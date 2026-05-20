import type { Request, Response } from 'express';
import pool from '../db/pool';
import { ensureAIConfigForTenant, updateAIConfig } from '../db/models/aiConfig';
import {
  deleteCustomTenantPromptBlock,
  findTenantPromptBlockForAdmin,
  insertCustomTenantPromptBlock,
  listTenantPromptBlocksRuntime,
  listTenantPromptBlocksWithMeta,
  resetTenantPromptBlockContent,
  updateTenantPromptBlock,
} from '../db/models/promptBlock';
import { invalidateTenantAiCaches } from '../services/invalidateTenantAiCaches';
import { sendSuccess, sendError } from '../utils/response';
import type { TenantAiSnapshot } from '../validators/adminAi';
import { findAIConfigVersion, insertAIConfigVersion, listAIConfigVersions } from '../db/models/aiConfigVersion';
import { findTenantById } from '../db/models/tenant';
import { searchProducts } from '../db/models/product';
import { openai, OPENAI_CHAT_MODEL } from '../services/openaiClient';
import { buildRetailAISystemPrompt, formatProductCatalog } from '../services/aiService';
import { assembleGuidelinesFromBlocks } from '../services/promptAssemblyService';

async function buildTenantAiSnapshot(tenantId: string): Promise<TenantAiSnapshot> {
  const ai = await ensureAIConfigForTenant(tenantId);
  const blocks = await listTenantPromptBlocksWithMeta(tenantId);
  return {
    ai_config: {
      tone: ai.tone,
      personality_description: ai.personality_description,
      restrictions: ai.restrictions ?? [],
      platform_restrictions: ai.platform_restrictions ?? [],
      sales_strategy: ai.sales_strategy,
      objection_handling: ai.objection_handling,
      qa_pairs: ai.qa_pairs ?? [],
      is_active: ai.is_active,
      custom_model_id: ai.custom_model_id,
    },
    prompt_blocks: blocks.map((b) => ({
      block_key: b.block_key,
      prompt_block_id: b.prompt_block_id,
      enabled: b.enabled,
      content: b.content,
      sort_order: b.sort_order,
    })),
  };
}

async function recordAiVersion(tenantId: string, email: string | undefined, note?: string): Promise<void> {
  const snapshot = await buildTenantAiSnapshot(tenantId);
  await insertAIConfigVersion({
    tenantId,
    snapshot: snapshot as unknown as Record<string, unknown>,
    note: note ?? null,
    createdByEmail: email ?? null,
  });
}

export async function getTenantAiConfig(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = String(req.params.tenantId);
    const config = await ensureAIConfigForTenant(tenantId);
    sendSuccess(res, config);
  } catch (err) {
    sendError(res, 'Failed to load AI configuration', 500, err);
  }
}

export async function listTenantPromptBlocks(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = String(req.params.tenantId);
    const rows = await listTenantPromptBlocksWithMeta(tenantId);
    sendSuccess(res, { rows });
  } catch (err) {
    sendError(res, 'Failed to load prompt blocks', 500, err);
  }
}

export async function updateTenantAiConfig(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = String(req.params.tenantId);
    await ensureAIConfigForTenant(tenantId);
    const updated = await updateAIConfig(tenantId, req.body);
    if (!updated) {
      sendError(res, 'AI configuration not found', 404);
      return;
    }
    await invalidateTenantAiCaches(tenantId);
    await recordAiVersion(tenantId, req.admin?.email);
    sendSuccess(res, updated, 'AI configuration updated');
  } catch (err) {
    sendError(res, 'Failed to update AI configuration', 500, err);
  }
}

export async function patchTenantPromptBlock(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = String(req.params.tenantId);
    const blockRowId = String(req.params.blockRowId);
    const existing = await findTenantPromptBlockForAdmin(tenantId, blockRowId);
    if (!existing) {
      sendError(res, 'Prompt block row not found', 404);
      return;
    }

    if (req.body.enabled === false && existing.is_platform_locked === true) {
      sendError(res, 'Cannot disable a platform-locked guideline block', 400);
      return;
    }

    const updated = await updateTenantPromptBlock(tenantId, blockRowId, req.body);
    if (!updated) {
      sendError(res, 'Update failed', 500);
      return;
    }
    await invalidateTenantAiCaches(tenantId);
    await recordAiVersion(tenantId, req.admin?.email);
    sendSuccess(res, updated, 'Prompt block updated');
  } catch (err) {
    sendError(res, 'Failed to update prompt block', 500, err);
  }
}

export async function postTenantPromptBlockReset(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = String(req.params.tenantId);
    const blockRowId = String(req.params.blockRowId);
    const updated = await resetTenantPromptBlockContent(tenantId, blockRowId);
    if (!updated) {
      sendError(res, 'Reset only applies to catalog-linked blocks', 400);
      return;
    }
    await invalidateTenantAiCaches(tenantId);
    await recordAiVersion(tenantId, req.admin?.email);
    sendSuccess(res, updated, 'Prompt block reset to platform default');
  } catch (err) {
    sendError(res, 'Failed to reset prompt block', 500, err);
  }
}

