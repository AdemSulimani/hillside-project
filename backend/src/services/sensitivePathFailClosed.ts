/**
 * P0-4 (RC-19, RC-22): fail-CLOSED policy for the pre-reply sensitive-escalation
 * subsystem in `processAIReply.ts`.
 *
 * RC-19: the whole pre-reply special-path block (cancellation/refund, wrong-product,
 * post-purchase, order-info, escalation) sits inside a single umbrella try/catch whose
 * catch logs `console.warn('...continuing normal flow')` and falls through to
 * `generateReply`. Any throw inside — a classifier transport error, a DB write failure,
 * a contact lookup — silently downgrades a refund/cancellation demand into an ordinary
 * sales reply, with no alert, no pause, no order flag, and (because the throw is
 * swallowed) no BullMQ retry. RC-22 is the sibling swallow on the post-send
 * intent-detect / draft-order block.
 *
 * This module holds the PURE decision core so the policy is unit-testable without a
 * network/DB/OpenAI, mirroring the P0-3 `productInformationGapHelpers` split. The
 * side-effectful wiring (holding message, alert, pause, re-throw) lives in
 * `processAIReply.ts`, which composes these.
 *
 * The whole behaviour is gated on the `SENSITIVE_PATH_FAIL_CLOSED` flag: flag OFF
 * returns `'continue'` for every failure kind, preserving the legacy fail-OPEN
 * umbrella (warn + fall through to a normal reply) byte-for-byte.
 */

/**
 * Where in the sensitive special-path block a throw originated, relative to whether an
 * outbound message has already been put on the wire.
 *
 *  - `detector`  — a SENSITIVE detector call itself threw (cancellation/refund,
 *                  wrong-product, post-purchase, order-info). No side effect has run
 *                  yet, so the safe response is to ESCALATE to a human.
 *  - `pre_send`  — a throw elsewhere in the block BEFORE any send/ack went out (e.g. an
 *                  order-signal detector, a DB write). Safe to RETRY: nothing was
 *                  delivered, so a BullMQ re-run cannot double-send.
 *  - `post_send` — a throw AFTER a send/ack already went out. Retrying would re-run the
 *                  whole job and double-send the delivered message (RC-20), so we must
 *                  fall through (`continue`) rather than re-throw.
 */
export type SensitivePathFailureKind = 'detector' | 'pre_send' | 'post_send';

/**
 * What the caller should do with a swallowed sensitive-path failure.
 *
 *  - `escalate` — route to the safe escalation path (holding message + alert + pause)
 *                 instead of a normal sales reply, then stop.
 *  - `retry`    — re-throw so BullMQ retries the job.
 *  - `continue` — legacy fail-OPEN: log and fall through to `generateReply` (flag off),
 *                 or decline to re-throw because a message already went out (post-send).
 */
export type SensitivePathAction = 'escalate' | 'retry' | 'continue';

/**
 * The whole P0-4 fail-closed policy as a pure function.
 *
 * Flag OFF → always `continue` (legacy umbrella: warn + fall through to a normal reply).
 * Flag ON  → fail closed by failure kind: escalate a failed detector, retry a pre-send
 *            error, and (critically) `continue` a post-send error so a retry cannot
 *            double-send an already-delivered reply (RC-20).
 */
export function decideSensitivePathAction(
  kind: SensitivePathFailureKind,
  failClosed: boolean,
): SensitivePathAction {
  if (!failClosed) {
    return 'continue';
  }
  switch (kind) {
    case 'detector':
      return 'escalate';
    case 'pre_send':
      return 'retry';
    case 'post_send':
      return 'continue';
    default:
      return 'continue';
  }
}

/**
 * Sentinel thrown after a sensitive detector error has ALREADY been handled by the safe
 * escalation path (holding message + alert + pause). The umbrella catch recognises it
 * and returns cleanly — i.e. it stops the special-path block WITHOUT falling through to
 * `generateReply` (the exact fail-open this fixes) and WITHOUT re-throwing for a retry
 * (the escalation already happened; a retry would double-send the holding message).
 */
export class SensitivePathEscalatedError extends Error {
  constructor() {
    super('sensitive-path escalated (fail-closed)');
    this.name = 'SensitivePathEscalatedError';
  }
}
