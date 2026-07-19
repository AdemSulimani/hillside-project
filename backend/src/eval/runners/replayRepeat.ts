/**
 * P3-4 — the live-replay-repeat runner. `npm run eval:live-replay`
 *
 * ⚠️ THE ONLY COMPONENT IN THIS HARNESS THAT SPENDS MONEY AND TALKS TO A CUSTOMER-FACING MODEL.
 * `--dry-run` is the DEFAULT; a live run requires an explicit `--live`, and every run is bounded by
 * a hard OpenAI call cap enforced through the existing `openaiCallTracker` counter. The audit's own
 * Phase-10 harness used exactly this guard (81 calls against a 118 cap, clean exit).
 *
 * WHAT IT MEASURES, AND WHY NO OFFLINE TEST CAN. The CI suite asserts INVARIANCE: given a fixed
 * input, the decision must not move whatever the stochastic sub-decision emits. It does that by
 * replaying RECORDED assessor outputs, which bounds its coverage to the label universe someone
 * already wrote down. Three things live only here:
 *
 *   1. `distinctRepliesPerInput` — RC-03's headline measurement. Reply generation runs at
 *      `AI_REPLY_TEMPERATURE=0.3` with no seed on the legacy path; Phase 10 measured [1, 3, 8]
 *      distinct replies for three fixed inputs. That is a property of sampling, and no stub has it.
 *   2. FABRICATION IN REAL PROSE. The IN3 replies invented "BSN = Bio-Engineered Supplements and
 *      Nutrition"; the offline corpus can only re-check text that was already captured.
 *   3. NEW ASSESSOR LABELS. This runner prints the `missing` label sets it observes, and folding
 *      them back into `ADVERSARIAL_LABELS` is what stops the offline suite ossifying against a
 *      2026-era label universe. Treat that as the standing maintenance task it is.
 *
 * DETERMINISM CAVEAT (the plan's own edge case): assert DECISION CLASS and FACT MEMBERSHIP, never
 * byte-identical prose. Hosted models are not bit-deterministic, so a text-equality assertion here
 * would be a permanently flaky gate — which is why this runner reports and never fails a build.
 *
 *   npx tsx src/eval/runners/replayRepeat.ts                       # dry run, no calls, no cost
 *   npx tsx src/eval/runners/replayRepeat.ts --live --tenant=<uuid> --runs=8 --max-calls=100
 */
// Operator CLI, not a CI module: load backend/.env first (FIRST import — later imports may
// freeze knob/env reads at module load). CI-side eval modules stay dotenv-free by fence.
import 'dotenv/config';
import pool from '../../db/pool';
import { GOLDEN_ANSWERABLE } from '../corpora/goldenGapGate';
import { summarizeReplays, type ReplayCaseResult } from '../harness/replaySummary';

