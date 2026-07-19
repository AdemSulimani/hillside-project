/**
 * P3-2 — the manual multi-tenant fairness harness. `npm run loadtest:fairness`
 *
 * The scaled-down CI version of this lives in `__integration__/fairnessAndDrain.integration.test.ts`;
 * THIS is the configurable full-scale run the remediation plan's load-test validation asks for:
 * one noisy tenant bursting against a fleet of steady tenants, all contending through the
 * PRODUCTION slot-lease Lua scripts on a real Redis, reporting per-tenant wait distributions.
 *
 * What a healthy run looks like: every steady tenant's p99 wait-rounds ≈ ceil(steady/slots),
 * independent of the burst size; the noisy tenant's own backlog is long (that's the cap working)
 * but its concurrency never exceeds the cap. A steady tenant whose p99 grows WITH --burst is the
 * starvation defect this harness exists to catch.
 *
 * Read-only against production data structures? No — it writes its own `ai_slots:{loadtest-*}`
 * keys and deletes them on exit. Never run in CI (wall-clock scales with the knobs).
 *
 *   npm run loadtest:fairness                                  # defaults: 5+1 tenants
 *   npm run loadtest:fairness -- --tenants=20 --burst=500 --steady=30 --slots=8 --hold-ms=40
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import IORedis from 'ioredis';
import {
  TENANT_SLOT_ACQUIRE_SCRIPT,
  TENANT_SLOT_RELEASE_SCRIPT,
  parseAcquireResult,
  tenantSlotKey,
  tenantSlotMember,
} from '../services/tenantSlotLease';

interface Args {
  tenants: number;
  burst: number;
  steady: number;
  slots: number;
  holdMs: number;
  maxRounds: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: number): number => {
    const raw = argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    tenants: get('tenants', 5),
    burst: get('burst', 200),
    steady: get('steady', 10),
    slots: get('slots', 2),
    holdMs: get('hold-ms', 25),
    maxRounds: get('max-rounds', 500),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  const runId = crypto.randomUUID().slice(0, 8);

  interface Tenant {
    id: string;
    label: string;
    pending: string[];
    waitRounds: number[];
    enqueuedAt: Map<string, number>;
    maxConcurrent: number;
  }
  const tenants: Tenant[] = [];
  const mk = (label: string, contenders: number): Tenant => ({
    id: `loadtest-${runId}-${label}`,
    label,
    pending: Array.from({ length: contenders }, (_, i) => `${label}-${i}`),
    waitRounds: [],
    enqueuedAt: new Map(),
    maxConcurrent: 0,
  });
  tenants.push(mk('noisy', args.burst));
  for (let i = 1; i < args.tenants; i++) tenants.push(mk(`steady-${i}`, args.steady));
  for (const t of tenants) for (const c of t.pending) t.enqueuedAt.set(c, 1);

  console.info(
    `[loadtest] ${args.tenants} tenants (1 noisy @${args.burst}, ${args.tenants - 1} steady @${args.steady}), ` +
      `cap ${args.slots}, hold ${args.holdMs}ms`,
  );

  const started = Date.now();
  let rounds = 0;
  for (let round = 1; round <= args.maxRounds; round++) {
    rounds = round;
    const admitted: Array<[Tenant, string]> = [];
    for (const t of tenants) {
      let concurrent = 0;
      for (const c of [...t.pending]) {
        const raw = await redis.eval(
          TENANT_SLOT_ACQUIRE_SCRIPT,
          1,
          tenantSlotKey(t.id),
          Date.now(),
          60_000,
          tenantSlotMember(c, 'tok'),
          args.slots,
        );
        if (parseAcquireResult(raw).acquired) {
          admitted.push([t, c]);
          concurrent++;
          t.pending.splice(t.pending.indexOf(c), 1);
          t.waitRounds.push(round - (t.enqueuedAt.get(c) ?? 1));
        }
      }
      t.maxConcurrent = Math.max(t.maxConcurrent, concurrent);
    }
    if (admitted.length > 0 && args.holdMs > 0) {
      await new Promise((r) => setTimeout(r, args.holdMs)); // the simulated job duration
    }
    for (const [t, c] of admitted) {
      await redis.eval(TENANT_SLOT_RELEASE_SCRIPT, 1, tenantSlotKey(t.id), tenantSlotMember(c, 'tok'));
    }
    if (tenants.every((t) => t.pending.length === 0)) break;
  }

  const wallMs = Date.now() - started;
  console.info(`\n[loadtest] done in ${rounds} rounds, ${wallMs}ms wall\n`);
  console.info('  tenant        contenders  done  maxConc  wait-rounds p50 / p99 / max');
  const steadyP99: number[] = [];
  for (const t of tenants) {
    const sorted = [...t.waitRounds].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p99 = percentile(sorted, 99);
    if (t.label !== 'noisy') steadyP99.push(p99);
    console.info(
      `  ${t.label.padEnd(12)} ${String(t.enqueuedAt.size).padStart(10)}  ${String(t.waitRounds.length).padStart(4)}  ` +
        `${String(t.maxConcurrent).padStart(7)}  ${p50} / ${p99} / ${sorted[sorted.length - 1] ?? 0}`,
    );
  }

  const expectedSteady = Math.ceil(args.steady / args.slots);
  const worstSteady = Math.max(0, ...steadyP99);
  const fair = worstSteady <= expectedSteady + 1;
  console.info(
    `\n  VERDICT: ${fair ? 'FAIR' : 'STARVATION'} — worst steady-tenant p99 wait ${worstSteady} rounds ` +
      `vs ~${expectedSteady} expected at cap ${args.slots} (burst ${args.burst} must not move this)`,
  );

  for (const t of tenants) await redis.del(tenantSlotKey(t.id));
  redis.disconnect();
  if (!fair) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[loadtest] failed', err);
    process.exitCode = 1;
  });
}
