-- Reverse of 082 (P3-3 reversible-subset demonstrator). Nothing references
-- ai_prompt_blobs, so the drop is safe. Guarded so a partial prior state reverts
-- cleanly. Run only via `npm run migrate:down` (MIGRATE_ALLOW_DOWN=1).
DROP TABLE IF EXISTS ai_prompt_blobs;
