export interface QueueCountsSnapshot {
  waiting: number;
  active: number;
  delayed: number;
  paused: number;
  completed: number;
  failed: number;
}

export interface WorkerStatusSnapshot {
  concurrency: number;
  isRunning: boolean;
  isPaused: boolean;
  redisWorkersCount: number;
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
