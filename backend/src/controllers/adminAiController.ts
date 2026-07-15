import type { Request, Response } from 'express';
import pool from '../db/pool';
import { ensureAIConfigForTenant, findAIConfigByTenant, updateAIConfig } from '../db/models/aiConfig';
import {
  deleteCustomTenantPromptBlock,
  findTenantPromptBlockForAdmin,
  forceSyncLockedBlocksForTenants,
  insertCatalogPromptBlock,
  insertCustomTenantPromptBlock,
  listAllCatalogPromptBlocks,
  listTenantPromptBlocksRuntime,
  listTenantPromptBlocksWithMeta,
  resetTenantPromptBlockContent,
  syncNewCatalogBlocksForTenant,
  syncNewCatalogBlocksForTenants,
  updateCatalogPromptBlock,
  updateTenantPromptBlock,
} from '../db/models/promptBlock';
import { invalidateTenantAiCaches } from '../services/invalidateTenantAiCaches';
import { writeThroughAiConfig } from '../services/aiConfigCache';
import { sendSuccess, sendError } from '../utils/response';
import type { TenantAiSnapshot } from '../validators/adminAi';
import { findAIConfigVersion, insertAIConfigVersion, listAIConfigVersions } from '../db/models/aiConfigVersion';
import { findTenantById } from '../db/models/tenant';
import { searchProducts } from '../db/models/product';
import { findImageUrlsWithoutFingerprints } from '../db/models/productImageFingerprint';
import { defaultQueue } from '../jobs/queues';
import { openai, OPENAI_CHAT_MODEL } from '../services/openaiClient';
import { buildRestrictionsFooter, buildRetailAISystemPrompt, formatProductCatalog } from '../services/aiService';
import {
  PRODUCT_DESCRIPTION_CONCISE_APPEND,
  SHORTEST_ANSWER_APPEND,
} from '../services/productDescriptionPromptService';
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
    // P2-3 (RC-17): write-through the fresh row so the edit propagates fleet-wide within one request
    // (no-op when the versioned-cache flag is off).
    await writeThroughAiConfig(tenantId, updated);
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

    // Normalise the key the same way the model will before checking for duplicates.
    const rawKey: string = req.body.block_key ?? '';
    const normalisedKey = rawKey.startsWith('custom_') ? rawKey : `custom_${rawKey}`;

    const existingBlocks = await listTenantPromptBlocksWithMeta(tenantId);
    const duplicate = existingBlocks.find((b) => b.block_key === normalisedKey);
    if (duplicate) {
      sendError(res, `A prompt block with key "${normalisedKey}" already exists for this tenant`, 409);
      return;
    }

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

    const snapshotKeys = new Set(snap.prompt_blocks.map((b) => b.block_key));

    // Update blocks that exist in both the snapshot and the DB.
    for (const b of snap.prompt_blocks) {
      await client.query(
        `UPDATE tenant_prompt_blocks
         SET content = $1, enabled = $2, sort_order = $3, updated_at = now()
         WHERE tenant_id = $4 AND block_key = $5`,
        [b.content, b.enabled, b.sort_order, tenantId, b.block_key],
      );
    }

    // Re-insert custom blocks that were in the snapshot but no longer exist in the DB.
    // Catalog-linked blocks (prompt_block_id IS NOT NULL) are managed by the platform and
    // are intentionally skipped here — they will already exist or get re-seeded separately.
    const customInSnapshot = snap.prompt_blocks.filter((b) => b.prompt_block_id === null);
    for (const b of customInSnapshot) {
      await client.query(
        `INSERT INTO tenant_prompt_blocks (tenant_id, prompt_block_id, block_key, enabled, content, sort_order)
         VALUES ($1, NULL, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, block_key) DO NOTHING`,
        [tenantId, b.block_key, b.enabled, b.content, b.sort_order],
      );
    }

    // Remove custom blocks that exist in the DB but were NOT in the snapshot — these
    // were added after the snapshot was taken and must be removed to fully restore state.
    // Catalog-linked blocks (prompt_block_id IS NOT NULL) are intentionally preserved.
    const placeholders = [...snapshotKeys]
      .map((_, i) => `$${i + 2}`)
      .join(', ');
    if (snapshotKeys.size > 0) {
      await client.query(
        `DELETE FROM tenant_prompt_blocks
         WHERE tenant_id = $1
           AND prompt_block_id IS NULL
           AND block_key NOT IN (${placeholders})`,
        [tenantId, ...snapshotKeys],
      );
    } else {
      // Snapshot had no custom blocks — remove all custom blocks for this tenant.
      await client.query(
        `DELETE FROM tenant_prompt_blocks
         WHERE tenant_id = $1 AND prompt_block_id IS NULL`,
        [tenantId],
      );
    }

    await client.query('COMMIT');
    await invalidateTenantAiCaches(tenantId);
    // P2-3 (RC-17): write-through the restored row (re-fetched post-commit) so the restore propagates
    // fleet-wide within one request (no-op when the versioned-cache flag is off).
    await writeThroughAiConfig(tenantId, await findAIConfigByTenant(tenantId));
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

    let systemPrompt = buildRetailAISystemPrompt(
      tenant.name,
      config,
      catalog,
      assembled,
      tenant.niche,
      tenant.description,
      tenant.delivery_methods,
    );

    // Mirror the production reply path: the platform-enforced brevity rule is appended
    // before the restrictions footer. P2-5: production appends PRODUCT_DESCRIPTION_CONCISE_APPEND
    // immediately after SHORTEST_ANSWER_APPEND (aiService, the always-on pair) — the preview
    // omitted it and so did not actually mirror the prompt it claimed to preview.
    systemPrompt += SHORTEST_ANSWER_APPEND;
    systemPrompt += PRODUCT_DESCRIPTION_CONCISE_APPEND;

    // Restrictions are appended last so the test prompt mirrors production behaviour. P2-5:
    // the locale is threaded through, so the preview shows the same platform rulebook the
    // customer would actually receive.
    const restrictionsFooter = buildRestrictionsFooter(config, lang);
    if (restrictionsFooter) {
      systemPrompt += restrictionsFooter;
    }

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

