/**
 * P2-6 (RC-19, RC-04) — provider-failure isolation: the pure core.
 *
 * THE PROBLEM (audit SPOF-3). One OpenAI provider, no fallback, no breaker, no per-call abort —
 * and a pipeline that degrades INCOHERENTLY. A single reply fans out to ~25 serialized calls, each
 * inheriting `OPENAI_TIMEOUT_MS` (60s) x (1 + OPENAI_MAX_RETRIES) ≈ 240s. During a blip the same
 * turn fails OPEN on the sensitive path (a refund demand becomes a sales reply — RC-19) and CLOSED
 * on the gap gate (every product question escalates — RC-01), while holding a per-tenant slot and a
 * per-conversation lock whose 300s TTL is never renewed.
 *
 * THE SHAPE. This module is pure: a decision table, a state machine over an INJECTED clock, and an
 * AsyncLocalStorage turn store. All IO — wrapping the SDK, timers, aborts — lives in
 * `providerResilienceInstall.ts`. That split is the house pattern (`sensitivePathFailClosed.ts` +
 * `runSensitiveDetector`, `failureClassifier.ts`/`failedJobOrchestration.ts` + `failureHandler.ts`):
 * the load-bearing rules stay unit-testable with no live provider, no Redis, and — because the
 * clock is a constructor argument — no sleeping. The repo has no fake timers and no mocking
 * framework; injecting the clock as a value is how `webhookDelivery.test.ts` does it.
 *
 * TWO DECISIONS WORTH THE COMMENT, because both are counter-intuitive and both were found by
 * tracing real failures rather than reasoning from the pattern:
 *
 *  1. THE FLOOR IS DECIDED AT THE TURN LEVEL, FROM A COUNTER — NEVER FROM AN EXCEPTION.
 *     A `ProviderUnavailableError` cannot be caught reliably: ~21 classifiers in aiService.ts wrap
 *     their call in `try/catch` and return a fail-open default (`classifySpeculativeHealthAdvice`
 *     returns `false` — i.e. "no unsafe advice here" — for ANY error), and the sensitive umbrella
 *     at processAIReply.ts swallows what escapes them. Worse, `generateReply` runs FIRST and is the
 *     largest budget consumer, so deadline exhaustion preferentially starves the GUARDS while
 *     preserving the reply: a fast unguarded reply where today we'd get a slow guarded one. So the
 *     wrapper RECORDS every failure into the turn store and the pre-send gate reads the counter.
 *     That is immune to both the fail-open catches and the umbrella swallow.
 *
 *  2. THE BREAKER CLASSIFIES BY CAUSE TRACKED IN WRAPPER SCOPE, NEVER BY SNIFFING THE ERROR.
 *     Our own deadline abort surfaces as the SAME `APIUserAbortError` a caller's 6s abort does
 *     (`detectSpecifiedAttributes`), and it carries `status === undefined`. Counting our own aborts
 *     would let one slow fan-out-heavy turn open the breaker against a provider that was never
 *     down — degradation causing degradation. Only the wrapper knows why a call ended, so only the
 *     wrapper may say. See {@link ProviderFailureCause}.
 *
 * INVARIANT — LEAF MODULE: no SDK import, no DB/Redis, no module-load throw. `openaiClient.ts`
 * imports this transitively, and `openaiClient` throws at load without OPENAI_API_KEY, so anything
 * reachable from it must stay importable by a test that has no API key.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

// ---------------------------------------------------------------------------
// Failure taxonomy.
// ---------------------------------------------------------------------------

/**
 * Why a call ended badly. Assigned by the wrapper from what IT did, never inferred from the error.
 *
 * `rate_limit` is deliberately NOT a breaker failure: a 429 means the provider is UP and throttling
 * our own burst. It is still recorded in the turn store — a turn whose guards were skipped because
 * of a 429 is just as unguarded as one skipped by an outage.
 *
 * HONEST LIMIT, measured against the real SDK rather than assumed: this rule only holds for a 429
 * that SURFACES to us. When OpenAI sends `retry-after: 30`, the SDK swallows the 429 and sleeps for
 * the full header value inside its retry loop (`client.js` retryRequest → `internal/utils/sleep.js`,
 * a plain non-abort-aware setTimeout), so with any shorter call cap OUR deadline fires first and the
 * call is classified `call_timeout` — which DOES count. That is deliberate, not a leak: a provider
 * throttling us so hard that no call can complete within the budget is, from the reply path's
 * vantage point, unusable, and fast-failing to the degradation floor beats burning the cap on every
 * one of a turn's ~25 calls. The reason the 429 rule exists at all — "a bulk import must not open
 * the customer reply path's breaker" — is enforced far more strongly by TURN-SCOPING: imports and
 * crons run outside a turn, where the wrapper never records or consults the breaker at all.
 *
 * REFINEMENT (P2-6-F2): `call_timeout` counts ONLY when the per-call cap was the binding bound. A
 * call truncated because the TURN budget had shrunk below the cap (or when no cap is configured at
 * all) is classified `turn_truncated` — recorded for the degradation floor, never counted. The
 * distinction is rule 2 above taken seriously: a turn that spent its own budget says nothing about
 * provider health, and a ~5-classifier Promise.all fan-out aborting on budget slivers would
 * otherwise accumulate `failureThreshold` counted failures inside ONE turn and open the breaker
 * against a healthy provider — degradation causing degradation.
 */
