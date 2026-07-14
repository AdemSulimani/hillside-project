/**
 * P1-2 (RC-20/21/18): the pure decision/dispatch core of failed-job handling.
 *
 * Kept free of BullMQ / DB / Redis imports (only the pure classifier + the pure redaction module +
 * a type-only import) so it is unit-testable with fake effects and never opens a Redis handle at
 * import time. The IO wiring — the real dead_letter insert, Sentry, ai_alerts, socket push, and
 * notifications enqueue — lives in failureHandler.ts, which injects it via `FailedJobEffects`.
 */
import { classifyJobFailure, type JobFailureClassification } from './failureClassifier';
import { redactValue } from '../utils/redact';
import type { InsertDeadLetterInput } from '../db/models/deadLetter';

interface AiReplyJobDataShape {
  tenantId?: string;
  channelId?: string;
  conversationId?: string;
  traceId?: string;
}

/** Queue/job facts the orchestrator needs, decoupled from the BullMQ `Job` instance for testability. */
export interface FailedJobInfo {
  queueName: string;
  jobId: string | null;
  jobName: string | null;
  data: Record<string, unknown>;
  failedReason: string | null;
  attemptsMade: number;
  maxAttempts: number;
}

/** Injectable side-effects so the orchestrator can be unit-tested with fakes. */
export interface FailedJobEffects {
  insertDeadLetter(input: InsertDeadLetterInput): Promise<string | null>;
  raiseAlerts(info: FailedJobInfo, err: Error, classification: JobFailureClassification): Promise<void>;
}

export interface FailedJobFlags {
  dlqEnabled: boolean;
  alertsEnabled: boolean;
  /** Mirrors the REDACT_PII master switch (utils/redact.ts) — when off, payloads are stored raw. */
  redactPii: boolean;
}

/**
 * Queues whose job payloads can carry raw customer free text. Webhook jobs store the raw inbound
 * webhook body (message text, names, phones); the other queues (ai/notifications/finetuning/default)
 * carry only ids. Drives the PII masking of `dead_letter.payload` (the P1-6 redaction boundary).
 */
export function queueCarriesCustomerText(queueName: string): boolean {
  return queueName === 'webhook';
}

export interface FailedJobOutcome {
  classification: JobFailureClassification;
  willRetry: boolean;
  deadLettered: boolean;
  alerted: boolean;
}

/**
 * Classify → (record) → (alert once). Alerts fire only when a NEW dead_letter row was inserted
 * (`insertDeadLetter` returns non-null) so a per-attempt re-fire never double-alerts. When DLQ
 * recording is off but alerts are on, it falls back to alerting on every dead-letter verdict.
 */
export async function orchestrateFailedJob(
  info: FailedJobInfo,
  err: Error,
  effects: FailedJobEffects,
  flags: FailedJobFlags,
): Promise<FailedJobOutcome> {
  const verdict = classifyJobFailure({
    failedReason: info.failedReason,
    errorName: err.name,
    errorMessage: err.message,
    attemptsMade: info.attemptsMade,
    maxAttempts: info.maxAttempts,
  });

  const outcome: FailedJobOutcome = {
    classification: verdict.classification,
    willRetry: !verdict.deadLetter,
    deadLettered: false,
    alerted: false,
  };

  if (!verdict.deadLetter) return outcome;

  const data = info.data as AiReplyJobDataShape;
  let newlyDeadLettered = false;

  if (flags.dlqEnabled) {
    // Webhook payloads are raw inbound webhook bodies (customer text/names/phones) — mask them
    // before the durable insert so dead_letter never bypasses the P1-6 redaction boundary. The
    // other queues' payloads carry only ids and stay replayable verbatim.
    const redactPayload = flags.redactPii && queueCarriesCustomerText(info.queueName);
    const newId = await effects.insertDeadLetter({
      queue_name: info.queueName,
      job_id: info.jobId ?? `unknown:${info.jobName ?? 'job'}`,
      job_name: info.jobName,
      tenant_id: data.tenantId ?? null,
      conversation_id: data.conversationId ?? null,
      trace_id: data.traceId ?? null,
      classification: verdict.classification,
      reason: verdict.classification === 'transient' ? 'exhausted' : verdict.classification,
      error: err.message,
      attempts: info.attemptsMade,
      max_attempts: info.maxAttempts,
      payload: redactPayload ? (redactValue(info.data) as Record<string, unknown>) : info.data,
      payload_redacted: redactPayload,
    });
    newlyDeadLettered = newId !== null;
    outcome.deadLettered = newlyDeadLettered;
  }

  const shouldAlert = flags.alertsEnabled && (newlyDeadLettered || !flags.dlqEnabled);
  if (shouldAlert) {
    await effects.raiseAlerts(info, err, verdict.classification);
    outcome.alerted = true;
  }

  return outcome;
}
