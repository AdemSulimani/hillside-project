import crypto from 'crypto';
import { openai, OPENAI_EMBEDDING_MODEL, OPENAI_VISION_MODEL } from './openaiClient';
import { generateEmbedding } from './embeddingService';
import {
  upsertProductImageFingerprint,
  updateProductImageFingerprintEmbedding,
  hashImageUrl,
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
  if (data.product_name) parts.push(`Product: ${data.product_name}`);
  if (data.product_type) parts.push(`Type: ${data.product_type}`);
  if (data.flavor) parts.push(`Flavor: ${data.flavor}`);
  if (data.size) parts.push(`Size: ${data.size}`);
  if (data.packaging_colors) parts.push(`Colors: ${data.packaging_colors}`);
  if (data.distinguishing_features) parts.push(`Features: ${data.distinguishing_features}`);
  if (data.sku_visible) parts.push(`SKU: ${data.sku_visible}`);
  if (data.packaging_version_note) parts.push(`Packaging: ${data.packaging_version_note}`);
  if (data.visible_text.length > 0) parts.push(`Visible text: ${data.visible_text.join(', ')}`);
  if (data.barcode_visible) parts.push('Barcode visible');
  return parts.join('. ');
}

export function hashFingerprintInput(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeFingerprint(raw: Partial<VisualFingerprintData>): VisualFingerprintData {
  return {
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
}

const CATALOG_FINGERPRINT_SYSTEM = `You are a strict product packaging analyst. Extract ONLY what is clearly visible on the product image.
Return ONLY valid JSON with keys:
- brand_name (string|null)
- product_name (string|null)
- product_type (string|null)
- flavor (string|null)
- size (string|null)
- visible_text (string[] — up to 20 short strings read from the label/packaging)
- packaging_colors (string|null — dominant colors and layout)
- distinguishing_features (string|null — logos, shapes, unique visual markers)
- sku_visible (string|null)
- barcode_visible (boolean)
- packaging_version_note (string|null — e.g. "old packaging", "new label design", or null if unknown)
Use null for unknown fields. Do not guess brand if unreadable.`;

export async function extractCatalogImageFingerprint(imageUrl: string): Promise<VisualFingerprintData> {
  const cacheKey = `img_fp:${hashImageUrl(imageUrl)}`;
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
    max_tokens: 400,
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
