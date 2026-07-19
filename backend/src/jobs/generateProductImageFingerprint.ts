import { generateAndStoreProductImageFingerprint } from '../services/productImageFingerprintService';
import { withJobCostTracking } from '../services/costRecorder';

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
    // P3-6: a vision call per catalog image is real COGS that never reaches the reply ledger.
    // At the 5k-product scale on the roadmap this is a large burst that would otherwise appear
    // only on the OpenAI invoice, with nothing in the product able to say which tenant caused it.
    await withJobCostTracking({ tenantId, job: 'product.imageFingerprint' }, () =>
      generateAndStoreProductImageFingerprint(productId, tenantId, imageUrl.trim()),
    );
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
