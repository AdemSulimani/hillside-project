import pool from '../pool';
import type { PoolClient } from 'pg';

export interface Tenant {
  id: string;
  name: string;
  niche: string;
  description: string | null;
  delivery_methods: string[];
  country: string;
  currency: string;
  logo_url: string | null;
  plan: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateTenantInput {
  name: string;
  niche: string;
  description?: string | null;
  delivery_methods: string[];
  country: string;
  currency?: string;
  logo_url?: string | null;
}

export async function createTenant(
  input: CreateTenantInput,
  client?: PoolClient,
): Promise<Tenant> {
  const executor = client ?? pool;
  const { rows } = await executor.query<Tenant>(
    `INSERT INTO tenants (name, niche, description, delivery_methods, country, currency, logo_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.name,
      input.niche,
      input.description ?? null,
      JSON.stringify(input.delivery_methods),
      input.country,
      input.currency ?? 'USD',
      input.logo_url ?? null,
    ],
  );
  return rows[0];
}

export async function findTenantById(id: string): Promise<Tenant | null> {
  const { rows } = await pool.query<Tenant>(
    'SELECT * FROM tenants WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export async function updateTenant(
  id: string,
  fields: Partial<Omit<Tenant, 'id' | 'created_at' | 'updated_at'>>,
): Promise<Tenant | null> {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (keys.length === 0) return findTenantById(id);

  const setClauses = keys.map((key, i) => {
    if (key === 'delivery_methods') return `${key} = $${i + 2}::jsonb`;
    return `${key} = $${i + 2}`;
  });
  setClauses.push('updated_at = now()');

  const values = keys.map((key) => {
    if (key === 'delivery_methods') return JSON.stringify(fields[key]);
    return fields[key];
  });

  const { rows } = await pool.query<Tenant>(
    `UPDATE tenants SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return rows[0] ?? null;
}
