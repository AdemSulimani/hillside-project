-- Migration 062: Persist the products the AI identified/recommended on each message.
--
-- Problem fixed:
--   Multi-turn product context was lost on follow-up questions. When a customer asked
--   for (e.g.) weight-gain products and the AI recommended Product A and B, a follow-up
--   like "what are the prices?" / "sa kushtojn kto" re-ran retrieval from scratch. When
--   that lookup failed (anchor extraction picking the follow-up itself, catalog-name vs
--   AI-phrasing mismatch, embedding gaps, semantic timeout), the AI incorrectly replied
--   that the products it had just recommended were "not in the catalog".
--
-- Root cause:
--   There was NO durable record of which products were resolved for a turn. Every
--   follow-up re-derived products from raw message text, which is inherently fragile.
--
-- Fix:
--   Store the resolved product IDs on the outbound AI message (`product_ids`). Follow-up
--   turns can then deterministically reuse the products the AI already identified instead
--   of relying on a fresh text lookup that can fail. The column is a JSONB array of UUID
--   strings to match the existing `attachment_urls` / `tags` JSONB conventions and to
--   tolerate products that are later deleted (we filter to active products at read time).

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS product_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Backfill any pre-existing NULLs (defensive; the DEFAULT covers new rows).
UPDATE messages SET product_ids = '[]'::jsonb WHERE product_ids IS NULL;
