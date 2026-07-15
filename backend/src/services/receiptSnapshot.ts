/**
 * P2-4 Part 2 (RC-06 + RC-17) — the receipt-time snapshot.
 *
 * RC-06: all three enablement gates (`ai_configs.is_active`, `channels.ai_enabled`,
 * `conversations.ai_paused`/`human_override_until`) are evaluated at JOB-RUN time — ≥8s after
 * receipt, because `processInboundMessage` deliberately enqueues `ai.reply` with
 * `AI_REPLY_DELAY_MS` (default 8000), and the fairness/lock/hold reschedules can stretch that to
 * minutes. A toggle flip inside that window "changes an already-received message's outcome class
 * with no artifact that a received message was discarded" (11-root-causes.md:110).
 *
 * ── Why this module RECORDS and does not GOVERN ──────────────────────────────────────────────
 * The obvious fix — evaluate the gates against the snapshot — is unsafe, on four counts:
 *
 *   1. `toggleAiPaused` (db/models/conversation.ts) is a bare UPDATE that writes NO message row,
 *      so the pre-send `human_outbound_after_inbound` check CANNOT backstop a merchant's pause.
 *      Snapshot-governance blinds every gate at once.
 *   2. The P0-5/RC-14 rate-limit auto-resume is nested INSIDE the live `if (conversation.ai_paused)`
 *      branch, and that branch holds the job's only pause-clearing write. Governing `ai_paused`
 *      from a snapshot dead-codes it → permanent silence, the exact dead-end P0-5 closed.
 *   3. Governing `is_active` makes a tenant-wide kill switch fail to stop in-flight work, and
 *      re-introduces precisely the ai_config staleness P2-3 removed (C-55).
 *   4. `ai_paused` is written by the pipeline's OWN guards mid-flight (escalations), and the
 *      per-conversation lock backoff re-enqueues `data` verbatim — so a stale snapshot riding a
 *      lock backoff is the COMMON burst case, not a rare race.
 *
 * RC-06's own regression-prevention line offers the weaker remedy — "evaluate against the snapshot
 * **(or record it)**" (:117) — and its stated defect is the MISSING ARTIFACT, not the late read.
 * So: capture at receipt, compare against live at evaluation, write both plus the divergence to
 * the decision ledger, and let the live reads keep governing. Every drop becomes queryable; no
 * control loses its authority.
 *
 * The one thing the snapshot legitimately governs is `aiConfigVersion` — a STALENESS FLOOR on the
 * P2-3 versioned cache (see aiConfigCache.ts). That is safe by construction: the version is
 * monotonic epoch-micros off a single DB clock, so the floor can only make config FRESHER.
 *
 * Pure by design (no DB/Redis imports) — the impure loader lives in `processInboundMessage`, this
 * module is the testable decision surface. Mirrors the `aiResumePolicy.ts` precedent, which takes
 * injected probe results for exactly this reason.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Captured at receipt, carried in the `ai.reply` job payload. Scalars only — never PII. */
export interface ReceiptSnapshot {
  /** Epoch ms when the snapshot was taken (immediately before the deliberate delay is applied). */
  capturedAtMs: number;
  /**
   * Epoch ms the webhook was received, threaded from the controller. Distinct from `capturedAtMs`:
   * the difference is the NON-deliberate part of the window (webhookQueue hop, attachment work),
   * which RC-06 does not blame but which should be visible rather than assumed small.
   */
  receivedAtMs: number | null;
  /** `ai_configs.is_active` at receipt. */
  aiActive: boolean;
  /** `aiConfigVersion(ai_configs.updated_at)` — epoch micros; 0 when unknown. */
  aiConfigVersion: number;
  /** `channels.ai_enabled` at receipt. */
  channelAiEnabled: boolean;
  /** `conversations.ai_paused` at receipt. */
  conversationAiPaused: boolean;
  /** `conversations.human_override_until` at receipt, ISO string or null. */
  humanOverrideUntil: string | null;
  /**
   * P1-7/RC-09: how many channel rows matched this (type, external_id) at receipt. >1 means the
   * turn ran under a live dual-tenant binding — free to capture here, archaeology otherwise.
   *
   * `null` where the path genuinely cannot observe it (the edit path resolves its channel through
   * `findChannelByTypeAndExternalId`, which collapses the count). Recording a confident `1` there
   * would be fabrication in the one field whose entire job is detecting that the count is NOT 1.
   */
  matchCount: number | null;
}

/** The live gate values the worker actually evaluated, ≥8s later. */
export interface LiveGateState {
  aiActive: boolean;
  aiConfigVersion: number;
  channelAiEnabled: boolean;
  conversationAiPaused: boolean;
  humanOverrideUntil: string | null;
}

export interface SnapshotComparison {
  captured: Record<string, unknown>;
  live: Record<string, unknown>;
  diverged: string[];
  receipt_to_capture_ms: number | null;
  capture_to_eval_ms: number | null;
}

/**
 * Structural validity guard. MUST be called before any arithmetic on the snapshot.
 *
 * The hazard is concrete: `outboxRelay` re-hydrates `transactional_outbox.payload` (jsonb) into an
 * `ai.reply` job, so rows pending at deploy time carry no snapshot at all. `Date.now() - undefined`
 * is `NaN` and `NaN > MAX` is `false`, so an age check written arithmetic-first fails OPEN into
 * reading `undefined` fields — which are falsy — i.e. it would silently look like "AI disabled".
 * Absence is a first-class case: no snapshot → fall back to live, record nothing.
 */
