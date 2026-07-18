/**
 * P2-6 (RC-19, RC-04) — provider-failure isolation: the IO wrapper.
 *
 * WHY A SEAM AND NOT 35 CALL SITES. There are ~35 OpenAI SDK call sites; only TWO pass an
 * AbortSignal today (`detectSpecifiedAttributes`' 6s bound and `embeddingService`'s pass-through),
 * and THIRTEEN have no try/catch at all — including `detectCancellationOrRefundIntent`, the RC-19
 * refund path, and `generateReply` itself. Editing each would be a large, high-regression diff that
 * rots the moment someone adds call site #36. Instead we wrap the SDK singleton's
 * `chat.completions.create` + `embeddings.create` ONCE, exactly as `openaiCallTracker` already does
 * for usage accounting — so every current and future call site gets the cap, the deadline, and the
 * breaker for free.
 *
 * TURN-SCOPED ON PURPOSE. Outside an active turn this wrapper is a PURE PASS-THROUGH. The Express
 * API and all five BullMQ workers share one process (`server.ts` imports `jobs/workers`), so a
 * global breaker would let a nightly 5k-product import fast-fail customer replies. The reverse is
 * worse: product import is a synchronous HTTP handler whose catch falls back to non-AI parsing and
 * still returns `201 "N products imported"` — a breaker-fast-failed import would not fail, it would
 * SUCCEED with brand/price/tag-less rows that get embedded and served forever. And there is nothing
 * to protect out there anyway: BullMQ renews its own job lock; only `ai_conv_lock` is un-renewed.
 *
 * WHY BOTH AbortSignal AND Promise.race. The signal alone does not bound the caller. Verified in
 * `node_modules/openai`: `internal/utils/sleep.js` is `new Promise(r => setTimeout(r, ms))` — NOT
 * abort-aware — and `client.js` `retryRequest` honours a server `retry-after` header VERBATIM as
 * the sleep duration. So an abort landing during a `retry-after: 60` backoff is not observed until
 * that sleep finishes. The signal bounds the SOCKET and stops the retry loop (`client.js` checks
 * `options.signal?.aborted` before the retry branch); the race bounds the CALLER'S WALL CLOCK. We
 * need both, and the orphaned promise needs a `.catch()` or Node 22 kills the worker on an
 * unhandled rejection.
 *
 * DEPS ARE INJECTED, NOT READ. Every knob read and the timer pair arrive as parameters, mirroring
 * `failureHandler` → `orchestrateFailedJob(info, err, effects, flags)`. `node:test` isolates FILES,
 * not `it`s, so a wrapper that read `process.env` itself would force every test into a
 * mutate-and-restore dance where one missed restore silently reconfigures the rest of the file.
 * Knob reads live at exactly one site: `openaiClient.ts`.
 */
import type OpenAI from 'openai';
import {
  ProviderBreaker,
  ProviderUnavailableError,
  classifyProviderError,
  inTurn,
  noteProviderFailure,
  remainingTurnBudgetMs,
  type BreakerMode,
  type ProviderCallKind,
} from './providerResilience';

