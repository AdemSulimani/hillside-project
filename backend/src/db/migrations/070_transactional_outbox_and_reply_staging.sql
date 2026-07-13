-- P1-1 (RC-20, RC-21): the durable substrate for an idempotent post-send pipeline.
-- Additive and inert until the P1-1 flags are enabled; no existing path reads or writes
-- these tables when OUTBOX_RELAY_ENABLED / INBOUND_OUTBOX_ENQUEUE / AI_REPLY_STAGE_BEFORE_SEND
-- are off.
--
-- Two tables:
--   transactional_outbox — one row per side-effect (the ai.reply enqueue-intent, plus the
--     analytics / use-case / rate-count / alert effects that must fire exactly once). A relay
--     (jobs/outboxRelay.ts) drains it to BullMQ / performs the DB effect. Because the outbox
--     row is written in the SAME Postgres transaction as the message persist, a crash between
--     persist and enqueue can no longer silently drop the ai.reply job (RC-21).
--   ai_reply_staging — one row per logical outbound reply, staged BEFORE the channel send and
--     flipped staged→sent in the same transaction that persists the delivered messages row and
--     records the real external_message_id. On a BullMQ retry a `sent` row no-ops the send, so a
--     crash-after-send can no longer double-send, dead-letter on the global UNIQUE, or persist a
--     freshly-generated reply text that differs from what the customer saw (RC-20).

-- ---------------------------------------------------------------------------------------------
-- transactional_outbox
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactional_outbox (
  -- BIGINT identity so the relay drains in a stable, monotonic order.
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Set for ai.reply and every reply side-effect; NULL is allowed for future non-conversation
  -- topics. ON DELETE CASCADE so a deleted conversation cannot strand rows.
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  -- 'ai.reply' | 'analytics.ai_reply_sent' | 'usecase.eval' | 'reply.ratecount'
  --   | 'alert.message_send_failed' | 'alert.product_image_unavailable'
  topic           TEXT NOT NULL,
  -- Unique per logical effect; the ON CONFLICT (dedupe_key) DO NOTHING anchor that makes each
  -- side-effect exactly-once even when the producing transaction is retried.
  dedupe_key      TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'done', 'dead')),
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 10,
  -- When the row becomes eligible to drain. Carries the ai.reply debounce delay (now() +
  -- AI_REPLY_DELAY_MS) and per-effect retry backoff.
  available_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at       TIMESTAMPTZ,
  locked_by       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  last_error      TEXT
);

-- Exactly-once per logical effect.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedupe
  ON transactional_outbox (dedupe_key);

-- Drain scan: the relay claims the oldest-available not-yet-terminal rows.
CREATE INDEX IF NOT EXISTS idx_outbox_drain
  ON transactional_outbox (available_at)
  WHERE status IN ('pending', 'processing');

-- Debounce collapse + RC-21 re-check anchor: at most ONE live (undispatched) ai.reply per
-- conversation. A newer inbound within the debounce window upserts this row (resets
-- available_at, repoints the payload to the latest inbound); the inbound dedupe re-check keys
-- on its presence to decide whether a persisted-but-un-enqueued message still needs a job.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_live_ai_reply
  ON transactional_outbox (conversation_id)
  WHERE topic = 'ai.reply' AND status = 'pending';

-- ---------------------------------------------------------------------------------------------
-- ai_reply_staging
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_reply_staging (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id             UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- hash(conversationId, logicalInboundExternalId, replySlot). Stable across BullMQ attempts
  -- (keyed on the logical inbound this reply answers, not the attempt number).
  idempotency_key             TEXT NOT NULL,
  -- 'main' | 'holding:*' | 'ack:*' | 'confirm:order' | 'clarify' | 'image:<productId>'
  reply_slot                  TEXT NOT NULL,
  -- = AIReplyJobData.messageExternalId (the latest inbound external id this reply answers).
  logical_inbound_external_id TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'staged'
                                CHECK (status IN ('staged', 'sent', 'failed')),
  -- Authoritative delivered text; a retry re-sends/persists THIS, never a fresh generation.
  reply_text                  TEXT,
  attachment_urls             JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Guard outcomes needed to reproduce the persisted messages row on a resume flip
  -- (quality_score, flagged, flag_reason, product_ids, escalation flags).
  guard_verdicts              JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Recorded at the flip: real channel message id, or the deterministic null-send placeholder.
  external_message_id         TEXT,
  -- messages.id created at the flip (informational; FK-less to avoid insert-order coupling).
  message_id                  UUID,
  send_attempts               INT NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at                     TIMESTAMPTZ
);

-- ON CONFLICT (idempotency_key) DO NOTHING anchor: one staging row per (conversation, inbound,
-- slot); a retry of the same slot collides and no-ops the send.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_reply_staging_idem
  ON ai_reply_staging (idempotency_key);

-- Crash-resume reaper: find staged/failed rows whose job exhausted its BullMQ attempts.
CREATE INDEX IF NOT EXISTS idx_ai_reply_staging_open
  ON ai_reply_staging (created_at)
  WHERE status <> 'sent';
