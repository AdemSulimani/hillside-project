import { openai, OPENAI_VISION_MODEL } from './openaiClient';
import { generateEmbedding } from './embeddingService';
import {
  buildFingerprintText,
  extractCatalogImageFingerprint,
} from './productImageFingerprintService';
import {
  searchProductsByImageFingerprintSimilarity,
  countMissingImageFingerprints,
  type ImageFingerprintMatch,
  type VisualFingerprintData,
} from '../db/models/productImageFingerprint';
import { searchProducts, type Product } from '../db/models/product';
import { permanentUrlToFilePath, fileToBase64DataUrl } from './attachmentStorageService';
import { redisConnection } from '../jobs/redisConnection';

export const IMAGE_SIMILARITY_THRESHOLD = parseFloat(
  process.env.IMAGE_SIMILARITY_THRESHOLD || '0.62',
);
export const IMAGE_MATCH_CONFIDENCE_THRESHOLD = parseFloat(
  process.env.IMAGE_MATCH_CONFIDENCE_THRESHOLD || '0.55',
);
export const VISION_EXTRACTION_CONFIDENCE_MIN = parseFloat(
  process.env.VISION_EXTRACTION_CONFIDENCE_MIN || '0.35',
);
export const IMAGE_MATCH_AMBIGUITY_DELTA = parseFloat(
  process.env.IMAGE_MATCH_AMBIGUITY_DELTA || '0.04',
);

console.info('[productImageMatching] thresholds', {
  IMAGE_SIMILARITY_THRESHOLD,
  IMAGE_MATCH_CONFIDENCE_THRESHOLD,
  VISION_EXTRACTION_CONFIDENCE_MIN,
  IMAGE_MATCH_AMBIGUITY_DELTA,
});

export type ImageQuality = 'good' | 'fair' | 'poor';

export interface CustomerVisionExtraction extends VisualFingerprintData {
  confidence: number;
  image_quality: ImageQuality;
  multiple_products_detected: boolean;
  product_count_estimate: number;
  is_social_media_screenshot: boolean;
  extraction_notes: string | null;
}

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
  };

  const qualityRaw = typeof raw.image_quality === 'string' ? raw.image_quality.toLowerCase() : 'fair';
  const imageQuality: ImageQuality =
    qualityRaw === 'good' || qualityRaw === 'poor' ? qualityRaw : 'fair';

  return {
    ...base,
    confidence: parseConfidence(raw.confidence),
    image_quality: imageQuality,
    multiple_products_detected: raw.multiple_products_detected === true,
    product_count_estimate:
      typeof raw.product_count_estimate === 'number' && raw.product_count_estimate > 0
        ? Math.min(10, Math.round(raw.product_count_estimate))
        : raw.multiple_products_detected
          ? 2
          : 1,
    is_social_media_screenshot: raw.is_social_media_screenshot === true,
    extraction_notes:
      typeof raw.extraction_notes === 'string' && raw.extraction_notes.trim()
        ? raw.extraction_notes.trim()
        : null,
  };
}

const CUSTOMER_VISION_SYSTEM = `You are a strict product-image analyst for a retail chatbot.
Extract ONLY what is clearly visible. Return ONLY valid JSON with keys:
- brand_name, product_name, product_type, flavor, size (string|null each)
- visible_text (string[] — label text you can read, max 20)
- packaging_colors, distinguishing_features, sku_visible, barcode_visible, packaging_version_note
- confidence (number 0-1 — how confident you are in brand+product identification)
- image_quality ("good"|"fair"|"poor" — based on blur, crop, angle, lighting)
- multiple_products_detected (boolean)
- product_count_estimate (integer)
- is_social_media_screenshot (boolean — Instagram/Facebook post screenshot with UI chrome)
- extraction_notes (string|null — e.g. "product partially visible", "similar packaging different brand")
Do NOT invent brand names. Use null when unreadable.`;

async function extractCustomerProductFromImages(
  inboundMessage: string,
  attachmentUrls: string[],
): Promise<CustomerVisionExtraction | null> {
  const visionUrls = attachmentUrls.filter(urlLooksLikeVisionImage);
  if (visionUrls.length === 0) return null;

  const resolvedImageUrls = resolveImageUrls(visionUrls);
  if (resolvedImageUrls.length === 0) return null;

  const cacheKey = `cust_vision:${resolvedImageUrls.map((u) => u.slice(-48)).join('|')}:${inboundMessage.slice(0, 80)}`;
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
    max_tokens: 450,
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

function buildClarificationReason(extraction: CustomerVisionExtraction | null): string | null {
  if (extraction?.multiple_products_detected && extraction.product_count_estimate > 1) {
    return 'multiple_products_in_image';
  }
  return null;
}

function computeProductNotInCatalog(input: {
  extraction: CustomerVisionExtraction | null;
  shouldAskClarification: boolean;
  matchConfidence: number;
  products: Product[];
}): boolean {
  if (!input.extraction || input.shouldAskClarification) return false;
  if (input.products.length > 0) return false;
  return input.matchConfidence < IMAGE_MATCH_CONFIDENCE_THRESHOLD;
}

function buildVisionContextRules(productNotInCatalog: boolean, shouldAskClarification: boolean): string[] {
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

  if (shouldAskClarification) {
    rules.push('- If multiple products visible, ask which one they mean.');
  }

  return rules;
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

  const structuredQuery = extraction
    ? [extraction.brand_name, extraction.product_name, extraction.product_type, extraction.flavor, extraction.size]
        .filter(Boolean)
        .join(' ')
    : '';

  let textSearchMatches: Product[] = [];
  if (structuredQuery) {
    textSearchMatches = await searchProducts(input.tenantId, structuredQuery, limit);
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
  const matchConfidence = computeMatchConfidence(extraction, topMatch);
  const clarificationReason = buildClarificationReason(extraction);
  const shouldAskClarification = clarificationReason !== null;

  let products: Product[];
  if (matchConfidence >= IMAGE_MATCH_CONFIDENCE_THRESHOLD && !shouldAskClarification) {
    products = scoredMatches.map((s) => s.product);
  } else if (topMatch && (topMatch.imageSimilarity ?? 0) >= IMAGE_SIMILARITY_THRESHOLD) {
    products = scoredMatches.slice(0, 3).map((s) => s.product);
  } else if (exactBrandMatches.length > 0) {
    products = exactBrandMatches;
  } else if (brandLikelyAbsent && textSearchMatches.length > 0) {
    // Response B: similar alternative from a different brand may still be offered.
    products = textSearchMatches.slice(0, limit);
  } else if (!extraction) {
    products = input.textMatchedProducts ?? [];
  } else {
    products = [];
  }

  const productNotInCatalog = computeProductNotInCatalog({
    extraction,
    shouldAskClarification,
    matchConfidence,
    products,
  });

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
        ...buildVisionContextRules(productNotInCatalog, shouldAskClarification),
      ].join('\n')
    : null;

  console.info('[imageMatch]', {
    tenantId: input.tenantId,
    visualMatches: visualMatches.length,
    topSimilarity: visualMatches[0]?.similarity ?? null,
    matchConfidence,
    shouldAskClarification,
    clarificationReason,
    brandLikelyAbsent,
    productNotInCatalog,
  });

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
