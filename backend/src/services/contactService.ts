import {
  findContactByIdForTenant,
  type Contact,
} from '../db/models/contact';
import { listConversationsForContactForTenant } from '../db/models/conversation';
import { listRecentMessagesChronologicalForConversation } from '../db/models/message';
import { listOrdersForContactForTenant } from '../db/models/order';
import type { ConversationWithChannel } from '../db/models/conversation';
import type { Message } from '../db/models/message';
import type { OrderWithChannelType } from '../db/models/order';

export interface ConversationWithMessages extends ConversationWithChannel {
  messages: Message[];
}

export interface ContactDetailResult {
  contact: Contact;
  conversations: ConversationWithMessages[];
  conversationsTotal: number;
  orders: OrderWithChannelType[];
  ordersTotal: number;
}

export async function getContactDetailForTenant(params: {
  contactId: string;
  tenantId: string;
  conversationsPage: number;
  conversationsLimit: number;
  ordersPage: number;
  ordersLimit: number;
  messagesPerConversation: number;
}): Promise<ContactDetailResult | null> {
  const {
    contactId,
    tenantId,
    conversationsPage,
    conversationsLimit,
    ordersPage,
    ordersLimit,
    messagesPerConversation,
  } = params;

  const contact = await findContactByIdForTenant(contactId, tenantId);
  if (!contact) return null;

  const [{ rows: convRows, total: conversationsTotal }, { orders, total: ordersTotal }] =
    await Promise.all([
      listConversationsForContactForTenant(
        contactId,
        tenantId,
        conversationsPage,
        conversationsLimit,
      ),
      listOrdersForContactForTenant(contactId, tenantId, ordersPage, ordersLimit),
    ]);

  const messagesLists = await Promise.all(
    convRows.map((c) =>
      listRecentMessagesChronologicalForConversation(
        c.id,
        tenantId,
        messagesPerConversation,
      ),
    ),
  );

  const conversations: ConversationWithMessages[] = convRows.map((c, i) => ({
    ...c,
    messages: messagesLists[i]!,
  }));

  return {
    contact,
    conversations,
    conversationsTotal,
    orders,
    ordersTotal,
  };
}
