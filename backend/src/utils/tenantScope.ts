export interface TenantClause {
  text: string;
  values: [string];
}

/**
 * Returns a partial SQL WHERE fragment for tenant isolation.
 * Usage: `SELECT * FROM table WHERE ${clause.text}` with clause.values appended to params.
 */
export function withTenant(tenantId: string, paramIndex = 1): TenantClause {
  return {
    text: `tenant_id = $${paramIndex}`,
    values: [tenantId],
  };
}