// ——————————————————————————————————————————
// Platform catalog block management
// ——————————————————————————————————————————

export async function listCatalogBlocks(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listAllCatalogPromptBlocks(true);
    sendSuccess(res, { rows });
  } catch (err) {
    sendError(res, 'Failed to load catalog blocks', 500, err);
  }
}

export async function createCatalogBlock(req: Request, res: Response): Promise<void> {
  try {
    const { sync_to_existing, ...blockInput } = req.body as {
      key: string;
      title: string;
      description?: string | null;
      default_content: string;
      category: string;
      sort_order: number;
      is_platform_locked: boolean;
      is_active: boolean;
      sync_to_existing?: boolean;
    };

    const created = await insertCatalogPromptBlock(blockInput);

    let syncSummary: { tenants_updated: number; total_blocks_added: number } | null = null;
    if (sync_to_existing && created.is_active) {
      const results = await syncNewCatalogBlocksForTenants();
      await Promise.all(
        results.map(async ({ tenant_id, added_block_keys }) => {
          await invalidateTenantAiCaches(tenant_id);
          await recordAiVersion(
            tenant_id,
            req.admin?.email,
            `catalog-sync:${added_block_keys.length}-blocks-added`,
          );
        }),
      );
      syncSummary = {
        tenants_updated: results.length,
        total_blocks_added: results.reduce((s, r) => s + r.added_block_keys.length, 0),
      };
    }

    sendSuccess(res, { block: created, sync: syncSummary }, 'Platform guideline created');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
      sendError(res, 'A catalog block with that key already exists', 409);
      return;
    }
    sendError(res, 'Failed to create catalog block', 500, err);
  }
}

export async function updateCatalogBlock(req: Request, res: Response): Promise<void> {
  try {
    const blockId = String(req.params.blockId);
    const { sync_to_existing, ...updateInput } = req.body as {
      title?: string;
      description?: string | null;
      default_content?: string;
      category?: string;
      sort_order?: number;
      is_platform_locked?: boolean;
      is_active?: boolean;
      sync_to_existing?: boolean;
    };

    const updated = await updateCatalogPromptBlock(blockId, updateInput);
    if (!updated) {
      sendError(res, 'Catalog block not found', 404);
      return;
    }

    let syncSummary: { tenants_updated: number; total_blocks_added: number } | null = null;
    if (sync_to_existing && updated.is_active) {
      const results = await syncNewCatalogBlocksForTenants();
      await Promise.all(
        results.map(async ({ tenant_id, added_block_keys }) => {
          await invalidateTenantAiCaches(tenant_id);
          await recordAiVersion(
            tenant_id,
            req.admin?.email,
            `catalog-sync:${added_block_keys.length}-blocks-added`,
          );
        }),
      );
      syncSummary = {
        tenants_updated: results.length,
        total_blocks_added: results.reduce((s, r) => s + r.added_block_keys.length, 0),
      };
    }

    sendSuccess(res, { block: updated, sync: syncSummary }, 'Platform guideline updated');
  } catch (err) {
    sendError(res, 'Failed to update catalog block', 500, err);
  }
}

