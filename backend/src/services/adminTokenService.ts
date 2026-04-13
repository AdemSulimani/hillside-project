import jwt from 'jsonwebtoken';

const ADMIN_ACCESS_EXPIRY = '12h';

export interface AdminAccessTokenPayload {
  platformOwnerId: string;
  email: string;
}

function getAdminJwtSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET?.trim();
  if (!secret) {
    throw new Error('ADMIN_JWT_SECRET is not configured');
  }
  return secret;
}

export function generateAdminAccessToken(platformOwnerId: string, email: string): string {
  return jwt.sign({ platformOwnerId, email }, getAdminJwtSecret(), {
    expiresIn: ADMIN_ACCESS_EXPIRY,
  });
}

export function verifyAdminAccessToken(token: string): AdminAccessTokenPayload {
  return jwt.verify(token, getAdminJwtSecret()) as AdminAccessTokenPayload;
}
