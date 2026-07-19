/**
 * P3-6 — the COGS arithmetic.
 *
 * The single most important assertion in this file is the DOUBLE-COUNT PIN. `usage.usd_cost` is
 * the main generation's cost, and the main generation also passes through the call tracker — so
 * it appears a second time inside `usage.calls[]`, which means `calls_usd_cost` already contains
 * it. Summing the two inflates every cost figure by the turn's single most expensive call, and
 * because the inflation is proportional it looks entirely plausible. The numbers below are taken
 * verbatim from a live dev ledger row, not invented, so the pin fails if anyone "fixes" the rule
 * by adding.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldTurnCosts,
  summarizeCogs,
  turnCallCount,
  turnCostUsd,
  UNATTRIBUTED_ROLE,
  type CostTurn,
} from '../costAggregation';
import type { LedgerUsage } from '../../db/models/aiDecisionLedger';

/** A real row from the dev ledger: 21 calls, main generation 0.016948, fan-out total 0.03755. */
const LIVE_USAGE: LedgerUsage = {
  prompt_tokens: 6623,
  completion_tokens: 39,
  total_tokens: 6662,
  usd_cost: 0.016948,
  call_count: 21,
  calls_usd_cost: 0.03755,
  calls: null,
};

describe('turnCostUsd — the double-count rule', () => {
  it('returns calls_usd_cost, NOT the sum of it and usd_cost', () => {
    assert.equal(turnCostUsd(LIVE_USAGE), 0.03755);
    // The bug this pin exists to prevent. 0.016948 + 0.03755 = 0.054498 — a 45% overstatement
    // that would look like a plausible per-turn cost to anyone not checking.
    assert.notEqual(turnCostUsd(LIVE_USAGE), 0.054498);
  });

  it('falls back to usd_cost when no call array was priced', () => {
    assert.equal(
      turnCostUsd({ ...LIVE_USAGE, calls_usd_cost: undefined }),
      0.016948,
      'a pre-tracker row, or a turn whose only priced call was the generation',
    );
  });

  it('returns null — never 0 — when nothing was recorded', () => {
    assert.equal(turnCostUsd(null), null);
    assert.equal(turnCostUsd(undefined), null);
    assert.equal(
      turnCostUsd({ ...LIVE_USAGE, usd_cost: null, calls_usd_cost: undefined }),
      null,
      'null means "we did not measure"; rendering it as 0.00 would claim a reply was free',
    );
  });

  it('ignores a non-finite cost rather than propagating NaN into an aggregate', () => {
    assert.equal(turnCostUsd({ ...LIVE_USAGE, calls_usd_cost: NaN }), 0.016948);
  });
});

describe('turnCallCount', () => {
  it('prefers the recorded count and falls back to the array length', () => {
    assert.equal(turnCallCount(LIVE_USAGE), 21);
    assert.equal(
      turnCallCount({ ...LIVE_USAGE, call_count: undefined, calls: [] as never }),
      0,
    );
    assert.equal(turnCallCount({ ...LIVE_USAGE, call_count: undefined, calls: null }), null);
  });
});

const call = (over: Partial<NonNullable<LedgerUsage['calls']>[number]> = {}) => ({
  kind: 'chat',
  requested: 'gpt-4o',
  served: 'gpt-4o-2024-08-06',
  prompt_tokens: 100,
  completion_tokens: 10,
  total_tokens: 110,
  usd_cost: 0.00035,
  ...over,
});

