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
  /** P2-4 (F2): sha256 of the SYSTEM prompt alone — joins to ai_prompt_blobs.hash (migration 082). */
  system_hash: string;
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
  /**
   * The seed actually sent. P2-1 pins AI_REPLY_SEED on the facts_used contract path (RC-03), so
   * this is populated when FACTS_USED_CONTRACT is on and null otherwise (legacy free-prose path).
   */
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
  /** P1-5 (C-108): EVERY OpenAI call this reply made (classifiers + embeddings + the main
   * completion) — model ids and token counts only, no text. `usd_cost` above remains the
   * main completion's cost; `calls_usd_cost` aggregates the priced calls below. */
  calls?: Array<{
    kind: string;
    requested: string | null;
    served: string | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    usd_cost: number | null;
  }> | null;
  call_count?: number | null;
  calls_usd_cost?: number | null;
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

/**
 * P2-4 Part 2 (RC-06): the ledger's view of the receipt-time snapshot. Deliberately its own shape
 * rather than the raw job payload: the payload only carries what was captured, while the ledger
 * additionally records what the LIVE gates read and whether the two diverged — which is the whole
 * measurement. Scalars only (booleans, epoch micros/ms, a timestamp) — carries no customer PII.
 */
export interface LedgerReceiptSnapshot {
  /** The snapshot as captured at receipt (before the deliberate AI_REPLY_DELAY_MS deferral). */
  captured: Record<string, unknown>;
  /** The live values the gates actually evaluated, read ≥8s later. */
  live: Record<string, unknown>;
  /** Field names whose captured value differs from live — empty when the window was quiet. */
  diverged: string[];
  /** ms between webhook receipt and snapshot capture (the non-deliberate part of the window). */
  receipt_to_capture_ms: number | null;
  /** ms between snapshot capture and gate evaluation (the deliberate deferral + backoffs). */
  capture_to_eval_ms: number | null;
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
  /**
   * P2-4 Part 2 (RC-06): the enablement/config state captured at RECEIPT, plus how it compared to
   * the live state the gates actually read ≥8s later. Record-only — the live reads always govern;
   * this exists so a message discarded (or answered) on a mid-window toggle leaves an artifact,
   * which is RC-06's stated defect. NULL when RECEIPT_TIME_SNAPSHOT is off or the job predates it.
   */
  receipt_snapshot: LedgerReceiptSnapshot | null;
  /**
   * P2-7 (RC-06): which config produced this reply — `{ hash, instance }`, a pointer into the
   * `config_fingerprints` table (migration 081) that holds the actual knob values.
   *
   * Short form on purpose: the fingerprint is a per-PROCESS fact, so carrying the full knob set on
   * every per-REPLY row would duplicate it thousands of times. Once `config_fingerprints` shows the
   * fleet disagrees with itself, this column answers the follow-up — "which replies ran on the bad
   * config" — from the ledger alone. NULL on rows written before P2-7.
   */
  config_fingerprint: LedgerConfigFingerprint | null;
}

/** P2-7: the per-reply pointer into `config_fingerprints`. Scalars only — no PII. */
export interface LedgerConfigFingerprint {
  hash: string;
  instance: string;
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
    // P2-4 Part 2: passed through UNREDACTED, deliberately. The snapshot is booleans + epoch
    // numbers + a hold timestamp — no field can carry customer PII, and redactValue would only
    // risk mangling the epoch-micros config version. Stated explicitly rather than relying on the
    // spread above, so this stays a decision a reviewer can see instead of an invisible omission.
    receipt_snapshot: record.receipt_snapshot ?? null,
    // P2-7: passed through UNREDACTED for the same reason as receipt_snapshot above — it is a
    // 16-char hash and a host:pid string, neither of which can carry customer PII, and any
    // secret-valued knob is already hashed by `config/knobs.fingerprint` before it gets here.
    config_fingerprint: record.config_fingerprint ?? null,
  };
}

/** Build the enqueue-ready (already-redacted) outbox payload for a `ledger.write` row. */
export function buildLedgerOutboxPayload(record: LedgerRecord): Record<string, unknown> {
  return redactLedgerRecord(record) as unknown as Record<string, unknown>;
}

const INSERT_SQL = `INSERT INTO ai_decision_ledger
    (tenant_id, conversation_id, message_id, correlation_id, trace_id, idempotency_key,
     reply_slot, decision_kind, prompt, model, usage, retrieval, decision_events,
     guard_verdicts, facts_used, receipt_snapshot, config_fingerprint)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
          $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
          $16::jsonb, $17::jsonb)
  ON CONFLICT (idempotency_key) DO NOTHING`;

/**
 * Exported for tests only: the suite has no DB, so asserting a field actually reaches its bind
 * parameter (rather than being silently dropped by the mapper) is only possible on these params.
 */
export function insertParams(r: LedgerRecord): unknown[] {
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
    j(r.receipt_snapshot),
    j(r.config_fingerprint),
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

/**
 * P2-4 Part 2: retention prune — delete ledger rows older than `retentionDays`.
 *
 * Mirrors `pruneReplayedDeadLetter`. Unlike the DLQ there is no status to spare: a ledger row is
 * pure telemetry that no operator actions, so age is the only axis. Every row carries a prompt
 * preview derived from customer conversation text, so unbounded retention is a GDPR exposure
 * (P2-4's own listed edge case) as well as unbounded growth.
 *
 * Deletes in bounded batches so a first run over a large backlog cannot hold a long transaction or
 * bloat WAL; the caller ticks repeatedly. Returns rows deleted this call.
 */
export async function pruneLedger(
  retentionDays: number,
  batchSize = 5_000,
  client: Db = pool,
): Promise<number> {
  const { rowCount } = await client.query(
    `DELETE FROM ai_decision_ledger
      WHERE id IN (
        SELECT id FROM ai_decision_ledger
         WHERE created_at < now() - make_interval(days => $1)
         LIMIT $2
      )`,
    [retentionDays, batchSize],
  );
  return rowCount ?? 0;
}
