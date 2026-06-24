import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { createProduct, type Product } from '../db/models/product';
import {
  extractedDataToProductInput,
  type ExtractedProductData,
} from './documents/AttachDocumentService';
import { parsePrice } from './documents/priceParsing';

export class ImageProcessingService {
  private tenantId: string;

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  async preprocessImage(source: Buffer | string): Promise<Buffer> {
    return sharp(source)
      .greyscale()
      .normalize()
      .sharpen()
      .toBuffer();
  }

  async extractText(source: Buffer | string): Promise<string> {
    const preprocessedBuffer = await this.preprocessImage(source);

    const { data } = await Tesseract.recognize(preprocessedBuffer, 'eng', {
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
        const parsed = parsePrice(match[0]);
        if (parsed !== undefined) product.price = parsed;
        break;
      }
    }

    const descLines = lines.slice(1).filter((l) => !priceRegex.test(l));
    if (descLines.length > 0) {
      product.description = descLines.join(' ').slice(0, 5000);
    }

    return product;
  }

  async process(source: Buffer | string): Promise<Product> {
    const rawText = await this.extractText(source);
    const data = this.parseExtractedText(rawText);

    return createProduct(
      extractedDataToProductInput(this.tenantId, data, 'image', rawText, { ocr_data: data }, 'OCR Imported Product'),
    );
  }

  async processWithAI(
    source: Buffer | string,
    aiEnrich: (text: string) => Promise<ExtractedProductData[]>,
  ): Promise<Product> {
    const rawText = await this.extractText(source);
    const enriched = await aiEnrich(rawText);
    const data = enriched[0] ?? this.parseExtractedText(rawText);

    return createProduct(
      extractedDataToProductInput(
        this.tenantId,
        data,
        'image',
        rawText,
        { ocr_data: data, ai_enriched: true },
        'OCR Imported Product',
      ),
    );
  }
}
