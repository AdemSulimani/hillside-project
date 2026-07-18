/**
 * P2-5 (RC-15, fluency portion): the offline Gheg fluency judge.
 *
 * ⚠️ MANUAL SCRIPT — NEVER ON THE SEND PATH, NEVER IN CI. ⚠️
 *
 * This is the ONE place P2-5 uses an LLM as a judge, and it is deliberately quarantined:
 *
 *   - OFF THE SEND PATH. `evalIsolation.test.ts` walks the import graph from aiService.ts and
 *     processAIReply.ts and fails if any transitive path reaches `src/eval/**`. An offline
 *     evaluator that leaks into the reply pipeline becomes an unbudgeted per-message LLM call on
 *     the customer's turn — and the audit already found a per-turn quality eval doing exactly
 *     that, systematically scoring order confirmations 0.200 and pausing the AI at checkout.
 *     RC-15's whole conclusion is that fluency scoring belongs offline. This file is the offline.
 *
 *   - NOT IN CI. It costs money per run and its verdicts are stochastic, so it cannot gate a
 *     merge. The DISCRETE half of Gheg capability — locale, routing labels — is deterministic
 *     and IS in `npm test` (see `ghegCorpus.test.ts`), per RC-25: "Dialect classification is a
 *     discrete label — checkable without a judge; reserve LLM-as-judge for fluency."
 *     This repo has no nightly workflow (only ci.yml and deploy.yml); the remediation plan
 *     assumed one existed. Rather than invent that scaffold, this runs on demand:
 *
 *         cd backend && npx tsx src/eval/ghegFluency/judge.ts
 *
 * WHAT IT MEASURES. Register and dialect appropriateness of Albanian text for a Kosovo/Gheg
 * audience — the dimension WF-E scored 65/100, deducting for the delivered mojibake and for
 * canned copy that is fluent standard Albanian but noticeably more formal than the customers'
 * Gheg. It does NOT judge factual grounding: that is P2-1's deterministic gate, and routing it
 * through a stochastic judge is precisely the mistake P2-1 exists to undo.
 */
import { OPENAI_EVAL_MODEL, openai } from '../../services/openaiClient';
import { GHEG_CORPUS_WITH_EV_010 } from './corpus';

export interface FluencyVerdict {
  /** 0–100: how natural this reads to a Kosovo Gheg speaker. */
  score: number;
  /** 'gheg' | 'standard' | 'mixed' | 'not_albanian' */
  register: string;
  /** Concrete phrases that read as wrong/foreign/over-formal. */
  issues: string[];
}

const JUDGE_SCHEMA = {
  name: 'gheg_fluency_verdict',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      score: { type: 'integer', minimum: 0, maximum: 100 },
      register: { type: 'string', enum: ['gheg', 'standard', 'mixed', 'not_albanian'] },
      issues: { type: 'array', items: { type: 'string' } },
    },
    required: ['score', 'register', 'issues'],
  },
} as const;

const JUDGE_SYSTEM_PROMPT = [
  'You are a native Kosovo Albanian (Gheg) speaker evaluating a shop assistant\'s written reply.',
  '',
  'Score 0-100 for how NATURAL the reply reads to a Kosovar customer messaging a shop on Instagram.',
  'Judge ONLY language: register, dialect fit, grammar, spelling, and encoding integrity.',
  'Do NOT judge whether the facts are correct — that is validated deterministically elsewhere.',
  '',
  'Deduct heavily for:',
  '  - mojibake or replacement characters (e.g. "S� shpejti") — this has reached real customers',
  '  - mixing languages within one reply',
  '  - register that is far more formal than an Instagram shop chat',
  'Deduct mildly for standard-Tosk phrasing where a Gheg speaker would use a dialect form.',
  'Do not deduct for missing diacritics: Kosovar customers do not type them (0 of 40 real messages did).',
].join('\n');

export async function judgeFluency(text: string): Promise<FluencyVerdict> {
  const completion = await openai.chat.completions.create({
    model: OPENAI_EVAL_MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    response_format: { type: 'json_schema', json_schema: JUDGE_SCHEMA },
  });
  return JSON.parse(completion.choices[0]?.message?.content ?? '{}') as FluencyVerdict;
}

