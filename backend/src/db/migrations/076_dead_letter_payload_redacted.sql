-- P1-2 audit remediation (P1-6 / SEC-5 boundary): flag dead_letter rows whose stored payload was
-- PII-redacted at insert time. Webhook-queue payloads are the raw inbound webhook body — full
-- customer message text/names/phones — so persisting them verbatim bypassed the P1-6 redaction
-- boundary. The failure handler now masks those payloads (utils/redact.ts) before the durable
-- insert; the other queues' payloads carry only ids and are stored as-is. `true` means the original
-- content is gone, so the admin replay endpoint refuses these rows (no force override).
ALTER TABLE dead_letter
  ADD COLUMN IF NOT EXISTS payload_redacted BOOLEAN NOT NULL DEFAULT false;
