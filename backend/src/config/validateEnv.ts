const REQUIRED = [
  { key: 'DATABASE_URL', description: 'PostgreSQL connection string' },
  { key: 'JWT_SECRET', description: 'Signing secret for access tokens' },
  { key: 'JWT_REFRESH_SECRET', description: 'Signing secret for refresh tokens' },
  { key: 'OPENAI_API_KEY', description: 'OpenAI API key for AI features' },
] as const;

/**
 * Secrets that are not strictly required to boot (e.g. a dev instance may not use
 * channels or the admin dashboard) but whose absence weakens security in production.
 * We warn rather than hard-fail so local development is not blocked.
 */
const RECOMMENDED = [
  { key: 'ENCRYPTION_KEY', description: 'AES key for channel access-token encryption' },
  { key: 'ADMIN_JWT_SECRET', description: 'Signing secret for platform-admin tokens' },
  { key: 'WEBHOOK_VERIFY_TOKEN', description: 'Meta webhook subscription verify token' },
  { key: 'META_APP_SECRET', description: 'Meta app secret for webhook signature checks' },
] as const;

/** Secrets that must be high-entropy. Short/guessable values are brute-forceable. */
const STRENGTH_CHECKED = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'ADMIN_JWT_SECRET', 'ADMIN_KEY'] as const;
const MIN_SECRET_LENGTH = 32;

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Validates secrets required for a safe production boot. Call from `bootstrap.ts` before importing the Express app.
 *
 * Behaviour:
 *  - Missing REQUIRED secrets always abort the boot.
 *  - In production, weak (short) or duplicated signing secrets abort the boot, because they
 *    directly undermine token integrity. In development they only emit a warning so local
 *    setups are not blocked.
 *  - Missing RECOMMENDED secrets emit a warning.
 */
export function validateRequiredEnv(): void {
  const fatal: string[] = [];
  const warnings: string[] = [];

  for (const { key, description } of REQUIRED) {
    const value = process.env[key]?.trim();
    if (!value) {
      fatal.push(`  - ${key} (${description}) is missing`);
    }
  }

  for (const { key, description } of RECOMMENDED) {
    const value = process.env[key]?.trim();
    if (!value) {
      warnings.push(`  - ${key} (${description}) is not set`);
    }
  }

  for (const key of STRENGTH_CHECKED) {
    const value = process.env[key]?.trim();
    if (value && value.length < MIN_SECRET_LENGTH) {
      const msg = `  - ${key} is shorter than ${MIN_SECRET_LENGTH} characters (low entropy)`;
      if (isProduction()) {
        fatal.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }

  const jwt = process.env.JWT_SECRET?.trim();
  const jwtRefresh = process.env.JWT_REFRESH_SECRET?.trim();
  if (jwt && jwtRefresh && jwt === jwtRefresh) {
    const msg =
      '  - JWT_SECRET and JWT_REFRESH_SECRET are identical; refresh and access tokens must use distinct secrets';
    if (isProduction()) {
      fatal.push(msg);
    } else {
      warnings.push(msg);
    }
  }

  if (warnings.length > 0) {
    console.warn('[env] Security warnings:\n' + warnings.join('\n'));
  }

  if (fatal.length > 0) {
    console.error('[env] Refusing to start due to insecure configuration:\n' + fatal.join('\n'));
    console.error('[env] Fix these in your environment or .env file, then restart the server.');
    process.exit(1);
  }
}
