/**
 * P1-A — attribute backfill CLI.
 *
 * Populates empty structured attribute columns (flavor, size, color, variant, weight, brand) from
 * each product's OWN text via a deterministic regex pass + a verbatim-verified LLM pass. See
 * services/attributeBackfillService.ts for the extraction/merge rules.
 *
 * Usage:
 *   npm run attribute-backfill                      # dry-run, all tenants
 *   npm run attribute-backfill -- --tenant <uuid>   # dry-run, one tenant
 *   npm run attribute-backfill -- --apply           # write the proposals
 *   npm run attribute-backfill -- --force           # revisit provenance-stamped rows
 *   npm run attribute-backfill -- --limit 100 --batch 15
 *
 * Dry-run by default: prints the full per-product proposal table and writes nothing.
 * Apply stamps `metadata.attribute_backfill = { version, at, model, fields }` per row; writes go
 * through `updateProduct`, which nulls the row's embedding — the fast reconcile cron re-embeds
 * within ~1 minute (no manual step needed).
 */
import 'dotenv/config';
import pool from '../db/pool';
import { updateProduct, type Product } from '../db/models/product';
import { resolveModel } from '../config/models';
import {
  BACKFILL_ATTRIBUTE_KEYS,
  BACKFILL_VERSION,
  extractAttributesBatch,
  mergeBackfillValues,
  type BackfillProposal,
} from '../services/attributeBackfillService';

interface CliArgs {
  tenant: string | null;
  limit: number;
  batch: number;
  apply: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { tenant: null, limit: 500, batch: 15, apply: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--tenant') args.tenant = argv[++i] ?? null;
    else if (arg === '--limit') {
      const n = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) args.limit = n;
    } else if (arg === '--batch') {
      const n = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0 && n <= 50) args.batch = n;
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error('Usage: tsx src/scripts/backfillProductAttributes.ts [--tenant <uuid>] [--limit N] [--batch N] [--apply] [--force]');
      process.exit(1);
    }
  }
  return args;
}

async function selectCandidates(args: CliArgs): Promise<Product[]> {
  const params: unknown[] = [];
  const conditions = [
    'deleted_at IS NULL',
    'is_active = true',
    "(flavor IS NULL OR size IS NULL OR variant IS NULL OR weight IS NULL OR brand IS NULL)",
  ];
  if (!args.force) {
    conditions.push("(metadata->'attribute_backfill'->>'version') IS NULL");
  }
  if (args.tenant) {
    params.push(args.tenant);
    conditions.push(`tenant_id = $${params.length}`);
  }
  params.push(args.limit);
  const { rows } = await pool.query<Product>(
    `SELECT * FROM products WHERE ${conditions.join(' AND ')} ORDER BY name ASC LIMIT $${params.length}::int`,
    params,
  );
  return rows;
}

function formatProposal(product: Product, proposal: BackfillProposal): string {
  const parts = BACKFILL_ATTRIBUTE_KEYS.flatMap((key) => {
    const value = proposal.updates[key];
    return value ? [`${key}=${JSON.stringify(value)} (${proposal.fields[key]})`] : [];
  });
  const rejected = BACKFILL_ATTRIBUTE_KEYS.flatMap((key) => {
    const value = proposal.rejected[key];
    return value ? [`${key}=${JSON.stringify(value)}`] : [];
  });
  const lines = [`${product.name}`];
  lines.push(parts.length ? `  -> ${parts.join(', ')}` : '  -> (nothing extractable)');
  if (rejected.length) lines.push(`  !! rejected (not in product's own text): ${rejected.join(', ')}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const model = resolveModel('product_processing');
  console.log(
    `[attribute-backfill] mode=${args.apply ? 'APPLY' : 'dry-run'} tenant=${args.tenant ?? 'all'} ` +
      `limit=${args.limit} batch=${args.batch} force=${args.force} model=${model}`,
  );

  const candidates = await selectCandidates(args);
  console.log(`[attribute-backfill] ${candidates.length} candidate products (missing >=1 attribute column)`);
  if (candidates.length === 0) return;

  const perKeyCounts: Record<string, number> = {};
  let productsWithUpdates = 0;
  let applied = 0;
  let rejectedCount = 0;

  for (let start = 0; start < candidates.length; start += args.batch) {
    const batch = candidates.slice(start, start + args.batch);
    let llmResults: Array<Partial<Record<(typeof BACKFILL_ATTRIBUTE_KEYS)[number], string>>>;
    try {
      llmResults = await extractAttributesBatch(batch);
    } catch (err) {
      console.warn(
        `[attribute-backfill] LLM batch ${start / args.batch + 1} failed — falling back to regex-only for these ${batch.length} products`,
        err instanceof Error ? err.message : err,
      );
      llmResults = batch.map(() => ({}));
    }

    for (let i = 0; i < batch.length; i += 1) {
      const product = batch[i];
      const proposal = mergeBackfillValues(product, llmResults[i] ?? {});
      const updateKeys = Object.keys(proposal.updates);
      rejectedCount += Object.keys(proposal.rejected).length;
      console.log(formatProposal(product, proposal));
      if (updateKeys.length === 0) continue;

      productsWithUpdates += 1;
      for (const key of updateKeys) perKeyCounts[key] = (perKeyCounts[key] ?? 0) + 1;

      if (args.apply) {
        const metadata = {
          ...(product.metadata ?? {}),
          attribute_backfill: {
            version: BACKFILL_VERSION,
            at: new Date().toISOString(),
            model,
            fields: proposal.fields,
          },
        };
        const updated = await updateProduct(product.id, product.tenant_id, {
          ...proposal.updates,
          metadata,
        });
        if (updated) applied += 1;
        else console.warn(`[attribute-backfill] update returned null for ${product.id} (${product.name})`);
      }
    }
  }

  console.log('\n[attribute-backfill] summary');
  console.log(`  products scanned:        ${candidates.length}`);
  console.log(`  products with proposals: ${productsWithUpdates}`);
  for (const key of BACKFILL_ATTRIBUTE_KEYS) {
    if (perKeyCounts[key]) console.log(`    ${key}: ${perKeyCounts[key]}`);
  }
  console.log(`  LLM values rejected by verbatim guard: ${rejectedCount}`);
  if (args.apply) {
    console.log(`  rows updated: ${applied} (embeddings nulled; the fast reconcile cron re-embeds them)`);
  } else {
    console.log('  DRY-RUN — nothing written. Re-run with --apply to write.');
  }
}

main()
  .catch((err) => {
    console.error('[attribute-backfill] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