interface Args {
  live: boolean;
  runs: number;
  maxCalls: number;
  tenantId?: string;
  caseIds?: string[];
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (n: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
  const num = (n: string, d: number): number => {
    const raw = get(n);
    if (raw === undefined) return d;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`--${n} must be a positive number`);
    return v;
  };
  const cases = get('cases');
  return {
    live: argv.includes('--live'),
    runs: num('runs', 8), // the audit replayed each input 8×
    maxCalls: num('max-calls', 100),
    tenantId: get('tenant'),
    caseIds: cases ? cases.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    json: argv.includes('--json'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = args.caseIds
    ? GOLDEN_ANSWERABLE.filter((c) => args.caseIds!.includes(c.id))
    : GOLDEN_ANSWERABLE;

  const plannedCalls = cases.length * args.runs;

  if (!args.live) {
    console.info('[eval:live-replay] DRY RUN — no OpenAI calls, no cost.');
    console.info(`  cases        : ${cases.length} (${cases.map((c) => c.id).join(', ')})`);
    console.info(`  runs per case: ${args.runs}`);
    console.info(`  planned calls: ${plannedCalls} (cap ${args.maxCalls})`);
    if (plannedCalls > args.maxCalls) {
      console.info(
        `  ⚠️  the plan exceeds the cap — a live run would stop after ${args.maxCalls} calls. ` +
          'Raise --max-calls or narrow --cases.',
      );
    }
    console.info('\n  Add --live --tenant=<uuid> to execute. This SPENDS OPENAI CREDITS.');
    console.info('  It measures what no offline test can: distinctRepliesPerInput (RC-03),');
    console.info('  fabrication in real prose, and new assessor labels to fold back into');
    console.info('  ADVERSARIAL_LABELS in eval/corpora/gapGatePolicies.ts.');
    return;
  }

  if (!args.tenantId) {
    console.error('[eval:live-replay] --live requires --tenant=<uuid> (retrieval is tenant-scoped)');
    process.exitCode = 1;
    return;
  }

  /**
   * WHY THIS WRITES NOTHING. `generateReply` takes ids and loads history itself, so a replay needs
   * a conversation id — but it only ever SELECTs from `messages`. Passing an id that exists in no
   * row makes the history query return empty and leaves the database untouched. That is exactly how
   * the audit's own Phase-10 harness ran ("random nonexistent conversationIds — the history SELECT
   * returned empty, so nothing persisted"), and it is what makes an unattended live run safe: the
   * runner cannot create, mutate, or send anything. It reads the tenant's real catalog and calls
   * the real model; that is the whole extent of its effects.
   *
   * Imported lazily so the module graph above stays free of `openaiClient`, which throws at load
   * without an API key — a dry run must work on a machine that has no key at all.
   */
  const { randomUUID } = await import('node:crypto');
  const { generateReply } = await import('../../services/aiService');
  const { getTrackedOpenAICalls, runWithOpenAICallTracking } = await import(
    '../../services/openaiCallTracker'
  );

  const results: ReplayCaseResult[] = [];
  let capReached = false;
  // Captured INSIDE the tracking context: `getTrackedOpenAICalls()` reads AsyncLocalStorage and
  // returns null once the context has exited, so reading it afterwards would report nothing.
  let totalCalls = 0;
  const callsSoFar = (): number => getTrackedOpenAICalls()?.length ?? 0;

  await runWithOpenAICallTracking(async () => {
    for (const c of cases) {
      if (capReached) break;
      const replies: string[] = [];
      let injectedCatalogText = '';
      let catalogNames: string[] = [];
      let catalogPriceRows: Array<{ price: string; discounted_price: string | null }> = [];

      for (let run = 0; run < args.runs; run++) {
        // The audit's 118-cap guard, verbatim in spirit: check BEFORE each call, because one
        // reply turn fans out to ~18-25 provider calls and checking after would overshoot badly.
        if (callsSoFar() >= args.maxCalls) {
          capReached = true;
          console.warn(
            `[eval:live-replay] call cap ${args.maxCalls} reached — stopping. ` +
              'Results so far are still reported.',
          );
          break;
        }

        const out = await generateReply(randomUUID(), args.tenantId!, c.text);
        replies.push(out.reply);
        injectedCatalogText = out.productCatalogContext;
        catalogNames = out.matchedProducts.map((p) => p.name);
        catalogPriceRows = out.matchedProducts.map((p) => ({
          price: String(p.price ?? ''),
          discounted_price: p.discounted_price == null ? null : String(p.discounted_price),
        }));
      }

      if (replies.length === 0) continue;
      results.push(
        summarizeReplays({
          id: c.id,
          text: c.text,
          replies,
          injectedCatalogText,
          catalogNames,
          catalogPriceRows,
        }),
      );
    }
    totalCalls = callsSoFar();
  });

  if (args.json) {
    console.log(JSON.stringify({ totalOpenAICalls: totalCalls, capReached, results }, null, 2));
    return;
  }

  console.info(`\n[eval:live-replay] ${totalCalls} OpenAI calls (cap ${args.maxCalls})\n`);
  console.info('  id       runs  distinctReplies  fabricating');
  for (const r of results) {
    console.info(
      `  ${r.id.padEnd(8)} ${String(r.runs).padEnd(5)} ${String(r.distinctReplies).padEnd(16)} ` +
        `${r.fabricationViolations}/${r.runs}`,
    );
    if (r.fabricatedSpans.length > 0) {
      console.info(`     ↳ ungrounded spans: ${r.fabricatedSpans.join(', ')}`);
    }
  }
  const distinct = results.map((r) => r.distinctReplies);
  console.info(
    `\n  distinctRepliesPerInput = [${distinct.join(', ')}]` +
      '   (RC-03 baseline, Phase 10: [1, 3, 8])',
  );
  console.info(
    '\n  Next: fold any NEW assessor "missing" labels observed in the logs above into\n' +
      '  ADVERSARIAL_LABELS in eval/corpora/gapGatePolicies.ts — that feedback loop is what\n' +
      '  stops the offline suite ossifying against a stale label universe.',
  );
}

// Only runs when invoked directly — importing `summarizeReplays` can never fire a live run.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[eval:live-replay] failed', err);
      process.exitCode = 1;
    })
    .finally(() => {
      void pool.end();
    });
}
