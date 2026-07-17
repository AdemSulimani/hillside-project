/**
 * P2-6 (RC-19) — the graceful-degradation gate, as a MIRROR test.
 *
 * No test imports `jobs/processAIReply.ts` (it is a 5.8k-line orchestrator that pulls in the whole
 * world); the house convention is to test the composed helpers standalone and re-implement the
 * composition here, exactly as `partialProductAnswer.test.ts` and `gapGateDeterministicFirst.test.ts`
 * do. What is mirrored is the pre-send gate:
 *
 *     const turnFailures = turnProviderFailures();
 *     if (shouldDegradeTurn(turnFailures, GRACEFUL_DEGRADE_MODE)) { degrade(); return; }
 *     rearmTurnDeadline(OPENAI_TURN_DEADLINE_MS);
 *     ...send...
 *
 * THE CASE THIS FILE EXISTS FOR is `a swallowed fail-open still degrades`. Every other assertion
 * here is scaffolding around it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProviderBreaker,
  ProviderUnavailableError,
  noteProviderFailure,
  rearmTurnDeadline,
  remainingTurnBudgetMs,
  runWithTurnResilience,
  shouldDegradeTurn,
  turnProviderFailures,
} from '../providerResilience';

type Outcome = { kind: 'sent'; text: string } | { kind: 'degraded' } | { kind: 'no_reply' };

/**
 * The pre-send gate, mirroring processAIReply's composition order: guards run, THEN the gate, THEN
 * the rearm, THEN the send.
 */
async function runTurn(opts: {
  degradeEnabled: boolean;
  turnBudgetMs?: number;
  guards: () => Promise<string | null>;
}): Promise<Outcome> {
  const budget = opts.turnBudgetMs ?? 0;
  return runWithTurnResilience(budget, async () => {
    const replyText = await opts.guards();
    if (replyText === null) return { kind: 'no_reply' as const };

    // ---- the gate ----
    if (shouldDegradeTurn(turnProviderFailures(), opts.degradeEnabled)) {
      return { kind: 'degraded' as const };
    }
    rearmTurnDeadline(budget);
    return { kind: 'sent' as const, text: replyText };
  });
}

/**
 * `classifySpeculativeHealthAdvice` (aiService.ts), reproduced faithfully: a real LLM call wrapped
 * in `try/catch` that returns `false` — "no unsafe advice here" — for ANY error. ~21 classifiers
 * share this shape. It is the reason the floor cannot be exception-driven.
 */
async function failOpenSafetyClassifier(call: () => Promise<boolean>): Promise<boolean> {
  try {
    return await call();
  } catch {
    return false; // fail-open: indistinguishable from a genuine "clean text" verdict
  }
}

