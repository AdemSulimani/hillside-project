export interface QueueCountsSnapshot {
  waiting: number;
  active: number;
  delayed: number;
  paused: number;
  completed: number;
  failed: number;
}

export interface WorkerStatusSnapshot {
  /**
   * Concurrency of the Worker in the process that served this request, or `null` when workers run
   * out-of-process (P3-2). Not a failure — an API-only replica cannot know another process's
   * concurrency, and `redisWorkersCount` is the cross-process liveness signal.
   */
  concurrency: number | null;
  isRunning: boolean;
  isPaused: boolean;
  /** Workers registered in Redis for this queue, from any host. */
  redisWorkersCount: number;
  /** Whether the Worker lives in the process that served this request. */
  inProcess: boolean;
}

export interface SingleQueueHealth {
  key: string;
  label: string;
  counts: QueueCountsSnapshot;
  depth: number;
  worker: WorkerStatusSnapshot;
  healthy: boolean;
  issues: string[];
}

export interface QueuesHealthPayload {
  queues: SingleQueueHealth[];
  depthWarningThreshold: number;
  overallHealthy: boolean;
  overallDegraded: boolean;
}
