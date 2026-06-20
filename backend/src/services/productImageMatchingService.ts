import crypto from 'crypto';
import { openai, OPENAI_VISION_MODEL } from './openaiClient';
import { generateEmbedding } from './embeddingService';
import {
  buildFingerprintText,
  extractCatalogImageFingerprint,
} from './productImageFingerprintService';
import {
  searchProductsByImageFingerprintSimilarity,
  countMissingImageFingerprints,
  normalizeAttributesMap,
  normalizeConfidenceMap,
  type ImageFingerprintMatch,
  type VisualFingerprintData,
} from '../db/models/productImageFingerprint';
import {
  searchProducts,
  searchProductsByTokens,
  findActiveProductBySku,
  type Product,
} from '../db/models/product';
import {
  parseProductTitle,
  tokenizeForMatch,
  extractSelectionAttributes,
  rankProductsByAttributeOverlap,
} from './productTitleNormalization';
import { permanentUrlToFilePath, fileToBase64DataUrl } from './attachmentStorageService';
import { redisConnection } from '../jobs/redisConnection';
import { logEvent } from './analyticsService';
import {
  decideVisionMatch,
  deriveVisionCounts,
  CONFIDENT_MATCH_FLOOR,
  IMAGE_SIMILARITY_THRESHOLD,
  IMAGE_MATCH_CONFIDENCE_THRESHOLD,
  IMAGE_MATCH_AMBIGUITY_DELTA,
  type CustomerVisionExtraction,
  type ImageQuality,
} from './productImageMatchPolicy';

export {
  IMAGE_SIMILARITY_THRESHOLD,
  IMAGE_MATCH_CONFIDENCE_THRESHOLD,
  IMAGE_MATCH_AMBIGUITY_DELTA,
  type CustomerVisionExtraction,
  type ImageQuality,
};

console.info('[productImageMatching] thresholds', {
  IMAGE_SIMILARITY_THRESHOLD,
  IMAGE_MATCH_CONFIDENCE_THRESHOLD,
  IMAGE_MATCH_AMBIGUITY_DELTA,
});

export interface ScoredProductMatch {
  product: Product;
  compositeScore: number;
  imageSimilarity: number | null;
  matchedImageUrl: string | null;
  matchSource: 'visual' | 'text' | 'fused';
}

export interface CustomerImageMatchOutcome {
  products: Product[];
  scoredMatches: ScoredProductMatch[];
  visionContext: string | null;
  matchConfidence: number;
  shouldAskClarification: boolean;
  clarificationReason: string | null;
  multipleProductsDetected: boolean;
  imageQuality: ImageQuality;
  extraction: CustomerVisionExtraction | null;
  brandLikelyAbsent: boolean;
  /** True when the photo has no confident catalog match — reply should state we do not carry it. */
  productNotInCatalog: boolean;
}

function resolveImageUrls(attachmentUrls: string[]): string[] {
  const resolved: string[] = [];
  for (const url of attachmentUrls) {
    const filePath = permanentUrlToFilePath(url);
    if (filePath) {
      const dataUrl = fileToBase64DataUrl(filePath);
      if (dataUrl) {
        resolved.push(dataUrl);
        continue;
      }
    }
    resolved.push(url);
  }
  return resolved;
}

function hashVisionCacheInput(resolvedImageUrls: string[], inboundMessage: string): string {
  const hash = crypto.createHash('sha256');
  for (const url of resolvedImageUrls) {
    hash.update(url, 'utf8');
    hash.update('\u0000', 'utf8');
  }
  hash.update(inboundMessage.trim(), 'utf8');
  return hash.digest('hex');
}

