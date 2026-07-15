import { z } from 'zod';
import type { ChannelType } from '../db/models/channel';
import type { ReceiptSnapshot } from '../services/receiptSnapshot';

export interface InboundWebhookJobData {
  channelType: ChannelType;
  payload: Record<string, unknown>;
  /**
   * Correlation ID generated at webhook ingestion time (crypto.randomUUID).
   * Propagated through every downstream job so a single `grep traceId=<uuid>`
   * in logs returns the complete lifecycle of one inbound message.
   */
  traceId: string;
  /**
   * P2-4 Part 2 (RC-06): epoch ms the webhook was received, stamped in the controller next to
   * `traceId`. The receipt snapshot itself is captured later — in processInboundMessage, the first
   * point the conversation row exists and the point the deliberate 8s deferral is applied — so
   * this is what makes the gap between true receipt and capture a measured number instead of an
   * assumption. Free and content-free, exactly like `traceId`.
   * Optional: absent on jobs enqueued before this shipped.
   */
  receivedAtMs?: number;
}

export interface AIReplyJobData {
  tenantId: string;
  channelId: string;
  conversationId: string;
  messageExternalId: string;
  /** Correlation ID from the originating webhook — see InboundWebhookJobData.traceId. */
  traceId?: string;
  /**
   * P2-4 Part 2 (RC-06): enablement/config state as it stood at RECEIPT, before this job's
   * deliberate AI_REPLY_DELAY_MS deferral. RECORD-ONLY — the gates in processAIReply still read
   * live state; this is compared against them and written to the decision ledger so a message
   * whose outcome turned on a mid-window toggle leaves an artifact. (RC-06's stated defect is the
   * MISSING ARTIFACT, not the late read — see services/receiptSnapshot.ts for why governing the
   * gates from a snapshot is unsafe.)
   *
   * Optional, and every consumer must treat absence as "fall back to live, record nothing": jobs
   * enqueued before this shipped, `transactional_outbox` rows pending at deploy, and every job
   * while RECEIPT_TIME_SNAPSHOT is off all lack it.
   */
  receiptSnapshot?: ReceiptSnapshot;
}

/**
 * P2-4 Part 2: the single constructor for every `ai.reply` payload.
 *
 * Two of the four producer sites build the payload for `upsertLiveAiReplyTx`, whose `payload` is
 * `Record<string, unknown>`, and the relay re-hydrates it through `aiQueueAdd(data: unknown)` — so
 * BOTH erase this interface, and a forgotten field there compiles clean. Those are also exactly
 * the sites that become the ONLY live producers once the outbox owns delivery
 * (INBOUND_OUTBOX_ENQUEUE + OUTBOX_DISPATCH_ENABLED), i.e. the unchecked sites are the ones that
 * end up mattering. Routing all four through one typed factory makes the payload a real contract
 * instead of four object literals that drift — which has already happened once: the edit path
 * silently lost `traceId`.
 */
export function buildAIReplyJobData(input: AIReplyJobData): AIReplyJobData {
  return {
    tenantId: input.tenantId,
    channelId: input.channelId,
    conversationId: input.conversationId,
    messageExternalId: input.messageExternalId,
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
    ...(input.receiptSnapshot !== undefined ? { receiptSnapshot: input.receiptSnapshot } : {}),
  };
}

const receiptSnapshotSchema = z.object({
  capturedAtMs: z.number().finite(),
  receivedAtMs: z.number().finite().nullable(),
  aiActive: z.boolean(),
  aiConfigVersion: z.number().finite(),
  channelAiEnabled: z.boolean(),
  conversationAiPaused: z.boolean(),
  humanOverrideUntil: z.string().nullable(),
  matchCount: z.number().finite().nullable(),
});

/**
 * P2-4 Part 2: the ONE boundary where an ai.reply payload genuinely crosses Postgres JSONB
 * untyped — `transactional_outbox.payload` written by `upsertLiveAiReplyTx` and re-hydrated by the
 * relay. The relay previously did `row.payload as unknown as AIReplyJobData`: a raw cast that
 * asserts a shape nothing checked, over a value that may have been written by a PREVIOUS deploy.
 *
 * `receiptSnapshot` is `.optional()` and the snapshot object is validated structurally, which is
 * what makes rows pending across this deploy safe: they simply parse without one, and every
 * consumer treats absence as "fall back to live". A malformed snapshot is stripped rather than
 * trusted — the alternative is `undefined` fields reading as falsy, i.e. silently "AI disabled".
 */
export const aiReplyJobDataSchema = z.object({
  tenantId: z.string().min(1),
  channelId: z.string().min(1),
  conversationId: z.string().min(1),
  messageExternalId: z.string().min(1),
  traceId: z.string().optional(),
  receiptSnapshot: receiptSnapshotSchema.optional().catch(undefined),
});
