import pool from '../pool';

export type ChannelType = 'facebook' | 'instagram' | 'whatsapp';

export interface Channel {
  id: string;
  tenant_id: string;
  type: ChannelType;
  name: string;
  external_id: string;
  access_token_encrypted: string;
  webhook_verified: boolean;
  ai_enabled: boolean;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateChannelInput {
  tenant_id: string;
  type: ChannelType;
  name: string;
  external_id: string;
  access_token_encrypted: string;
  webhook_verified?: boolean;
  ai_enabled?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateChannelInput {
  name?: string;
  access_token_encrypted?: string;
  webhook_verified?: boolean;
  ai_enabled?: boolean;
  metadata?: Record<string, unknown> | null;
}

export async function createChannel(input: CreateChannelInput): Promise<Channel> {
  const { rows } = await pool.query<Channel>(
    `INSERT INTO channels (tenant_id, type, name, external_id, access_token_encrypted, webhook_verified, ai_enabled, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING *`,
    [
      input.tenant_id,
      input.type,
      input.name,
      input.external_id,
      input.access_token_encrypted,
      input.webhook_verified ?? false,
      input.ai_enabled ?? true,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );

  return rows[0];
}

export async function findChannelsByTenant(tenantId: string): Promise<Channel[]> {
  const { rows } = await pool.query<Channel>(
    'SELECT * FROM channels WHERE tenant_id = $1 ORDER BY created_at DESC',
    [tenantId],
  );
  return rows;
}

export async function findChannelByExternalId(
  tenantId: string,
  type: ChannelType,
  externalId: string,
): Promise<Channel | null> {
  const { rows } = await pool.query<Channel>(
    'SELECT * FROM channels WHERE tenant_id = $1 AND type = $2 AND external_id = $3 LIMIT 1',
    [tenantId, type, externalId],
  );
  return rows[0] ?? null;
}

export async function findChannelByTypeAndExternalId(
  type: ChannelType,
  externalId: string,
): Promise<Channel | null> {
  const { rows } = await pool.query<Channel>(
    'SELECT * FROM channels WHERE type = $1 AND external_id = $2 LIMIT 1',
    [type, externalId],
  );
  return rows[0] ?? null;
}

export async function findChannelById(id: string, tenantId: string): Promise<Channel | null> {
  const { rows } = await pool.query<Channel>(
    'SELECT * FROM channels WHERE id = $1 AND tenant_id = $2 LIMIT 1',
    [id, tenantId],
  );
  return rows[0] ?? null;
}

export async function updateChannel(
  id: string,
  tenantId: string,
  fields: UpdateChannelInput,
): Promise<Channel | null> {
  const keys = Object.keys(fields) as (keyof UpdateChannelInput)[];
  if (keys.length === 0) return findChannelById(id, tenantId);

  const setClauses: string[] = [];
  const values: unknown[] = [id, tenantId];
  let paramIdx = 3;

  for (const key of keys) {
    if (key === 'metadata') {
      setClauses.push('metadata = $' + paramIdx + '::jsonb');
      values.push(fields.metadata ? JSON.stringify(fields.metadata) : null);
    } else {
      setClauses.push(`${key} = $${paramIdx}`);
      values.push(fields[key]);
    }
    paramIdx++;
  }
  setClauses.push('updated_at = now()');

  const { rows } = await pool.query<Channel>(
    `UPDATE channels
     SET ${setClauses.join(', ')}
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    values,
  );

  return rows[0] ?? null;
}

export async function deleteChannel(id: string, tenantId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM channels WHERE id = $1 AND tenant_id = $2',
    [id, tenantId],
  );
  return (rowCount ?? 0) > 0;
}
