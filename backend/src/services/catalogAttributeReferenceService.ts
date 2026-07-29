/**
 * P3-1 — the per-tenant free-text evidence index behind the declared-attribute grounding lane.
 *
 * The third reference set, beside `getFullCatalogPriceSet` and `getFullCatalogNameIndex` in
 * `catalogGuardReferenceService`. It answers a different question from those two: not "does this
 * value exist in the catalog?" but "does THIS product's own text say anything about this
 * substance?" — so its unit is a resolved row, never the tenant-wide union.
 *
 * ALL NORMALIZATION HAPPENS IN NODE, none in SQL. `foldDialect` folds diacritics and rewrites Gheg
 * function words; Postgres cannot do the second at all and does the first only through a lossy
 * hand-rolled `translate()`. Splitting normalization across the two would recreate RC-25's original
 * defect inside a guard — one arm searching '%çokollatë%' while the other searches '%cokollate%'.
 * Measured on the dev catalog: `description ~* 'qumesht'` returns 0 rows while 16 rows contain
 * "Qumështi". A `strpos`/`ILIKE` probe additionally cannot express clause-scoped negation, which is
 * the entire rescue mechanism.
 *
 * EVIDENCE-SUPERSET INVARIANT. The gate must read at least what the generator was shown, or it can
 * flag a claim the model was correctly grounded in. `buildProductKnowledgeContext` injects the full
 * untruncated description on exactly the ingredient-style turns that produce attribute facts, so
 * this index reads description and usage_description uncapped for the same reason.
 *
 * MUST NOT import `catalogGuardReferenceService` — that module will import
 * `catalogGuardAttributesKey` from here, and the cycle would be a module-load hazard on a path the
 * send path already depends on. `findMostSimilarActiveProductName` is taken straight from
 * `db/models/product`, exactly as `catalogGuardReferenceService` does.
 */
import { redisConnection } from '../jobs/redisConnection';
import {
  findMostSimilarActiveProductName,
  listActiveCatalogAttributeRowsForTenant,
  type CatalogAttributeSourceRow,
  type SimilarProductName,
} from '../db/models/product';
import { knobNumber } from '../config/knobs';
import { segmentClauses } from './attributeClaimLexicon';
import { normalizeText } from './productTitleNormalization';
// Shapes and the two pure projections live in the PURE module so `groundingGate` can use them
// without this file's redis/pg imports landing on the offline eval suite's walked import graph.
import type {
  CatalogAttributeIndex,
  CatalogAttributeRow,
  ProductRefResolution,
} from './attributeGrounding';

export type { CatalogAttributeIndex, CatalogAttributeRow, ProductRefResolution };

/**
 * Shared with the price/name reference sets on purpose — correctness here comes from the
 * invalidation hook firing on every product mutation, not from a short TTL, so a fourth
 * independently-drifting TTL knob would buy nothing.
 */
const CACHE_TTL_SECONDS = knobNumber('GUARD_CATALOG_CACHE_TTL_SECONDS');

export function catalogGuardAttributesKey(tenantId: string): string {
  return `guard_catalog_attrs:${tenantId}`;
}

/**
 * PURE. Folds each row's evidence once, at index-build time, so a cache hit costs a string scan
 * rather than a re-fold of the whole catalog.
 *
 * `populated` deliberately keys off the FREE TEXT only. A row whose sole evidence is its own name
 * and category has nothing to say about a substance, and must resolve to `silent` rather than be
 * treated as an authoritative silence — 37 of 257 real active rows are in this class.
 */
export function buildAttributeIndexFromRows(
  rows: CatalogAttributeSourceRow[],
  rowLimit: number,
): CatalogAttributeIndex {
  const built: CatalogAttributeRow[] = rows.map((row) => {
    const freeText = [row.description ?? '', row.usage_description ?? ''].join('\n').trim();
    // Structured attribute values (P1-B): one clause per value, so the membership predicate can
    // ground a declared "Qershi" against a backfilled flavor column exactly as it would against
    // the name. Kept OUT of `populated` — that flag governs contradiction eligibility for the
    // exclusion lane, whose evidence base is free text.
    const structuredValues = [row.brand, row.flavor, row.size, row.color, row.variant, row.weight]
      .map((v) => v?.trim() ?? '')
      .filter(Boolean);
    const source = [row.name ?? '', row.category ?? '', freeText, ...structuredValues]
      .filter(Boolean)
      .join('\n');
    return {
      id: row.id,
      name: row.name,
      normName: normalizeText(row.name ?? ''),
      clauses: segmentClauses(source),
      populated: freeText.length > 0,
    };
  });
  return { rows: built, truncated: rows.length >= rowLimit };
}

