import { toFile } from 'openai/uploads';
import pool from '../db/pool';
import { findAIConfigByTenant } from '../db/models/aiConfig';
import {
  listPendingFeedbackLogsForTenant,
  listTenantIdsEligibleForFinetuning,
  updateFeedbackLogsStatus,
  type FeedbackLog,
} from '../db/models/feedbackLog';
import {
  findMessageByIdForTenant,
  listMessagesBeforeForConversation,
  type Message,
} from '../db/models/message';
import { finetuningQueue } from './queues';
import { openai } from '../services/openaiClient';
import { uploadFile } from '../services/backblazeService';

export type PrepareFinetuningJobData = Record<string, never>;
export interface StartFinetuningJobData {
  tenantId: string;
  filePath: string;
}

export type FinetuningChatRole = 'system' | 'user' | 'assistant';

export interface FinetuningChatMessage {
  role: FinetuningChatRole;
  content: string;
}

export interface FinetuningJsonlLine {
  messages: FinetuningChatMessage[];
}

function parseFinetuningThreshold(): number {
  const raw = process.env.FINETUNING_THRESHOLD;
  if (raw === undefined || raw === '') return 50;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

/** BullMQ repeat pattern: 2:00 UTC nightly (override with FINETUNING_CRON). */
function finetuningCronPattern(): string {
  return process.env.FINETUNING_CRON?.trim() || '0 2 * * *';
}

function mapMessageToRole(message: Message): FinetuningChatRole | null {
  if (message.type !== 'text') return null;
  const text = (message.content ?? '').trim();
  if (!text) return null;
  if (message.sent_by === 'customer') return 'user';
  if (message.sent_by === 'ai' || message.sent_by === 'human') return 'assistant';
  return null;
}

function mergeAdjacentSameRole(messages: FinetuningChatMessage[]): FinetuningChatMessage[] {
  const merged: FinetuningChatMessage[] = [];
  for (const m of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }
  return merged;
}

function priorMessagesToChatMessages(prior: Message[]): FinetuningChatMessage[] {
  const mapped: FinetuningChatMessage[] = [];
  for (const m of prior) {
    const role = mapMessageToRole(m);
    if (!role) continue;
    mapped.push({ role, content: (m.content ?? '').trim() });
  }
  return mergeAdjacentSameRole(mapped);
}

async function buildSystemPrompt(tenantId: string): Promise<FinetuningChatMessage> {
  const ac = await findAIConfigByTenant(tenantId);
  if (!ac) {
    return {
      role: 'system',
      content: 'You are a helpful customer support assistant.',
    };
  }
  const parts = [`Tone: ${ac.tone}.`];
  if (ac.personality_description?.trim()) {
    parts.push(ac.personality_description.trim());
  }
  const content = parts.join(' ').slice(0, 8000);
  return {
    role: 'system',
    content: content || 'You are a helpful customer support assistant.',
  };
}

function ensureUserBeforeFinalAssistant(messages: FinetuningChatMessage[]): FinetuningChatMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    return [
      ...messages,
      { role: 'user', content: 'Provide the preferred assistant reply for this turn.' },
    ];
  }
  return messages;
}

function targetAssistantContent(log: FeedbackLog): string {
  const corrected = log.corrected_response?.trim();
  if (corrected) return corrected;
  return log.original_ai_response;
}

export async function buildFinetuningLineForLog(log: FeedbackLog): Promise<FinetuningJsonlLine | null> {
  const flagged = await findMessageByIdForTenant(log.message_id, log.tenant_id);
  if (!flagged) return null;

  const prior = await listMessagesBeforeForConversation(
    log.conversation_id,
    log.tenant_id,
    flagged.created_at,
    flagged.id,
    200,
  );

  const system = await buildSystemPrompt(log.tenant_id);
  const history = priorMessagesToChatMessages(prior);
  let withUser = ensureUserBeforeFinalAssistant(history);
  if (withUser.length === 0) {
    withUser = [
      {
        role: 'user',
        content:
          'Prior transcript was unavailable for this example. Produce the preferred assistant reply.',
      },
    ];
  }
  const assistantContent = targetAssistantContent(log);
  const messages: FinetuningChatMessage[] = [
    system,
    ...withUser,
    { role: 'assistant', content: assistantContent },
  ];

  return { messages };
}

function utcDateStamp(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function processPrepareFinetuning(): Promise<void> {
  const threshold = parseFinetuningThreshold();
  const tenantIds = await listTenantIdsEligibleForFinetuning(threshold);

  if (tenantIds.length === 0) {
    console.info('[finetuning.prepare] No eligible tenants');
    return;
  }

  const runDate = utcDateStamp(new Date());

  for (const tenantId of tenantIds) {
    const pending = await listPendingFeedbackLogsForTenant(tenantId);
    if (pending.length === 0) continue;

    const lines: string[] = [];
    const includedIds: string[] = [];

    for (const log of pending) {
      try {
        const doc = await buildFinetuningLineForLog(log);
        if (!doc) continue;
        lines.push(JSON.stringify(doc));
        includedIds.push(log.id);
      } catch (err) {
        console.error('[finetuning.prepare] Skipping log due to error', {
          tenantId,
          logId: log.id,
          error: err instanceof Error ? err.message : err,
        });
      }
    }

    if (lines.length === 0) continue;

    const filename = `tenant_${tenantId}_${runDate}.jsonl`;
    const jsonlContent = `${lines.join('\n')}\n`;
    await uploadFile(Buffer.from(jsonlContent, 'utf8'), filename, 'text/plain', 'finetuning');
    const fileBuffer = Buffer.from(jsonlContent, 'utf8');
    const uploadedFile = await openai.files.create({
      file: await toFile(fileBuffer, filename, { type: 'application/jsonl' }),
      purpose: 'fine-tune',
    });
    await openai.fineTuning.jobs.create({
      training_file: uploadedFile.id,
      model: 'gpt-4o',
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await updateFeedbackLogsStatus(tenantId, includedIds, 'included_in_training', client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[finetuning.prepare] Failed to update feedback log statuses', {
        tenantId,
        error: err instanceof Error ? err.message : err,
      });
      throw err;
    } finally {
      client.release();
    }

    console.info('[finetuning.prepare] Uploaded training file', {
      tenantId,
      fileId: uploadedFile.id,
      rows: includedIds.length,
    });
  }
}

export async function initPrepareFinetuningScheduler(): Promise<void> {
  const pattern = finetuningCronPattern();
  await finetuningQueue.upsertJobScheduler(
    'finetuning-prepare-nightly',
    { pattern },
    {
      name: 'prepareFinetuning',
      data: {},
      opts: {
        attempts: 1,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    },
  );
  console.info('[finetuning.prepare] Scheduler registered', { pattern });
}