export interface ResilienceDeps {
  breaker: ProviderBreaker;
  /** Re-read per call so an incident can flip the mode without a redeploy. */
  readMode: () => BreakerMode;
  /** Hard cap (ms) on one call including the SDK retry chain. `<= 0` ⇒ no cap. */
  readCallCapMs: () => number;
  /** TEST-ONLY: force every call to fail with this cause. `''` ⇒ inert. */
  readForcedError?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type CreateFn = (body: unknown, options?: unknown) => Promise<unknown>;

/**
 * TEST-ONLY: an abort shaped exactly like the SDK's.
 *
 * The class is NAMED `APIUserAbortError` on purpose, and the name is load-bearing: the real SDK
 * class never assigns `this.name`, so an instance reports `name === 'Error'` and is identifiable
 * only via `constructor.name` (see `isAbortLike`). Fabricating `{name:'APIUserAbortError'}` instead
 * would inject a shape production never produces — and would route the forced fault down a branch
 * the real one never takes, which is precisely how a live bug once passed a green suite.
 * The SDK is not imported here: this module must stay importable without an API key.
 */
class APIUserAbortError extends Error {}
const ForcedAbortError = APIUserAbortError;

const INSTALLED = Symbol.for('hillside.providerResilience.installed');

/**
 * Wrap the singleton's chat + embedding creates with the resilience policy.
 *
 * Idempotent via its OWN symbol — `openaiCallTracker`'s marker is on the same client object, so
 * sharing one would make whichever installed second silently no-op.
 *
 * Install AFTER `instrumentOpenAIClient` so the order is `resilience → tracker → orig`: a
 * fast-failed call never reaches the tracker, which is correct — it records COGS, and a call we
 * refused to make has none. (The tracker records only after `await orig` resolves, so it would
 * record nothing either way; this just makes the intent explicit.)
 */
export function installProviderResilience(client: OpenAI, deps: ResilienceDeps): void {
  const marker = client as unknown as Record<symbol, boolean>;
  if (marker[INSTALLED]) return;
  marker[INSTALLED] = true;

  const chat = client.chat.completions as unknown as { create: CreateFn };
  const origChat = chat.create.bind(client.chat.completions);
  chat.create = (body: unknown, options?: unknown) => guard('chat', origChat, body, options, deps);

  const embeddings = client.embeddings as unknown as { create: CreateFn };
  const origEmbed = embeddings.create.bind(client.embeddings);
  embeddings.create = (body: unknown, options?: unknown) =>
    guard('embedding', origEmbed, body, options, deps);
}

/**
 * The per-call policy.
 *
 * Steps 1, 2 and 6 run even when NO cap applies. That is load-bearing: an earlier sketch returned
 * early when there was no deadline to enforce, which meant `OPENAI_CIRCUIT_BREAKER=monitor` with
 * the (default) caps off recorded ZERO would-open events against a completely dead provider — so
 * the promotion gate ("monitor shows a clean baseline") would have passed vacuously and promoted to
 * `on` on no evidence. Only the AbortController allocation is skipped when there is no cap.
 */
async function guard(
  kind: ProviderCallKind,
  orig: CreateFn,
  body: unknown,
  options: unknown,
  deps: ResilienceDeps,
): Promise<unknown> {
  // Outside a turn: pure pass-through. No cap, no breaker, no recording.
  if (!inTurn()) return orig(body, options);

  const mode = deps.readMode();

  // --- Step 1: ask the breaker before dialing. ---
  const action = deps.breaker.decide(kind, mode);
  if (action === 'reject') {
    noteProviderFailure(kind, 'breaker_open');
    throw new ProviderUnavailableError('breaker_open', kind);
  }
  const isProbe = action === 'probe';
  if (isProbe) deps.breaker.probeStarted(kind);

  try {
    // --- Step 2: budget. min(call cap, remaining turn budget). ---
    const capMs = deps.readCallCapMs();
    const remainingMs = remainingTurnBudgetMs();

    if (remainingMs !== null && remainingMs <= 0) {
      // The turn's budget is already spent. Fast-fail WITHOUT dialing — and note that this is a
      // statement about us, not the provider, so it never counts toward the breaker.
      noteProviderFailure(kind, 'turn_starved');
      throw new ProviderUnavailableError('turn_starved', kind);
    }

    const effectiveMs = smallestPositive(capMs, remainingMs);
    // P2-6-F2: which bound is binding? When the turn budget shrank below the per-call cap (or no
    // cap is configured), a timeout is a statement about OUR budget, not provider health — it is
    // classified `turn_truncated` and never counts toward the breaker. Only a full-cap elapse is
    // provider evidence. Mirrors `smallestPositive` semantics (non-positive cap = no cap).
    const capApplies = capMs !== null && capMs > 0;
    const turnBudgetWon =
      remainingMs !== null && remainingMs > 0 && (!capApplies || remainingMs < (capMs as number));
    const ourAbortCause = turnBudgetWon ? ('turn_truncated' as const) : ('call_timeout' as const);
    const forced = deps.readForcedError?.() ?? '';

    // --- Steps 3-5: abort + race + always clear the timer. ---
    const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));

