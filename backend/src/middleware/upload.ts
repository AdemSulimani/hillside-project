import multer from 'multer';
import path from 'path';
const storage = multer.memoryStorage();

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];
const MAX_SIZE = 2 * 1024 * 1024; // 2 MB

export const uploadLogo = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and SVG images are allowed'));
    }
  },
}).single('logo');

export const uploadProductImages = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and SVG images are allowed'));
    }
  },
}).array('images', 5);

const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/excel',
  'application/x-excel',
  'application/x-msexcel',
  'text/csv',
  'application/csv',
  'text/comma-separated-values',
]);

const DOCUMENT_EXT = /\.(pdf|xlsx|xls|csv)$/i;

function isAllowedDocument(file: Express.Multer.File): boolean {
  if (DOCUMENT_TYPES.has(file.mimetype)) {
    return true;
  }
  const name = file.originalname || '';
  // CSV is often reported as text/plain on Windows.
  if (file.mimetype === 'text/plain' && /\.csv$/i.test(name)) {
    return true;
  }
  // Browsers/OS often send application/octet-stream or empty mimetype; trust extension.
  if (DOCUMENT_EXT.test(name)) {
    return true;
  }
  return false;
}

export const uploadDocument = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedDocument(file)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, Excel, and CSV files are allowed'));
    }
  },
}).single('document');

export const uploadOcrImage = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and SVG images are allowed'));
    }
  },
}).single('image');

export const uploadAttachment = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
  },
}).single('attachment');
