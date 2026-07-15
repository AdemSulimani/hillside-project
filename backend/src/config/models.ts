/**
 * P2-7 (RC-17, RC-04) — the single model-resolution chain.
 *
 * WHY THIS MODULE EXISTS (the M8 constraint). Before P2-7 there were FOUR competing ways to
 * decide which OpenAI model a call site uses:
 *   (A) import the frozen const from openaiClient   — 22 classifier sites in aiService
 *   (B) `process.env.X?.trim() || CONST`            — re-read per call (embeddingService, aiQuality…)
 *   (C) `CONST || 'literal'`                        — dead `||`, the const is never falsy
 *   (D) a private OpenAI client + its own default   — AIProductProcessingService
 * They can disagree on a partial env and silently mask a typo'd var. Worse, `retrievalReliability`
 * had to DUPLICATE `'text-embedding-3-large'` as a literal rather than import it, because importing
 * `openaiClient` triggers module-load side effects (it THROWS when OPENAI_API_KEY is unset, builds a
 * client, and instruments it) — which makes it un-importable from a unit test. So the duplication
 * was a symptom of there being nowhere side-effect-free to put config. This module is that place.
 *
 * INVARIANT — this module must stay a LEAF: no module-load throw, no client construction, no
 * console, no process.exit, no DB/Redis, and no import of anything that does those. Reading
 * process.env at module load is fine. Both `openaiClient.ts` and `retrievalReliability.ts` import
 * it, and `scripts/checkConfig.ts` runs it with no API key present.
 */

/**
 * The distinct jobs we ask an LLM to do. This is a ROLE taxonomy, not a per-call-site one: the
 * audit's "only 2 of ~30 honor a dedicated var" counts CALL SITES (~30), but they collapse to ~7
 * roles. One var per role gives operators the routing knob (e.g. move the whole cheap boolean
 * classifier fan-out to a smaller model) without a 30-variable explosion.
 */
export type ModelRole =
  | 'chat'
  | 'classifier'
  | 'vision'
  | 'eval'
  | 'intent'
  | 'product_processing'
  | 'embedding'
  | 'finetune_base';

/**
 * Each role's resolution chain: the first non-empty env var wins, else `terminal`.
 *
 * Every chat-family role falls back to OPENAI_CHAT_MODEL, so the new vars are purely additive —
 * an env that sets none of them behaves EXACTLY as it did before P2-7.
 */
interface RoleSpec {
  /** Env vars in precedence order. */
  chain: readonly string[];
  /** Last-resort default. `null` ⇒ the role has no safe default and is validated as required. */
  terminal: string | null;
}

export const MODEL_ROLES: Record<ModelRole, RoleSpec> = {
  chat: { chain: ['OPENAI_CHAT_MODEL'], terminal: 'gpt-4o' },
  classifier: { chain: ['OPENAI_CLASSIFIER_MODEL', 'OPENAI_CHAT_MODEL'], terminal: 'gpt-4o' },
  vision: { chain: ['OPENAI_VISION_MODEL', 'OPENAI_CHAT_MODEL'], terminal: 'gpt-4o' },
  eval: { chain: ['OPENAI_EVAL_MODEL', 'OPENAI_CHAT_MODEL'], terminal: 'gpt-4o' },
  intent: { chain: ['OPENAI_INTENT_MODEL', 'OPENAI_CHAT_MODEL'], terminal: 'gpt-4o' },
  /**
   * Product extraction from uploaded documents/images.
   *
   * ⚠️ The terminal is `gpt-4o-mini`, NOT `gpt-4o` — this is deliberate and load-bearing.
   * `AIProductProcessingService` has always resolved `process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini'`:
   * chat model when set, mini when unset. Giving this role the generic `gpt-4o` terminal would
   * silently move every product import to `gpt-4o` (~15x the cost) in any environment that leaves
   * OPENAI_CHAT_MODEL unset. The chain below reproduces the historical behaviour exactly.
   */
  product_processing: {
    chain: ['OPENAI_PRODUCT_PROCESSING_MODEL', 'OPENAI_CHAT_MODEL'],
    terminal: 'gpt-4o-mini',
  },
  /**
   * No terminal: an embedding model whose dimension does not match the `vector(1536)` column
   * silently disables semantic retrieval fleet-wide (RC-04). A wrong default is more dangerous
   * than no default, so `validateEnv` fatals when OPENAI_EMBEDDING_MODEL is unset rather than
   * letting a fallback pick for us. See EMBEDDING_MODEL_DIMS below.
   */
  embedding: { chain: ['OPENAI_EMBEDDING_MODEL'], terminal: null },
  finetune_base: { chain: ['OPENAI_FINETUNING_BASE_MODEL'], terminal: 'gpt-4o-mini-2024-07-18' },
};

/**
 * Known OpenAI embedding-model output dimensions. `products.embedding` and
 * `product_image_fingerprints.embedding` are both `vector(1536)` (migration 029), so the active
 * model MUST be 1536-dim — otherwise every similarity query errors and semantic retrieval is
 * silently disabled (the RC-04 dimension landmine).
 *
 * This table is the fast, offline half of the guard. `scripts/checkConfig.ts` additionally reads
 * the REAL column dimension from the database, which is the authority — see EXPECTED_EMBEDDING_DIM.
 */
export const EMBEDDING_MODEL_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-ada-002': 1536,
  'text-embedding-3-large': 3072,
};

/**
 * The dimension the embedding columns are declared with. Sourced from the COLUMN contract, not the
 * model, because the guard's job is "does this vector fit the column".
 *
 * Before P2-7 this literal existed in THREE places (validateEnv, retrievalReliability, and
 * migration 029). It now lives here once; `scripts/checkConfig.ts` verifies it still matches what
 * the database actually declares, so the constant cannot silently rot if a migration changes it.
 */
export const EXPECTED_EMBEDDING_DIM = 1536;

/** The tables whose `embedding` column must match EXPECTED_EMBEDDING_DIM. */
export const EMBEDDING_COLUMN_TABLES = ['products', 'product_image_fingerprints'] as const;

export interface ResolveModelOptions {
  /**
   * A tenant's fine-tuned `ai_configs.custom_model_id`, when the caller wants it to win.
   *
   * NOTE (M1): the vision path deliberately passes `null` here — vision generation drops a tenant's
   * custom_model_id today because fine-tuned models may not serve images. That is a known, separate
   * defect (audit M1); P2-7 preserves the behaviour exactly and only makes the drop an EXPLICIT
   * argument instead of an accident of expression shape. Do not "fix" it here.
   */
  customModelId?: string | null;
  /** Env source. Defaults to process.env; injected in tests so no global mutation is needed. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the model id for a role. Precedence: custom_model_id → role's env chain → terminal.
 *
 * Returns '' only for `embedding` with nothing set — the caller-facing fatal for that case lives in
 * validateEnv, so this stays a pure function with no throw.
 */
export function resolveModel(role: ModelRole, opts: ResolveModelOptions = {}): string {
  const env = opts.env ?? process.env;

  const custom = opts.customModelId?.trim();
  if (custom) return custom;

  for (const key of MODEL_ROLES[role].chain) {
    const value = env[key]?.trim();
    if (value) return value;
  }

  return MODEL_ROLES[role].terminal ?? '';
}

/** Every env var that can name a model, for the manifest + `.env.example` drift check. */
export function modelEnvKeys(): string[] {
  const keys = new Set<string>();
  for (const spec of Object.values(MODEL_ROLES)) {
    for (const key of spec.chain) keys.add(key);
  }
  return [...keys];
}
