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
}

interface CallTrackingContext {
  calls: TrackedOpenAICall[];
}

const callTrackingStorage = new AsyncLocalStorage<CallTrackingContext>();

/** Run `fn` with an active call-tracking context (one per AI-reply job). */
export async function runWithOpenAICallTracking<T>(fn: () => Promise<T>): Promise<T> {
  return callTrackingStorage.run({ calls: [] }, fn);
}

/** The calls recorded in the current context, or null when no context is active. */
export function getTrackedOpenAICalls(): TrackedOpenAICall[] | null {
  return callTrackingStorage.getStore()?.calls ?? null;
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
      } | null;
    } | null;
    const served = typeof r?.model === 'string' ? r.model : null;
    const usage = r?.usage ?? null;
    const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null;
    const completionTokens =
      typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null;
    const totalTokens = typeof usage?.total_tokens === 'number' ? usage.total_tokens : null;
    store.calls.push({
      kind,
      requested: typeof requestedModel === 'string' ? requestedModel : null,
      served,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      usd_cost: computeCost(served ?? (typeof requestedModel === 'string' ? requestedModel : null), {
        prompt_tokens: promptTokens ?? 0,
        completion_tokens: completionTokens ?? 0,
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
