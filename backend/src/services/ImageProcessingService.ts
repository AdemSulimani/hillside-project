import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import path from 'path';
import { createProduct, type Product } from '../db/models/product';
import type { ExtractedProductData } from './documents/AttachDocumentService';

export class ImageProcessingService {
  private tenantId: string;

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  async preprocessImage(filePath: string): Promise<string> {
    const ext = path.extname(filePath);
    const preprocessedPath = filePath.replace(ext, `_preprocessed${ext}`);

    await sharp(filePath)
      .greyscale()
      .normalize()
      .sharpen()
      .toFile(preprocessedPath);

    return preprocessedPath;
  }

  async extractText(filePath: string): Promise<string> {
    const preprocessedPath = await this.preprocessImage(filePath);

    const { data } = await Tesseract.recognize(preprocessedPath, 'eng', {
      logger: () => {},
    });

    return data.text.trim();
  }

  parseExtractedText(text: string): ExtractedProductData {
    const product: ExtractedProductData = {};
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    if (lines.length > 0) {
      product.name = lines[0].slice(0, 255);
    }

    const priceRegex = /\$?\d+[.,]\d{2}/;
    for (const line of lines) {
      const match = line.match(priceRegex);
      if (match) {
        const priceStr = match[0].replace(/[^0-9.]/g, '');
        product.price = parseFloat(priceStr);
        break;
      }
    }

    const descLines = lines.slice(1).filter((l) => !priceRegex.test(l));
    if (descLines.length > 0) {
      product.description = descLines.join(' ').slice(0, 5000);
    }

    return product;
  }

  async process(filePath: string): Promise<Product> {
    const rawText = await this.extractText(filePath);
    const data = this.parseExtractedText(rawText);

    return createProduct({
      tenant_id: this.tenantId,
      name: data.name || 'OCR Imported Product',
      price: data.price ?? 0,
      description: data.description ?? null,
      tags: data.tags ?? (data.category ? [data.category] : []),
      source_type: 'image',
      extracted_text: rawText,
      metadata: { ocr_data: data },
    });
  }

  async processWithAI(
    filePath: string,
    aiEnrich: (text: string) => Promise<ExtractedProductData[]>,
  ): Promise<Product> {
    const rawText = await this.extractText(filePath);
    const enriched = await aiEnrich(rawText);
    const data = enriched[0] ?? this.parseExtractedText(rawText);

    return createProduct({
      tenant_id: this.tenantId,
      name: data.name || 'OCR Imported Product',
      price: data.price ?? 0,
      description: data.description ?? null,
      tags: data.tags ?? (data.category ? [data.category] : []),
      source_type: 'image',
      extracted_text: rawText,
      metadata: { ocr_data: data, ai_enriched: true },
    });
  }
}
