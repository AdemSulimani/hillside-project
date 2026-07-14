/**
 * P1-3 (RC-07, RC-08) — Confidence-boost symmetry + required-`confidence` contract +
 * threshold hysteresis.
 *
 * RC-07: when a classifier asserts an intent boolean `true` but omits/zeroes
 * `confidence`, four escalation detectors (cancel/refund, wrong-product,
 * post-purchase, order-info-update) overwrite confidence to 0.9/0.85 — clearing
 * their `>0.8`/`>0.82` gate on the boolean alone — while `detectOrderAffirmationIntent`
 * has NO boost and so *fails* its `>0.7` gate on the identical malformed output.
 * Identical parseable-but-malformed output therefore over-escalates on four paths and
 * under-creates orders on one. The asymmetry is a code policy, not a model property
 * (DP-GPR-16: eliminate).
 *
 * RC-08: every one of those gates is a hard `>` threshold over a non-deterministic
 * classifier score, so boundary phrasing (a true confidence hovering at the threshold)
 * flips outcome-class run-to-run.
 *
 * This module is the single source of truth for the confidence *contract* and is a pure,
 * in-process, network-free helper set (mirrors `productInformationGapHelpers.ts`). The
 * behavioural change is gated by `CONFIDENCE_CONTRACT_SYMMETRY` and the flag is threaded
 * as an explicit `applySymmetry` argument (as P0-3 threads `GAP_GATE_DETERMINISTIC_FIRST`
 * into `decideGapEscalation`) so both branches are unit-testable in one process. With the
 * flag OFF every helper reproduces the legacy per-site behaviour byte-for-byte.
 */
import { z } from 'zod';

/**
 * P1-3 (RC-07/RC-08): when ON, the confidence contract is symmetric across all five
 * intent detectors — a missing/zero confidence never auto-passes a gate (the four
 * escalation boosts are removed → those paths abstain; the order/affirmation path keeps
 * its deterministic order-stage slot fallback so it does not asymmetrically forfeit
 * revenue) — and every hard threshold gains a symmetric abstain band so boundary scores
 * resolve deterministically. Defaults OFF: flag-off preserves the legacy per-site boosts
 * and hard `>` gates byte-for-byte. Flip per environment (staging first, the DP-GPR-16
 * five-detector fail-direction assertion + boundary-corpus replay as the gate) per the
 * remediation plan.
 */
export const CONFIDENCE_CONTRACT_SYMMETRY =
  (process.env.CONFIDENCE_CONTRACT_SYMMETRY ?? 'false').trim().toLowerCase() === 'true';

/**
 * Half-width of the symmetric abstain band applied around every hard confidence gate when
 * `CONFIDENCE_CONTRACT_SYMMETRY` is ON (RC-08). A score within `±band` of the threshold
 * resolves to `abstain` (never fires the action) so boundary phrasing is a deterministic
 * function of the score rather than a coin-flip. Configurable without a deploy; clamped to
 * a sane `[0, 0.25]` range with a `0.05` default.
 */
export const CONFIDENCE_HYSTERESIS_BAND = (() => {
  const raw = process.env.CONFIDENCE_HYSTERESIS_BAND;
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 0.25 ? n : 0.05;
})();

/**
 * The required-`confidence` output contract (DP-GPR-16). `confidence` is a REQUIRED,
 * range-checked number (`[0, 100]` — values in `(1, 100]` are the C-63 percentage scale,
 * normalized by `/100` downstream; anything outside is a contract violation). A classifier
 * output that omits it fails the contract (`safeParse().success === false`). The intent
 * booleans are optional here because each detector layers its own intent shape on top — the
 * contract's job is solely to make `confidence` a mandatory, typed, bounded field.
 */
export const confidenceContractSchema = z
  .object({
    confidence: z.number().min(0).max(100),
  })
  .passthrough();

/**
 * Runtime enforcement of {@link confidenceContractSchema} on a parsed detector payload —
 * the production wiring of the contract (previously the schema had no call sites). Emits
 * the `[CONFIDENCE_CONTRACT]` violation marker so the omission rate is measurable, and
 * hands the raw `confidence` (usable or not) back to the caller's normalize/resolve path,
 * whose fail direction is owned by `resolveEscalationConfidence` / the affirmation slot
 * check — a violation therefore never throws and never silently passes a gate.
 */
export function enforceConfidenceContract(
  payload: unknown,
  detector: string,
): { rawConfidence: unknown; contractViolated: boolean } {
  const result = confidenceContractSchema.safeParse(payload);
  if (result.success) {
    return { rawConfidence: result.data.confidence, contractViolated: false };
  }
  const rawConfidence =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>).confidence
      : undefined;
  console.warn(
    `[CONFIDENCE_CONTRACT] violation detector: ${detector} confidence: ${JSON.stringify(rawConfidence) ?? 'undefined'} — required range-checked field missing/invalid`,
  );
  return { rawConfidence, contractViolated: true };
}

/**
 * Normalizes a raw model `confidence` into `[0, 1]`.
 *  - number or numeric string;
 *  - 0–1 as-is, `>1 ⇒ /100` (the C-63 percentage scale-guess) — normalized in-contract so
 *    every detector shares one interpretation (previously `detectOrderAffirmationIntent`
 *    carried its own inline copy of this logic);
 *  - anything non-finite / unparseable ⇒ 0, then clamped to `[0, 1]`.
 */