    let ourAbortFired = false;
    let timer: unknown;
    let controller: AbortController | null = null;

    try {
      let callOptions = options;
      if (effectiveMs !== null) {
        controller = new AbortController();
        const callerSignal = (options as { signal?: AbortSignal } | undefined)?.signal;
        // Compose rather than replace: `detectSpecifiedAttributes` passes its own 6s signal and
        // must keep it — whichever bound is tighter wins. `{...undefined}` is legal and yields {}.
        const signal = callerSignal
          ? AbortSignal.any([callerSignal, controller.signal])
          : controller.signal;
        callOptions = { ...(options as object | undefined), signal };
      }

      // TEST-ONLY fault injection (P0-4's TEST_FORCE_DETECTOR_ERROR idiom). `timeout` HANGS rather
      // than rejecting, so the forced failure takes exactly the production path — the deadline
      // fires, `ourAbortFired` is set, and the cause is classified for real. Rejecting immediately
      // would bypass the very mechanism under test.
      const call = forced ? forcedCall(forced, controller) : orig(body, callOptions);

      let result: unknown;
      if (effectiveMs === null) {
        result = await call;
      } else {
        const ctl = controller!;
        // The race is what actually bounds the caller: a `retry-after` backoff sleep is not
        // abort-aware, so the signal alone can overshoot by the length of that sleep.
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimer(() => {
            ourAbortFired = true;
            ctl.abort();
            reject(new ProviderUnavailableError(ourAbortCause, kind));
          }, effectiveMs);
        });
        // The orphan MUST be caught: once the race settles on the deadline, an unhandled rejection
        // from the abandoned call would take the worker down on Node 22.
        void call.catch(() => undefined);
        result = await Promise.race([call, deadline]);
      }

      deps.breaker.recordSuccess(kind, mode);
      return result;
    } catch (err) {
      // --- Step 6: record. Cause comes from OUR bookkeeping, never from sniffing the error. ---
      let cause = classifyProviderError(err, ourAbortFired);
      // The abort-race fallback (the SDK's abort rejection winning the race over our deadline
      // rejection) classifies a wrapper abort as call_timeout; apply the same bound-won rule.
      if (cause === 'call_timeout' && ourAbortFired && turnBudgetWon) cause = 'turn_truncated';
      if (cause) {
        noteProviderFailure(kind, cause);
        deps.breaker.recordFailure(kind, cause, mode);
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimer(timer);
    }
  } finally {
    if (isProbe) deps.breaker.probeSettled(kind);
  }
}

/** The tighter of the two bounds; `null` when neither applies. Ignores non-positive caps (= off). */
function smallestPositive(capMs: number, remainingMs: number | null): number | null {
  const cap = capMs > 0 ? capMs : null;
  if (cap === null) return remainingMs;
  if (remainingMs === null) return cap;
  return Math.min(cap, remainingMs);
}

/**
 * TEST-ONLY: shape a forced failure like the real thing, so the injected fault takes the production
 * path rather than a shortcut.
 *
 * `unavailable`/`rate_limit` reject with a `status`, exactly as the SDK's APIError does, so
 * `classifyProviderError`'s real status branch decides. `timeout` HANGS until our own abort fires —
 * which is the only way to exercise the deadline + `ourAbortFired` bookkeeping. With no cap
 * configured a forced `timeout` would hang forever, so it also rejects if there is no controller to
 * abort it.
 */
function forcedCall(kind: string, controller: AbortController | null): Promise<never> {
  if (kind === 'rate_limit') {
    return Promise.reject(Object.assign(new Error('TEST_FORCE_PROVIDER_ERROR: 429'), { status: 429 }));
  }
  if (kind === 'unavailable') {
    return Promise.reject(Object.assign(new Error('TEST_FORCE_PROVIDER_ERROR: 503'), { status: 503 }));
  }
  if (!controller) {
    return Promise.reject(
      Object.assign(new Error('TEST_FORCE_PROVIDER_ERROR: timeout (no cap configured)'), { status: 503 }),
    );
  }
  return new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new ForcedAbortError('TEST_FORCE_PROVIDER_ERROR: timeout')),
      { once: true },
    );
  });
}
