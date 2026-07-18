-- P2-4 (audit F2): content-addressed store for the FULL (PII-redacted) assembled system prompt,
-- closing the §15.2 "recover the prompt from the ledger alone" residue: the ledger row keeps a
-- 12K-char preview, and its prompt.system_hash now joins to the complete text here.
--
-- Content-addressed (hash PK) so the 26-33K-char blob is stored ONCE per distinct prompt, not per
-- reply: prompts repeat heavily within a tenant (same persona/blocks/footer; only the injected
-- product context varies), so dedup is the difference between megabytes and gigabytes.
--
-- tenant_id is NOT part of the key but is retained for GDPR scoping (delete a tenant => delete
-- its blobs) and is the FIRST tenant to have produced the blob. Rows are pruned by the same
-- retention sweep as the ledger (LEDGER_RETENTION_DAYS), keyed on last_seen so a still-active
-- prompt is never pruned out from under recent ledger rows.
--
-- Written best-effort behind LEDGER_PROMPT_BLOBS (default off); inert until enabled.

CREATE TABLE IF NOT EXISTS ai_prompt_blobs (
  hash TEXT PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_prompt_blobs_last_seen ON ai_prompt_blobs (last_seen);
CREATE INDEX IF NOT EXISTS idx_ai_prompt_blobs_tenant ON ai_prompt_blobs (tenant_id);
