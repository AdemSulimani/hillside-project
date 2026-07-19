import IORedis from 'ioredis';
import { Worker } from 'bullmq';
import type { WorkerOptions } from 'bullmq';
import { bullMqRedisConnectionOptions } from '../redisClientDefaults';
import { redisUrl } from './redisConnection';
import type { InboundWebhookJobData } from './jobTypes';
import { processInboundMessage } from './processInboundMessage';
import { processAIReply, type AIReplyJobData } from './processAIReply';
import { processGenerateProductEmbedding, type GenerateProductEmbeddingJobData } from './generateProductEmbedding';
import {
  processGenerateProductImageFingerprint,
  type GenerateProductImageFingerprintJobData,
} from './generateProductImageFingerprint';
import {
  processReconcileProductEmbeddings,
  processFastReconcileMissingEmbeddings,
  initEmbeddingReconcileScheduler,
  initFastEmbeddingReconcileScheduler,
} from './reconcileProductEmbeddings';
import {
  processReconcileProductImageFingerprints,
  processFastReconcileProductImageFingerprints,
  initImageFingerprintReconcileScheduler,
  initFastImageFingerprintReconcileScheduler,
} from './reconcileProductImageFingerprints';
import { initPrepareFinetuningScheduler, processPrepareFinetuning } from './prepareFinetuning';
import { initRefreshMetaTokensScheduler, processRefreshMetaTokens } from './refreshMetaTokens';
import { checkFinetuningStatus, startFinetuningJob } from './checkFinetuningStatus';
import { processNotificationJob } from './processNotificationJob';
import {
  processEvaluateConversationUseCase,
  type EvaluateUseCaseJobData,
} from './evaluateConversationUseCase';
import {
  processMonthlyUseCaseSnapshot,
  initMonthlyUseCaseSnapshotScheduler,
} from './monthlyUseCaseSnapshot';
import {
  runPauseInvariantMonitor,
  initPauseInvariantMonitorScheduler,
} from './pauseInvariantMonitor';
import { processOutboxRelay, initOutboxRelayScheduler } from './outboxRelay';
import { attachWorkerFailureHandler } from './failureHandler';
import { resolveWorkerConcurrency } from './workerConcurrency';
import { registerLocalWorker } from '../services/localWorkerRegistry';
import { runLedgerRetentionSweep } from '../services/ledgerRetention';
import { tick as runDeadLetterMetricsTick } from '../services/deadLetterMonitor';
import { runPromptRegistryReconcile } from '../services/promptRegistryReconcile';
import { runCostRollupSweep } from '../services/costRollup';
import { runCostAnomalyScan } from '../services/costAnomalyMonitor';
import {
  LEDGER_RETENTION_JOB,
  DLQ_METRICS_JOB,
  PROMPT_REGISTRY_JOB,
  AI_COST_ROLLUP_JOB,
  VECTOR_PARTIAL_INDEX_JOB,
  initLedgerRetentionScheduler,
  initDeadLetterMetricsScheduler,
  initPromptRegistryScheduler,
  initAiCostRollupScheduler,
  initVectorPartialIndexScheduler,
  removeDeadLetterMetricsScheduler,
} from './maintenanceSchedulers';
import { runVectorPartialIndexSweep } from '../db/vectorPartialIndexes';

/** Shared BullMQ worker tuning to reduce idle / polling Redis traffic. */
const redisOptimizedWorkerOptions: Pick<
  WorkerOptions,
  'stalledInterval' | 'maxStalledCount' | 'drainDelay' | 'lockDuration' | 'lockRenewTime' | 'settings'
> = {
  stalledInterval: 60_000,
  maxStalledCount: 2,
  drainDelay: 10,
  lockDuration: 30_000,
  lockRenewTime: 15_000,
  settings: {
    backoffStrategy: (attemptsMade) => Math.min(attemptsMade * 1000, 30_000),
  },
};

function createWorkerConnection(): IORedis {
  return new IORedis(redisUrl, bullMqRedisConnectionOptions);
}

/**
 * Allows operators to dial worker concurrency down on small hosts (e.g. the 1 vCPU droplet)
 * so that BullMQ jobs cannot starve the HTTP request loop. Defaults preserve historical
 * behaviour on hosts large enough to handle them. Parsing lives in `workerConcurrency.ts` (P3-2)
 * so it is unit-testable and shared with the worker entrypoint.
 */
const WEBHOOK_CONCURRENCY = resolveWorkerConcurrency('WEBHOOK_WORKER_CONCURRENCY');
const AI_CONCURRENCY = resolveWorkerConcurrency('AI_WORKER_CONCURRENCY');
const NOTIFICATIONS_CONCURRENCY = resolveWorkerConcurrency('NOTIFICATIONS_WORKER_CONCURRENCY');
const FINETUNING_CONCURRENCY = resolveWorkerConcurrency('FINETUNING_WORKER_CONCURRENCY');
const DEFAULT_CONCURRENCY = resolveWorkerConcurrency('DEFAULT_WORKER_CONCURRENCY');

