/**
 * P3-4 — the two gap-gate policies, side by side, plus the adversarial assessor that perturbs them.
 *
 * THIS FILE IS THE RC-01 META-TEST'S PIVOT. The remediation plan's headline validation is that the
 * harness must "reproduce the audit's findings: run against the pre-fix codebase → it CATCHES
 * IN1/IN3 8/8 escalation … then goes green against the end-state". Checking out the pre-fix commit
 * is not a viable way to do that — the old source will not typecheck against current types, and it
 * would mean maintaining a second compilation target forever. So the pre-fix POLICY is frozen here
 * as a fixture instead, and both policies run against the same corpus and the same draws.
 *
 * That works for RC-01 specifically because the production code already carries both: P0-3 left
 * `decideGapEscalation(assessment, status, deterministicFirst)` with the legacy branch intact and
 * documented. This module supplies the surrounding combiner — the part `processAIReply` composes
 * inline and that therefore has no other seam.
 *
 * ⚠️ THE TWO COMBINERS DIFFER BY MORE THAN THE FLAG. `filterFreeFormInfoLabels` did not exist
 * before P0-3: legacy fed the assessor's RAW `missing` labels straight through. So flipping only
 * `deterministicFirst` would understate the pre-fix damage and the meta-test would prove less than
 * it claims. `decideOutcomeLegacy` reproduces the whole pre-fix flow, unfiltered.
 *
 * FIXTURE ONLY. `decideOutcomeLegacy` is deliberately unreachable from production code — it lives
 * under `src/eval/**`, which `evalIsolation.test.ts` fences off the send path.
 *
 * ⚠️ WHAT THIS GATE DOES NOT COVER. The combiners below take PRE-RESOLVED `StructuredAttributeMap`s
 * and `imageUsableKeys`. Production resolves those first: `processAIReply` calls
 * `getProductInferredAttributes` (regex over name/description/extracted text/tags) and unions the
 * image keys with the availability classifier's. Both are load-bearing for RC-01's actual promise —
 * "never escalate an attribute the catalog can answer" — and a regression in either passes this
 * suite untouched, because the attribute maps are handed in already correct. This corpus guards the
 * DECISION LAYER; the resolution layer above it is guarded by `productAttributeResolution.test.ts`
 * and `attributeAvailability.test.ts`. Stated plainly so nobody reads a green gate as more coverage
 * than it is.
 *
 * Pure: no DB, Redis, network, clock or OpenAI key. Runs in `npm test`.
 */
import {
  buildMissingInfoHoldingMessage,
  composePartialAnswer,
  computeMissingStructuredAttributes,
  decideGapEscalation,
  dedupeInfoLabels,
  deriveAnswerabilityStatus,
  filterFreeFormInfoLabels,
  localizedAttributeLabels,
  reconcileMissingAgainstAnswer,
  type AnswerabilityStatus,
  type InfoGapLocale,
  type StructuredAttributeMap,
} from '../../services/productInformationGapHelpers';
import type { StructuredAttributeKey } from '../../services/productRetrievalService';
import { rngPick, type Rng } from '../harness/invariance';

/** What `assessProductInformationRequest` returns — including its fail-closed error shape. */
export interface Assessment {
  answer: string;
  missing: string[];
  ok: boolean;
  errored: boolean;
}

export interface GapScenario {
  assessment: Assessment;
  requested: readonly StructuredAttributeKey[];
  products: readonly StructuredAttributeMap[];
  imageUsableKeys?: ReadonlySet<string>;
  locale: InfoGapLocale;
}

export interface GapOutcome {
  status: AnswerabilityStatus;
  /** null ⇒ the original AI reply is sent as-is (no escalation). */
  reply: string | null;
  escalated: boolean;
  missing: string[];
}

