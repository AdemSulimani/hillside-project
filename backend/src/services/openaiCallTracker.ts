/**
 * P1-5 (RC-03/RC-17, C-108): per-call OpenAI usage capture for the AI decision ledger.
 *
 * `generateReply` is one of ~18–25 OpenAI calls a single reply makes (intent detectors, gap
 * assessor, quality eval, language, retrieval embedding, …), and until now only the main
 * reply call's `completion.usage` reached the ledger — the majority of the per-reply COGS
 * was invisible. Instead of threading a usage accumulator through every classifier call site,
 * `instrumentOpenAIClient` wraps the SDK singleton's `chat.completions.create` and
 * `embeddings.create` ONCE at module load: when a call completes inside an active tracking
 * context (AsyncLocalStorage entered by `processAIReply` via `runWithOpenAICallTracking`),
 * its model + usage + computed USD cost are appended to the context's call list, which the
 * ledger writer folds into `usage.calls`. Outside a context (product imports, embeddings
 * reconciliation, fine-tuning jobs) the wrapper is a pure pass-through.
 *
 * The wrapper NEVER alters the call result or error path — recording is wrapped in its own
 * try/catch, and streaming payloads (none exist in this repo today) are skipped defensively.
 * No prompt/customer text is recorded — model ids and token counts only (P1-6 clean).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type OpenAI from 'openai';
import { computeCost } from './modelPricing';
import { MODEL_ROLES, resolveModel, type ModelRole } from '../config/models';

export interface TrackedOpenAICall {
  /** 'chat' | 'embedding' */
  kind: string;
  /** The model id the caller requested. */
  requested: string | null;
  /** The model the API actually served (`response.model`). */
  served: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  usd_cost: number | null;
  /**
   * P3-6: which model ROLE this call belongs to, or null when it cannot be determined.
   * See `attributeRole` — it is what turns a flat per-turn total into "the classifier fan-out
   * costs 53% of a reply", which is the number a tiering decision is actually made on.
   */
  role: ModelRole | null;
  /**
   * P3-6: prompt tokens served from OpenAI's automatic prefix cache. `null` when the provider did
   * not report the field at all, which is meaningfully different from a reported 0 (no cache hit):
   * the first tells you nothing, the second tells you the prefix missed.
   */
  cached_tokens: number | null;
}

interface CallTrackingContext {
  calls: TrackedOpenAICall[];
  /** The role label pushed by `withModelRole`, if any. See `attributeRole`. */
  role?: ModelRole;
}

const callTrackingStorage = new AsyncLocalStorage<CallTrackingContext>();

/** Run `fn` with an active call-tracking context (one per AI-reply job). */
export async function runWithOpenAICallTracking<T>(fn: () => Promise<T>): Promise<T> {
  return callTrackingStorage.run({ calls: [] }, fn);
}

/**
 * P3-6: label every call made inside `fn` with an explicit role.
 *
 * Applied only at the few chokepoints whose role the model id cannot reveal (see `attributeRole`).
 * A no-op outside a tracking context, and it inherits the enclosing context's `calls` array so a
 * labelled section still records into the same turn.
 */
export async function withModelRole<T>(role: ModelRole, fn: () => Promise<T>): Promise<T> {
  const store = callTrackingStorage.getStore();
  if (!store) return fn();
  return callTrackingStorage.run({ calls: store.calls, role }, fn);
}

/** The calls recorded in the current context, or null when no context is active. */
export function getTrackedOpenAICalls(): TrackedOpenAICall[] | null {
  return callTrackingStorage.getStore()?.calls ?? null;
}

/**
 * Map a model id back to the role that requested it.
 *
 * WHY A REVERSE MAP RATHER THAN THREADING A LABEL THROUGH 30 CALL SITES. Every site already
 * imports a role-specific frozen const (`OPENAI_CLASSIFIER_MODEL` and friends, resolved once in
 * `openaiClient`), so the requested model id ALREADY encodes the role — but only when roles
 * resolve to distinct models. In the default config every chat-family role collapses onto
 * `gpt-4o`, and the map is ambiguous exactly there.
 *
 * That ambiguity is self-correcting in the direction that matters: the moment an operator tiers a
 * role (which is the entire point of this item), that role's calls become attributable for free.
 * For the default config the handful of `withModelRole` labels cover the roles whose cost you need
 * to separate anyway — the main generation, eval, intent, vision, product import — leaving the
 * unlabelled remainder to be exactly what it is: the classifier fan-out.
 *
 * Ambiguous ⇒ `null`, never a guess. A confidently wrong role would corrupt the per-role split
 * that a downgrade decision reads, which is worse than an honest gap.
 */
