/**
 * P1-5 (C-108): per-call OpenAI usage capture. Covers: recording inside a tracking context
 * (chat + embeddings), pass-through outside a context, transparency of results/errors,
 * instrument idempotency, and streaming skip.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import {
  instrumentOpenAIClient,
  runWithOpenAICallTracking,
  getTrackedOpenAICalls,
} from '../openaiCallTracker';

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
