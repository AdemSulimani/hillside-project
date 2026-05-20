import pool from '../pool';

export interface AIConfigVersionRow {
  id: string;
  tenant_id: string;
  note: string | null;
  snapshot: Record<string, unknown>;
  created_by_email: string | null;
  created_at: Date;
}

export async function insertAIConfigVersion(input: {
  tenantId: string;
  snapshot: Record<string, unknown>;
  note?: string | null;
  createdByEmail?: string | null;
}): Promise<AIConfigVersionRow> {
  const { rows } = await pool.query<AIConfigVersionRow>(
    `INSERT INTO ai_config_versions (tenant_id, snapshot, note, created_by_email)
     VALUES ($1, $2::jsonb, $3, $4)
     RETURNING *`,
    [input.tenantId, JSON.stringify(input.snapshot), input.note ?? null, input.createdByEmail ?? null],
  );
  return rows[0];
}

export async function listAIConfigVersions(
  tenantId: string,
  limit: number,
): Promise<AIConfigVersionRow[]> {
  const { rows } = await pool.query<AIConfigVersionRow>(
    `SELECT * FROM ai_config_versions
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

export async function findAIConfigVersion(
  tenantId: string,
  versionId: string,
): Promise<AIConfigVersionRow | null> {
  const { rows } = await pool.query<AIConfigVersionRow>(
    `SELECT * FROM ai_config_versions
     WHERE tenant_id = $1 AND id = $2
     LIMIT 1`,
    [tenantId, versionId],
  );
  return rows[0] ?? null;
}
