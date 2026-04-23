import pool from '../pool';

export interface Contact {
  id: string;
  tenant_id: string;
  channel_id: string;
  external_id: string;
  name: string;
  avatar_url: string | null;
  metadata: Record<string, unknown>;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ContactListRow extends Contact {
  message_count: number;
  order_count: number;
  last_seen: Date | null;
}

export type ContactListSortColumn = 'last_seen' | 'name' | 'message_count' | 'order_count';

export interface ContactListFilters {
  tenantId: string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: ContactListSortColumn;
  sortDir?: 'asc' | 'desc';
}

export interface UpdateContactInput {
  name?: string;
  notes?: string | null;
}

export interface UpsertContactInput {
  tenant_id: string;
  channel_id: string;
  external_id: string;
  name: string;
  avatar_url?: string | null;
  metadata?: Record<string, unknown>;
}

export async function findContactById(id: string): Promise<Contact | null> {
  const { rows } = await pool.query<Contact>(
    'SELECT * FROM contacts WHERE id = $1 LIMIT 1',
    [id],
  );
  return rows[0] ?? null;
}

export async function findContactByIdForTenant(
  id: string,
  tenantId: string,
): Promise<Contact | null> {
  const { rows } = await pool.query<Contact>(
    'SELECT * FROM contacts WHERE id = $1 AND tenant_id = $2 LIMIT 1',
    [id, tenantId],
  );
  return rows[0] ?? null;
}

export async function findContactByExternalIdForTenantChannel(
  tenantId: string,
  channelId: string,
  externalId: string,
): Promise<Contact | null> {
  const { rows } = await pool.query<Contact>(
    `SELECT * FROM contacts
     WHERE tenant_id = $1 AND channel_id = $2 AND external_id = $3
     LIMIT 1`,
    [tenantId, channelId, externalId],
  );
  return rows[0] ?? null;
}

export async function listContactsAggregatedForTenant(
  filters: ContactListFilters,
): Promise<{ rows: ContactListRow[]; total: number }> {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: string[] = ['c.tenant_id = $1'];
  const values: unknown[] = [filters.tenantId];
  let p = 2;

  if (filters.search?.trim()) {
    conditions.push(`c.name ILIKE $${p}`);
    values.push(`%${filters.search.trim()}%`);
    p++;
  }

  const whereSql = conditions.join(' AND ');

  const sortBy = filters.sortBy ?? 'last_seen';
  const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';
  const SORT_SQL: Record<ContactListSortColumn, string> = {
    last_seen: 'MAX(m.created_at)',
    name: 'c.name',
    message_count: 'COUNT(DISTINCT m.id)',
    order_count: 'COUNT(DISTINCT o.id)',
  };
  const orderExpr = SORT_SQL[sortBy];
  const nullsClause =
    sortBy === 'last_seen'
      ? sortDir === 'ASC'
        ? 'NULLS FIRST'
        : 'NULLS LAST'
      : '';

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM contacts c WHERE ${whereSql}`,
    values,
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const { rows } = await pool.query<ContactListRow>(
    `SELECT
       c.id,
       c.tenant_id,
       c.channel_id,
       c.external_id,
       c.name,
       c.avatar_url,
       c.metadata,
       c.notes,
       c.created_at,
       c.updated_at,
       COUNT(DISTINCT m.id)::int AS message_count,
       COUNT(DISTINCT o.id)::int AS order_count,
       MAX(m.created_at) AS last_seen
     FROM contacts c
     LEFT JOIN conversations conv
       ON conv.contact_id = c.id AND conv.tenant_id = c.tenant_id
     LEFT JOIN messages m
       ON m.conversation_id = conv.id AND m.tenant_id = c.tenant_id
     LEFT JOIN orders o
       ON o.contact_id = c.id AND o.tenant_id = c.tenant_id
     WHERE ${whereSql}
     GROUP BY c.id
     ORDER BY ${orderExpr} ${sortDir} ${nullsClause}, c.updated_at DESC
     LIMIT $${p} OFFSET $${p + 1}`,
    [...values, limit, offset],
  );

  return { rows, total };
}

export async function updateContactForTenant(
  id: string,
  tenantId: string,
  input: UpdateContactInput,
): Promise<Contact | null> {
  const keys = Object.keys(input) as (keyof UpdateContactInput)[];
  if (keys.length === 0) {
    return findContactByIdForTenant(id, tenantId);
  }

  const setClauses: string[] = [];
  const vals: unknown[] = [id, tenantId];
  let idx = 3;

  for (const key of keys) {
    setClauses.push(`${key} = $${idx}`);
    vals.push(input[key]);
    idx++;
  }
  setClauses.push('updated_at = now()');

  const { rows } = await pool.query<Contact>(
    `UPDATE contacts SET ${setClauses.join(', ')}
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    vals,
  );
  return rows[0] ?? null;
}

export async function upsertContact(input: UpsertContactInput): Promise<Contact> {
  const { rows } = await pool.query<Contact>(
    `INSERT INTO contacts (tenant_id, channel_id, external_id, name, avatar_url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (tenant_id, channel_id, external_id)
     DO UPDATE SET
       name = EXCLUDED.name,
       avatar_url = EXCLUDED.avatar_url,
       metadata = (contacts.metadata - 'raw_payload_contact') || EXCLUDED.metadata,
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