describe('foldTurnCosts', () => {
  it('groups by (role, model, kind) and counts each turn exactly once', () => {
    const turns: CostTurn[] = [
      {
        conversation_id: 'c1',
        usage: {
          ...LIVE_USAGE,
          calls: [
            call({ role: 'chat', usd_cost: 0.01 }),
            call({ role: 'classifier', usd_cost: 0.002 }),
            call({ role: 'classifier', usd_cost: 0.003 }),
          ],
        },
      },
      {
        conversation_id: 'c1',
        usage: { ...LIVE_USAGE, calls: [call({ role: 'classifier', usd_cost: 0.004 })] },
      },
    ];

    const rows = foldTurnCosts(turns);
    const chat = rows.find((r) => r.role === 'chat')!;
    const classifier = rows.find((r) => r.role === 'classifier')!;

    assert.equal(chat.calls, 1);
    assert.equal(classifier.calls, 3);
    assert.equal(chat.usd_cost, 0.01);
    assert.equal(classifier.usd_cost, 0.009);

    // Turns land on the row their FIRST call hit, so summing across rows reproduces 2 — not 2 per
    // distinct (role, model) pair. A cost-per-turn computed off an inflated denominator would be
    // silently LOW, which is the direction that reads as good news.
    assert.equal(
      rows.reduce((s, r) => s + r.turns, 0),
      2,
    );
    // Both turns are the same conversation.
    assert.equal(
      rows.reduce((s, r) => s + r.conversations, 0),
      1,
    );
  });

  it('buckets a pre-P3-6 call (no role key) as unattributed rather than guessing', () => {
    const rows = foldTurnCosts([
      { conversation_id: 'c1', usage: { ...LIVE_USAGE, calls: [call({ role: undefined })] } },
    ]);
    assert.equal(rows[0].role, UNATTRIBUTED_ROLE);
  });

  it('counts an unpriced call but does not let it contribute 0 to the priced total', () => {
    const rows = foldTurnCosts([
      {
        conversation_id: 'c1',
        usage: {
          ...LIVE_USAGE,
          calls: [call({ role: 'classifier', usd_cost: 0.005 }), call({ role: 'classifier', usd_cost: null })],
        },
      },
    ]);
    assert.equal(rows[0].calls, 2);
    // `priced_calls < calls` is the unpriced-model canary — it is how a new OpenAI model id shows
    // up as a visible measurement gap instead of a quietly shrinking cost.
    assert.equal(rows[0].priced_calls, 1);
    assert.equal(rows[0].usd_cost, 0.005);
  });

  it('tolerates a turn with no calls array at all', () => {
    assert.deepEqual(foldTurnCosts([{ conversation_id: 'c1', usage: LIVE_USAGE }]), []);
    assert.deepEqual(foldTurnCosts([{ conversation_id: null, usage: null }]), []);
  });

  it('tags rows with the requested source so job spend stays separable from reply spend', () => {
    const rows = foldTurnCosts(
      [{ conversation_id: null, usage: { ...LIVE_USAGE, calls: [call()] } }],
      'job',
    );
    assert.equal(rows[0].source, 'job');
    assert.equal(rows[0].conversations, 0, 'a background job has no conversation');
  });
});

describe('summarizeCogs', () => {
  it('reports spend share by role, not call share', () => {
    const rows = foldTurnCosts([
      {
        conversation_id: 'c1',
        usage: {
          ...LIVE_USAGE,
          calls: [
            call({ role: 'chat', usd_cost: 0.017 }),
            ...Array.from({ length: 19 }, () => call({ role: 'classifier', usd_cost: 0.001 })),
          ],
        },
      },
    ]);
    const summary = summarizeCogs(rows);

    assert.equal(summary.calls, 20);
    assert.equal(summary.usd_cost, 0.036);

    const chat = summary.by_role.find((r) => r.role === 'chat')!;
    // 1 of 20 calls (5%) but 47% of the dollars — the whole reason share is computed on spend.
    // Reading "the fan-out is 95% of calls" as "the fan-out is 95% of cost" is how a tiering
    // decision gets aimed at the wrong target.
    assert.equal(chat.calls, 1);
    assert.equal(chat.share, 0.472222);
  });

  it('computes per-turn and per-conversation rates, and null when there is nothing to divide by', () => {
    const summary = summarizeCogs([]);
    assert.equal(summary.usd_per_turn, null);
    assert.equal(summary.usd_per_conversation, null);
    assert.equal(summary.cached_prompt_ratio, null);
    assert.equal(summary.usd_cost, 0);
  });

  it('reports the cached-prompt ratio — the C-24 prompt-caching measurement', () => {
    const rows = foldTurnCosts([
      {
        conversation_id: 'c1',
        usage: {
          ...LIVE_USAGE,
          calls: [call({ role: 'chat', prompt_tokens: 1000, cached_tokens: 750 })],
        },
      },
    ]);
    assert.equal(summarizeCogs(rows).cached_prompt_ratio, 0.75);
  });

  it('surfaces unpriced calls in the summary so the total is never read as complete', () => {
    const rows = foldTurnCosts([
      {
        conversation_id: 'c1',
        usage: { ...LIVE_USAGE, calls: [call({ usd_cost: null }), call({ usd_cost: 0.001 })] },
      },
    ]);
    const summary = summarizeCogs(rows);
    assert.equal(summary.unpriced_calls, 1);
  });
});
