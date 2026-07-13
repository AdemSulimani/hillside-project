-- P1-7 (RC-09 / SEC-2): a messaging account identified by (type, external_id) must belong to
-- exactly ONE tenant. Today the only uniqueness is UNIQUE (tenant_id, type, external_id)
-- (009_create_channels.sql), so two tenants can bind the same FB page / IG account / WhatsApp
-- phone-number-id / Viber bot. The channel resolver (findChannelByTypeAndExternalId) then routes an
-- inbound — and the AI reply, decrypted token, catalog, persona, and commission — to an ARBITRARY
-- tenant. This adds the global uniqueness that makes a dual-connect impossible.
--
-- `channels` has NO soft-delete (removal is a hard DELETE, which is why 039/040 switched dependent
-- FKs to ON DELETE SET NULL), so a plain global unique index is correct: a disconnect→reconnect
-- deletes the old row first, so even a same-tenant reconnect never collides.
--
-- A blind CREATE UNIQUE INDEX would fail with a cryptic error if production already holds a
-- legitimate dual-binding. Detect first and RAISE a descriptive exception naming the offending
-- accounts so ops resolves them before enforcement (the plan's "the constraint refuses until
-- resolved"). Dev `channels` is empty (EV-038), so this applies clean there. Reversible:
--   DROP INDEX IF EXISTS idx_channels_type_external_id_global;
DO $$
DECLARE
  dup_count INTEGER;
  dup_list  TEXT;
BEGIN
  SELECT COUNT(*), string_agg(format('(%s, %s) -> %s tenants', type, external_id, cnt), '; ')
    INTO dup_count, dup_list
  FROM (
    SELECT type, external_id, COUNT(DISTINCT tenant_id) AS cnt
    FROM channels
    GROUP BY type, external_id
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'P1-7: % (type, external_id) binding(s) span multiple tenants; resolve the dual-connect(s) before enforcing global uniqueness: %',
      dup_count, dup_list;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_type_external_id_global
  ON channels (type, external_id);
