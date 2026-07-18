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
  /**
   * P3-5 (RC-26): the exact prompt-block versions that produced this reply, by content hash —
   * each resolvable through `prompt_block_versions` (migration 084). Non-rendered blocks are
   * retained with `rendered: false` so a REJECTED orphan is distinguishable from an ABSENT one.
   *
   * Nested in this JSONB column rather than given a top-level column of its own: block versions
   * are a per-PROMPT fact whose only query is "what produced this reply" — already a `prompt`
   * read — unlike `config_fingerprint`, which is a per-PROCESS fact needing a fleet-wide indexed
   * slice. A column would also be NULL on most rows, since the gate-drop / ack / [NO_REPLY]
   * ledger paths carry no prompt at all. Same shape as `usage.calls` above.
   */
  blocks?: LedgerBlockVersion[] | null;
  /** P3-5: the structural assembly outcome (what rendered, what was violated, what was cut). */
  assembly?: LedgerAssemblyProvenance | null;
}

/** P3-5: one guideline block considered by prompt assembly. */
export interface LedgerBlockVersion {
  key: string;
  /** sha256 of the block content AS STORED — never the placeholder-expanded text. */
  hash: string;
  rendered: boolean;
  drop_reason?: 'allowlist' | 'budget' | 'disabled' | 'vision_absent' | 'empty';
}

/** P3-5: structural assembly facts. Booleans and enums only — see the redaction note below. */
export interface LedgerAssemblyProvenance {
  footer_present: boolean;
  platform_policy_present: boolean;
  platform_policy_source: 'tenant_override' | 'code_rulebook' | 'none';
  grounding_directive_present: boolean;
  violations: Array<{ kind: string; detail: string }>;
  unknown_tokens: string[];
  sections?: Array<{ id: string; chars: number; dropped: boolean }>;
  over_budget: boolean;
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
    // P3-5: the spread carries `blocks` and `assembly` through UNREDACTED, and that is the
    // decision, not an omission. Both are block keys, sha256 hashes, booleans and enums. The only
    // free text is `assembly.unknown_tokens` — regex-constrained to [A-Z0-9_]+ by
    // `expandPromptPlaceholders`, so it cannot carry a phone number or an address — and
    // `violations[].detail`, which is a section name or an "N > M" size pair. Stated explicitly in
    // the style of the receipt_snapshot / config_fingerprint notes below, so a reviewer sees a
    // judgement rather than an accident. Anything added here that CAN carry customer text must be
    // routed through `redactValue` instead.
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

// ---------------------------------------------------------------------------
// READ side (P3-4)
//
// Until P3-4 this model was WRITE-ONLY: `grep "FROM ai_decision_ledger"` returned nothing but the
// retention DELETE. Every field above was captured and none was ever read back, which meant the
// §15.2 promise — "reconstruct an incident from the ledger alone" — was a claim about the schema
// rather than about anything the code could do. These functions are what make the ledger an
// instrument: the shadow-diff report and the quality-eval parity report are both built on them,
// and P3-1's per-classifier cutovers are gated on the first of those.
//
// Deliberately NO new migration and NO GIN index. Filtering by `decision_events[].classifier`
// would want `decision_events @> '[{"classifier":"..."}]'` and an index to go with it; for the
// volumes P3-4 reports over, a tenant+time-bounded scan filtered application-side is enough, and
// it keeps this item purely additive. Add the index when volume demands it, not before.
// ---------------------------------------------------------------------------

/** A ledger row as read back, i.e. the written record plus its server-assigned identity. */
export interface LedgerRow extends LedgerRecord {
  id: string;
  created_at: Date;
}

export interface LedgerQuery {
  tenantId?: string;
  conversationId?: string;
  decisionKind?: string;
  since?: Date;
  until?: Date;
  /** Hard-capped at 10_000: a report must not be able to pull a month of rows into memory. */
  limit?: number;
  /** Keyset pagination — pass the last row's `id` to continue. */
  afterId?: string;
}

/**
 * The read column list, as an ARRAY rather than a formatted string.
 *
 * `reconstructReply` needs the same columns table-qualified for its join, and deriving that by
 * splitting a multi-line template on ', ' silently misses the columns whose separator is ',\n  ' —
 * they come out unqualified. Postgres resolves them today only because `ai_prompt_blobs` happens
 * to share no column name; the day it gains one, the §15.2 reconstruction query starts failing
 * with "column reference is ambiguous", i.e. exactly while someone is investigating an incident.
 * An array cannot drift with formatting.
 */
const LEDGER_COLUMNS = [
  'id', 'tenant_id', 'conversation_id', 'message_id', 'correlation_id', 'trace_id',
  'idempotency_key', 'reply_slot', 'decision_kind', 'prompt', 'model', 'usage', 'retrieval',
  'decision_events', 'guard_verdicts', 'facts_used', 'receipt_snapshot', 'config_fingerprint',
  'created_at',
] as const;

const SELECT_COLUMNS = LEDGER_COLUMNS.join(', ');
/** The same columns, qualified for a join. Exported for the test that pins the qualification. */
export const ledgerSelectList = (alias?: string): string =>
  LEDGER_COLUMNS.map((c) => (alias ? `${alias}.${c}` : c)).join(', ');

const MAX_LIMIT = 10_000;

function buildQuery(q: LedgerQuery): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('$?', `$${params.length}`));
  };

  if (q.tenantId) add('tenant_id = $?', q.tenantId);
  if (q.conversationId) add('conversation_id = $?', q.conversationId);
  if (q.decisionKind) add('decision_kind = $?', q.decisionKind);
  if (q.since) add('created_at >= $?', q.since);
  if (q.until) add('created_at < $?', q.until);
  if (q.afterId) add('id > $?', q.afterId);

  params.push(Math.min(Math.max(1, q.limit ?? 1_000), MAX_LIMIT));
  return {
    // ORDER BY id — monotonic and unique, so keyset pagination cannot skip or repeat a row the way
    // ordering by created_at would when two rows share a timestamp.
    sql: `SELECT ${SELECT_COLUMNS} FROM ai_decision_ledger
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY id ASC
          LIMIT $${params.length}`,
    params,
  };
}

