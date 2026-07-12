/**
 * P0-5 (RC-14, RC-06): pure decision core for AI auto-resume.
 *
 * RC-14: `ai_paused`, the rate-limit pause, and `human_override_until` have NO automatic
 * re-enable — a pause exits only via a human toggle or an alert resolved with an explicit
 * `resume_ai:true`, and alert resolution defaults to LEAVING the pause on. Because
 * escalations overwhelmingly fire on the final turn, a healthy conversation goes
 * permanently silent the moment any guard escalates.
 *
 * Two decisions live here as pure, I/O-free predicates (mirroring the P0-4
 * `sensitivePathFailClosed` split), so the policy is unit-testable without a DB/Redis:
 *   - `shouldResumeOnResolve`      — when resolving an alert, should the AI resume? (part 2)
 *   - `shouldAutoResumeRateLimitPause` — should a new inbound clear a rate-limit pause? (part 3)
 *
 * Both are gated on `autoResumeEnabled` (the `AI_AUTO_RESUME` flag, read by the callers):
 * flag OFF preserves the legacy resume-only-via-explicit-`resume_ai:true` behaviour
 * byte-for-byte.
 */

/**
 * Alert reasons that represent a SENSITIVE case a human must own: a cancellation, a
 * refund, or post-purchase support (delivery/product issue). These NEVER auto-resume — a
 * human must explicitly resume. Kept here (a pure module) rather than in `db/models` so
 * importing it never pulls in a DB connection.
 */
export const SENSITIVE_ALERT_REASONS = [
  'cancellation_request',
  'refund_request',
  'post_purchase_support_request',
] as const;

export type SensitiveAlertReason = (typeof SENSITIVE_ALERT_REASONS)[number];

/** True if `reason` is one of the sensitive reasons that must never auto-resume. */
export function isSensitiveAlertReason(reason: string | null | undefined): boolean {
  return reason != null && (SENSITIVE_ALERT_REASONS as readonly string[]).includes(reason);
}

/**
 * Part 2 — should resolving an alert resume the AI for its conversation?
 *
 *  - explicit `resume_ai === true`  → resume (the legacy explicit-resume path, always honoured).
 *  - explicit `resume_ai === false` → stay paused (an explicit human decision to keep it paused).
 *  - omitted (`undefined`):
 *      · flag OFF                 → stay paused (legacy default — resume only via explicit true).
 *      · unknown/legacy reason    → stay paused (a NULL reason is treated as "require explicit").
 *      · SENSITIVE reason         → stay paused (cancellation/refund/post-purchase need a human).
 *      · otherwise (non-sensitive)→ resume (the P0-5 default that ends the silent dead-end).
 */
export function shouldResumeOnResolve(
  reason: string | null | undefined,
  explicitResumeAi: boolean | undefined,
  autoResumeEnabled: boolean,
): boolean {
  if (explicitResumeAi === true) return true;
  if (explicitResumeAi === false) return false;
  if (!autoResumeEnabled) return false;
  if (reason == null) return false;
  if (isSensitiveAlertReason(reason)) return false;
  return true;
}

/**
 * Part 3 — should a new inbound clear a `rate_limit_exceeded` pause?
 *
 * All conjuncts must hold:
 *  - the flag is on;
 *  - the conversation is actually paused for the rate-limit reason;
 *  - the delivered-only (P0-6) rate counter has ROLLED OVER (its Redis key expired) — so a
 *    genuine hour of real replies has elapsed, not a phantom pause;
 *  - there is no OPEN sensitive alert (a human may be mid-handling a refund/cancellation);
 *  - there is no ACTIVE human hold (resuming would also wipe `human_override_until`, and a
 *    human is actively handling the thread within the hold window).
 */
export function shouldAutoResumeRateLimitPause(args: {
  autoResumeEnabled: boolean;
  aiPaused: boolean;
  reason: string | null;
  rateKeyExists: boolean;
  hasOpenSensitiveAlert: boolean;
  humanOverrideActive: boolean;
}): boolean {
  return (
    args.autoResumeEnabled &&
    args.aiPaused &&
    args.reason === 'rate_limit_exceeded' &&
    !args.rateKeyExists &&
    !args.hasOpenSensitiveAlert &&
    !args.humanOverrideActive
  );
}