/** Shared prelude: the deterministic net + the per-product pass, identical in both policies. */
function deterministicEvidence(input: GapScenario): {
  deterministicMissing: StructuredAttributeKey[];
  perProduct: string[];
} {
  const deterministicMissing = computeMissingStructuredAttributes(
    [...input.requested],
    [...input.products],
    input.imageUsableKeys ?? new Set(),
  );
  const perProduct: string[] = [];
  if (input.products.length > 1) {
    for (const key of input.requested) {
      if (deterministicMissing.includes(key)) continue;
      const anyMissing = input.products.some((p) => {
        const val = p?.[key];
        return !(typeof val === 'string' && val.trim().length > 0);
      });
      if (anyMissing) perProduct.push(...localizedAttributeLabels([key], input.locale));
    }
  }
  return { deterministicMissing, perProduct };
}

/**
 * POST-FIX (P0-3, `GAP_GATE_DETERMINISTIC_FIRST=true`): the LLM's `missing` labels are filtered to
 * known free-form concepts, merged with deterministic evidence, and only that decides. An errored
 * assessor with a clear deterministic net fails OPEN — the grounded AI reply is sent as-is.
 *
 * Mirrors the composition in `jobs/processAIReply.ts` without importing it (that module reaches
 * `openaiClient`, which throws at load without an API key).
 */
export function decideOutcomeDeterministicFirst(input: GapScenario): GapOutcome {
  const { deterministicMissing, perProduct } = deterministicEvidence(input);
  const llmMissing = filterFreeFormInfoLabels(input.assessment.missing);
  const merged = reconcileMissingAgainstAnswer(
    dedupeInfoLabels([...llmMissing, ...localizedAttributeLabels(deterministicMissing, input.locale)]),
    input.assessment.answer,
  );
  const finalMissing = dedupeInfoLabels([...merged, ...perProduct]);
  const status = deriveAnswerabilityStatus(input.assessment.answer, finalMissing);
  if (!decideGapEscalation(input.assessment, status, true)) {
    return { status, reply: null, escalated: false, missing: [] };
  }
  const reply =
    status === 'partial'
      ? composePartialAnswer(input.assessment.answer, finalMissing, input.locale)
      : buildMissingInfoHoldingMessage(finalMissing, input.locale);
  return { status, reply, escalated: true, missing: finalMissing };
}

/**
 * PRE-FIX (the policy the audit measured at IN1 8/8 and IN3 8/8). FROZEN FIXTURE — do not "fix".
 *
 * Two differences from the post-fix combiner, both load-bearing:
 *   1. NO `filterFreeFormInfoLabels` — the assessor's raw labels pass straight through, so a
 *      question echo like `['cila eshte me e mire']` or `['ma shum']` becomes a missing attribute.
 *   2. `decideGapEscalation(..., false)` — `!ok` alone escalates, so a transport/parse error
 *      (which returns `ok:false`) escalates a question the catalog could answer. Fail CLOSED.
 */
export function decideOutcomeLegacy(input: GapScenario): GapOutcome {
  const { deterministicMissing, perProduct } = deterministicEvidence(input);
  const merged = reconcileMissingAgainstAnswer(
    dedupeInfoLabels([
      ...input.assessment.missing, // RAW — the pre-P0-3 behaviour
      ...localizedAttributeLabels(deterministicMissing, input.locale),
    ]),
    input.assessment.answer,
  );
  const finalMissing = dedupeInfoLabels([...merged, ...perProduct]);
  const status = deriveAnswerabilityStatus(input.assessment.answer, finalMissing);
  if (!decideGapEscalation(input.assessment, status, false)) {
    return { status, reply: null, escalated: false, missing: [] };
  }
  const reply =
    status === 'partial'
      ? composePartialAnswer(input.assessment.answer, finalMissing, input.locale)
      : buildMissingInfoHoldingMessage(finalMissing, input.locale);
  return { status, reply, escalated: true, missing: finalMissing };
}

/**
 * The stochastic labels the assessor has actually been observed emitting, plus plausible siblings.
 *
 * OWNER + FEEDBACK LOOP: this array bounds the offline suite's coverage. It can only assert
 * "whatever the assessor emits, the decision holds" over the labels it knows, so a NEW label class
 * would pass here and could still fail live. `eval/runners/replayRepeat.ts` prints the label sets
 * it observes precisely so they can be folded back in. Treat that as a standing maintenance task,
 * not a nice-to-have — an ossified label universe is how this suite would quietly stop guarding.
 *
 * Measured entries cite their evidence; the rest are same-shape siblings.
 */
