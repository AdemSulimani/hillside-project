/**
 * P1-2 (RC-20/21/18): fault-injection coverage for the failed-job orchestrator — the exhaustion →
 * DLQ + alert chain and its exactly-once dedupe. Effects are injected as fakes so this runs in CI
 * (npm test) with no DB / Redis. The DB-level behaviour (real dead_letter insert, ai_alert) is
 * exercised by the integration suite.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  orchestrateFailedJob,
  queueCarriesCustomerText,
  type FailedJobInfo,
  type FailedJobEffects,
  type FailedJobFlags,
} from '../../jobs/failedJobOrchestration';
import { STALLED_MESSAGE } from '../../jobs/failureClassifier';
import type { InsertDeadLetterInput } from '../../db/models/deadLetter';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CONV = '22222222-2222-2222-2222-222222222222';

function aiReplyInfo(overrides: Partial<FailedJobInfo> = {}): FailedJobInfo {
  return {
    queueName: 'ai',
    jobId: 'job-1',
    jobName: 'ai.reply',
    data: { tenantId: TENANT, conversationId: CONV, channelId: 'chan-1' },
    failedReason: null,
    attemptsMade: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

/** Fake effects: insertDeadLetter returns a fresh id the first time, null on a repeat (row exists). */
function makeEffects(existingKeys = new Set<string>()) {
  const inserts: Array<{ input: InsertDeadLetterInput; result: string | null }> = [];
  const alerts: Array<{ info: FailedJobInfo; classification: string }> = [];
  let idSeq = 0;
  const effects: FailedJobEffects = {
    async insertDeadLetter(input) {
      const key = `${input.queue_name}:${input.job_id}`;
      let result: string | null;
      if (existingKeys.has(key)) {
        result = null;
      } else {
        existingKeys.add(key);
        idSeq += 1;
        result = String(idSeq);
      }
      inserts.push({ input, result });
      return result;
    },
    async raiseAlerts(info, _err, classification) {
      alerts.push({ info, classification });
    },
  };
  return { effects, inserts, alerts };
}

const ALL_ON: FailedJobFlags = { dlqEnabled: true, alertsEnabled: true, redactPii: true };

describe('orchestrateFailedJob — stalled ai.reply (deploy SIGKILL)', () => {
  it('records a dead_letter row + alerts, even at attempt 1 of 3', async () => {
    const { effects, inserts, alerts } = makeEffects();
    const err = new Error(STALLED_MESSAGE);
    err.name = 'UnrecoverableError';

    const outcome = await orchestrateFailedJob(aiReplyInfo(), err, effects, ALL_ON);

    assert.equal(outcome.classification, 'stalled');
    assert.equal(outcome.willRetry, false);
    assert.equal(outcome.deadLettered, true);
    assert.equal(outcome.alerted, true);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].input.classification, 'stalled');
    assert.equal(inserts[0].input.reason, 'stalled');
    assert.equal(inserts[0].input.tenant_id, TENANT);
    assert.equal(alerts.length, 1);
  });

  it('a second identical failed event does NOT re-alert (dedupe on first insert)', async () => {
    const shared = new Set<string>();
    const err = new Error(STALLED_MESSAGE);
    err.name = 'UnrecoverableError';

    const first = makeEffects(shared);
    await orchestrateFailedJob(aiReplyInfo(), err, first.effects, ALL_ON);
    assert.equal(first.alerts.length, 1);

    // Same (queue, jobId) → insert returns null → no alert.
    const second = makeEffects(shared);
    const outcome = await orchestrateFailedJob(aiReplyInfo(), err, second.effects, ALL_ON);
    assert.equal(outcome.deadLettered, false);
    assert.equal(outcome.alerted, false);
    assert.equal(second.alerts.length, 0);
  });
});

describe('orchestrateFailedJob — transient', () => {
  it('does not record or alert while retries remain', async () => {
    const { effects, inserts, alerts } = makeEffects();
    const err = new Error('Request failed with status code 503');
    const outcome = await orchestrateFailedJob(aiReplyInfo({ attemptsMade: 1 }), err, effects, ALL_ON);

    assert.equal(outcome.classification, 'transient');
    assert.equal(outcome.willRetry, true);
    assert.equal(outcome.deadLettered, false);
    assert.equal(outcome.alerted, false);
    assert.equal(inserts.length, 0);
    assert.equal(alerts.length, 0);
  });

  it('records + alerts once exhausted', async () => {
    const { effects, inserts, alerts } = makeEffects();
    const err = new Error('Request failed with status code 503');
    const outcome = await orchestrateFailedJob(aiReplyInfo({ attemptsMade: 3 }), err, effects, ALL_ON);

    assert.equal(outcome.deadLettered, true);
    assert.equal(outcome.alerted, true);
    assert.equal(inserts[0].input.reason, 'exhausted');
    assert.equal(alerts.length, 1);
  });
});

