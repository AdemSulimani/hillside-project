/**
 * P1-1 (RC-20): pure decision core for the idempotent post-send pipeline.
 *
 * RC-20: the outbound channel send happens BEFORE the DB persist, and
 * `messages.external_message_id` carries a GLOBAL NOT NULL UNIQUE. On a BullMQ retry after a
 * crash-between-send-and-ack the whole job re-runs: FB/IG/Viber re-INSERT collides on the
 * global UNIQUE and dead-letters a DELIVERED reply's side-effects; WhatsApp/Viber (null send
 * id → a fresh `ai_${uuid}` per attempt) insert a SECOND row whose text is a freshly-sampled
 * generation ≠ what the customer saw.
 *
 * The fix stages a durable reply row BEFORE the send, keyed by a stable idempotency key, and
 * flips staged→sent in the same transaction that persists the delivered `messages` row. On
 * retry a `sent` staging row no-ops the send and re-drives only unfinished side-effects; the
 * persisted text is authoritative and never regenerated.
 *
 * This module holds the PURE, I/O-free pieces (the key derivation, the deterministic null-send
 * placeholder, the send-action predicate) so they are unit-testable without a DB — mirroring
 * the P0-6 `rateLimitDeliveredCount` / P0-4 `sensitivePathFailClosed` split. The side-effectful
 * `stageAndSend` composition (staging upsert, channel send, the flip transaction, outbox
 * side-effects) lives in `jobs/processAIReply.ts`.
 *
 * The whole behaviour is gated on `AI_REPLY_STAGE_BEFORE_SEND`: flag OFF keeps the legacy
 * send-then-`createMessage` path (with its existing Redis `ai_send_done` marker) byte-for-byte.
 */

import { createHash } from 'crypto';

/**
 * A logical outbound slot within one AI-reply job. Each distinct send in a job gets its own
 * slot so it is independently idempotent (a holding message and the main reply never collide),
 * while a RETRY of the same slot collides on the idempotency key and no-ops.
 *
 * `image:<productId>` is a template — `imageReplySlot()` builds the concrete value.
 */
export type ReplySlot =
  | 'main'
  | 'holding:knowledge_gap'
  | 'holding:price'
  | 'holding:product_name'
  | 'holding:uncertain'
  | 'holding:sensitive'
  | 'holding:post_purchase'
  /** P2-6: the graceful-degradation floor — the provider failed mid-turn, so we hold + escalate. */
  | 'holding:degraded'
  | 'ack:order'
  | 'ack:order_info'
  | 'ack:eta'
  | 'ack:wrong_product'
  | 'confirm:order'
  | 'clarify'
  | `image:${string}`;

/** The concrete image slot for a product image send. */
export function imageReplySlot(productId: string): ReplySlot {
  return `image:${productId}`;
}

/** Field separator that cannot appear inside a UUID / external id, so field boundaries in the
 * hashed tuple cannot be forged by concatenation (`a` + `b` vs `a\0b` hash differently). */
const KEY_FIELD_SEPARATOR = '\0';

/**
 * Derive the stable idempotency key for one logical outbound reply.
 *
 * Keyed on the LOGICAL inbound this reply answers (`AIReplyJobData.messageExternalId`, which is
 * identical across every BullMQ retry of the same message and, after burst-merge, equals the
 * latest inbound's external id) — NOT the BullMQ attempt number. So a retry produces the same
 * key and collides on `ai_reply_staging.idempotency_key`, which is what makes the send no-op.
 */
export function deriveReplyIdempotencyKey(args: {
  conversationId: string;
  logicalInboundExternalId: string;
  replySlot: ReplySlot;
}): string {
  return createHash('sha256')
    .update(
      [args.conversationId, args.logicalInboundExternalId, args.replySlot].join(
        KEY_FIELD_SEPARATOR,
      ),
    )
    .digest('hex');
}

/**
 * Deterministic `external_message_id` for the WhatsApp/Viber null-send path.
 *
 * The channel Send API returns no id for WhatsApp (and sometimes Viber), so the legacy path
 * synthesised a FRESH `ai_${uuid}` on every attempt → a retry inserted a duplicate row. Deriving
 * the placeholder from the (stable) idempotency key makes it identical across retries, so the
 * flip's `ON CONFLICT (tenant_id, external_message_id) DO NOTHING` no-ops the duplicate. The
 * value is written to `ai_reply_staging.external_message_id` at the first flip and read back on
 * resume (the DB is authoritative; this only seeds the first write).
 */
export function nullSendPlaceholderExternalId(idempotencyKey: string): string {
  return `ai_${idempotencyKey.slice(0, 32)}`;
}

/** Staging lifecycle status, mirrored from the `ai_reply_staging.status` CHECK. */
export type StagingStatus = 'staged' | 'sent' | 'failed';

/**
 * What to do about the CHANNEL SEND given the current staging state.
 *   'send'   — no prior delivery for this slot; send now.
 *   'resend' — a prior attempt's send failed and we are under the attempt cap; try again.
 *   'noop'   — do NOT hit the channel: either already delivered (`sent` → self-heal the flip)
 *              or the send attempts are exhausted (`failed` at/over cap → record failure, no
 *              further re-send). The caller distinguishes the two by the row's status.
 */
export type SendAction = 'send' | 'resend' | 'noop';

export function decideSendAction(args: {
  status: StagingStatus | null;
  sendAttempts: number;
  maxSendAttempts: number;
}): SendAction {
  if (args.status === 'sent') return 'noop';
  if (args.status === 'failed') {
    return args.sendAttempts < args.maxSendAttempts ? 'resend' : 'noop';
  }
  // null (row not present yet) or 'staged' — first delivery attempt for this slot.
  return 'send';
}
