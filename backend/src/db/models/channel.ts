import pool from '../pool';

export type ChannelType = 'facebook' | 'instagram' | 'whatsapp';
export type ChannelConnectionMethod =
  | 'oauth_meta'
  | 'oauth_instagram'
  | 'manual'
  | 'embedded_signup';

export interface Channel {
  id: string;
  tenant_id: string;
  type: ChannelType;
  name: string;
  external_id: string;
  access_token_encrypted: string;
  connection_method: ChannelConnectionMethod;
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
  connection_method?: ChannelConnectionMethod;
  webhook_verified?: boolean;
  ai_enabled?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateChannelInput {
  name?: string;
  access_token_encrypted?: string;
  connection_method?: ChannelConnectionMethod;
  webhook_verified?: boolean;
  ai_enabled?: boolean;
  metadata?: Record<string, unknown> | null;
}

export async function createChannel(input: CreateChannelInput): Promise<Channel> {
  const { rows } = await pool.query<Channel>(
    `INSERT INTO channels (
      tenant_id,
      type,
      name,
      external_id,
      access_token_encrypted,
      connection_method,
      webhook_verified,
      ai_enabled,
      metadata
    )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING *`,
    [
      input.tenant_id,
      input.type,
      input.name,
      input.external_id,
      input.access_token_encrypted,
      input.connection_method ?? 'oauth_meta',
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

/** Safe fields for platform admin UI (no tokens). */
export interface ChannelAdminSummary {
  id: string;
  type: ChannelType;
  connection_method: ChannelConnectionMethod;
  name: string;
  webhook_verified: boolean;
  ai_enabled: boolean;
}

export async function listChannelSummariesForTenant(tenantId: string): Promise<ChannelAdminSummary[]> {
  const { rows } = await pool.query<ChannelAdminSummary>(
    `SELECT id, type, connection_method, name, webhook_verified, ai_enabled
     FROM channels
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
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

/**
 * Deletes a channel while preserving all commission data (orders, AI use cases,
 * commission reports) that were generated through conversations on that channel.
 *
 * Strategy: inside a single transaction, attempt to set channel_id = NULL on
 * every linked conversation before deleting the channel row.  This decouples the
 * rows so the database DELETE cannot cascade to orders / ai_use_cases.
 *
 * A SAVEPOINT is used around the UPDATE so that if migration 039 has not yet been
 * applied (channel_id still NOT NULL in the DB) the outer transaction can recover
 * gracefully and fall back to the original hard-delete behaviour.  Once the
 * migration is applied the UPDATE will always succeed and commission data is safe.
 */
export async function deleteChannel(id: string, tenantId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Decouple contacts and conversations from the channel before deletion so the
    // database ON DELETE CASCADE on older columns cannot reach orders / ai_use_cases /
    // commission data.  Uses SAVEPOINTs so that if either migration (039 or 040) has
    // not yet been applied the outer transaction recovers gracefully and falls back to
    // the original hard-delete behaviour.

    await client.query('SAVEPOINT sp_decouple_contacts');
    try {
      await client.query(
        'UPDATE contacts SET channel_id = NULL WHERE channel_id = $1',
        [id],
      );
      await client.query('RELEASE SAVEPOINT sp_decouple_contacts');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT sp_decouple_contacts');
      await client.query('RELEASE SAVEPOINT sp_decouple_contacts');
    }

    await client.query('SAVEPOINT sp_decouple_conversations');
    try {
      await client.query(
        'UPDATE conversations SET channel_id = NULL WHERE channel_id = $1',
        [id],
      );
      await client.query('RELEASE SAVEPOINT sp_decouple_conversations');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT sp_decouple_conversations');
      await client.query('RELEASE SAVEPOINT sp_decouple_conversations');
    }

    const { rowCount } = await client.query(
      'DELETE FROM channels WHERE id = $1 AND tenant_id = $2',
      [id, tenantId],
    );

    await client.query('COMMIT');
    return (rowCount ?? 0) > 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
