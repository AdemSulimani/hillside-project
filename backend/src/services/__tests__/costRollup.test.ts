/**
 * P3-6 audit fix — the sweep's scan window must start at UTC midnight.
 *
 * `replaceCostDay` rewrites a whole (tenant, day, source) partition, so the sweep may only rewrite
 * days it scanned in full. A raw `now − windowDays·24h` cutoff scans the window's oldest day from
 * mid-day onward while still replacing the whole partition — each sweep truncates that day further,
 * and the seal at `AI_COST_ROLLUP_SEAL_DAYS` freezes the shrunken figure permanently, understating
 * COGS in the direction that reads as a cost improvement.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sweepWindowStart, utcDayKey } from '../costRollup';

describe('sweepWindowStart', () => {
  it('floors the window start to UTC midnight of the oldest windowed day', () => {
    const now = new Date('2026-07-19T13:47:23.456Z');
    const since = sweepWindowStart(now, 3);
    assert.equal(since.toISOString(), '2026-07-16T00:00:00.000Z');
  });

  it('never lands after the raw cutoff, and stays within its UTC day', () => {
    const cases = [
      { now: '2026-07-19T00:00:00.000Z', windowDays: 3 },
      { now: '2026-07-19T23:59:59.999Z', windowDays: 3 },
      { now: '2026-02-28T12:00:00.000Z', windowDays: 1 },
      { now: '2026-01-01T00:30:00.000Z', windowDays: 7 },
    ];
    for (const c of cases) {
      const now = new Date(c.now);
      const raw = new Date(now.getTime() - c.windowDays * 24 * 60 * 60 * 1000);
      const since = sweepWindowStart(now, c.windowDays);
      assert.ok(since.getTime() <= raw.getTime(), `${c.now}: floor must not move the cutoff later`);
      assert.equal(utcDayKey(since), utcDayKey(raw), `${c.now}: floor must stay within the raw cutoff's UTC day`);
      assert.equal(since.toISOString().slice(11), '00:00:00.000Z', `${c.now}: must be UTC midnight`);
    }
  });

  it('an exact-midnight now keeps the full oldest day in the window', () => {
    const since = sweepWindowStart(new Date('2026-07-19T00:00:00.000Z'), 3);
    assert.equal(since.toISOString(), '2026-07-16T00:00:00.000Z');
  });
});

/**
 * Source invariant, following the house convention in `costAnomaly.test.ts`: the sweep itself is
 * not unit-runnable offline (its graph reaches db/pool and a live scan), so pin that it derives
 * `since` through the tested helper rather than an inline raw cutoff.
 */
describe('runCostRollupSweep window derivation (source invariant)', () => {
  const rollupSource = (() => {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'src', 'services', 'costRollup.ts');
      if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error('could not locate costRollup.ts');
  })();

  it('computes `since` via sweepWindowStart (count guard)', () => {
    const uses = rollupSource.split('sweepWindowStart').length - 1;
    // export + doc mention + call site at minimum. If the call site is inlined back to a raw
    // timestamp subtraction, the pure tests above stop describing production.
    assert.ok(uses >= 2, `expected sweepWindowStart to be defined and called, saw ${uses} occurrence(s)`);
    assert.ok(
      /const since = sweepWindowStart\(now, windowDays\)/.test(rollupSource),
      'the sweep must derive its scan window through sweepWindowStart',
    );
  });
});
