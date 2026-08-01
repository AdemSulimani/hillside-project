-- Migration 090 (brand audit C3): platform-lock `guidelines.vision_product_images`.
--
-- This block carries the platform's brand-accuracy policy for customer photos ("A match is
-- only valid if the brand name AND product type match. A different brand of the same product
-- type is NOT a match... Brand accuracy matters.") plus the honest-denial ladder (Response
-- A/B/C) and the competitor-brand rule. The 2026-08-01 brand audit (§10) found it was the
-- only accuracy-critical platform policy block left tenant-editable: a tenant edit silently
-- overrides brand policy, and unlike `guidelines.catalog_integrity` (locked by migration 063)
-- nothing re-asserts it. Locking makes the runtime force-sync
-- (`forceSyncLockedBlocksForTenant`) own tenant copies from now on, exactly like
-- catalog_integrity.
--
-- Verified before writing (dev DB): all 6 tenant copies are byte-identical to the catalog
-- default, so the propagation below cannot clobber an operator customization. On any
-- environment where a copy HAS drifted, locking is still the intended policy decision — brand
-- accuracy is a platform guarantee, not a tenant preference (BRAND_RECOGNITION_AUDIT.md §13
-- flags this as an approved behavior change).
--
-- Data-only migration; idempotent. NO PAIRED .down.sql — to unlock, ship a new migration.

UPDATE prompt_blocks
SET
  is_platform_locked = true,
  updated_at         = now()
WHERE key = 'guidelines.vision_product_images'
  AND is_platform_locked = false;

-- Propagate the catalog default to every tenant copy of the now-locked block (063 pattern).
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE tpb.block_key = pb.key
  AND pb.key        = 'guidelines.vision_product_images'
  AND pb.is_platform_locked = true
  AND tpb.content IS DISTINCT FROM pb.default_content;
