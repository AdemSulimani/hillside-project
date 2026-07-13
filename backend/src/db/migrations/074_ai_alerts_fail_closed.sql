-- P1-5 (RC-01/02/19): distinguish a genuine escalation from a fail-closed degradation on every
-- ai_alerts row. Phase 15 §15.2: an on-call engineer cannot currently tell whether a guard fired
-- because it truly found a problem or because a transient error routed it down the safe
-- (fail-closed) escalation path (P0-4's escalateSensitivePathOnDetectorError, or the post-send
-- order_detection_failed catch). `false` = genuine positive classification; `true` = escalated
-- because the detector could not actually decide.
ALTER TABLE ai_alerts
  ADD COLUMN IF NOT EXISTS fail_closed BOOLEAN NOT NULL DEFAULT false;
