/**
 * Tests for the P1-5 AI decision ledger (RC-03/17/01/02/04/22).
 *
 * Two guarantees, both pure/in-process (no DB/network):
 *  1. MANDATORY P1-6 redaction — customer PII (phones/emails/addresses) never reaches the durable
 *     ledger record (nor the outbox payload built from it), regardless of which field carries it.
 *  2. §15.2 RECONSTRUCTION — from the ledger record ALONE, an on-call engineer can recover the
 *     assembled-prompt provenance, the model + temperature, the retrieval similarity scores +
 *     semanticSkipped, the per-classifier decision chain, and completion.usage — the exact set the
 *     observability audit proved was unrecoverable for the `fcd0af7e` false-hallucination incident.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ReplyTelemetry } from '../aiTelemetry';
import { buildLedgerRecord } from '../../jobs/aiDecisionLedgerWriter';
import {
  buildLedgerOutboxPayload,
  redactLedgerRecord,
  type LedgerDecisionEvent,
} from '../../db/models/aiDecisionLedger';

const PHONE = '+38344123456';
const EMAIL = 'blerta@example.com';

// A telemetry blob modelled on the fcd0af7e turn: a keyword-less Gheg follow-up rotated the
// retrieval window (the two correct products fell BELOW 0.65), and the name guard replaced the
// correct reply with a holding message. The system-prompt preview carries a customer phone so the
// redaction contract is exercised on the reconstruction target itself.
function fcd0af7eTelemetry(): ReplyTelemetry {
  return {
    prompt: {
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      charCount: 28000,
      tokenEstimate: 7000,
      preview: `You are the AI assistant for Hillside. Persona active. Customer callback ${PHONE}.`,
    },
    model: {
      requested: 'gpt-4o',
      served: 'gpt-4o-2024-08-06',
      customModelUsed: false,
      temperature: 0.3,
      maxTokens: 768,
      seed: null,
      finishReason: 'stop',
      truncated: false,
      systemFingerprint: 'fp_abc123',
    },
    usage: {
      promptTokens: 7100,
      completionTokens: 40,
      totalTokens: 7140,
      usdCost: 0.018,
    },
    retrieval: {
      semanticSkipped: false,
      skipReason: null,
      threshold: 0.65,
      coreCount: 0, // nothing cleared 0.65 — the rotated window
      bandCount: 0,
      sources: [
        { name: 'semantic', count: 0 },
        { name: 'keyword', count: 10 },
      ],
      // The two CORRECT products (Mega Mass, Mass gainer) fell to 0.58/0.54 — the §15.2 gap.
      top: [
        { id: 'mega-mass', similarity: 0.58 },
        { id: 'mass-gainer', similarity: 0.54 },
        { id: 'melatonine', similarity: 0.41 },
      ],
      productIds: ['melatonine', 'creatine', 'c4'],
    },
  };
}

const NAME_GUARD_ESCALATION: LedgerDecisionEvent = {
  classifier: 'product_name_hallucination_guard',
  raw_score: 2,
  threshold: null,
  boost_applied: false,
  passed: true,
  branch: 'escalate',
};

function buildFcd0af7eRecord() {
  return buildLedgerRecord({
    tenantId: 'tenant-1',
    conversationId: 'conv-1',
    correlationId: 'inbound-msg-6',
    traceId: 'trace-xyz',
    replySlot: 'main',
    decisionKind: 'escalation:product_name',
    messageId: 'msg-6e9144d7',
    telemetry: fcd0af7eTelemetry(),
    decisionEvents: [
      { classifier: 'product_info_gap', raw_score: null, threshold: null, boost_applied: false, passed: false, branch: 'answer_as_is' },
      NAME_GUARD_ESCALATION,
      { classifier: 'quality_eval', raw_score: 0.2, threshold: 0.1, boost_applied: false, passed: false, branch: 'ok' },
    ],
    guardVerdicts: {
      productNameHallucinationEscalated: true,
      knowledgeGapEscalated: false,
      priceHallucinationEscalated: false,
      uncertainAnswerEscalated: false,
      customerCallbackNote: `ring me on ${PHONE} or ${EMAIL}`,
    },
  });
}

describe('aiDecisionLedger — mandatory PII redaction', () => {
  it('masks phones/emails in every field, in the record and the outbox payload', () => {
    const raw = buildFcd0af7eRecord();
    // buildLedgerRecord itself does NOT redact (redaction is the writer's mandatory pass).
    assert.ok(JSON.stringify(raw).includes(PHONE), 'precondition: raw record carries cleartext');

    const redacted = redactLedgerRecord(raw);
    const redactedJson = JSON.stringify(redacted);
    assert.ok(!redactedJson.includes(PHONE), 'phone must be masked in the record');
    assert.ok(!redactedJson.includes(EMAIL), 'email must be masked in the record');
    assert.ok(redactedJson.includes('[phone#3456]'), 'phone -> deterministic last-4 token');
    assert.ok(redactedJson.includes('[email#'), 'email -> deterministic token');

    const payloadJson = JSON.stringify(buildLedgerOutboxPayload(raw));
    assert.ok(!payloadJson.includes(PHONE), 'outbox payload must also be pre-redacted');
    assert.ok(!payloadJson.includes(EMAIL), 'outbox payload must also be pre-redacted');
  });

  it('is idempotent — re-redacting a redacted record does not corrupt tokens', () => {
    const once = redactLedgerRecord(buildFcd0af7eRecord());
    const twice = redactLedgerRecord(once);
    assert.deepEqual(twice, once);
  });

  it('preserves non-PII data (scores, model, ids) through redaction', () => {
    const redacted = redactLedgerRecord(buildFcd0af7eRecord());
    assert.equal(redacted.retrieval?.top[0]?.similarity, 0.58);
    assert.equal(redacted.model?.temperature, 0.3);
    assert.equal(redacted.usage?.total_tokens, 7140);
  });
});

describe('aiDecisionLedger — §15.2 reconstruction from the record alone', () => {
  const record = redactLedgerRecord(buildFcd0af7eRecord());

  it('recovers the assembled-prompt provenance (hash + masked preview)', () => {
    assert.equal(record.prompt?.hash.length, 64);
    assert.equal(record.prompt?.char_count, 28000);
    assert.ok((record.prompt?.preview ?? '').includes('Persona active'), 'system prompt structure visible');
    assert.ok(!(record.prompt?.preview ?? '').includes(PHONE), 'no cleartext PII in the preview');
  });

  it('recovers which model and temperature answered', () => {
    assert.equal(record.model?.requested, 'gpt-4o');
    assert.equal(record.model?.served, 'gpt-4o-2024-08-06');
    assert.equal(record.model?.custom_model_used, false);
    assert.equal(record.model?.temperature, 0.3);
    assert.equal(record.model?.max_tokens, 768);
    assert.equal(record.model?.seed, null); // never sent; recorded honestly
  });

  it('recovers the retrieval scores + threshold outcome + semanticSkipped', () => {
    assert.equal(record.retrieval?.semantic_skipped, false);
    assert.equal(record.retrieval?.threshold, 0.65);
    assert.equal(record.retrieval?.core_count, 0);
    // The correct products' scores fell below the threshold — recoverable WITHOUT manual SQL.
    const megaMass = record.retrieval?.top.find((t) => t.id === 'mega-mass');
    assert.ok(megaMass && megaMass.similarity < 0.65);
    assert.ok(megaMass && megaMass.similarity === 0.58);
  });

  it('recovers the classifier decision chain, including the name-guard escalation', () => {
    const chain = record.decision_events.map((e) => e.classifier);
    assert.deepEqual(chain, ['product_info_gap', 'product_name_hallucination_guard', 'quality_eval']);
    const nameGuard = record.decision_events.find((e) => e.classifier === 'product_name_hallucination_guard');
    assert.equal(nameGuard?.branch, 'escalate');
    assert.equal(record.decision_kind, 'escalation:product_name');
    assert.equal(record.guard_verdicts.productNameHallucinationEscalated, true);
  });

  it('recovers completion.usage / cost', () => {
    assert.equal(record.usage?.total_tokens, 7140);
    assert.equal(record.usage?.usd_cost, 0.018);
  });

  it('carries the per-message correlation id (burst-merge-safe)', () => {
    assert.equal(record.correlation_id, 'inbound-msg-6');
    assert.equal(record.trace_id, 'trace-xyz');
  });
});

describe('aiDecisionLedger — idempotency key', () => {
  it('is stable for the same (conversation, inbound, slot) and differs by slot', () => {
    const base = { tenantId: 't', conversationId: 'c', correlationId: 'm', decisionEvents: [] as LedgerDecisionEvent[] };
    const a = buildLedgerRecord({ ...base, replySlot: 'main', decisionKind: 'reply' });
    const a2 = buildLedgerRecord({ ...base, replySlot: 'main', decisionKind: 'reply' });
    const b = buildLedgerRecord({ ...base, replySlot: 'none', decisionKind: 'no_reply' });
    assert.equal(a.idempotency_key, a2.idempotency_key, 'same inputs -> same key (retry dedupe)');
    assert.notEqual(a.idempotency_key, b.idempotency_key, 'different slot -> different key');
  });

  it('builds a null-telemetry record for early-return paths (no model call)', () => {
    const r = buildLedgerRecord({
      tenantId: 't',
      conversationId: 'c',
      correlationId: 'm',
      replySlot: 'none',
      decisionKind: 'no_reply',
      decisionEvents: [],
    });
    assert.equal(r.prompt, null);
    assert.equal(r.model, null);
    assert.equal(r.usage, null);
    assert.equal(r.retrieval, null);
    assert.deepEqual(r.decision_events, []);
  });
});
