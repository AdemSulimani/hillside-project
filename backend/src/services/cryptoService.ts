import crypto from 'crypto';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const rawKey = process.env.ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error('ENCRYPTION_KEY is not configured');
  }

  const trimmed = rawKey.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  const base64Key = Buffer.from(trimmed, 'base64');
  if (base64Key.length === 32) {
    return base64Key;
  }

  if (Buffer.byteLength(trimmed, 'utf8') === 32) {
    return Buffer.from(trimmed, 'utf8');
  }

  throw new Error(
    'ENCRYPTION_KEY must be 32-byte utf8, 64-char hex, or base64-encoded 32-byte value',
  );
}

export class CryptoService {
  private readonly key: Buffer;

  constructor() {
    this.key = getEncryptionKey();
  }

  encrypt(plainText: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  decrypt(payload: string): string {
    const data = Buffer.from(payload, 'base64');
    if (data.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      throw new Error('Invalid encrypted payload');
    }

    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    const plainText = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return plainText.toString('utf8');
  }
}

export const cryptoService = new CryptoService();
