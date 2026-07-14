/**
 * P1-5: the write-side glue for the AI decision ledger, kept out of the 4500-line processAIReply.
 *
 * - `buildLedgerRecord` maps generateReply's telemetry + the orchestrator's accumulated decision
 *   events + guard verdicts + correlation context into a `LedgerRecord`.
 * - `enqueueLedgerViaOutbox` writes the ledger row THROUGH P1-1's outbox inside the reply-flip
 *   transaction (stageAndSend `onFlip`), under a SAVEPOINT so a ledger failure can never poison
 *   the flip and roll back a delivered reply (Postgres aborts the whole txn on any error).
 * - `writeLedgerBestEffort` is the direct fire-and-forget path for early returns that never reach
 *   the flip txn ([NO_REPLY], sensitive acks, holding messages, the legacy non-staged send).
 *
 * All writes are gated by AI_DECISION_LEDGER_ENABLED (default off) → zero behaviour change when off.
 */
import type { PoolClient } from 'pg';
import { deriveReplyIdempotencyKey, type ReplySlot } from '../services/replyIdempotency';
import { insertOutboxTx } from '../db/models/outbox';
import {
  buildLedgerOutboxPayload,
  insertLedgerBestEffort,
  insertLedgerTx,
  ledgerDedupeKey,
  type LedgerDecisionEvent,
  type LedgerRecord,
} from '../db/models/aiDecisionLedger';
import type { ReplyTelemetry } from '../services/aiTelemetry';
import { getTrackedOpenAICalls } from '../services/openaiCallTracker';
import { logger } from '../utils/logger';

const AI_DECISION_LEDGER_ENABLED =
  (process.env.AI_DECISION_LEDGER_ENABLED ?? 'false').trim().toLowerCase() === 'true';

// The relay actually performs outbox effects only when BOTH flags are on. In shadow mode
// (relay on, dispatch off) the relay claims rows and marks them done WITHOUT effect — safe for
// topics the legacy path still delivers (ai.reply), but a `ledger.write` row has no legacy
// fallback and would be silently discarded. So when the relay does not own dispatch, the flip
// writes the ledger row DIRECTLY on the flip transaction (still under the savepoint) instead
// of enqueueing a row the relay would shadow-drain.
const OUTBOX_LEDGER_DISPATCH_ENABLED =
  (process.env.OUTBOX_RELAY_ENABLED ?? 'false').trim().toLowerCase() === 'true' &&
  (process.env.OUTBOX_DISPATCH_ENABLED ?? 'false').trim().toLowerCase() === 'true';

export function isDecisionLedgerEnabled(): boolean {
  return AI_DECISION_LEDGER_ENABLED;
}

export interface BuildLedgerRecordInput {
  tenantId: string;
  conversationId: string;
  /** Per-message correlation (AIReplyJobData.messageExternalId) — burst-merge collapses traceId. */
  correlationId: string;
  traceId?: string | null;
  /** 'main' joins to ai_reply_staging.idempotency_key; early returns use their own slot. */
  replySlot: string;
  decisionKind: string;
  messageId?: string | null;
  telemetry?: ReplyTelemetry;
  decisionEvents: LedgerDecisionEvent[];
  guardVerdicts?: Record<string, unknown>;
}

/**
 * P1-5 (C-108): the ledger's usage blob — the main completion's usage from `generateReply`'s
 * telemetry, plus EVERY OpenAI call the job made (from the AsyncLocalStorage call tracker).
 * A row is written even when the main telemetry is absent (ack/[NO_REPLY] paths) so their
 * classifier calls still surface in COGS.
 */
function buildLedgerUsage(t: ReplyTelemetry | undefined): LedgerRecord['usage'] {
  const calls = getTrackedOpenAICalls();
  const hasCalls = !!calls && calls.length > 0;
  if (!t && !hasCalls) return null;
  const pricedCosts = hasCalls
    ? calls.map((c) => c.usd_cost).filter((c): c is number => typeof c === 'number')
    : [];
  return {
    prompt_tokens: t?.usage.promptTokens ?? null,
    completion_tokens: t?.usage.completionTokens ?? null,
    total_tokens: t?.usage.totalTokens ?? null,
    usd_cost: t?.usage.usdCost ?? null,
    calls: hasCalls ? calls : undefined,
    call_count: hasCalls ? calls.length : undefined,
    calls_usd_cost:
      pricedCosts.length > 0
        ? Math.round(pricedCosts.reduce((sum, c) => sum + c, 0) * 1_000_000) / 1_000_000
        : undefined,
  };
}

