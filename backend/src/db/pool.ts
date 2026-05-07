import { Pool, type PoolConfig } from 'pg';

function sslOption(): PoolConfig['ssl'] | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return undefined;
  }

  const ca = process.env.DATABASE_SSL_CA?.trim();
  if (ca) {
    return { ca, rejectUnauthorized: true };
  }

  // DigitalOcean Postgres: chain is not in Node's default trust store without their CA.
  // In DO control panel you can download the CA and set DATABASE_SSL_CA (PEM) for full verification.
  if (host.endsWith('.db.ondigitalocean.com') || host.includes('ondigitalocean.com')) {
    return { rejectUnauthorized: false };
  }

  return undefined;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslOption(),
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
  process.exit(-1);
});

export default pool;
