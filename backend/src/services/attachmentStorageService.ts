import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import type { ChannelType } from '../db/models/channel';

const STORAGE_DIR = path.join(__dirname, '../../storage/attachments');
const GRAPH_API_BASE = 'https://graph.facebook.com/v25.0';

fs.mkdirSync(STORAGE_DIR, { recursive: true });

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
  'application/octet-stream': '.bin',
};

function extensionFromContentType(contentType: string): string {
  const base = contentType.split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_TO_EXT[base] || '.bin';
}

function generateFilename(ext: string): string {
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

function buildPublicUrl(filename: string): string {
  const base = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 8000}`;
  return `${base}/storage/attachments/${filename}`;
}

async function resolveMetaMediaUrl(
  mediaId: string,
  accessToken: string,
): Promise<string> {
  const { data } = await axios.get(`${GRAPH_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (typeof data.url !== 'string') {
    throw new Error(`Failed to resolve media URL for id=${mediaId}`);
  }
  return data.url;
}

async function downloadBuffer(
  url: string,
  headers?: Record<string, string>,
): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers,
  });
  const contentType =
    typeof response.headers['content-type'] === 'string'
      ? response.headers['content-type']
      : 'application/octet-stream';
  return { buffer: Buffer.from(response.data), contentType };
}

export async function downloadAndStore(
  attachmentRef: string,
  channelType: ChannelType,
  accessToken?: string,
): Promise<string> {
  let downloadUrl = attachmentRef;
  const headers: Record<string, string> = {};

  const isUrl = attachmentRef.startsWith('http://') || attachmentRef.startsWith('https://');

  if (!isUrl && accessToken) {
    downloadUrl = await resolveMetaMediaUrl(attachmentRef, accessToken);
    headers['Authorization'] = `Bearer ${accessToken}`;
  } else if (
    isUrl &&
    (channelType === 'whatsapp' || channelType === 'facebook' || channelType === 'instagram') &&
    accessToken
  ) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const { buffer, contentType } = await downloadBuffer(
    downloadUrl,
    Object.keys(headers).length > 0 ? headers : undefined,
  );

  const ext = extensionFromContentType(contentType);
  const filename = generateFilename(ext);
  const filePath = path.join(STORAGE_DIR, filename);

  await fs.promises.writeFile(filePath, buffer);

  return buildPublicUrl(filename);
}

export async function storeBuffer(
  buffer: Buffer,
  originalName: string,
): Promise<string> {
  const ext = path.extname(originalName) || '.bin';
  const filename = generateFilename(ext);
  const filePath = path.join(STORAGE_DIR, filename);

  await fs.promises.writeFile(filePath, buffer);

  return buildPublicUrl(filename);
}

export function getAbsolutePath(filename: string): string {
  return path.join(STORAGE_DIR, filename);
}

export function fileToBase64DataUrl(filePath: string): string | null {
  try {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
    };
    const mime = mimeMap[ext] || 'image/jpeg';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

export function permanentUrlToFilePath(permanentUrl: string): string | null {
  const marker = '/storage/attachments/';
  const idx = permanentUrl.indexOf(marker);
  if (idx === -1) return null;
  const filename = permanentUrl.slice(idx + marker.length);
  if (!filename || filename.includes('/') || filename.includes('..')) return null;
  return path.join(STORAGE_DIR, filename);
}
