-- P2-4 Part 2 (RC-06 + RC-17): record the enablement/config state captured at RECEIPT alongside
-- the live state the gates actually read, so a message whose outcome flipped on a mid-window
-- toggle leaves an artifact.
--
-- RC-06's defect is NOT merely "gates are read ≥8s late" — it is that a toggle flip in the
-- receipt→run window "changes an already-received message's outcome class with no artifact that a
-- received message was discarded". The whole gate ladder in processAIReply is `console.info` +
-- bare `return`; the earliest ledger write sits ~500 lines below it, so every gate-drop is
-- currently invisible. This column is where that artifact lands.
--
-- Deliberately RECORD-ONLY: the live reads keep governing. RC-06's own regression-prevention text
-- offers "evaluate against the snapshot (or record it)", and the record option is the only safe
-- one here — snapshot-GOVERNING the gates would blind a merchant's kill switch (toggleAiPaused
-- writes no message row, so the pre-send human-takeover check cannot backstop it), dead-code the
-- P0-5/RC-14 rate-limit auto-resume (nested inside the live `if (conversation.ai_paused)`), and
-- re-introduce exactly the ai_config staleness P2-3 removed (C-55).
--
-- Additive and INERT until RECEIPT_TIME_SNAPSHOT is set: no path writes this column when the flag
-- is off. Nullable JSONB, no backfill (legacy rows read NULL → reconstruction simply reports the
-- snapshot as unavailable for that turn). Scalars only (booleans, epoch numbers, one timestamp) —
-- carries no customer PII, so the P1-6 redaction pass passes it through explicitly.
ALTER TABLE ai_decision_ledger
  ADD COLUMN IF NOT EXISTS receipt_snapshot JSONB;

-- P2-4 Part 2: retention. The ledger writes a row per reply carrying a size-capped prompt preview
-- derived from a 26–33K-char system prompt, and had no prune path at all — unbounded growth of
-- customer-derived telemetry on an EU-registered company's database (P2-4's own listed edge case:
-- "Retention/sampling + GDPR"). `pruneLedger` (see db/models/aiDecisionLedger.ts) deletes by
-- created_at; this index keeps that DELETE from seq-scanning the table.
--
-- idx_ai_decision_ledger_tenant is (tenant_id, created_at) — leading-column mismatch makes it
-- useless for a tenant-agnostic retention sweep, hence a dedicated created_at index.
CREATE INDEX IF NOT EXISTS idx_ai_decision_ledger_created_at
  ON ai_decision_ledger (created_at);
