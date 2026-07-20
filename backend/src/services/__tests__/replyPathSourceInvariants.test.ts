/**
 * Source-level invariants on the reply path (P2 audit fixes). `processAIReply.ts` is deliberately
 * not importable in unit scope (its module graph reaches openaiClient's boot-fatal env reads), so
 * — following the house convention established by `evalIsolation.test.ts` — these regressions are
 * pinned as assertions over the source text, each with a count guard so a refactor that moves the
 * code cannot make an assertion pass vacuously.
 *
 * Invariants:
 *  1. S1 (P2-1-F1): a grounding-gate escalation must NEVER write `human_replied`. The flag is the
 *     sticky "any human reply ever" billing input; forcing it false re-qualifies a human-touched
 *     conversation for use-case billing once the alert is resolved with resume_ai.
 *  2. P2-6-F1: the outer catch routes the FINAL attempt of a provider-caused pre-send failure to
 *     the degradation floor (instead of dead-lettering into customer silence), and the worker
 *     threads the BullMQ attempt position in.
 *  3. P2-6 floor txn: the provider_unavailable escalation commits the ALERT ONLY — no pause, no
 *     human_replied write (the mirror tests in providerDegradation.test.ts pin the effects; this
 *     pins the production source the mirror cannot see).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function findSrcDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'src');
    if (existsSync(path.join(candidate, 'services', 'aiService.ts'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate backend/src from cwd ${process.cwd()}`);
}

const SRC = findSrcDir();
const processAIReplySource = readFileSync(path.join(SRC, 'jobs', 'processAIReply.ts'), 'utf8');
const workersSource = readFileSync(path.join(SRC, 'jobs', 'workers.ts'), 'utf8');

/** All indices at which `needle` occurs in `haystack`. */
function indicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

describe('S1: grounding-gate escalation never touches human_replied', () => {
  // The grounding-specific pause is the anchor: it is the only pause call parameterised by
  // `groundingGateReason`, so it uniquely identifies both escalation paths (staged flip + legacy
  // inline).
  const anchor = 'setConversationAiPaused(conversationId, tenantId, true, client, groundingGateReason)';
  const sites = indicesOf(processAIReplySource, anchor);

  it('both grounding escalation paths still exist (the guard is not vacuous)', () => {
    assert.equal(sites.length, 2, `expected 2 grounding pause sites, found ${sites.length}`);
  });

  it('neither path writes human_replied in its transaction', () => {
    for (const site of sites) {
      const window = processAIReplySource.slice(site, site + 800);
      assert.ok(
        !window.includes('setConversationHumanReplied'),
        'a grounding-gate escalation path writes human_replied — this wipes the sticky billing flag (P2-1-F1)',
      );
    }
  });
});

describe('P2-6-F1: final-attempt provider failures resolve to the floor, not the DLQ', () => {
  it('the degradation floor is hoisted for the outer catch', () => {
    assert.ok(
      processAIReplySource.includes('degradeFloorFn = degradeToHoldingAndEscalate'),
      'degradeFloorFn hoist assignment missing',
    );
  });

  it('the outer catch gates on final attempt + pre-send + provider cause', () => {
    const catchIdx = processAIReplySource.indexOf('const providerCaused =');
    assert.ok(catchIdx !== -1, 'providerCaused classification missing from the outer catch');
    const window = processAIReplySource.slice(catchIdx, catchIdx + 1200);
    for (const required of [
      'err instanceof ProviderUnavailableError',
      'err instanceof GenerationContractError',
      'turnProviderFailures().length > 0',
      'isFinalAttempt',
      'preSendPhase',
      'SensitivePathEscalatedError',
      'await degradeFloorFn()',
    ]) {
      assert.ok(window.includes(required), `outer catch is missing: ${required}`);
    }
  });

  it('the worker threads the BullMQ attempt position into processAIReply', () => {
    const call = workersSource.indexOf('await processAIReply(');
    assert.ok(call !== -1, 'aiWorker no longer calls processAIReply');
    const window = workersSource.slice(call, call + 300);
    assert.ok(
      window.includes('attemptsMade') && window.includes('attempts'),
      'aiWorker does not pass attempt info — the final-attempt floor can never engage',
    );
  });
});

describe('P2-6 floor txn: alert only — no pause, no human_replied', () => {
  it('the provider_unavailable escalation commits nothing but the alert', () => {
    const sites = indicesOf(processAIReplySource, "reason: 'provider_unavailable'");
    assert.ok(sites.length >= 1, 'provider_unavailable alert site missing');
    for (const site of sites) {
      // The whole degrade transaction fits well inside this window (BEGIN … COMMIT).
      const window = processAIReplySource.slice(Math.max(0, site - 2000), site + 800);
      assert.ok(
        !window.includes('setConversationAiPaused('),
        'the degradation floor pauses the conversation — one provider blip would pause every mid-turn thread',
      );
      assert.ok(
        !window.includes('setConversationHumanReplied('),
        'the degradation floor writes human_replied — this wipes the sticky billing flag',
      );
    }
  });
});

