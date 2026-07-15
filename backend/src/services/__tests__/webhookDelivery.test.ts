/**
 * Tests for P2-4 Part 2 webhook delivery acceptance + dedupe-key derivation (RC-11).
 *
 * These are the repo's first tests over webhook ingestion logic — it previously lived inline in an
 * Express handler between a `redisConnection.set` and a `res.status(403)`, i.e. untestable without
 * a DB/Redis harness the suite does not have. Extracting the decisions is what makes the two RC-11
 * validation cases ("a 6-min-late valid delivery", "a timestamp-less replay") assertable at all.
 *
 * HONEST LIMIT, stated rather than papered over: "enqueued exactly ONCE" is a property of the Redis
 * SET NX claim plus the durable DB dedupe, and is integration-only. What is unit-testable — and what
 * these tests assert — is the KEY: that identical replays derive the same claim key, that a
 * timestamp-less payload derives a content-derived key rather than a Date.now()-tainted one, and
 * that the key matches the unit the normalizer actually consumes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveDedupeKey,
  deriveViberDedupeKey,
  isStaleMessageEdit,
  shouldAcceptWebhookDelivery,
} from '../webhookDelivery';

const NOW = 1_700_000_000_000;
const SIX_MIN_MS = 6 * 60_000;

const raw = (payload: unknown): Buffer => Buffer.from(JSON.stringify(payload), 'utf8');

describe('P2-4 Part 2 — shouldAcceptWebhookDelivery (RC-11)', () => {
  describe('flag OFF — the legacy skew gate, byte-for-byte', () => {
    it('accepts a fresh delivery', () => {
      const d = shouldAcceptWebhookDelivery({
        payloadTsMs: NOW - 1_000,
        nowMs: NOW,
        dedupeReplayEnabled: false,
      });
      assert.equal(d.accept, true);
    });

    it('403s a 6-minute-late VALID delivery — the RC-11 silent drop', () => {
      // Meta redelivers the same stale timestamp forever, so this message is lost permanently:
      // no traceId, no job, no DB row. A promptly-delivered identical message is answered.
      const d = shouldAcceptWebhookDelivery({
        payloadTsMs: NOW - SIX_MIN_MS,
        nowMs: NOW,
        dedupeReplayEnabled: false,
      });
      assert.equal(d.accept, false);
      assert.equal(d.accept === false && d.reason, 'timestamp_out_of_range');
    });

    it('auto-passes a timestamp-less payload however old — the gate cannot see age', () => {
      // `payloadTsMs ?? Date.now()` scores |now - now| = 0. The gate meant to stop replays waves
      // through precisely the payload whose age it cannot verify.
      const d = shouldAcceptWebhookDelivery({
        payloadTsMs: null,
        nowMs: NOW,
        dedupeReplayEnabled: false,
      });
      assert.equal(d.accept, true);
      assert.equal(d.accept === true && d.reason, 'within_skew');
    });

    it('403s a far-future timestamp (the gate is two-sided)', () => {
      const d = shouldAcceptWebhookDelivery({
        payloadTsMs: NOW + SIX_MIN_MS,
        nowMs: NOW,
        dedupeReplayEnabled: false,
      });
      assert.equal(d.accept, false);
    });
  });

  describe('flag ON — accept, and let dedupe do the work it alone can do', () => {
    it('accepts the 6-minute-late valid delivery', () => {
      const d = shouldAcceptWebhookDelivery({
        payloadTsMs: NOW - SIX_MIN_MS,
        nowMs: NOW,
        dedupeReplayEnabled: true,
      });
      assert.equal(d.accept, true);
      assert.equal(d.accept === true && d.reason, 'dedupe_replay_mode');
    });

    it('accepts a timestamp-less payload — now deduped by key, not waved through by luck', () => {
      const d = shouldAcceptWebhookDelivery({
        payloadTsMs: null,
        nowMs: NOW,
        dedupeReplayEnabled: true,
      });
      assert.equal(d.accept, true);
    });

    it('never 403s on wall-clock, at any age', () => {
      for (const ageMs of [0, SIX_MIN_MS, 86_400_000, 365 * 86_400_000]) {
        const d = shouldAcceptWebhookDelivery({
          payloadTsMs: NOW - ageMs,
          nowMs: NOW,
          dedupeReplayEnabled: true,
        });
        assert.equal(d.accept, true, `age ${ageMs}ms`);
      }
    });
  });
});

describe('P2-4 Part 2 — deriveDedupeKey (RC-11 prerequisite)', () => {
  const messengerBody = (mid: string) => ({
    entry: [{ id: 'page1', messaging: [{ sender: { id: 'u1' }, message: { mid } }] }],
  });

  it('derives a stable key: two byte-identical replays claim the same key', () => {
    const p = messengerBody('m_abc');
    assert.equal(deriveDedupeKey(p, raw(p)), deriveDedupeKey(p, raw(p)));
    assert.equal(deriveDedupeKey(p, raw(p)), 'm_abc');
  });

  it('derives a CONTENT key for a timestamp-less payload, not a Date.now()-tainted one', () => {
    // The key must be a function of the message, never of arrival time — otherwise a replay
    // computes a fresh key and is not deduped at all.
    const p = messengerBody('m_no_ts');
    assert.equal(deriveDedupeKey(p, raw(p)), 'm_no_ts');
  });

  it('keys on entry[0]/messaging[0] — the same unit the normalizer consumes', () => {
    // The legacy key joined ALL mids across ALL entries with '|', while every normalizer branch
    // reads only entry[0] and messaging[0]/messages[0]. That mismatch meant a batch [m1,m2] claimed
    // "m1|m2", processed only m1, and dropped m2 — and a later delivery carrying m2 computed a
    // DIFFERENT key, so it deduped against nothing.
    const batch = {
      entry: [{ id: 'page1', messaging: [{ message: { mid: 'm1' } }, { message: { mid: 'm2' } }] }],
    };
    assert.equal(deriveDedupeKey(batch, raw(batch)), 'm1');

    // The m2-alone redelivery therefore gets its own key and is processed rather than swallowed.
    const m2Alone = messengerBody('m2');
    assert.equal(deriveDedupeKey(m2Alone, raw(m2Alone)), 'm2');
    assert.notEqual(deriveDedupeKey(batch, raw(batch)), deriveDedupeKey(m2Alone, raw(m2Alone)));
  });

  it('keys an FB/IG edit on mid+num_edit instead of degrading to a body hash', () => {
    // The legacy walker read `item.message`, but an edit carries `message_edit` — so `parts` came
    // out EMPTY and the key silently fell back to sha256(rawBody), which changes on any byte-level
    // re-serialization. And the edit path is exactly the one with no durable DB backstop.
    const p = {
      entry: [{ id: 'page1', messaging: [{ message_edit: { mid: 'm_edit', num_edit: 2 } }] }],
    };
    assert.equal(deriveDedupeKey(p, raw(p)), 'edit:m_edit:2');
  });

  it('treats successive revisions of one message as distinct claims', () => {
    const rev1 = { entry: [{ messaging: [{ message_edit: { mid: 'm1', num_edit: 1 } }] }] };
    const rev2 = { entry: [{ messaging: [{ message_edit: { mid: 'm1', num_edit: 2 } }] }] };
    // An edit is a legitimately repeatable event on a stable mid — revision 2 must not be deduped
    // away as "already seen" just because revision 1 was.
    assert.notEqual(deriveDedupeKey(rev1, raw(rev1)), deriveDedupeKey(rev2, raw(rev2)));
    // But a replay of the SAME revision collides and is dropped.
    assert.equal(deriveDedupeKey(rev1, raw(rev1)), deriveDedupeKey(rev1, raw(rev1)));
  });

  it('keys a WhatsApp message on its wamid', () => {
    const p = {
      entry: [{ changes: [{ value: { messages: [{ id: 'wamid.ABC' }] } }] }],
    };
    assert.equal(deriveDedupeKey(p, raw(p)), 'wamid.ABC');
  });

  it('distinguishes a WhatsApp edit from the original message on the same wamid', () => {
    // WhatsApp edits reuse the original wamid, so without the revision the edit would collide with
    // the original's claim and never be processed.
    const original = { entry: [{ changes: [{ value: { messages: [{ id: 'wamid.ABC' }] } }] }] };
    const edited = {
      entry: [{ changes: [{ value: { messages: [{ id: 'wamid.ABC', edit: { num_edit: 1 } }] } }] }],
    };
    assert.equal(deriveDedupeKey(original, raw(original)), 'wamid.ABC');
    assert.equal(deriveDedupeKey(edited, raw(edited)), 'edit:wamid.ABC:1');
  });

  it('keys a reaction on mid+timestamp (reactions legitimately repeat on one mid)', () => {
    const p = { entry: [{ messaging: [{ reaction: { mid: 'm1' }, timestamp: 123 }] }] };
    assert.equal(deriveDedupeKey(p, raw(p)), 'reaction:m1:123');
  });

  it('falls back to a body hash only when no message is identifiable', () => {
    const p = { entry: [{ id: 'page1', standby: [{}] }] };
    const key = deriveDedupeKey(p, raw(p));
    assert.equal(key.length, 64, 'sha256 hex');
    // Still stable for an identical body.
    assert.equal(key, deriveDedupeKey(p, raw(p)));
  });

  it('is not confused by a null/empty entry list', () => {
    assert.equal(deriveDedupeKey({}, raw({})).length, 64);
    assert.equal(deriveDedupeKey({ entry: [] }, raw({ entry: [] })).length, 64);
  });
});

describe('P2-4 Part 2 — isStaleMessageEdit (RC-11 prerequisite)', () => {
  it('rejects a replay of a revision already applied — the content-rewind primitive', () => {
    // Revision 1 has been applied (edit_count 1). Replaying that same signed body must not rewind
    // content to the pre-edit text, bump edit_count, or emit a message_edited socket.
    assert.equal(isStaleMessageEdit({ numEdit: 1 }, { editCount: 1 }), true);
  });

  it('rejects an OLDER revision arriving after a newer one', () => {
    assert.equal(isStaleMessageEdit({ numEdit: 1 }, { editCount: 3 }), true);
    assert.equal(isStaleMessageEdit({ numEdit: 2 }, { editCount: 3 }), true);
  });

  it('applies the next genuine revision', () => {
    assert.equal(isStaleMessageEdit({ numEdit: 2 }, { editCount: 1 }), false);
    assert.equal(isStaleMessageEdit({ numEdit: 1 }, { editCount: 0 }), false);
  });

  it('applies a first edit on a never-edited message', () => {
    assert.equal(isStaleMessageEdit({ numEdit: 1 }, { editCount: 0, editedAt: null }), false);
  });

  it('does not block edits from platforms that send no revision counter', () => {
    // WhatsApp shape B carries no num_edit. Absent a counter and a real platform timestamp there is
    // nothing to compare — falling back to same-content idempotency, as before.
    assert.equal(isStaleMessageEdit({ numEdit: null }, { editCount: 5 }), false);
    assert.equal(isStaleMessageEdit({}, { editCount: 5 }), false);
  });

  it('falls back to the platform timestamp when no counter is present', () => {
    const stored = new Date('2026-07-15T10:00:00Z');
    assert.equal(
      isStaleMessageEdit({ editedAt: new Date('2026-07-15T09:00:00Z') }, { editCount: 1, editedAt: stored }),
      true,
      'older timestamp is stale',
    );
    assert.equal(
      isStaleMessageEdit({ editedAt: stored }, { editCount: 1, editedAt: stored }),
      true,
      'identical timestamp is a replay',
    );
    assert.equal(
      isStaleMessageEdit({ editedAt: new Date('2026-07-15T11:00:00Z') }, { editCount: 1, editedAt: stored }),
      false,
      'newer timestamp applies',
    );
  });

  it('does not treat a never-edited message as newer-than-everything', () => {
    assert.equal(
      isStaleMessageEdit({ editedAt: new Date('2026-07-15T09:00:00Z') }, { editCount: 0, editedAt: null }),
      false,
    );
  });

  it('ignores a NaN counter rather than silently rejecting the edit', () => {
    assert.equal(isStaleMessageEdit({ numEdit: NaN }, { editCount: 1 }), false);
  });

  it('prefers the counter over the timestamp when both are present', () => {
    // A genuine revision 2 must apply even if the platform's edited_at is skewed backwards.
    const stored = new Date('2026-07-15T10:00:00Z');
    assert.equal(
      isStaleMessageEdit(
        { numEdit: 2, editedAt: new Date('2026-07-15T11:00:00Z') },
        { editCount: 1, editedAt: stored },
      ),
      false,
    );
  });
});

describe('P2-4 Part 2 — deriveViberDedupeKey', () => {
  it('keys on message_token', () => {
    const p = { message_token: 'tok123' };
    assert.equal(deriveViberDedupeKey(p, raw(p)), 'viber:tok123');
  });

  it('handles a numeric message_token (Viber sends these as numbers)', () => {
    const p = { message_token: 5098034272017990000 };
    assert.equal(deriveViberDedupeKey(p, raw(p)), 'viber:5098034272017990000');
  });

  it('falls back to a body hash when the token is absent', () => {
    const p = { event: 'message' };
    assert.match(deriveViberDedupeKey(p, raw(p)), /^viber:[0-9a-f]{64}$/);
  });
});
