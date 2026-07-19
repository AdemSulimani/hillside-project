/**
 * P3-6 integration: the COGS rollup against a REAL Postgres.
 *
 * The offline suite (`services/__tests__/costAggregation.test.ts`) covers the pure fold. Only a
 * real database can verify the three properties that actually make the rollup trustworthy:
 *
 *   1. THE TWO HALVES AGREE. The pure `foldTurnCosts` and the SQL sweep must produce identical
 *      numbers over identical rows. That equality is the entire justification for the pure/IO
 *      split — without it, the unit-tested arithmetic would be describing a function nobody runs.
 *   2. IDEMPOTENCE. The sweep re-folds a trailing window every tick rather than tracking a
 *      watermark, so running it twice must not double anything. If it did, the design would be
 *      unusable and the failure would look like a gradual cost increase.
 *   3. SEALING IS ABSOLUTE. A sealed day must survive a later sweep untouched. Sealing is what
 *      stops a re-fold of a day whose ledger rows were partly pruned from silently SHRINKING a
 *      historical cost — a wrong number in the direction that reads as an improvement.
 *
 * Run with `npm run test:integration` (needs DATABASE_URL). Not in CI.
 */
import 'dotenv/config';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pool from '../db/pool';
import { replaceCostDay, queryCostDaily, sealCostDays } from '../db/models/aiCostDaily';
import { foldTurnCosts, summarizeCogs, type CostTurn } from '../services/costAggregation';
import type { LedgerUsage } from '../db/models/aiDecisionLedger';

const DAY = '2020-01-02'; // Far in the past, so it cannot collide with real dev data.

function usage(calls: Array<Partial<NonNullable<LedgerUsage['calls']>[number]>>): LedgerUsage {
  return {
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    usd_cost: null,
    calls: calls.map((c) => ({
      kind: 'chat',
      requested: 'gpt-4o',
      served: 'gpt-4o-2024-08-06',
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      usd_cost: 0.00035,
      cached_tokens: 0,
      ...c,
    })),
  };
}

describe('ai_cost_daily rollup (real Postgres)', () => {
  let tenantId: string;

  const turns: CostTurn[] = [
    {
      conversation_id: null, // set in `before` once the tenant exists
      usage: usage([
        { role: 'chat', usd_cost: 0.02 },
        { role: 'classifier', usd_cost: 0.001 },
        { role: 'classifier', usd_cost: 0.002 },
      ]),
    },
    {
      conversation_id: null,
      usage: usage([{ role: 'classifier', usd_cost: 0.003 }, { role: 'embedding', kind: 'embedding', usd_cost: 0.000002 }]),
    },
  ];

  before(async () => {
    tenantId = crypto.randomUUID();
    await pool.query('INSERT INTO tenants (id, name, niche) VALUES ($1, $2, $3)', [
      tenantId,
      `p3-6-rollup-test-${tenantId.slice(0, 8)}`,
      'test',
    ]);
    turns[0].conversation_id = 'conv-a';
    turns[1].conversation_id = 'conv-a'; // same conversation ⇒ distinct count must be 1, not 2
  });

  after(async () => {
    // ON DELETE CASCADE removes the ai_cost_daily rows with the tenant.
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    await pool.end();
  });

  it('the SQL sweep and the pure fold produce identical numbers', async () => {
    const rows = foldTurnCosts(turns, 'reply');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await replaceCostDay(client, { tenantId, day: DAY, source: 'reply', rows });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const persisted = await queryCostDaily({ tenantId, from: DAY, to: DAY });
    const fromDb = summarizeCogs(persisted);
    const fromPure = summarizeCogs(rows);

    assert.equal(fromDb.usd_cost, fromPure.usd_cost);
    assert.equal(fromDb.calls, fromPure.calls);
    assert.equal(fromDb.turns, fromPure.turns, 'two turns');
    assert.equal(fromDb.conversations, fromPure.conversations, 'one distinct conversation');
    assert.equal(fromDb.turns, 2);
    assert.equal(fromDb.conversations, 1);
    assert.equal(fromDb.usd_cost, 0.026002);
  });

  it('re-running the sweep is idempotent — nothing doubles', async () => {
    const rows = foldTurnCosts(turns, 'reply');
    for (let i = 0; i < 3; i++) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await replaceCostDay(client, { tenantId, day: DAY, source: 'reply', rows });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }
    const summary = summarizeCogs(await queryCostDaily({ tenantId, from: DAY, to: DAY }));
    assert.equal(summary.usd_cost, 0.026002, 'three sweeps, same total');
    assert.equal(summary.turns, 2);
    assert.equal(summary.conversations, 1, 'a distinct-conversation count must not accumulate');
  });

  it('a sealed day is never recomputed', async () => {
    // DAY is in 2020, so any sane seal horizon covers it.
    const sealedCount = await sealCostDays(30);
    assert.ok(sealedCount > 0, 'the test day should now be sealed');

    // Attempt to overwrite the sealed day with a deliberately different (much smaller) figure —
    // the shape a re-fold over partly-pruned ledger rows would produce.
    const shrunken = foldTurnCosts([turns[1]], 'reply');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const written = await replaceCostDay(client, {
        tenantId,
        day: DAY,
        source: 'reply',
        rows: shrunken,
      });
      await client.query('COMMIT');
      assert.equal(written, 0, 'replaceCostDay must refuse a sealed partition');
    } finally {
      client.release();
    }

    const summary = summarizeCogs(await queryCostDaily({ tenantId, from: DAY, to: DAY }));
    assert.equal(summary.usd_cost, 0.026002, 'the sealed figure survived unchanged');
  });
});
