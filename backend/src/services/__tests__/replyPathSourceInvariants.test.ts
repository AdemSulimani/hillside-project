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
