import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import healthRouter from './routes/health';
import { errorHandler } from './middleware/errorHandler';

const app = express();

app.use(helmet());

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  }),
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests, please try again later.' },
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/health', healthRouter);

app.use(errorHandler);

export default app;
