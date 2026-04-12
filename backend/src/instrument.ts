import * as Sentry from '@sentry/node';
import type { Application } from 'express';

let sentryInitialized = false;

/**
 * Initialize Sentry before the Express app is loaded. No-op when SENTRY_DSN is unset.
 */
function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    return;
  }

  const tracesSampleRateRaw = process.env.SENTRY_TRACES_SAMPLE_RATE;
  const tracesSampleRate =
    tracesSampleRateRaw !== undefined && tracesSampleRateRaw !== ''
      ? Math.min(1, Math.max(0, Number(tracesSampleRateRaw)))
      : process.env.NODE_ENV === 'production'
        ? 0.1
        : 1.0;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 0.1,
    integrations: [Sentry.expressIntegration()],
  });

  sentryInitialized = true;
}

export function setupSentryExpressErrorHandler(app: Application): void {
  if (!sentryInitialized) {
    return;
  }
  Sentry.setupExpressErrorHandler(app);
}

initSentry();
