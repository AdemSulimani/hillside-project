-- P2-3 (RC-13): persist the last AI-recommended product ids per conversation so the
-- recommendation anchor survives PAST the 40-row history window. Completes RC-13 on top of
-- P2-2's slot store (migration 077): name/phone/address slots already exist there; this adds
-- the missing "last recommendation" anchor so a slot-backed summary can always re-inject it,
-- preventing a later-turn fail-closed classifier from denying a product the AI recommended
-- earlier (once that recommendation slid out of the AI_HISTORY_FETCH_LIMIT window).
--
-- Additive and INERT until SUMMARY_SLOT_BACKED is set: no path reads or writes this column when
-- the flag is off. Nullable, JSONB array of catalog product UUIDs (mirrors messages.product_ids);
-- no backfill (legacy rows read NULL → the summary simply omits the recommendation line).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS slot_last_recommended_product_ids JSONB;
