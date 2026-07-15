/**
 * P2-5 workstream 3 (RC-25/EV-043): the zero-cost retrieval-threshold probe.
 *
 * ⚠️ MEASUREMENT ONLY — this script changes nothing. ⚠️
 *
 * WHY THIS SHIPS AND THE THRESHOLD CHANGE DOES NOT.
 *
 * The remediation plan asks P2-5 to "re-evaluate the -small/0.65 choice (EV-043) WITH THE P2-1
 * GATE AS THE SAFETY NET". P2-1's gate exists but its flag (`GROUNDING_GATE_CONSOLIDATED`) is
 * OFF. Lowering the threshold today would admit ~5 semantic hits where 1 is admitted now, with
 * no grounding gate deployed to catch what the extra neighbours let the model say — inverting
 * the plan's own precondition. So P2-5 ships the INSTRUMENT and leaves `SIMILARITY_THRESHOLD`
 * at 0.65. The flip is gated on `GROUNDING_GATE_CONSOLIDATED=on`.
 *
 * The evidence is nonetheless unambiguous about where the retrieval loss is. EV-043 replayed a
 * stored vector against 257 embedded products:
 *
 *     >= 0.65  ->  1 hit  (0 excluding the self-vector)
 *     >= 0.60  ->  1 hit  (0 excluding the self-vector)
 *     >= 0.55  ->  5 hits
 *     closest distinct neighbour: 0.594
 *
 * At the 0.65 floor, semantic retrieval contributes ZERO distinct-neighbour recall — only a
 * product's identical self-vector clears it. This is also why P2-5 does not normalize the
 * embedding arm: diacritic folding moves cosine by a hair and cannot cross a 0.056 gap, while
 * changing `buildProductText` would flip the sha256 input hash for 100% of rows and force a full
 * re-embed. The threshold, not the representation, is the retrieval defect.
 *
 * ZERO COST. It reuses a product's OWN stored embedding as the query vector, so it makes no
 * OpenAI calls — the same technique EV-043 used. Safe to run against production.
 *
 *     cd backend && npx tsx src/scripts/probeSimilarityThreshold.ts [tenantId]
 */
import 'dotenv/config';
import pool from '../db/pool';

const BANDS = [0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45];

interface Row {
  id: string;
  name: string;
  similarity: number;
}

async function pickTenant(explicit?: string): Promise<{ tenantId: string; embedded: number }> {
  if (explicit) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM products
        WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true AND embedding IS NOT NULL`,
      [explicit],
    );
    return { tenantId: explicit, embedded: parseInt(rows[0]?.n ?? '0', 10) };
  }
  // Default to the tenant with the most embedded products — the only one with a meaningful pool.
  const { rows } = await pool.query<{ tenant_id: string; n: string }>(
    `SELECT tenant_id, count(*)::text AS n FROM products
      WHERE deleted_at IS NULL AND is_active = true AND embedding IS NOT NULL
      GROUP BY tenant_id ORDER BY count(*) DESC LIMIT 1`,
  );
  if (!rows[0]) throw new Error('no tenant has embedded products');
  return { tenantId: rows[0].tenant_id, embedded: parseInt(rows[0].n, 10) };
}

async function main(): Promise<void> {
  const { tenantId, embedded } = await pickTenant(process.argv[2]);
  console.info(`[probe] tenant ${tenantId} — ${embedded} active embedded products`);
  if (embedded === 0) return;

  const configured = parseFloat(process.env.SIMILARITY_THRESHOLD || '0.65');
  console.info(`[probe] SIMILARITY_THRESHOLD in effect: ${configured}`);

  // Probe vectors: products spread evenly across the catalog, each queried with its OWN stored
  // embedding. No OpenAI call is made. EV-043 probed exactly ONE product and generalised from it;
  // a sample is what tells us whether its finding was representative.
  const sampleSize = Math.min(25, embedded);
  const { rows: probes } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM (
       SELECT id, name, row_number() OVER (ORDER BY name ASC) AS rn, count(*) OVER () AS total
         FROM products
        WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true AND embedding IS NOT NULL
     ) s
     WHERE (rn - 1) % GREATEST(1, (total / $2)::int) = 0
     ORDER BY name ASC LIMIT $2`,
    [tenantId, sampleSize],
  );

  const distinctAtConfigured: number[] = [];
  const closestDistinct: number[] = [];
  const starved: string[] = [];
  const verbose = process.argv.includes('--verbose');

  for (const probe of probes) {
    const { rows } = await pool.query<Row>(
      `SELECT id, name, 1 - (embedding <=> (SELECT embedding FROM products WHERE id = $2)) AS similarity
         FROM products
        WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true AND embedding IS NOT NULL
        ORDER BY embedding <=> (SELECT embedding FROM products WHERE id = $2)
        LIMIT 10`,
      [tenantId, probe.id],
    );

    const distinct = rows.filter((r) => r.id !== probe.id);
    const nAtConfigured = distinct.filter((r) => r.similarity >= configured).length;
    distinctAtConfigured.push(nAtConfigured);
    if (distinct[0]) closestDistinct.push(distinct[0].similarity);
    if (nAtConfigured === 0) starved.push(`${probe.name} (closest ${distinct[0]?.similarity.toFixed(3) ?? 'n/a'})`);

    if (verbose) {
      console.info(`\n[probe] "${probe.name}"`);
      console.info(
        `        closest distinct neighbour: ${distinct[0] ? `${distinct[0].similarity.toFixed(6)}  ${distinct[0].name}` : 'none'}`,
      );
      console.info(
        `        distinct hits by band (excl. self): ${BANDS.map((b) => `${b}:${distinct.filter((r) => r.similarity >= b).length}`).join('  ')}`,
      );
    }
  }

  // Catalog-wide distribution at the configured floor.
  const starvedCount = starved.length;
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  };

  console.info(`\n[probe] ---- ${probes.length} probes at floor ${configured} ----`);
  console.info(`[probe] products with ZERO distinct neighbours : ${starvedCount}/${probes.length}`);
  console.info(
    `[probe] median distinct neighbours admitted     : ${median(distinctAtConfigured)}` +
      ` (saturates at 9 — the probe window is LIMIT 10 incl. self)`,
  );
  console.info(`[probe] median closest-distinct similarity      : ${median(closestDistinct).toFixed(3)}`);
  for (const name of starved) console.info(`[probe]   starved: ${name}`);

  console.info(
    `\n[probe] READ THIS BEFORE CHANGING SIMILARITY_THRESHOLD.\n` +
      `        EV-043 probed a SINGLE product (a fitness belt in a supplement catalog) and found only\n` +
      `        the self-vector clearing 0.65, concluding the floor filters out "genuine same-category\n` +
      `        neighbours". This sample shows that conclusion is product-specific, not catalog-wide:\n` +
      `        most supplement products DO admit distinct neighbours at 0.65, while sparse-category\n` +
      `        outliers admit none. The floor is therefore not the blanket defect EV-043 implies, and\n` +
      `        lowering it globally would trade real precision for recall only some products need.\n` +
      `        Either way the flip must wait for GROUNDING_GATE_CONSOLIDATED=on — the safety net the\n` +
      `        remediation plan makes a precondition. P2-5 deliberately changes nothing here.`,
  );
}

main()
  .catch((err) => {
    console.error('[probe] failed', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
