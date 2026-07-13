/**
 * P1-1 (RC-20): the durable stage-before-send + transactional-flip choke point.
 *
 * Every outbound reply that persists a `messages` row (the main AI reply and the escalation /
 * holding / ack / clarify sends) routes through `stageAndSend`. It:
 *   1. Stages the reply row (authoritative text + guard verdicts) BEFORE the channel send. On a
 *      BullMQ retry the `ON CONFLICT (idempotency_key) DO NOTHING` returns the FIRST attempt's
 *      staged text, so the customer-visible reply is never a fresh temp-0.3 re-generation.
 *   2. Sends (or no-ops the send when a `sent` staging row / the Redis send marker shows a prior
 *      attempt already delivered it).
 *   3. Flips staged→sent/failed, persists the delivered `messages` row with the real (or a
 *      deterministic null-send) external id via `ON CONFLICT (tenant_id, external_message_id) DO
 *      NOTHING`, and runs the caller's atomic side-effects — all in ONE transaction.
 *
 * `wasFirstDelivery` tells the caller whether this call actually delivered (true) or was a retry
 * no-op of an already-sent reply (false) — so the caller runs its non-idempotent side-effects
 * (alerts, analytics, use-case enqueue) exactly once.
 *
 * Gated by `AI_REPLY_STAGE_BEFORE_SEND` (+ a CSV channel allowlist). Flag off / channel not
 * allowlisted → `enabled: false` and the caller keeps its legacy send-then-createMessage path
 * byte-for-byte.
 */
import type { PoolClient } from 'pg';
import pool from '../db/pool';
import { redisConnection } from '../jobs/redisConnection';
import { createMessageTx, type Message, type MessageType } from '../db/models/message';
import { upsertStagingTx, flipStagingTx } from '../db/models/replyStaging';
import { markSelfSentMessageEcho } from './outboundEchoRegistry';
import {
  deriveReplyIdempotencyKey,
  decideSendAction,
  nullSendPlaceholderExternalId,
  type ReplySlot,
} from './replyIdempotency';
import type { ChannelSendMessageResult } from './channelSenderService';

const AI_REPLY_STAGE_BEFORE_SEND =
  (process.env.AI_REPLY_STAGE_BEFORE_SEND ?? 'false').trim().toLowerCase() === 'true';

/** CSV allowlist of channel types to stage (empty = all). e.g. `whatsapp,viber`. */
const STAGE_CHANNELS = (process.env.AI_REPLY_STAGE_BEFORE_SEND_CHANNELS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Cap on send attempts per staging row (a secondary guard under BullMQ's own attempt cap). */
const STAGE_SEND_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.AI_REPLY_STAGE_MAX_SEND_ATTEMPTS ?? '5') || 5,
);

/** Whether staging is active for a given channel type. */
export function isStageBeforeSendEnabled(channelType: string): boolean {
  if (!AI_REPLY_STAGE_BEFORE_SEND) return false;
  if (STAGE_CHANNELS.length === 0) return true;
  return STAGE_CHANNELS.includes(channelType.trim().toLowerCase());
}

export interface StageAndSendParams {
  tenantId: string;
  conversationId: string;
  channelType: string;
  /** The latest inbound external id this reply answers (AIReplyJobData.messageExternalId). */
  logicalInboundExternalId: string;
  replySlot: ReplySlot;
  /** The reply text this attempt generated. Overridden by the staged text on a retry. */
  replyText: string;
  messageType?: MessageType;
  attachmentUrls?: string[];
  /** Persisted-row fields. */
  qualityScore?: number | null;
  flagged?: boolean;
  flagReason?: string | null;
  productIds?: string[];
  /** Guard verdicts stored on the staging row for a resume flip. */
  guardVerdicts?: Record<string, unknown>;
  /** Perform the channel send of the (authoritative) text. */
  send: (text: string) => Promise<ChannelSendMessageResult>;
  /**
   * Caller side-effects that must be ATOMIC with the delivered message (e.g. an escalation pause
   * + alert). Runs inside the flip transaction, only on the first delivery. Throwing rolls back
   * the whole flip.
   */
  onFlip?: (client: PoolClient, message: Message, sendSucceeded: boolean) => Promise<void>;
}

export interface StageAndSendResult {
  /** False → staging disabled for this channel; caller must use its legacy path. */
  enabled: boolean;
  outboundMessage?: Message;
  sendResult?: ChannelSendMessageResult | null;
  /** True iff this call performed the send + flip (false = retry no-op of an already-sent reply). */
  wasFirstDelivery: boolean;
  /** The authoritative text actually sent/persisted (the staged text on a retry). */
  replyText: string;
}