export type ProviderFailureCause =
  /** Provider returned 5xx, or the connection failed/timed out on its own. The breaker's signal. */
  | 'provider_error'
  /** OUR per-call cap fired. Provider health unknown-but-suspect: it was slower than we allow. */
  | 'call_timeout'
  /** The turn's shared budget was already spent. Says nothing about the provider — never counted. */
  | 'turn_starved'
  /**
   * OUR deadline fired, but the binding bound was the TURN budget (remaining < call cap, or no cap
   * configured) — the call got a sliver, not a fair cap. A statement about us — never counted.
   */
  | 'turn_truncated'
  /** The breaker was open, so we never dialed. Never counted (it IS the breaker's own output). */
  | 'breaker_open'
  /** Provider returned 429. Provider is up; this is our own burst. Never counted. */
  | 'rate_limit';

/** Causes that are evidence the PROVIDER is unhealthy. Everything else is evidence about US. */
const BREAKER_COUNTED: ReadonlySet<ProviderFailureCause> = new Set<ProviderFailureCause>([
  'provider_error',
  'call_timeout',
]);

export function countsTowardBreaker(cause: ProviderFailureCause): boolean {
  return BREAKER_COUNTED.has(cause);
}

/**
 * Classify a thrown value from the OpenAI SDK, given what the WRAPPER knows about the call.
 *
 * `ourAbortFired` is the wrapper's own bookkeeping — it is the whole reason this is not a pure
 * error-sniff. The SDK throws `APIUserAbortError` for both our abort and the caller's, and
 * `status === undefined` on it, so the error alone cannot distinguish "we gave up" from "OpenAI is
 * down". A caller's own abort (e.g. detectSpecifiedAttributes' 6s bound) is that call site's
 * business and is NOT a provider signal — it returns `null`, meaning "record nothing".
 */
export function classifyProviderError(err: unknown, ourAbortFired: boolean): ProviderFailureCause | null {
  if (err instanceof ProviderUnavailableError) return err.cause;

  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    if (status === 429) return 'rate_limit';
    if (status >= 500) return 'provider_error';
    // 4xx — a malformed request. Won't fix itself on retry and says nothing about provider health.
    return null;
  }

  // No status ⇒ an abort or a transport error. Only the wrapper's own flag can tell them apart.
  if (isAbortLike(err)) return ourAbortFired ? 'call_timeout' : null;

  // A connection error (ECONNRESET, socket hang up, DNS) — the provider is unreachable.
  return 'provider_error';
}

/**
 * True for an abort, from either side.
 *
 * ⚠️ `constructor.name` is NOT redundant with `.name`, and this is the trap. The OpenAI SDK's
 * `APIUserAbortError` is an ES class that never assigns `this.name`, so it INHERITS
 * `Error.prototype.name` and a real instance reports `err.name === 'Error'`:
 *
 *     new OpenAI.APIUserAbortError({}).name             // => 'Error'      (!)
 *     new OpenAI.APIUserAbortError({}).constructor.name // => 'APIUserAbortError'
 *     new OpenAI.APIUserAbortError({}).status           // => undefined
 *
 * Keying on `.name` alone therefore matches NOTHING the SDK actually throws, and
 * `classifyProviderError` would fall through to its transport catch-all and record a routine
 * caller-side abort — P1-4's own 5s embedding timeout, which is designed to degrade INVISIBLY to
 * lexical retrieval — as a provider outage, degrading the turn on a healthy provider.
 *
 * `constructor.name` is checked by string rather than `instanceof` deliberately: this module is a
 * leaf and must not import the SDK (`openaiClient` throws at module load without OPENAI_API_KEY, so
 * anything reachable from it must stay importable by a test with no API key). `AbortError` is the
 * DOMException Node raises for a native abort.
 */
