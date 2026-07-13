/**
 * P0-7 (RC-24): pure decision core for classifying a native Instagram/Facebook echo as a
 * human agent reply vs the AI's own reply echoing back.
 *
 * RC-24: Meta echoes every message a Page/IG account sends back as an inbound webhook. On
 * INSTAGRAM those echoes carry NO `app_id`, so the `isHumanAgentEcho` heuristic reports the
 * AI's own reply as a human agent reply. A Redis self-send registry normally catches our own
 * echoes by message id, but its read returns "not ours" on both a genuine miss AND a Redis
 * error — so any registry miss (Redis hiccup, evicted key, TTL expiry, echo-before-persist)
 * falls through to the human-agent branch, which sets the sticky `human_replied` flag (which
 * DISQUALIFIES the use-case fee), a 10-minute human-override hold (which SILENCES the AI), and
 * a phantom `sent_by:'human'` row. Identical conversations then diverge on Redis timing.
 *
 * The fix corroborates a no-`app_id` echo against DURABLE state (a recently-persisted outbound
 * we sent) before classifying it as human, and fails toward "not human". A genuine human
 * reply's content will not match a recent outbound we sent, so real handoffs are preserved.
 *
 * This module holds the PURE, I/O-free predicate so the policy is unit-testable without Redis
 * or the DB, mirroring the P0-4 `sensitivePathFailClosed` / P0-6 `rateLimitDeliveredCount`
 * split. The side-effectful wiring (the registry read, the `findRecentOutboundMessageByContent`
 * lookup, and the human-classification branch) lives in `jobs/processInboundMessage.ts`, which
 * composes this. The whole behaviour is gated on the `ECHO_DURABLE_CORROBORATION` flag: flag
 * OFF preserves the legacy app_id-only classification byte-for-byte.
 *
 * The "an outbound the platform itself sent must NEVER set `human_replied`" invariant is
 * enforced structurally: a positive self-send registry hit returns early in the caller before
 * this predicate is consulted, so this function only ever runs for a registry miss/error.
 *
 * Documented residuals (accepted for this P0 slice):
 *  1. Image echoes on a registry miss — auto-sent product images are not persisted by the AI
 *     reply job, so there is no content row to corroborate against; an AI image echo on a
 *     registry miss is still classified human (mis-attribution + hold, not a dropped bubble).
 *     Practically a Redis-outage case. Text — the dominant RC-24 harm — is fixed. Durable
 *     follow-up: persist auto-sent images at send time so content corroboration covers them too.
 *  2. Content-collision false-negative — a genuine human reply whose full content exactly
 *     equals a recent (tight-window) outbound is suppressed. Mitigated by the tight
 *     corroboration window in the caller and full-message equality (not substring). Rated
 *     "vanishingly rare, low-harm"; the harm ordering favours shipping.
 */

/**
 * Whether a native echo that reached the human-agent branch should be classified as a HUMAN
 * reply (vs recognised as the AI's own echo).
 *
 * Flag OFF → always true: this branch is only reached for `app_id`-less native echoes with no
 * self-send registry hit, which legacy code always treats as human — preserved byte-for-byte.
 * Flag ON  → durable corroboration overrides the app_id heuristic: a content match against a
 * recent outbound we sent proves the echo is ours, so it is NOT a human reply.
 */
export function shouldClassifyEchoAsHuman(args: {
  durableCorroborationEnabled: boolean;
  contentMatchesRecentOutbound: boolean;
}): boolean {
  if (!args.durableCorroborationEnabled) return true;
  return !args.contentMatchesRecentOutbound;
}
