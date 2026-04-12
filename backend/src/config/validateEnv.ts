const REQUIRED = [
  { key: 'DATABASE_URL', description: 'PostgreSQL connection string' },
  { key: 'JWT_SECRET', description: 'Signing secret for access tokens' },
  { key: 'JWT_REFRESH_SECRET', description: 'Signing secret for refresh tokens' },
  { key: 'GROQ_API_KEY', description: 'Groq API key for AI features' },
] as const;

/**
 * Validates secrets required for a safe production boot. Call from `bootstrap.ts` before importing the Express app.
 */
export function validateRequiredEnv(): void {
  const missing: string[] = [];

  for (const { key, description } of REQUIRED) {
    const value = process.env[key]?.trim();
    if (!value) {
      missing.push(`  - ${key} (${description})`);
    }
  }

  if (missing.length > 0) {
    console.error('[env] Missing required environment variables:\n' + missing.join('\n'));
    console.error('[env] Set these in your environment or .env file, then restart the server.');
    process.exit(1);
  }
}