function urlLooksLikeVisionImage(url: string): boolean {
  const u = url.toLowerCase();
  if (u.endsWith('.mp4') || u.includes('.mp4?')) return false;
  if (u.endsWith('.webm') || u.includes('.webm?')) return false;
  if (u.endsWith('.mov') || u.includes('.mov?')) return false;
  if (u.includes('/video/upload/')) return false;
  if (u.includes('mime_video') || u.includes('resource_type=video')) return false;
  return true;
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getProductBrand(product: Product): string | null {
  return typeof product.brand === 'string' && product.brand.trim() ? product.brand.trim() : null;
}

function isBrandLikelyInCatalog(brandName: string, products: Product[]): boolean {
  const normalizedBrand = normalizeForMatch(brandName);
  if (!normalizedBrand) return false;
  return products.some((product) => {
    const candidates = [
      getProductBrand(product) ?? '',
      product.name ?? '',
      product.description ?? '',
      ...(product.tags ?? []),
    ];
    return candidates.some((candidate) => normalizeForMatch(candidate).includes(normalizedBrand));
  });
}

function parseConfidence(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(1, Math.max(0, raw > 1 ? raw / 100 : raw));
  }
  if (typeof raw === 'string') {
    const n = parseFloat(raw.trim());
    if (Number.isFinite(n)) return Math.min(1, Math.max(0, n > 1 ? n / 100 : n));
  }
  return 0;
}

function normalizeCustomerExtraction(raw: Partial<CustomerVisionExtraction>): CustomerVisionExtraction {
  const base: VisualFingerprintData = {
    brand_name:
      typeof raw.brand_name === 'string' && raw.brand_name.trim() ? raw.brand_name.trim() : null,
    product_name:
      typeof raw.product_name === 'string' && raw.product_name.trim() ? raw.product_name.trim() : null,
    product_type:
      typeof raw.product_type === 'string' && raw.product_type.trim() ? raw.product_type.trim() : null,
    flavor: typeof raw.flavor === 'string' && raw.flavor.trim() ? raw.flavor.trim() : null,
    size: typeof raw.size === 'string' && raw.size.trim() ? raw.size.trim() : null,
    servings: typeof raw.servings === 'string' && raw.servings.trim() ? raw.servings.trim() : null,
    category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : null,
    manufacturer:
      typeof raw.manufacturer === 'string' && raw.manufacturer.trim() ? raw.manufacturer.trim() : null,
    visible_text: Array.isArray(raw.visible_text)
      ? raw.visible_text.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 20)
      : [],
    packaging_colors:
      typeof raw.packaging_colors === 'string' && raw.packaging_colors.trim()
        ? raw.packaging_colors.trim()
        : null,
    distinguishing_features:
      typeof raw.distinguishing_features === 'string' && raw.distinguishing_features.trim()
        ? raw.distinguishing_features.trim()
        : null,
    sku_visible:
      typeof raw.sku_visible === 'string' && raw.sku_visible.trim() ? raw.sku_visible.trim() : null,
    barcode_visible: raw.barcode_visible === true,
    packaging_version_note:
      typeof raw.packaging_version_note === 'string' && raw.packaging_version_note.trim()
        ? raw.packaging_version_note.trim()
        : null,
    attributes: normalizeAttributesMap(raw.attributes),
    attribute_confidence: normalizeConfidenceMap(raw.attribute_confidence),
  };

  const qualityRaw = typeof raw.image_quality === 'string' ? raw.image_quality.toLowerCase() : 'fair';
  const imageQuality: ImageQuality =
    qualityRaw === 'good' || qualityRaw === 'poor' ? qualityRaw : 'fair';

  const counts = deriveVisionCounts(raw);

  return {
    ...base,
    confidence: parseConfidence(raw.confidence),
    image_quality: imageQuality,
    multiple_products_detected: counts.multipleDetected,
    product_count_estimate: counts.productCountEstimate,
    is_social_media_screenshot: raw.is_social_media_screenshot === true,
    extraction_notes:
      typeof raw.extraction_notes === 'string' && raw.extraction_notes.trim()
        ? raw.extraction_notes.trim()
        : null,
    contains_product: counts.containsProduct,
    primary_subject_clear: counts.primarySubjectClear,
    distinct_product_count: counts.distinctProductCount,
    all_visible_products_identical: counts.allIdentical,
    has_distracting_objects: raw.has_distracting_objects === true,
  };
}