describe('P2-6 degradation gate', () => {
  it('a clean turn sends normally', async () => {
    const outcome = await runTurn({ degradeEnabled: true, guards: async () => 'Here are our prices.' });
    assert.deepEqual(outcome, { kind: 'sent', text: 'Here are our prices.' });
  });

  it('flag off ⇒ the reply still ships, exactly as today (byte-for-byte legacy)', async () => {
    const outcome = await runTurn({
      degradeEnabled: false,
      guards: async () => {
        noteProviderFailure('chat', 'provider_error');
        return 'A sales reply built on guards that never ran.';
      },
    });
    assert.equal(outcome.kind, 'sent', 'flag off must change nothing');
  });

  /**
   * THE test. An OpenAI failure hits a safety classifier, whose `catch` swallows it into `false` —
   * so by the time the gate runs, NOTHING in the reply's own data says anything went wrong: the
   * classifier looks like it confidently cleared the text.
   *
   * An exception-driven floor is bypassed here, silently, at ~21 sites. The counter is not.
   */
  it('a swallowed fail-open still degrades — the reply is never sent', async () => {
    let sawUnsafeAdvice: boolean | null = null;

    const outcome = await runTurn({
      degradeEnabled: true,
      guards: async () => {
        const reply = 'For that dosage, I would check with a specialist.'; // speculative health advice
        sawUnsafeAdvice = await failOpenSafetyClassifier(async () => {
          noteProviderFailure('chat', 'provider_error'); // the wrapper records...
          throw new ProviderUnavailableError('provider_error', 'chat'); // ...then the classifier eats it
        });
        return reply;
      },
    });

    assert.equal(sawUnsafeAdvice, false, 'the guard fail-opened: it "cleared" unsafe advice');
    assert.equal(outcome.kind, 'degraded', 'but the turn still degraded — the counter saw the truth');
  });

  it('degrades on every cause, including the ones the breaker ignores', async () => {
    for (const cause of ['provider_error', 'call_timeout', 'turn_starved', 'breaker_open', 'rate_limit'] as const) {
      const outcome = await runTurn({
        degradeEnabled: true,
        guards: async () => {
          noteProviderFailure('chat', cause);
          return 'reply';
        },
      });
      assert.equal(outcome.kind, 'degraded', `cause=${cause}`);
    }
  });

  /**
   * The RC-19 regression, at the DEFAULT flags. `SENSITIVE_PATH_FAIL_CLOSED` is off by default, so
   * a refund detector that throws is rethrown, the umbrella logs "continuing normal flow", and
   * execution falls through to generateReply — which happily produces a sales reply. Today that is
   * survivable only because the SDK grinds through ~240s and usually succeeds; add a cap and the
   * abort makes it FASTER and more likely.
   *
   * The gate is what stops the sales reply, with P0-4 still off.
   */
  it('refund demand during a blip: no sales reply, even with SENSITIVE_PATH_FAIL_CLOSED off', async () => {
    const SENSITIVE_PATH_FAIL_CLOSED = false; // the manifest default

    const outcome = await runTurn({
      degradeEnabled: true,
      guards: async () => {
        // detectCancellationOrRefundIntent throws (provider blip).
        try {
          noteProviderFailure('chat', 'call_timeout');
          throw new ProviderUnavailableError('call_timeout', 'chat');
        } catch (err) {
          // runSensitiveDetector: flag off ⇒ decideSensitivePathAction returns 'continue' ⇒ rethrow.
          // The umbrella then catches, warns, and falls through — the RC-19 fail-open.
          if (SENSITIVE_PATH_FAIL_CLOSED) throw err;
        }
        return 'Absolutely! Would you like to see our other protein flavours? 😊'; // the sales reply
      },
    });

    assert.equal(outcome.kind, 'degraded', 'the refund demand must never receive a sales reply');
  });

  it('with P0-4 ON the sensitive path escalates first and the gate is never reached', async () => {
    const SENSITIVE_PATH_FAIL_CLOSED = true;
    const outcome = await runTurn({
      degradeEnabled: true,
      guards: async () => {
        try {
          noteProviderFailure('chat', 'call_timeout');
          throw new ProviderUnavailableError('call_timeout', 'chat');
        } catch (err) {
          if (SENSITIVE_PATH_FAIL_CLOSED) return null; // escalate + sentinel ⇒ umbrella returns
          throw err;
        }
      },
    });
    // Composes correctly: the two floors do not fight — whichever fires first wins, and both
    // outcomes are "a human sees this", never a sales reply.
    assert.equal(outcome.kind, 'no_reply');
  });
});

describe('P2-6 turn budget', () => {
  it('no budget ⇒ unbounded (the default kill switch)', async () => {
    await runWithTurnResilience(0, async () => {
      assert.equal(remainingTurnBudgetMs(), null);
    });
  });

  it('the budget drains as the turn spends it', async () => {
    await runWithTurnResilience(1_000, async () => {
      const start = remainingTurnBudgetMs();
      assert.ok(start !== null && start > 900);
      await new Promise((r) => setTimeout(r, 20));
      const later = remainingTurnBudgetMs();
      assert.ok(later !== null && later < start, 'the budget is read live, never captured');
    });
  });

  /**
   * REARM, not release. Nulling the deadline before the send would hand `runOrderDetectionTail()`
   * an unbounded budget — and that tail makes OpenAI calls from inside the very try whose `finally`
   * releases `ai_conv_lock` (300s TTL, never renewed). An unbounded tail re-creates the exact
   * lock-expiry defect P2-6 exists to remove.
   */
  it('rearm gives the post-send tail a fresh, BOUNDED budget', async () => {
    await runWithTurnResilience(50, async () => {
      await new Promise((r) => setTimeout(r, 60));
      assert.ok((remainingTurnBudgetMs() ?? 0) <= 0, 'pre-send spend exhausted the budget');

      rearmTurnDeadline(50);
      const after = remainingTurnBudgetMs();
      assert.ok(after !== null, 'still BOUNDED — not null/unbounded');
      assert.ok(after > 0, 'and the tail is not starved by pre-send spend');
    });
  });

  it('rearm is visible to callers that captured nothing (the store is shared by reference)', async () => {
    await runWithTurnResilience(10, async () => {
      const read = () => remainingTurnBudgetMs();
      await new Promise((r) => setTimeout(r, 20));
      assert.ok((read() ?? 0) <= 0);
      rearmTurnDeadline(5_000);
      assert.ok((read() ?? 0) > 1_000, 'the ALS store mutation reaches every frame in the turn');
    });
  });

  it('outside a turn: no budget, and rearm is a harmless no-op', () => {
    assert.equal(remainingTurnBudgetMs(), null);
    assert.doesNotThrow(() => rearmTurnDeadline(1_000));
    assert.deepEqual(turnProviderFailures(), []);
  });

  it('turns are isolated — concurrent turns never share a budget or a failure list', async () => {
    const [a, b] = await Promise.all([
      runWithTurnResilience(5_000, async () => {
        noteProviderFailure('chat', 'provider_error');
        await new Promise((r) => setTimeout(r, 10));
        return turnProviderFailures().length;
      }),
      runWithTurnResilience(5_000, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return turnProviderFailures().length;
      }),
    ]);
    assert.equal(a, 1);
    assert.equal(b, 0, "one turn's outage must not degrade another's reply");
  });
});

