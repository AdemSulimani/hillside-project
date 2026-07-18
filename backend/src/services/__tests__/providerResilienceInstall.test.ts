/**
 * P2-6 (RC-19/RC-04) — the seam wrapper: fault-injection coverage for the per-call cap, the shared
 * per-turn deadline, the breaker precheck, and signal composition.
 *
 * Runs in CI (`npm test`) with no OpenAI, no Redis and no DB: the client is a duck-typed literal
 * cast to the SDK type (the `openaiCallTracker.test.ts` pattern — `openaiClient.ts` must never be
 * imported by a test, it throws at module load without OPENAI_API_KEY), and every knob read plus the
 * timer pair arrives through the injected deps bag (the `failedJobOrchestration.test.ts` `Effects`
 * pattern). No `process.env` mutation anywhere: `node:test` isolates FILES, not `it`s, so one missed
 * restore would silently reconfigure every later case in this file.
 *
 * Timers are real but tiny, and the "hangs until aborted" fake is the same device
 * `retrievalReliability.test.ts` uses (`hangingEmbed`) — the repo has no fake timers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import {
  ProviderBreaker,
  ProviderUnavailableError,
  runWithTurnResilience,
  turnProviderFailures,
  type BreakerMode,
} from '../providerResilience';
import { installProviderResilience, type ResilienceDeps } from '../providerResilienceInstall';

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

type ChatBehaviour =
  | { kind: 'ok' }
  | { kind: 'throw'; error: unknown }
  /** Never settles on its own — only an abort ends it (simulates a provider slower than the cap). */
  | { kind: 'hang' };

/**
 * A duck-typed OpenAI client. Records the options it was handed so signal composition is directly
 * assertable, and counts calls so "fast-fail never reached the SDK" is provable rather than implied.
 */
