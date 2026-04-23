import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const BACKBLAZE_ENDPOINT = process.env.BACKBLAZE_ENDPOINT ?? '';
const BACKBLAZE_REGION = process.env.BACKBLAZE_REGION ?? '';
const BACKBLAZE_BUCKET_NAME = process.env.BACKBLAZE_BUCKET_NAME ?? '';

const DEFAULT_MAX_FILE_BYTES = 52428800;

function getMaxFileSizeBytes(): number {
  const raw = process.env.BACKBLAZE_MAX_FILE_SIZE_BYTES;
  if (raw == null || raw.trim() === '') return DEFAULT_MAX_FILE_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_BYTES;
}

function getBackblazePublicBase(): string {
  return (process.env.BACKBLAZE_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
}

const s3Client = new S3Client({
  endpoint: BACKBLAZE_ENDPOINT,
  region: BACKBLAZE_REGION,
  credentials: {
    accessKeyId: process.env.BACKBLAZE_KEY_ID ?? '',
    secretAccessKey: process.env.BACKBLAZE_APP_KEY ?? '',
  },
});

export async function uploadFile(
  fileBuffer: Buffer,
  filename: string,
  mimeType: string,
  folder: string,
): Promise<string> {
  const maxBytes = getMaxFileSizeBytes();
  if (fileBuffer.length > maxBytes) {
    const maxMb = maxBytes / (1024 * 1024);
    const label = Number.isInteger(maxMb) ? String(maxMb) : maxMb.toFixed(1).replace(/\.0$/, '');
    throw new Error(`File size exceeds maximum allowed size of ${label}MB.`);
  }

  const safeOriginal = path.basename(filename);
  const storedFilename = `${Date.now()}-${randomUUID()}-${safeOriginal}`;
  const key = `${folder}/${storedFilename}`;

  const publicBase = getBackblazePublicBase();
  if (!publicBase) {
    throw new Error('BACKBLAZE_PUBLIC_URL is not configured.');
  }
  if (!BACKBLAZE_BUCKET_NAME) {
    throw new Error('BACKBLAZE_BUCKET_NAME is not configured.');
  }

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BACKBLAZE_BUCKET_NAME,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType,
        ContentDisposition: 'inline',
      }),
    );
  } catch (error) {
    throw new Error(
      `Failed to upload file "${filename}" to Backblaze folder "${folder}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return `${publicBase}/${BACKBLAZE_BUCKET_NAME}/${key}`;
}

export async function deleteFile(filename: string, folder: string): Promise<void> {
  const key = `${folder}/${filename}`;
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: BACKBLAZE_BUCKET_NAME,
      Key: key,
    }),
  );
}
