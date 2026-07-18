/**
 * P3-4 — the golden-set digest runner. `npm run eval:golden`
 *
 * WHY A DIGEST AND NOT JUST "RUN THE TESTS 3×". The remediation plan requires the golden set to be
 * run three times in CI with IDENTICAL pass/fail, because this harness is a release gate and "a
 * flaky assertion blocks deploys". Comparing three test-runner transcripts is awkward (timings and
 * ordering differ), so this runner reduces the whole corpus to one sha256 over an ORDERED,
 * value-only vector of outcomes. Three identical digests is the assertion, and it is a few seconds
 * rather than three full suite runs.
 *
 * The digest covers the outcome of every case under every adversarial draw — not just pass/fail —
 * so a change that flipped one run out of 20×23 cases still moves the hash.
 *
 * OFFLINE and PURE: no DB, Redis, network, clock or OpenAI key. Every draw comes from a seeded LCG,
 * so the digest is identical on every machine.
 *
 *   npx tsx src/eval/runGolden.ts             # human-readable summary + the digest
 *   npx tsx src/eval/runGolden.ts --digest    # the digest alone (what CI diffs)
 */
import { createHash } from 'node:crypto';
import {
  decideOutcomeDeterministicFirst,
  drawAdversarialAssessment,
  type GapScenario,
} from './corpora/gapGatePolicies';
import { GOLDEN_ANSWERABLE, GOLDEN_TRUE_GAPS } from './corpora/goldenGapGate';
import type { GapGateCase } from './corpora/types';
import { makeSeededRng, stableKey } from './harness/invariance';

const RUNS = 20;

/** Must match `gapGateGolden.test.ts` — the digest is meaningless if it samples a different stream. */
const seedFor = (index: number): number => 0xc0ffee + index * 7919;

const scenarioFor = (c: GapGateCase): Omit<GapScenario, 'assessment'> => ({
  requested: c.requested,
  products: c.products,
  imageUsableKeys: new Set(c.imageUsableKeys ?? []),
  locale: c.locale,
});

interface CaseOutcome {
  id: string;
  expect: string;
  escalations: number;
  runs: number;
  /** Distinct decision shapes seen across the draws. >1 means the decision moved. */
  distinct: number;
  ok: boolean;
}

function evaluateCase(c: GapGateCase, seedIndex: number): CaseOutcome {
  const base = scenarioFor(c);
  const rng = makeSeededRng(seedFor(seedIndex));
  const seen = new Set<string>();
  let escalations = 0;

  for (let run = 0; run < RUNS; run++) {
    const out = decideOutcomeDeterministicFirst({ ...base, assessment: drawAdversarialAssessment(rng) });
    // The invariant is the DECISION — escalate or answer — not the shape of the resulting reply.
    // For a genuine gap the reply legitimately differs by draw: when the assessor produced partial
    // text the customer gets a partial answer, and when it errored they get a holding message. Both
    // are the same decision. Folding `status` in here would report that as a divergence, which is
    // also why RC-03's own edge case says to assert decision CLASS and never the prose.
    seen.add(stableKey({ escalated: out.escalated }));
    if (out.escalated) escalations += 1;
  }

  const expectedEscalations = c.expect === 'escalate' ? RUNS : 0;
  return {
    id: c.id,
    expect: c.expect,
    escalations,
    runs: RUNS,
    distinct: seen.size,
    ok: seen.size === 1 && escalations === expectedEscalations,
  };
}

export function runGoldenSet(): { outcomes: CaseOutcome[]; digest: string; failures: CaseOutcome[] } {
  const all = [...GOLDEN_ANSWERABLE, ...GOLDEN_TRUE_GAPS];
  const outcomes = all.map((c, i) =>
    // The true-gap seeds must not collide with the answerable ones, matching the test suite's
    // 1000-offset. A shared seed would replay the same perturbation stream for two different cases.
    evaluateCase(c, c.expect === 'escalate' ? 1000 + i - GOLDEN_ANSWERABLE.length : i),
  );

  const digest = createHash('sha256')
    .update(
      outcomes
        .map((o) => `${o.id}:${o.expect}:${o.escalations}/${o.runs}:d${o.distinct}:${o.ok ? 'ok' : 'FAIL'}`)
        .join('\n'),
    )
    .digest('hex');

  return { outcomes, digest, failures: outcomes.filter((o) => !o.ok) };
}

function main(): void {
  const { outcomes, digest, failures } = runGoldenSet();
  const digestOnly = process.argv.includes('--digest');

  if (!digestOnly) {
    console.info(`[eval:golden] ${outcomes.length} cases × ${RUNS} adversarial draws\n`);
    console.info('  id       expect    escalations  distinct');
    for (const o of outcomes) {
      console.info(
        `  ${o.id.padEnd(8)} ${o.expect.padEnd(9)} ${String(`${o.escalations}/${o.runs}`).padEnd(12)} ` +
          `${o.distinct}${o.ok ? '' : '   <-- FAIL'}`,
      );
    }
    console.info('');
  }

  console.log(digest);

  if (failures.length > 0) {
    console.error(
      `[eval:golden] ${failures.length} case(s) FAILED: ${failures.map((f) => f.id).join(', ')}`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
