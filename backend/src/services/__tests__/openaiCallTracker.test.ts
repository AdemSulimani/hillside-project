/**
 * P1-5 (C-108): per-call OpenAI usage capture. Covers: recording inside a tracking context
 * (chat + embeddings), pass-through outside a context, transparency of results/errors,
 * instrument idempotency, and streaming skip.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import {
  attributeRole,
  instrumentOpenAIClient,
  runWithOpenAICallTracking,
  getTrackedOpenAICalls,
  withModelRole,
} from '../openaiCallTracker';
import type { ModelRole } from '../../config/models';

function fakeClient(): {
  client: OpenAI;
  chatCalls: unknown[];
  embedCalls: unknown[];
} {
  const chatCalls: unknown[] = [];
  const embedCalls: unknown[] = [];
  const client = {
    chat: {
      completions: {
        async create(body: { model?: string; stream?: boolean; fail?: boolean }) {
          chatCalls.push(body);
          if (body.fail) throw new Error('boom');
          return {
            model: `${body.model}-2025-01-01`,
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            choices: [{ message: { content: 'ok' } }],
          };
        },
      },
    },
    embeddings: {
      async create(body: { model?: string }) {
        embedCalls.push(body);
        return {
          model: body.model,
          usage: { prompt_tokens: 8, total_tokens: 8 },
          data: [{ embedding: [0.1, 0.2] }],
        };
      },
    },
  } as unknown as OpenAI;
  return { client, chatCalls, embedCalls };
}

describe('openaiCallTracker', () => {
  it('records chat + embedding calls inside a tracking context', async () => {
    const { client } = fakeClient();
    instrumentOpenAIClient(client);
    await runWithOpenAICallTracking(async () => {
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] } as never);
      await client.embeddings.create({ model: 'text-embedding-3-small', input: 'x' } as never);
      const calls = getTrackedOpenAICalls();
      assert.ok(calls);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].kind, 'chat');
      assert.equal(calls[0].requested, 'gpt-4o');
      assert.equal(calls[0].served, 'gpt-4o-2025-01-01');
      assert.equal(calls[0].prompt_tokens, 100);
      assert.equal(calls[0].completion_tokens, 20);
      assert.equal(typeof calls[0].usd_cost, 'number', 'gpt-4o family is priced');
      assert.equal(calls[1].kind, 'embedding');
      assert.equal(calls[1].requested, 'text-embedding-3-small');
    });
  });

  it('is a pure pass-through outside a context (nothing recorded, result unchanged)', async () => {
    const { client } = fakeClient();
    instrumentOpenAIClient(client);
    const res = (await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [],
    } as never)) as { choices: Array<{ message: { content: string } }> };
    assert.equal(res.choices[0].message.content, 'ok');
    assert.equal(getTrackedOpenAICalls(), null);
  });

  it('errors propagate unchanged and are not recorded', async () => {
    const { client } = fakeClient();
    instrumentOpenAIClient(client);
    await runWithOpenAICallTracking(async () => {
      await assert.rejects(
        client.chat.completions.create({ model: 'gpt-4o', fail: true } as never),
        /boom/,
      );
      assert.equal(getTrackedOpenAICalls()?.length, 0);
    });
  });

  it('instrumenting twice does not double-record', async () => {
    const { client } = fakeClient();
    instrumentOpenAIClient(client);
    instrumentOpenAIClient(client);
    await runWithOpenAICallTracking(async () => {
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] } as never);
      assert.equal(getTrackedOpenAICalls()?.length, 1);
    });
  });

  it('streaming requests pass through unrecorded', async () => {
    const { client } = fakeClient();
    instrumentOpenAIClient(client);
    await runWithOpenAICallTracking(async () => {
      await client.chat.completions.create({ model: 'gpt-4o', stream: true } as never);
      assert.equal(getTrackedOpenAICalls()?.length, 0);
    });
  });

  it('contexts are isolated: concurrent jobs do not see each other\'s calls', async () => {
    const { client } = fakeClient();
    instrumentOpenAIClient(client);
    await Promise.all([
      runWithOpenAICallTracking(async () => {
        await client.chat.completions.create({ model: 'gpt-4o', messages: [] } as never);
        assert.equal(getTrackedOpenAICalls()?.length, 1);
      }),
      runWithOpenAICallTracking(async () => {
        assert.equal(getTrackedOpenAICalls()?.length, 0);
      }),
    ]);
  });
});

/**
 * P3-6. Role attribution is what turns a flat per-turn total into "the classifier fan-out is 53%
 * of a reply" — the number a tiering decision is actually made on. The design constraint driving
 * the tests below: in the DEFAULT config every chat-family role resolves to the same `gpt-4o`, so
 * the model id alone cannot identify a role and the answer must be an honest `null` rather than
 * whichever role happened to be registered first.
 */
