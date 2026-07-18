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
  insertParams,
  redactLedgerRecord,
  type LedgerDecisionEvent,
  ledgerSelectList,
} from '../../db/models/aiDecisionLedger';
import type { DeclaredFact } from '../groundingGate';

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
      systemHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
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
    assert.equal(r.facts_used, null);
    assert.equal(r.receipt_snapshot, null);
  });
});

/**
 * P2-4 Part 2 (RC-01/RC-02): `facts_used` is what lets a grounding-gate strip be re-judged against
 * the catalog from the ledger alone. P2-1 built the whole chain but the LEGACY send path — the
 * default, since AI_REPLY_STAGE_BEFORE_SEND is off — silently omitted the field, so every delivered
 * reply recorded facts_used NULL despite declared facts existing. There was no test to catch it.
 *
 * Asserted on `insertParams` and not just the record: the mapper is only half the trip, and the
 * question that actually matters is whether the value reaches its bind parameter.
 */
describe('aiDecisionLedger — facts_used reaches the DB (P2-4 Part 2)', () => {
  const FACTS: DeclaredFact[] = [
    { type: 'price', product_ref: 'Mega Mass 4000', value: '18.00' },
    { type: 'name', product_ref: 'Serious Mass', value: 'Serious Mass 5.4kg' },
  ];

  const FACTS_USED_PARAM_INDEX = 14; // $15
  const RECEIPT_SNAPSHOT_PARAM_INDEX = 15; // $16

  it('binds declared facts to $15', () => {
    const r = buildLedgerRecord({
      tenantId: 't',
      conversationId: 'c',
      correlationId: 'm',
      replySlot: 'main',
      decisionKind: 'reply',
      decisionEvents: [],
      factsUsed: FACTS,
    });
    assert.deepEqual(r.facts_used, FACTS);
    assert.equal(insertParams(r)[FACTS_USED_PARAM_INDEX], JSON.stringify(FACTS));
  });

  it('binds null — not the string "null" or undefined — when the contract is off', () => {
    // Vision replies, custom-model replies, and FACTS_USED_CONTRACT=off legitimately declare no
    // facts. That must be a SQL NULL, distinguishable from "the contract ran and found nothing".
    const r = buildLedgerRecord({
      tenantId: 't',
      conversationId: 'c',
      correlationId: 'm',
      replySlot: 'main',
      decisionKind: 'reply',
      decisionEvents: [],
    });
    assert.equal(r.facts_used, null);
    assert.equal(insertParams(r)[FACTS_USED_PARAM_INDEX], null);
  });

  it('distinguishes an empty declaration from an absent one', () => {
    const r = buildLedgerRecord({
      tenantId: 't',
      conversationId: 'c',
      correlationId: 'm',
      replySlot: 'main',
      decisionKind: 'reply',
      decisionEvents: [],
      factsUsed: [],
    });
    // "The contract ran and the model declared zero facts" is a real, different signal from NULL.
    assert.deepEqual(r.facts_used, []);
    assert.equal(insertParams(r)[FACTS_USED_PARAM_INDEX], '[]');
  });

  it('survives redaction with prices and product names intact', () => {
    // The redaction pass must not eat the very values the reconstruction needs. `PHONE_RE` requires
    // 7-15 digits, so a price like "18.00" is safe — this pins that rather than assuming it.
    const r = buildLedgerRecord({
      tenantId: 't',
      conversationId: 'c',
      correlationId: 'm',
      replySlot: 'main',
      decisionKind: 'reply',
      decisionEvents: [],
      factsUsed: FACTS,
    });
    const redacted = redactLedgerRecord(r);
    const json = JSON.stringify(redacted.facts_used);
    assert.ok(json.includes('18.00'), 'a price must survive redaction');
    assert.ok(json.includes('Mega Mass 4000'), 'a product name must survive redaction');
  });

  it('still masks PII that reaches facts_used', () => {
    const r = buildLedgerRecord({
      tenantId: 't',
      conversationId: 'c',
      correlationId: 'm',
      replySlot: 'main',
      decisionKind: 'reply',
      decisionEvents: [],
      factsUsed: [
        { type: 'attribute', product_ref: `call ${PHONE}`, value: EMAIL },
      ] satisfies DeclaredFact[],
    });
    const json = JSON.stringify(redactLedgerRecord(r).facts_used);
    assert.ok(!json.includes(PHONE));
    assert.ok(!json.includes(EMAIL));
  });

  it('binds the receipt snapshot to $16 and keeps it queryable', () => {
    const snapshot = {
      captured: { aiActive: true, conversationAiPaused: false },
      live: { aiActive: false, conversationAiPaused: false },
      diverged: ['aiActive'],
      receipt_to_capture_ms: 120,
      capture_to_eval_ms: 8_000,
    };
    const r = buildLedgerRecord({
      tenantId: 't',
      conversationId: 'c',
      correlationId: 'm',
      replySlot: 'none:gate:ai_globally_disabled',
      decisionKind: 'no_reply:ai_globally_disabled',
      decisionEvents: [],
      receiptSnapshot: snapshot,
    });
    assert.deepEqual(r.receipt_snapshot, snapshot);
    assert.equal(insertParams(r)[RECEIPT_SNAPSHOT_PARAM_INDEX], JSON.stringify(snapshot));
    // The RC-06 artifact survives the mandatory redaction pass — it carries no PII, only scalars,
    // and the divergence list is the whole point of the row.
    assert.deepEqual(redactLedgerRecord(r).receipt_snapshot?.diverged, ['aiActive']);
  });

  it('gives each gate its own idempotency key so one drop cannot mask another', () => {
    // The ledger insert is ON CONFLICT (idempotency_key) DO NOTHING and the key is slot-keyed, so a
    // single shared 'none' slot would let the first drop of an inbound swallow every later one — and
    // a job re-enqueued by the fairness/lock backoff can legitimately drop at a different gate.
    const base = {
      tenantId: 't',
      conversationId: 'c',
      correlationId: 'm',
      decisionEvents: [] as LedgerDecisionEvent[],
    };
    const a = buildLedgerRecord({
      ...base,
      replySlot: 'none:gate:ai_paused',
      decisionKind: 'no_reply:ai_paused',
    });
    const b = buildLedgerRecord({
      ...base,
      replySlot: 'none:gate:ai_globally_disabled',
      decisionKind: 'no_reply:ai_globally_disabled',
    });
    assert.notEqual(a.idempotency_key, b.idempotency_key);
  });

  it('keeps a suppressed main reply from masking a later delivered one', () => {
    // Both rows can occur for one inbound across a retry: attempt 1 generates then gets suppressed
    // by the pre-send re-validation, attempt 2 delivers. Sharing the 'main' slot would let the
    // suppressed row win the ON CONFLICT and permanently hide the delivered reply.
    const base = {
      tenantId: 't',
      conversationId: 'c',
      correlationId: 'm',
      decisionEvents: [] as LedgerDecisionEvent[],
    };
    const suppressed = buildLedgerRecord({
      ...base,
      replySlot: 'main:suppressed',
      decisionKind: 'suppressed:human_outbound_after_inbound',
    });
    const delivered = buildLedgerRecord({ ...base, replySlot: 'main', decisionKind: 'reply' });
    assert.notEqual(suppressed.idempotency_key, delivered.idempotency_key);
  });
});