export async function postTenantPromptBlockCustom(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = String(req.params.tenantId);
    const row = await insertCustomTenantPromptBlock(tenantId, req.body);
    await invalidateTenantAiCaches(tenantId);
    await recordAiVersion(tenantId, req.admin?.email);
    sendSuccess(res, row, 'Custom prompt block added');
  } catch (err) {
    sendError(res, 'Failed to add prompt block', 500, err);
  }
}

export async function deleteTenantPromptBlockCustom(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = String(req.params.tenantId);
    const blockRowId = String(req.params.blockRowId);
    const ok = await deleteCustomTenantPromptBlock(tenantId, blockRowId);
    if (!ok) {
      sendError(res, 'Only custom (non-catalog) blocks can be deleted this way', 400);
      return;
    }
    await invalidateTenantAiCaches(tenantId);
    await recordAiVersion(tenantId, req.admin?.email);
    sendSuccess(res, null, 'Prompt block removed');
  } catch (err) {
    sendError(res, 'Failed to delete prompt block', 500, err);
  }
}

export async function listTenantAiVersions(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = String(req.params.tenantId);
    const rows = await listAIConfigVersions(tenantId, 40);
    sendSuccess(res, { rows });
  } catch (err) {
    sendError(res, 'Failed to load versions', 500, err);
  }
}

export async function postRestoreTenantAiVersion(req: Request, res: Response): Promise<void> {
  const client = await pool.connect();
  try {
    const tenantId = String(req.params.tenantId);
    const versionId = String(req.params.versionId);
    const version = await findAIConfigVersion(tenantId, versionId);
    if (!version) {
      sendError(res, 'Version not found', 404);
      return;
    }

    const snap = version.snapshot as unknown as TenantAiSnapshot;
    if (!snap?.ai_config || !Array.isArray(snap.prompt_blocks)) {
      sendError(res, 'Invalid snapshot payload', 500);
      return;
    }

    await client.query('BEGIN');

    await updateAIConfig(
      tenantId,
      {
        tone: snap.ai_config.tone,
        personality_description: snap.ai_config.personality_description,
        restrictions: snap.ai_config.restrictions,
        platform_restrictions: snap.ai_config.platform_restrictions,
        sales_strategy: snap.ai_config.sales_strategy,
        objection_handling: snap.ai_config.objection_handling,
        qa_pairs: snap.ai_config.qa_pairs,
        is_active: snap.ai_config.is_active,
        custom_model_id: snap.ai_config.custom_model_id,
      },
      client,
    );

    for (const b of snap.prompt_blocks) {
      await client.query(
        `UPDATE tenant_prompt_blocks
         SET content = $1, enabled = $2, sort_order = $3, updated_at = now()
         WHERE tenant_id = $4 AND block_key = $5`,
        [b.content, b.enabled, b.sort_order, tenantId, b.block_key],
      );
    }

    await client.query('COMMIT');
    await invalidateTenantAiCaches(tenantId);
    await recordAiVersion(tenantId, req.admin?.email, `restore:${versionId}`);
    sendSuccess(res, { restored_from: versionId }, 'Configuration restored');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, 'Failed to restore version', 500, err);
  } finally {
    client.release();
  }
}

export async function postTenantAiTest(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = String(req.params.tenantId);
    const { testMessage, language, include_vision_block } = req.body as {
      testMessage: string;
      language?: 'sq' | 'en';
      include_vision_block?: boolean;
    };

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Tenant not found', 404);
      return;
    }

    const config = await ensureAIConfigForTenant(tenantId);
    const products = await searchProducts(tenantId, '', 8);
    const catalog = formatProductCatalog(products, { includePrice: true, includeDiscount: true });
    const lang = language ?? 'sq';

    const blockRows = await listTenantPromptBlocksRuntime(tenantId);
    const assembled = assembleGuidelinesFromBlocks(blockRows, { language: lang }, {
      hasImages: Boolean(include_vision_block),
    });

    const systemPrompt = buildRetailAISystemPrompt(
      tenant.name,
      config,
      catalog,
      assembled,
      tenant.niche,
      tenant.description,
    );

    const model = config.custom_model_id?.trim() || OPENAI_CHAT_MODEL;
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: testMessage },
      ],
      temperature: 0.7,
      max_tokens: 1024,
    });

    const reply = completion.choices[0]?.message?.content?.trim();
    if (!reply) {
      sendError(res, 'AI returned an empty response', 500);
      return;
    }

    sendSuccess(res, { reply, model_used: model });
  } catch (err) {
    sendError(res, 'Test request failed', 500, err);
  }
}