export const webhookWorker = new Worker<InboundWebhookJobData>(
  'webhook',
  async (job) => {
    await processInboundMessage(job.data);
  },
  { connection: createWorkerConnection(), concurrency: WEBHOOK_CONCURRENCY, ...redisOptimizedWorkerOptions },
);

export const aiWorker = new Worker<AIReplyJobData | EvaluateUseCaseJobData>(
  'ai',
  async (job) => {
    if (job.name === 'evaluateConversationUseCase') {
      await processEvaluateConversationUseCase(job.data as EvaluateUseCaseJobData);
      return;
    }
    // P2-6 (F1): attempt position lets the final attempt of a provider-caused failure resolve
    // to the degradation floor instead of dead-lettering into customer silence. BullMQ v5:
    // inside the processor `attemptsMade` already includes the current attempt.
    await processAIReply(job.data as AIReplyJobData, {
      made: job.attemptsMade ?? 1,
      total: job.opts?.attempts ?? 1,
    });
  },
  {
    connection: createWorkerConnection(),
    concurrency: AI_CONCURRENCY,
    ...redisOptimizedWorkerOptions,
  },
);

export const notificationsWorker = new Worker(
  'notifications',
  async (job) => {
    await processNotificationJob(job);
  },
  { connection: createWorkerConnection(), concurrency: NOTIFICATIONS_CONCURRENCY, ...redisOptimizedWorkerOptions },
);

export const finetuningWorker = new Worker(
  'finetuning',
  async (job) => {
    if (job.name === 'prepareFinetuning') {
      await processPrepareFinetuning();
      return;
    }
    if (job.name === 'startFinetuning') {
      await startFinetuningJob(job.data as { tenantId: string; filePath: string });
      return;
    }
    if (job.name === 'checkFinetuningStatus') {
      await checkFinetuningStatus(job.data as { tenantId: string; fineTuningJobId: string });
      return;
    }
    console.warn('[jobs] finetuning queue: unknown job name', { name: job.name, id: job.id });
  },
  {
    connection: createWorkerConnection(),
    concurrency: FINETUNING_CONCURRENCY,
    ...redisOptimizedWorkerOptions,
    stalledInterval: 300_000,
    lockDuration: 300_000,
  },
);

export const defaultWorker = new Worker<
  GenerateProductEmbeddingJobData | GenerateProductImageFingerprintJobData | Record<string, never>
>(
  'default',
  async (job) => {
    if (job.name === 'refreshMetaTokens') {
      await processRefreshMetaTokens();
      return;
    }
    if (job.name === 'monthlyUseCaseSnapshot') {
      await processMonthlyUseCaseSnapshot();
      return;
    }
    if (job.name === 'pauseInvariantMonitor') {
      await runPauseInvariantMonitor();
      return;
    }
    if (job.name === 'outboxDrain') {
      await processOutboxRelay();
      return;
    }
    // P3-2 Step 7: these two were per-process `setInterval`s in server.ts, so N replicas ran N
    // concurrent DELETE sweeps. As scheduler jobs they fire exactly once fleet-wide.
    if (job.name === LEDGER_RETENTION_JOB) {
      await runLedgerRetentionSweep();
      return;
    }
    if (job.name === DLQ_METRICS_JOB) {
      await runDeadLetterMetricsTick();
      return;
    }
    // P3-5: registers unregistered prompt content, verifies stored hashes, refreshes the locked
    // catalog marker, and force-syncs drifted tenants — the replacement for the per-reply
    // self-heal, so it must be a fleet-singleton rather than a per-process interval.
    if (job.name === PROMPT_REGISTRY_JOB) {
      await runPromptRegistryReconcile();
      return;
    }
    // P3-6: fold the ledger into ai_cost_daily, then scan the freshly-written rollup for cost
    // anomalies. One job, in this order, deliberately — the alerter reads the numbers the sweep
    // just wrote, so it sees a consistent snapshot instead of racing a concurrent rewrite.
    if (job.name === AI_COST_ROLLUP_JOB) {
      await runCostRollupSweep();
      await runCostAnomalyScan();
      return;
    }
    // P3-2 (RC-04): reconcile per-tenant partial HNSW indexes. Fleet-singleton is mandatory here —
    // two replicas racing CREATE INDEX CONCURRENTLY on the same name is a deadlock class.
    if (job.name === VECTOR_PARTIAL_INDEX_JOB) {
      await runVectorPartialIndexSweep();
      return;
    }
    if (job.name === 'embeddingReconcile') {
      await processReconcileProductEmbeddings();
      return;
    }
    if (job.name === 'embeddingReconcileFast') {
      await processFastReconcileMissingEmbeddings();
      return;
    }
    if (job.name === 'imageFingerprintReconcile') {
      await processReconcileProductImageFingerprints();
      return;
    }
    if (job.name === 'imageFingerprintReconcileFast') {
      await processFastReconcileProductImageFingerprints();
      return;
    }
    if (job.name === 'product.imageFingerprint') {
      await processGenerateProductImageFingerprint(job.data as GenerateProductImageFingerprintJobData);
      return;
    }
    if (job.name === 'product.embedding') {
      await processGenerateProductEmbedding(job.data as GenerateProductEmbeddingJobData);
      return;
    }
    console.warn('[jobs] Unknown default job name, skipping', { name: job.name, jobId: job.id });
  },
  { connection: createWorkerConnection(), concurrency: DEFAULT_CONCURRENCY, ...redisOptimizedWorkerOptions },
);