/**
 * Syncs missing platform catalog blocks into a single tenant.
 * Existing blocks (even customised ones) are never overwritten.
 */
export async function postSyncTenantCatalogBlocks(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = String(req.params.tenantId);
    const addedKeys = await syncNewCatalogBlocksForTenant(tenantId);
    if (addedKeys.length > 0) {
      await invalidateTenantAiCaches(tenantId);
      await recordAiVersion(tenantId, req.admin?.email, `catalog-sync:${addedKeys.length}-blocks-added`);
    }
    sendSuccess(res, {
      added_count: addedKeys.length,
      added_block_keys: addedKeys,
    }, addedKeys.length > 0
      ? `${addedKeys.length} new platform guideline(s) added`
      : 'Already up to date — no new guidelines found');
  } catch (err) {
    sendError(res, 'Failed to sync catalog blocks', 500, err);
  }
}

/**
 * Syncs missing platform catalog blocks across all tenants (or a specified subset).
 * Accepts an optional { tenantIds: string[] } body — omit or send an empty array
 * to target every tenant in the system.
 */
export async function postSyncAllCatalogBlocks(req: Request, res: Response): Promise<void> {
  try {
    const tenantIds: string[] | undefined = Array.isArray(req.body?.tenantIds)
      ? (req.body.tenantIds as string[])
      : undefined;

    const results = await syncNewCatalogBlocksForTenants(tenantIds);

    // Invalidate AI caches and record a version snapshot only for tenants that
    // actually received new blocks — skip clean tenants to avoid noise.
    await Promise.all(
      results.map(async ({ tenant_id, added_block_keys }) => {
        await invalidateTenantAiCaches(tenant_id);
        await recordAiVersion(
          tenant_id,
          req.admin?.email,
          `catalog-sync:${added_block_keys.length}-blocks-added`,
        );
      }),
    );

    const totalAdded = results.reduce((sum, r) => sum + r.added_block_keys.length, 0);
    sendSuccess(res, {
      tenants_updated: results.length,
      total_blocks_added: totalAdded,
      details: results,
    }, totalAdded > 0
      ? `${totalAdded} new platform guideline(s) distributed across ${results.length} business(es)`
      : 'All businesses are already up to date');
  } catch (err) {
    sendError(res, 'Failed to sync catalog blocks', 500, err);
  }
}

/**
 * Backfills missing product embeddings for a tenant.
 * Queues a `product.embedding` job for every active product whose `embedding`
 * column is NULL — typically products that were bulk-imported before the
 * embedding pipeline was hooked into the document upload controller.
 *
 * POST /admin/businesses/:tenantId/products/backfill-embeddings
 */
