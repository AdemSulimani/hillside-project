/**
 * P1-1 (RC-20, RC-21): integration coverage for the DB-level exactly-once guarantees that the
 * idempotent post-send pipeline is built on. Run with `npm run test:integration` against a real
 * Postgres (DATABASE_URL, default the dev DB) that has migrations 070/071 applied.
 *
 * These exercise the actual correctness seams — the ON CONFLICT dedupe on messages / outbox /
 * staging, the atomic persist+enqueue-intent, the single-live-ai.reply debounce upsert, the
 * `FOR UPDATE SKIP LOCKED` relay claim, and the crash-after-flip resume — directly against the
 * models, without standing up BullMQ/OpenAI. A throwaway tenant is created and dropped
 * (ON DELETE CASCADE cleans up every dependent row), so the dev data is left untouched.
 */
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import pool from '../db/pool';
import { createMessageTx, findMessageIdByTenantAndExternalMessageId } from '../db/models/message';
import {
  aiReplyDedupeKey,
  insertOutboxTx,
  upsertLiveAiReplyTx,
  hasLiveAiReply,
  claimOutboxBatch,
  markOutboxDone,
} from '../db/models/outbox';
import { upsertStagingTx, flipStagingTx, getStagingByKey } from '../db/models/replyStaging';
import { deriveReplyIdempotencyKey } from '../services/replyIdempotency';

let tenantId: string;
let contactId: string;
let conversationId: string;
let dbAvailable = false;

async function withTxn<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

before(async () => {
  // Fail fast with a clear message when the DB is unreachable (matches the suite's philosophy).
  const t = await pool.query(
    `INSERT INTO tenants (name, niche) VALUES ('p1-1-itest', 'test') RETURNING id`,
  );
  tenantId = t.rows[0].id;
  const c = await pool.query(
    `INSERT INTO contacts (tenant_id, external_id, name) VALUES ($1, 'p1-1-itest-contact', 'Test') RETURNING id`,
    [tenantId],
  );
  contactId = c.rows[0].id;
  const conv = await pool.query(
    `INSERT INTO conversations (tenant_id, contact_id, status) VALUES ($1, $2, 'open') RETURNING id`,
    [tenantId, contactId],
  );
  conversationId = conv.rows[0].id;
  dbAvailable = true;
});

after(async () => {
  if (tenantId) {
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => undefined);
  }
  await pool.end().catch(() => undefined);
});

describe('createMessageTx — idempotent outbound persist (RC-20 no dead-letter / no dup row)', () => {
  it('a second insert with the same (tenant, external_message_id) no-ops to one row', async () => {
    assert.ok(dbAvailable);
    const ext = 'p1-1-msg-dupe';
    const first = await withTxn((c) =>
      createMessageTx(c, {
        tenant_id: tenantId,
        conversation_id: conversationId,
        external_message_id: ext,
        direction: 'outbound',
        type: 'text',
        content: 'first delivered text',
        sent_by: 'ai',
      }),
    );
    // Simulate a retry re-persisting the SAME external id (the FB/IG collision that used to
    // dead-letter, or the WhatsApp deterministic-placeholder re-insert).
    const second = await withTxn((c) =>
      createMessageTx(c, {
        tenant_id: tenantId,
        conversation_id: conversationId,
        external_message_id: ext,
        direction: 'outbound',
        type: 'text',
        content: 'RETRY regenerated text (must be ignored)',
        sent_by: 'ai',
      }),
    );
    assert.equal(second.id, first.id, 'retry returns the same row, not a new one');
    assert.equal(second.content, 'first delivered text', 'delivered text is authoritative');
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND external_message_id = $2',
      [tenantId, ext],
    );
    assert.equal(rows[0].n, 1, 'exactly one row for the external id');
  });
});

describe('reply staging — stage → flip → resume (RC-20 authoritative text, once-only flip)', () => {
  it('upsert is idempotent and the flip records the delivered id exactly once', async () => {
    const key = deriveReplyIdempotencyKey({
      conversationId,
      logicalInboundExternalId: 'p1-1-inb-1',
      replySlot: 'main',
    });
    const staged = await withTxn((c) =>
      upsertStagingTx(c, {
        tenant_id: tenantId,
        conversation_id: conversationId,
        idempotency_key: key,
        reply_slot: 'main',
        logical_inbound_external_id: 'p1-1-inb-1',
        reply_text: 'attempt-1 text',
      }),
    );
    assert.equal(staged.status, 'staged');

    // A retry stages again with DIFFERENT (regenerated) text → ON CONFLICT no-ops, returns the
    // original attempt-1 text.
    const restaged = await withTxn((c) =>
      upsertStagingTx(c, {
        tenant_id: tenantId,
        conversation_id: conversationId,
        idempotency_key: key,
        reply_slot: 'main',
        logical_inbound_external_id: 'p1-1-inb-1',
        reply_text: 'attempt-2 regenerated text',
      }),
    );
    assert.equal(restaged.reply_text, 'attempt-1 text', 'staged text is authoritative across retries');

    await withTxn((c) =>
      flipStagingTx(c, {
        idempotency_key: key,
        status: 'sent',
        external_message_id: 'graph-abc',
        message_id: null,
      }),
    );
    const afterFlip = await getStagingByKey(key);
    assert.equal(afterFlip?.status, 'sent');
    assert.equal(afterFlip?.external_message_id, 'graph-abc');
    assert.equal(afterFlip?.send_attempts, 1);

    // Re-driving the flip (resume) is idempotent.
    await withTxn((c) =>
      flipStagingTx(c, {
        idempotency_key: key,
        status: 'sent',
        external_message_id: 'graph-abc',
        message_id: null,
      }),
    );
    const afterResume = await getStagingByKey(key);
    assert.equal(afterResume?.status, 'sent');
    assert.equal(afterResume?.send_attempts, 2, 'attempts bumped but state stable');
  });
});