function fakeClient(behaviour: () => ChatBehaviour) {
  const calls: { body: unknown; options: unknown }[] = [];
  const client = {
    chat: {
      completions: {
        async create(body: unknown, options?: unknown) {
          calls.push({ body, options });
          const b = behaviour();
          if (b.kind === 'throw') throw b.error;
          if (b.kind === 'hang') {
            const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
            return new Promise((_, reject) => {
              // A REAL SDK error instance. A fabricated `{name:'APIUserAbortError'}` is the one
              // shape the SDK never produces (it inherits `Error.prototype.name === 'Error'`), and
              // faking it here previously hid a live bug behind a green test.
              signal?.addEventListener('abort', () => reject(new OpenAI.APIUserAbortError({})), {
                once: true,
              });
            });
          }
          return { model: 'gpt-4o', usage: { total_tokens: 1 }, choices: [{ message: { content: 'ok' } }] };
        },
      },
    },
    embeddings: {
      async create(body: unknown, options?: unknown) {
        calls.push({ body, options });
        return { model: 'text-embedding-3-small', data: [{ embedding: [1, 2, 3] }] };
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

function makeDeps(over: Partial<ResilienceDeps> = {}): ResilienceDeps & { timers: { set: number; cleared: number } } {
  const timers = { set: 0, cleared: 0 };
  return {
    breaker: new ProviderBreaker({
      failureThreshold: 3,
      cooldownMs: 5_000,
      halfOpenProbes: 1,
      now: () => Date.now(),
    }),
    readMode: () => 'off' as BreakerMode,
    readCallCapMs: () => 0,
    readForcedError: () => '',
    // Counting the pair is the only way to pin timer hygiene here: with real timers, a missing
    // clearTimeout does not fail an `aborted === false` assertion — it just leaves a pending timer
    // that fires later and the test passes anyway. Leak-by-accumulation is exactly why the wrapper
    // owns its controller instead of using AbortSignal.timeout.
    setTimer: (fn, ms) => { timers.set++; return setTimeout(fn, ms); },
    clearTimer: (h) => { timers.cleared++; clearTimeout(h as NodeJS.Timeout); },
    timers,
    ...over,
  } as ResilienceDeps & { timers: { set: number; cleared: number } };
}

/** Each install must get a FRESH client — the marker symbol makes installation once-per-object. */
function installed(behaviour: () => ChatBehaviour, over: Partial<ResilienceDeps> = {}) {
  const { client, calls } = fakeClient(behaviour);
  const deps = makeDeps(over);
  installProviderResilience(client, deps);
  return { client, calls, deps };
}

const chat = (client: OpenAI, options?: unknown) =>
  (client.chat.completions as unknown as { create: (b: unknown, o?: unknown) => Promise<unknown> })
    .create({ model: 'gpt-4o' }, options);

// ---------------------------------------------------------------------------
// Transparency + the turn boundary.
// ---------------------------------------------------------------------------

describe('installProviderResilience — transparency', () => {
  it('is a pass-through on success inside a turn', async () => {
    const { client, calls } = installed(() => ({ kind: 'ok' }));
    const result = await runWithTurnResilience(0, () => chat(client));
    assert.equal((result as { model: string }).model, 'gpt-4o');
    assert.equal(calls.length, 1);
  });

  it('is idempotent — a second install does not double-wrap', async () => {
    const { client, calls, deps } = installed(() => ({ kind: 'ok' }));
    installProviderResilience(client, deps);
    await runWithTurnResilience(0, () => chat(client));
    assert.equal(calls.length, 1);
  });

  // THE blast-radius guarantee. The API and all five BullMQ workers share one process, so without
  // this a nightly product import or the embeddings reconcile cron would be governed by — and could
  // trip — the customer reply path's breaker. Product import is worst: its catch falls back to
  // non-AI parsing and still returns 201, so a fast-failed import SUCCEEDS with attribute-less rows.
  it('outside a turn: pure pass-through — no cap, no breaker, no recording', async () => {
    const { client, calls, deps } = installed(() => ({ kind: 'throw', error: { status: 503 } }), {
      readMode: () => 'on',
      readCallCapMs: () => 5,
    });
    // Open the breaker first: even so, a non-turn call must still be attempted.
    for (let i = 0; i < 3; i++) deps.breaker.recordFailure('chat', 'provider_error', 'on');
    assert.equal(deps.breaker.stateOf('chat'), 'open');

    await assert.rejects(() => chat(client), (e: { status?: number }) => e.status === 503);
    assert.equal(calls.length, 1, 'the call reached the SDK despite the open breaker');
    assert.equal(deps.timers.set, 0, 'no cap applied outside a turn');
  });
});

// ---------------------------------------------------------------------------
// The breaker precheck.
// ---------------------------------------------------------------------------

describe('installProviderResilience — breaker', () => {
  it('open + on ⇒ fast-fails without ever reaching the SDK', async () => {
    const { client, calls, deps } = installed(() => ({ kind: 'ok' }), { readMode: () => 'on' });
    for (let i = 0; i < 3; i++) deps.breaker.recordFailure('chat', 'provider_error', 'on');

    await runWithTurnResilience(0, async () => {
      await assert.rejects(
        () => chat(client),
        (e: ProviderUnavailableError) =>
          e instanceof ProviderUnavailableError && e.cause === 'breaker_open',
      );
      assert.deepEqual(turnProviderFailures(), [{ kind: 'chat', cause: 'breaker_open' }]);
    });
    assert.equal(calls.length, 0, 'nothing was dialed');
  });

  it('open + monitor ⇒ still calls (bake-in changes nothing)', async () => {
    const { client, calls, deps } = installed(() => ({ kind: 'ok' }), { readMode: () => 'monitor' });
    for (let i = 0; i < 3; i++) deps.breaker.recordFailure('chat', 'provider_error', 'monitor');
    assert.equal(deps.breaker.stateOf('chat'), 'open');

    await runWithTurnResilience(0, () => chat(client));
    assert.equal(calls.length, 1);
  });

  // The step-1/2/6-always-run rule. An earlier sketch returned early when no cap applied, which
  // meant `monitor` with the (default) caps off recorded ZERO would-open events against a totally
  // dead provider — so the promotion gate "monitor shows a clean baseline" would pass VACUOUSLY and
  // promote to `on` on no evidence.
  it('records failures even with NO cap configured, so monitor mode cannot pass vacuously', async () => {
    let opened = false;
    const breaker = new ProviderBreaker({
      failureThreshold: 3,
      cooldownMs: 5_000,
      halfOpenProbes: 1,
      now: () => Date.now(),
      onTransition: (t) => { if (t.to === 'open') opened = true; },
    });
    const { client } = installed(() => ({ kind: 'throw', error: { status: 503 } }), {
      breaker,
      readMode: () => 'monitor',
      readCallCapMs: () => 0, // no cap — the default
    });

    await runWithTurnResilience(0, async () => {          // no turn deadline either — also default
      for (let i = 0; i < 3; i++) {
        await assert.rejects(() => chat(client));
      }
    });
    assert.equal(opened, true, 'a dead provider produced a would-open event with every cap off');
  });

  it('a 429 that SURFACES is recorded on the turn but never opens the breaker', async () => {
    const { client, deps } = installed(() => ({ kind: 'throw', error: { status: 429 } }), {
      readMode: () => 'on',
    });
    await runWithTurnResilience(0, async () => {
      for (let i = 0; i < 5; i++) await assert.rejects(() => chat(client));
      assert.equal(turnProviderFailures().length, 5, 'the turn saw them (the reply is unguarded)');
    });
    assert.equal(deps.breaker.stateOf('chat'), 'closed', 'but the provider is up — do not open');
  });

  /**
   * The honest limit of the rule above, found by driving the REAL SDK against a fake provider
   * rather than by reasoning about it.
   *
   * OpenAI answers a 429 with `retry-after: 30`. The SDK swallows that 429 and sleeps for the full
   * header value inside its retry loop — and that sleep is a plain `setTimeout` that ignores our
   * signal. So the 429 NEVER SURFACES to the wrapper: our cap fires first and the call is a
   * `call_timeout`, which counts. Pinned deliberately, because it looks like a bug and is not: a
   * provider throttling us so hard that no call completes within the budget is unusable, and the
   * "don't let a bulk import open the reply breaker" concern is handled by turn-scoping instead.
   */
  it('a 429 hidden behind a long retry-after backoff surfaces as call_timeout, and DOES count', async () => {
    const { client, deps } = installed(() => ({ kind: 'hang' }), { // hang = the SDK's backoff sleep
      readMode: () => 'on',
      readCallCapMs: () => 10,
    });
    await runWithTurnResilience(0, async () => {
      for (let i = 0; i < 3; i++) await assert.rejects(() => chat(client));
      assert.equal(turnProviderFailures()[0]?.cause, 'call_timeout', 'not rate_limit — we never saw the 429');
    });
    assert.equal(deps.breaker.stateOf('chat'), 'open');
  });

  it('a 4xx is neither recorded nor counted', async () => {
    const { client, deps } = installed(() => ({ kind: 'throw', error: { status: 400 } }), {
      readMode: () => 'on',
    });
    await runWithTurnResilience(0, async () => {
      await assert.rejects(() => chat(client));
      assert.deepEqual(turnProviderFailures(), []);
    });
    assert.equal(deps.breaker.stateOf('chat'), 'closed');
  });
});

// ---------------------------------------------------------------------------
// Cap, deadline, signal composition, timer hygiene.
// ---------------------------------------------------------------------------

describe('installProviderResilience — cap + deadline', () => {
  it('the per-call cap aborts a hanging call and records call_timeout', async () => {
    const { client, deps } = installed(() => ({ kind: 'hang' }), {
      readMode: () => 'on',
      readCallCapMs: () => 10,
    });
    await runWithTurnResilience(0, async () => {
      await assert.rejects(() => chat(client));
      assert.deepEqual(turnProviderFailures(), [{ kind: 'chat', cause: 'call_timeout' }]);
    });
    assert.equal(deps.timers.set, deps.timers.cleared, 'every timer was cleared');
  });

  it('an exhausted turn budget fast-fails WITHOUT dialing, and never blames the provider', async () => {
    const { client, calls, deps } = installed(() => ({ kind: 'ok' }), { readMode: () => 'on' });
    // A 1ms budget, already spent by the time the call happens.
    await runWithTurnResilience(1, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await assert.rejects(
        () => chat(client),
        (e: ProviderUnavailableError) => e.cause === 'turn_starved',
      );
    });
    assert.equal(calls.length, 0, 'no point dialing with no budget left');
    // turn_starved is a statement about US, not the provider. Counting it would let one slow turn
    // open the breaker fleet-wide.
    assert.equal(deps.breaker.stateOf('chat'), 'closed');
  });

  it('the turn budget bounds a call even when the per-call cap is larger', async () => {
    const { client } = installed(() => ({ kind: 'hang' }), {
      readMode: () => 'on',
      readCallCapMs: () => 60_000, // would never fire
    });
    await runWithTurnResilience(15, async () => {
      await assert.rejects(() => chat(client)); // the 15ms turn budget is the binding constraint
      // P2-6-F2: the turn budget won, so the cause is turn_truncated (recorded, never counted) —
      // a sliver timeout is a statement about our budget, not provider health.
      assert.equal(turnProviderFailures()[0]?.cause, 'turn_truncated');
    });
  });

  // detectSpecifiedAttributes passes its own 6s signal. Composition must PRESERVE it — replacing it
  // would silently remove a bound a call site deliberately chose.
  it("composes with a caller's own signal; the tighter bound wins", async () => {
    const { client, calls } = installed(() => ({ kind: 'hang' }), {
      readMode: () => 'on',
      readCallCapMs: () => 60_000,
    });
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 10);

    await runWithTurnResilience(0, async () => {
      await assert.rejects(() => chat(client, { signal: caller.signal }));
      // The caller's abort is that call site's own business, not evidence about the provider.
      assert.deepEqual(turnProviderFailures(), []);
    });
    const passed = (calls[0]?.options as { signal?: AbortSignal }).signal;
    assert.ok(passed, 'a composed signal reached the SDK');
    assert.equal(passed.aborted, true);
  });

  it('passes options through untouched when no cap applies (undefined stays undefined)', async () => {
    const { client, calls } = installed(() => ({ kind: 'ok' }), { readCallCapMs: () => 0 });
    await runWithTurnResilience(0, () => chat(client));
    assert.equal(calls[0]?.options, undefined);
  });

  it('preserves other option fields when composing a signal', async () => {
    const { client, calls } = installed(() => ({ kind: 'ok' }), { readCallCapMs: () => 5_000 });
    await runWithTurnResilience(0, () => chat(client, { headers: { 'x-test': '1' } }));
    const opts = calls[0]?.options as { headers?: unknown; signal?: AbortSignal };
    assert.deepEqual(opts.headers, { 'x-test': '1' });
    assert.ok(opts.signal);
  });

  it('clears the timer on the success path too (no leak per successful call)', async () => {
    const { client, deps } = installed(() => ({ kind: 'ok' }), { readCallCapMs: () => 5_000 });
    await runWithTurnResilience(0, async () => {
      for (let i = 0; i < 5; i++) await chat(client);
    });
    assert.equal(deps.timers.set, 5);
    assert.equal(deps.timers.cleared, 5);
  });

  it('embeddings go through the same policy', async () => {
    const { client, deps } = installed(() => ({ kind: 'ok' }), { readMode: () => 'on' });
    for (let i = 0; i < 3; i++) deps.breaker.recordFailure('embedding', 'provider_error', 'on');
    await runWithTurnResilience(0, async () => {
      await assert.rejects(
        () => (client.embeddings as unknown as { create: (b: unknown) => Promise<unknown> })
          .create({ model: 'text-embedding-3-small', input: 'x' }),
        (e: ProviderUnavailableError) => e.cause === 'breaker_open',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// P2-6-F2 — which bound won decides whether the breaker may count the timeout.
// ---------------------------------------------------------------------------

describe('P2-6-F2: budget-sliver truncation never opens the breaker', () => {
  it('turn budget below the cap: timeout is turn_truncated, recorded for degradation, uncounted', async () => {
    const { client, deps } = installed(() => ({ kind: 'hang' }), {
      readMode: () => 'on' as BreakerMode,
      readCallCapMs: () => 10_000, // generous cap — the tiny turn budget is the binding bound
    });

    // Four separate turns (threshold is 3), one truncated call each: if truncation counted, the
    // breaker would be open by turn 4.
    for (let turn = 0; turn < 4; turn++) {
      await runWithTurnResilience(40, async () => {
        await assert.rejects(
          () => chat(client),
          (e: ProviderUnavailableError) => e.cause === 'turn_truncated',
        );
        const causes = turnProviderFailures().map((f) => f.cause);
        assert.deepEqual(causes, ['turn_truncated'], 'recorded for the degradation floor');
      });
    }

    assert.notEqual(deps.breaker.decide('chat', 'on'), 'reject', 'breaker must stay closed');
  });

  it('cap-won timeout (remaining budget above the cap) still counts and opens', async () => {
    const { client, deps } = installed(() => ({ kind: 'hang' }), {
      readMode: () => 'on' as BreakerMode,
      readCallCapMs: () => 15, // the cap is the binding bound; the 10s turn budget is generous
    });

    await runWithTurnResilience(10_000, async () => {
      for (let i = 0; i < 3; i++) {
        await assert.rejects(
          () => chat(client),
          (e: ProviderUnavailableError) => e.cause === 'call_timeout',
        );
      }
      // Threshold 3 reached on genuine full-cap elapses: the next decision must fast-fail.
      assert.equal(deps.breaker.decide('chat', 'on'), 'reject');
    });
  });
});