const CUSTOMER_VISION_SYSTEM = `You are a strict product-image analyst for a retail chatbot.
Extract ONLY what is clearly visible. Identify the SINGLE primary product the customer is asking about.

Focus rules:
- The primary product is the one that is in the foreground, centered, held up, or largest. Describe THAT product in brand_name/product_name/etc.
- IGNORE hands holding the item, reflections, glare, shadows, price tags, shelves, and unrelated background products. Do not let them change the identified product.
- If several copies of the SAME item appear (e.g. three identical bottles), that is ONE distinct product, not many — set all_visible_products_identical=true and distinct_product_count=1.
- Only count products as distinct when they are genuinely different items (different brand/name/variant).

Return ONLY valid JSON with keys:
- brand_name, product_name, product_type, flavor, size (string|null each — for the PRIMARY product)
- category (string|null — product category if printed or strongly implied)
- manufacturer (string|null — manufacturer/distributor if printed and distinct from the brand)
- servings (string|null — serving count/serving info if printed, e.g. "60 servings")
- visible_text (string[] — label text you can read on the primary product, max 20)
- packaging_colors, distinguishing_features, packaging_version_note (string|null)
- sku_visible (string|null — any SKU or barcode digits legible on the label), barcode_visible (boolean)
- attributes (object — a map of ANY other clearly-labeled fact on the PRIMARY product's packaging, keyed by a short lowercase attribute name, e.g. {"protein per serving":"24g","calories":"120","directions":"mix 1 scoop with water","ingredients":"whey concentrate","warnings":"keep out of reach of children","made in":"USA"}. Include anything a customer might ask about; omit anything not legibly printed.)
- attribute_confidence (object — your confidence in [0,1] for each field you filled, keyed by the SAME names used above and in attributes, e.g. {"brand_name":0.95,"flavor":0.9,"servings":0.6}. Lower it for blurry/occluded/ambiguous text.)
- confidence (number 0-1 — confidence in brand+product identification of the PRIMARY product)
- image_quality ("good"|"fair"|"poor" — based on blur, crop, angle, lighting, occlusion)
- contains_product (boolean — false for selfies, receipts, memes, screenshots with no product, empty scenes)
- multiple_products_detected (boolean — more than one product INSTANCE visible, including duplicates)
- product_count_estimate (integer — total product instances visible)
- distinct_product_count (integer — number of visually DIFFERENT products; identical copies count as 1)
- all_visible_products_identical (boolean — every visible product is the same item)
- primary_subject_clear (boolean — true if one product is clearly the main subject)
- has_distracting_objects (boolean — hands, reflections, glare, or unrelated objects partially obscure the product)
- is_social_media_screenshot (boolean — Instagram/Facebook post screenshot with UI chrome)
- extraction_notes (string|null — e.g. "product partially occluded by hand", "old packaging design")
Do NOT invent brand names. Use null when unreadable.`;

