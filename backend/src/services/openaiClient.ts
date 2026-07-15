import OpenAI from 'openai';
import { knobNumber } from '../config/knobs';
import { resolveModel } from '../config/models';
import { instrumentOpenAIClient } from './openaiCallTracker';

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
const OPENAI_MAX_RETRIES = knobNumber('OPENAI_MAX_RETRIES');

const OPENAI_TIMEOUT_MS = knobNumber('OPENAI_TIMEOUT_MS');

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: OPENAI_MAX_RETRIES,
  timeout: OPENAI_TIMEOUT_MS,
});

// P1-5 (C-108): record model + token usage + USD cost of EVERY chat/embedding call made
// inside an AI-reply job into the decision ledger's `usage.calls` (transparent pass-through
// outside a tracking context — see services/openaiCallTracker.ts).
instrumentOpenAIClient(openai);

/**
 * Model ids, resolved through the single chain in `config/models.ts` (P2-7 / M8).
 *
 * These stay exported for the ~25 call sites that import them, but they are now derived, not
 * defined: `config/models.ts` owns every default and every fallback. That module is side-effect-free
 * on purpose, so `retrievalReliability` and `scripts/checkConfig` can import the same resolution
 * logic WITHOUT triggering this file's module-load throw + client construction — which is exactly
 * why the `text-embedding-3-large` literal used to be duplicated there.
 *
 * NOTE the embedding default moved: it was `text-embedding-3-large` (3072-dim) here, which is
 * incompatible with the `vector(1536)` columns and silently disables semantic retrieval (RC-04).
 * `config/models.ts` gives the role NO default, and `validateEnv` fatals when it is unset — a wrong
 * default is more dangerous than no default.
 */
export const OPENAI_CHAT_MODEL = resolveModel('chat');
export const OPENAI_CLASSIFIER_MODEL = resolveModel('classifier');
export const OPENAI_VISION_MODEL = resolveModel('vision');
export const OPENAI_EVAL_MODEL = resolveModel('eval');
export const OPENAI_INTENT_MODEL = resolveModel('intent');
export const OPENAI_EMBEDDING_MODEL = resolveModel('embedding');
export const OPENAI_FINETUNING_BASE_MODEL = resolveModel('finetune_base');
