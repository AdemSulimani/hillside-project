/**
 * P3-4 (RC-15) — the OFFLINE reply-quality scorer.
 *
 * ⚠️ PAID + STOCHASTIC. Never in CI, never on the send path. `require.main === module` guards the
 * CLI, and `goldenSets/__tests__/harnessOfflineFence.test.ts` asserts no CI-side module imports it.
 *
 * WHY IT EXISTS. The inline quality eval is miscalibrated (a systematic 0.200 on order
 * confirmations, EV-018) and sits on the customer's turn, where a low score flags, alerts and
 * PAUSES the conversation with no automatic resume. RC-15's remediation is not a better threshold —
 * it is moving the eval off the send path "where its miscalibration can do no billing damage".
 * This is the replacement.
 *
 * THE ONE THING THAT MAKES THE CUTOVER DEFENSIBLE: this scorer reuses the SAME prompt builders and
 * the SAME parser as the inline path (`services/aiQualityContract.ts`). Only the call site differs.
 * If it rebuilt the prompt even slightly differently, the "do the scores match?" comparison in
 * `parityReport.ts` would be measuring the harness rather than the eval, and the removal it is
 * meant to justify would rest on nothing.
 *
 *   npx tsx src/eval/quality/offlineScorer.ts replies.jsonl
 *     …one JSON object per line: { inbound, reply, catalog?, businessName? }
 */
import { openai, OPENAI_EVAL_MODEL } from '../../services/openaiClient';
import {
  buildQualityEvalSystemPrompt,
  buildQualityEvalUserContent,
  evaluationTriggersAlert,
  getQualityThreshold,
  parseEvaluationJson,
  resolveStoredFlagReason,
  type ReplyQualityEvaluation,
} from '../../services/aiQualityContract';

export interface ScorableTurn {
  /** The customer message the reply answered. */
  inbound: string;
  /** The AI reply under evaluation. */
  reply: string;
  /** The product catalog context that was injected. */
  catalog?: string;
  businessName?: string;
}

export interface OfflineScore {
  evaluation: ReplyQualityEvaluation | null;
  /** Whether this verdict WOULD have flagged at the given threshold. */
  wouldFlag: boolean;
  flagReason: string | null;
}

/**
 * Score one turn. Fails OPEN (returns `evaluation: null`) exactly as the inline path does — an
 * offline scorer that threw on a transport blip would abort a long comparison run partway through
 * and, worse, make transport failures look like score disagreements.
 */
export async function scoreOffline(
  turn: ScorableTurn,
  threshold = getQualityThreshold(),
): Promise<OfflineScore> {
  const reply = turn.reply.trim();
  if (!reply) return { evaluation: null, wouldFlag: false, flagReason: null };

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_EVAL_MODEL,
      messages: [
        { role: 'system', content: buildQualityEvalSystemPrompt(turn.businessName ?? 'the business') },
        {
          role: 'user',
          content: buildQualityEvalUserContent(turn.inbound, turn.reply, turn.catalog ?? ''),
        },
      ],
      temperature: 0,
      max_tokens: 256,
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return { evaluation: null, wouldFlag: false, flagReason: null };

    const evaluation = parseEvaluationJson(content.trim());
    const wouldFlag = evaluationTriggersAlert(evaluation, threshold);
    return {
      evaluation,
      wouldFlag,
      flagReason: wouldFlag ? resolveStoredFlagReason(evaluation, threshold) : null,
    };
  } catch (err) {
    console.warn('[eval:quality] offline score failed (continuing)', {
      err: err instanceof Error ? err.message : String(err),
    });
    return { evaluation: null, wouldFlag: false, flagReason: null };
  }
}

/** Score a batch sequentially. Sequential on purpose: this is a nightly job, not a latency path,
 *  and serial calls keep it well clear of rate limits on a long run. */
export async function scoreBatch(
  turns: readonly ScorableTurn[],
  threshold = getQualityThreshold(),
): Promise<OfflineScore[]> {
  const out: OfflineScore[] = [];
  for (const turn of turns) out.push(await scoreOffline(turn, threshold));
  return out;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error(
      '[eval:quality] usage: npx tsx src/eval/quality/offlineScorer.ts <turns.jsonl>\n' +
        '  each line: {"inbound": "...", "reply": "...", "catalog": "...", "businessName": "..."}',
    );
    process.exitCode = 1;
    return;
  }
  const { readFileSync } = await import('node:fs');
  const turns = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ScorableTurn);

  const threshold = getQualityThreshold();
  console.info(`[eval:quality] scoring ${turns.length} turns with ${OPENAI_EVAL_MODEL} @ threshold ${threshold}`);
  const scores = await scoreBatch(turns, threshold);
  for (const [i, s] of scores.entries()) {
    const score = s.evaluation ? s.evaluation.quality_score.toFixed(3) : ' n/a ';
    console.info(
      `  ${score}  ${s.wouldFlag ? 'FLAG' : '  ok'}  ${turns[i].reply.slice(0, 70).replace(/\n/g, ' ')}`,
    );
  }
  const scored = scores.filter((s) => s.evaluation !== null);
  const mean = scored.length
    ? scored.reduce((a, s) => a + s.evaluation!.quality_score, 0) / scored.length
    : 0;
  console.info(
    `[eval:quality] mean ${mean.toFixed(3)} over ${scored.length}/${turns.length} scored; ` +
      `${scores.filter((s) => s.wouldFlag).length} would flag`,
  );
}

// Only runs when invoked directly — importing `scoreOffline` can never fire a paid batch.
if (require.main === module) {
  main().catch((err) => {
    console.error('[eval:quality] failed', err);
    process.exitCode = 1;
  });
}