async function extractCustomerProductFromImages(
  inboundMessage: string,
  attachmentUrls: string[],
): Promise<CustomerVisionExtraction | null> {
  const visionUrls = attachmentUrls.filter(urlLooksLikeVisionImage);
  if (visionUrls.length === 0) return null;

  const resolvedImageUrls = resolveImageUrls(visionUrls);
  if (resolvedImageUrls.length === 0) return null;

  // Hash the FULL resolved image content (+ message) for the cache key. A previous
  // version keyed on only the last 48 chars of each URL, which for base64 data URLs
  // are near-identical across different images — causing the extraction of one photo
  // to be served for a completely different photo. Hashing the whole payload removes
  // that collision while keeping the key bounded in size.
  const cacheKey = `cust_vision:${hashVisionCacheInput(resolvedImageUrls, inboundMessage)}`;
  const cached = await redisConnection.get(cacheKey);
  if (cached) {
    try {
      return normalizeCustomerExtraction(JSON.parse(cached) as Partial<CustomerVisionExtraction>);
    } catch {
      await redisConnection.del(cacheKey);
    }
  }

  const completion = await openai.chat.completions.create({
    model: OPENAI_VISION_MODEL || 'gpt-4o',
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 750,
    messages: [
      { role: 'system', content: CUSTOMER_VISION_SYSTEM },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analyze the customer's product image(s). Message context: "${inboundMessage.trim() || 'No text.'}"`,
          },
          ...resolvedImageUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) return null;

  const parsed = normalizeCustomerExtraction(JSON.parse(raw) as Partial<CustomerVisionExtraction>);
  await redisConnection.set(cacheKey, JSON.stringify(parsed), 'EX', 3600);
  return parsed;
}

async function rerankAmbiguousVisualMatches(
  customerImageUrls: string[],
  candidates: ImageFingerprintMatch[],
): Promise<ImageFingerprintMatch[]> {
  if (candidates.length < 2) return candidates;

  const top = candidates[0];
  const second = candidates[1];
  if (top.similarity - second.similarity > IMAGE_MATCH_AMBIGUITY_DELTA) {
    return candidates;
  }

  const customerUrl = resolveImageUrls(customerImageUrls.filter(urlLooksLikeVisionImage))[0];
  if (!customerUrl) return candidates;

  const compareList = candidates.slice(0, 3).map((c, i) => ({
    index: i + 1,
    product_id: c.id,
    product_name: c.name,
    brand: getProductBrand(c),
    catalog_image_url: c.matched_image_url,
  }));

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_VISION_MODEL || 'gpt-4o',
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 120,
      messages: [
        {
          role: 'system',
          content:
            'Compare the customer product photo to catalog candidate images. Return JSON: { best_index: number (1-based from list), confidence: number 0-1, same_product: boolean, reason: string|null }. Pick best_index=0 if none match.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Customer image vs candidates:\n${JSON.stringify(compareList)}`,
            },
            { type: 'image_url', image_url: { url: customerUrl } },
            ...compareList.map((c) => ({
              type: 'image_url' as const,
              image_url: { url: c.catalog_image_url },
            })),
          ],
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw?.trim()) return candidates;

    const parsed = JSON.parse(raw) as { best_index?: number; confidence?: number; same_product?: boolean };
    const bestIndex = typeof parsed.best_index === 'number' ? parsed.best_index : 0;
    const confidence = parseConfidence(parsed.confidence);

    if (bestIndex >= 1 && bestIndex <= compareList.length && parsed.same_product !== false && confidence >= 0.5) {
      const chosen = candidates[bestIndex - 1];
      const rest = candidates.filter((_, i) => i !== bestIndex - 1);
      return [{ ...chosen, similarity: Math.max(chosen.similarity, confidence) }, ...rest];
    }
  } catch (err) {
    console.warn('[imageMatch] Vision re-rank failed, using vector order', err);
  }

  return candidates;
}

function fuseProductMatches(
  visualMatches: ImageFingerprintMatch[],
  textMatches: Product[],
  textSearchMatches: Product[],
  limit: number,
): ScoredProductMatch[] {
  const scoreMap = new Map<string, ScoredProductMatch>();

  for (let i = 0; i < visualMatches.length; i++) {
    const m = visualMatches[i];
    const rrf = 2.0 / (60 + i + 1);
    const imageBoost = m.similarity * 0.5;
    const existing = scoreMap.get(m.id);
    const score = rrf + imageBoost + m.similarity * 0.3;
    if (!existing || score > existing.compositeScore) {
      scoreMap.set(m.id, {
        product: m,
        compositeScore: score,
        imageSimilarity: m.similarity,
        matchedImageUrl: m.matched_image_url,
        matchSource: 'visual',
      });
    }
  }

  for (let i = 0; i < textMatches.length; i++) {
    const p = textMatches[i];
    const rrf = 1.5 / (60 + i + 1);
    const existing = scoreMap.get(p.id);
    if (existing) {
      existing.compositeScore += rrf;
      existing.matchSource = 'fused';
    } else {
      scoreMap.set(p.id, {
        product: p,
        compositeScore: rrf,
        imageSimilarity: null,
        matchedImageUrl: null,
        matchSource: 'text',
      });
    }
  }

  for (let i = 0; i < textSearchMatches.length; i++) {
    const p = textSearchMatches[i];
    const rrf = 1.0 / (60 + i + 1);
    const existing = scoreMap.get(p.id);
    if (existing) {
      existing.compositeScore += rrf;
      if (existing.matchSource === 'text') existing.matchSource = 'fused';
    } else {
      scoreMap.set(p.id, {
        product: p,
        compositeScore: rrf,
        imageSimilarity: null,
        matchedImageUrl: null,
        matchSource: 'text',
      });
    }
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, limit);
}

