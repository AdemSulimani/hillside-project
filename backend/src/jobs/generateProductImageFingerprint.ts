import { generateAndStoreProductImageFingerprint } from '../services/productImageFingerprintService';

export interface GenerateProductImageFingerprintJobData {
  productId: string;
  tenantId: string;
  imageUrl: string;
}

export async function processGenerateProductImageFingerprint(
  data: GenerateProductImageFingerprintJobData,
): Promise<void> {
  const { productId, tenantId, imageUrl } = data;

  if (!imageUrl?.trim()) {
    console.warn('[imageFingerprint] Empty image URL, skipping', { productId, tenantId });
    return;
  }

  try {
    await generateAndStoreProductImageFingerprint(productId, tenantId, imageUrl.trim());
  } catch (err) {
    console.error('[imageFingerprint] Failed to generate fingerprint', {
      productId,
      tenantId,
      imageUrl: imageUrl.slice(0, 80),
      err,
    });
    throw err;
  }
}
