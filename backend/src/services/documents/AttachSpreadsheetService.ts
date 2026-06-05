import XLSX from 'xlsx';
import {
  AttachDocumentService,
  type DocumentParseResult,
  type ExtractedProductData,
} from './AttachDocumentService';
import { decodeLegacyTextBuffer, repairMojibake } from '../../utils/textEncoding';

interface SpreadsheetRow {
  [key: string]: unknown;
}

export class AttachSpreadsheetService extends AttachDocumentService {
  constructor(tenantId: string) {
    super(tenantId, 'spreadsheet');
  }

  async parse(source: Buffer | string): Promise<DocumentParseResult> {
    const workbook = Buffer.isBuffer(source)
      ? this.readWorkbookFromBuffer(source)
      : XLSX.readFile(source);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<SpreadsheetRow>(sheet);

    const rawText = rows
      .map((r) => Object.values(r).join(' | '))
      .join('\n');

    const products = this.extractProducts(rows);
    return { rawText: repairMojibake(rawText), products };
  }

  private readWorkbookFromBuffer(source: Buffer) {
    const isCsvLike =
      source.length > 0 &&
      !source.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
      !source.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

    if (!isCsvLike) {
      return XLSX.read(source, { type: 'buffer' });
    }

    const decoded = decodeLegacyTextBuffer(source);
    return XLSX.read(decoded, { type: 'string', raw: false });
  }

  private extractProducts(rows: SpreadsheetRow[]): ExtractedProductData[] {
    if (rows.length === 0) return [];

    const headers = Object.keys(rows[0]);
    const fieldMap = this.detectColumns(headers);

    return rows.map((row) => {
      const product: ExtractedProductData = {};

      if (fieldMap.name) {
        product.name = repairMojibake(String(row[fieldMap.name] ?? '').trim()) || undefined;
      }
      if (fieldMap.description) {
        product.description = repairMojibake(String(row[fieldMap.description] ?? '').trim()) || undefined;
      }
      if (fieldMap.price) {
        const parsed = this.parsePrice(row[fieldMap.price]);
        if (parsed != null) product.price = parsed;
      }
      if (fieldMap.discounted_price) {
        const parsed = this.parsePrice(row[fieldMap.discounted_price]);
        if (parsed != null) product.discounted_price = parsed;
      }
      if (fieldMap.brand) {
        product.brand = repairMojibake(String(row[fieldMap.brand] ?? '').trim()) || undefined;
      }
      if (fieldMap.sku) {
        product.sku = repairMojibake(String(row[fieldMap.sku] ?? '').trim()) || undefined;
      }
      if (fieldMap.usage_description) {
        product.usage_description =
          repairMojibake(String(row[fieldMap.usage_description] ?? '').trim()) || undefined;
      }
      if (fieldMap.tags) {
        const val = row[fieldMap.tags];
        if (typeof val === 'string') {
          product.tags = val.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
        }
      }
      if (fieldMap.category) {
        product.category = repairMojibake(String(row[fieldMap.category] ?? '').trim()) || undefined;
      }

      return product;
    }).filter((p) => p.name || p.price);
  }

  private detectColumns(headers: string[]): Record<string, string | undefined> {
    const map: Record<string, string | undefined> = {};
    const lower = headers.map((h) => h.toLowerCase().trim());
    const used = new Set<number>();

    const patterns: Record<string, RegExp> = {
      discounted_price:
        /^(discounted[_\s-]?price|discounted|sale[_\s-]?price|discount[_\s-]?price|promo[_\s-]?price|special[_\s-]?price|offer[_\s-]?price|reduced[_\s-]?price)/,
      usage_description:
        /^(usage([_\s-]desc(ription)?)?|how[_\s-]?to[_\s-]?use|instructions?|directions?)/,
      name: /^(name|product|title|item)/,
      brand: /^(brand|manufacturer|maker|vendor)/,
      description: /^(desc(ription)?|details|about|product[_\s-]?desc(ription)?)/,
      price: /^(price|cost|amount|rate|regular[_\s-]?price)/,
      sku: /^(sku|code|product[_\s-]?code|item[_\s-]?code|barcode|upc|ean)/,
      tags: /^(tags?|labels?|keywords?)/,
      category: /^(category|type|group|class)/,
    };

    const fieldOrder = [
      'discounted_price',
      'usage_description',
      'name',
      'brand',
      'description',
      'price',
      'sku',
      'tags',
      'category',
    ] as const;

    for (const field of fieldOrder) {
      const regex = patterns[field];
      const idx = lower.findIndex((h, i) => !used.has(i) && regex.test(h));
      if (idx !== -1) {
        map[field] = headers[idx];
        used.add(idx);
      }
    }

    return map;
  }

  private parsePrice(value: unknown): number | undefined {
    if (typeof value === 'number' && !isNaN(value) && value >= 0) {
      return value;
    }
    const raw = String(value ?? '').replace(/[^0-9.]/g, '');
    const parsed = parseFloat(raw);
    return !isNaN(parsed) && parsed >= 0 ? parsed : undefined;
  }
}
