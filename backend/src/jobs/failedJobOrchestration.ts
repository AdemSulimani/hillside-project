/**
 * P1-2 (RC-20/21/18): the pure decision/dispatch core of failed-job handling.
 *
 * Kept free of BullMQ / DB / Redis imports (only the pure classifier + a type-only import) so it is
 * unit-testable with fake effects and never opens a Redis handle at import time. The IO wiring — the
 * real dead_letter insert, Sentry, ai_alerts, socket push, and notifications enqueue — lives in
 * failureHandler.ts, which injects it via `FailedJobEffects`.
 */
import { classifyJobFailure, type JobFailureClassification } from './failureClassifier';
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
      payload: info.data,
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
