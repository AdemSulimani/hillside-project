import pool from '../pool';

export interface Contact {
  id: string;
  tenant_id: string;
  channel_id: string;
  external_id: string;
  name: string;
  avatar_url: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertContactInput {
  tenant_id: string;
  channel_id: string;
  external_id: string;
  name: string;
  avatar_url?: string | null;
  metadata?: Record<string, unknown>;
}

export async function upsertContact(input: UpsertContactInput): Promise<Contact> {
  const { rows } = await pool.query<Contact>(
    `INSERT INTO contacts (tenant_id, channel_id, external_id, name, avatar_url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (tenant_id, channel_id, external_id)
     DO UPDATE SET
       name = EXCLUDED.name,
       avatar_url = EXCLUDED.avatar_url,
       metadata = EXCLUDED.metadata,
       updated_at = now()
     RETURNING *`,
    [
      input.tenant_id,
      input.channel_id,
      input.external_id,
      input.name,
      input.avatar_url ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  return rows[0];
}
