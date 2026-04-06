import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;

const ACCESS_TOKEN_EXPIRY = '15m';
/** Long-lived refresh when "Remember me" is checked */
const REFRESH_TOKEN_LONG_SECONDS = 30 * 24 * 60 * 60; // 30 days
/** Shorter refresh when not remembering (browser session cookie; server cap) */
const REFRESH_TOKEN_SESSION_SECONDS = 24 * 60 * 60; // 1 day

export interface AccessTokenPayload {
  userId: string;
  tenantId: string | null;
}

export interface RefreshTokenPayload {
  userId: string;
}

export function generateAccessToken(userId: string, tenantId: string | null): string {
  return jwt.sign({ userId, tenantId }, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
}

export function generateRefreshToken(userId: string, persistent: boolean): string {
  const seconds = persistent ? REFRESH_TOKEN_LONG_SECONDS : REFRESH_TOKEN_SESSION_SECONDS;
  return jwt.sign({ userId }, JWT_REFRESH_SECRET, {
    expiresIn: seconds,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, JWT_REFRESH_SECRET) as RefreshTokenPayload;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function getRefreshTokenExpiryDate(persistent: boolean): Date {
  const seconds = persistent ? REFRESH_TOKEN_LONG_SECONDS : REFRESH_TOKEN_SESSION_SECONDS;
  return new Date(Date.now() + seconds * 1000);
}

export const REFRESH_TOKEN_LONG_MS = REFRESH_TOKEN_LONG_SECONDS * 1000;
export const REFRESH_TOKEN_SESSION_MS = REFRESH_TOKEN_SESSION_SECONDS * 1000;

export function getRefreshCookieMaxAgeMs(persistent: boolean): number | undefined {
  return persistent ? REFRESH_TOKEN_LONG_MS : undefined;
}