function isAbortLike(err: unknown): boolean {
  const e = err as { name?: unknown; constructor?: { name?: unknown } } | null;
  if (e?.name === 'APIUserAbortError' || e?.name === 'AbortError') return true;
  return e?.constructor?.name === 'APIUserAbortError';
}

/**
 * Thrown when we refuse to dial (breaker open / turn starved) or when our own cap fired.
 *
 * Distinct class rather than reusing `APIUserAbortError`: callers and tests must be able to tell
 * "we decided not to call" from "the SDK aborted", and the SDK's error carries no usable status.
 */
export class ProviderUnavailableError extends Error {
  readonly cause: ProviderFailureCause;
  readonly kind: ProviderCallKind;

  constructor(cause: ProviderFailureCause, kind: ProviderCallKind, message?: string) {
    super(message ?? `OpenAI ${kind} call unavailable (${cause})`);
    this.name = 'ProviderUnavailableError';
    this.cause = cause;
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// The breaker decision table (pure).
// ---------------------------------------------------------------------------

export type ProviderCallKind = 'chat' | 'embedding';
export type BreakerState = 'closed' | 'open' | 'half_open';
export type BreakerMode = 'off' | 'monitor' | 'on';
export type BreakerAction = 'allow' | 'reject' | 'probe';

/**
 * What to do with a call, given the breaker's state and the operator's mode. Pure table lookup —
 * the whole 3x3 matrix is unit-tested exhaustively (mirrors `severityOf` in config/knobs.ts and
 * `decideSensitivePathAction` in sensitivePathFailClosed.ts).
 *
 * Returning a verdict instead of throwing is what makes `monitor` mode testable. An earlier sketch
 * had the wrapper's `precheck()` throw directly, so the monitor-mode test could only assert "does
 * not throw" — an assertion that passes just as happily if the check is a no-op for EVERY mode,
 * including `on`. The bake-in window the audit mandates would then have been pinned by a test that
 * could not fail. Here `('open','monitor') → 'allow'` and `('open','on') → 'reject'` are two
 * `assert.equal`s over the same table.
 */
export function decideBreakerAction(
  state: BreakerState,
  mode: BreakerMode,
  probesInFlight: number,
  maxProbes: number,
): BreakerAction {
  // `off` and `monitor` never change behaviour. monitor still runs the state machine (the wrapper
  // records outcomes regardless) — it just never acts on it. That IS the bake-in.
  if (mode === 'off' || mode === 'monitor') return 'allow';

  switch (state) {
    case 'closed':
      return 'allow';
    case 'open':
      return 'reject';
    case 'half_open':
      // Admit a bounded number of probes; the rest keep fast-failing until one settles.
      return probesInFlight < maxProbes ? 'probe' : 'reject';
    default:
      return 'allow';
  }
}

// ---------------------------------------------------------------------------
// The breaker state machine.
// ---------------------------------------------------------------------------

export interface BreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenProbes: number;
  /** Injected clock. Tests advance a variable; nothing sleeps. */
  now: () => number;
  /** Called on every state change — the wrapper routes this to logger/Sentry. */
  onTransition?: (t: BreakerTransition) => void;
}

export interface BreakerTransition {
  kind: ProviderCallKind;
  from: BreakerState;
  to: BreakerState;
  consecutiveFailures: number;
  /** True when the mode is `monitor`: the transition is recorded but not enforced. */
  observedOnly: boolean;
}

/**
 * Per-kind consecutive-failure breaker, in-process.
 *
 * IN-PROCESS, NOT REDIS-SHARED, on purpose. Sharing state would put breaker writes on the same
 * 192MB `noeviction` Redis that BullMQ needs (SPOF-2), and would make handling an OpenAI outage
 * depend on Redis being up — a failure-handling path that needs a second dependency to work is not
 * a failure-handling path. Each worker learning independently costs at most `failureThreshold`
 * wasted calls per worker per outage, which is the cheaper side of the trade.
 *
 * PER-KIND, NOT GLOBAL. chat and embedding are different endpoints with different load profiles;
 * an embedding backfill saturating its own quota must not fast-fail customer replies.
 */
export class ProviderBreaker {
  private readonly opts: BreakerOptions;
  private readonly state = new Map<ProviderCallKind, KindState>();