/** Judges a batch and returns the mean score plus the per-item verdicts. */
export async function judgeCorpus(
  texts: readonly string[],
): Promise<{ mean: number; verdicts: Array<{ text: string; verdict: FluencyVerdict }> }> {
  const verdicts: Array<{ text: string; verdict: FluencyVerdict }> = [];
  for (const text of texts) {
    verdicts.push({ text, verdict: await judgeFluency(text) });
  }
  const mean = verdicts.length
    ? verdicts.reduce((s, v) => s + v.verdict.score, 0) / verdicts.length
    : 0;
  return { mean, verdicts };
}

/**
 * Entry point — two modes:
 *
 * DEFAULT (no args): judges the corpus utterances as a baseline calibration of the judge itself:
 * these are real customer messages, so a Gheg-competent judge should score them HIGH. A low
 * score here means the judge is miscalibrated, not that the customers write badly.
 *
 * `--rescore <replies.jsonl>`: the P2-5 validation bullet "Albanian re-score materially above
 * 54/100" — judges ASSISTANT replies, one JSON object per line with a `text` field (export them
 * from a staging run with the P2-5 flags on, e.g. the delivered AI replies of a WF-E replay).
 * DEFERRAL, made explicit here because the audit (P2-5-F3) found it documented nowhere: the
 * re-score was NOT executed as part of the P2-5 merge — it needs (a) the flags live in a staging
 * environment to produce the replies and (b) a paid judge pass over them. Run it before calling
 * the RC-15 fluency portion re-validated:
 *
 *     npx tsx src/eval/ghegFluency/judge.ts --rescore staging-replies.jsonl
 */
async function main(): Promise<void> {
  const rescoreIdx = process.argv.indexOf('--rescore');
  if (rescoreIdx !== -1) {
    const file = process.argv[rescoreIdx + 1];
    if (!file) {
      console.error('[gheg-eval] --rescore requires a JSONL file of {"text": "<assistant reply>"} lines');
      process.exit(1);
    }
    const { readFileSync } = await import('node:fs');
    const texts = readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { text: string }).text)
      .filter((t) => typeof t === 'string' && t.trim().length > 0);
    console.info(`[gheg-eval] RE-SCORE: judging ${texts.length} assistant replies with ${OPENAI_EVAL_MODEL}…`);
    const { mean, verdicts } = await judgeCorpus(texts);
    for (const { text, verdict } of verdicts) {
      console.info(`  ${String(verdict.score).padStart(3)}  ${text.slice(0, 80).replace(/\n/g, ' / ')}`);
      for (const issue of verdict.issues) console.info(`       - ${issue}`);
    }
    console.info(
      `[gheg-eval] RE-SCORE mean: ${mean.toFixed(1)} (WF-E pre-P2-5 baseline: 54/100 — ` +
        'the validation passes when this is materially above it)',
    );
    return;
  }

  const texts = GHEG_CORPUS_WITH_EV_010.map((c) => c.text);
  console.info(`[gheg-eval] judging ${texts.length} utterances with ${OPENAI_EVAL_MODEL}…`);
  const { mean, verdicts } = await judgeCorpus(texts);
  for (const { text, verdict } of verdicts) {
    console.info(
      `  ${String(verdict.score).padStart(3)}  ${verdict.register.padEnd(9)}  ${text.replace(/\n/g, ' / ')}`,
    );
    for (const issue of verdict.issues) console.info(`       - ${issue}`);
  }
  console.info(`[gheg-eval] mean score: ${mean.toFixed(1)}`);
}

// Only runs when invoked directly (`npx tsx src/eval/ghegFluency/judge.ts`), never on import —
// so importing `judgeFluency` from a future analysis script cannot fire a paid corpus run.
// `require.main === module` is the CommonJS idiom (tsconfig sets "module": "commonjs").
if (require.main === module) {
  main().catch((err) => {
    console.error('[gheg-eval] failed', err);
    process.exit(1);
  });
}
