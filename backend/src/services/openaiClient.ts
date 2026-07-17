import OpenAI from 'openai';
import { knobNumber, knobString } from '../config/knobs';
import { resolveModel } from '../config/models';
import { instrumentOpenAIClient } from './openaiCallTracker';
import { ProviderBreaker, type BreakerMode } from './providerResilience';
import { installProviderResilience } from './providerResilienceInstall';
import { logger } from '../utils/logger';

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
 * P2-6 (RC-19/RC-04): bound every OpenAI call and stop dialing a dead provider.
 *
 * `OPENAI_TIMEOUT_MS` above is PER ATTEMPT — with OPENAI_MAX_RETRIES=3 one call can hold the
 * per-conversation lock for ~240s. This installs the second wrapper on the same seam as the tracker
 * (order: resilience → tracker → orig), so all ~35 call sites get the cap, the shared per-turn
 * deadline, and the breaker with no call-site edits. Inert outside an AI-reply turn, and inert
 * entirely while the knobs sit at their defaults.
 *
 * THIS is the one place P2-6's knobs are read. The wrapper takes them as injected thunks so the
 * seam stays unit-testable without `process.env` mutation (`node:test` isolates files, not cases).
 *
 * The two duration knobs are declared `binding: 'frozen'` — "read once into a module-load const" —
 * so they are captured here rather than re-read per call, keeping the manifest's binding field
 * honest (it drives config-fingerprint participation; RC-06's own drift axis). `OPENAI_CIRCUIT_BREAKER`
 * is `per-call` by contrast, so an incident can flip it without a redeploy.
 */
const OPENAI_CALL_TIMEOUT_MS = knobNumber('OPENAI_CALL_TIMEOUT_MS');

export const providerBreaker = new ProviderBreaker({
  failureThreshold: knobNumber('OPENAI_BREAKER_FAILURE_THRESHOLD'),
  cooldownMs: knobNumber('OPENAI_BREAKER_COOLDOWN_MS'),
  halfOpenProbes: knobNumber('OPENAI_BREAKER_HALF_OPEN_PROBES'),
  now: () => Date.now(),
  onTransition: (t) => {
    // logger.warn/error carry the correlation tags and route to Sentry for free (P2-4). Process-level
    // facts like this deliberately get no table: the audit's own rollback note says the DLQ table is
    // the only additive schema, and a breaker transition belongs to no tenant and answers no message.
    const meta = { provider: 'openai', ...t };
    if (t.to === 'open') logger.error('[provider] circuit breaker opened', undefined, meta);
    else logger.warn('[provider] circuit breaker state change', meta);
  },
});

installProviderResilience(openai, {
  breaker: providerBreaker,
  readMode: () => knobString('OPENAI_CIRCUIT_BREAKER') as BreakerMode,
  readCallCapMs: () => OPENAI_CALL_TIMEOUT_MS,
  readForcedError: () => knobString('TEST_FORCE_PROVIDER_ERROR'),
});

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
