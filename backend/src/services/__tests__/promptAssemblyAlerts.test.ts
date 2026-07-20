/**
 * P3-5 (RC-26): turning prompt-assembly governance failures into deduped, durable alerts.
 *
 * The two pure pieces are tested here; the I/O half (`raisePromptAssemblyAlerts`) is a Redis
 * SET NX plus `createAIAlert`, which the suite has no database for — consistent with the house
 * convention of exporting the decision and asserting on it rather than mocking the world.
 *
 * The property that matters most is the DEDUP KEY. Without it the orphan block — a structural
 * condition present on every single reply — produces one alert per reply per tenant, which is
 * indistinguishable from the console.warn this replaces. Keying on the catalog marker rather than
 * a TTL is what makes it exactly one alert per catalog epoch, self-clearing when the block is
 * fixed rather than re-firing forever on a timer.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assemblyAlertDedupeKey,
  collectPromptAssemblyIssues,
  dedupeDetailFor,
  PROMPT_ASSEMBLY_ALERT_REASON,
} from '../promptAssemblyAlerts';

const ORPHAN = 'guidelines.offers_promotions';

describe('collectPromptAssemblyIssues', () => {
  it('reports an allowlist drop as an orphan block key — the RC-26 case', () => {
    const issues = collectPromptAssemblyIssues({
      droppedBlocks: [{ key: ORPHAN, reason: 'allowlist' }],
      violations: [],
      unknownTokens: [],
    });
    assert.deepEqual(issues, [{ kind: 'orphan_block_key', detail: ORPHAN }]);
  });

  it('does NOT report a budget drop', () => {
    // A budget drop is the budget working as configured — already recorded in ledger provenance,
    // and not a governance failure. Alerting on it would train operators to ignore the alert.
    const issues = collectPromptAssemblyIssues({
      droppedBlocks: [{ key: 'custom_promo', reason: 'budget' }],
      violations: [],
      unknownTokens: [],
    });
    assert.deepEqual(issues, []);
  });

  it('does not report disabled or vision-absent blocks', () => {
    const issues = collectPromptAssemblyIssues({
      droppedBlocks: [
        { key: 'guidelines.recommendations', reason: 'disabled' },
        { key: 'guidelines.vision_product_images', reason: 'vision_absent' },
      ],
      violations: [],
      unknownTokens: [],
    });
    assert.deepEqual(issues, []);
  });

  it('carries the three alertable violation kinds through', () => {
    const issues = collectPromptAssemblyIssues({
      droppedBlocks: [],
      violations: [
        { kind: 'missing_required_section', detail: 'PLATFORM POLICY' },
        { kind: 'forbidden_section_reference', detail: 'Active offers' },
        { kind: 'over_budget', detail: '35000 > 34000' },
      ],
      unknownTokens: [],
    });
    assert.deepEqual(issues.map((i) => i.kind), [
      'missing_required_section',
      'forbidden_section_reference',
      'over_budget',
    ]);
    assert.equal(issues[1].detail, 'Active offers');
  });

  it('dedupes repeated unknown placeholder tokens within one assembly', () => {
    // The same {{TOKEN}} can appear in several blocks; that is one problem, not three.
    const issues = collectPromptAssemblyIssues({
      droppedBlocks: [],
      violations: [],
      unknownTokens: ['FOO', 'FOO', 'BAR'],
    });
    assert.deepEqual(issues, [
      { kind: 'unknown_placeholder_token', detail: 'FOO' },
      { kind: 'unknown_placeholder_token', detail: 'BAR' },
    ]);
  });

  it('a clean assembly yields nothing', () => {
    assert.deepEqual(
      collectPromptAssemblyIssues({ droppedBlocks: [], violations: [], unknownTokens: [] }),
      [],
    );
  });
});

describe('assemblyAlertDedupeKey', () => {
  const issue = { kind: 'orphan_block_key', detail: ORPHAN } as const;

  it('is stable for the same tenant, issue and catalog epoch', () => {
    // This is the property that turns "one alert per reply" into "one alert, ever, until
    // something changes".
    assert.equal(
      assemblyAlertDedupeKey('tenant-1', issue, 'marker-a'),
      assemblyAlertDedupeKey('tenant-1', issue, 'marker-a'),
    );
  });

  it('separates tenants', () => {
    assert.notEqual(
      assemblyAlertDedupeKey('tenant-1', issue, 'marker-a'),
      assemblyAlertDedupeKey('tenant-2', issue, 'marker-a'),
    );
  });

  it('separates issue kinds and details', () => {
    assert.notEqual(
      assemblyAlertDedupeKey('t', issue, 'm'),
      assemblyAlertDedupeKey('t', { kind: 'over_budget', detail: ORPHAN }, 'm'),
    );
    assert.notEqual(
      assemblyAlertDedupeKey('t', issue, 'm'),
      assemblyAlertDedupeKey('t', { kind: 'orphan_block_key', detail: 'custom_x' }, 'm'),
    );
  });

  it('re-alerts once the catalog epoch moves', () => {
    // A catalog change is the moment the condition might have been fixed — and the moment it is
    // worth re-checking whether it survived.
    assert.notEqual(
      assemblyAlertDedupeKey('t', issue, 'marker-a'),
      assemblyAlertDedupeKey('t', issue, 'marker-b'),
    );
  });

  it('over_budget keys are identical across varying prompt lengths against the same cap', () => {
    // The production bug this pins: N is the assembled prompt's length and changes on every
    // reply, so keying on the raw "N > M" detail minted a fresh key per turn — one tenant-level
    // alert per AI reply, exactly the per-reply spam this module exists to prevent.
    assert.equal(
      assemblyAlertDedupeKey('t', { kind: 'over_budget', detail: '39458 > 34000' }, 'm'),
      assemblyAlertDedupeKey('t', { kind: 'over_budget', detail: '35001 > 34000' }, 'm'),
    );
  });

  it('over_budget keys differ across budget caps', () => {
    // A cap change is a config move — re-checking whether the condition survived it is correct.
    assert.notEqual(
      assemblyAlertDedupeKey('t', { kind: 'over_budget', detail: '40000 > 34000' }, 'm'),
      assemblyAlertDedupeKey('t', { kind: 'over_budget', detail: '40000 > 30000' }, 'm'),
    );
  });

  it('a malformed over_budget detail degrades to a constant key, never to no dedup', () => {
    const a = dedupeDetailFor({ kind: 'over_budget', detail: 'not a size pair' });
    const b = dedupeDetailFor({ kind: 'over_budget', detail: 'another odd shape' });
    assert.equal(a, b);
  });

  it('non-over_budget kinds still key on the full detail', () => {
    for (const kind of [
      'orphan_block_key',
      'missing_required_section',
      'forbidden_section_reference',
      'unknown_placeholder_token',
    ] as const) {
      assert.equal(dedupeDetailFor({ kind, detail: 'some-detail' }), 'some-detail');
    }
  });

  it('degrades a missing marker to a CONSTANT epoch, never to no dedup', () => {
    // With Redis cold or the registry off there is no marker. The dangerous reading is "unknown,
    // so do not dedupe" — that is one alert per reply. Null must be a stable epoch instead.
    const a = assemblyAlertDedupeKey('t', issue, null);
    const b = assemblyAlertDedupeKey('t', issue, null);
    assert.equal(a, b);
    assert.ok(a.endsWith('nomarker'));
  });
});

describe('the alert reason', () => {
  it('is a distinct snake_case reason, not reused from a conversation escalation', () => {
    assert.equal(PROMPT_ASSEMBLY_ALERT_REASON, 'prompt_assembly_violation');
  });
});
