-- Migration 089 (brand audit C3): stop training an unverified "Yes." for brand questions.
--
-- Migration 061's `guidelines.messaging_style` block contains, among the brevity examples:
--
--     - "Do you have this brand?" -> "Yes."
--
-- and the rule "Do NOT restate the product or brand name the customer just referenced".
--
-- The 2026-08-01 brand audit (BRAND_RECOGNITION_AUDIT.md §10) found this pair is the
-- platform's ONLY always-on brand instruction, and it trains exactly the failure mode the
-- brand-membership lane exists to prevent: a bare "Yes." to "do you have brand X?" with
-- nothing downstream verifying it, and with the brand name (the actual answer) forbidden
-- from the reply. The runtime mirror of this rule (SHORTEST_ANSWER_APPEND in
-- productDescriptionPromptService.ts) was corrected in code in the same change-set; this
-- migration brings the seeded block to parity so tenant copies stop contradicting it.
--
-- Surgical `replace()` — the 080/086 pattern: preserves stored line endings, touches only
-- the offending clauses, idempotent (no-op once applied or if the text drifted).
-- Verified before writing (dev DB): the default and all 6 tenant copies carry the exact
-- target strings and every tenant copy is byte-identical to the catalog default, so no
-- string here can be an operator's deliberate customization.
--
-- NO PAIRED .down.sql — a prompt/data change. Its inverse is the previous content, which
-- lives in `prompt_block_versions` (migration 084).

-- ---------------------------------------------------------------------------
-- 1. Catalog default: the brand example must require catalog grounding and name the brand.
-- ---------------------------------------------------------------------------
UPDATE prompt_blocks
SET
  default_content = replace(
    default_content,
    '- "Do you have this brand?" -> "Yes."',
    '- "Do you have this brand?" -> "Yes, we carry [Brand]." (only when the catalog or the brand-availability verdict confirms it; a brand question must never get a bare unverified "Yes.")'
  ),
  updated_at = now()
WHERE key = 'guidelines.messaging_style'
  AND default_content LIKE '%- "Do you have this brand?" -> "Yes."%';

UPDATE prompt_blocks
SET
  default_content = replace(
    default_content,
    'Do NOT restate the product or brand name the customer just referenced',
    'Do NOT restate the product name the customer just referenced (a brand-availability answer may name the brand - that is the answer, not filler)'
  ),
  updated_at = now()
WHERE key = 'guidelines.messaging_style'
  AND default_content LIKE '%Do NOT restate the product or brand name the customer just referenced%';

-- ---------------------------------------------------------------------------
-- 2. Tenant copies of the NON-locked block: the same SURGICAL replaces, never a
--    force-sync (086's rationale: a force-sync would clobber a legitimate operator
--    customization elsewhere in the block).
-- ---------------------------------------------------------------------------
UPDATE tenant_prompt_blocks
SET
  content    = replace(
    content,
    '- "Do you have this brand?" -> "Yes."',
    '- "Do you have this brand?" -> "Yes, we carry [Brand]." (only when the catalog or the brand-availability verdict confirms it; a brand question must never get a bare unverified "Yes.")'
  ),
  updated_at = now()
WHERE block_key = 'guidelines.messaging_style'
  AND content LIKE '%- "Do you have this brand?" -> "Yes."%';

UPDATE tenant_prompt_blocks
SET
  content    = replace(
    content,
    'Do NOT restate the product or brand name the customer just referenced',
    'Do NOT restate the product name the customer just referenced (a brand-availability answer may name the brand - that is the answer, not filler)'
  ),
  updated_at = now()
WHERE block_key = 'guidelines.messaging_style'
  AND content LIKE '%Do NOT restate the product or brand name the customer just referenced%';

-- ---------------------------------------------------------------------------
-- 3. Register the NEW content in the P3-5 registry (086 idiom): done here rather than
--    left to the reconcile sweep so the registry is complete regardless of whether
--    PROMPT_BLOCK_REGISTRY is enabled. `convert_to(…,'UTF8')` because pgcrypto hashes in
--    the server encoding while the runtime hashes UTF-8.
-- ---------------------------------------------------------------------------
INSERT INTO prompt_block_versions
  (block_key, content_hash, version, content, char_count, source)
SELECT
  b.key,
  encode(digest(convert_to(b.default_content, 'UTF8'), 'sha256'), 'hex'),
  COALESCE(
    (SELECT max(version) FROM prompt_block_versions v WHERE v.block_key = b.key),
    0
  ) + 1,
  b.default_content,
  length(b.default_content),
  'migration'
FROM prompt_blocks b
WHERE b.key = 'guidelines.messaging_style'
ON CONFLICT (block_key, content_hash) DO NOTHING;
