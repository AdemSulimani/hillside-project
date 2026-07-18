/**
 * Unit tests for the shadow-diff reader (P3-4).
 *
 * The remediation plan makes shadow-diffing the gate for P3-1's ~20 classifier cutovers, so the
 * arithmetic below decides whether a behaviour change ships. Two properties get the most attention:
 *
 *   - the parser must survive branch strings it does not recognise. A report over months of ledger
 *     rows WILL meet strings written by code that no longer exists, and a throw there makes the
 *     analyzer useless exactly when the history matters most.
 *   - `other`-kind branches must stay out of the agreement denominator. Folding an unparseable row
 *     into either bucket quietly moves a cutover threshold, which is the worst kind of bug here
 *     because the number still looks plausible.
 *
 * Pure/in-process: no network, DB, Redis or OpenAI key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShadowDiffReport,
  meetsCutoverBar,
  parseShadowBranch,
  type ShadowDiffRow,
} from '../shadowDiff';
import type { LedgerDecisionEvent } from '../../../db/models/aiDecisionLedger';

const event = (classifier: string, branch: string): LedgerDecisionEvent => ({
  classifier,
  raw_score: null,
  threshold: null,
  boost_applied: false,
  passed: true,
  branch,
});

const row = (id: string, ...events: LedgerDecisionEvent[]): ShadowDiffRow => ({
  idempotency_key: id,
  conversation_id: `conv-${id}`,
  created_at: '2026-07-18T00:00:00.000Z',
  decision_events: events,
});

describe('parseShadowBranch', () => {
  it('parses the exact agree form order_stage emits', () => {
    const p = parseShadowBranch('agree:true:stage=awaiting_confirmation');
    assert.equal(p.kind, 'agree');
    assert.equal(p.value, 'true');
    assert.deepEqual(p.context, { stage: 'awaiting_confirmation' });
  });

  it('parses the exact diverge form order_stage emits', () => {
    const p = parseShadowBranch('diverge:legacy=false:det=true:stage=collecting');
    assert.equal(p.kind, 'diverge');
    assert.equal(p.legacy, 'false');
    assert.equal(p.deterministic, 'true');
    // legacy/det are not context — they are the comparison itself.
    assert.deepEqual(p.context, { stage: 'collecting' });
  });

  it('parses an agree with no value and no context', () => {
    const p = parseShadowBranch('agree');
    assert.equal(p.kind, 'agree');
    assert.equal(p.value, undefined);
    assert.deepEqual(p.context, {});
  });

  it('parses multiple context pairs', () => {
    const p = parseShadowBranch('agree:true:stage=x:locale=sq');
    assert.deepEqual(p.context, { stage: 'x', locale: 'sq' });
  });

  it('returns kind "other" — never throws — on an unrecognised string', () => {
    assert.equal(parseShadowBranch('flagged').kind, 'other');
    assert.equal(parseShadowBranch('').kind, 'other');
    assert.equal(parseShadowBranch('ok:whatever').kind, 'other');
  });

  it('does not throw on null/undefined input from a legacy row', () => {
    assert.equal(parseShadowBranch(undefined as unknown as string).kind, 'other');
  });
});

describe('buildShadowDiffReport', () => {
  it('counts agreement and divergence for the named classifier only', () => {
    const rows = [
      row('a', event('order_stage', 'agree:true:stage=x'), event('quality_eval', 'diverge:legacy=a:det=b')),
      row('b', event('order_stage', 'diverge:legacy=false:det=true:stage=x')),
      row('c', event('order_stage', 'agree:false:stage=y')),
    ];
    const r = buildShadowDiffReport('order_stage', rows);
    assert.equal(r.total, 3);
    assert.equal(r.agree, 2);
    assert.equal(r.diverge, 1);
    assert.equal(r.agreementPercent, 66, 'floored, not rounded');
  });

  it('excludes unparseable branches from the denominator but still reports them', () => {
    const rows = [
      row('a', event('c1', 'agree:true')),
      row('b', event('c1', 'flagged')), // a non-shadow decision_event on the same classifier
    ];
    const r = buildShadowDiffReport('c1', rows);
    assert.equal(r.other, 1);
    assert.equal(r.total, 1, 'the unparseable row must not inflate the denominator');
    assert.equal(r.agreementPercent, 100);
  });

  it('reports 100% on an empty set rather than NaN', () => {
    const r = buildShadowDiffReport('nobody', [row('a', event('other', 'agree:true'))]);
    assert.equal(r.total, 0);
    assert.equal(r.agreementPercent, 100);
    assert.deepEqual(r.byContext, []);
  });

  it('breaks agreement down by context', () => {
    const rows = [
      row('a', event('c', 'agree:true:stage=x')),
      row('b', event('c', 'diverge:legacy=1:det=2:stage=y')),
      row('c', event('c', 'agree:true:stage=y')),
    ];
    const r = buildShadowDiffReport('c', rows);
    const y = r.byContext.find((b) => b.context === 'stage=y');
    assert.ok(y);
    assert.equal(y.total, 2);
    assert.equal(y.diverge, 1);
    assert.equal(y.agreementPercent, 50);
  });

  it('sorts byContext by key so two runs over the same data produce a diffable report', () => {
    const rows = [
      row('a', event('c', 'agree:true:stage=zeta')),
      row('b', event('c', 'agree:true:stage=alpha')),
      row('c', event('c', 'agree:true:stage=mid')),
    ];
    const contexts = buildShadowDiffReport('c', rows).byContext.map((b) => b.context);
    assert.deepEqual(contexts, [...contexts].sort());
  });

  it('caps divergence examples and carries the identifiers needed to find the reply', () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      row(`k${i}`, event('c', 'diverge:legacy=false:det=true')),
    );
    const r = buildShadowDiffReport('c', rows, { maxExamples: 3 });
    assert.equal(r.diverge, 25);
    assert.equal(r.divergenceExamples.length, 3);
    assert.equal(r.divergenceExamples[0].idempotencyKey, 'k0');
    assert.equal(r.divergenceExamples[0].conversationId, 'conv-k0');
  });

  it('tolerates a row with no decision_events at all', () => {
    const r = buildShadowDiffReport('c', [
      { idempotency_key: 'x', conversation_id: null, created_at: new Date(0), decision_events: [] },
    ]);
    assert.equal(r.total, 0);
  });
});

describe('meetsCutoverBar', () => {
  const rows = (agree: number, diverge: number): ShadowDiffRow[] => [
    ...Array.from({ length: agree }, (_, i) => row(`a${i}`, event('c', 'agree:true'))),
    ...Array.from({ length: diverge }, (_, i) => row(`d${i}`, event('c', 'diverge:legacy=1:det=2'))),
  ];

  it('passes when agreement and volume both clear the bar', () => {
    const v = meetsCutoverBar(buildShadowDiffReport('c', rows(99, 1)), { minPercent: 99, minRows: 100 });
    assert.equal(v.pass, true);
  });

  it('FAILS on thin evidence even at 100% agreement', () => {
    // 3/3 is not evidence, and a cutover gate that accepted it would be worse than no gate.
    const v = meetsCutoverBar(buildShadowDiffReport('c', rows(3, 0)), { minPercent: 99, minRows: 100 });
    assert.equal(v.pass, false);
    assert.match(v.reason, /only 3 observations/);
  });

  it('fails when agreement is below the bar, naming the divergence count', () => {
    const v = meetsCutoverBar(buildShadowDiffReport('c', rows(90, 10)), { minPercent: 99, minRows: 50 });
    assert.equal(v.pass, false);
    assert.match(v.reason, /90% below the 99% bar/);
    assert.match(v.reason, /10 divergences/);
  });
});
