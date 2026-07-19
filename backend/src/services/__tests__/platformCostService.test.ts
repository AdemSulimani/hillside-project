/**
 * P3-6 audit fix — cost rankings must sort numerically, never lexicographically.
 *
 * The panel/anomaly queries render `usd_cost` as `::text` (numeric-to-JS float precision hygiene),
 * and `ORDER BY <ordinal>` binds to the OUTPUT column — the text cast — so '9.5' ranked above
 * '12.3'. The runaway-conversation anomaly then inspects the wrong conversation and misses a real
 * threshold crossing; the fleet summary (LIMIT 50) can drop the true top spender entirely.
 *
 * Source invariant, following the house convention in `costAnomaly.test.ts`: this module is not
 * unit-importable offline (its graph reaches db/pool), so the SQL shape is pinned over the source.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

describe('platformCostService ranking queries (source invariant)', () => {
  const source = (() => {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'src', 'services', 'platformCostService.ts');
      if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error('could not locate platformCostService.ts');
  })();

  it('never orders by an output-column ordinal (they are ::text casts)', () => {
    assert.ok(
      !/ORDER BY \d+ DESC/.test(source),
      'ORDER BY <ordinal> binds to the ::text output column and sorts lexicographically ' +
        "('9.5' > '12.3') — order by the numeric aggregate expression instead",
    );
  });

  it('ranks cost by the numeric aggregate expression (count guard)', () => {
    const numericOrderings = source.match(/ORDER BY (?:COALESCE\()?SUM\(/g) ?? [];
    // getFleetCostSummary + getCostOutliers' worst-conversation query. If this drops below 2, a
    // ranking query was rewritten away from the numeric expression and the assertion above may
    // have gone vacuous.
    assert.ok(
      numericOrderings.length >= 2,
      `expected >=2 numeric ORDER BY SUM(...) rankings, saw ${numericOrderings.length}`,
    );
  });
});
