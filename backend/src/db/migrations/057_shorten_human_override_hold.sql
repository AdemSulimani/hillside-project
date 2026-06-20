-- Human hold is now auto-released after a short window (default 10 minutes) instead of
-- 24 hours. Clamp holds created under the old rule so existing conversations are not
-- stuck with AI silenced for up to a day.
UPDATE conversations
SET human_override_until = LEAST(human_override_until, NOW() + INTERVAL '10 minutes'),
    updated_at = NOW()
WHERE human_override_until IS NOT NULL
  AND human_override_until > NOW() + INTERVAL '10 minutes';