describe('openaiCallTracker — role attribution (P3-6)', () => {
  it('attributes exactly when roles resolve to distinct models', () => {
    const byModel = new Map<string, ModelRole | null>([
      ['gpt-4o', 'chat'],
      ['gpt-4o-mini', 'classifier'],
    ]);
    assert.equal(attributeRole('gpt-4o', undefined, byModel), 'chat');
    assert.equal(attributeRole('gpt-4o-mini', undefined, byModel), 'classifier');
  });

  it('returns null — never a guess — when two roles share a model id', () => {
    // This is the DEFAULT config: chat/classifier/vision/eval/intent all collapse onto gpt-4o.
    // A confidently wrong role would corrupt the per-role split a downgrade decision reads,
    // which is worse than an honest gap that the panel can label "unattributed".
    const ambiguous = new Map<string, ModelRole | null>([['gpt-4o', null]]);
    assert.equal(attributeRole('gpt-4o', undefined, ambiguous), null);
  });

  it('lets an explicit label win over the model map', () => {
    const byModel = new Map<string, ModelRole | null>([['gpt-4o', null]]);
    assert.equal(attributeRole('gpt-4o', 'chat', byModel), 'chat');
  });

  it('returns null for an unmapped model, e.g. a tenant custom_model_id', () => {
    const byModel = new Map<string, ModelRole | null>([['gpt-4o', 'chat']]);
    assert.equal(attributeRole('ft:gpt-4o:acme::x1', undefined, byModel), null);
    assert.equal(attributeRole(null, undefined, byModel), null);
  });

  it('records the role on calls made inside withModelRole, and null outside it', async () => {
    const { client } = fakeClient();
    instrumentOpenAIClient(client);
    await runWithOpenAICallTracking(async () => {
      await withModelRole('eval', async () => {
        await client.chat.completions.create({ model: 'unmapped-model', messages: [] } as never);
      });
      await client.chat.completions.create({ model: 'unmapped-model', messages: [] } as never);

      const calls = getTrackedOpenAICalls()!;
      assert.equal(calls[0].role, 'eval');
      assert.equal(calls[1].role, null);
      // Both calls land in the SAME turn's array — a labelled section must not start a new one,
      // or the ledger row would lose every call made inside it.
      assert.equal(calls.length, 2);
    });
  });

  it('withModelRole is a no-op outside a tracking context', async () => {
    const { client } = fakeClient();
    instrumentOpenAIClient(client);
    const result = await withModelRole('vision', async () => {
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] } as never);
      return 'returned';
    });
    assert.equal(result, 'returned');
    assert.equal(getTrackedOpenAICalls(), null);
  });
});

describe('openaiCallTracker — cached tokens (P3-6)', () => {
  it('captures prompt_tokens_details.cached_tokens when the provider reports it', async () => {
    const client = {
      chat: {
        completions: {
          async create() {
            return {
              model: 'gpt-4o-2024-08-06',
              usage: {
                prompt_tokens: 1000,
                completion_tokens: 10,
                total_tokens: 1010,
                prompt_tokens_details: { cached_tokens: 768 },
              },
              choices: [{ message: { content: 'ok' } }],
            };
          },
        },
      },
      embeddings: { async create() { return { model: 'm', usage: {}, data: [] }; } },
    } as unknown as OpenAI;
    instrumentOpenAIClient(client);

    await runWithOpenAICallTracking(async () => {
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] } as never);
      const call = getTrackedOpenAICalls()![0];
      assert.equal(call.cached_tokens, 768);
      // And the discount is actually applied: 232 @ 2.5/M + 768 @ 1.25/M + 10 @ 10/M.
      assert.equal(call.usd_cost, 0.00164);
    });
  });

  it('records null — not 0 — when the provider omits the field', async () => {
    // "We looked and there was nothing" reads differently from "the prefix missed the cache".
    // Only the second is a fact about caching; conflating them would make the C-24 measurement
    // report a 0% hit rate on a provider that simply does not report the field.
    const { client } = fakeClient();
    instrumentOpenAIClient(client);
    await runWithOpenAICallTracking(async () => {
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] } as never);
      assert.equal(getTrackedOpenAICalls()![0].cached_tokens, null);
    });
  });
});

describe('openaiCallTracker — model id per call (P3-6 regression)', () => {
  it('records requested and served separately', async () => {
    // The item's "Regression: model-id-per-call captured". Live data shows requested `gpt-4o` and
    // served `gpt-4o-2024-08-06` — collapsing them would make the RC-17 model-drift check blind
    // to a provider-side snapshot change.
    const { client } = fakeClient();
    instrumentOpenAIClient(client);
    await runWithOpenAICallTracking(async () => {
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] } as never);
      const call = getTrackedOpenAICalls()![0];
      assert.equal(call.requested, 'gpt-4o');
      assert.equal(call.served, 'gpt-4o-2025-01-01');
      assert.notEqual(call.requested, call.served);
    });
  });
});
