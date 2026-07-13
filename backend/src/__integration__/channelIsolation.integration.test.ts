/**
 * P1-7 (RC-09 / SEC-2): integration coverage for multi-tenant channel isolation. Run with
 * `npm run test:integration` against a real Postgres (DATABASE_URL, default the dev DB) that has
 * migration 075 applied.
 *
 * Exercises the real DB seams: the global UNIQUE (type, external_id) constraint refuses a
 * cross-tenant dual-connect, a same-tenant disconnect→reconnect still works (channels are
 * hard-deleted), `findConflictingChannelBinding` sees only cross-tenant owners, and the resolver
 * picks the earliest binding deterministically when a collision exists. Two throwaway tenants are
 * created and dropped (ON DELETE CASCADE cleans up the seeded channels), leaving dev data untouched.
 *
 * NOTE: the determinism case temporarily DROPs the global unique index (the only way to hold two
 * colliding rows at once) and recreates it in a `finally`, so a crash cannot leave the DB unguarded.
 */
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../db/pool';
import {
  findConflictingChannelBinding,
  findChannelByTypeAndExternalId,
  resolveChannelByTypeAndExternalId,
} from '../db/models/channel';

const GLOBAL_UNIQUE_INDEX = 'idx_channels_type_external_id_global';

let tenantA: string;
let tenantB: string;

async function insertChannel(opts: {
  tenantId: string;
  externalId: string;
  createdAt?: string;
}): Promise<string> {
  const cols = ['tenant_id', 'type', 'name', 'external_id', 'access_token_encrypted'];
  const vals: unknown[] = [opts.tenantId, 'facebook', 'p1-7-itest', opts.externalId, 'enc'];
  if (opts.createdAt) {
    cols.push('created_at');
    vals.push(opts.createdAt);
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO channels (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    vals,
  );
  return rows[0].id;
}

before(async () => {
  const a = await pool.query(`INSERT INTO tenants (name, niche) VALUES ('p1-7-itest-a', 'test') RETURNING id`);
  tenantA = a.rows[0].id;
  const b = await pool.query(`INSERT INTO tenants (name, niche) VALUES ('p1-7-itest-b', 'test') RETURNING id`);
  tenantB = b.rows[0].id;
});

after(async () => {
  if (tenantA) await pool.query('DELETE FROM tenants WHERE id = $1', [tenantA]).catch(() => undefined);
  if (tenantB) await pool.query('DELETE FROM tenants WHERE id = $1', [tenantB]).catch(() => undefined);
  await pool.end().catch(() => undefined);
});

describe('findConflictingChannelBinding — onboarding guard probe', () => {
  it('returns the other tenant’s binding, and null for the same tenant', async () => {
    const ext = 'p1-7-itest-conflict';
    await insertChannel({ tenantId: tenantA, externalId: ext });

    const conflict = await findConflictingChannelBinding(tenantB, 'facebook', ext);
    assert.ok(conflict, 'tenantB should see tenantA’s binding as a conflict');
    assert.equal(conflict!.tenant_id, tenantA);

    const sameTenant = await findConflictingChannelBinding(tenantA, 'facebook', ext);
    assert.equal(sameTenant, null, 'a same-tenant reconnect must not be flagged as a conflict');
  });
});

describe('global UNIQUE (type, external_id) — migration 075 constraint', () => {
  it('rejects a second tenant binding the same (type, external_id)', async () => {
    const ext = 'p1-7-itest-dup';
    await insertChannel({ tenantId: tenantA, externalId: ext });
    await assert.rejects(
      () => insertChannel({ tenantId: tenantB, externalId: ext }),
      /duplicate key value|unique/i,
      'the DB must refuse a cross-tenant dual-connect',
    );
  });

  it('allows a same-tenant disconnect→reconnect (hard delete then re-insert)', async () => {
    const ext = 'p1-7-itest-reconnect';
    const id = await insertChannel({ tenantId: tenantA, externalId: ext });
    await pool.query('DELETE FROM channels WHERE id = $1', [id]);
    // Re-insert the same account for the same tenant — the old row is gone, so no collision.
    await assert.doesNotReject(() => insertChannel({ tenantId: tenantA, externalId: ext }));
  });
});

describe('resolveChannelByTypeAndExternalId — deterministic under collision', () => {
  it('returns the earliest binding and reports the match count', async () => {
    const ext = 'p1-7-itest-determinism';
    try {
      // Drop the global unique so two colliding rows can coexist for the duration of the assertion.
      await pool.query(`DROP INDEX IF EXISTS ${GLOBAL_UNIQUE_INDEX}`);
      await insertChannel({ tenantId: tenantA, externalId: ext, createdAt: '2020-01-01T00:00:00Z' });
      await insertChannel({ tenantId: tenantB, externalId: ext, createdAt: '2020-06-01T00:00:00Z' });

      const res = await resolveChannelByTypeAndExternalId('facebook', ext);
      assert.equal(res.matchCount, 2, 'both bindings should be seen');
      assert.equal(res.channel?.tenant_id, tenantA, 'earliest created_at (tenantA) must win');
      assert.equal(new Set(res.tenantIds).size, 2, 'both tenants should be reported for the alert');

      // The thin wrapper delegates to the same deterministic resolution.
      const single = await findChannelByTypeAndExternalId('facebook', ext);
      assert.equal(single?.tenant_id, tenantA);
    } finally {
      // Remove the seeded collision rows, THEN recreate the constraint (recreating with dup rows
      // present would fail), leaving the DB guarded again regardless of assertion outcome.
      await pool.query('DELETE FROM channels WHERE external_id = $1', [ext]).catch(() => undefined);
      await pool
        .query(`CREATE UNIQUE INDEX IF NOT EXISTS ${GLOBAL_UNIQUE_INDEX} ON channels (type, external_id)`)
        .catch(() => undefined);
    }
  });
});
