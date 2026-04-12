import 'dotenv/config';
import IORedis from 'ioredis';
import { Pool } from 'pg';

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[healthcheck] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

function fail(message: string): never {
  console.error(`[healthcheck] ${message}`);
  process.exit(1);
}

async function checkDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: requireEnv('DATABASE_URL') });
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error('[healthcheck] Database check failed:', err);
    fail('Database connectivity check failed.');
  } finally {
    await pool.end();
  }
}

async function checkRedis(): Promise<void> {
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const client = new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: true });
  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== 'PONG') {
      fail(`Redis PING returned unexpected response: ${String(pong)}`);
    }
  } catch (err) {
    console.error('[healthcheck] Redis check failed:', err);
    fail('Redis connectivity check failed.');
  } finally {
    client.disconnect();
  }
}

async function checkGroq(): Promise<void> {
  const key = requireEnv('GROQ_API_KEY');
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[healthcheck] Groq API response:', res.status, body.slice(0, 500));
    fail(`Groq API reachability check failed with HTTP ${res.status}.`);
  }
}

async function main(): Promise<void> {
  console.log('[healthcheck] Running checks…');
  await checkDatabase();
  await checkRedis();
  await checkGroq();
  console.log('[healthcheck] All checks passed.');
}

main().catch((err) => {
  console.error('[healthcheck] Unexpected error:', err);
  process.exit(1);
});
