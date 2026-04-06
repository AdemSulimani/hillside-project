import { Router } from 'express';
import pool from '../db/pool';
import { sendSuccess, sendError } from '../utils/response';

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

export default router;