  constructor(opts: BreakerOptions) {
    this.opts = opts;
  }

  private kindState(kind: ProviderCallKind): KindState {
    let s = this.state.get(kind);
    if (!s) {
      s = { state: 'closed', consecutiveFailures: 0, openedAt: 0, probesInFlight: 0 };
      this.state.set(kind, s);
    }
    return s;
  }

  /**
   * The live state, after applying any elapsed cooldown. Reading is what promotes open → half_open;
   * there is no timer, so a breaker on an idle worker costs nothing and cannot fire a stray abort.
   *
   * `mode` is taken only so the promotion is labelled honestly: `observedOnly` answers "is the
   * breaker enforcing yet?", which is the whole output of the mandated monitor bake-in, and the
   * ledger snapshot calls this on every reply. Defaulting to `'on'` would report a monitor-mode
   * fleet as enforcing.
   */
  stateOf(kind: ProviderCallKind, mode: BreakerMode = 'on'): BreakerState {
    const s = this.kindState(kind);
    if (s.state === 'open' && this.opts.now() - s.openedAt >= this.opts.cooldownMs) {
      this.transition(kind, s, 'half_open', mode === 'monitor');
    }
    return s.state;
  }

  decide(kind: ProviderCallKind, mode: BreakerMode): BreakerAction {
    const state = this.stateOf(kind, mode); // may promote open → half_open
    const s = this.kindState(kind);
    return decideBreakerAction(state, mode, s.probesInFlight, this.opts.halfOpenProbes);
  }

  /** Mark a probe as in flight. The wrapper calls this when `decide` returned `'probe'`. */
  probeStarted(kind: ProviderCallKind): void {
    this.kindState(kind).probesInFlight += 1;
  }

  probeSettled(kind: ProviderCallKind): void {
    const s = this.kindState(kind);
    s.probesInFlight = Math.max(0, s.probesInFlight - 1);
  }

  recordSuccess(kind: ProviderCallKind, mode: BreakerMode): void {
    if (mode === 'off') return; // see recordFailure — `off` is fully inert
    const s = this.kindState(kind);

    /**
     * ONLY a half-open probe may close an open breaker.
     *
     * The wrapper records a success for EVERY resolved call, and under load there are always calls
     * in flight that passed `decide` while the breaker was still closed (the AI worker runs 5 jobs
     * concurrently and a single turn fans ~5 classifiers out through `Promise.all`, all sharing one
     * process-wide breaker). Such a straggler resolving after the breaker opened is not evidence
     * that the provider recovered — it predates the evidence that opened it. Letting it close the
     * breaker makes a PARTIAL outage flap open→closed→open forever, re-dialing a sick provider and
     * firing a Sentry event on every flap — failing exactly the case the breaker exists for.
     *
     * No lockout risk: `stateOf` still promotes open → half_open once the cooldown elapses, and the
     * probe that follows closes it properly.
     */
    if (s.state === 'open') return;

    s.consecutiveFailures = 0;
    if (s.state !== 'closed') this.transition(kind, s, 'closed', mode === 'monitor');
  }

  /**
   * Record a failure. Only provider-health causes count — see {@link countsTowardBreaker}. A cause
   * that does not count is a no-op here (it is still recorded in the TURN store by the wrapper, so
   * degradation still sees it).
   *
   * `off` is FULLY INERT — it does not even run the machine. That distinction is the whole point of
   * having three modes rather than a bool:
   *   off     — nothing happens. Byte-for-byte legacy.
   *   monitor — the machine runs and reports (would-open events, Sentry), but never fast-fails.
   *   on      — the machine runs, reports, and acts.
   * Recording while `off` would keep `decide` correct (it returns 'allow' for every state) but would
   * still fire `onTransition` → `logger.error` → a SENTRY EVENT for a breaker the operator has
   * switched off, and would show `open` in the ledger's snapshot. "Flag off changes nothing" has to
   * include the alerting, or the first rollback pages someone at 3am about a disabled feature.
   */
  recordFailure(kind: ProviderCallKind, cause: ProviderFailureCause, mode: BreakerMode): void {
    if (mode === 'off') return;
    if (!countsTowardBreaker(cause)) return;
    const s = this.kindState(kind);
    s.consecutiveFailures += 1;

    // A failed half-open probe re-opens immediately: the cooldown restarts rather than requiring
    // another `failureThreshold` failures to re-trip.
    if (s.state === 'half_open' || s.consecutiveFailures >= this.opts.failureThreshold) {
      s.openedAt = this.opts.now();
      if (s.state !== 'open') this.transition(kind, s, 'open', mode === 'monitor');
    }
  }

