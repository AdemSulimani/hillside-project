/**
 * P2-4 Part 1 (C-109 / OBS-*): the AI path's structured, correlation-keyed, PII-safe logger.
 *
 * The AI reply pipeline made ~18–25 OpenAI calls and logged across `aiService` + `processAIReply`
 * + the classifiers with raw `console.*`, none of it keyed to the message it belongs to — so a
 * single reply's lifecycle could not be reconstructed from the log stream (C-109). This module
 * carries a per-message correlation context through the whole job via `AsyncLocalStorage`
 * (mirroring `openaiCallTracker.ts`'s `runWithOpenAICallTracking`, so NO classifier signature
 * changes are needed) and folds it into every log line and every Sentry event.
 *
 * Two orthogonal switches govern behaviour:
 *   - `STRUCTURED_LOGGING` (default off) — FORMAT only. Off → legacy `console[level](tag, meta)`
 *     shape, byte-for-byte (context is available via ALS but not injected). On → one JSON line
 *     per call carrying `traceId`/`correlationId`/`tenantId`/`conversationId`, grep-joinable.
 *   - `REDACT_PII` (default ON, owned by `utils/redact.ts`) — MASKING. Every `meta` object is run
 *     through `redactValue` before it leaves the process (idempotent, string-leaves-only, a no-op
 *     on non-PII), so structured logs and Sentry `extra` are PII-clean by construction. Known
 *     free-text should still use `logSafe`/`logSafeStructured` at the call site for the sharper
 *     hash-reference form; double application is safe.
 *
 * `logger.error(...)` additionally reports to Sentry (a no-op when `SENTRY_DSN` is unset), with
 * the correlation context as tags — the first Sentry coverage of the reply/generation path. The
 * report is wrapped so a Sentry failure can never throw through into the pipeline.
 */
import * as Sentry from '@sentry/node';
import { AsyncLocalStorage } from 'node:async_hooks';
import { redactValue } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Per-message correlation carried through the whole AI-reply job tree. */
export interface LogContext {
  /** Per-webhook UUID; burst-merge can collapse several webhooks into one reply. */
  traceId?: string | null;
  /** Per-message (= AIReplyJobData.messageExternalId) — the stable per-reply join key. */
  correlationId?: string | null;
  tenantId?: string | null;
  conversationId?: string | null;
  /** Emitting component, e.g. 'processAIReply' | 'aiService' | a classifier name. */
  component?: string | null;
}

export interface Logger {
  debug(tag: string, meta?: Record<string, unknown>): void;
  info(tag: string, meta?: Record<string, unknown>): void;
  warn(tag: string, meta?: Record<string, unknown>): void;
  /** Logs AND reports to Sentry with correlation tags. `err` is the caught value (optional). */
  error(tag: string, err?: unknown, meta?: Record<string, unknown>): void;
  /** Derive a logger with additional fixed context (e.g. a component name). */
  child(extra: Partial<LogContext>): Logger;
}

const ctxStore = new AsyncLocalStorage<LogContext>();

/**
 * Enter an ambient correlation scope for the duration of `fn`. Called once per AI-reply job,
 * nested inside `runWithOpenAICallTracking` at the top of `processAIReply`. Generic over sync or
 * async `fn` — `AsyncLocalStorage.run` propagates the store across awaits.
 */
export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return ctxStore.run(ctx, fn);
}

/** The current ambient context, or an empty object when none is active. */
export function currentLogContext(): LogContext {
  return ctxStore.getStore() ?? {};
}

/** Read the format flag lazily (per call) so tests can toggle it without re-importing. */
function structuredEnabled(): boolean {
  return (process.env.STRUCTURED_LOGGING ?? 'false').trim().toLowerCase() === 'true';
}

function consoleFn(level: LogLevel): (...args: unknown[]) => void {
  if (level === 'error') return console.error;
  if (level === 'warn') return console.warn;
  if (level === 'debug') return console.debug;
  return console.info;
}

function safeRedact(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (meta === undefined) return undefined;
  return redactValue(meta) as Record<string, unknown>;
}

function emit(
  level: LogLevel,
  bound: LogContext,
  tag: string,
  meta?: Record<string, unknown>,
): void {
  const safeMeta = safeRedact(meta);

  if (!structuredEnabled()) {
    // LEGACY PATH — preserve the existing `console[level](tag, meta)` shape byte-for-byte. Context
    // is intentionally NOT injected here so default stdout is unchanged; ids are still available
    // via ALS the moment ops flips STRUCTURED_LOGGING on.
    if (safeMeta === undefined) consoleFn(level)(tag);
    else consoleFn(level)(tag, safeMeta);
    return;
  }

  // STRUCTURED PATH — one JSON line per call, correlation-keyed and grep-able by correlationId.
  const ctx = { ...currentLogContext(), ...bound };
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    tag,
    traceId: ctx.traceId ?? null,
    correlationId: ctx.correlationId ?? null,
    tenantId: ctx.tenantId ?? null,
    conversationId: ctx.conversationId ?? null,
    component: ctx.component ?? null,
    ...(safeMeta ?? {}),
  };
  console.log(JSON.stringify(record));
}

function errMessage(err: unknown): string | undefined {
  if (err === undefined) return undefined;
  return err instanceof Error ? err.message : String(err);
}

function reportSentry(
  bound: LogContext,
  tag: string,
  err: unknown,
  meta?: Record<string, unknown>,
): void {
  const ctx = { ...currentLogContext(), ...bound };
  try {
    const captured =
      err instanceof Error
        ? err
        : new Error(err === undefined ? tag : `${tag}: ${String(err)}`);
    Sentry.captureException(captured, {
      tags: {
        component: ctx.component ?? 'ai',
        traceId: ctx.traceId ?? undefined,
        correlationId: ctx.correlationId ?? undefined,
        tenantId: ctx.tenantId ?? undefined,
      },
      extra: {
        tag,
        conversationId: ctx.conversationId ?? null,
        ...(safeRedact(meta) ?? {}),
      },
    });
  } catch (sentryErr) {
    // Reporting must never throw into the pipeline (mirrors failureHandler.ts).
    console.error('[logger] Sentry captureException failed', {
      err: sentryErr instanceof Error ? sentryErr.message : String(sentryErr),
    });
  }
}

function make(bound: LogContext): Logger {
  return {
    debug: (tag, meta) => emit('debug', bound, tag, meta),
    info: (tag, meta) => emit('info', bound, tag, meta),
    warn: (tag, meta) => emit('warn', bound, tag, meta),
    error: (tag, err, meta) => {
      // Keep the caught error's message on the log line too (matches the legacy `{ err }` shape),
      // while the full exception object goes to Sentry.
      const logMeta =
        err !== undefined ? { ...(meta ?? {}), err: errMessage(err) } : meta;
      emit('error', bound, tag, logMeta);
      reportSentry(bound, tag, err, meta);
    },
    child: (extra) => make({ ...bound, ...extra }),
  };
}

/** Ambient-context logger — reads the ALS context at emit time. Use inside the AI-reply job tree. */
export const logger: Logger = make({});

/** Bind a fixed context (e.g. at job entry) for a stable child logger. */
export function createLogger(ctx: LogContext): Logger {
  return make(ctx);
}