function buildRoleByModel(): Map<string, ModelRole | null> {
  const byModel = new Map<string, ModelRole | null>();
  for (const role of Object.keys(MODEL_ROLES) as ModelRole[]) {
    const model = resolveModel(role);
    if (!model) continue;
    // Second role claiming the same id ⇒ ambiguous. Record the ambiguity rather than the winner.
    byModel.set(model, byModel.has(model) ? null : role);
  }
  return byModel;
}

const ROLE_BY_MODEL = buildRoleByModel();

/**
 * Resolve a call's role: the explicit ALS label wins, else the reverse map on the REQUESTED id.
 *
 * Requested, not served: `served` is a dated snapshot (`gpt-4o-2024-08-06`) that no role's env var
 * ever names, so matching on it would miss every time. A tenant's `custom_model_id` is likewise
 * unmapped and correctly falls through to `null` unless labelled.
 */
export function attributeRole(
  requested: string | null,
  labelled: ModelRole | undefined,
  roleByModel: Map<string, ModelRole | null> = ROLE_BY_MODEL,
): ModelRole | null {
  if (labelled) return labelled;
  if (!requested) return null;
  return roleByModel.get(requested) ?? null;
}

function recordCall(kind: string, requestedModel: unknown, response: unknown): void {
  try {
    const store = callTrackingStorage.getStore();
    if (!store) return;
    const r = response as {
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number } | null;
      } | null;
    } | null;
    const served = typeof r?.model === 'string' ? r.model : null;
    const usage = r?.usage ?? null;
    const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null;
    const completionTokens =
      typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null;
    const totalTokens = typeof usage?.total_tokens === 'number' ? usage.total_tokens : null;
    const rawCached = usage?.prompt_tokens_details?.cached_tokens;
    const cachedTokens = typeof rawCached === 'number' ? rawCached : null;
    const requested = typeof requestedModel === 'string' ? requestedModel : null;
    store.calls.push({
      kind,
      requested,
      served,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      cached_tokens: cachedTokens,
      role: attributeRole(requested, store.role),
      usd_cost: computeCost(served ?? requested, {
        prompt_tokens: promptTokens ?? 0,
        completion_tokens: completionTokens ?? 0,
        cached_tokens: cachedTokens ?? 0,
      }),
    });
  } catch {
    // Recording must never affect the call itself.
  }
}

/**
 * Wrap the singleton's `chat.completions.create` + `embeddings.create` with the recorder.
 * Idempotent (safe if imported twice) and transparent: same arguments, same return, same
 * throw behaviour. Streaming requests (`body.stream === true`) pass through unrecorded.
 */
const INSTRUMENTED = Symbol.for('hillside.openaiCallTracker.instrumented');

export function instrumentOpenAIClient(client: OpenAI): void {
  const marker = client as unknown as Record<symbol, boolean>;
  if (marker[INSTRUMENTED]) return;
  marker[INSTRUMENTED] = true;

  const chat = client.chat.completions as unknown as {
    create: (body: unknown, options?: unknown) => Promise<unknown>;
  };
  const origChatCreate = chat.create.bind(client.chat.completions);
  chat.create = async (body: unknown, options?: unknown) => {
    const result = await origChatCreate(body, options);
    const b = body as { model?: unknown; stream?: unknown } | null;
    if (b?.stream !== true) recordCall('chat', b?.model, result);
    return result;
  };

  const embeddings = client.embeddings as unknown as {
    create: (body: unknown, options?: unknown) => Promise<unknown>;
  };
  const origEmbeddingsCreate = embeddings.create.bind(client.embeddings);
  embeddings.create = async (body: unknown, options?: unknown) => {
    const result = await origEmbeddingsCreate(body, options);
    recordCall('embedding', (body as { model?: unknown } | null)?.model, result);
    return result;
  };
}
