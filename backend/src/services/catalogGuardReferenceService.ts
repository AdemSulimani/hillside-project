/**
 * Full-catalog reference sets for the outbound hallucination guards (P0-2, RC-02).
 *
 * The price and product-name guards historically judged the AI reply against
 * `matchedProducts` — the ~10–25 rows retrieved for THIS turn. Retrieval is per-turn,
 * timing-sensitive, and keyword-dependent, so a correct answer about a real active
 * catalog item was stripped/escalated whenever that item fell outside the window
 * (all three dev "hallucination" alerts were this false positive).
 *
 * This service provides the interim fix: per-tenant reference sets built from the
 * FULL active catalog (plus the tenant's own AI-config/prompt-block text for prices —
 * the AI's other ground-truth source, e.g. delivery fees and promo thresholds), so
 * guard verdicts no longer depend on the volatile retrieval window.
 *
 *  - getFullCatalogPriceSet()   — every price the reply is allowed to state
 *  - getFullCatalogNameIndex()  — every active product name for the tenant
 *  - verifySuspectedNamesAgainstCatalog() — deterministic rescue layer: a name the
 *    LLM classifier suspects is checked against the full catalog (normalized
 *    containment, then a pg_trgm word_similarity lookup) before it may escalate.
 *    Verification can only RESCUE a suspect (more permissive), never add flags.
 *
 * Both sets are Redis-cached with a short TTL and invalidated on product mutation
 * (invalidateProductCatalogCaches) and AI-config changes (invalidateTenantAiCaches),
 * so a price edit is reflected within seconds — a stale entry can only produce a
 * transient, never permanent, wrong verdict.
 */
import { redisConnection } from '../jobs/redisConnection';
import {
  findMostSimilarActiveProductName,
  listActiveCatalogNamesForTenant,
  listActiveCatalogPriceRowsForTenant,
  type SimilarProductName,
} from '../db/models/product';
import { findAIConfigByTenant, type AIConfig } from '../db/models/aiConfig';
import { listTenantPromptBlocksRuntime } from '../db/models/promptBlock';
import { extractStatedPrices, type CatalogPriceSet } from './priceConsistencyGuard';
import { normalizeText } from './productTitleNormalization';

const CACHE_TTL_SECONDS = (() => {
  const n = parseInt(process.env.GUARD_CATALOG_CACHE_TTL_SECONDS || '120', 10);
  return Number.isFinite(n) && n > 0 ? n : 120;
})();

/**
 * Minimum pg_trgm word_similarity for a suspected name to be considered a real
 * catalog item. The normalized-containment check upstream already covers
 * exact/partial mentions, so this threshold only decides typo-level variants.
 *
 * Default 0.48 was calibrated empirically (2026-07-12) against the largest dev
 * catalog (257 products) with a 29-item labeled corpus:
 *   - 16 realistic typo/phonetic mentions of real products (Albanian + English:
 *     "Serioz Mass qokolad", "Kreatine monohidrate 120 kapsula", "Karbo One 1kg",
 *     "Ashwaganda 60 kapsula", …) scored 0.500–0.870 → all rescued at 0.48.
 *   - 10 pure fabrications ("ZMA Pro 90caps", "Carnivor Beef Protein 2kg", …)
 *     scored 0.143–0.467 → all correctly stay flagged at 0.48.
 *   - The empirical gap between the classes is (0.467, 0.500]; 0.48 is its midpoint,
 *     and avoids the knife edge at 0.50 where the hardest real-typo case sits exactly.
 *   - Variant fabrications (real family, nonexistent variant: "Gold Standard Casein"
 *     0.667, "Serious Mass 5.4kg Vanil" 0.520) fall INSIDE the rescue band — no
 *     threshold separates them; that class is the plan's accepted residual and the
 *     attribute-availability gate's job, not this guard's.
 * Raise toward ~0.7 only if invented near-variants must be caught at the cost of
 * escalating heavier typos; lower toward ~0.4 only if real typo'd names still escalate.
 */