export async function postBackfillProductEmbeddings(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.params.tenantId as string;

    const { rows } = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM products
       WHERE tenant_id = $1
         AND deleted_at IS NULL
         AND is_active = true
         AND embedding IS NULL`,
      [tenantId],
    );

    if (rows.length === 0) {
      sendSuccess(res, { queued: 0 }, 'All products already have embeddings');
      return;
    }

    // Priority 3 — admin-initiated, lower than live edits/imports (1-2) but above
    // automated reconciliation (5) so operators can manually force a backfill quickly.
    await Promise.all(
      rows.map((p) =>
        defaultQueue.add('product.embedding', { productId: p.id, tenantId }, { priority: 3 }),
      ),
    );

    console.info('[admin] Queued embedding backfill', { tenantId, count: rows.length });

    sendSuccess(
      res,
      { queued: rows.length, product_ids: rows.map((p) => p.id) },
      `Queued embedding generation for ${rows.length} product(s)`,
    );
  } catch (err) {
    sendError(res, 'Failed to backfill embeddings', 500, err);
  }
}

/**
 * Re-generates embeddings for ALL active products of a tenant, regardless of
 * whether they already have an embedding.  Use this after any change to the
 * embedding schema — e.g. adding usage_description to the indexed text — so
 * that all vectors reflect the current field set.
 *
 * POST /admin/businesses/:tenantId/products/reembed-all
 */
export async function postReembedAllProducts(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.params.tenantId as string;

    const { rows } = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM products
       WHERE tenant_id = $1
         AND deleted_at IS NULL
         AND is_active = true
       ORDER BY created_at ASC`,
      [tenantId],
    );

    if (rows.length === 0) {
      sendSuccess(res, { queued: 0 }, 'No active products found for this tenant');
      return;
    }

    // Priority 3 — same as backfill, below live edits/imports so a full re-embed of a
    // large catalog doesn't starve normal product update jobs.
    await Promise.all(
      rows.map((p) =>
        defaultQueue.add('product.embedding', { productId: p.id, tenantId }, { priority: 3 }),
      ),
    );

    console.info('[admin] Queued full re-embed for all products', {
      tenantId,
      count: rows.length,
    });

    sendSuccess(
      res,
      { queued: rows.length, product_ids: rows.map((p) => p.id) },
      `Queued embedding regeneration for all ${rows.length} product(s)`,
    );
  } catch (err) {
    sendError(res, 'Failed to queue re-embed for all products', 500, err);
  }
}

/**
 * Queues visual fingerprint generation for catalog product images that lack
 * embeddings (used for customer photo → product matching).
 *
 * POST /admin/businesses/:tenantId/products/backfill-image-fingerprints
 */
export async function postBackfillProductImageFingerprints(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.params.tenantId as string;
    const candidates = await findImageUrlsWithoutFingerprints(tenantId, 500);

    if (candidates.length === 0) {
      sendSuccess(res, { queued: 0 }, 'All catalog images already have visual fingerprints');
      return;
    }

    await Promise.all(
      candidates.map((row) =>
        defaultQueue.add(
          'product.imageFingerprint',
          { productId: row.product_id, tenantId: row.tenant_id, imageUrl: row.image_url },
          { priority: 3 },
        ),
      ),
    );

    console.info('[admin] Queued image fingerprint backfill', {
      tenantId,
      count: candidates.length,
    });

    sendSuccess(
      res,
      { queued: candidates.length },
      `Queued visual fingerprint generation for ${candidates.length} catalog image(s)`,
    );
  } catch (err) {
    sendError(res, 'Failed to backfill image fingerprints', 500, err);
  }
}

/**
 * Force-pushes the current catalog default content of every platform-locked
 * prompt block to all tenants (or a specified subset), overwriting whatever
 * content is currently stored in tenant_prompt_blocks.
 *
 * This is the recovery action for when a migration's exact-string sync
 * failed to update some tenants and their AI is operating with stale instructions.
 *
 * Accepts an optional { tenantIds: string[] } body — omit or send an empty
 * array to target every tenant in the system.
 *
 * POST /admin/ai/prompt-blocks/force-sync-locked
 */
export async function postForceSyncLockedBlocks(req: Request, res: Response): Promise<void> {
  try {
    const tenantIds: string[] | undefined = Array.isArray(req.body?.tenantIds)
      ? (req.body.tenantIds as string[])
      : undefined;

    const results = await forceSyncLockedBlocksForTenants(tenantIds);

    await Promise.all(
      results.map(async ({ tenant_id, updated_block_keys }) => {
        await invalidateTenantAiCaches(tenant_id);
        await recordAiVersion(
          tenant_id,
          req.admin?.email,
          `force-sync-locked:${updated_block_keys.length}-blocks-updated`,
        );
      }),
    );

    const totalUpdated = results.reduce((sum, r) => sum + r.updated_block_keys.length, 0);
    sendSuccess(
      res,
      {
        tenants_updated: results.length,
        total_blocks_updated: totalUpdated,
        details: results,
      },
      totalUpdated > 0
        ? `Forced ${totalUpdated} locked block(s) up-to-date across ${results.length} business(es)`
        : 'All businesses are already on the latest locked block content',
    );
  } catch (err) {
    sendError(res, 'Failed to force-sync locked prompt blocks', 500, err);
  }
}