describe('F4: provider-caused sensitive-detector failures route to the no-pause floor', () => {
  // Dev validation Finding 4: the detectors run first in the turn and call the provider, so a
  // global outage always struck them before the pre-send degrade gate — the fail-closed pause
  // fanned out to every mid-turn conversation. The detector catch now consults the pure route
  // function; provider-caused failures take the floor (no pause), detector code bugs keep the
  // pause. The mirror tests pin the routing table; this pins the production composition.
  const anchor = 'decideSensitiveDetectorFailureRoute({';
  const sites = indicesOf(processAIReplySource, anchor);

  it('exactly one detector-catch route site exists (the guard is not vacuous)', () => {
    assert.equal(sites.length, 1, `expected 1 route site, found ${sites.length}`);
  });

  it('the catch classifies provider cause via the ALS store AND the error class, and both terminal paths end in the sentinel', () => {
    const window = processAIReplySource.slice(Math.max(0, sites[0] - 1200), sites[0] + 2600);
    for (const required of [
      'turnProviderFailures().length > 0',
      'err instanceof ProviderUnavailableError',
      'await degradeToHoldingAndEscalate()',
      'escalateSensitivePathOnDetectorError()',
      'SensitivePathEscalatedError',
    ]) {
      assert.ok(window.includes(required), `detector catch is missing: ${required}`);
    }
  });

  it('the degrade route never pauses and never creates its own alert', () => {
    const window = processAIReplySource.slice(sites[0], sites[0] + 2600);
    assert.ok(
      !window.includes('setConversationAiPaused('),
      'the detector degrade route pauses — the Finding-4 fan-out is back',
    );
    assert.ok(
      !window.includes("reason: 'provider_unavailable'"),
      'the detector degrade route creates its own alert — the floor already commits it (double alert)',
    );
  });
});

describe('F3: the order_stage shadow verdict reaches the ledger as its own row', () => {
  // Dev validation Finding 3: the turn's 'main' ledger row is serialized inside stageAndSend's
  // onFlip; the order-detection tail runs AFTER that seal, so a recordDecision() push there is
  // silently dropped and eval:shadow — the P2-2 cutover gate — reads zero observations forever.
  // The fix writes the verdict as a second best-effort row. This pin holds the three load-bearing
  // properties: a distinct slot (idempotency key is slot-keyed; 'main' collides silently), a
  // nulled usage (buildLedgerRecord pulls the whole turn's tracked calls; P3-6 cost readers sum
  // per-row, so inheriting it would double order-detection COGS), and no resurrected dead push.
  const anchor = "ORDER_STAGE_MACHINE_MODE === 'shadow'";
  const sites = indicesOf(processAIReplySource, anchor);

  it('exactly one shadow-mode block exists (the guard is not vacuous)', () => {
    assert.equal(sites.length, 1, `expected 1 shadow-mode site, found ${sites.length}`);
  });

  it('the shadow block writes its own best-effort row with a distinct slot and nulled usage', () => {
    const window = processAIReplySource.slice(sites[0], sites[0] + 3200);
    for (const required of [
      'writeLedgerBestEffort',
      "replySlot: 'shadow:order_stage'",
      "decisionKind: 'order_shadow'",
      'usage: null',
    ]) {
      assert.ok(window.includes(required), `order_stage shadow block is missing: ${required}`);
    }
  });

  it('the dead recordDecision push does not come back', () => {
    const window = processAIReplySource.slice(sites[0], sites[0] + 3200);
    assert.ok(
      !window.includes('recordDecision('),
      'the order_stage shadow block pushes to decisionEvents — that array was already serialized ' +
        'into the main row at the send flip; the event is dropped (Finding 3)',
    );
  });
});

