/**
 * P3-2 — the read-replica seam.
 *
 * The load-bearing property is the DEFAULT: with `DATABASE_REPLICA_URL` unset, `db/readPool`'s
 * default export must be the primary pool OBJECT ITSELF (not a second pool over the same URL —
 * that would double the connection count on the deployment that never asked for a replica).
 * Plus source invariants pinning WHO routes through the seam: the three lag-tolerant analytics
 * modules and nobody read-after-write-sensitive.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pool from '../../db/pool';
import readPool, { isReplicaConfigured, resolveReplicaSettings } from '../../db/readPool';

describe('resolveReplicaSettings', () => {
  it('unset / blank URL means no replica', () => {
    assert.deepEqual(resolveReplicaSettings({}), { url: null, max: 5 });
    assert.deepEqual(resolveReplicaSettings({ DATABASE_REPLICA_URL: '   ' }), { url: null, max: 5 });
  });

  it('a set URL is passed through trimmed, with the default max', () => {
    const s = resolveReplicaSettings({ DATABASE_REPLICA_URL: ' postgresql://ro:x@replica:5432/db ' });
    assert.equal(s.url, 'postgresql://ro:x@replica:5432/db');
    assert.equal(s.max, 5);
  });

  it('PG_POOL_MAX_REPLICA overrides the max; garbage falls back', () => {
    assert.equal(resolveReplicaSettings({ PG_POOL_MAX_REPLICA: '12' }).max, 12);
    assert.equal(resolveReplicaSettings({ PG_POOL_MAX_REPLICA: '0' }).max, 5);
    assert.equal(resolveReplicaSettings({ PG_POOL_MAX_REPLICA: 'lots' }).max, 5);
  });
});

describe('readPool default (no replica configured in the test environment)', () => {
  it('is the primary pool object itself — same reference, zero extra connections', () => {
    // The offline suite never sets DATABASE_REPLICA_URL; if this ever fails, something started
    // exporting a second pool on the default path.
    assert.equal(isReplicaConfigured, false);
    assert.equal(readPool, pool);
  });
});

describe('replica routing (source invariants)', () => {
  function readSource(...rel: string[]): string {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'src', ...rel);
      if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`could not locate src/${rel.join('/')}`);
  }

  it('the three lag-tolerant analytics modules route through db/readPool', () => {
    for (const rel of [
      ['services', 'statisticsService.ts'],
      ['controllers', 'dashboardController.ts'],
      ['services', 'platformCostService.ts'],
    ]) {
      const source = readSource(...rel);
      assert.ok(
        /from '\.\.\/db\/readPool'/.test(source),
        `${rel.join('/')} must import from db/readPool`,
      );
      assert.ok(
        !/from '\.\.\/db\/pool'/.test(source),
        `${rel.join('/')} must not also import the primary pool directly`,
      );
    }
  });

  it('read-after-write-sensitive paths never import the replica seam', () => {
    // A replica is entitled to be seconds behind. A merchant who sends a reply and refreshes must
    // see it — these modules must stay on the primary.
    for (const rel of [
      ['jobs', 'processAIReply.ts'],
      ['controllers', 'conversationController.ts'],
      ['controllers', 'orderController.ts'],
    ]) {
      const source = readSource(...rel);
      assert.ok(
        !/db\/readPool/.test(source),
        `${rel.join('/')} tolerates no replication lag and must not use readPool`,
      );
    }
  });
});