const NAME_SIMILARITY_THRESHOLD = (() => {
  const n = parseFloat(process.env.NAME_GUARD_SIMILARITY_THRESHOLD || '0.48');
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.48;
})();

export function catalogGuardPricesKey(tenantId: string): string {
  return `guard_catalog_prices:${tenantId}`;
}

export function catalogGuardNamesKey(tenantId: string): string {
  return `guard_catalog_names:${tenantId}`;
}

/**
 * Coerces raw catalog price rows into a numeric CatalogPriceSet. pg returns
 * NUMERIC(10,2) columns as strings (no global type parser is registered), and
 * Number.isFinite() rejects strings — which is precisely why the legacy
 * buildCatalogPriceSet(matchedProducts) produced an empty set at runtime and left
 * the price guard inert. All coercion for the full-catalog set happens here.
 */
export function buildPriceSetFromCatalogRows(
  rows: Array<{ price: unknown; discounted_price: unknown }>,
): CatalogPriceSet {
  const prices: number[] = [];
  for (const row of rows) {
    const price = Number(row.price);
    if (row.price != null && row.price !== '' && Number.isFinite(price)) prices.push(price);
    const discounted = Number(row.discounted_price);
    if (row.discounted_price != null && row.discounted_price !== '' && Number.isFinite(discounted)) {
      prices.push(discounted);
    }
  }
  return { prices };
}

/**
 * Prices stated in the tenant's own AI configuration and prompt blocks. These texts
 * are injected into the system prompt, so any price they contain (delivery fee, promo
 * threshold, bundle price) is ground truth the AI was explicitly told — a reply
 * repeating one must not be flagged as hallucinated once the guard validates against
 * the catalog. Deterministic: reuses the guard's own price extractor.
 */
export function extractConfigGroundTruthPrices(
  config: Pick<
    AIConfig,
    | 'personality_description'
    | 'restrictions'
    | 'platform_restrictions'
    | 'sales_strategy'
    | 'objection_handling'
    | 'qa_pairs'
  > | null,
  promptBlockContents: string[],
): number[] {
  const texts: string[] = [];
  if (config) {
    if (config.personality_description) texts.push(config.personality_description);
    if (config.sales_strategy) texts.push(config.sales_strategy);
    if (config.objection_handling) texts.push(config.objection_handling);
    for (const r of config.restrictions ?? []) texts.push(r);
    for (const r of config.platform_restrictions ?? []) texts.push(r);
    for (const qa of config.qa_pairs ?? []) {
      if (qa?.question) texts.push(qa.question);
      if (qa?.answer) texts.push(qa.answer);
    }
  }
  texts.push(...promptBlockContents);

  const prices = new Set<number>();
  for (const text of texts) {
    for (const stated of extractStatedPrices(text)) {
      prices.add(stated.value);
    }
  }
  return [...prices];
}

/**
 * The full set of prices an AI reply for this tenant is allowed to state:
 * every active product's base + discounted price, plus prices appearing in the
 * tenant's AI-config/prompt-block ground-truth text. Redis-cached.
 */
export async function getFullCatalogPriceSet(tenantId: string): Promise<CatalogPriceSet> {
  const cacheKey = catalogGuardPricesKey(tenantId);
  const cached = await redisConnection.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as CatalogPriceSet;
      if (Array.isArray(parsed?.prices)) return parsed;
    } catch {
      // fall through to rebuild
    }
    await redisConnection.del(cacheKey);
  }

  const [rows, config, blocks] = await Promise.all([
    listActiveCatalogPriceRowsForTenant(tenantId),
    findAIConfigByTenant(tenantId),
    listTenantPromptBlocksRuntime(tenantId),
  ]);
  const set = buildPriceSetFromCatalogRows(rows);
  const configPrices = extractConfigGroundTruthPrices(
    config,
    blocks.filter((b) => b.enabled).map((b) => b.content),
  );
  const merged = new Set<number>([...set.prices, ...configPrices]);
  const result: CatalogPriceSet = { prices: [...merged] };

  await redisConnection.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
  return result;
}