/** The per-slot Redis send marker (belt-and-suspenders for the send-return→flip-commit window). */
function sendMarkerKey(conversationId: string, inboundExternalId: string, slot: ReplySlot): string {
  return `ai_send_done:${conversationId}:${inboundExternalId}:${slot}`;
}

async function withTxn<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function stageAndSend(params: StageAndSendParams): Promise<StageAndSendResult> {
  if (!isStageBeforeSendEnabled(params.channelType)) {
    return { enabled: false, wasFirstDelivery: false, replyText: params.replyText };
  }

  const {
    tenantId,
    conversationId,
    logicalInboundExternalId,
    replySlot,
  } = params;
  const key = deriveReplyIdempotencyKey({
    conversationId,
    logicalInboundExternalId,
    replySlot,
  });
  const messageType: MessageType = params.messageType ?? 'text';

  // 1. Stage (idempotent). On a retry this returns the FIRST attempt's row, so its text — not this
  //    attempt's regeneration — is authoritative.
  const staging = await withTxn((client) =>
    upsertStagingTx(client, {
      tenant_id: tenantId,
      conversation_id: conversationId,
      idempotency_key: key,
      reply_slot: replySlot,
      logical_inbound_external_id: logicalInboundExternalId,
      reply_text: params.replyText,
      attachment_urls: params.attachmentUrls,
      guard_verdicts: params.guardVerdicts,
    }),
  );
  const authoritativeText = staging.reply_text ?? params.replyText;

  // 2. Already fully delivered on a prior attempt → complete no-op.
  if (staging.status === 'sent') {
    let existing: Message | undefined;
    if (staging.message_id) {
      const { rows } = await pool.query<Message>('SELECT * FROM messages WHERE id = $1 LIMIT 1', [
        staging.message_id,
      ]);
      existing = rows[0];
    }
    return {
      enabled: true,
      wasFirstDelivery: false,
      replyText: authoritativeText,
      outboundMessage: existing,
      sendResult: {
        success: true,
        graphMessageId: staging.external_message_id ?? null,
      },
    };
  }

  // 3. Decide + perform the send.
  const action = decideSendAction({
    status: staging.status,
    sendAttempts: staging.send_attempts,
    maxSendAttempts: STAGE_SEND_MAX_ATTEMPTS,
  });
  const markerKey = sendMarkerKey(conversationId, logicalInboundExternalId, replySlot);
  const priorMarker = await redisConnection.get(markerKey).catch(() => null);
  const alreadySent = !!priorMarker;
  const priorGraphMessageId = priorMarker && priorMarker !== '1' ? priorMarker : null;

  let sendResult: ChannelSendMessageResult;
  if (action === 'noop') {
    // Send attempts exhausted — do not re-send; record a failed delivery so it stops retrying.
    sendResult = { success: false, error: 'send attempts exhausted' };
  } else if (alreadySent) {
    // Crash-before-flip: the send already happened on a prior attempt. Do NOT re-send.
    sendResult = { success: true, graphMessageId: priorGraphMessageId };
  } else {
    sendResult = await params.send(authoritativeText);
    if (sendResult.success) {
      await redisConnection
        .set(markerKey, sendResult.graphMessageId ?? '1', 'EX', 3600)
        .catch(() => undefined);
      await markSelfSentMessageEcho(sendResult.graphMessageId);
    }
  }

  const sendSucceeded = sendResult.success === true;
  const externalId =
    (sendSucceeded && sendResult.graphMessageId) ||
    staging.external_message_id ||
    nullSendPlaceholderExternalId(key);

  // 4. Flip: persist the delivered row + flip staging + caller's atomic side-effects, in one txn.
  const outboundMessage = await withTxn(async (client) => {
    const message = await createMessageTx(client, {
      tenant_id: tenantId,
      conversation_id: conversationId,
      external_message_id: externalId,
      direction: 'outbound',
      type: messageType,
      content: authoritativeText,
      attachment_urls: params.attachmentUrls,
      sent_by: 'ai',
      quality_score: params.qualityScore ?? null,
      flagged: params.flagged ?? false,
      flag_reason: params.flagReason ?? null,
      product_ids: params.productIds,
      send_status: sendSucceeded ? null : 'failed',
      send_error: sendSucceeded ? null : sendResult.error ?? null,
    });
    await flipStagingTx(client, {
      idempotency_key: key,
      status: sendSucceeded ? 'sent' : 'failed',
      external_message_id: externalId,
      message_id: message.id,
    });
    if (params.onFlip) {
      await params.onFlip(client, message, sendSucceeded);
    }
    return message;
  });

  return {
    enabled: true,
    wasFirstDelivery: true,
    replyText: authoritativeText,
    outboundMessage,
    sendResult,
  };
}