describe('orchestrateFailedJob — flag gating', () => {
  it('records nothing and does not alert when both flags are off (legacy behaviour)', async () => {
    const { effects, inserts, alerts } = makeEffects();
    const err = new Error(STALLED_MESSAGE);
    err.name = 'UnrecoverableError';
    const outcome = await orchestrateFailedJob(aiReplyInfo(), err, effects, {
      dlqEnabled: false,
      alertsEnabled: false,
      redactPii: true,
    });
    assert.equal(outcome.deadLettered, false);
    assert.equal(outcome.alerted, false);
    assert.equal(inserts.length, 0);
    assert.equal(alerts.length, 0);
  });

  it('record-only shadow: DLQ on, alerts off → row written, no alert', async () => {
    const { effects, inserts, alerts } = makeEffects();
    const err = new Error(STALLED_MESSAGE);
    err.name = 'UnrecoverableError';
    const outcome = await orchestrateFailedJob(aiReplyInfo(), err, effects, {
      dlqEnabled: true,
      alertsEnabled: false,
      redactPii: true,
    });
    assert.equal(outcome.deadLettered, true);
    assert.equal(outcome.alerted, false);
    assert.equal(inserts.length, 1);
    assert.equal(alerts.length, 0);
  });

  it('alerts-only (DLQ off): alerts on every dead-letter verdict, no dedupe row', async () => {
    const { effects, inserts, alerts } = makeEffects();
    const err = new Error(STALLED_MESSAGE);
    err.name = 'UnrecoverableError';
    const outcome = await orchestrateFailedJob(aiReplyInfo(), err, effects, {
      dlqEnabled: false,
      alertsEnabled: true,
      redactPii: true,
    });
    assert.equal(outcome.deadLettered, false);
    assert.equal(outcome.alerted, true);
    assert.equal(inserts.length, 0);
    assert.equal(alerts.length, 1);
  });
});

describe('orchestrateFailedJob — dead_letter payload redaction (P1-6 boundary)', () => {
  /** A webhook-queue payload: the raw inbound body carries customer free text/phone/email. */
  function webhookInfo(): FailedJobInfo {
    return aiReplyInfo({
      queueName: 'webhook',
      jobName: 'webhook.facebook',
      data: {
        tenantId: TENANT,
        body: {
          message: 'Call me on +38344123456',
          email: 'filan@example.com',
        },
      },
    });
  }

  it('masks a webhook-queue payload and sets payload_redacted', async () => {
    const { effects, inserts } = makeEffects();
    const err = new Error(STALLED_MESSAGE);
    err.name = 'UnrecoverableError';

    await orchestrateFailedJob(webhookInfo(), err, effects, ALL_ON);

    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].input.payload_redacted, true);
    const stored = JSON.stringify(inserts[0].input.payload);
    assert.ok(!stored.includes('38344123456'), 'phone must be masked');
    assert.ok(!stored.includes('filan@example.com'), 'email must be masked');
    assert.ok(stored.includes('[phone#3456]'), 'phone token keeps last-4 for correlation');
  });

  it('stores an ai-queue payload verbatim with payload_redacted=false (ids only)', async () => {
    const { effects, inserts } = makeEffects();
    const err = new Error(STALLED_MESSAGE);
    err.name = 'UnrecoverableError';
    const info = aiReplyInfo();

    await orchestrateFailedJob(info, err, effects, ALL_ON);

    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].input.payload_redacted, false);
    assert.deepEqual(inserts[0].input.payload, info.data);
  });

  it('REDACT_PII off: webhook payload stored raw with payload_redacted=false', async () => {
    const { effects, inserts } = makeEffects();
    const err = new Error(STALLED_MESSAGE);
    err.name = 'UnrecoverableError';
    const info = webhookInfo();

    await orchestrateFailedJob(info, err, effects, {
      dlqEnabled: true,
      alertsEnabled: true,
      redactPii: false,
    });

    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].input.payload_redacted, false);
    assert.deepEqual(inserts[0].input.payload, info.data);
  });
});

describe('queueCarriesCustomerText', () => {
  it('flags only the webhook queue (raw inbound bodies); the id-only queues stay verbatim', () => {
    assert.equal(queueCarriesCustomerText('webhook'), true);
    for (const q of ['ai', 'notifications', 'finetuning', 'default']) {
      assert.equal(queueCarriesCustomerText(q), false);
    }
  });
});
