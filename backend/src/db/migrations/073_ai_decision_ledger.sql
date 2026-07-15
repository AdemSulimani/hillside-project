-- P1-5 (RC-03, RC-17, RC-01/02, RC-04, RC-22): the append-only AI decision ledger.
-- Additive and inert until AI_DECISION_LEDGER_ENABLED is on; no existing path reads or writes
-- this table when the flag is off.
--
-- Phase 15 found all five AI-specific telemetry categories ABSENT: the assembled 26–33K-char
-- system prompt and the model/params/completion.usage of every OpenAI call are discarded the
-- instant each call returns. This ledger persists, per reply, everything the §15.2 reconstruction
-- test needs to recover an incident from the ledger ALONE: prompt provenance, model/params,
-- token usage + cost, retrieval scores/threshold outcomes/semanticSkipped, the per-classifier
-- decision chain, and the guard verdicts — with all customer text redacted at the boundary
-- (P1-6) so the ledger is not a fresh GDPR liability on an EU company.
--
-- The row is written through P1-1's transactional_outbox (topic 'ledger.write') in the SAME
-- transaction as the reply persist (via stageAndSend's onFlip), so a delivered reply and its
-- ledger row commit atomically; the relay performs the actual INSERT so a ledger-write failure
-- can never fail the reply. Early-return paths ([NO_REPLY], sensitive acks, holding messages)
-- write best-effort directly.

CREATE TABLE IF NOT EXISTS ai_decision_ledger (
  -- BIGINT identity so the table is append-only and ordered by insertion.
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Nullable for future non-conversation (system) rows. ON DELETE CASCADE so a deleted
  -- conversation cannot strand rows.
  conversation_id  UUID REFERENCES conversations(id) ON DELETE CASCADE,
  -- The delivered outbound messages.id. FK-less + nullable on purpose: the relay writes AFTER
  -- the message committed (an FK would risk a dead-letter storm on a telemetry table if the
  -- message/conversation is later deleted), and ack/[NO_REPLY] rows have no outbound message.
  message_id       UUID,
  -- Per-message correlation (= AIReplyJobData.messageExternalId, the logical inbound this reply
  -- answers) — NOT the per-webhook traceId, which burst-merge collapses across several inbounds.
  correlation_id   TEXT NOT NULL,
  -- The originating webhook's traceId when present (webhook-only today, C-109).
  trace_id         TEXT,
  -- = deriveReplyIdempotencyKey(conversationId, messageExternalId, replySlot). Stable across
  -- BullMQ retries; the ON CONFLICT DO NOTHING anchor that keeps a retry to one ledger row.
  idempotency_key  TEXT NOT NULL,
  -- 'main' | 'holding:*' | 'ack:*' | 'confirm:order' | 'clarify' | 'image:<productId>' | 'none'.
  reply_slot       TEXT NOT NULL,
  -- 'reply' | 'no_reply' | 'escalation:*' | 'ack:*' — the branch the pipeline took.
  decision_kind    TEXT NOT NULL,
  -- Prompt provenance: { hash, char_count, token_estimate, preview }. `preview` is a redacted,
  -- size-capped copy (never the full 26–33K chars). NULL on paths with no LLM reply.
  prompt           JSONB,
  -- Model & params: { requested, served, custom_model_used, temperature, max_tokens, seed,
  -- finish_reason, truncated, system_fingerprint }. NULL on paths with no LLM reply.
  model            JSONB,
  -- Token usage & cost: { prompt_tokens, completion_tokens, total_tokens, usd_cost }. NULL when
  -- completion.usage was unavailable or no LLM call was made.
  usage            JSONB,
  -- Retrieval quality: { semantic_skipped, skip_reason, threshold, core_count, band_count,
  -- sources, top: [{ id, similarity }], product_ids }.
  retrieval        JSONB,
  -- Per-classifier decision chain: [{ classifier, raw_score, threshold, boost_applied, passed,
  -- branch }] — the measurement P1-3's boost-rate needs and the §15.2 "classifier chain".
  decision_events  JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The guard outcomes carried on the staging row (knowledgeGap/price/name/uncertain escalated).
  guard_verdicts   JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The generation's declared facts_used (Phase 12 contract) so a guard strip can be re-judged
  -- against the catalog. Populated since P2-1 landed the contract; NULL when FACTS_USED_CONTRACT
  -- is off, on vision/custom-model replies (which never run the contract), and on the no-LLM
  -- early-return paths.
  facts_used       JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One ledger row per (conversation, inbound, slot); a retry collides and no-ops.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_decision_ledger_idem
  ON ai_decision_ledger (idempotency_key);

-- Per-tenant COGS / trend scans.
CREATE INDEX IF NOT EXISTS idx_ai_decision_ledger_tenant
  ON ai_decision_ledger (tenant_id, created_at);

-- Per-conversation reconstruction (the §15.2 replay walks a conversation's rows in order).
CREATE INDEX IF NOT EXISTS idx_ai_decision_ledger_conversation
  ON ai_decision_ledger (conversation_id, created_at);

-- Correlate a single reply's fan-out across the pipeline.
CREATE INDEX IF NOT EXISTS idx_ai_decision_ledger_correlation
  ON ai_decision_ledger (correlation_id);
