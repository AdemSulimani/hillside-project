-- P2-2 (RC-07, RC-08, RC-22, RC-10): deterministic order_stage FSM + slot store on conversations.
--
-- Replaces three per-turn LLM order-classifiers (classifyNewOrderSignal ×2/job,
-- detectOrderAffirmationIntent ×2/job, and the ~40-call hasAssistantAskedOrderClosingInConversation
-- LLM-in-a-loop) with a persisted deterministic stage machine + slot cache. Because the consent
-- path becomes a stage-gated lexicon check with NO confidence field, RC-07's boost asymmetry and
-- RC-22's 7-conjunct boundary flip vanish by construction.
--
-- Additive and INERT until ORDER_STAGE_MACHINE is set (shadow/on): no existing path reads these
-- columns when the flag is off. Every column is nullable/defaulted so legacy rows read as
-- 'browsing' with no backfill (the reader coalesces NULL -> 'browsing'; a one-time deterministic
-- regex seed reconstructs mid-flow conversations lazily on first read — see orderStageMachine.ts).
ALTER TABLE conversations
  -- FSM state. NULL is interpreted as 'browsing' by the reader (normalizeStage).
  ADD COLUMN IF NOT EXISTS order_stage TEXT
    CHECK (order_stage IN ('browsing', 'collecting', 'awaiting_confirmation', 'confirmed')),
  ADD COLUMN IF NOT EXISTS order_stage_updated_at TIMESTAMPTZ,

  -- Sticky monotone (false -> true) assistant-event markers, set when the ASSISTANT emits the
  -- message. data_confirmation_sent replaces the per-job hasAssistantAskedDataConfirmation regex
  -- rescan; order_closing_asked replaces the ~40-call order-closing LLM loop.
  ADD COLUMN IF NOT EXISTS data_confirmation_sent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS order_closing_asked BOOLEAN NOT NULL DEFAULT FALSE,

  -- RC-22 commission anchor: WHEN the consent that authorized the order landed (an immutable
  -- ordered-message timestamp used instead of NOW() in the commission-window query), and the
  -- logical inbound external id that advanced the stage (retry-idempotency anchor so a retry of
  -- the SAME consent inbound cannot re-arm/oscillate the stage).
  ADD COLUMN IF NOT EXISTS order_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS order_consent_inbound_id TEXT,

  -- Slot cache (also feeds RC-13 memory / P2-3). Writers COALESCE-keep: never overwrite a known
  -- value with NULL.
  ADD COLUMN IF NOT EXISTS slot_customer_name TEXT,
  ADD COLUMN IF NOT EXISTS slot_customer_phone TEXT,
  ADD COLUMN IF NOT EXISTS slot_delivery_address TEXT,

  -- RC-10 sticky reply locale + last-resolution timestamp (hysteresis anchor for a genuine switch).
  ADD COLUMN IF NOT EXISTS reply_locale TEXT CHECK (reply_locale IN ('sq', 'en')),
  ADD COLUMN IF NOT EXISTS reply_locale_updated_at TIMESTAMPTZ;