/**
 * P3-4 added the READ side. Before it, this model was write-only (`grep "FROM ai_decision_ledger"`
 * returned nothing but the retention DELETE), so §15.2's "reconstruct an incident from the ledger
 * alone" was a property of the schema rather than of anything the code could do.
 */
describe('aiDecisionLedger — read-side column list (P3-4)', () => {
  it('qualifies EVERY column for the reconstruct join', () => {
    // This is not cosmetic. The list used to be a multi-line template split on ', ', which misses
    // the columns whose separator is ',\n  ' — `idempotency_key` and `guard_verdicts` came out
    // UNQUALIFIED. Postgres resolves them today only because ai_prompt_blobs shares no column
    // name; the day it gains one, the reconstruction query fails with "ambiguous column
    // reference" — precisely while someone is investigating an incident.
    const qualified = ledgerSelectList('l');
    for (const segment of qualified.split(/,\s*/)) {
      assert.ok(
        segment.startsWith('l.'),
        `unqualified column in the join select list: "${segment}"`,
      );
    }
  });

  it('carries every column the reader maps back onto LedgerRecord', () => {
    const plain = ledgerSelectList();
    for (const required of [
      'id', 'tenant_id', 'conversation_id', 'message_id', 'correlation_id', 'trace_id',
      'idempotency_key', 'reply_slot', 'decision_kind', 'prompt', 'model', 'usage', 'retrieval',
      'decision_events', 'guard_verdicts', 'facts_used', 'receipt_snapshot', 'config_fingerprint',
      'created_at',
    ]) {
      assert.ok(plain.split(', ').includes(required), `missing column: ${required}`);
    }
  });

  it('the unqualified form has no alias prefix (it is used without a join)', () => {
    assert.ok(!ledgerSelectList().includes('l.'));
  });
});