/** Every active product name for the tenant, Redis-cached. */
export async function getFullCatalogNameIndex(tenantId: string): Promise<string[]> {
  const cacheKey = catalogGuardNamesKey(tenantId);
  const cached = await redisConnection.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as string[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to rebuild
    }
    await redisConnection.del(cacheKey);
  }

  const names = await listActiveCatalogNamesForTenant(tenantId);
  await redisConnection.set(cacheKey, JSON.stringify(names), 'EX', CACHE_TTL_SECONDS);
  return names;
}

/**
 * Deterministic in-process name match: true when the suspected name equals a catalog
 * name after normalization (lowercase, diacritics stripped, whitespace collapsed) or
 * when one contains the other — a reply's partial mention ("Carbo One") must match
 * the full catalog title ("Carbo One 1kg Orange"), and a reply stating the full
 * variant must match a shorter catalog base name. Very short strings are excluded
 * from containment (only exact match) so noise like "po" cannot rescue itself.
 */
export function nameMatchesCatalogIndex(suspectedName: string, nameIndex: string[]): boolean {
  const suspect = normalizeText(suspectedName);
  if (!suspect) return false;
  const CONTAINMENT_MIN_LENGTH = 4;
  for (const catalogName of nameIndex) {
    const candidate = normalizeText(catalogName);
    if (!candidate) continue;
    if (candidate === suspect) return true;
    if (suspect.length >= CONTAINMENT_MIN_LENGTH && candidate.includes(suspect)) return true;
    if (candidate.length >= CONTAINMENT_MIN_LENGTH && suspect.includes(candidate)) return true;
  }
  return false;
}

export interface RescuedName {
  name: string;
  matchedCatalogName: string | null;
  via: 'name_index' | 'trigram' | 'lookup_error';
}

export interface NameVerificationResult {
  /** Suspects with no full-catalog match — genuine hallucination candidates. */
  confirmed: string[];
  /** Suspects that matched an active catalog item and must NOT escalate. */
  rescued: RescuedName[];
}

/**
 * Verifies LLM-suspected hallucinated names against the FULL active catalog.
 * Two deterministic layers: the in-process normalized name index, then a pg_trgm
 * word_similarity lookup for typo-level variants. A lookup error rescues the suspect
 * (fail-open — the guard must never block a reply because the guard itself failed).
 * `similarityLookup` is injectable so tests can run without a database.
 */
export async function verifySuspectedNamesAgainstCatalog(
  tenantId: string,
  suspectedNames: string[],
  nameIndex: string[],
  similarityLookup: (
    tenantId: string,
    candidate: string,
    minSimilarity: number,
  ) => Promise<SimilarProductName | null> = findMostSimilarActiveProductName,
): Promise<NameVerificationResult> {
  const confirmed: string[] = [];
  const rescued: RescuedName[] = [];

  for (const name of suspectedNames) {
    if (nameMatchesCatalogIndex(name, nameIndex)) {
      rescued.push({ name, matchedCatalogName: null, via: 'name_index' });
      continue;
    }
    try {
      const similar = await similarityLookup(tenantId, name, NAME_SIMILARITY_THRESHOLD);
      if (similar) {
        rescued.push({ name, matchedCatalogName: similar.name, via: 'trigram' });
      } else {
        confirmed.push(name);
      }
    } catch (err) {
      console.warn('[catalog_guard] Similarity lookup failed — rescuing suspect (fail-open)', {
        tenantId,
        name,
        error: err instanceof Error ? err.message : String(err),
      });
      rescued.push({ name, matchedCatalogName: null, via: 'lookup_error' });
    }
  }

  return { confirmed, rescued };
}

/**
 * Clears every product-derived Redis cache for the tenant: the AI fallback catalog
 * list plus both guard reference sets. Call on any product mutation.
 */
export async function invalidateProductCatalogCaches(tenantId: string): Promise<void> {
  await redisConnection.del(
    `products:${tenantId}`,
    catalogGuardPricesKey(tenantId),
    catalogGuardNamesKey(tenantId),
  );
}