export function normalizeClassifierConfidence(raw: unknown): number {
  let confidence = 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    confidence = raw > 1 ? raw / 100 : raw;
  } else if (typeof raw === 'string') {
    const n = parseFloat(raw.trim());
    if (Number.isFinite(n)) confidence = n > 1 ? n / 100 : n;
  }
  return Math.min(1, Math.max(0, confidence));
}

/** True when the raw model `confidence` is a usable numeric value (0 counts as usable). */
export function hasUsableConfidence(raw: unknown): boolean {
  if (typeof raw === 'number') return Number.isFinite(raw);
  if (typeof raw === 'string') return Number.isFinite(parseFloat(raw.trim()));
  return false;
}

/**
 * Uniform missing-confidence policy for the four ESCALATION detectors (DP-GPR-16).
 *
 *  - `applySymmetry` ON: return the normalized value with NO boost. A model that asserts
 *    the intent boolean but omits/zeroes confidence therefore leaves confidence low, so the
 *    boolean alone can never clear the `>0.8`/`>0.82` gate — the path abstains rather than
 *    auto-escalating (the single consistent fail-direction the order/affirmation path
 *    already had).
 *  - `applySymmetry` OFF: reproduce the legacy per-site boost byte-for-byte — when the
 *    intent is asserted and the normalized confidence is exactly 0, return `legacyBoost`
 *    (0.9 for cancel/refund, wrong-product, post-purchase; 0.85 for order-info-update).
 */
export function resolveEscalationConfidence(args: {
  raw: unknown;
  intentAsserted: boolean;
  legacyBoost: number;
  applySymmetry: boolean;
}): number {
  return resolveEscalationConfidenceDetailed(args).confidence;
}

/**
 * {@link resolveEscalationConfidence} plus the RC-07 measurement the P1-5 decision ledger
 * records per gate: whether the legacy missing-confidence boost actually fired for this
 * decision (`boostApplied` is by construction always false with `applySymmetry` ON).
 */
export function resolveEscalationConfidenceDetailed(args: {
  raw: unknown;
  intentAsserted: boolean;
  legacyBoost: number;
  applySymmetry: boolean;
}): { confidence: number; boostApplied: boolean } {
  const normalized = normalizeClassifierConfidence(args.raw);
  if (args.applySymmetry) return { confidence: normalized, boostApplied: false };
  if (args.intentAsserted && normalized === 0) {
    return { confidence: args.legacyBoost, boostApplied: true };
  }
  return { confidence: normalized, boostApplied: false };
}

export type GateVerdict = 'pass' | 'abstain' | 'fail';

/**
 * Classifies a confidence/score against a hard threshold, applying the symmetric abstain
 * band (RC-08) when `applySymmetry` is ON. The verdict is a pure, deterministic function of
 * the score — replaying the same score N× always yields the same label.
 *
 *  - `applySymmetry` OFF (legacy): `> threshold ⇒ pass`, otherwise `fail`. There is no
 *    abstain zone, matching the historical hard `>` gates byte-for-byte.
 *  - `applySymmetry` ON: `≥ threshold+band ⇒ pass`; `≤ threshold−band ⇒ fail`; strictly
 *    inside the band ⇒ `abstain`. For every consumer here (escalate / create-order) both
 *    `abstain` and `fail` mean "do not fire the action", i.e. the effective firing bar is
 *    `threshold+band`, and the `abstain` label is surfaced for boundary observability.
 */
export function classifyConfidenceGate(args: {
  confidence: number;
  threshold: number;
  band: number;
  applySymmetry: boolean;
}): GateVerdict {
  const { confidence, threshold, applySymmetry } = args;
  if (!applySymmetry) return confidence > threshold ? 'pass' : 'fail';
  // Cap the band so `threshold + band` can never exceed 1: confidence is clamped to [0, 1],
  // so an over-wide band would otherwise make the gate permanently unpassable — a silent
  // kill switch on the action it protects.
  const band = Math.max(0, Math.min(args.band, 1 - threshold));
  if (confidence >= threshold + band) return 'pass';
  if (confidence <= threshold - band) return 'fail';
  return 'abstain';
}

/**
 * Boolean convenience over {@link classifyConfidenceGate}: does the score clear the gate
 * (fire the action)? Only a `pass` fires; `abstain` and `fail` do not. With `applySymmetry`
 * OFF this is exactly the legacy `confidence > threshold`.
 */
export function passesConfidenceGate(
  confidence: number,
  threshold: number,
  applySymmetry: boolean,
  band: number = CONFIDENCE_HYSTERESIS_BAND,
): boolean {
  return classifyConfidenceGate({ confidence, threshold, band, applySymmetry }) === 'pass';
}

/**
 * Loose E.164-shape validator used by the order path's deterministic slot check: an
 * optional leading `+` followed by 7–15 digits (ITU-T E.164 caps the national+country
 * number at 15 digits; 7 is a pragmatic floor for the shortest Kosovo/Albanian mobile
 * numbers once a country/area code is present). Accepts common separators (spaces, dashes,
 * parentheses) by stripping them first. This is intentionally a *shape* check — it never
 * blocks order creation on its own (see the note in `processAIReply.ts`); it exists so a
 * missing-confidence order affirmation can be corroborated by a structurally-valid phone
 * rather than merely a non-empty string.
 */
export function isLikelyE164Phone(phone: unknown): boolean {
  if (typeof phone !== 'string') return false;
  const trimmed = phone.trim();
  if (!trimmed) return false;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  // Reject stray letters embedded in the candidate (a real phone is digits + separators).
  const body = hasPlus ? trimmed.slice(1) : trimmed;
  return /^[\d\s().-]+$/.test(body);
}
