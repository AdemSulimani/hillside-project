-- P1-2 (RC-20/21/18): durable dead-letter store for exhausted / terminally-failed BullMQ jobs.
--
-- The queue layer previously had no DLQ: an exhausted (or SIGKILL-stalled) job left only a
-- console.error and a row in the per-queue failed set. This table gives every dead-lettered job a
-- durable, queryable, replayable record (reason/error/attempts/traceId/tenant_id + full payload).
--
-- Additive and inert until DLQ_ENABLED. tenant_id is NULLABLE — embedding / meta-token-refresh jobs
-- carry no tenant. conversation_id is intentionally FK-less so forensic rows survive conversation
-- churn (a deleted conversation should not erase the record of a job that failed on it).
-- Runs inside the migration runner's single per-file transaction, so no CREATE INDEX CONCURRENTLY.

CREATE TABLE IF NOT EXISTS dead_letter (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue_name      TEXT NOT NULL,
  job_id          TEXT NOT NULL,                 -- BullMQ ids may be custom strings (e.g. outbox-ai-reply-123)
  job_name        TEXT,
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE,   -- NULLABLE by design
  conversation_id UUID,                          -- FK-less on purpose (forensic retention)
  trace_id        TEXT,
  classification  TEXT NOT NULL CHECK (classification IN ('transient', 'terminal', 'stalled')),
  reason          TEXT NOT NULL,
  error           TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'replayed', 'ignored')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  replayed_at     TIMESTAMPTZ
);

-- Exactly-one row per (queue, job): the ON CONFLICT DO NOTHING dedupe anchor. The failed listener
-- fires per attempt, so this keeps a single dead_letter row (and a single alert) per dead job.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dead_letter_queue_job ON dead_letter (queue_name, job_id);

-- Backlog gauge + retention prune scans.
CREATE INDEX IF NOT EXISTS idx_dead_letter_status_created ON dead_letter (status, created_at);

-- Per-tenant forensic lookups.
CREATE INDEX IF NOT EXISTS idx_dead_letter_tenant ON dead_letter (tenant_id) WHERE tenant_id IS NOT NULL;