describe('outbox dedupe (each side-effect exactly-once)', () => {
  it('a second insert with the same dedupe_key no-ops', async () => {
    const dedupe = `analytics.ai_reply_sent:p1-1-${conversationId}`;
    await withTxn((c) =>
      insertOutboxTx(c, {
        tenant_id: tenantId,
        conversation_id: conversationId,
        topic: 'analytics.ai_reply_sent',
        dedupe_key: dedupe,
        payload: { a: 1 },
      }),
    );
    await withTxn((c) =>
      insertOutboxTx(c, {
        tenant_id: tenantId,
        conversation_id: conversationId,
        topic: 'analytics.ai_reply_sent',
        dedupe_key: dedupe,
        payload: { a: 2 },
      }),
    );
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM transactional_outbox WHERE dedupe_key = $1',
      [dedupe],
    );
    assert.equal(rows[0].n, 1);
  });
});

describe('atomic persist + ai.reply intent + burst debounce (RC-21)', () => {
  it('persists the message and a single live ai.reply intent in one txn; a burst collapses it', async () => {
    const ext1 = 'p1-1-inb-burst-1';
    await withTxn(async (c) => {
      await createMessageTx(c, {
        tenant_id: tenantId,
        conversation_id: conversationId,
        external_message_id: ext1,
        direction: 'inbound',
        type: 'text',
        content: 'first',
        sent_by: 'customer',
      });
      await upsertLiveAiReplyTx(c, {
        tenant_id: tenantId,
        conversation_id: conversationId,
        dedupe_key: aiReplyDedupeKey(conversationId, ext1),
        payload: { messageExternalId: ext1 },
        available_at: new Date(Date.now() + 8000),
      });
    });
    assert.equal(await hasLiveAiReply(conversationId), true, 'a live intent exists after persist');

    // A second inbound in the debounce window upserts the SAME live row (collapse to latest).
    const ext2 = 'p1-1-inb-burst-2';
    await withTxn((c) =>
      upsertLiveAiReplyTx(c, {
        tenant_id: tenantId,
        conversation_id: conversationId,
        dedupe_key: aiReplyDedupeKey(conversationId, ext2),
        payload: { messageExternalId: ext2 },
        available_at: new Date(Date.now() + 8000),
      }),
    );
    const live = await pool.query(
      `SELECT count(*)::int AS n, max(payload->>'messageExternalId') AS latest
         FROM transactional_outbox
        WHERE conversation_id = $1 AND topic = 'ai.reply' AND status = 'pending'`,
      [conversationId],
    );
    assert.equal(live.rows[0].n, 1, 'burst collapses to exactly one live intent');
    assert.equal(live.rows[0].latest, ext2, 'the live intent points at the latest inbound');
  });
});

describe('relay claim — FOR UPDATE SKIP LOCKED (no double-dispatch)', () => {
  it('a row claimed (and locked) by one worker is not claimed by a concurrent worker', async () => {
    // Insert a due pending row on a distinct topic so other tests do not interfere.
    const dedupe = `usecase.eval:p1-1-skiplocked-${conversationId}`;
    await withTxn((c) =>
      insertOutboxTx(c, {
        tenant_id: tenantId,
        conversation_id: conversationId,
        topic: 'usecase.eval',
        dedupe_key: dedupe,
        payload: { conversationId, tenantId },
        available_at: new Date(Date.now() - 1000),
      }),
    );

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('BEGIN');
      const claimedA = await claimOutboxBatch(clientA, 'workerA', 10, 120);
      const idsA = claimedA.map((r) => r.dedupe_key);
      assert.ok(idsA.includes(dedupe), 'worker A claims the due row');

      // While A holds the row lock (uncommitted), B must not claim the same row.
      await clientB.query('BEGIN');
      const claimedB = await claimOutboxBatch(clientB, 'workerB', 10, 120);
      await clientB.query('COMMIT');
      assert.ok(
        !claimedB.some((r) => r.dedupe_key === dedupe),
        'worker B skips the row locked by A (SKIP LOCKED)',
      );

      await clientA.query('COMMIT');

      // Mark it done so it is terminal.
      const row = claimedA.find((r) => r.dedupe_key === dedupe)!;
      await withTxn((c) => markOutboxDone(c, row.id));
      const done = await pool.query(
        'SELECT status FROM transactional_outbox WHERE dedupe_key = $1',
        [dedupe],
      );
      assert.equal(done.rows[0].status, 'done');
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});

describe('inbound scoped dedupe lookup', () => {
  it('finds a persisted inbound by (tenant, external id)', async () => {
    const ext = 'p1-1-scoped-lookup';
    await withTxn((c) =>
      createMessageTx(c, {
        tenant_id: tenantId,
        conversation_id: conversationId,
        external_message_id: ext,
        direction: 'inbound',
        type: 'text',
        content: 'hi',
        sent_by: 'customer',
      }),
    );
    const found = await findMessageIdByTenantAndExternalMessageId(tenantId, ext);
    assert.ok(found, 'row found for the owning tenant');
    const otherTenant = await findMessageIdByTenantAndExternalMessageId(
      '00000000-0000-0000-0000-000000000000',
      ext,
    );
    assert.equal(otherTenant, null, 'not visible to a different tenant (scoped)');
  });
});
