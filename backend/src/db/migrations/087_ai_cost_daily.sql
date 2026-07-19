-- P3-6 (RC-17/RC-03): per-tenant/per-day COGS rollup.
--
-- WHY A TABLE AND NOT JUST A QUERY OVER THE LEDGER. `ai_decision_ledger` already carries every
-- call's model + tokens + USD cost (P1-5), and migration 073 even ships an index commented
-- "Per-tenant COGS / trend scans". But `services/ledgerRetention.ts` DELETES ledger rows older
-- than LEDGER_RETENTION_DAYS (default 90) — a GDPR obligation, since a ledger row carries a
-- redacted preview derived from customer conversation text. So a live query answers "what did
-- last month cost" and permanently cannot answer "what did last year cost". The rollup holds
-- counters only — model ids and integers, zero customer-derived content — so it is free of that
-- obligation and is retained far longer (AI_COST_ROLLUP_RETENTION_DAYS, default 730).
--
-- GRAIN: (tenant_id, day, role, model, kind). `role` is the P3-6 model-role attribution
-- ('chat' | 'classifier' | 'vision' | 'eval' | 'intent' | 'product_processing' | 'embedding')
-- plus the honest bucket 'unattributed' — used when a call's role could not be determined,
-- because in the default config every chat-family role resolves to the same model id. That
-- bucket is surfaced in the admin panel deliberately: "we could not tell" must never be allowed
-- to read as "that part was free".
--
-- `source` distinguishes reply-turn spend (folded from the ledger) from background-job spend
-- (product imports, image fingerprinting) which never reaches the ledger at all — the ledger is
-- reply-scoped and its NOT NULL decision_kind/reply_slot columns do not describe an import.
--
-- Transaction-safe: plain CREATE TABLE/INDEX, so it rides the runner's single batch transaction.

CREATE TABLE IF NOT EXISTS ai_cost_daily (
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day               DATE NOT NULL,
  role              TEXT NOT NULL,
  model             TEXT NOT NULL,
  kind              TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'reply',

  calls             BIGINT        NOT NULL DEFAULT 0,
  -- Calls whose model had a price entry. `priced_calls < calls` is the unpriced-model canary:
  -- it is how "OpenAI shipped a new model id" surfaces as a VISIBLE measurement gap rather than
  -- a quietly shrinking cost number. Surfaced in the admin panel, never swallowed.
  priced_calls      BIGINT        NOT NULL DEFAULT 0,
  prompt_tokens     BIGINT        NOT NULL DEFAULT 0,
  cached_tokens     BIGINT        NOT NULL DEFAULT 0,
  completion_tokens BIGINT        NOT NULL DEFAULT 0,
  usd_cost          NUMERIC(14,6) NOT NULL DEFAULT 0,

  -- Turn/conversation counters are recorded on the fold, not summed later: COUNT(DISTINCT
  -- conversation_id) is not additive across partial sweeps, which is why the sweep RECOMPUTES a
  -- whole (tenant_id, day) partition rather than incrementing it.
  turns             BIGINT        NOT NULL DEFAULT 0,
  conversations     BIGINT        NOT NULL DEFAULT 0,

  computed_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- Set once a day is old enough that the ledger rows behind it may have been pruned. A sealed
  -- day is NEVER recomputed: re-folding a day whose source rows are half-deleted would silently
  -- SHRINK a historical number, which is the exact failure this table exists to prevent, and it
  -- would fail in the direction that looks like a cost improvement.
  sealed_at         TIMESTAMPTZ,

  PRIMARY KEY (tenant_id, day, role, model, kind, source)
);

-- Fleet-wide "what did the platform spend on day X" + the retention prune's scan key.
CREATE INDEX IF NOT EXISTS idx_ai_cost_daily_day ON ai_cost_daily (day);