/** Redis-cached full-catalog attribute index. Same degradation contract as the name index. */
export async function getFullCatalogAttributeIndex(
  tenantId: string,
): Promise<CatalogAttributeIndex> {
  const cacheKey = catalogGuardAttributesKey(tenantId);
  const rowLimit = knobNumber('GROUNDING_ATTR_INDEX_MAX_ROWS');

  // The cache is an optimization, not a dependency: a Redis outage degrades to a direct DB read.
  try {
    const cached = await redisConnection.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as CatalogAttributeIndex;
        if (Array.isArray(parsed?.rows)) return parsed;
      } catch {
        // fall through to rebuild
      }
      await redisConnection.del(cacheKey);
    }
  } catch (err) {
    console.warn('[catalogAttributeReference] Redis cache read failed — reading DB directly', {
      tenantId,
      err,
    });
  }

  const rows = await listActiveCatalogAttributeRowsForTenant(tenantId, rowLimit);
  const index = buildAttributeIndexFromRows(rows, rowLimit);

  await redisConnection
    .set(cacheKey, JSON.stringify(index), 'EX', CACHE_TTL_SECONDS)
    .catch(() => undefined);
  return index;
}

/**
 * Every row whose normalized name matches `productRef` by bidirectional containment.
 *
 * Returns rows, not a boolean — `nameMatchesCatalogIndex` in `catalogGuardReferenceService` is a
 * `boolean` and structurally cannot say WHICH row matched, which is exactly what an attribute
 * claim needs. `CONTAINMENT_MIN_LENGTH` mirrors that function's value so the two resolvers agree
 * on what counts as a mention.
 */
export function findCatalogRowsMatchingRef(
  productRef: string,
  index: CatalogAttributeIndex,
): CatalogAttributeRow[] {
  const suspect = normalizeText(productRef ?? '');
  if (!suspect) return [];
  const CONTAINMENT_MIN_LENGTH = 4;
  const hits: CatalogAttributeRow[] = [];
  for (const row of index.rows) {
    const candidate = row.normName;
    if (!candidate) continue;
    if (
      candidate === suspect ||
      (suspect.length >= CONTAINMENT_MIN_LENGTH && candidate.includes(suspect)) ||
      (candidate.length >= CONTAINMENT_MIN_LENGTH && suspect.includes(candidate))
    ) {
      hits.push(row);
    }
  }
  return hits;
}

/**
 * Resolve a declared `product_ref` to exactly ONE catalog row, or decline.
 *
 * Two deterministic layers, mirroring the name path: normalized containment, then a pg_trgm
 * lookup for typo-level variants. Every outcome other than a unique hit declines to `row: null`,
 * which downstream means tenant scope, which can never contradict:
 *  - `ambiguous`  — "Mega mass" matches both the 3kg and 7kg rows; picking one would judge the
 *                   claim against a sibling that may genuinely differ in composition.
 *  - `unresolved` / `lookup_error` — no basis to judge; a lookup failure must never flag.
 *
 * The similarity floor is its OWN knob, decoupled from `NAME_GUARD_SIMILARITY_THRESHOLD`, because
 * the safety direction inverts: for names a low threshold RESCUES a suspect, while here a low
 * threshold resolves MORE refs to product scope — the only scope that can flag.
 */
export async function resolveProductRef(
  tenantId: string,
  productRef: string,
  index: CatalogAttributeIndex,
  similarityLookup: (
    tenantId: string,
    candidate: string,
    minSimilarity: number,
  ) => Promise<SimilarProductName | null> = findMostSimilarActiveProductName,
): Promise<ProductRefResolution> {
  const trimmed = (productRef ?? '').trim();
  if (!trimmed) return { row: null, via: 'unresolved' };

  const hits = findCatalogRowsMatchingRef(trimmed, index);
  if (hits.length === 1) return { row: hits[0], via: 'name_index' };
  if (hits.length > 1) return { row: null, via: 'ambiguous' };

  try {
    const similar = await similarityLookup(
      tenantId,
      trimmed,
      knobNumber('GROUNDING_ATTR_REF_SIMILARITY'),
    );
    if (!similar) return { row: null, via: 'unresolved' };
    const norm = normalizeText(similar.name);
    const row = index.rows.find((r) => r.normName === norm) ?? null;
    return row ? { row, via: 'trigram' } : { row: null, via: 'unresolved' };
  } catch (err) {
    console.warn('[catalogAttributeReference] product_ref similarity lookup failed — declining', {
      tenantId,
      productRef: trimmed,
      error: err instanceof Error ? err.message : String(err),
    });
    return { row: null, via: 'lookup_error' };
  }
}

// `evidenceForRow` and `tenantWideEvidence` deliberately live in ./attributeGrounding — they are
// pure projections over the index shape, and keeping them there is what lets `groundingGate`
// consume them without importing this module's redis/pg edges.