attachWorkerFailureHandler(webhookWorker, { queueName: 'webhook' });
attachWorkerFailureHandler(aiWorker, { queueName: 'ai' });
attachWorkerFailureHandler(notificationsWorker, { queueName: 'notifications', alertOnExhaustion: false });
attachWorkerFailureHandler(finetuningWorker, { queueName: 'finetuning' });
attachWorkerFailureHandler(defaultWorker, { queueName: 'default' });

/**
 * P3-2 Step 5: publish local Worker state for `/api/health/queues` WITHOUT the health path having
 * to import this module. `queueHealthService` previously imported these five bindings directly,
 * which made `import app` construct the entire fleet (the five `new Worker(...)` above are
 * module-load side effects). The registry inverts that edge; in an API-only process it stays empty
 * and health falls back to the Redis worker count, which is the cross-process-correct signal.
 */
const LOCAL_WORKERS = [
  { key: 'webhook', worker: webhookWorker },
  { key: 'ai', worker: aiWorker },
  { key: 'notifications', worker: notificationsWorker },
  { key: 'finetuning', worker: finetuningWorker },
  { key: 'default', worker: defaultWorker },
] as const;

for (const { key, worker } of LOCAL_WORKERS) {
  registerLocalWorker(key, () => ({
    concurrency: worker.opts.concurrency ?? 1,
    isRunning: worker.isRunning(),
    isPaused: worker.isPaused(),
  }));
}

/**
 * P3-2 Step 6: one drain used by BOTH entrypoints, so `server.ts` and `worker.ts` cannot diverge
 * on shutdown semantics. `allSettled` — one worker refusing to close must not abandon the other
 * four mid-job, which is exactly how a deploy SIGKILLs an in-flight `ai.reply` (C-88).
 */
export async function closeAllWorkers(): Promise<void> {
  await Promise.allSettled(LOCAL_WORKERS.map(({ worker }) => worker.close()));
}

aiWorker.on('completed', (job) => {
  console.info('[jobs] ai completed', { jobId: job?.id });
});

finetuningWorker.on('completed', (job) => {
  console.info('[jobs] finetuning completed', { jobId: job?.id, name: job?.name });
});

defaultWorker.on('completed', (job) => {
  console.info('[jobs] default (embedding) completed', { jobId: job?.id });
});

void initPrepareFinetuningScheduler().catch((err) => {
  console.error('[jobs] Failed to register finetuning scheduler', err);
});

void initEmbeddingReconcileScheduler().catch((err) => {
  console.error('[jobs] Failed to register embedding reconciliation scheduler', err);
});

void initPauseInvariantMonitorScheduler().catch((err) => {
  console.error('[jobs] Failed to register pause invariant monitor scheduler', err);
});

void initFastEmbeddingReconcileScheduler().catch((err) => {
  console.error('[jobs] Failed to register fast embedding reconciliation scheduler', err);
});

void initImageFingerprintReconcileScheduler().catch((err) => {
  console.error('[jobs] Failed to register image fingerprint reconciliation scheduler', err);
});

void initFastImageFingerprintReconcileScheduler().catch((err) => {
  console.error('[jobs] Failed to register fast image fingerprint reconciliation scheduler', err);
});

void initRefreshMetaTokensScheduler().catch((err) => {
  console.error('[jobs] Failed to register Meta token refresh scheduler', err);
});

void initMonthlyUseCaseSnapshotScheduler().catch((err) => {
  console.error('[jobs] Failed to register monthly use case snapshot scheduler', err);
});

void initOutboxRelayScheduler().catch((err) => {
  console.error('[jobs] Failed to register outbox relay scheduler', err);
});

void initLedgerRetentionScheduler().catch((err) => {
  console.error('[jobs] Failed to register ledger retention scheduler', err);
});

void initPromptRegistryScheduler().catch((err) => {
  console.error('[jobs] Failed to register prompt registry scheduler', err);
});

void initAiCostRollupScheduler().catch((err) => {
  console.error('[jobs] Failed to register AI cost rollup scheduler', err);
});

void initVectorPartialIndexScheduler().catch((err) => {
  console.error('[jobs] Failed to register vector partial-index scheduler', err);
});

// The scheduler record lives in Redis, so turning the flag off must actively REMOVE it — otherwise
// a scheduler registered by a previous deploy keeps firing after the code stopped wanting it.
if ((process.env.DLQ_METRICS_ENABLED ?? 'false').trim().toLowerCase() === 'true') {
  void initDeadLetterMetricsScheduler().catch((err) => {
    console.error('[jobs] Failed to register dead-letter metrics scheduler', err);
  });
} else {
  void removeDeadLetterMetricsScheduler();
}
