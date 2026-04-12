import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { Express } from 'express';
import { requireAdminKey } from '../middleware/requireAdminKey';
import {
  webhookQueue,
  aiQueue,
  notificationsQueue,
  finetuningQueue,
  defaultQueue,
} from './queues';

const basePath = '/admin/queues';

export function mountBullBoard(app: Express): void {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(basePath);

  createBullBoard({
    queues: [
      new BullMQAdapter(webhookQueue),
      new BullMQAdapter(aiQueue),
      new BullMQAdapter(notificationsQueue),
      new BullMQAdapter(finetuningQueue),
      new BullMQAdapter(defaultQueue),
    ],
    serverAdapter,
  });

  app.use(basePath, requireAdminKey, serverAdapter.getRouter());
}