function computeMatchConfidence(
  extraction: CustomerVisionExtraction | null,
  topMatch: ScoredProductMatch | null,
): number {
  if (!extraction && !topMatch) return 0;
  const visionConf = extraction?.confidence ?? 0;
  const imageSim = topMatch?.imageSimilarity ?? 0;
  const textBoost = topMatch?.matchSource === 'fused' ? 0.15 : topMatch?.matchSource === 'text' ? 0.08 : 0;
  const qualityPenalty =
    extraction?.image_quality === 'poor' ? 0.15 : extraction?.image_quality === 'fair' ? 0.05 : 0;
  const multiPenalty = extraction?.multiple_products_detected ? 0.12 : 0;

  return Math.min(
    1,
    Math.max(0, visionConf * 0.35 + imageSim * 0.45 + textBoost + 0.05 - qualityPenalty - multiPenalty),
  );
}

function buildVisionContextRules(
  productNotInCatalog: boolean,
  clarificationReason: string | null,
): string[] {
  if (productNotInCatalog) {
    return [
      'Rules:',
      '- This product is NOT in the catalog. Tell the customer honestly and briefly that you do not carry it.',
      '- Do NOT ask for a clearer photo, product name, or any additional details.',
      '- Do NOT describe ingredients, benefits, or other general product information from the image.',
      '- You may briefly name the brand/product visible in the photo only to confirm what you do not carry.',
      '- You may offer to help find something else from the catalog.',
    ];
  }

  const rules = [
    'Rules:',
    '- Never claim an exact match when confidence is below threshold or brand is absent.',
    '- If packaging looks similar but brand differs, state you carry a similar product, not the exact brand.',
    '- Mention out-of-stock status honestly; inactive products must not be offered.',
  ];

  if (clarificationReason === 'multiple_products_in_image') {
    rules.push(
      '- Several DIFFERENT products are visible and none is clearly the main one. Ask which product they mean; do NOT guess.',
    );
  }
  if (
    clarificationReason === 'poor_image_quality' ||
    clarificationReason === 'low_extraction_confidence'
  ) {
    rules.push('- For poor image quality, ask once for a clearer, well-lit photo showing the label.');
  }
  if (clarificationReason === 'no_product_detected') {
    rules.push(
      '- The image does not show a product. Politely ask the customer to send a clear photo of the product itself.',
    );
  }

  return rules;
}

/**
 * Resolve catalog text matches from a vision extraction in an attribute-robust way.
 *
 * The customer photo (and thus the extraction) often shows only the BASE product name
 * ("creatine monohydrate") while catalog titles bundle variant attributes
 * ("Creatine Monohydrate 50 Servings"). A single contiguous `ILIKE` over the full
 * extracted phrase then misses the match. Instead we:
 *   1. retrieve by BASE-NAME tokens (identity) so every variant in the family is found,
 *      regardless of the extra servings/flavor/size words in either the title or the
 *      photo, and
 *   2. re-rank the survivors by how well their attributes overlap what the photo shows,
 *      so the exact variant (e.g. the 50-serving, strawberry one) surfaces first.
 *
 * Retrieval is tiered from most precise (brand + name) to broadest (product type),
 * and finally falls back to the legacy contiguous search so behaviour never regresses.
 */
