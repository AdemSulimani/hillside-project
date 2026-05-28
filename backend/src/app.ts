import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import healthRouter from './routes/health';
import authRouter from './routes/auth';
import onboardingRouter from './routes/onboarding';
import dashboardRouter from './routes/dashboard';
import profileRouter from './routes/profile';
import businessRouter from './routes/business';
import productsRouter from './routes/products';
import channelsRouter from './routes/channels';
import conversationsRouter from './routes/conversations';
import oauthRouter from './routes/oauth';
import webhooksRouter from './routes/webhooks';
import aiConfigRouter from './routes/aiConfig';
import ordersRouter from './routes/orders';
import contactsRouter from './routes/contacts';
import feedbackRouter from './routes/feedback';
import statisticsRouter from './routes/statistics';
import chatbotRouter from './routes/chatbot';
import adminRouter from './routes/admin';
import aiAlertsRouter from './routes/aiAlerts';
import escalationsRouter from './routes/escalations';
import creditsRouter from './routes/credits';
import { errorHandler } from './middleware/errorHandler';
import { mountBullBoard } from './jobs/bullBoard';
import { setupSentryExpressErrorHandler } from './instrument';

const app = express();
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: false }));

app.use(compression());

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
  app.use(morgan('dev'));
}

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  }),
);

/**
 * Rate limiting strategy
 *
 * The previous setup applied a single 100 req / 15 min limit to every endpoint, which
 * was orders of magnitude too low for a real SPA: a single user opening the app fires
 * 5–10 calls (`/auth/refresh`, `/auth/me`, `/onboarding/status`, `/business`, dashboard
 * widgets, ...) and each navigation adds more. Worse, `/api/auth/refresh` shared the
 * bucket with everything else, so once exhausted no one could log in or stay signed in.
 *
 * We now apply:
 *  - a strict limiter only on the abuse-prone endpoints (login, register)
 *  - a generous global limiter on everything else
 *  - explicit exemption of `/api/health`, `/api/auth/refresh`, and `/api/webhooks/*`
 *    because they're called frequently or come from servers we don't want to rate-limit.
 *
 * Defaults can be tuned via env vars without redeploying code.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const isProduction = process.env.NODE_ENV === 'production';

const generalLimiter = rateLimit({
  windowMs: envInt('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  max: envInt('RATE_LIMIT_MAX', isProduction ? 1500 : 5000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
  skip: (req) => {
    const url = req.originalUrl || req.url;
    return (
      url.startsWith('/api/health') ||
      url.startsWith('/api/auth/refresh') ||
      url.startsWith('/api/webhooks')
    );
  },
});

const authLimiter = rateLimit({
  windowMs: envInt('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  max: envInt('AUTH_RATE_LIMIT_MAX', isProduction ? 30 : 200),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts, please try again later.' },
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use(generalLimiter);

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/profile', profileRouter);
app.use('/api/business', businessRouter);
app.use('/api/products', productsRouter);
app.use('/api/channels', channelsRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/oauth', oauthRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/ai-config', aiConfigRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/statistics', statisticsRouter);
app.use('/api/chatbot', chatbotRouter);
app.use('/api/admin', adminRouter);
app.use('/api/ai-alerts', aiAlertsRouter);
app.use('/api/escalations', escalationsRouter);
app.use('/api/credits', creditsRouter);

mountBullBoard(app);

setupSentryExpressErrorHandler(app);

app.use(errorHandler);

export default app;
