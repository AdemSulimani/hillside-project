import { AttachPdfService } from './AttachPdfService';
import { AttachSpreadsheetService } from './AttachSpreadsheetService';
import type { AttachDocumentService } from './AttachDocumentService';
import path from 'path';

export type DocumentType = 'pdf' | 'spreadsheet';

const MIME_TO_TYPE: Record<string, DocumentType> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
  'application/vnd.ms-excel': 'spreadsheet',
  'application/excel': 'spreadsheet',
  'application/x-excel': 'spreadsheet',
  'application/x-msexcel': 'spreadsheet',
  'text/csv': 'spreadsheet',
  'application/csv': 'spreadsheet',
  'text/comma-separated-values': 'spreadsheet',
  'text/plain': 'spreadsheet',
};

const EXT_TO_TYPE: Record<string, DocumentType> = {
  '.pdf': 'pdf',
  '.xlsx': 'spreadsheet',
  '.xls': 'spreadsheet',
  '.csv': 'spreadsheet',
};

export function getDocumentService(
  tenantId: string,
  mimetype: string,
  originalname?: string,
): AttachDocumentService {
  const normalizedMime = (mimetype || '').toLowerCase().trim();
  const ext = path.extname(originalname || '').toLowerCase();
  const docType = MIME_TO_TYPE[normalizedMime] ?? EXT_TO_TYPE[ext];

  switch (docType) {
    case 'pdf':
      return new AttachPdfService(tenantId);
    case 'spreadsheet':
      return new AttachSpreadsheetService(tenantId);
    default:
      throw new Error(
        `Unsupported document type: mimetype="${mimetype}" filename="${originalname ?? ''}"`,
      );
  }
}

export { AttachDocumentService } from './AttachDocumentService';
export { AttachPdfService } from './AttachPdfService';
export { AttachSpreadsheetService } from './AttachSpreadsheetService';
export type { ExtractedProductData, DocumentParseResult } from './AttachDocumentService';
