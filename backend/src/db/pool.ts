import { Pool, type PoolConfig } from 'pg';
import { resolveProcessRole } from '../config/processRole';
import { buildRolePoolSettings, buildSessionOptions, poolRoleFromProcessRole } from './poolConfig';

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

/**
 * P3-2 Step 10: the pool's CONFIGURATION is role-aware; the pool itself is still one default export.
 *
 * 65 files import this default. Making the singleton's config depend on the role keeps all of them
 * untouched, while letting the API and the worker diverge on the settings where they genuinely must
 * — most importantly `statement_timeout`, which the API wants and the worker must not have (the
 * reconcile, finetuning and monthly-snapshot jobs legitimately run for minutes).
 *
 * With PROCESS_ROLE unset the role is `all` and every value is byte-identical to the pre-split
 * defaults, so an existing deployment sees no change whatsoever.
 */
const poolSettings = buildRolePoolSettings({ role: poolRoleFromProcessRole(resolveProcessRole()) });
const sessionOptions = buildSessionOptions(poolSettings);

const pool = new Pool({
  ...buildPoolConfig(),
  max: poolSettings.max,
  idleTimeoutMillis: poolSettings.idleTimeoutMillis,
  connectionTimeoutMillis: poolSettings.connectionTimeoutMillis,
  // Makes `SELECT application_name, count(*) FROM pg_stat_activity GROUP BY 1` answer "did the
  // split take effect". Every row is anonymous without it.
  application_name: poolSettings.applicationName,
  ...(sessionOptions !== undefined ? { options: sessionOptions } : {}),
});

console.info('[db] pool configured', {
  role: poolSettings.role,
  max: poolSettings.max,
  applicationName: poolSettings.applicationName,
  statementTimeoutMs: poolSettings.statementTimeoutMs,
  idleInTransactionTimeoutMs: poolSettings.idleInTransactionTimeoutMs,
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
