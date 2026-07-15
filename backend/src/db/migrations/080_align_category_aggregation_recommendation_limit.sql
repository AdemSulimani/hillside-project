-- Migration 080 (P2-5, RC-26 / C-03): finish migration 066 — align the last block that
-- still caps product recommendations at 1-2.
--
-- Migration 066 raised the recommendation / unavailable-product-alternative cap from 1-2 to
-- 2-3 and stated it applied "across every place the rule is enforced". It updated two blocks
-- (guidelines.recommendations, guidelines.catalog_integrity) and MISSED a third:
-- guidelines.category_product_aggregation (added later, by migration 049), which still says
-- 1-2 in two places. The audit recorded the result as a four-way conflict (C-03):
--
--   business.md                                1-2   (a repo file no code reads; updated by P2-5)
--   ai_configs.restrictions ("një alternativë")  1   (operator-owned data on 1 tenant; left alone)
--   guidelines.catalog_integrity               2-3   (migration 066 — shipped, live in 6/6)
--   guidelines.recommendations                 2-3   (migration 066 — shipped, live in 6/6)
--   guidelines.category_product_aggregation    1-2   <- the 066 miss, fixed here
--
-- 2-3 is canonical: it is the only decided-and-shipped value. This block is ALSO
-- platform-locked, so its 1-2 cannot be an operator's deliberate choice — it is unambiguously
-- an oversight, which is why it is corrected rather than treated as a customization.
--
-- Verified before writing (dev DB): all 6 tenant copies are byte-identical to the catalog
-- default and all 6 carry both 1-2 occurrences.
--
-- NOTE: this migration is flag-independent — the counts should agree regardless of any P2-5
-- feature flag, so it is not gated. Revert = a new migration (081).
--
-- Surgical `replace()` rather than pasting the block wholesale: it preserves the stored CRLF
-- line endings exactly, touches only the two counts, and is idempotent (a no-op once applied
-- or if the text has drifted).

-- ---------------------------------------------------------------------------
-- 1. Catalog default — both 1-2 occurrences.
--    (a) "you may still suggest 1-2 options"          — recommending from a group
--    (b) "immediately suggest 1-2 relevant alternatives" — product-not-in-catalog
--    The "never more than three" wording mirrors guidelines.catalog_integrity (migration 066).
-- ---------------------------------------------------------------------------
UPDATE prompt_blocks
SET
  default_content = replace(
    replace(
      default_content,
      'you may still suggest 1-2 options',
      'you may still suggest up to 2-3 options (never more than three)'
    ),
    'immediately suggest 1-2 relevant alternatives',
    'immediately suggest up to 2-3 relevant alternatives (never more than three)'
  ),
  updated_at = now()
WHERE key = 'guidelines.category_product_aggregation'
  AND (
    default_content LIKE '%you may still suggest 1-2 options%'
    OR default_content LIKE '%immediately suggest 1-2 relevant alternatives%'
  );

-- ---------------------------------------------------------------------------
-- 2. Force-sync all tenant copies of this platform-locked block — the same
--    unconditional pattern migrations 052/062/065/066 use for locked blocks.
-- ---------------------------------------------------------------------------
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key              = 'guidelines.category_product_aggregation'
  AND tpb.prompt_block_id = pb.id
  AND pb.is_platform_locked = true
  AND tpb.content IS DISTINCT FROM pb.default_content;
