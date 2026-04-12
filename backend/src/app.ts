import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
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
import { errorHandler } from './middleware/errorHandler';

const app = express();
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: false }));

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  }),
);

const isDev = process.env.NODE_ENV !== 'production';

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isDev ? 1000 : 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests, please try again later.' },
  }),
);

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/storage/attachments', express.static(path.join(__dirname, '../storage/attachments')));

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

app.use(errorHandler);

export default app;
