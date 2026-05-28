import pool from '../db/pool';
import { checkAndCreateUseCase } from '../services/aiUseCaseService';

export interface EvaluateUseCaseJobData {
  conversationId: string;
  tenantId: string;
}

/**
 * Evaluates whether a conversation qualifies as a billable AI use case and records it.
 *
 * This job is enqueued in two scenarios:
 *  1. After every AI reply, with a 4-hour delay (inactivity-based resolution).
 *  2. When a conversation is explicitly closed by the tenant, with no delay.
 *
 * BullMQ deduplication: both enqueue calls use the same jobId = `eval-usecase-{conversationId}`.
 * If an early close fires before the delayed job runs, BullMQ skips the duplicate.
 */
export async function processEvaluateConversationUseCase(
  data: EvaluateUseCaseJobData,
): Promise<void> {
  const { conversationId, tenantId } = data;

  const { rows } = await pool.query<{ contact_id: string }>(
    'SELECT contact_id FROM conversations WHERE id = $1 AND tenant_id = $2 LIMIT 1',
    [conversationId, tenantId],
  );

  const contactId = rows[0]?.contact_id;
  if (!contactId) {
    console.info('[use-case] Skipping eval: conversation not found', { conversationId, tenantId });
    return;
  }

  await checkAndCreateUseCase(conversationId, tenantId, contactId);
}
