import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { createUser, findUserByEmail, findUserById, toPublicUser } from '../db/models/user';
import {
  createRefreshToken,
  findRefreshTokenByHash,
  deleteRefreshTokenByHash,
} from '../db/models/refreshToken';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  hashToken,
  getRefreshTokenExpiryDate,
  getRefreshCookieMaxAgeMs,
} from '../services/tokenService';
import { sendSuccess, sendError } from '../utils/response';
import type { RegisterInput, LoginInput } from '../validators/auth';

const SALT_ROUNDS = 12;
const COOKIE_NAME = 'refresh_token';

function setRefreshCookie(res: Response, token: string, persistent: boolean): void {
  const maxAge = getRefreshCookieMaxAgeMs(persistent);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    ...(maxAge !== undefined ? { maxAge } : {}),
    path: '/api/auth',
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
  });
}

export async function register(req: Request, res: Response): Promise<void> {
  try {
    const { name, email, password, rememberMe } = req.body as RegisterInput;
    const persistent = rememberMe === true;

    const existing = await findUserByEmail(email);
    if (existing) {
      sendError(res, 'A user with this email already exists', 409);
      return;
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await createUser(name, email, passwordHash);

    const accessToken = generateAccessToken(user.id, user.tenant_id);
    const refreshToken = generateRefreshToken(user.id, persistent);

    await createRefreshToken(
      user.id,
      hashToken(refreshToken),
      getRefreshTokenExpiryDate(persistent),
      persistent,
    );

    setRefreshCookie(res, refreshToken, persistent);

    sendSuccess(
      res,
      { user: toPublicUser(user), accessToken },
      'Registration successful',
      201,
    );
  } catch (err) {
    sendError(res, 'Registration failed', 500, err);
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password, rememberMe } = req.body as LoginInput;
    const persistent = rememberMe === true;

    const user = await findUserByEmail(email);
    if (!user) {
      sendError(res, 'Invalid email or password', 401);
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      sendError(res, 'Invalid email or password', 401);
      return;
    }

    const accessToken = generateAccessToken(user.id, user.tenant_id);
    const refreshToken = generateRefreshToken(user.id, persistent);

    await createRefreshToken(
      user.id,
      hashToken(refreshToken),
      getRefreshTokenExpiryDate(persistent),
      persistent,
    );

    setRefreshCookie(res, refreshToken, persistent);

    sendSuccess(res, { user: toPublicUser(user), accessToken }, 'Login successful');
  } catch (err) {
    sendError(res, 'Login failed', 500, err);
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  try {
    const token = req.cookies?.[COOKIE_NAME];

    if (token) {
      await deleteRefreshTokenByHash(hashToken(token));
    }

    clearRefreshCookie(res);
    sendSuccess(res, null, 'Logged out successfully');
  } catch (err) {
    sendError(res, 'Logout failed', 500, err);
  }
}

export async function refresh(req: Request, res: Response): Promise<void> {
  try {
    const token = req.cookies?.[COOKIE_NAME];

    if (!token) {
      sendError(res, 'Refresh token not found', 401);
      return;
    }

    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      clearRefreshCookie(res);
      sendError(res, 'Invalid refresh token', 401);
      return;
    }

    const tokenHash = hashToken(token);
    const storedToken = await findRefreshTokenByHash(tokenHash);

    if (!storedToken) {
      clearRefreshCookie(res);
      sendError(res, 'Refresh token not recognized', 401);
      return;
    }

    if (new Date() > storedToken.expires_at) {
      await deleteRefreshTokenByHash(tokenHash);
      clearRefreshCookie(res);
      sendError(res, 'Refresh token expired', 401);
      return;
    }

    // Rotate: delete old token, issue new pair
    await deleteRefreshTokenByHash(tokenHash);

    const user = await findUserById(payload.userId);
    if (!user) {
      clearRefreshCookie(res);
      sendError(res, 'User not found', 401);
      return;
    }

    const persistent = storedToken.persistent;

    const newAccessToken = generateAccessToken(user.id, user.tenant_id);
    const newRefreshToken = generateRefreshToken(user.id, persistent);

    await createRefreshToken(
      user.id,
      hashToken(newRefreshToken),
      getRefreshTokenExpiryDate(persistent),
      persistent,
    );

    setRefreshCookie(res, newRefreshToken, persistent);

    sendSuccess(res, { accessToken: newAccessToken }, 'Token refreshed');
  } catch (err) {
    sendError(res, 'Token refresh failed', 500, err);
  }
}

export async function me(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;

    const user = await findUserById(userId);
    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }

    sendSuccess(res, { user: toPublicUser(user) });
  } catch (err) {
    sendError(res, 'Failed to fetch user', 500, err);
  }
}
