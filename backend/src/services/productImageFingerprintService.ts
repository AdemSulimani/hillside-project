import crypto from 'crypto';
import { openai, OPENAI_EMBEDDING_MODEL, OPENAI_VISION_MODEL } from './openaiClient';
import { generateEmbedding } from './embeddingService';
import {
  upsertProductImageFingerprint,
  updateProductImageFingerprintEmbedding,
  hashImageUrl,
  normalizeAttributesMap,
  normalizeConfidenceMap,
  CURRENT_FINGERPRINT_VERSION,
  type VisualFingerprintData,
} from '../db/models/productImageFingerprint';
import { redisConnection } from '../jobs/redisConnection';
import type { GenerateProductImageFingerprintJobData } from '../jobs/generateProductImageFingerprint';
import type { Queue } from 'bullmq';
import type { DefaultQueueJobData } from '../jobs/queues/defaultQueue';

const FINGERPRINT_CACHE_TTL_SEC = 86400 * 7;

export function buildFingerprintText(data: VisualFingerprintData): string {
  const parts: string[] = [];
  if (data.brand_name) parts.push(`Brand: ${data.brand_name}`);
  if (data.manufacturer) parts.push(`Manufacturer: ${data.manufacturer}`);
  if (data.product_name) parts.push(`Product: ${data.product_name}`);
  if (data.product_type) parts.push(`Type: ${data.product_type}`);
  if (data.category) parts.push(`Category: ${data.category}`);
  if (data.flavor) parts.push(`Flavor: ${data.flavor}`);
  if (data.size) parts.push(`Size: ${data.size}`);
  if (data.servings) parts.push(`Servings: ${data.servings}`);
  if (data.packaging_colors) parts.push(`Colors: ${data.packaging_colors}`);
  if (data.distinguishing_features) parts.push(`Features: ${data.distinguishing_features}`);
  if (data.sku_visible) parts.push(`SKU: ${data.sku_visible}`);
  if (data.packaging_version_note) parts.push(`Packaging: ${data.packaging_version_note}`);
  const attrEntries = Object.entries(data.attributes ?? {});
  if (attrEntries.length > 0) {
    parts.push(attrEntries.map(([k, v]) => `${k}: ${v}`).join('; '));
  }
  if (data.visible_text.length > 0) parts.push(`Visible text: ${data.visible_text.join(', ')}`);
  if (data.barcode_visible) parts.push('Barcode visible');
  return parts.join('. ');
}

