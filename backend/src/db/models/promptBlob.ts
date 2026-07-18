/**
 * P2-4 (audit F2): the content-addressed prompt blob store (migration 082). The ledger row's
 * `prompt.system_hash` joins here to recover the FULL redacted system prompt — the §15.2
 * reconstruction residue the 12K preview could not close.
 */
import pool from '../pool';

/**
 * Insert-or-touch a prompt blob. Content-addressed: an existing hash only bumps `last_seen`
 * (which is what keeps the retention sweep from pruning a blob still referenced by fresh ledger
 * rows). Best-effort by contract — callers fire-and-forget; a blob write must never affect a
 * reply.
 */
export async function upsertPromptBlob(
  hash: string,
  tenantId: string,
  content: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO ai_prompt_blobs (hash, tenant_id, content, char_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (hash) DO UPDATE SET last_seen = now()`,
    [hash, tenantId, content, content.length],
  );
}

/** Delete blobs unseen for longer than the retention window. Returns rows deleted this batch. */
export async function prunePromptBlobs(retentionDays: number, batchSize: number): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM ai_prompt_blobs WHERE hash IN (
       SELECT hash FROM ai_prompt_blobs
       WHERE last_seen < now() - ($1 || ' days')::interval
       LIMIT $2
     )`,
    [String(retentionDays), batchSize],
  );
  return rowCount ?? 0;
}