async function resolveTextMatchesFromExtraction(
  tenantId: string,
  extraction: CustomerVisionExtraction,
  legacyQuery: string,
  limit: number,
): Promise<Product[]> {
  const parsedName = parseProductTitle(extraction.product_name ?? '');
  const nameTokens = parsedName.baseTokens;
  const brandTokens = extraction.brand_name ? tokenizeForMatch(extraction.brand_name) : [];
  const typeTokens = extraction.product_type ? tokenizeForMatch(extraction.product_type) : [];

  let matches: Product[] = [];

  // Tier 1: brand + base name — the most precise identity signal.
  if (brandTokens.length > 0 && nameTokens.length > 0) {
    matches = await searchProductsByTokens(tenantId, [...brandTokens, ...nameTokens], limit);
  }
  // Tier 2: base name only (brand may be unreadable or stored only in a column).
  if (matches.length === 0 && nameTokens.length > 0) {
    matches = await searchProductsByTokens(tenantId, nameTokens, limit);
  }
  // Tier 3: product type (e.g. "creatine", "mass gainer") when no name is legible.
  if (matches.length === 0 && typeTokens.length > 0) {
    matches = await searchProductsByTokens(tenantId, typeTokens, limit);
  }
  // Tier 4: legacy contiguous search — preserves the previous behaviour as a safety net.
  if (matches.length === 0 && legacyQuery) {
    matches = await searchProducts(tenantId, legacyQuery, limit);
  }

  // Re-rank by attribute overlap so the specific variant shown in the photo wins.
  const queryAttributes = extractSelectionAttributes(
    [extraction.product_name, extraction.flavor, extraction.size, ...extraction.visible_text]
      .filter(Boolean)
      .join(' '),
  );
  return rankProductsByAttributeOverlap(matches, queryAttributes);
}