export function hashFingerprintInput(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function normalizeFingerprint(raw: Partial<VisualFingerprintData>): VisualFingerprintData {
  return {
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
}

const CATALOG_FINGERPRINT_SYSTEM = `You are a strict product packaging analyst. Extract ONLY what is clearly visible on the product image. Never guess or infer values that are not legibly printed.
Return ONLY valid JSON with keys:
- brand_name (string|null)
- product_name (string|null)
- product_type (string|null — e.g. "protein powder", "running shoe")
- category (string|null — product category if printed or strongly implied by the packaging)
- manufacturer (string|null — manufacturer/distributor if printed and distinct from the brand)
- flavor (string|null)
- size (string|null — net weight/volume/quantity, e.g. "2.27kg", "500ml")
- servings (string|null — serving count/serving info if printed, e.g. "60 servings", "30 servings per container")
- visible_text (string[] — up to 20 short strings read verbatim from the label/packaging)
- packaging_colors (string|null — dominant colors and layout)
- distinguishing_features (string|null — logos, shapes, unique visual markers)
- sku_visible (string|null)
- barcode_visible (boolean)
- packaging_version_note (string|null — e.g. "old packaging", "new label design", or null if unknown)
- attributes (object — a map of ANY other clearly-labeled fact on the packaging, keyed by a short lowercase attribute name. Examples: {"protein per serving":"24g","calories":"120","weight":"2.27kg","directions":"mix 1 scoop with 250ml water","warnings":"keep out of reach of children","ingredients":"whey concentrate, cocoa","certifications":"informed sport","made in":"USA"}. Include anything a customer might ask about. Omit anything not legibly printed.)
- attribute_confidence (object — your confidence in [0,1] for each field you filled, keyed by the SAME names you used above and in attributes. Example: {"brand_name":0.97,"flavor":0.9,"servings":0.6,"protein per serving":0.85}. Lower the value when text is blurry, partially occluded, or ambiguous.)
Use null/empty for unknown fields. Do not invent brand, numbers, or claims if unreadable.`;

export async function extractCatalogImageFingerprint(imageUrl: string): Promise<VisualFingerprintData> {
  const cacheKey = `img_fp:v${CURRENT_FINGERPRINT_VERSION}:${hashImageUrl(imageUrl)}`;
  const cached = await redisConnection.get(cacheKey);
  if (cached) {
    try {
      return normalizeFingerprint(JSON.parse(cached) as Partial<VisualFingerprintData>);
    } catch {
      await redisConnection.del(cacheKey);
    }
  }

  const completion = await openai.chat.completions.create({
    model: OPENAI_VISION_MODEL || 'gpt-4o',
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 700,
    messages: [
      { role: 'system', content: CATALOG_FINGERPRINT_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract a visual fingerprint for catalog matching from this product image.' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) {
    throw new Error('Vision model returned empty fingerprint');
  }

  const parsed = normalizeFingerprint(JSON.parse(raw) as Partial<VisualFingerprintData>);
  await redisConnection.set(cacheKey, JSON.stringify(parsed), 'EX', FINGERPRINT_CACHE_TTL_SEC);
  return parsed;
}

export async function generateAndStoreProductImageFingerprint(
  productId: string,
  tenantId: string,
  imageUrl: string,
): Promise<void> {
  const fingerprintJson = await extractCatalogImageFingerprint(imageUrl);
  const fingerprintText = buildFingerprintText(fingerprintJson);
  if (!fingerprintText.trim()) {
    console.warn('[imageFingerprint] Empty fingerprint text, skipping embed', { productId, imageUrl });
    await upsertProductImageFingerprint({
      tenantId,
      productId,
      imageUrl,
      fingerprintJson,
      fingerprintText: 'unknown product image',
      fingerprintVersion: CURRENT_FINGERPRINT_VERSION,
    });
    return;
  }

  const inputHash = hashFingerprintInput(fingerprintText);
  const modelName = process.env.OPENAI_EMBEDDING_MODEL?.trim() || OPENAI_EMBEDDING_MODEL;
  const vector = await generateEmbedding(fingerprintText);

  const row = await upsertProductImageFingerprint({
    tenantId,
    productId,
    imageUrl,
    fingerprintJson,
    fingerprintText,
    embedding: vector,
    embeddingInputHash: inputHash,
    embeddingModel: modelName,
    fingerprintVersion: CURRENT_FINGERPRINT_VERSION,
  });

  if (!row.embedding) {
    await updateProductImageFingerprintEmbedding(row.id, tenantId, vector, inputHash, modelName);
  }

  console.info('[imageFingerprint] Stored catalog image fingerprint', {
    productId,
    tenantId,
    imageUrl: imageUrl.slice(0, 80),
    dimensions: vector.length,
  });
}

export async function queueProductImageFingerprintJobs(
  defaultQueue: Queue<DefaultQueueJobData>,
  productId: string,
  tenantId: string,
  imageUrls: string[],
  priority = 2,
): Promise<void> {
  const uniqueUrls = [...new Set(imageUrls.filter((u) => typeof u === 'string' && u.trim().length > 0))];
  await Promise.all(
    uniqueUrls.map((imageUrl) =>
      defaultQueue.add(
        'product.imageFingerprint',
        { productId, tenantId, imageUrl } satisfies GenerateProductImageFingerprintJobData,
        { priority },
      ),
    ),
  );
}