/** One page of ledger rows. Ordered by `id` so `afterId` paginates deterministically. */
export async function queryLedger(q: LedgerQuery, client: Db = pool): Promise<LedgerRow[]> {
  const { sql, params } = buildQuery(q);
  const { rows } = await client.query(sql, params);
  return rows as LedgerRow[];
}

/**
 * Stream every matching row, one page at a time.
 *
 * A shadow-diff report over a bake-in window can cover hundreds of thousands of replies; buffering
 * that would defeat the purpose of having a bounded `limit` at all.
 */
export async function* scanLedger(
  q: LedgerQuery,
  batchSize = 1_000,
  client: Db = pool,
): AsyncGenerator<LedgerRow> {
  // Clamp to the SAME bound `queryLedger` applies. Without this, `scanLedger(q, 20_000)` asks for
  // 20k, silently receives the 10k cap, sees `page.length < batchSize` and returns as if the scan
  // were complete — a report over a truncated window, with no error and no warning, in the
  // safe-looking direction (fewer observations). Comparing against the EFFECTIVE page size is what
  // makes the termination condition mean "the server ran out of rows".
  const effectiveBatch = Math.min(Math.max(1, batchSize), MAX_LIMIT);
  let afterId = q.afterId;
  for (;;) {
    const page = await queryLedger({ ...q, afterId, limit: effectiveBatch }, client);
    if (page.length === 0) return;
    for (const row of page) yield row;
    if (page.length < effectiveBatch) return;
    afterId = page[page.length - 1].id;
  }
}

/** The reply this idempotency key produced, if any. */
export async function getLedgerByIdempotencyKey(
  key: string,
  client: Db = pool,
): Promise<LedgerRow | null> {
  const { rows } = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM ai_decision_ledger WHERE idempotency_key = $1`,
    [key],
  );
  return (rows[0] as LedgerRow) ?? null;
}

/** Every ledger row written for one message (a turn can produce several — gate drops, acks, sends). */
export async function getLedgerForMessage(
  messageId: string,
  client: Db = pool,
): Promise<LedgerRow[]> {
  const { rows } = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM ai_decision_ledger WHERE message_id = $1 ORDER BY id ASC`,
    [messageId],
  );
  return rows as LedgerRow[];
}

/**
 * The §15.2 reconstruction: a ledger row plus the full system prompt that produced it.
 *
 * The prompt is content-addressed in `ai_prompt_blobs` (migration 082) and joined on
 * `prompt->>'system_hash'`, so the 26–33K-char prompt is stored once per distinct prompt rather
 * than once per reply. `systemPrompt` is null when `LEDGER_PROMPT_BLOBS` was off for the reply or
 * the blob has since aged out of the retention window — a null here means "not recoverable", which
 * is itself the answer to the reconstructability question and must not be mistaken for an error.
 */
export async function reconstructReply(
  idempotencyKey: string,
  client: Db = pool,
): Promise<{ ledger: LedgerRow; systemPrompt: string | null } | null> {
  const { rows } = await client.query(
    `SELECT ${ledgerSelectList('l')}, b.content AS system_prompt
       FROM ai_decision_ledger l
       LEFT JOIN ai_prompt_blobs b ON b.hash = l.prompt->>'system_hash'
      WHERE l.idempotency_key = $1`,
    [idempotencyKey],
  );
  if (rows.length === 0) return null;
  const { system_prompt: systemPrompt, ...ledger } = rows[0] as LedgerRow & {
    system_prompt: string | null;
  };
  return { ledger: ledger as LedgerRow, systemPrompt: systemPrompt ?? null };
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
