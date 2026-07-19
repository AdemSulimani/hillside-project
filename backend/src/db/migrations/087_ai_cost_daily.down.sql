-- Down for 087. A new, self-contained table with no other object depending on it is cleanly
-- reversible, so it gets a paired down file (CLAUDE.md §11 rule 5).
--
-- This is not bookkeeping. `runDown` reverts from the TOP of the stack and refuses the whole
-- range if any file in it lacks a paired down — so an irreversible migration at the tip
-- permanently blocks reverting everything beneath it. 085 and 086 are data migrations and
-- correctly have no down file, which means the reversible tip is currently zero; 087 restores it.

DROP INDEX IF EXISTS idx_ai_cost_daily_day;
DROP TABLE IF EXISTS ai_cost_daily;