  private transition(kind: ProviderCallKind, s: KindState, to: BreakerState, observedOnly = false): void {
    const from = s.state;
    if (from === to) return;
    s.state = to;
    if (to === 'closed') s.consecutiveFailures = 0;
    try {
      this.opts.onTransition?.({
        kind,
        from,
        to,
        consecutiveFailures: s.consecutiveFailures,
        observedOnly,
      });
    } catch {
      // Reporting a transition must never break the call that caused it.
    }
  }

  /** Scalars only — safe for the ledger's `guard_verdicts` and for logs. */
  snapshot(mode: BreakerMode = 'on'): Record<string, BreakerState> {
    const out: Record<string, BreakerState> = {};
    for (const kind of this.state.keys()) out[kind] = this.stateOf(kind, mode);
    return out;
  }
}

interface KindState {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  probesInFlight: number;
}

// ---------------------------------------------------------------------------
// The per-turn store (AsyncLocalStorage).
// ---------------------------------------------------------------------------

export interface ProviderFailure {
  kind: ProviderCallKind;
  cause: ProviderFailureCause;
}

interface TurnStore {
  /** Absolute epoch-ms deadline for this turn's OpenAI budget. `null` ⇒ unbounded. */
  deadlineAt: number | null;
  /** Every failure seen this turn — INCLUDING ones a classifier then swallowed into a fail-open. */
  failures: ProviderFailure[];
}

const turnStorage = new AsyncLocalStorage<TurnStore>();

/**
 * Run one AI-reply turn with a shared OpenAI budget + failure ledger.
 *
 * Entered next to `runWithOpenAICallTracking` / `runWithLogContext` in processAIReply. The store is
 * MUTABLE BY REFERENCE (like openaiCallTracker's `store.calls.push`) so `rearmTurnDeadline` can
 * re-arm the budget mid-turn without a second ALS scope — which matters, because the pre-send and
 * post-send halves of `processAIReplyInner` are one 4,000-line function, not two.
 *
 * `budgetMs <= 0` ⇒ no deadline (the knob's kill switch). The store is still created, so failure
 * recording and the degradation gate work with the caps off — that is the intended step-1 rollout.
 *
 * CAVEAT: a fire-and-forget `void (async () => …)()` inherits this context and can outlive the
 * turn. None make OpenAI calls today; one that did would read a stale, exhausted budget and
 * fast-fail forever. Keep provider calls inside the awaited path.
 */
export function runWithTurnResilience<T>(budgetMs: number, fn: () => Promise<T>): Promise<T> {
  return turnStorage.run(
    { deadlineAt: budgetMs > 0 ? Date.now() + budgetMs : null, failures: [] },
    fn,
  );
}

/** The active turn store, or null outside a turn (product imports, crons, the offline eval). */
function turnStore(): TurnStore | null {
  return turnStorage.getStore() ?? null;
}

/** True when a turn is active. Outside one, the wrapper is a pure pass-through. */
export function inTurn(): boolean {
  return turnStorage.getStore() !== undefined;
}

/**
 * Remaining turn budget in ms; `null` when unbounded or outside a turn. Read at CALL time, never
 * captured, so a rearm is visible to every later call in the turn.
 */
export function remainingTurnBudgetMs(nowMs: number = Date.now()): number | null {
  const store = turnStore();
  if (!store || store.deadlineAt === null) return null;
  return store.deadlineAt - nowMs;
}

/**
 * Re-arm the budget for the post-send tail. REARM, not release.
 *
 * The audit's edge case is "the deadline must not abort mid-send (scope to pre-send)" — but simply
 * NULLING the deadline would hand `runOrderDetectionTail()` an unbounded budget, and that tail runs
 * inside the very try whose `finally` releases `ai_conv_lock`. An unbounded tail re-creates the
 * exact lock-expiry defect P2-6 exists to remove. So the tail gets a FRESH budget instead of none.
 *
 * Worst case is therefore 2x the budget against a 300s never-renewed lock — see the knob rationale.
 */
export function rearmTurnDeadline(budgetMs: number): void {
  const store = turnStore();
  if (!store) return;
  store.deadlineAt = budgetMs > 0 ? Date.now() + budgetMs : null;
}

/** Record a provider failure against the current turn. No-op outside a turn. */
export function noteProviderFailure(kind: ProviderCallKind, cause: ProviderFailureCause): void {
  turnStore()?.failures.push({ kind, cause });
}

/**
 * Every provider failure recorded this turn. THE degradation input.
 *
 * Non-empty means at least one OpenAI call this turn did not produce a real answer — whether it
 * fast-failed, timed out, was starved, or errored — regardless of whether some classifier then
 * swallowed it into a confident-looking fail-open default. A reply built on that is a reply whose
 * safety guards silently did not run.
 */
export function turnProviderFailures(): ProviderFailure[] {
  return turnStore()?.failures ?? [];
}

/**
 * The degradation verdict: pure, so the gate is testable without the pipeline.
 *
 * Flag off ⇒ never degrade (byte-for-byte legacy). Flag on ⇒ degrade iff anything failed.
 */
export function shouldDegradeTurn(failures: readonly ProviderFailure[], degradeEnabled: boolean): boolean {
  return degradeEnabled && failures.length > 0;
}

/** Compact, scalar-only summary for the ledger's `guard_verdicts` + logs. No PII. */
export function summarizeTurnFailures(failures: readonly ProviderFailure[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of failures) out[f.cause] = (out[f.cause] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// Config-combination safety (pure — `validateEnv`'s boot posture calls these).
// ---------------------------------------------------------------------------

export interface ProviderPosture {
  degradeEnabled: boolean;
  breakerMode: BreakerMode;
  callCapMs: number;
  turnBudgetMs: number;
  breakerCooldownMs: number;
}

/**
 * The one P2-6 combination that is actively WORSE than shipping nothing.
 *
 * A cap or an open breaker aborts the sensitive detectors like any other call. With the degradation
 * gate off, `runSensitiveDetector` rethrows, the umbrella logs "continuing normal flow", and
 * execution falls through to `generateReply` — so a refund demand receives a cheerful SALES reply.
 * Today that is survivable only because the SDK grinds through ~240s and usually succeeds; a cap
 * makes the abort fast and reliable, i.e. it makes RC-19 *more* likely, not less.
 *
 * Pure and exported so the rule is a tested contract rather than an untested log string — the same
 * split P2-7 uses for `detect`/`applyMode`. `validateEnv` warns (never fatals) on it: a mis-set
 * deploy must not become an outage.
 */
export function enforcementWithoutFloor(p: ProviderPosture): boolean {
  const enforcing = p.callCapMs > 0 || p.turnBudgetMs > 0 || p.breakerMode === 'on';
  return enforcing && !p.degradeEnabled;
}

/**
 * `aiQueue`'s exponential backoff base (ms). Retries land at T+10s and T+30s (attempts: 3).
 * Duplicated as a constant rather than imported: this module is a leaf and must not pull in BullMQ.
 * {@link breakerCooldownOutrunsRetries} is what keeps the duplication honest.
 */
export const AI_QUEUE_BACKOFF_BASE_MS = 10_000;

/**
 * True when the breaker's cooldown spans BullMQ's retry window.
 *
 * The breaker's fast-fail is free, so the retry budget is denominated in ATTEMPTS while the cooldown
 * is denominated in WALL-CLOCK. If the cooldown covers both retries, all three attempts fast-fail
 * without ever re-probing the provider, the job exhausts, and `classifyJobFailure` dead-letters it —
 * so a brief blip DLQs every in-flight reply, each raising a tenant-facing `ai_reply_undelivered`
 * alert. Exactly the outcome the breaker exists to prevent.
 */
export function breakerCooldownOutrunsRetries(p: ProviderPosture): boolean {
  return p.breakerMode === 'on' && p.breakerCooldownMs >= AI_QUEUE_BACKOFF_BASE_MS;
}