/**
 * The floor's SHAPE, pinned as a mirror of `degradeToHoldingAndEscalate`'s committed effects.
 *
 * The degrade path deliberately does NOT pause the conversation, unlike every other escalation in
 * processAIReply — see the long comment at its transaction. A pause is sticky (its only exits are a
 * human toggle or an alert resolved with `resume_ai:true`), and this is the only escalation reason
 * driven by a GLOBAL condition, so pausing would let one 5-minute OpenAI blip permanently disable
 * the AI on every conversation that was mid-turn — O(conversations) manual cleanup for a fault that
 * fixed itself. The floor is: neutral holding message + a durable retryable alert.
 */
describe('P2-6 degradation floor — committed effects', () => {
  interface Effects { paused: boolean; humanRepliedWritten: boolean; alerts: string[]; sent: string[] }

  /** Mirrors the effects degradeToHoldingAndEscalate commits. */
  function degrade(effects: Effects, opts: { outboundAlreadySent: boolean }): void {
    effects.alerts.push('provider_unavailable');            // durable, distinct, retryable
    if (!opts.outboundAlreadySent) effects.sent.push('holding:degraded');
    // NO setConversationAiPaused, NO setConversationHumanReplied — deliberately.
  }

  it('raises a retryable alert and sends a holding message, but never pauses', () => {
    const e: Effects = { paused: false, humanRepliedWritten: false, alerts: [], sent: [] };
    degrade(e, { outboundAlreadySent: false });

    assert.deepEqual(e.alerts, ['provider_unavailable']);
    assert.deepEqual(e.sent, ['holding:degraded']);
    assert.equal(e.paused, false, 'a provider outage is not a reason to hand the thread to a human');
  });

  it('never writes the sticky human_replied flag', () => {
    const e: Effects = { paused: false, humanRepliedWritten: false, alerts: [], sent: [] };
    degrade(e, { outboundAlreadySent: false });
    // Forcing it false on a conversation a human HAS replied to would silently re-qualify that
    // conversation for AI use-case billing.
    assert.equal(e.humanRepliedWritten, false);
  });

  // RC-20: the sensitive block may already have acked this inbound and then thrown, with the
  // umbrella falling through to here. Escalate, but never stack a second message on the ack.
  it('skips the holding send when an ack is already on the wire, but still alerts', () => {
    const e: Effects = { paused: false, humanRepliedWritten: false, alerts: [], sent: [] };
    degrade(e, { outboundAlreadySent: true });

    assert.deepEqual(e.sent, [], 'no double-send');
    assert.deepEqual(e.alerts, ['provider_unavailable'], 'the alert is still owed');
  });
});

describe('P2-6 ledger snapshot', () => {
  it('the breaker snapshot is scalars only — no migration needed for guard_verdicts', () => {
    const breaker = new ProviderBreaker({
      failureThreshold: 1, cooldownMs: 1_000, halfOpenProbes: 1, now: () => 0,
    });
    breaker.recordFailure('chat', 'provider_error', 'on');
    const snapshot = breaker.snapshot();
    // guard_verdicts is Record<string, unknown> and gets JSON.stringify'd + redactValue'd; anything
    // non-scalar here would be a schema problem or a PII problem.
    assert.equal(JSON.stringify(snapshot), '{"chat":"open"}');
  });
});
