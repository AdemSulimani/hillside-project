import XLSX from 'xlsx';
import {
  AttachDocumentService,
  type DocumentParseResult,
  type ExtractedProductData,
} from './AttachDocumentService';

interface SpreadsheetRow {
  [key: string]: unknown;
}

export class AttachSpreadsheetService extends AttachDocumentService {
  constructor(tenantId: string) {
    super(tenantId, 'spreadsheet');
  }

  async parse(filePath: string): Promise<DocumentParseResult> {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<SpreadsheetRow>(sheet);

    const rawText = rows
      .map((r) => Object.values(r).join(' | '))
      .join('\n');

    const products = this.extractProducts(rows);
    return { rawText, products };
  }

  private extractProducts(rows: SpreadsheetRow[]): ExtractedProductData[] {
    if (rows.length === 0) return [];

    const headers = Object.keys(rows[0]);
    const fieldMap = this.detectColumns(headers);

    return rows.map((row) => {
      const product: ExtractedProductData = {};

      if (fieldMap.name) {
        product.name = String(row[fieldMap.name] ?? '').trim() || undefined;
      }
      if (fieldMap.description) {
        product.description = String(row[fieldMap.description] ?? '').trim() || undefined;
      }
      if (fieldMap.price) {
        const raw = String(row[fieldMap.price] ?? '').replace(/[^0-9.]/g, '');
        const parsed = parseFloat(raw);
        if (!isNaN(parsed)) product.price = parsed;
      }
      if (fieldMap.tags) {
        const val = row[fieldMap.tags];
        if (typeof val === 'string') {
          product.tags = val.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
        }
      }
      if (fieldMap.category) {
        product.category = String(row[fieldMap.category] ?? '').trim() || undefined;
      }

      return product;
    }).filter((p) => p.name || p.price);
  }

  private detectColumns(headers: string[]): Record<string, string | undefined> {
    const map: Record<string, string | undefined> = {};
    const lower = headers.map((h) => h.toLowerCase());

    const patterns: Record<string, RegExp> = {
      name: /^(name|product|title|item)/,
      description: /^(desc|description|details|about)/,
      price: /^(price|cost|amount|rate)/,
      tags: /^(tags?|labels?|keywords?)/,
      category: /^(category|type|group|class)/,
    };

    for (const [field, regex] of Object.entries(patterns)) {
      const idx = lower.findIndex((h) => regex.test(h));
      if (idx !== -1) map[field] = headers[idx];
    }

    return map;
  }
}