export function snapshotUsable(s: unknown): s is ReceiptSnapshot {
  if (!s || typeof s !== 'object') return false;
  const c = (s as ReceiptSnapshot).capturedAtMs;
  return typeof c === 'number' && Number.isFinite(c);
}

/**
 * Build the snapshot from already-loaded rows. Pure: the caller does the I/O.
 *
 * `reply_locale` is deliberately NOT captured. It is job-OUTPUT state written by the previous
 * turn's reply (P2-2's sticky-locale slot, which carries its own `reply_locale_updated_at`
 * hysteresis anchor). Freezing it at receipt would let a burst read a locale from before the prior
 * turn resolved one — re-introducing exactly the oscillation STICKY_LOCALE_SLOT exists to stop.
 */
export function buildReceiptSnapshot(input: {
  nowMs: number;
  receivedAtMs: number | null;
  aiActive: boolean;
  aiConfigVersion: number;
  channelAiEnabled: boolean;
  conversationAiPaused: boolean;
  humanOverrideUntil: Date | string | null;
  matchCount: number | null;
}): ReceiptSnapshot {
  return {
    capturedAtMs: input.nowMs,
    receivedAtMs: input.receivedAtMs ?? null,
    aiActive: input.aiActive,
    aiConfigVersion: input.aiConfigVersion,
    channelAiEnabled: input.channelAiEnabled,
    conversationAiPaused: input.conversationAiPaused,
    humanOverrideUntil: toIso(input.humanOverrideUntil),
    matchCount: input.matchCount,
  };
}

function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Compare the receipt snapshot against the live gate state the worker read.
 *
 * The `diverged` list IS the RC-06 measurement: a non-empty list means this turn's outcome was
 * decided by state that changed after the message was already accepted. Returns null when the
 * snapshot is absent/malformed (nothing to compare — the job simply ran on live reads, as always).
 *
 * `live` is PARTIAL by necessity, not by laziness: the gate ladder drops out early, so a job that
 * returns at the `is_active` gate never reads the channel or conversation rows at all. Only keys
 * actually present are diffed — reporting an unread field as "diverged" would be fabrication.
 */
export function compareSnapshotToLive(
  snapshot: unknown,
  live: Partial<LiveGateState>,
  nowMs: number,
): SnapshotComparison | null {
  if (!snapshotUsable(snapshot)) return null;

  const captured: Record<string, unknown> = {
    aiActive: snapshot.aiActive,
    aiConfigVersion: snapshot.aiConfigVersion,
    channelAiEnabled: snapshot.channelAiEnabled,
    conversationAiPaused: snapshot.conversationAiPaused,
    humanOverrideUntil: snapshot.humanOverrideUntil,
    matchCount: snapshot.matchCount,
  };

  const liveShape: Record<string, unknown> = {};
  const diverged: string[] = [];
  for (const key of Object.keys(live) as Array<keyof LiveGateState>) {
    const value = live[key];
    if (value === undefined) continue;
    liveShape[key] = value;
    if (captured[key] !== value) diverged.push(key);
  }

  return {
    captured,
    live: liveShape,
    diverged,
    receipt_to_capture_ms:
      typeof snapshot.receivedAtMs === 'number' && Number.isFinite(snapshot.receivedAtMs)
        ? snapshot.capturedAtMs - snapshot.receivedAtMs
        : null,
    capture_to_eval_ms: nowMs - snapshot.capturedAtMs,
  };
}

/**
 * The snapshot's ONLY governing use (RC-17): a floor on the P2-3 versioned ai_config cache.
 *
 * Without a consumer the captured version is ledger decoration and the plan's RC-17 billing is
 * unearned. With it, no worker can serve a config older than the one in force when the message was
 * accepted — turning RC-17's unbounded 900s per-worker drift into a bounded guarantee.
 *
 * Safe in one direction only, by construction: `aiConfigVersion` is `updated_at` as epoch micros
 * off ONE DB clock (no worker NTP skew), and monotonic — so `cachedVersion < floor` can only ever
 * force a re-read of FRESHER config, never pin staler config. A cached version at-or-above the
 * floor is always acceptable: config edited after receipt is fine to answer WITH (the gate decision
 * is what must not move; the wording may improve).
 */
export function isCachedConfigStale(cachedVersion: number, snapshotVersion: number): boolean {
  if (!Number.isFinite(cachedVersion) || !Number.isFinite(snapshotVersion)) return false;
  if (snapshotVersion <= 0) return false;
  return cachedVersion < snapshotVersion;
}

/**
 * Ambient access to the current job's snapshot, so the RC-17 staleness floor reaches `loadAIConfig`
 * — six frames below `processAIReply` — without adding a parameter to `generateReply` and its
 * callers. This mirrors `openaiCallTracker.ts`, which exists for exactly this reason and by whose
 * precedent P2-4 Part 1 already threads log correlation. `processAIReply` enters the scope once at
 * job entry, alongside the two scopes already there.
 *
 * Outside a scope (product imports, admin edits, the embeddings cron) `getReceiptSnapshot()` is
 * undefined and every consumer behaves exactly as before.
 */
const snapshotStorage = new AsyncLocalStorage<{ snapshot: ReceiptSnapshot | undefined }>();

export async function runWithReceiptSnapshot<T>(
  snapshot: ReceiptSnapshot | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return snapshotStorage.run({ snapshot }, fn);
}

export function getReceiptSnapshot(): ReceiptSnapshot | undefined {
  return snapshotStorage.getStore()?.snapshot;
}
