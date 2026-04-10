import type { Request, Response } from 'express';
import { listContactsAggregatedForTenant, updateContactForTenant } from '../db/models/contact';
import { getContactDetailForTenant } from '../services/contactService';
import { sendError, sendPaginated, sendSuccess } from '../utils/response';
import type { ContactListQuery, ContactShowQuery, UpdateContactBody } from '../validators/contact';

export async function index(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const query = (req.validated?.query ?? req.query) as unknown as ContactListQuery;

    const { rows, total } = await listContactsAggregatedForTenant({
      tenantId,
      search: query.search,
      page: query.page,
      limit: query.limit,
      sortBy: query.sort,
      sortDir: query.sort_dir,
    });

    sendPaginated(res, rows, query.page, query.limit, total, 'Contacts retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve contacts', 500, err);
  }
}

export async function show(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { id } = (req.validated?.params ?? req.params) as { id: string };
    const query = (req.validated?.query ?? req.query) as unknown as ContactShowQuery;

    const detail = await getContactDetailForTenant({
      contactId: id,
      tenantId,
      conversationsPage: query.conversations_page,
      conversationsLimit: query.conversations_limit,
      ordersPage: query.orders_page,
      ordersLimit: query.orders_limit,
      messagesPerConversation: query.messages_limit,
    });

    if (!detail) {
      sendError(res, 'Contact not found', 404);
      return;
    }

    const {
      contact,
      conversations,
      conversationsTotal,
      orders,
      ordersTotal,
    } = detail;

    sendSuccess(
      res,
      {
        contact,
        conversations: {
          data: conversations,
          pagination: {
            page: query.conversations_page,
            limit: query.conversations_limit,
            total: conversationsTotal,
            totalPages: Math.ceil(conversationsTotal / query.conversations_limit),
          },
        },
        orders: {
          data: orders,
          pagination: {
            page: query.orders_page,
            limit: query.orders_limit,
            total: ordersTotal,
            totalPages: Math.ceil(ordersTotal / query.orders_limit),
          },
        },
      },
      'Contact retrieved successfully',
    );
  } catch (err) {
    sendError(res, 'Failed to retrieve contact', 500, err);
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { id } = (req.validated?.params ?? req.params) as { id: string };
    const body = req.body as UpdateContactBody;

    const fields: { name?: string; notes?: string | null } = {};
    if (body.name !== undefined) fields.name = body.name;
    if (body.notes !== undefined) fields.notes = body.notes;

    const contact = await updateContactForTenant(id, tenantId, fields);
    if (!contact) {
      sendError(res, 'Contact not found', 404);
      return;
    }

    sendSuccess(res, { contact }, 'Contact updated successfully');
  } catch (err) {
    sendError(res, 'Failed to update contact', 500, err);
  }
}
