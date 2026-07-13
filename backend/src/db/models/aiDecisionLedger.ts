/**
 * P1-5 (RC-03/17/01/02/04/22): data-access for the append-only `ai_decision_ledger`.
 *
 * One row per AI reply decision. It captures everything the Phase 15 §15.2 reconstruction test
 * needs to recover an incident from the ledger ALONE — prompt provenance, model/params, token
 * usage + cost, retrieval scores/threshold outcomes/semanticSkipped, the per-classifier decision
 * chain, and the guard verdicts.
 *
 * Two write paths:
 *   - `insertLedgerTx(client, record)` — the RELAY path. The main reply enqueues a `ledger.write`
 *     transactional_outbox row inside the flip txn (atomic with the reply persist); the relay
 *     drains it and calls this. Assumes the payload was already redacted at enqueue, and re-runs
 *     the mandatory P1-6 pass idempotently as defense-in-depth.
 *   - `insertLedgerBestEffort(record)` — the DIRECT path for early returns ([NO_REPLY], sensitive
 *     acks, holding messages, and the legacy non-staged send) that never reach the flip txn. It
 *     redacts, inserts, and swallows any error so a ledger write can NEVER fail the reply.
 *
 * Raw parameterised SQL against the shared pool / a caller-supplied client (no-ORM convention;
 * mirrors db/models/outbox.ts and deadLetter.ts).
 */
import type { PoolClient } from 'pg';
import pool from '../pool';
import { REDACT_PII, redactPII, redactValue } from '../../utils/redact';

type Db = PoolClient | typeof pool;

export interface LedgerPromptProvenance {
  /** sha256 of the full assembled messages (integrity + "was the orphan directive injected?"). */
  hash: string;
  char_count: number;
  token_estimate: number;
  /** Size-capped, PII-masked copy of the system prompt (the reconstruction target). */
  preview: string;
}

export interface LedgerModelParams {
  /** Requested model id (custom_model_id | env chat model | resolved vision model). */
  requested: string | null;
  /** Model OpenAI actually served (completion.model). */
  served: string | null;
  custom_model_used: boolean;
  /** The DYNAMIC per-reply temperature actually sent (not the AI_REPLY_TEMPERATURE constant). */
  temperature: number | null;
  max_tokens: number | null;
  /** Never sent today (recorded null) — adding a seed is an RC-03 change, out of P1-5 scope. */
  seed: number | null;
  finish_reason: string | null;
  /** finish_reason === 'length' — the reply was silently truncated at max_tokens (C-97). */
  truncated: boolean;
  system_fingerprint: string | null;
}

export interface LedgerUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  usd_cost: number | null;
}

export interface LedgerRetrievalTop {
  id: string;
  similarity: number;
}

export interface LedgerRetrieval {
  semantic_skipped: boolean;
  skip_reason: string | null;
  threshold: number | null;
  core_count: number | null;
  band_count: number | null;
  sources: Array<{ name: string; count: number }>;
  /** Top candidates with their similarity scores (the §15.2 "retrieval scores" gap). */
  top: LedgerRetrievalTop[];
  product_ids: string[];
}

export interface LedgerDecisionEvent {
  classifier: string;
  raw_score: number | null;
  threshold: number | null;
  /** RC-07: the missing-confidence boost fired for this decision. */
  boost_applied: boolean;
  passed: boolean;
  branch: string;
}

export interface LedgerRecord {
  tenant_id: string;
  conversation_id: string | null;
  message_id: string | null;
  correlation_id: string;
  trace_id: string | null;
  idempotency_key: string;
  reply_slot: string;
  decision_kind: string;
  prompt: LedgerPromptProvenance | null;
  model: LedgerModelParams | null;
  usage: LedgerUsage | null;
  retrieval: LedgerRetrieval | null;
  decision_events: LedgerDecisionEvent[];
  guard_verdicts: Record<string, unknown>;
  facts_used: unknown | null;
}

/** The transactional_outbox `dedupe_key` for a reply's ledger row (exactly-once per reply slot). */
export function ledgerDedupeKey(idempotencyKey: string): string {
  return `ledger.write:${idempotencyKey}`;
}

/**
 * The MANDATORY P1-6 pass. Masks customer PII in every field that can carry it before the record
 * becomes durable telemetry (in the outbox payload AND the ledger row). Idempotent, so re-running
 * on the relay side is safe. A no-op when REDACT_PII is off (a deliberate, compliance-gated
 * action — matches `redactAlertDetails`). The prompt preview is masked with `redactPII` (keeping
 * the system-prompt structure visible for reconstruction while masking phones/emails/addresses).
 */
export function redactLedgerRecord(record: LedgerRecord): LedgerRecord {
  if (!REDACT_PII) return record;
  return {
    ...record,
    prompt: record.prompt
      ? { ...record.prompt, preview: redactPII(record.prompt.preview) }
      : null,
    retrieval: record.retrieval
      ? (redactValue(record.retrieval) as LedgerRetrieval)
      : null,
    decision_events: redactValue(record.decision_events) as LedgerDecisionEvent[],
    guard_verdicts: redactValue(record.guard_verdicts) as Record<string, unknown>,
    facts_used: record.facts_used == null ? null : redactValue(record.facts_used),
  };
}

/** Build the enqueue-ready (already-redacted) outbox payload for a `ledger.write` row. */
export function buildLedgerOutboxPayload(record: LedgerRecord): Record<string, unknown> {
  return redactLedgerRecord(record) as unknown as Record<string, unknown>;
}

const INSERT_SQL = `INSERT INTO ai_decision_ledger
    (tenant_id, conversation_id, message_id, correlation_id, trace_id, idempotency_key,
     reply_slot, decision_kind, prompt, model, usage, retrieval, decision_events,
     guard_verdicts, facts_used)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
          $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb)
  ON CONFLICT (idempotency_key) DO NOTHING`;

function insertParams(r: LedgerRecord): unknown[] {
  const j = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));
  return [
    r.tenant_id,
    r.conversation_id ?? null,
    r.message_id ?? null,
    r.correlation_id,
    r.trace_id ?? null,
    r.idempotency_key,
    r.reply_slot,
    r.decision_kind,
    j(r.prompt),
    j(r.model),
    j(r.usage),
    j(r.retrieval),
    JSON.stringify(r.decision_events ?? []),
    JSON.stringify(r.guard_verdicts ?? {}),
    j(r.facts_used),
  ];
}

/**
 * Insert a ledger row inside a caller-supplied transaction (the relay path). Re-runs the
 * mandatory redaction pass idempotently, then `ON CONFLICT (idempotency_key) DO NOTHING`.
 */
export async function insertLedgerTx(client: Db, record: LedgerRecord): Promise<void> {
  await client.query(INSERT_SQL, insertParams(redactLedgerRecord(record)));
}

/**
 * Best-effort direct insert for paths with no reply-persist transaction ([NO_REPLY], sensitive
 * acks, holding messages, legacy send). Redacts, inserts, and swallows every error — a ledger
 * write must NEVER fail the reply. Callers `void insertLedgerBestEffort(...)` (fire-and-forget).
 */
export async function insertLedgerBestEffort(record: LedgerRecord): Promise<void> {
  try {
    await pool.query(INSERT_SQL, insertParams(redactLedgerRecord(record)));
  } catch (err) {
    console.warn('[ai_decision_ledger] best-effort insert failed (ignored)', {
      conversationId: record.conversation_id,
      correlationId: record.correlation_id,
      reply_slot: record.reply_slot,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
