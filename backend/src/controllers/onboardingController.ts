import type { Request, Response } from 'express';
import pool from '../db/pool';
import { createTenant } from '../db/models/tenant';
import { createAIConfig } from '../db/models/aiConfig';
import { toPublicUser } from '../db/models/user';
import { generateAccessToken } from '../services/tokenService';
import { sendSuccess, sendError } from '../utils/response';
import { onboardingSchema } from '../validators/onboarding';
import type { User } from '../db/models/user';
import type { Tenant } from '../db/models/tenant';

export async function complete(req: Request, res: Response): Promise<void> {
  const client = await pool.connect();

  try {
    const parsed = onboardingSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors);
      return;
    }

    const userId = req.user!.userId;

    const { rows: existingUsers } = await client.query<User>(
      'SELECT tenant_id FROM users WHERE id = $1',
      [userId],
    );

    if (existingUsers[0]?.tenant_id) {
      sendError(res, 'Onboarding already completed', 409);
      return;
    }

    const logoUrl = req.file
      ? `/uploads/${req.file.filename}`
      : null;

    await client.query('BEGIN');

    const tenant: Tenant = await createTenant(
      {
        name: parsed.data.name,
        niche: parsed.data.niche,
        description: parsed.data.description ?? null,
        delivery_methods: parsed.data.delivery_methods,
        logo_url: logoUrl,
      },
      client,
    );

    await createAIConfig(tenant.id, client);

    const { rows: updatedUsers } = await client.query<User>(
      `UPDATE users SET tenant_id = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [tenant.id, userId],
    );

    await client.query('COMMIT');

    const updatedUser = updatedUsers[0];
    const accessToken = generateAccessToken(updatedUser.id, updatedUser.tenant_id);

    sendSuccess(
      res,
      {
        user: toPublicUser(updatedUser),
        tenant,
        accessToken,
      },
      'Onboarding completed successfully',
      201,
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, 'Onboarding failed', 500, err);
  } finally {
    client.release();
  }
}

export async function status(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    sendSuccess(res, { completed: tenantId !== null });
  } catch (err) {
    sendError(res, 'Failed to fetch onboarding status', 500, err);
  }
}