export function buildLedgerRecord(input: BuildLedgerRecordInput): LedgerRecord {
  const idempotencyKey = deriveReplyIdempotencyKey({
    conversationId: input.conversationId,
    logicalInboundExternalId: input.correlationId,
    // The key derivation is slot-agnostic at runtime (it hashes the joined strings); the cast lets
    // early-return slots outside the ReplySlot union ('none', escalation acks) reuse it.
    replySlot: input.replySlot as ReplySlot,
  });
  const t = input.telemetry;
  return {
    tenant_id: input.tenantId,
    conversation_id: input.conversationId,
    message_id: input.messageId ?? null,
    correlation_id: input.correlationId,
    trace_id: input.traceId ?? null,
    idempotency_key: idempotencyKey,
    reply_slot: input.replySlot,
    decision_kind: input.decisionKind,
    prompt: t
      ? {
          hash: t.prompt.hash,
          char_count: t.prompt.charCount,
          token_estimate: t.prompt.tokenEstimate,
          preview: t.prompt.preview,
        }
      : null,
    model: t
      ? {
          requested: t.model.requested,
          served: t.model.served,
          custom_model_used: t.model.customModelUsed,
          temperature: t.model.temperature,
          max_tokens: t.model.maxTokens,
          seed: t.model.seed,
          finish_reason: t.model.finishReason,
          truncated: t.model.truncated,
          system_fingerprint: t.model.systemFingerprint,
        }
      : null,
    usage: buildLedgerUsage(t),
    retrieval: t?.retrieval
      ? {
          semantic_skipped: t.retrieval.semanticSkipped,
          skip_reason: t.retrieval.skipReason,
          threshold: t.retrieval.threshold,
          core_count: t.retrieval.coreCount,
          band_count: t.retrieval.bandCount,
          sources: t.retrieval.sources,
          top: t.retrieval.top,
          product_ids: t.retrieval.productIds,
        }
      : null,
    decision_events: input.decisionEvents,
    guard_verdicts: input.guardVerdicts ?? {},
    facts_used: null,
  };
}

/**
 * Enqueue the ledger row via the outbox INSIDE the reply-flip transaction (onFlip). Wrapped in a
 * SAVEPOINT: on any error we ROLLBACK TO the savepoint (clearing the txn's aborted state) and
 * swallow, so the flip's `createMessageTx` + `flipStagingTx` still commit — a ledger write can
 * never fail or roll back a delivered reply. No-op when the flag is off.
 */
export async function enqueueLedgerViaOutbox(
  client: PoolClient,
  record: LedgerRecord,
): Promise<void> {
  if (!AI_DECISION_LEDGER_ENABLED) return;
  await client.query('SAVEPOINT ai_ledger');
  try {
    if (OUTBOX_LEDGER_DISPATCH_ENABLED) {
      await insertOutboxTx(client, {
        tenant_id: record.tenant_id,
        conversation_id: record.conversation_id,
        topic: 'ledger.write',
        dedupe_key: ledgerDedupeKey(record.idempotency_key),
        payload: buildLedgerOutboxPayload(record),
      });
    } else {
      // Relay dispatch off → write the (redacted, idempotent) row directly in the flip txn.
      await insertLedgerTx(client, record);
    }
    await client.query('RELEASE SAVEPOINT ai_ledger');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT ai_ledger').catch(() => undefined);
    logger.error(
      '[ai_decision_ledger] outbox enqueue failed inside flip (savepoint rolled back)',
      err,
      {
        conversationId: record.conversation_id,
        correlationId: record.correlation_id,
      },
    );
  }
}

/** Direct best-effort write for paths with no flip txn. Fire-and-forget; never throws. */
export async function writeLedgerBestEffort(record: LedgerRecord): Promise<void> {
  if (!AI_DECISION_LEDGER_ENABLED) return;
  await insertLedgerBestEffort(record);
}
