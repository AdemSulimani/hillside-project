import { Pool, type PoolConfig } from 'pg';

function isLocalHost(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'postgres';
}

function isDigitalOceanPostgres(host: string) {
  return host.endsWith('.db.ondigitalocean.com') || host.includes('ondigitalocean.com');
}

/**
 * `DATABASE_URL` from DigitalOcean includes `sslmode=require`. node-pg parses that as
 * verify-full and ignores our Pool `ssl` option enough that TLS still fails with
 * SELF_SIGNED_CERT_IN_CHAIN. Strip those params and set `ssl` on the Pool explicitly.
 */
function buildPoolConfig(): PoolConfig {
  const raw = process.env.DATABASE_URL;
  if (!raw) return {};

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { connectionString: raw };
  }

  const host = u.hostname;

  if (isLocalHost(host)) {
    return { connectionString: raw };
  }

  for (const key of ['sslmode', 'ssl', 'sslrootcert', 'sslfactory']) {
    u.searchParams.delete(key);
  }
  const connectionString = u.toString();

  const ca = process.env.DATABASE_SSL_CA?.trim();
  if (ca) {
    return { connectionString, ssl: { ca, rejectUnauthorized: true } };
  }

  if (isDigitalOceanPostgres(host)) {
    return {
      connectionString,
      ssl: { rejectUnauthorized: false },
    };
  }

  return { connectionString, ssl: true };
}

const pool = new Pool({
  ...buildPoolConfig(),
  max: parseInt(process.env.PG_POOL_MAX || '10', 10),
  idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || '10000', 10),
});

/**
 * `pg` emits 'error' for transient failures on idle clients (network blip, Postgres restart,
 * brief OOM, etc.). Killing the process here is unsafe in production: combined with a missing
 * container restart policy it leaves the API permanently down until a human SSHes in. The
 * Pool will discard the broken client and create a new one on the next acquire, so we just log.
 */
pool.on('error', (err) => {
  console.error('[db] Idle client error (pool will recover automatically):', err);
});

export default pool;
