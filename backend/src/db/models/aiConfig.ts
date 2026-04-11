import pool from '../pool';
import type { PoolClient } from 'pg';

export interface AIConfig {
  id: string;
  tenant_id: string;
  tone: string;
  personality_description: string | null;
  restrictions: string[];
  sales_strategy: string | null;
  objection_handling: string | null;
  qa_pairs: { question: string; answer: string }[];
  is_active: boolean;
  custom_model_id: string | null;
  feedback_count: number;
  created_at: Date;
  updated_at: Date;
}

export async function findAIConfigByTenant(tenantId: string): Promise<AIConfig | null> {
  const { rows } = await pool.query<AIConfig>(
    'SELECT * FROM ai_configs WHERE tenant_id = $1 LIMIT 1',
    [tenantId],
  );
  return rows[0] ?? null;
}

/** Tenants created before onboarding seeded ai_configs still need a row. */
export async function ensureAIConfigForTenant(tenantId: string): Promise<AIConfig> {
  const existing = await findAIConfigByTenant(tenantId);
  if (existing) return existing;
  return createAIConfig(tenantId);
}

export async function createAIConfig(
  tenantId: string,
  client?: PoolClient,
): Promise<AIConfig> {
  const executor = client ?? pool;
  const { rows } = await executor.query<AIConfig>(
    `INSERT INTO ai_configs (tenant_id)
     VALUES ($1)
     RETURNING *`,
    [tenantId],
  );
  return rows[0];
}

export interface UpdateAIConfigInput {
  tone?: string;
  personality_description?: string | null;
  restrictions?: string[];
  sales_strategy?: string | null;
  objection_handling?: string | null;
  qa_pairs?: { question: string; answer: string }[];
  is_active?: boolean;
  custom_model_id?: string | null;
}

export async function incrementFeedbackCount(
  tenantId: string,
  client?: PoolClient,
): Promise<AIConfig | null> {
  const executor = client ?? pool;
  const { rows } = await executor.query<AIConfig>(
    `UPDATE ai_configs
     SET feedback_count = feedback_count + 1,
         updated_at = now()
     WHERE tenant_id = $1
     RETURNING *`,
    [tenantId],
  );
  return rows[0] ?? null;
}

export async function updateAIConfig(
  tenantId: string,
  fields: UpdateAIConfigInput,
): Promise<AIConfig | null> {
  const keys = Object.keys(fields) as (keyof UpdateAIConfigInput)[];
  if (keys.length === 0) return findAIConfigByTenant(tenantId);

  const setClauses: string[] = [];
  const values: unknown[] = [tenantId];

  keys.forEach((key, i) => {
    const paramIdx = i + 2;
    if (key === 'restrictions' || key === 'qa_pairs') {
      setClauses.push(`${key} = $${paramIdx}::jsonb`);
      values.push(JSON.stringify(fields[key]));
    } else {
      setClauses.push(`${key} = $${paramIdx}`);
      values.push(fields[key]);
    }
  });

  setClauses.push('updated_at = now()');

  const { rows } = await pool.query<AIConfig>(
    `UPDATE ai_configs SET ${setClauses.join(', ')} WHERE tenant_id = $1 RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}
