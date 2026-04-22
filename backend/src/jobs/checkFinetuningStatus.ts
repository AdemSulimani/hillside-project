import { createReadStream } from 'fs';
import { finetuningQueue } from './queues';
import { openai, OPENAI_FINETUNING_BASE_MODEL } from '../services/openaiClient';
import { updateAIConfig } from '../db/models/aiConfig';
import pool from '../db/pool';

export interface CheckFinetuningStatusJobData extends Record<string, unknown> {
  tenantId: string;
  fineTuningJobId: string;
}

export async function startFinetuningJob(params: {
  tenantId: string;
  filePath: string;
}): Promise<void> {
  const file = await openai.files.create({
    file: createReadStream(params.filePath),
    purpose: 'fine-tune',
  });

  const fineTune = await openai.fineTuning.jobs.create({
    model: process.env.OPENAI_FINETUNING_BASE_MODEL?.trim() || OPENAI_FINETUNING_BASE_MODEL,
    training_file: file.id,
    suffix: `tenant-${params.tenantId.slice(0, 8)}`,
  });

  await finetuningQueue.add(
    'checkFinetuningStatus',
    {
      tenantId: params.tenantId,
      fineTuningJobId: fineTune.id,
    } satisfies CheckFinetuningStatusJobData,
    {
      delay: 120_000,
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  );
}

/**
 * Poll fine-tuning job status, persist model ids, and continue polling until complete.
 */
export async function checkFinetuningStatus(
  data: CheckFinetuningStatusJobData,
): Promise<void> {
  const job = await openai.fineTuning.jobs.retrieve(data.fineTuningJobId);
  const status = job.status;

  if (status === 'succeeded' && job.fine_tuned_model) {
    await updateAIConfig(data.tenantId, { custom_model_id: job.fine_tuned_model });
    try {
      await pool.query(
        `UPDATE feedback_logs
         SET status = 'trained'
         WHERE tenant_id = $1 AND status = 'included_in_training'`,
        [data.tenantId],
      );
    } catch (err) {
      console.error('[finetuning] failed to mark included feedback as trained', {
        tenantId: data.tenantId,
        fineTuningJobId: data.fineTuningJobId,
        err,
      });
    }
    return;
  }

  if (status === 'failed' || status === 'cancelled') {
    console.error('[finetuning] job did not complete successfully', {
      tenantId: data.tenantId,
      fineTuningJobId: data.fineTuningJobId,
      status,
      error: job.error,
    });
    return;
  }

  await finetuningQueue.add(
    'checkFinetuningStatus',
    data,
    {
      delay: 120_000,
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  );
}
