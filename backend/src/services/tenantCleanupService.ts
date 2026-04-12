import type { PoolClient } from 'pg';
import pool from '../db/pool';

/**
 * Hard-deletes all application data for a tenant in FK-safe order inside one transaction.
 */
export class TenantCleanupService {
  /** @returns false when no tenant row exists for the id. */
  async deleteTenant(tenantId: string): Promise<boolean> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');

      const exists = await client.query('SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE', [
        tenantId,
      ]);
      if (exists.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query('DELETE FROM feedback_logs WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM messages WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM orders WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM conversations WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM analytics_events WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM ai_configs WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM contacts WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM products WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM channels WHERE tenant_id = $1', [tenantId]);

      await client.query(
        `DELETE FROM refresh_tokens
         WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`,
        [tenantId],
      );
      await client.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export const tenantCleanupService = new TenantCleanupService();
