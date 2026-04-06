import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import {
  findUserById,
  findUserByEmailExcluding,
  updateUser,
  updatePasswordHash,
  toPublicUser,
} from '../db/models/user';
import { sendSuccess, sendError } from '../utils/response';
import type { UpdateProfileInput, UpdatePasswordInput } from '../validators/profile';

const SALT_ROUNDS = 12;

export async function update(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { name, email } = req.body as UpdateProfileInput;

    const conflict = await findUserByEmailExcluding(email, userId);
    if (conflict) {
      sendError(res, 'A user with this email already exists', 409);
      return;
    }

    const updated = await updateUser(userId, { name, email });
    if (!updated) {
      sendError(res, 'User not found', 404);
      return;
    }

    sendSuccess(res, { user: toPublicUser(updated) }, 'Profile updated successfully');
  } catch (err) {
    sendError(res, 'Failed to update profile', 500, err);
  }
}

export async function updatePassword(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { currentPassword, newPassword } = req.body as UpdatePasswordInput;

    const user = await findUserById(userId);
    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) {
      sendError(res, 'Current password is incorrect', 401);
      return;
    }

    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await updatePasswordHash(userId, newHash);

    sendSuccess(res, null, 'Password updated successfully');
  } catch (err) {
    sendError(res, 'Failed to update password', 500, err);
  }
}
