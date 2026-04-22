import type { Request, Response } from 'express';
import path from 'path';
import crypto from 'crypto';
import { findTenantById, updateTenant } from '../db/models/tenant';
import { sendSuccess, sendError } from '../utils/response';
import type { UpdateBusinessInput } from '../validators/business';
import { uploadImage } from '../services/cloudinaryService';

export async function show(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    sendSuccess(res, { business: tenant }, 'Business retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve business', 500, err);
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const fields = req.body as UpdateBusinessInput;

    const updated = await updateTenant(tenantId, fields);
    if (!updated) {
      sendError(res, 'Business not found', 404);
      return;
    }

    sendSuccess(res, { business: updated }, 'Business updated successfully');
  } catch (err) {
    sendError(res, 'Failed to update business', 500, err);
  }
}

export async function uploadLogo(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;

    if (!req.file) {
      sendError(res, 'No image file provided', 400);
      return;
    }

    const ext = path.extname(req.file.originalname || '').toLowerCase();
    const uniqueFilename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    const logoUrl = await uploadImage(req.file.buffer, 'logos', uniqueFilename);

    const updated = await updateTenant(tenantId, { logo_url: logoUrl });
    if (!updated) {
      sendError(res, 'Business not found', 404);
      return;
    }

    sendSuccess(res, { logo_url: logoUrl }, 'Logo uploaded successfully');
  } catch (err) {
    sendError(res, 'Failed to upload logo', 500, err);
  }
}
