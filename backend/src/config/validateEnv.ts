import { REDACT_PII } from '../utils/redact';

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

/**
 * Known OpenAI embedding-model output dimensions. The `products.embedding` column is
 * `vector(1536)` (migration 029), so the active model MUST be 1536-dim — otherwise every
 * similarity query errors and semantic retrieval is silently disabled (the P1-4/RC-04 dimension
 * landmine, made worse by `openaiClient`'s `text-embedding-3-large` (3072-dim) code default).
 * We fail fast at boot so the misconfiguration is loud instead of a silent fleet-wide degradation.
 */
const EMBEDDING_MODEL_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-ada-002': 1536,
  'text-embedding-3-large': 3072,
};
const REQUIRED_EMBEDDING_DIM = 1536;

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

  // Embedding-model dimension must match the vector(1536) column, in EVERY environment — a
  // wrong/unset model is a functional break (silent semantic-disabled), not just a prod posture.
  const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL?.trim();
  if (!embeddingModel) {
    fatal.push(
      '  - OPENAI_EMBEDDING_MODEL is not set; the code default (text-embedding-3-large, 3072-dim) ' +
        'is incompatible with the products.embedding vector(1536) column and disables semantic ' +
        'retrieval. Set it to a 1536-dim model (e.g. text-embedding-3-small).',
    );
  } else {
    const dim = EMBEDDING_MODEL_DIMS[embeddingModel];
    if (dim !== undefined && dim !== REQUIRED_EMBEDDING_DIM) {
      fatal.push(
        `  - OPENAI_EMBEDDING_MODEL=${embeddingModel} produces ${dim}-dim vectors, but ` +
          `products.embedding is vector(${REQUIRED_EMBEDDING_DIM}); every similarity query would ` +
          'error. Use a 1536-dim model (e.g. text-embedding-3-small), or run a reindex migration first.',
      );
    } else if (dim === undefined) {
      warnings.push(
        `  - OPENAI_EMBEDDING_MODEL=${embeddingModel} has an unknown output dimension; ensure it ` +
          `matches the products.embedding vector(${REQUIRED_EMBEDDING_DIM}) column.`,
      );
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

  // P1-6 (SEC-5): redaction is ON by default and is the compliance boundary for customer PII in
  // logs and durable telemetry. Disabling it re-exposes cleartext PII and must be a deliberate,
  // compliance-owned decision — so surface it loudly at boot rather than silently.
  if (!REDACT_PII) {
    console.warn(
      '[REDACT_PII] DISABLED — customer PII (names/phones/addresses/health context) will be ' +
        'logged and stored in cleartext. This must be a deliberate, compliance-gated choice. ' +
        'Unset REDACT_PII (or set it to true) to re-enable redaction.',
    );
  }

  // P2-4 Part 1: surface the AI-path observability posture at boot so operators know how logs are
  // shaped and whether the decision ledger is recording. Purely informational — never fatal.
  const structuredLogging =
    (process.env.STRUCTURED_LOGGING ?? 'false').trim().toLowerCase() === 'true';
  const decisionLedger =
    (process.env.AI_DECISION_LEDGER_ENABLED ?? 'false').trim().toLowerCase() === 'true';
  console.info(
    `[observability] STRUCTURED_LOGGING=${structuredLogging ? 'on (JSON, correlation-keyed)' : 'off (legacy console)'}; ` +
      `AI_DECISION_LEDGER_ENABLED=${
        decisionLedger
          ? `on (retention ${process.env.LEDGER_RETENTION_DAYS ?? '90'}d)`
          : 'off (no rows written; retention sweep idle)'
      }; ` +
      `REDACT_PII=${REDACT_PII ? 'on' : 'off'}`,
  );

  // P2-4 Part 2: surface the receipt-snapshot + dedupe-replay posture. Purely informational —
  // never fatal.
  const receiptSnapshot =
    (process.env.RECEIPT_TIME_SNAPSHOT ?? 'false').trim().toLowerCase() === 'true';
  const dedupeReplay =
    (process.env.WEBHOOK_DEDUPE_REPLAY ?? 'false').trim().toLowerCase() === 'true';
  const versionedCacheForSnapshot =
    (process.env.AI_CONFIG_VERSIONED_CACHE ?? 'false').trim().toLowerCase() === 'true';
  console.info(
    `[receipt] RECEIPT_TIME_SNAPSHOT=${
      receiptSnapshot
        ? 'on (captured at receipt; gates stay LIVE — record-only)'
        : 'off (no capture; gates live as always)'
    }; WEBHOOK_DEDUPE_REPLAY=${
      dedupeReplay
        ? 'on (late deliveries accepted; replay = per-message key + DB dedupe)'
        : 'off (legacy 300s skew 403)'
    }; AI_REPLY_DELAY_MS=${process.env.AI_REPLY_DELAY_MS ?? '8000'}` +
      // The RC-17 staleness floor is the snapshot's only GOVERNING use, and it can only act on the
      // versioned cache — the legacy EX900 value carries no version to compare. Say so, rather than
      // letting an operator believe RC-17 is covered when the floor is silently inert.
      `${
        receiptSnapshot && !versionedCacheForSnapshot
          ? ' [RC-17 staleness floor INERT: needs AI_CONFIG_VERSIONED_CACHE=true]'
          : ''
      }`,
  );

  // P2-1: surface the grounding-gate posture at boot so operators know whether the deterministic
  // gate + facts_used contract are live. Purely informational — never fatal.
  const factsContract =
    (process.env.FACTS_USED_CONTRACT ?? 'false').trim().toLowerCase() === 'true';
  const groundingGate =
    (process.env.GROUNDING_GATE_CONSOLIDATED ?? 'false').trim().toLowerCase() === 'true';
  console.info(
    `[grounding] FACTS_USED_CONTRACT=${factsContract ? 'on (temp0+seed+json_schema)' : 'off (legacy temp/free-prose)'}; ` +
      `GROUNDING_GATE_CONSOLIDATED=${groundingGate ? 'on (consolidated gate)' : 'off (legacy price/name/gap guards)'}` +
      `${factsContract && !groundingGate ? ' [SHADOW: declared facts logged, legacy guards decide]' : ''}`,
  );

  // P2-2: surface the classifier-consolidation posture at boot. Purely informational — never fatal.
  const orderStageMode = (process.env.ORDER_STAGE_MACHINE ?? 'off').trim().toLowerCase();
  const stickyLocale = (process.env.STICKY_LOCALE_SLOT ?? 'false').trim().toLowerCase() === 'true';
  const intentStructured =
    (process.env.INTENT_STRUCTURED_CONTRACT ?? 'false').trim().toLowerCase() === 'true';
  const commissionStored =
    (process.env.COMMISSION_STORED_TIMESTAMP ?? 'false').trim().toLowerCase() === 'true';
  console.info(
    `[classifiers] ORDER_STAGE_MACHINE=${
      orderStageMode === 'on'
        ? 'on (deterministic FSM authoritative; order LLM classifiers skipped)'
        : orderStageMode === 'shadow'
          ? 'shadow (FSM computed + divergence logged; legacy decides)'
          : 'off (legacy LLM order-classifiers)'
    }; STICKY_LOCALE_SLOT=${stickyLocale ? 'on' : 'off'}; ` +
      `INTENT_STRUCTURED_CONTRACT=${intentStructured ? 'on' : 'off'}; ` +
      `COMMISSION_STORED_TIMESTAMP=${commissionStored ? 'on' : 'off'}`,
  );

  // P2-3: surface the memory/history redesign posture at boot. Purely informational — never fatal.
  const historyFiltered =
    (process.env.HISTORY_DELIVERY_FILTERED ?? 'false').trim().toLowerCase() === 'true';
  const summarySlotBacked =
    (process.env.SUMMARY_SLOT_BACKED ?? 'false').trim().toLowerCase() === 'true';
  const versionedCache =
    (process.env.AI_CONFIG_VERSIONED_CACHE ?? 'false').trim().toLowerCase() === 'true';
  console.info(
    `[memory] HISTORY_DELIVERY_FILTERED=${
      historyFiltered ? 'on (drop send-failed; flagged/holding→system)' : 'off (legacy binary role map)'
    }; SUMMARY_SLOT_BACKED=${
      summarySlotBacked ? 'on (slot-backed summary + slot writes)' : 'off (customer-only summarizer)'
    }; AI_CONFIG_VERSIONED_CACHE=${
      versionedCache ? 'on (CAS/versioned + write-through; C-55 healed)' : 'off (EX900 delete-only)'
    }`,
  );

  // P2-5: surface the Albanian/Gheg + prompt-hygiene posture at boot. Informational — never fatal.
  const ghegLexicons = (process.env.GHEG_LEXICONS ?? 'false').trim().toLowerCase() === 'true';
  const dialectNormalization =
    (process.env.DIALECT_NORMALIZATION ?? 'false').trim().toLowerCase() === 'true';
  const footerAllTenants =
    (process.env.RESTRICTIONS_FOOTER_ALL_TENANTS ?? 'false').trim().toLowerCase() === 'true';
  const promptAllowlistBudget =
    (process.env.PROMPT_ALLOWLIST_BUDGET ?? 'false').trim().toLowerCase() === 'true';
  console.info(
    `[albanian] GHEG_LEXICONS=${
      ghegLexicons ? 'on (Gheg forms appended; EV-010 routed as other-options)' : 'off (Tosk-only lexicons)'
    }; DIALECT_NORMALIZATION=${
      dialectNormalization
        ? 'on (lexical arm folded + unified stopwords)'
        : 'off (keyword/phrase arms disagree on diacritics)'
    }; RESTRICTIONS_FOOTER_ALL_TENANTS=${
      footerAllTenants ? 'on (platform rulebook renders for every tenant)' : 'off (footer reaches 1/6 tenants)'
    }; PROMPT_ALLOWLIST_BUDGET=${
      promptAllowlistBudget
        ? `on (orphan blocks rejected; guidelines<=${process.env.PROMPT_GUIDELINES_MAX_CHARS ?? '20000'} chars, prompt reported >${process.env.PROMPT_ASSEMBLY_MAX_CHARS ?? '34000'})`
        : 'off (orphan offers_promotions renders; prompt unbudgeted)'
    }`,
  );
  if (footerAllTenants && promptAllowlistBudget) {
    console.info(
      '[albanian] NOTE: the platform footer (+~2.2K chars/tenant) and the prompt budget are BOTH on — ' +
        'the interaction the P2-5 plan flags as its top risk. The footer is never truncated by design.',
    );
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
