/**
 * P2-4 Part 2 (RC-11) — webhook delivery acceptance + replay-dedupe key derivation.
 *
 * Extracted from the two webhook controllers so their logic cannot drift (the skew constant was
 * already duplicated verbatim in both) and so it is testable at all: the repo's suite has no
 * DB/Redis mocks, and both gates previously lived inline in an Express handler between a
 * `redisConnection.set` and a `res.status(403)`. Pure — the caller does the I/O.
 *
 * ── RC-11, restated honestly ────────────────────────────────────────────────────────────────
 * `const eventEpochMs = payloadTsMs ?? Date.now()` is unfalsifiable in BOTH directions:
 *   • No timestamp in the payload  → |now − now| = 0 → ALWAYS passes, however old. A replay of a
 *     timestamp-less body sails through the very gate meant to stop it.
 *   • Timestamp older than 300s    → 403, forever. Meta redelivers the SAME stale timestamp, so a
 *     late-but-valid customer message is dropped permanently, with no traceId, no job, no DB row.
 * Outcome depends on timestamp presence and delivery latency — not on content.
 *
 * It is also a live CORRECTNESS bug, not just a weak control: `WEBHOOK_ACK_AFTER_ENQUEUE` (P1-1,
 * RC-21) deliberately returns 500 on enqueue failure so Meta retries — and the skew gate then 403s
 * that very retry, defeating the recovery the flag exists to provide.
 *
 * ── Why removing it is safe (and what had to be fixed first) ────────────────────────────────
 * The gate does no authentication work: HMAC over the raw body is verified BEFORE it in both
 * controllers, and the signature carries no timestamp — so the gate never bounded replay of a
 * *validly signed* body by anything except wall-clock luck. What remains after removal:
 *   1. HMAC (unchanged, still first),
 *   2. the Redis `webhook_seen` claim — SET NX EX 86400 on a persistent Redis
 *      (`--appendonly yes --save 60 1 --maxmemory-policy noeviction`), so it cannot be
 *      LRU-evicted and an OOM fails the SET loudly rather than silently,
 *   3. the durable DB dedupe in processInboundMessage (tenant-scoped under P1-1).
 *
 * Leg 2 could not carry that load as written — `deriveDedupeKey` below is the fix. See its docs.
 * Leg 3 did not exist for edits, and `applyMessageEdit` had no monotonicity guard; both are fixed
 * alongside this module. Without those three prerequisites, removing the 403 would have opened a
 * durable content-rewrite + AI-turn-cancellation primitive from one replayed body.
 */
import crypto from 'crypto';

/** The legacy skew window. Retained ONLY for the flag-off path, so removal is a clean revert. */
export const WEBHOOK_TS_MAX_SKEW_MS = 300_000;

export type WebhookDeliveryDecision =
  | { accept: true; reason: 'dedupe_replay_mode' | 'within_skew' }
  | { accept: false; reason: 'timestamp_out_of_range' };

/**
 * Decide whether to accept a signature-verified delivery.
 *
 * Flag ON  → always accept; replay protection is the dedupe key + the durable DB dedupe, which is
 *            what actually distinguishes a replay from a late delivery. A 6-minute-late valid
 *            message is processed exactly once instead of being dropped forever.
 * Flag OFF → byte-for-byte the legacy skew gate, including its `?? Date.now()` auto-pass, so the
 *            rollback is exact.
 */
