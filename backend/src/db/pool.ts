import { Pool, type PoolConfig } from 'pg';

function isLocalHost(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
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

const pool = new Pool(buildPoolConfig());

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
  process.exit(-1);
});

export default pool;
