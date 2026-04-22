import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const BACKBLAZE_ENDPOINT = process.env.BACKBLAZE_ENDPOINT ?? '';
const BACKBLAZE_REGION = process.env.BACKBLAZE_REGION ?? '';
const BACKBLAZE_BUCKET_NAME = process.env.BACKBLAZE_BUCKET_NAME ?? '';

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
  const key = `${folder}/${filename}`;

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BACKBLAZE_BUCKET_NAME,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType,
      }),
    );
  } catch (error) {
    throw new Error(
      `Failed to upload file "${filename}" to Backblaze folder "${folder}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return `${BACKBLAZE_ENDPOINT}/${BACKBLAZE_BUCKET_NAME}/${key}`;
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
