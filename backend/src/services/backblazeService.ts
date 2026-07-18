import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const DEFAULT_MAX_FILE_BYTES = 52428800;

function getBackblazeBucketName(): string {
  return process.env.BACKBLAZE_BUCKET_NAME ?? '';
}

function getMaxFileSizeBytes(): number {
  const raw = process.env.BACKBLAZE_MAX_FILE_SIZE_BYTES;
  if (raw == null || raw.trim() === '') return DEFAULT_MAX_FILE_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_BYTES;
}

function getBackblazePublicBase(): string {
  return (process.env.BACKBLAZE_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
}

/**
 * Constructed on FIRST USE, not at module load.
 *
 * This used to be a top-level `const s3Client = new S3Client({...})`, and the AWS SDK validates
 * eagerly: an empty `region` makes the constructor throw `Region is missing`. Because this module is
 * transitively reachable from `app.ts`, that turned a missing FILE-UPLOAD credential into a
 * process that could not boot at all — it logged its config banner and exited before `listen`, with
 * an SDK-internal error naming nothing that would help you find it. A CI job hit exactly that and
 * spent its budget looking at the wrong step.
 *
 * Deferring construction moves the failure to where it belongs: the server starts, every unrelated
 * route works, and only an actual upload fails — with a message that names the variable to set.
 *
 * Memoized, so the client is still created once per process and connection reuse is unchanged.
 */
let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (s3Client) return s3Client;

  const endpoint = process.env.BACKBLAZE_ENDPOINT ?? '';
  const region = process.env.BACKBLAZE_REGION ?? '';

  // Checked here rather than left to the SDK: `Region is missing` gives no hint which of the
  // several AWS-shaped integrations is at fault, and no hint that it is even about file storage.
  if (!region) {
    throw new Error(
      'BACKBLAZE_REGION is not configured — file storage is unavailable. ' +
        'Set it in backend/.env (see .env.example).',
    );
  }
  if (!endpoint) {
    throw new Error(
      'BACKBLAZE_ENDPOINT is not configured — file storage is unavailable. ' +
        'Set it in backend/.env (see .env.example).',
    );
  }

  s3Client = new S3Client({
    endpoint,
    region,
    credentials: {
      accessKeyId: process.env.BACKBLAZE_KEY_ID ?? '',
      secretAccessKey: process.env.BACKBLAZE_APP_KEY ?? '',
    },
  });
  return s3Client;
}

/** Test-only: drop the memoized client so a case can vary the environment. */
export function resetBackblazeClientForTests(): void {
  s3Client = null;
}

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
  const bucketName = getBackblazeBucketName();
  if (!bucketName) {
    throw new Error('BACKBLAZE_BUCKET_NAME is not configured.');
  }

  try {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucketName,
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

  return `${publicBase}/${bucketName}/${key}`;
}

export async function deleteFile(filename: string, folder: string): Promise<void> {
  const key = `${folder}/${filename}`;
  await getS3Client().send(
    new DeleteObjectCommand({
      Bucket: getBackblazeBucketName(),
      Key: key,
    }),
  );
}
