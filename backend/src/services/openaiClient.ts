import OpenAI from 'openai';

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not configured');
}

/**
 * Resilience config for every OpenAI call. Several safety/quality classifiers (usage,
 * speculative-health, product-name hallucination) "fail open" on error — i.e. a transient
 * network blip silently lets a reply through that would otherwise have been caught. Making
 * retries/timeout explicit (instead of relying on undocumented SDK defaults) shrinks that
 * failure window across the board so the guards behave consistently run-to-run. Tunable via
 * env without a code change.
 */
const OPENAI_MAX_RETRIES = (() => {
  const n = process.env.OPENAI_MAX_RETRIES ? parseInt(process.env.OPENAI_MAX_RETRIES, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();

const OPENAI_TIMEOUT_MS = (() => {
  const n = process.env.OPENAI_TIMEOUT_MS ? parseInt(process.env.OPENAI_TIMEOUT_MS, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: OPENAI_MAX_RETRIES,
  timeout: OPENAI_TIMEOUT_MS,
});

export const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
export const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o';
export const OPENAI_EVAL_MODEL = process.env.OPENAI_EVAL_MODEL || 'gpt-4o';
export const OPENAI_INTENT_MODEL = process.env.OPENAI_INTENT_MODEL || 'gpt-4o';
export const OPENAI_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
export const OPENAI_FINETUNING_BASE_MODEL =
  process.env.OPENAI_FINETUNING_BASE_MODEL || 'gpt-4o-mini-2024-07-18';
