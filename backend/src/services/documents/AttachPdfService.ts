import { PDFParse } from 'pdf-parse';
import fs from 'fs/promises';
import {
  AttachDocumentService,
  type DocumentParseResult,
  type ExtractedProductData,
} from './AttachDocumentService';

export class AttachPdfService extends AttachDocumentService {
  constructor(tenantId: string) {
    super(tenantId, 'pdf');
  }

  async parse(source: Buffer | string): Promise<DocumentParseResult> {
    const buffer = Buffer.isBuffer(source) ? source : await fs.readFile(source);
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const rawText = result.text.trim();
    await parser.destroy();

    const products = this.extractProducts(rawText);
    return { rawText, products };
  }

  private extractProducts(text: string): ExtractedProductData[] {
    const products: ExtractedProductData[] = [];
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    const priceRegex = /\$?\d+[.,]\d{2}/;
    let current: ExtractedProductData | null = null;

    for (const line of lines) {
      const priceMatch = line.match(priceRegex);

      if (priceMatch && line.length < 200) {
        if (current) products.push(current);

        const priceStr = priceMatch[0].replace(/[^0-9.]/g, '');
        const name = line.replace(priceRegex, '').replace(/[-–—|:]/g, '').trim();

        current = {
          name: name || undefined,
          price: parseFloat(priceStr) || undefined,
        };
      } else if (current && !priceMatch) {
        current.description = current.description
          ? `${current.description} ${line}`
          : line;
      }
    }

    if (current) products.push(current);
    return products;
  }
}