export function shouldAcceptWebhookDelivery(args: {
  payloadTsMs: number | null;
  nowMs: number;
  dedupeReplayEnabled: boolean;
  maxSkewMs?: number;
}): WebhookDeliveryDecision {
  if (args.dedupeReplayEnabled) {
    return { accept: true, reason: 'dedupe_replay_mode' };
  }
  const maxSkewMs = args.maxSkewMs ?? WEBHOOK_TS_MAX_SKEW_MS;
  const eventEpochMs = args.payloadTsMs ?? args.nowMs;
  if (Math.abs(args.nowMs - eventEpochMs) > maxSkewMs) {
    return { accept: false, reason: 'timestamp_out_of_range' };
  }
  return { accept: true, reason: 'within_skew' };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pickMessageMidOrId(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  if (typeof message.mid === 'string' && message.mid.trim()) return message.mid.trim();
  if (typeof message.id === 'string' && message.id.trim()) return message.id.trim();
  if (typeof message.id === 'number' && Number.isFinite(message.id) && message.id > 0) {
    return String(Math.trunc(message.id));
  }
  return null;
}

/**
 * Derive the `webhook_seen` claim key from the SAME unit the normalizer actually consumes.
 *
 * The legacy key walked EVERY entry and EVERY message and joined all mids with '|'. Every
 * normalizer branch, by contrast, reads only `entry[0]` and `messaging[0]`/`messages[0]`. Three
 * consequences, all fixed here:
 *
 *   1. A batch [m1, m2] claimed "m1|m2" but processed only m1 — and a later delivery carrying m2
 *      computed a DIFFERENT key, so it was not deduped against the first at all. The claim gave no
 *      cross-delivery idempotency whenever batch composition varied.
 *   2. FB/IG EDIT payloads produced an EMPTY parts list — the walker reads `item.message`, while an
 *      edit carries `messaging[0].message_edit` — so the key silently degraded to
 *      `sha256(rawBody)`, which changes on any byte-level re-serialization. That was the one path
 *      with no durable DB backstop.
 *   3. Reactions were keyed on mid+timestamp, which is fine, and is preserved.
 *
 * Edits are keyed on `mid:num_edit` so revision N and revision N+1 of one message are distinct
 * claims (an edit is a legitimately repeatable event on a stable mid), while a replay of the SAME
 * revision collides and is dropped.
 *
 * The rawBody hash remains the last-resort fallback for bodies with no identifiable message.
 */
export function deriveDedupeKey(payload: Record<string, unknown>, rawBody: Buffer): string {
  const entry = Array.isArray(payload.entry) ? asRecord(payload.entry[0]) : null;

  if (entry) {
    const messagingItem = Array.isArray(entry.messaging) ? asRecord(entry.messaging[0]) : null;
    if (messagingItem) {
      // Edit before message: an edit payload carries `message_edit`, never `message`.
      const messageEdit = asRecord(messagingItem.message_edit);
      if (messageEdit) {
        const mid = pickMessageMidOrId(messageEdit);
        if (mid) {
          const numEdit =
            messageEdit.num_edit != null && messageEdit.num_edit !== ''
              ? String(messageEdit.num_edit)
              : '';
          return `edit:${mid}:${numEdit}`;
        }
      }

      const fromMessage = pickMessageMidOrId(asRecord(messagingItem.message));
      if (fromMessage) return fromMessage;

      const reaction = asRecord(messagingItem.reaction);
      if (reaction) {
        const rmid =
          typeof reaction.mid === 'string' && reaction.mid.trim() ? reaction.mid.trim() : '';
        const ts =
          messagingItem.timestamp != null && messagingItem.timestamp !== ''
            ? String(messagingItem.timestamp)
            : '';
        return rmid ? `reaction:${rmid}:${ts}` : `reaction:${ts}`;
      }
    }

    const change = Array.isArray(entry.changes) ? asRecord(entry.changes[0]) : null;
    const value = change ? asRecord(change.value) : null;
    const message = value && Array.isArray(value.messages) ? asRecord(value.messages[0]) : null;
    if (message) {
      const id = pickMessageMidOrId(message);
      if (id) {
        // WhatsApp edits reuse the original wamid, so key on the edit revision when present
        // (shape A: `messages[0].edit`; shape B: top-level `edited` + context.message_id).
        const editObj = asRecord(message.edit);
        if (editObj) {
          const numEdit =
            editObj.num_edit != null && editObj.num_edit !== '' ? String(editObj.num_edit) : '';
          return `edit:${id}:${numEdit}`;
        }
        return id;
      }
    }
  }

  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

/**
 * P2-4 Part 2 (RC-11 prerequisite): is this edit delivery a STALE revision?
 *
 * Pure, so the decision is testable — `applyMessageEdit` itself runs inside a `FOR UPDATE`
 * transaction that the suite (which has no DB) cannot reach. Same split as `aiResumePolicy`.
 *
 * Same-content was previously the ONLY idempotency on the edit path: the UPDATE compared neither
 * `num_edit` nor `edited_at` against the stored row, so replaying an OLDER edit body rewound the
 * message content, incremented edit_count, appended a bogus history entry, and emitted a
 * message_edited socket. Reachable from one captured signed body, because the HMAC embeds no
 * timestamp — and the edit path returns before both inbound dedupe blocks, so it has no other
 * durable backstop.
 *
 * `numEdit` is the platform's 1-based revision counter; `editCount` is how many edits we have
 * applied. Revision N is therefore already reflected once editCount >= N.
 *
 * `editedAt` is only a fallback for platforms that send no counter, and only meaningful when the
 * caller passes a real platform timestamp — `applyMessageEdit` defaults it to `new Date()`, which
 * can never be stale.
 */
export function isStaleMessageEdit(
  incoming: { numEdit?: number | null; editedAt?: Date | null },
  stored: { editCount: number; editedAt?: Date | string | null },
): boolean {
  if (
    typeof incoming.numEdit === 'number' &&
    Number.isFinite(incoming.numEdit) &&
    incoming.numEdit <= stored.editCount
  ) {
    return true;
  }
  if (incoming.editedAt && stored.editedAt) {
    const storedMs = new Date(stored.editedAt).getTime();
    if (Number.isFinite(storedMs) && incoming.editedAt.getTime() <= storedMs) return true;
  }
  return false;
}

/** Viber's own claim key: the platform message_token, else a body hash. Unchanged semantics. */
export function deriveViberDedupeKey(payload: Record<string, unknown>, rawBody: Buffer): string {
  const token = payload.message_token;
  if (typeof token === 'string' && token.trim()) return `viber:${token.trim()}`;
  if (typeof token === 'number' && Number.isFinite(token) && token > 0) {
    return `viber:${Math.trunc(token)}`;
  }
  return `viber:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
}