describe('P2-5: the Gheg consent widening stays OUT of the legacy affirmation path', () => {
  // GHEG_ORDER_CONSENT_EXTRA_PATTERNS feed ONLY the FSM's stage-gated consent detector
  // (honored solely in awaiting_confirmation). The legacy looksLikeOrderAffirmation runs on
  // BOTH flag branches and is NOT stage-gated — a Gheg-progressive/filler token there would
  // fire on any turn. This is the pin ghegLexicons.ts's comment refers to.
  it('looksLikeOrderAffirmation contains none of the Gheg-only extra tokens', () => {
    const marker = 'function looksLikeOrderAffirmation';
    const idx = processAIReplySource.indexOf(marker);
    assert.ok(idx !== -1, 'legacy affirmation function missing');
    const body = processAIReplySource.slice(idx, idx + 1500);
    // Only forms that exist SOLELY in the Gheg extra patterns: fillers (aha/ehe/hajde), the Gheg
    // copula (jom), and the progressive "pe porosit-" stem. The pan-Albanian "porosi(s)" stem is
    // legitimately part of the legacy patterns ("dua ta porosis") and is deliberately not listed.
    for (const token of ['aha', 'ehe', 'hajde', 'jom', 'pe porosit']) {
      assert.ok(
        !body.includes(token),
        `legacy looksLikeOrderAffirmation gained the Gheg-only token ${token} — it is not stage-gated`,
      );
    }
  });
});

describe('confidence_band_abstain alerts are binding-constraint-gated (alert-noise fix)', () => {
  // The [CONFIDENCE_GATE] log line is unconditional P1-3 observability; the operator ALERT
  // additionally requires the callers `alertEligible` assertion that the in-band score was the
  // BINDING constraint (order slots complete / positive intent verdict). These pins keep a new
  // call site from silently reverting to alert-on-every-in-band-score.
  const defIdx = processAIReplySource.indexOf('function logConfidenceGateBoundary(');
  const callSites = indicesOf(processAIReplySource, 'logConfidenceGateBoundary(').filter(
    (i) => i !== processAIReplySource.indexOf('function logConfidenceGateBoundary(') + 'function '.length,
  );

  it('the definition exists and takes the alertEligible parameter', () => {
    assert.ok(defIdx !== -1, 'logConfidenceGateBoundary definition missing');
    const header = processAIReplySource.slice(defIdx, defIdx + 400);
    assert.ok(header.includes('alertEligible: boolean'), 'alertEligible parameter missing');
  });

  it('exactly 6 call sites exist (count guard)', () => {
    const calls = callSites.filter((i) => !processAIReplySource.slice(i - 9, i).includes('function'));
    assert.equal(calls.length, 6, `expected 6 call sites, found ${calls.length}`);
  });

  it('the log line is emitted BEFORE the alertEligible early return', () => {
    const body = processAIReplySource.slice(defIdx, defIdx + 2600);
    const logIdx = body.indexOf('[CONFIDENCE_GATE]');
    const gateIdx = body.indexOf('if (!alertEligible) return;');
    const alertIdx = body.indexOf('confidence_band_abstain');
    assert.ok(logIdx !== -1 && gateIdx !== -1 && alertIdx !== -1, 'expected anchors missing');
    assert.ok(logIdx < gateIdx, 'log line must stay unconditional (before the eligibility gate)');
    assert.ok(gateIdx < alertIdx, 'the alert must sit behind the eligibility gate');
  });

  it('each call site passes its expected binding-constraint expression', () => {
    const expected: Record<string, string> = {
      "'cancellation_refund'": 'hasCancelOrRefundIntent',
      "'wrong_product'": 'wrongProductIntent.is_wrong_product === true',
      "'post_purchase'": 'hasPostPurchaseSupportIntent',
      "'order_info_update'": 'orderInfoUpdateIntent.is_order_info_update === true',
      "'order_affirmation'": 'orderAffirmationIntent.is_order_affirmation === true',
      "'order_intent_score'": 'orderSlotsBindOnScore',
    };
    for (const [gate, eligibility] of Object.entries(expected)) {
      const call = callSites
        .map((i) => processAIReplySource.slice(i, i + 400))
        .find((w) => w.slice(0, 80).includes(`${gate},`));
      assert.ok(call, `call site for gate ${gate} not found`);
      assert.ok(
        call.includes(eligibility),
        `gate ${gate} does not pass its binding-constraint expression ${eligibility}`,
      );
    }
  });

  it('the legacy draft-order gate is the same conjunct set, factored (behavior pin)', () => {
    const idx = processAIReplySource.indexOf('const orderSlotsBindOnScore =');
    assert.ok(idx !== -1, 'orderSlotsBindOnScore missing');
    const block = processAIReplySource.slice(idx, idx + 1400);
    for (const conjunct of [
      'intent.is_ready_to_order === true',
      'intent.product_name != null',
      'hasDeliveryAddress',
      'hasCustomerPhone',
      'hasCustomerName',
      'shouldAffirmOrder',
    ]) {
      assert.ok(block.includes(conjunct), `orderSlotsBindOnScore lost conjunct ${conjunct}`);
    }
    assert.ok(
      /legacyPassesDraftOrderValidation =\s*orderSlotsBindOnScore &&/.test(block),
      'legacyPassesDraftOrderValidation must be orderSlotsBindOnScore && the score gate',
    );
  });
});