export const ADVERSARIAL_LABELS: readonly string[] = [
  'marka', //                    EV-044 / IN1 — flagged 8/8 though brand was never asked
  'cila eshte me e mire', //     EV-044 / IN3 — question echo, 4 of 8 runs
  'më e mirë', //                EV-044 / IN3 — same echo, other 4 runs (temp 0!)
  'ma shum', //                  EV-010 (alert d3db5dac) — Gheg "more", filed as an attribute
  'brandi',
  'pesha',
  'shija',
  'ngjyra',
  'informacion shtesë',
  'detaje',
  'qfar shije',
  'sa kushton',
];

/**
 * THE AUDIT'S OWN `missing` LABELS — what the assessor actually returned on the eight live replays
 * of each input (Phase C, `docs/audit/10-runtime-verification.md`).
 *
 * The adversarial sweep above samples a broad label space and is the better COVERAGE instrument.
 * These are the better EVIDENCE instrument: replaying them reproduces the audit's headline number
 * exactly — legacy escalates 8/8, deterministic-first 0/8 — rather than approximately. The meta-test
 * uses these; the invariance sweep uses the sampler.
 *
 * IN3's two label sets are the single most damning detail in RC-01: the model was called at
 * temperature 0 and still returned a DIFFERENT escalation reason on four of eight runs.
 *
 * ⚠️ THE `answer` FIELD IS NOT FROM PHASE C. EV-044 recorded the assessor's `missing` labels
 * (Phase C) but not its `answer` text; "Po." is the measured CUSTOMER-FACING reply from Phase B,
 * a different call. It is used here as a plausible stand-in, and it does not affect the result:
 * `deriveAnswerabilityStatus('Po.', ['marka'])` is 'partial' and `('', …)` is 'none', and the
 * legacy policy escalates on both. Recorded rather than glossed over, because the whole value of
 * this constant is that a reader can trust what in it is measured.
 */
export const AUDIT_RECORDED_DRAWS: Readonly<Record<string, readonly Assessment[]>> = {
  IN1: Array.from({ length: 8 }, () => ({
    answer: 'Po.', // the measured degenerate reply — quality 0.20, above the live 0.1 floor
    missing: ['marka'], // brand: null on every matched row, and never asked
    ok: true,
    errored: false,
  })),
  IN3: [
    ...Array.from({ length: 4 }, () => ({
      answer: '',
      missing: ['cila eshte me e mire'],
      ok: true,
      errored: false,
    })),
    ...Array.from({ length: 4 }, () => ({
      answer: '',
      missing: ['më e mirë'],
      ok: true,
      errored: false,
    })),
  ],
};

/** Grounded answers the composer plausibly produces — including IN1's measured degenerate "Po.". */
const ADVERSARIAL_ANSWERS: readonly string[] = [
  'Po, e kemi në stok. Kushton €18.00.',
  'Po.', // EV-044 / IN1 — the degenerate one-word reply that scored 0.20 and still shipped
  'Po, i kemi të dyja shijet.',
];

/**
 * Draw one adversarial assessor result.
 *
 * ~1 draw in 5 simulates a transport/parse failure — the `{ok:false, errored:true}` fail-closed
 * shape RC-01 identified as the gate's error path. Including it in the invariance sweep is the
 * point: the post-fix policy must send the grounded reply anyway when the deterministic net is
 * clear, and the pre-fix policy must escalate.
 */
export function drawAdversarialAssessment(rng: Rng): Assessment {
  if (rng() < 0.2) return { answer: '', missing: [], ok: false, errored: true };
  const count = Math.floor(rng() * 3); // 0..2 spurious labels
  const missing: string[] = [];
  for (let i = 0; i < count; i++) missing.push(rngPick(rng, ADVERSARIAL_LABELS));
  return { answer: rngPick(rng, ADVERSARIAL_ANSWERS), missing, ok: true, errored: false };
}
