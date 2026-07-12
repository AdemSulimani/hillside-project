-- P0-5 (RC-14, RC-06): record WHY and WHEN the AI was paused so auto-resume and the
-- invariant monitor can reason about each pause. Additive and nullable — the columns are
-- unused (and always NULL) until the AI_AUTO_RESUME flag is enabled.
--   ai_paused_reason: the pause cause (e.g. 'rate_limit_exceeded'); NULL for legacy/manual
--                     pauses, which auto-resume treats as "unknown → require explicit resume".
--   ai_paused_at:     when the automated pause was set; the invariant monitor flags a
--                     conversation still paused with an inbound newer than this timestamp.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS ai_paused_at TIMESTAMPTZ;
