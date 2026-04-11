import type { Request, Response } from 'express';
import {
  findOrderWithRelationsForTenant,
  listOrdersForTenant,
  updateDraftOrderForTenant,
  updateOrderStatusForTenant,
  findOrderByIdForTenant,
} from '../db/models/order';
import { sendSuccess, sendError, sendPaginated } from '../utils/response';
import { logEvent } from '../services/analyticsService';
import type { OrderListQuery, UpdateDraftOrderBody } from '../validators/order';

export async function index(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const query = (req.validated?.query ?? req.query) as unknown as OrderListQuery;

    const { orders, total } = await listOrdersForTenant({
      tenantId,
      status: query.status,
      conversationId: query.conversation_id,
      search: query.search,
      createdFrom: query.created_from,
      createdTo: query.created_to,
      page: query.page,
      limit: query.limit,
      sortBy: query.sort,
      sortDir: query.sort_dir,
    });

    sendPaginated(res, orders, query.page, query.limit, total, 'Orders retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve orders', 500, err);
  }
}

export async function show(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { id } = (req.validated?.params ?? req.params) as { id: string };

    const order = await findOrderWithRelationsForTenant(id, tenantId);
    if (!order) {
      sendError(res, 'Order not found', 404);
      return;
    }

    sendSuccess(res, { order }, 'Order retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve order', 500, err);
  }
}

export async function confirm(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { id } = (req.validated?.params ?? req.params) as { id: string };

    const existing = await findOrderByIdForTenant(id, tenantId);
    if (!existing) {
      sendError(res, 'Order not found', 404);
      return;
    }

    if (existing.status === 'cancelled') {
      sendError(res, 'Cannot confirm a cancelled order', 400);
      return;
    }

    if (existing.status === 'confirmed') {
      sendSuccess(res, { order: existing }, 'Order already confirmed');
      return;
    }

    const order = await updateOrderStatusForTenant(id, tenantId, 'confirmed');
    if (!order) {
      sendError(res, 'Order not found', 404);
      return;
    }

    void logEvent(tenantId, 'order_confirmed', { order_id: order.id });

    sendSuccess(res, { order }, 'Order confirmed successfully');
  } catch (err) {
    sendError(res, 'Failed to confirm order', 500, err);
  }
}

export async function cancel(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { id } = (req.validated?.params ?? req.params) as { id: string };

    const existing = await findOrderByIdForTenant(id, tenantId);
    if (!existing) {
      sendError(res, 'Order not found', 404);
      return;
    }

    if (existing.status === 'cancelled') {
      sendSuccess(res, { order: existing }, 'Order already cancelled');
      return;
    }

    const order = await updateOrderStatusForTenant(id, tenantId, 'cancelled');
    if (!order) {
      sendError(res, 'Order not found', 404);
      return;
    }

    sendSuccess(res, { order }, 'Order cancelled successfully');
  } catch (err) {
    sendError(res, 'Failed to cancel order', 500, err);
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { id } = (req.validated?.params ?? req.params) as { id: string };
    const body = req.body as UpdateDraftOrderBody;

    const existing = await findOrderByIdForTenant(id, tenantId);
    if (!existing) {
      sendError(res, 'Order not found', 404);
      return;
    }

    if (existing.status !== 'draft') {
      sendError(res, 'Only draft orders can be edited', 400);
      return;
    }

    const fields: {
      quantity?: number;
      delivery_address?: string | null;
      notes?: string | null;
    } = {};
    if (body.quantity !== undefined) fields.quantity = body.quantity;
    if (body.delivery_address !== undefined) fields.delivery_address = body.delivery_address;
    if (body.notes !== undefined) fields.notes = body.notes;

    const order = await updateDraftOrderForTenant(id, tenantId, fields);
    if (!order) {
      sendError(res, 'Order not found or not editable', 404);
      return;
    }

    sendSuccess(res, { order }, 'Order updated successfully');
  } catch (err) {
    sendError(res, 'Failed to update order', 500, err);
  }
}
