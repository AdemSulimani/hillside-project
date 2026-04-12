import { Router } from 'express';
import pool from '../db/pool';
import { sendSuccess, sendError } from '../utils/response';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import * as healthController from '../controllers/healthController';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    const duration = Date.now() - start;

    sendSuccess(res, {
      status: 'healthy',
      database: { connected: true, responseTime: `${duration}ms` },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    sendError(
      res,
      'Database connection failed',
      503,
      err,
    );
  }
});

router.get('/queues', authenticate, ensureOnboarded, healthController.queues);

export default router;
