import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { findPlatformOwnerByEmail } from '../db/models/platformOwner';
import { generateAdminAccessToken } from '../services/adminTokenService';
import { sendSuccess, sendError } from '../utils/response';
import type { AdminLoginBody } from '../validators/admin';

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body as AdminLoginBody;

    const owner = await findPlatformOwnerByEmail(email);
    if (!owner) {
      sendError(res, 'Invalid email or password', 401);
      return;
    }

    const ok = await bcrypt.compare(password, owner.password_hash);
    if (!ok) {
      sendError(res, 'Invalid email or password', 401);
      return;
    }

    let accessToken: string;
    try {
      accessToken = generateAdminAccessToken(owner.id, owner.email);
    } catch (err) {
      sendError(res, 'Admin authentication is not configured', 503, err);
      return;
    }

    sendSuccess(
      res,
      {
        accessToken,
        owner: { id: owner.id, email: owner.email },
      },
      'Admin login successful',
    );
  } catch (err) {
    sendError(res, 'Admin login failed', 500, err);
  }
}
