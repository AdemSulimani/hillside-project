/**
 * One-off maintenance script: repair mojibake in existing product text fields.
 *
 * Usage:
 *   npx tsx src/scripts/repairProductTextEncoding.ts
 *   npx tsx src/scripts/repairProductTextEncoding.ts --tenant-id=<uuid>
 *   npx tsx src/scripts/repairProductTextEncoding.ts --dry-run
 */
import pool from '../db/pool';
import { repairMojibake } from '../utils/textEncoding';

type ProductTextRow = {
  id: string;
  tenant_id: string;
  name: string;
  brand: string | null;
  description: string | null;
  usage_description: string | null;
  sku: string | null;
  category: string | null;
  flavor: string | null;
  size: string | null;
  color: string | null;
  variant: string | null;
  weight: string | null;
  tags: string[];
};

function parseArgs(argv: string[]) {
  const dryRun = argv.includes('--dry-run');
  const tenantArg = argv.find((arg) => arg.startsWith('--tenant-id='));
  const tenantId = tenantArg?.split('=')[1]?.trim() || undefined;
  return { dryRun, tenantId };
}

function repairValue(value: string | null): string | null {
  if (value == null) return null;
  const repaired = repairMojibake(value);
  return repaired === value ? null : repaired;
}

function repairTags(tags: string[]): string[] | null {
  const repaired = tags.map((tag) => repairMojibake(tag));
  const changed = repaired.some((tag, index) => tag !== tags[index]);
  return changed ? repaired : null;
}

async function main(): Promise<void> {
  const { dryRun, tenantId } = parseArgs(process.argv.slice(2));

  const conditions = ['deleted_at IS NULL', "(description LIKE '%Ã%' OR usage_description LIKE '%Ã%' OR name LIKE '%Ã%' OR brand LIKE '%Ã%' OR category LIKE '%Ã%' OR sku LIKE '%Ã%' OR flavor LIKE '%Ã%' OR size LIKE '%Ã%' OR color LIKE '%Ã%' OR variant LIKE '%Ã%' OR weight LIKE '%Ã%' OR tags::text LIKE '%Ã%')"];
  const values: unknown[] = [];

  if (tenantId) {
    conditions.unshift('tenant_id = $1');
    values.push(tenantId);
  }

  const { rows } = await pool.query<ProductTextRow>(
    `SELECT id, tenant_id, name, brand, description, usage_description, sku, category,
            flavor, size, color, variant, weight, tags
     FROM products
     WHERE ${conditions.join(' AND ')}`,
    values,
  );

  console.info(`Found ${rows.length} product(s) with likely mojibake${tenantId ? ` for tenant ${tenantId}` : ''}.`);

  let repairedCount = 0;
  for (const row of rows) {
    const updates: Record<string, string | null | string[]> = {};

    const fields: Array<keyof ProductTextRow> = [
      'name', 'brand', 'description', 'usage_description', 'sku', 'category',
      'flavor', 'size', 'color', 'variant', 'weight',
    ];

    for (const field of fields) {
      const next = repairValue(row[field] as string | null);
      if (next != null) updates[field] = next;
    }

    const nextTags = repairTags(row.tags);
    if (nextTags) updates.tags = nextTags;

    if (Object.keys(updates).length === 0) continue;

    repairedCount += 1;
    console.info(`[repair] ${row.id} (${row.name})`);

    if (dryRun) continue;

    const setClauses: string[] = [];
    const updateValues: unknown[] = [row.id];
    let idx = 2;

    for (const [key, value] of Object.entries(updates)) {
      if (key === 'tags') {
        setClauses.push(`${key} = $${idx}::jsonb`);
        updateValues.push(JSON.stringify(value));
      } else {
        setClauses.push(`${key} = $${idx}`);
        updateValues.push(value);
      }
      idx += 1;
    }
    // Repaired text invalidates the stored embedding-input hash so the 6h
    // reconcile re-embeds unconditionally instead of racing a hash comparison.
    // The vector itself is kept — serving the pre-repair embedding until the
    // re-embed lands beats blinding semantic retrieval for the whole window.
    setClauses.push('embedding_input_hash = NULL');
    setClauses.push('updated_at = now()');

    await pool.query(
      `UPDATE products SET ${setClauses.join(', ')} WHERE id = $1`,
      updateValues,
    );
  }

  console.info(
    dryRun
      ? `Dry run complete. ${repairedCount} product(s) would be repaired.`
      : `Repair complete. ${repairedCount} product(s) updated.`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error('[repairProductTextEncoding] Failed', err);
  process.exit(1);
});
