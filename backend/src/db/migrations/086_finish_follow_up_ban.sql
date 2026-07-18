-- Migration 086 (P3-5, RC-26 / C-04 + C-05): finish migration 067 — remove the last two
-- instructions that still MANDATE a follow-up invitation.
--
-- Migration 067 removed the one permitted order-closing follow-up and stated the resulting policy
-- in its own header: product explanations, recommendations, comparisons, price/stock answers and
-- unavailable-product replies "all end immediately after delivering the answer — no follow-up
-- question of any kind. The ONLY remaining permitted follow-up is the order-confirmation
-- sentence." It updated `guidelines.follow_up_and_closing` and MISSED two sites that instruct the
-- model to produce exactly what it banned:
--
--   guidelines.catalog_integrity      "...say you have shown all available options and INVITE THEM
--                                      TO ASK about something specific."            <- C-05
--   guidelines.vision_product_images  Response C: "Tell the customer honestly and ASK IF THEY ARE
--                                      LOOKING FOR something specific..."           <- C-04
--
-- Same shape as C-03/migration 080: a policy migration that updated some sites and missed others.
--
-- THIS IS NOT A CHOICE BETWEEN TWO DEFENSIBLE POSITIONS. Three independent things already settle
-- the direction, which is why these two sites are corrected rather than the ban being relaxed:
--   1. Migration 067's header states the intended end-state in as many words (quoted above).
--   2. `guidelines.follow_up_and_closing` bans invitations in "ALL OTHER CASES", listing
--      "feel free to ask" and "më tregoni" among forbidden trailing patterns "in any language".
--   3. The CODE enforces it deterministically: `stripGenericFollowUpInvitation(finalReplyText,
--      !isOrderConfirmationReply)` (processAIReply.ts) runs on EVERY non-order-confirmation reply.
--      So the model is currently instructed to generate text the pipeline then deletes — wasted
--      tokens on every no-match turn, and an instruction that can never be satisfied.
--
-- `guidelines.catalog_integrity` additionally contradicted ITSELF: three bullets above the invite
-- instruction it already says "end the reply right after the alternatives with no follow-up
-- question". This makes the block internally consistent as well.
--
-- Verified before writing (dev DB): all 6 tenant copies of both blocks are byte-identical to their
-- catalog default (the registry from migration 084 holds exactly ONE version per key), so neither
-- string can be an operator's deliberate customization.
--
-- Surgical `replace()` rather than pasting the blocks wholesale — the 080 pattern: it preserves
-- the stored CRLF line endings exactly, touches only the offending clause, and is idempotent (a
-- no-op once applied, or if the text has drifted). Flag-independent: the prompt should not
-- contradict itself regardless of any feature flag.
--
-- NO PAIRED .down.sql — a prompt/data change. Its inverse is the previous content, which now
-- lives in `prompt_block_versions` (migration 084). To revert: re-apply the version whose
-- `content` still carries the invite clause.

-- ---------------------------------------------------------------------------
-- 1. guidelines.catalog_integrity (PLATFORM-LOCKED) — catalog default.
-- ---------------------------------------------------------------------------
UPDATE prompt_blocks
SET
  default_content = replace(
    default_content,
    'say you have shown all available options and invite them to ask about something specific.',
    'say you have shown all available options and end the reply there.'
  ),
  updated_at = now()
WHERE key = 'guidelines.catalog_integrity'
  AND default_content LIKE '%invite them to ask about something specific%';

-- Force-sync every tenant copy — the unconditional pattern for locked blocks (052/062/065/066/080).
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key              = 'guidelines.catalog_integrity'
  AND tpb.prompt_block_id = pb.id
  AND pb.is_platform_locked = true
  AND tpb.content IS DISTINCT FROM pb.default_content;

-- ---------------------------------------------------------------------------
-- 2. guidelines.vision_product_images (NOT locked) — catalog default.
-- ---------------------------------------------------------------------------
UPDATE prompt_blocks
SET
  default_content = replace(
    default_content,
    'Tell the customer honestly and ask if they are looking for something specific you might be able to help with.',
    'Tell the customer honestly and end the reply there.'
  ),
  updated_at = now()
WHERE key = 'guidelines.vision_product_images'
  AND default_content LIKE '%ask if they are looking for something specific%';

-- Tenant copies of the NON-locked block get the same SURGICAL replace, never a force-sync: a
-- force-sync would clobber a legitimate operator customization elsewhere in the block. A surgical
-- replace also avoids the failure mode migration 052 exists to repair — an exact-full-content
-- match silently missing any tenant whose copy drifted in an unrelated place.
UPDATE tenant_prompt_blocks
SET
  content    = replace(
    content,
    'Tell the customer honestly and ask if they are looking for something specific you might be able to help with.',
    'Tell the customer honestly and end the reply there.'
  ),
  updated_at = now()
WHERE block_key = 'guidelines.vision_product_images'
  AND content LIKE '%ask if they are looking for something specific%';

-- ---------------------------------------------------------------------------
-- 3. Register the NEW content in the P3-5 registry.
--
-- Done here rather than left to the reconcile sweep so the registry is complete regardless of
-- whether PROMPT_BLOCK_REGISTRY is enabled — the sweep no-ops when the flag is off, and a prompt
-- change that nothing recorded is exactly the gap 084 exists to close. `convert_to(…,'UTF8')` for
-- the same reason as 084: pgcrypto hashes in the server encoding, the runtime hashes UTF-8.
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
WHERE b.key IN ('guidelines.catalog_integrity', 'guidelines.vision_product_images')
ON CONFLICT (block_key, content_hash) DO NOTHING;
