/**
 * Tests for the reply-quality evaluation contract (P3-4, RC-15).
 *
 * This logic had ZERO coverage before P3-4, which is startling given what it decides: whether a
 * customer's conversation gets flagged, alerted on, and PAUSED with no automatic resume (RC-14).
 * It was untestable rather than untested — everything lived in `aiQualityService.ts`, which imports
 * `openaiClient` and therefore throws at module load without an API key. Extracting the contract
 * into a leaf module is what made these assertions possible at all.
 *
 * Pure/in-process: no network, DB, Redis or OpenAI key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLAG_REASON_VALUES,
  buildQualityEvalSystemPrompt,
  buildQualityEvalUserContent,
  evaluationTriggersAlert,
  parseEvaluationJson,
  resolveStoredFlagReason,
  type ReplyQualityEvaluation,
} from '../aiQualityContract';

const evaluation = (over: Partial<ReplyQualityEvaluation> = {}): ReplyQualityEvaluation => ({
  quality_score: 0.95,
  is_off_topic: false,
  is_unclear: false,
  is_irrelevant: false,
  reason: null,
  flagging_rule_triggered: null,
  ...over,
});

describe('evaluationTriggersAlert', () => {
  it('a clean high-scoring reply does not alert', () => {
    assert.equal(evaluationTriggersAlert(evaluation(), 0.1), false);
  });

  it('off-topic alerts regardless of score', () => {
    assert.equal(evaluationTriggersAlert(evaluation({ is_off_topic: true }), 0.1), true);
  });

  it('irrelevant alerts regardless of score', () => {
    assert.equal(evaluationTriggersAlert(evaluation({ is_irrelevant: true }), 0.1), true);
  });

  it('is_unclear ALONE never alerts (evaluators over-report it on short/non-English replies)', () => {
    assert.equal(evaluationTriggersAlert(evaluation({ is_unclear: true }), 0.1), false);
  });

  it('a score below the threshold alerts; at the threshold it does not', () => {
    assert.equal(evaluationTriggersAlert(evaluation({ quality_score: 0.09 }), 0.1), true);
    assert.equal(evaluationTriggersAlert(evaluation({ quality_score: 0.1 }), 0.1), false);
  });

  it('RC-15 IN1: the degenerate "Po." scored 0.20 and clears the live 0.1 floor', () => {
    // The measured case, pinned: at the live floor a one-word answer ships.
    assert.equal(evaluationTriggersAlert(evaluation({ quality_score: 0.2 }), 0.1), false);
  });

  it('RC-15 EV-018: order confirmations score a systematic 0.200 — inert at 0.1, fatal at 0.6', () => {
    // This is exactly why QUALITY_THRESHOLD must not be "tightened" to 0.6 while the eval is still
    // on the send path: every order confirmation would flag and pause the AI at checkout.
    const orderConfirmation = evaluation({ quality_score: 0.2 });
    assert.equal(evaluationTriggersAlert(orderConfirmation, 0.1), false, 'inert at the live floor');
    assert.equal(evaluationTriggersAlert(orderConfirmation, 0.6), true, 'fatal at the example floor');
  });
});

describe('resolveStoredFlagReason', () => {
  it('misleading wins over every other signal (it is the most actionable)', () => {
    const r = resolveStoredFlagReason(
      evaluation({ is_off_topic: true, is_irrelevant: true, reason: 'reply is misleading' }),
      0.1,
    );
    assert.equal(r, 'misleading');
  });

  it('off_topic beats irrelevant beats unclear', () => {
    assert.equal(resolveStoredFlagReason(evaluation({ is_off_topic: true, is_irrelevant: true }), 0.1), 'off_topic');
    assert.equal(resolveStoredFlagReason(evaluation({ is_irrelevant: true, is_unclear: true }), 0.1), 'irrelevant');
    assert.equal(resolveStoredFlagReason(evaluation({ is_unclear: true }), 0.1), 'unclear');
  });

  it('a sub-threshold score with no boolean set maps to low_confidence', () => {
    assert.equal(resolveStoredFlagReason(evaluation({ quality_score: 0.05 }), 0.1), 'low_confidence');
  });

  it("normalizes the model's free-text reason when it names a known value", () => {
    assert.equal(resolveStoredFlagReason(evaluation({ reason: 'Off-Topic' }), 0.1), 'off_topic');
    assert.equal(resolveStoredFlagReason(evaluation({ reason: 'offtopic' }), 0.1), 'off_topic');
    assert.equal(resolveStoredFlagReason(evaluation({ reason: 'low confidence' }), 0.1), 'low_confidence');
  });

  it('always returns a value inside the stored enum (the column is constrained)', () => {
    const inputs = [
      evaluation({ reason: 'something the model invented' }),
      evaluation({ quality_score: 0 }),
      evaluation({ is_unclear: true }),
      evaluation(),
    ];
    for (const e of inputs) {
      assert.ok(FLAG_REASON_VALUES.includes(resolveStoredFlagReason(e, 0.1)));
    }
  });
});

describe('parseEvaluationJson', () => {
  it('parses a well-formed verdict', () => {
    const e = parseEvaluationJson(
      JSON.stringify({ quality_score: 0.92, is_off_topic: false, reason: 'fine' }),
    );
    assert.equal(e.quality_score, 0.92);
    assert.equal(e.is_off_topic, false);
    assert.equal(e.reason, 'fine');
  });

  it('rescales a percentage score — evaluators return "85" as often as "0.85"', () => {
    assert.equal(parseEvaluationJson(JSON.stringify({ quality_score: 85 })).quality_score, 0.85);
  });

  it('clamps to [0, 1]', () => {
    assert.equal(parseEvaluationJson(JSON.stringify({ quality_score: -5 })).quality_score, 0);
    assert.equal(parseEvaluationJson(JSON.stringify({ quality_score: 250 })).quality_score, 1);
  });

  it('a MISSING score defaults to 0.5, not 0 — defaulting to 0 would pause on every parse failure', () => {
    assert.equal(parseEvaluationJson('{}').quality_score, 0.5);
    assert.equal(parseEvaluationJson(JSON.stringify({ quality_score: 'high' })).quality_score, 0.5);
    assert.equal(parseEvaluationJson(JSON.stringify({ quality_score: NaN })).quality_score, 0.5);
  });

  it('coerces booleans strictly (a truthy string must not become a flag)', () => {
    const e = parseEvaluationJson(JSON.stringify({ is_off_topic: 'yes', is_irrelevant: 1 }));
    assert.equal(e.is_off_topic, false);
    assert.equal(e.is_irrelevant, false);
  });

  it('blank strings become null rather than empty-string reasons', () => {
    const e = parseEvaluationJson(JSON.stringify({ reason: '   ', flagging_rule_triggered: '' }));
    assert.equal(e.reason, null);
    assert.equal(e.flagging_rule_triggered, null);
  });

  it('the 0.5 default does NOT alert at the live floor (parse failure must not pause anyone)', () => {
    assert.equal(evaluationTriggersAlert(parseEvaluationJson('{}'), 0.1), false);
  });
});

describe('prompt builders (shared with the offline scorer — that is the point)', () => {
  it('the system prompt carries the business name and the load-bearing rules', () => {
    const p = buildQualityEvalSystemPrompt('Acme Supplements');
    assert.match(p, /Acme Supplements/);
    assert.match(p, /Rule 1c/, 'the never-penalize-non-English rule must survive');
    assert.match(p, /Rule 1d/, 'the order-detail-collection rule must survive');
  });

  it('the user content embeds message, reply and catalog', () => {
    const c = buildQualityEvalUserContent('a keni carbo one', 'Po, e kemi.', '- Carbo one 1kg Limon');
    assert.match(c, /a keni carbo one/);
    assert.match(c, /Po, e kemi\./);
    assert.match(c, /Carbo one 1kg Limon/);
  });

  it('substitutes placeholders for an empty inbound or empty catalog rather than sending blanks', () => {
    const c = buildQualityEvalUserContent('', 'Po.', '   ');
    assert.match(c, /no text; attachments or images/);
    assert.match(c, /no catalog context provided/);
  });

  it('is deterministic — same inputs, byte-identical prompt', () => {
    assert.equal(
      buildQualityEvalUserContent('a', 'b', 'c'),
      buildQualityEvalUserContent('a', 'b', 'c'),
    );
  });
});
