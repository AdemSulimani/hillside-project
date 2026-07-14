/**
 * Tests for P2-4 Part 1 — the structured, correlation-keyed, PII-safe AI-path logger
 * (`utils/logger.ts`). All pure/in-process (no DB/Redis/network). Covers:
 *   - legacy `console[level](tag, meta)` shape when STRUCTURED_LOGGING is off,
 *   - automatic PII redaction of log metadata (composes with utils/redact),
 *   - structured JSON output + correlation keying via AsyncLocalStorage when on (incl. across awaits),
 *   - Sentry-on-error with correlation tags + redacted extra (and warn NOT reporting),
 *   - the Sentry-never-throws fallback,
 *   - graceful behaviour with no active context and via child().
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as SentryType from '@sentry/node';
import { logger, createLogger, runWithLogContext } from '../../utils/logger';

// The logger reports errors through @sentry/node. Grab the underlying CJS module object — the same
// require-cache singleton the logger's namespace import reads from — so a mock on it is observed by
// the logger in-process.
const Sentry = require('@sentry/node') as typeof SentryType;

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

async function withEnvAsync(
  key: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

describe('logger — legacy mode (STRUCTURED_LOGGING off)', () => {
  it('preserves console[level](tag, meta) shape with no injected context', (t) => {
    withEnv('STRUCTURED_LOGGING', undefined, () => {
      const info = t.mock.method(console, 'info', () => {});
      logger.info('[TAG]', { tenantId: 't1', score: 0.9 });
      assert.equal(info.mock.calls.length, 1);
      const args = info.mock.calls[0].arguments as unknown[];
      assert.equal(args[0], '[TAG]');
      assert.deepEqual(args[1], { tenantId: 't1', score: 0.9 });
    });
  });

  it('logs the tag only when no meta is given', (t) => {
    withEnv('STRUCTURED_LOGGING', undefined, () => {
      const warn = t.mock.method(console, 'warn', () => {});
      logger.warn('[ONLY_TAG]');
      assert.equal(warn.mock.calls.length, 1);
      assert.deepEqual(warn.mock.calls[0].arguments as unknown[], ['[ONLY_TAG]']);
    });
  });

  it('masks PII in metadata (phone -> token; numbers untouched)', (t) => {
    withEnv('STRUCTURED_LOGGING', undefined, () => {
      const warn = t.mock.method(console, 'warn', () => {});
      logger.warn('[X]', { q: '044 123 456', n: 5 });
      const meta = (warn.mock.calls[0].arguments as unknown[])[1] as Record<string, unknown>;
      assert.equal(meta.q, '[phone#3456]');
      assert.equal(meta.n, 5);
    });
  });
});

describe('logger — structured mode (STRUCTURED_LOGGING on)', () => {
  it('emits one JSON line carrying the ALS correlation ids + the meta', (t) => {
    withEnv('STRUCTURED_LOGGING', 'true', () => {
      const log = t.mock.method(console, 'log', () => {});
      runWithLogContext(
        {
          traceId: 'w1',
          correlationId: 'm1',
          tenantId: 't',
          conversationId: 'c',
          component: 'test',
        },
        () => logger.info('[TAG]', { a: 1 }),
      );
      assert.equal(log.mock.calls.length, 1);
      const rec = JSON.parse((log.mock.calls[0].arguments as unknown[])[0] as string);
      assert.equal(rec.level, 'info');
      assert.equal(rec.tag, '[TAG]');
      assert.equal(rec.traceId, 'w1');
      assert.equal(rec.correlationId, 'm1');
      assert.equal(rec.tenantId, 't');
      assert.equal(rec.conversationId, 'c');
      assert.equal(rec.component, 'test');
      assert.equal(rec.a, 1);
      assert.equal(typeof rec.ts, 'string');
    });
  });

  it('propagates the context across an await (AsyncLocalStorage threading)', async (t) => {
    await withEnvAsync('STRUCTURED_LOGGING', 'true', async () => {
      const log = t.mock.method(console, 'log', () => {});
      await runWithLogContext({ correlationId: 'm2' }, async () => {
        await Promise.resolve();
        logger.info('[NESTED]');
      });
      const rec = JSON.parse((log.mock.calls[0].arguments as unknown[])[0] as string);
      assert.equal(rec.correlationId, 'm2');
      assert.equal(rec.tag, '[NESTED]');
    });
  });

  it('a child() logger contributes fixed context (component)', (t) => {
    withEnv('STRUCTURED_LOGGING', 'true', () => {
      const log = t.mock.method(console, 'log', () => {});
      runWithLogContext({ correlationId: 'm3' }, () => {
        logger.child({ component: 'aiService' }).info('[C]');
      });
      const rec = JSON.parse((log.mock.calls[0].arguments as unknown[])[0] as string);
      assert.equal(rec.component, 'aiService');
      assert.equal(rec.correlationId, 'm3');
    });
  });
});

describe('logger.error — Sentry integration', () => {
  it('reports to Sentry with correlation tags + redacted extra; warn does not', (t) => {
    const capture = t.mock.method(Sentry, 'captureException', () => 'evt-id');
    withEnv('STRUCTURED_LOGGING', undefined, () => {
      t.mock.method(console, 'error', () => {});
      t.mock.method(console, 'warn', () => {});
      runWithLogContext(
        {
          traceId: 'w9',
          correlationId: 'm9',
          tenantId: 't9',
          conversationId: 'c9',
          component: 'test',
        },
        () => {
          logger.error('[BOOM]', new Error('kaboom'), { phone: '044 123 456' });
          logger.warn('[MEH]', { x: 1 });
        },
      );
    });
    assert.equal(capture.mock.calls.length, 1, 'only logger.error reports, not logger.warn');
    const [err, ctx] = capture.mock.calls[0].arguments as [Error, any];
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'kaboom');
    assert.equal(ctx.tags.correlationId, 'm9');
    assert.equal(ctx.tags.traceId, 'w9');
    assert.equal(ctx.tags.tenantId, 't9');
    assert.equal(ctx.tags.component, 'test');
    assert.equal(ctx.extra.tag, '[BOOM]');
    assert.equal(ctx.extra.conversationId, 'c9');
    assert.equal(ctx.extra.phone, '[phone#3456]');
  });

  it('synthesises a clean Error when no error value is passed', (t) => {
    const capture = t.mock.method(Sentry, 'captureException', () => 'evt-id');
    withEnv('STRUCTURED_LOGGING', undefined, () => {
      t.mock.method(console, 'error', () => {});
      logger.error('[NO_ERR]', undefined, { detail: 1 });
    });
    const [err] = capture.mock.calls[0].arguments as [Error];
    assert.ok(err instanceof Error);
    assert.equal(err.message, '[NO_ERR]');
  });

  it('never lets a Sentry failure throw into the caller (falls back to console.error)', (t) => {
    t.mock.method(Sentry, 'captureException', () => {
      throw new Error('sentry down');
    });
    const err = t.mock.method(console, 'error', () => {});
    withEnv('STRUCTURED_LOGGING', undefined, () => {
      assert.doesNotThrow(() => logger.error('[E]', new Error('x')));
    });
    const tags = err.mock.calls.map((c) => (c.arguments as unknown[])[0]);
    assert.ok(tags.includes('[logger] Sentry captureException failed'));
  });
});

describe('logger — no active context', () => {
  it('emits null ids and does not throw outside any scope', (t) => {
    withEnv('STRUCTURED_LOGGING', 'true', () => {
      const log = t.mock.method(console, 'log', () => {});
      assert.doesNotThrow(() => logger.info('[NOCTX]', { a: 1 }));
      const rec = JSON.parse((log.mock.calls[0].arguments as unknown[])[0] as string);
      assert.equal(rec.correlationId, null);
      assert.equal(rec.traceId, null);
      assert.equal(rec.a, 1);
    });
  });

  it('createLogger binds a fixed context usable without an ALS scope', (t) => {
    withEnv('STRUCTURED_LOGGING', 'true', () => {
      const log = t.mock.method(console, 'log', () => {});
      createLogger({ correlationId: 'bound-1', component: 'boot' }).info('[BOUND]');
      const rec = JSON.parse((log.mock.calls[0].arguments as unknown[])[0] as string);
      assert.equal(rec.correlationId, 'bound-1');
      assert.equal(rec.component, 'boot');
    });
  });
});