export async function matchProductsFromCustomerImages(input: {
  tenantId: string;
  inboundMessage: string;
  attachmentUrls: string[];
  textMatchedProducts?: Product[];
  limit?: number;
}): Promise<CustomerImageMatchOutcome> {
  const limit = input.limit ?? 10;
  const attachmentUrls = input.attachmentUrls.filter((u) => typeof u === 'string' && u.length > 0);

  if (attachmentUrls.length === 0) {
    return {
      products: input.textMatchedProducts ?? [],
      scoredMatches: [],
      visionContext: null,
      matchConfidence: 0,
      shouldAskClarification: false,
      clarificationReason: null,
      multipleProductsDetected: false,
      imageQuality: 'fair',
      extraction: null,
      brandLikelyAbsent: false,
      productNotInCatalog: false,
    };
  }

  const extraction = await extractCustomerProductFromImages(input.inboundMessage, attachmentUrls);

  let visualMatches: ImageFingerprintMatch[] = [];
  if (extraction) {
    const fingerprintText = buildFingerprintText(extraction);
    if (fingerprintText.trim()) {
      try {
        const queryVector = await generateEmbedding(fingerprintText);
        visualMatches = await searchProductsByImageFingerprintSimilarity(
          input.tenantId,
          queryVector,
          limit,
          IMAGE_SIMILARITY_THRESHOLD,
        );
        visualMatches = await rerankAmbiguousVisualMatches(attachmentUrls, visualMatches);
      } catch (err) {
        console.warn('[imageMatch] Visual fingerprint search failed', { tenantId: input.tenantId, err });
      }
    }

    if (visualMatches.length === 0) {
      countMissingImageFingerprints(input.tenantId)
        .then((missing) => {
          if (missing > 0) {
            console.warn('[imageMatch] No visual matches — catalog image fingerprint gap', {
              tenantId: input.tenantId,
              missingCatalogImageFingerprints: missing,
              hint: 'Run POST /admin/businesses/:tenantId/products/backfill-image-fingerprints',
            });
          }
        })
        .catch(() => {});
    }
  }

  // Legacy contiguous query, retained only as the final fallback inside the resolver.
  const structuredQuery = extraction
    ? [extraction.brand_name, extraction.product_name, extraction.product_type, extraction.flavor, extraction.size]
        .filter(Boolean)
        .join(' ')
    : '';

  // Attribute-robust text retrieval: match by base-name tokens (so extra servings/
  // flavor/size words in the title or photo do not break the match) and re-rank by
  // attribute overlap so the exact variant the photo shows surfaces first.
  let textSearchMatches: Product[] = [];
  if (extraction) {
    textSearchMatches = await resolveTextMatchesFromExtraction(
      input.tenantId,
      extraction,
      structuredQuery,
      limit,
    );
  }

  // Deterministic fast path: a legible SKU/barcode is the strongest matching signal.
  let skuProduct: Product | null = null;
  if (extraction?.sku_visible) {
    try {
      skuProduct = await findActiveProductBySku(input.tenantId, extraction.sku_visible);
    } catch (err) {
      console.warn('[imageMatch] SKU lookup failed', { tenantId: input.tenantId, err });
    }
  }

  const textPool = [...(input.textMatchedProducts ?? []), ...textSearchMatches];
  const brandCheckPool = visualMatches.length > 0 ? visualMatches : textPool;
  const brandLikelyAbsent = extraction?.brand_name
    ? !isBrandLikelyInCatalog(extraction.brand_name, brandCheckPool)
    : false;

  const normalizedBrand = extraction?.brand_name?.trim().toLowerCase() ?? null;
  const exactBrandMatches = normalizedBrand
    ? textSearchMatches.filter((p) => (getProductBrand(p) ?? '').toLowerCase() === normalizedBrand)
    : [];

  const scoredMatches = fuseProductMatches(
    visualMatches,
    input.textMatchedProducts ?? [],
    exactBrandMatches.length > 0 ? exactBrandMatches : textSearchMatches,
    limit,
  );

  const topMatch = scoredMatches[0] ?? null;
  const exactSkuMatch = skuProduct !== null;
  // A SKU hit floors the confidence at the confident band so it is honoured downstream.
  const matchConfidence = exactSkuMatch
    ? Math.max(CONFIDENT_MATCH_FLOOR, computeMatchConfidence(extraction, topMatch))
    : computeMatchConfidence(extraction, topMatch);

  const { decision, shouldAskClarification, productNotInCatalog, clarificationReason } =
    decideVisionMatch({
      extraction,
      matchConfidence,
      topSimilarity: topMatch?.imageSimilarity ?? 0,
      hasCatalogCandidates: scoredMatches.length > 0 || exactSkuMatch,
      brandLikelyAbsent,
      exactSkuMatch,
    });

  let products: Product[];
  if (exactSkuMatch && skuProduct) {
    // Surface the SKU-resolved product first, then any other scored candidates.
    const rest = scoredMatches.map((s) => s.product).filter((p) => p.id !== skuProduct!.id);
    products = [skuProduct, ...rest];
  } else if (productNotInCatalog || shouldAskClarification) {
    // When we are not carrying it or are about to ask the customer, surface alternatives
    // only for the "different brand, similar item" case; otherwise stay empty/honest.
    products =
      brandLikelyAbsent && !productNotInCatalog && textSearchMatches.length > 0
        ? textSearchMatches.slice(0, limit)
        : decision === 'tentative_match'
          ? scoredMatches.slice(0, 3).map((s) => s.product)
          : [];
  } else if (decision === 'confident_match') {
    products = scoredMatches.map((s) => s.product);
  } else if (decision === 'tentative_match') {
    if (topMatch && (topMatch.imageSimilarity ?? 0) >= IMAGE_SIMILARITY_THRESHOLD) {
      products = scoredMatches.slice(0, 3).map((s) => s.product);
    } else if (exactBrandMatches.length > 0) {
      products = exactBrandMatches;
    } else if (!extraction) {
      products = input.textMatchedProducts ?? [];
    } else {
      products = scoredMatches.slice(0, 3).map((s) => s.product);
    }
  } else {
    products = [];
  }

  const visionContext = extraction
    ? [
        productNotInCatalog
          ? 'Product-image analysis: no catalog match for this photo.'
          : 'Enhanced product-image analysis:',
        productNotInCatalog
          ? [
              extraction.brand_name ? `Identified brand: ${extraction.brand_name}` : null,
              extraction.product_name ? `Identified product: ${extraction.product_name}` : null,
              extraction.product_type ? `Product type: ${extraction.product_type}` : null,
            ]
              .filter(Boolean)
              .join('\n') || 'Product details could not be read clearly from the image.'
          : JSON.stringify(extraction),
        '',
        'Visual catalog matches (image fingerprint similarity):',
        visualMatches.length > 0
          ? visualMatches
              .slice(0, 5)
              .map(
                (m) =>
                  `- ${m.name} (brand: ${getProductBrand(m) ?? 'unknown'}, similarity: ${m.similarity.toFixed(3)}, in_stock: ${m.in_stock})`,
              )
              .join('\n')
          : '- none above threshold',
        '',
        `Composite match confidence: ${matchConfidence.toFixed(3)} (threshold: ${IMAGE_MATCH_CONFIDENCE_THRESHOLD})`,
        `Brand likely absent from catalog: ${brandLikelyAbsent ? 'yes' : 'no'}`,
        productNotInCatalog
          ? 'Outcome: product not in catalog — state this honestly; do not ask for more details.'
          : shouldAskClarification
            ? `Clarification required: ${clarificationReason}`
            : 'Match confidence acceptable.',
        '',
        ...buildVisionContextRules(productNotInCatalog, clarificationReason),
      ].join('\n')
    : null;

  console.info('[imageMatch]', {
    tenantId: input.tenantId,
    decision,
    visualMatches: visualMatches.length,
    topSimilarity: visualMatches[0]?.similarity ?? null,
    matchConfidence,
    shouldAskClarification,
    clarificationReason,
    brandLikelyAbsent,
    productNotInCatalog,
    exactSkuMatch,
    distinctProductCount: extraction?.distinct_product_count ?? null,
    allIdentical: extraction?.all_visible_products_identical ?? null,
  });

  // Fire-and-forget telemetry so production accuracy, clarification rate, and
  // not-in-catalog rate can be measured and the thresholds tuned off real data.
  logEvent(input.tenantId, 'vision_product_match', {
    decision,
    match_confidence: Number(matchConfidence.toFixed(3)),
    top_similarity: topMatch?.imageSimilarity ?? null,
    should_ask_clarification: shouldAskClarification,
    clarification_reason: clarificationReason,
    product_not_in_catalog: productNotInCatalog,
    exact_sku_match: exactSkuMatch,
    brand_likely_absent: brandLikelyAbsent,
    image_quality: extraction?.image_quality ?? null,
    contains_product: extraction?.contains_product ?? null,
    distinct_product_count: extraction?.distinct_product_count ?? null,
    all_visible_products_identical: extraction?.all_visible_products_identical ?? null,
    has_distracting_objects: extraction?.has_distracting_objects ?? null,
    matched_product_count: products.length,
    visual_candidate_count: visualMatches.length,
  }).catch(() => {});

  return {
    products,
    scoredMatches,
    visionContext,
    matchConfidence,
    shouldAskClarification,
    clarificationReason: productNotInCatalog ? 'product_not_in_catalog' : clarificationReason,
    multipleProductsDetected: extraction?.multiple_products_detected ?? false,
    imageQuality: extraction?.image_quality ?? 'fair',
    extraction,
    brandLikelyAbsent,
    productNotInCatalog,
  };
}

export { extractCustomerProductFromImages, extractCatalogImageFingerprint };
