import crypto from 'crypto';
import pool from '../db/pool';
import { redisConnection } from './redisConnection';
import { findChannelById } from '../db/models/channel';
import {
  findConversationById,
  setConversationAiPaused,
  setConversationHumanReplied,
  touchConversationLastMessageAt,
} from '../db/models/conversation';
import { findContactById } from '../db/models/contact';
import { findTenantById, type DeliveryTime } from '../db/models/tenant';
import {
  createMessage,
  findMessagesByConversation,
  type Message,
  updateMessageSendFailure,
} from '../db/models/message';
import { createAIAlert, type AIAlert } from '../db/models/aiAlert';
import {
  createOrder,
  findLatestActiveOrderForConversation,
  findLatestOpenOrderForContactForEscalation,
  markOrderCancellationRequested,
  markOrderRefundRequested,
  updateOrderCustomerInfoForAI,
  type UpdateOrderCustomerInfoInput,
} from '../db/models/order';
import { findActiveProductNamesForTenant } from '../db/models/product';
import { resolveOrderProduct } from '../services/orderProductResolutionService';
import { findAIConfigByTenant } from '../db/models/aiConfig';
import {
  classifyNegativeAvailabilityReply,
  classifyNewOrderSignal,
  classifyOrderClosingQuestionReplyIntent,
  classifyOrderDetailsCollectionReplyIntent,
  classifyOrderConfirmationReplyIntent,
  classifyUsageQuestionIntent,
  containsSpeculativeHealthAdvice,
  detectCancellationOrRefundIntent,
  detectOrderAffirmationIntent,
  detectOrderInfoUpdateIntent,
  detectPostPurchaseSupportIntent,
  detectWrongProductIntent,
  detectReplyLanguage,
  generateReply,
  isOutOfStockProductReply,
  isUsageQuestionUnanswered,
  type ReplyLocale,
} from '../services/aiService';
import { extractCustomerNameFromMessages } from '../services/orderCustomerDetails';
import {
  buildOrderConfirmationDeliveryLine,
  ensureOrderConfirmationDeliveryAndFollowUp,
} from '../services/orderConfirmationFormatting';
import { sanitizeOutboundMessageText } from '../services/outboundMessageFormatting';
import {
  buildProductKnowledgeContext,
  detectRequestedAttributes,
  getProductStructuredAttributes,
} from '../services/productRetrievalService';
import { getProductImageDerivedContext } from '../services/productImageAttributeService';
import { assessProductInformationRequest } from '../services/productInformationGapService';
import {
  buildMissingInfoHoldingMessage,
  composePartialAnswer,
  computeMissingStructuredAttributes,
  dedupeInfoLabels,
  deriveAnswerabilityStatus,
  localizedAttributeLabels,
} from '../services/productInformationGapHelpers';
import {
  evaluateReply,
  evaluationTriggersAlert,
  getQualityThreshold,
  resolveStoredFlagReason,
} from '../services/aiQualityService';
import { createFeedbackLog } from '../db/models/feedbackLog';
import { detect } from '../services/intentDetectionService';
import { sendMessage } from '../services/channelSenderService';
import { socketService } from '../services/socketService';
import { logEvent } from '../services/analyticsService';
import { getHumanHoldMinutes } from '../services/conversationService';
import { aiQueue } from './queues';

export interface AIReplyJobData {
  tenantId: string;
  channelId: string;
  conversationId: string;
  messageExternalId: string;
  /** Correlation ID from the originating webhook — see InboundWebhookJobData.traceId. */
  traceId?: string;
}

function normalizeLooseText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeVerbatimComparison(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics so AI accent-correction doesn't break the match
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function logJsonStringOrNull(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value);
}

function normalizeEscalationMessage(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractPhoneNumberCandidate(text: string): string | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  // Capture phone-like sequences that include digits, spaces, dashes, parentheses and optional leading '+'.
  const candidates = raw.match(/\+?\d[\d\s().-]{5,}\d/g) ?? [];
  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, b) => (b.length > a.length ? b : a));
  const hasPlus = best.trim().startsWith('+');
  const digits = best.replace(/[^\d]/g, '');

  if (digits.length < 7 || digits.length > 15) return null;
  return hasPlus ? `+${digits}` : digits;
}

function extractPhoneNumberFromMessages(
  messages: Array<{ sent_by: string; content: string | null }>,
): string | null {
  // Prefer the latest customer-provided phone number in recent messages.
  const recent = [...messages].reverse();
  for (const msg of recent) {
    if (msg.sent_by !== 'customer') continue;
    const phone = extractPhoneNumberCandidate(msg.content ?? '');
    if (phone) return phone;
  }
  return null;
}

function isFallbackContactLabel(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (trimmed.toLowerCase() === 'unknown') return true;
  if (/^ig user \d+$/i.test(trimmed)) return true;
  return /^messenger user \d+$/i.test(trimmed);
}

function readMetaString(meta: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Returns true when a candidate first name extracted by the intent LLM (or from contact
 * metadata) looks like a city name, street keyword, or address fragment rather than a
 * person's name.  These can slip through when the LLM misreads the first line of a
 * multi-line address submission (e.g. "Prishtina\n049…\nRruga…") as the customer name.
 */
function looksLikeAddressWord(candidate: string): boolean {
  const norm = candidate
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (!norm) return false;
  // Known Albanian / Kosovar city names and address keywords that the intent LLM
  // frequently misidentifies as first names when they appear on the first line.
  return /\b(prishtin|prizren|peje|gjakove|gjakova|ferizaj|mitrovic|mitrovica|lipjan|gjilan|vushtrri|skenderaj|malishev|rahovec|suhareke|decan|istog|klina|drenas|podujeve|fushe|kosov|tirane|tirana|shkoder|durres|vlore|elbasan|korce|adres|address|rrug|street|banes|bllok|lagja|zona|qyteti)\b/.test(
    norm,
  );
}

function resolveCustomerNameForOrder(args: {
  customerFirstNameFromIntent: string | null;
  contactName: string;
  contactMetadata: Record<string, unknown>;
  conversationMessages: Array<Pick<Message, 'sent_by' | 'content'>>;
}): { firstName: string | null; fullName: string | null } {
  const meta = args.contactMetadata ?? {};

  // Intent LLM extraction — highest priority, but validate it is not an address word.
  let firstName = args.customerFirstNameFromIntent?.trim() || null;
  if (firstName && looksLikeAddressWord(firstName)) {
    console.info(
      '[resolveCustomerNameForOrder] Discarding intent-extracted name that looks like an address word',
      { candidate: firstName },
    );
    firstName = null;
  }

  if (!firstName) {
    firstName = readMetaString(meta, ['first_name', 'firstName', 'given_name']);
  }

  if (!firstName) {
    const fromMessages = extractCustomerNameFromMessages(args.conversationMessages);
    firstName = fromMessages.firstName;
  }

  if (!firstName) {
    const contactName = args.contactName.trim();
    if (contactName && !isFallbackContactLabel(contactName)) {
      const parts = contactName.split(/\s+/).filter((part) => part.length > 0);
      if (parts.length >= 1) {
        firstName = parts[0];
      }
    }
  }

  const fullName = firstName ? firstName.trim() : null;
  return { firstName, fullName };
}

function normalizeQuestionForSimilarity(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeQuestionForSimilarity(value)
      .split(' ')
      .filter((token) => token.length > 2),
  );
}

function areLikelyDuplicateQuestions(a: string, b: string): boolean {
  const normalizedA = normalizeQuestionForSimilarity(a);
  const normalizedB = normalizeQuestionForSimilarity(b);
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;

  const minLen = Math.min(normalizedA.length, normalizedB.length);
  if (
    minLen >= 12 &&
    (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA))
  ) {
    return true;
  }

  const tokensA = tokenSet(normalizedA);
  const tokensB = tokenSet(normalizedB);
  if (tokensA.size === 0 || tokensB.size === 0) return false;

  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap += 1;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = union === 0 ? 0 : overlap / union;
  return jaccard >= 0.82;
}

function buildInboundBurstContext(recentMessages: Message[]): {
  latestInbound: Message | null;
  mergedInboundText: string;
  mergedAttachmentUrls: string[];
} {
  const reversed = [...recentMessages].reverse();
  const latestInbound = reversed.find((msg) => msg.direction === 'inbound') ?? null;
  if (!latestInbound) {
    return { latestInbound: null, mergedInboundText: '', mergedAttachmentUrls: [] };
  }

  const latestOutboundIndex = reversed.findIndex((msg) => msg.direction === 'outbound');
  const burstSource = reversed
    .slice(0, latestOutboundIndex >= 0 ? latestOutboundIndex : reversed.length)
    .filter((msg) => msg.direction === 'inbound')
    .reverse()
    .slice(-5);

  const uniqueQuestions: string[] = [];
  for (const msg of burstSource) {
    const text = (msg.content ?? '').trim();
    if (!text) continue;
    const alreadyIncluded = uniqueQuestions.some((existing) =>
      areLikelyDuplicateQuestions(existing, text),
    );
    if (!alreadyIncluded) {
      uniqueQuestions.push(text);
    }
  }

  const mergedInboundText =
    uniqueQuestions.length > 0
      ? uniqueQuestions.join('\n')
      : (latestInbound.content ?? '').trim();
  const mergedAttachmentUrls = burstSource.flatMap((msg) =>
    Array.isArray(msg.attachment_urls)
      ? msg.attachment_urls.filter((u): u is string => typeof u === 'string' && u.length > 0)
      : [],
  );

  return { latestInbound, mergedInboundText, mergedAttachmentUrls };
}

type AutomatedReplyPrecheck =
  | { ok: true }
  | { ok: false; reason: string; logPayload?: Record<string, unknown> };

/**
 * Re-validates tenant/channel/conversation AI gates and that no superseding inbound or human
 * takeover occurred since the job was queued. Call immediately before any channel send in this job.
 */
async function shouldStillSendAutomatedReply(args: {
  tenantId: string;
  channelId: string;
  conversationId: string;
  scheduledInboundExternalId: string;
}): Promise<AutomatedReplyPrecheck> {
  const { tenantId, channelId, conversationId, scheduledInboundExternalId } = args;

  const aiConfig = await findAIConfigByTenant(tenantId);
  if (!aiConfig?.is_active) {
    return { ok: false, reason: 'ai_globally_disabled' };
  }

  const channel = await findChannelById(channelId, tenantId);
  if (!channel) {
    return { ok: false, reason: 'channel_not_found' };
  }
  if (!channel.ai_enabled) {
    return { ok: false, reason: 'ai_disabled_for_channel' };
  }

  const conversation = await findConversationById(conversationId);
  if (!conversation) {
    return { ok: false, reason: 'conversation_not_found' };
  }
  if (conversation.ai_paused) {
    return { ok: false, reason: 'ai_paused' };
  }
  if (conversation.human_override_until && new Date(conversation.human_override_until) > new Date()) {
    return {
      ok: false,
      reason: 'human_override_active',
      logPayload: { until: conversation.human_override_until },
    };
  }

  const latestMessages = await findMessagesByConversation(conversationId, 8);
  const latestInbound = [...latestMessages].reverse().find((msg) => msg.direction === 'inbound');
  if (!latestInbound || latestInbound.external_message_id !== scheduledInboundExternalId) {
    return {
      ok: false,
      reason: 'newer_inbound',
      logPayload: latestInbound
        ? { scheduledFor: scheduledInboundExternalId, latestInboundExternalId: latestInbound.external_message_id }
        : { scheduledFor: scheduledInboundExternalId },
    };
  }

  const { rows: humanRows } = await pool.query<{ has_human_outbound: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM messages
       WHERE conversation_id = $1 AND tenant_id = $2
         AND direction = 'outbound'
         AND sent_by = 'human'
         AND created_at > $3
     ) AS has_human_outbound`,
    [conversationId, tenantId, latestInbound.created_at],
  );
  if (humanRows[0]?.has_human_outbound) {
    return { ok: false, reason: 'human_outbound_after_inbound' };
  }

  return { ok: true };
}

/** Extra delay added past the human-hold expiry so the rescheduled job never races the hold. */
const HUMAN_HOLD_RESCHEDULE_BUFFER_MS = 5_000;

/**
 * The human hold now auto-releases after a short window (see getHumanHoldMinutes). When an
 * ai.reply job lands while the hold is still active, we re-enqueue the same job to run just
 * after the hold expires so customer messages sent during the hold still get an AI reply —
 * but only when:
 *  - the hold is within the expected auto-release window (anomalously long holds keep the
 *    old skip behaviour),
 *  - this job is still the one scheduled for the latest inbound message (a newer inbound
 *    has its own job), and
 *  - the human has not already answered that latest inbound message.
 */
async function rescheduleReplyAfterHumanHold(
  data: AIReplyJobData,
  holdUntil: Date,
): Promise<void> {
  const { tenantId, conversationId } = data;
  const remainingMs = holdUntil.getTime() - Date.now();
  if (remainingMs <= 0) return;

  const maxRescheduleMs = getHumanHoldMinutes() * 60_000 + 60_000;
  if (remainingMs > maxRescheduleMs) {
    console.info('[ai.reply] Human hold exceeds auto-release window, not rescheduling', {
      conversationId,
      holdUntil,
    });
    return;
  }

  const latestMessages = await findMessagesByConversation(conversationId, 8);
  const latestInbound = [...latestMessages].reverse().find((msg) => msg.direction === 'inbound');
  if (!latestInbound || latestInbound.external_message_id !== data.messageExternalId) {
    // A newer inbound message exists; its own ai.reply job will handle the conversation.
    return;
  }

  const { rows } = await pool.query<{ has_human_outbound: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM messages
       WHERE conversation_id = $1 AND tenant_id = $2
         AND direction = 'outbound'
         AND sent_by = 'human'
         AND created_at > $3
     ) AS has_human_outbound`,
    [conversationId, tenantId, latestInbound.created_at],
  );
  if (rows[0]?.has_human_outbound) {
    // The human already answered the latest customer message — nothing for AI to do.
    return;
  }

  const delay = remainingMs + HUMAN_HOLD_RESCHEDULE_BUFFER_MS;
  await aiQueue.add('ai.reply', data, { delay });
  console.info('[ai.reply] Human hold active — rescheduled reply for after auto-release', {
    conversationId,
    holdUntil,
    delayMs: delay,
  });
}

/**
 * Hours of message inactivity that mark the start of a new conversation session.
 * Used only for the commission decision on AI-created orders.
 */
const COMMISSION_SESSION_GAP_HOURS = (() => {
  const parsed = Number(process.env.COMMISSION_SESSION_GAP_HOURS ?? '3');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
})();

/**
 * Decides whether a human agent participated in the conversation window that led to the
 * order being created right now.
 *
 * The window starts at the later of:
 *  - the start of the current message session (first message after a gap of
 *    COMMISSION_SESSION_GAP_HOURS or more), and
 *  - the creation of the previous order in this conversation (a new order implies a new
 *    engagement, even within the same session).
 *
 * This intentionally replaces the sticky `conversations.human_replied` flag for the
 * commission decision: a human reply in a past conversation/order must not permanently
 * disqualify future fully-AI-handled orders in the same chat thread.
 */
async function hasHumanParticipationInCurrentOrderWindow(
  conversationId: string,
  tenantId: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ human_in_window: boolean }>(
    `WITH recent_messages AS (
       SELECT created_at, direction, sent_by
       FROM messages
       WHERE conversation_id = $1
         AND tenant_id = $2
         AND created_at > NOW() - INTERVAL '30 days'
     ),
     gaps AS (
       SELECT created_at,
              LAG(created_at) OVER (ORDER BY created_at) AS prev_created_at
       FROM recent_messages
     ),
     session_start AS (
       SELECT COALESCE(MAX(created_at), NOW() - INTERVAL '30 days') AS started_at
       FROM gaps
       WHERE prev_created_at IS NULL
          OR created_at - prev_created_at > ($3::numeric * INTERVAL '1 hour')
     ),
     previous_order AS (
       SELECT MAX(created_at) AS last_order_at
       FROM orders
       WHERE conversation_id = $1 AND tenant_id = $2
     )
     SELECT EXISTS (
       SELECT 1
       FROM recent_messages m
       CROSS JOIN session_start s
       CROSS JOIN previous_order p
       WHERE m.direction = 'outbound'
         AND m.sent_by = 'human'
         AND m.created_at >= GREATEST(s.started_at, COALESCE(p.last_order_at, s.started_at))
     ) AS human_in_window`,
    [conversationId, tenantId, COMMISSION_SESSION_GAP_HOURS],
  );
  return rows[0]?.human_in_window === true;
}

function isUsageEscalationHoldingMessage(value: string): boolean {
  const normalized = normalizeEscalationMessage(value);
  const exactCandidates = [
    'pershendetje, se shpejti do t\'ju kontaktoje nje specialist lidhur me kete ceshtje.',
    'pershendetje, se shpejti do tju kontaktoje nje specialist lidhur me kete ceshtje.',
    normalizeEscalationMessage(HOLDING_MESSAGES.en.usageEscalation),
  ];
  if (exactCandidates.some((candidate) => normalized === normalizeEscalationMessage(candidate))) {
    return true;
  }

  const looksLikeAlbanianEscalation =
    normalized.includes('specialist') &&
    (normalized.includes('kontaktoje') || normalized.includes('kontaktoj')) &&
    (normalized.includes('se shpejti') || normalized.includes('shpejt')) &&
    normalized.includes('ceshtje');

  const looksLikeEnglishEscalation =
    normalized.includes('specialist') &&
    normalized.includes('contact') &&
    (normalized.includes('shortly') || normalized.includes('soon')) &&
    (normalized.includes('matter') || normalized.includes('issue') || normalized.includes('regarding'));

  return looksLikeAlbanianEscalation || looksLikeEnglishEscalation;
}

const HOLDING_MESSAGES: Record<
  ReplyLocale,
  {
    postPurchaseSupport: string;
    usageEscalation: string;
    productKnowledgeEscalation: string;
    orderInfoUpdated: string;
  }
> = {
  sq: {
    postPurchaseSupport:
      'Na vjen keq për problemin. Një anëtar i ekipit tonë do t’ju përgjigjet së shpejti.',
    usageEscalation:
      'Së shpejti do t’ju kontaktojë një specialist për këtë çështje.',
    productKnowledgeEscalation:
      'Së shpejti do t’ju kontaktojë një specialist me informacion të saktë për produktin.',
    orderInfoUpdated:
      'Informacioni i porosisë suaj u përditësua. Faleminderit!',
  },
  en: {
    postPurchaseSupport:
      'Sorry about the issue. A team member will get back to you shortly.',
    usageEscalation:
      'A specialist will contact you shortly about this matter.',
    productKnowledgeEscalation:
      'A product specialist will contact you shortly with accurate details.',
    orderInfoUpdated:
      'Your order info has been updated. Thank you!',
  },
};

const DELIVERY_TIME_LABEL_HOURS: Record<DeliveryTime, number> = {
  '24h': 24,
  '48h': 48,
  '72h': 72,
};

function buildDeliveryEtaReply(deliveryTime: DeliveryTime, locale: ReplyLocale): string {
  const hours = DELIVERY_TIME_LABEL_HOURS[deliveryTime];
  return locale === 'sq'
    ? `Porosia juaj do të mbërrijë brenda ${hours} orëve.`
    : `Your order will arrive within ${hours} hours.`;
}

type HoldingMessageLocale = ReplyLocale;
const ORDER_CONFIRMATION_FOLLOW_UP: Record<ReplyLocale, string> = {
  sq: 'Nëse keni pyetje të tjera ose doni të porosisni sërish, jam këtu për t’ju ndihmuar.',
  en: 'I’m here if you have other questions or want to order again.',
};

/**
 * Sent after all order details have been collected, asking the customer to verify
 * their name, phone, and address before the order is registered. Must match verbatim so
 * messageIsDataConfirmationRequest can identify it in conversation history.
 */
const DATA_CONFIRMATION_MESSAGES: Record<ReplyLocale, string> = {
  sq: 'Faleminderit për porosinë! A mund të konfirmoni që të dhënat që keni dhënë janë korrekte?',
  en: 'Thank you for your order! Please confirm the information you provided is correct.',
};

/**
 * Sent when the customer has provided phone and delivery address but has not yet given
 * their first name. Overrides any AI-generated reply (which might incorrectly confirm the
 * order) to ensure the name is explicitly collected before the data-confirmation step.
 */
const MISSING_CUSTOMER_NAME_MESSAGES: Record<ReplyLocale, string> = {
  sq: 'Faleminderit për të dhënat! Për të plotësuar porosinë, na tregoni edhe emrin tuaj.',
  en: 'Thanks for your details! To complete your order, please share your first name.',
};

/**
 * Distinctive, locale-specific lead-in for the variant-clarification question. Used both to
 * build the message and to detect (verbatim) whether we already asked it earlier in the
 * conversation, so we never loop on the same question.
 */
const VARIANT_CLARIFICATION_LEAD_IN: Record<ReplyLocale, string> = {
  sq: 'Për të shmangur ndonjë gabim, cilin nga këto produkte dëshironi të porosisni',
  en: 'To make sure I get your order right, which of these products would you like to order',
};

const MAX_VARIANT_OPTIONS_IN_CLARIFICATION = 6;

/**
 * Builds a question asking the customer to pick between similar product variants when their
 * selection could not be resolved to a single product. Listing the concrete candidate names
 * lets the next customer reply carry the distinguishing attribute (e.g. "50 servings").
 */
function buildVariantClarificationMessage(
  candidateNames: string[],
  locale: ReplyLocale,
): string {
  const options = candidateNames.slice(0, MAX_VARIANT_OPTIONS_IN_CLARIFICATION).join(', ');
  return `${VARIANT_CLARIFICATION_LEAD_IN[locale]}: ${options}?`;
}

function normalizeForIncludesCheck(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Strip apostrophe-like marks WITHOUT inserting whitespace so that
    // variants like "tju", "t'ju", and "t\u2019ju" all collapse to the
    // same token. Without this, the dedup check below would fail to
    // detect that the AI already added the order-confirmation follow-up
    // sentence, causing it to be appended a second time.
    .replace(/[\u0027\u02BC\u2018\u2019`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function messageLooksLikeOrderDetailsPayload(text: string): boolean {
  const raw = (text ?? '').trim();
  if (!raw) return false;

  const hasPhone = extractPhoneNumberCandidate(raw) !== null;
  if (!hasPhone) return false;

  const normalized = normalizeEscalationMessage(raw);
  const hasAddressKeywords =
    /\b(adres|address|rrug|street|banes|bllok|nr|number)\b/.test(normalized);
  const hasAddressLikeStructure =
    raw.includes(',') || /\b\d{1,4}\b/.test(raw) || normalized.length >= 20;
  return hasAddressKeywords || hasAddressLikeStructure;
}

function normalizeForOrderPromptMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s?]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function messageContainsOrderClosingAsk(value: string): boolean {
  const raw = (value ?? '').trim();
  if (!raw) return false;
  const normalized = normalizeForOrderPromptMatch(raw);
  if (!normalized) return false;

  const explicitPatterns = [
    /\b(a doni ta porosisni|deshironi ta porosisni|deshiron ta porositesh)\b/,
    /\b(doni ta porosisni|doni me porosit|doni me bo porosi)\b/,
    /\b(do you want to order|would you like to order)\b/,
  ];
  if (explicitPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const hasOrderKeyword = /\b(porosi|porosis|porosit|order)\b/.test(normalized);
  const hasQuestionMark = raw.includes('?');
  const hasQuestionCue = /\b(a|deshironi|doni|mund|would|do)\b/.test(normalized);
  return hasOrderKeyword && (hasQuestionMark || hasQuestionCue);
}

async function hasAssistantAskedOrderClosingInConversation(
  recentMessages: Message[],
): Promise<boolean> {
  const assistantMessages = recentMessages.filter((msg) => msg.sent_by !== 'customer');
  for (const msg of assistantMessages) {
    const content = (msg.content ?? '').trim();
    if (!content) continue;
    if (messageContainsOrderClosingAsk(content)) return true;
    if (await classifyOrderClosingQuestionReplyIntent(content)) return true;
  }
  return false;
}

/**
 * Returns true when the assistant message text looks like the data-confirmation request
 * we send after collecting name, phone, and address (before registering the order).
 */
function messageIsDataConfirmationRequest(text: string): boolean {
  if (!(text ?? '').trim()) return false;
  const normalized = normalizeForIncludesCheck(text);
  const genericAlbanianMatch =
    normalized.includes('konfirmoni') &&
    normalized.includes('te dhenat') &&
    normalized.includes('korrekte');
  const genericEnglishMatch =
    normalized.includes('confirm') &&
    normalized.includes('information') &&
    normalized.includes('provided') &&
    normalized.includes('correct');
  // Legacy wording that listed individual fields (still in older conversations).
  const legacyAlbanianMatch =
    normalized.includes('konfirmoni') &&
    (normalized.includes('telefon') || normalized.includes('numer')) &&
    normalized.includes('adres');
  const legacyEnglishMatch =
    normalized.includes('confirm') &&
    (normalized.includes('phone') || normalized.includes('number')) &&
    normalized.includes('address');
  return (
    genericAlbanianMatch ||
    genericEnglishMatch ||
    legacyAlbanianMatch ||
    legacyEnglishMatch
  );
}

/**
 * Returns true if any previous AI message in the conversation is a data-confirmation
 * request (asking the customer to verify their name, phone, and address before order creation).
 */
function hasAssistantAskedDataConfirmation(messages: Array<{ sent_by: string; content: string | null }>): boolean {
  return messages.some(
    (msg) => msg.sent_by !== 'customer' && messageIsDataConfirmationRequest(msg.content ?? ''),
  );
}

async function messageContainsOrderClosingAskHybrid(value: string): Promise<boolean> {
  const raw = (value ?? '').trim();
  if (!raw) return false;
  if (messageContainsOrderClosingAsk(raw)) return true;
  return classifyOrderClosingQuestionReplyIntent(raw);
}

async function stripRepeatedOrderClosingQuestion(
  replyText: string,
  orderClosingAlreadyAskedInConversation: boolean,
): Promise<string> {
  const reply = (replyText ?? '').trim();
  if (!reply) return reply;
  if (!orderClosingAlreadyAskedInConversation) return reply;
  if (!(await messageContainsOrderClosingAskHybrid(reply))) return reply;

  const sentenceLikeChunks = reply
    .split(/(?<=[.!?])\s+/u)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  if (sentenceLikeChunks.length > 1) {
    const cleanedChunks = sentenceLikeChunks.filter(
      (chunk) => !messageContainsOrderClosingAsk(chunk),
    );
    if (cleanedChunks.length > 0 && cleanedChunks.length < sentenceLikeChunks.length) {
      return cleanedChunks.join(' ').trim();
    }
  }

  const cleanedLines = reply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !messageContainsOrderClosingAsk(line))
    .filter((line) => line.length > 0);
  if (cleanedLines.length > 0) {
    return cleanedLines.join('\n').trim();
  }

  // Fallback: remove only trailing repeated order-closing questions from single-line replies.
  return reply
    .replace(
      /\s*(a\s+doni\s+t[aeë]\s+porosisni(?:\s+\p{L}+){0,5}\?)\s*$/iu,
      '',
    )
    .replace(
      /\s*((d[eë]shironi|doni|mund)\s+t[aeë]\s+porosisni(?:\s+\p{L}+){0,5}\?)\s*$/iu,
      '',
    )
    .replace(/\s*(do\s+you\s+want\s+to\s+order(?:\s+it)?\?)\s*$/iu, '')
    .trim();
}

// Generic follow-up invitations that are NOT explicit order-closing questions but still violate
// the strict no-follow-up policy in non-first / non-order-confirmation product replies — for
// example: "më tregoni", "më shkruani", "let me know", "feel free to ask".
const FOLLOW_UP_INVITATION_PATTERNS: RegExp[] = [
  // Albanian "më tregoni" (also catches "me tregoni" without diacritics).
  /(^|\s)(me|m)\s+tregon[ij]?(\s|$|[.,!?])/u,
  // Albanian "më shkruani" / "më shkruaj".
  /(^|\s)(me|m)\s+shkrua(j|ni|jeni)?(\s|$|[.,!?])/u,
  // Albanian "më kontaktoni" / "më kontakto".
  /(^|\s)(me|m)\s+kontakto(n[ij]?|j)?(\s|$|[.,!?])/u,
  // English variants.
  /\blet me know\b/u,
  /\bfeel free to (ask|reach|contact|message)\b/u,
  /\b(is there )?anything else\b/u,
  /\bif you (have|need|want).*(let me know|just ask|tell me)\b/u,
];

function sentenceContainsFollowUpInvitation(value: string): boolean {
  const raw = (value ?? '').trim();
  if (!raw) return false;
  const normalized = normalizeForOrderPromptMatch(raw);
  if (!normalized) return false;
  return FOLLOW_UP_INVITATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * When an order-closing question has already been asked earlier in the conversation and the
 * current reply is NOT an order-confirmation reply, strip any trailing generic follow-up
 * invitations the AI may have added (e.g., "Nëse dëshironi detaje më tregoni.").
 *
 * This is a safety net on top of the system-prompt rules in `aiService.buildSystemPrompt`.
 */
function stripGenericFollowUpInvitation(
  replyText: string,
  shouldStrip: boolean,
): string {
  const reply = (replyText ?? '').trim();
  if (!reply) return reply;
  if (!shouldStrip) return reply;
  if (!sentenceContainsFollowUpInvitation(reply)) return reply;

  const sentences = reply
    .split(/(?<=[.!?])\s+/u)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  if (sentences.length > 1) {
    const cleaned = sentences.filter((chunk) => !sentenceContainsFollowUpInvitation(chunk));
    if (cleaned.length > 0 && cleaned.length < sentences.length) {
      return cleaned.join(' ').trim();
    }
  }

  const cleanedLines = reply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !sentenceContainsFollowUpInvitation(line));
  if (cleanedLines.length > 0 && cleanedLines.length < reply.split(/\r?\n/).filter((l) => l.trim()).length) {
    return cleanedLines.join('\n').trim();
  }

  return reply;
}

/**
 * Falls back to a quick heuristic on the inbound text when no precomputed locale is available.
 * The full LLM detector lives in `aiService.detectReplyLanguage` and is used everywhere we have
 * conversation context (i.e. inside `generateReply`); the caller in this file passes that locale
 * along through `precomputed`. We keep this synchronous fallback for the very narrow case where
 * we only have raw inbound text and no async budget.
 */
function inferHoldingMessageLocale(
  text: string,
  precomputed?: ReplyLocale,
): HoldingMessageLocale {
  if (precomputed) return precomputed;
  const sample = (text ?? '').trim();
  if (!sample) return 'sq';

  if (/[ËëÇç]/.test(sample)) return 'sq';

  const normalized = sample
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const albanianMarkers = [
    'pershendetje', 'mirdita', 'naten e mire', 'faleminderit', 'flm', 'fln',
    'porosi', 'porosit', 'porosis', 'cmim', 'qmim', 'stok', 'produkt', 'produkti',
    'doni', 'deshironi', 'mund', 'kemi', 'kam', 'keni', 'jam', 'jeni', 'nuk',
    'gjendet', 'derges', 'adres', 'ju lutem', 'kalofshi', 'kalofsh',
  ];
  const englishMarkers = [
    'hello', 'hi there', 'hey', 'thanks', 'thank you', 'please', 'sorry',
    'how much', 'do you have', 'is this', 'are you', 'available', 'in stock',
    'shipping', 'delivery', 'address', 'order', 'product', 'price', 'discount',
  ];

  const albanianHits = albanianMarkers.filter((needle) => normalized.includes(needle)).length;
  const englishHits = englishMarkers.filter((needle) => normalized.includes(needle)).length;
  if (albanianHits >= 1 && albanianHits >= englishHits) return 'sq';
  if (englishHits >= 1 && englishHits > albanianHits) return 'en';
  return 'sq';
}

/** Per-locale fixed phrases the AI must never echo in the OPPOSITE locale. */
const FIXED_PHRASES_BY_LOCALE: Record<ReplyLocale, readonly string[]> = {
  sq: [
    HOLDING_MESSAGES.sq.postPurchaseSupport,
    HOLDING_MESSAGES.sq.usageEscalation,
    HOLDING_MESSAGES.sq.productKnowledgeEscalation,
    ORDER_CONFIRMATION_FOLLOW_UP.sq,
  ],
  en: [
    HOLDING_MESSAGES.en.postPurchaseSupport,
    HOLDING_MESSAGES.en.usageEscalation,
    HOLDING_MESSAGES.en.productKnowledgeEscalation,
    ORDER_CONFIRMATION_FOLLOW_UP.en,
    // Legacy English variants previously authored by the model — kept so we still strip them
    // when running in Albanian mode and the model accidentally falls back to old wording.
    "Hello, we're sorry for the issue. A member of our team will reply to you shortly.",
    'Hello, a specialist from our team will contact you shortly regarding this issue.',
    // Pre-shortening platform wording (see migration-era constants) — kept for the same reason.
    'Hello, we are sorry for the issue. A member of our team will get back to you shortly.',
    'Hello, a specialist from our team will contact you shortly regarding this matter.',
    'Hello, a product specialist from our team will contact you shortly with accurate product details.',
  ],
};

/**
 * When the AI accidentally leaks a fixed sentence in the WRONG language, drop those lines so the
 * downstream `ensureOrderConfirmationDeliveryAndFollowUp` step can append the correct one.
 */
function stripFixedPhrasesOfOtherLocale(text: string, locale: ReplyLocale): string {
  const otherLocale: ReplyLocale = locale === 'sq' ? 'en' : 'sq';
  const phrasesToStrip = FIXED_PHRASES_BY_LOCALE[otherLocale];
  if (phrasesToStrip.length === 0) return text;

  const phraseSet = new Set(phrasesToStrip.map((p) => normalizeForIncludesCheck(p)));
  const cleanedLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return true;
      const normalizedLine = normalizeForIncludesCheck(line.replace(/^[-*]\s*/, ''));
      return !phraseSet.has(normalizedLine);
    });

  return cleanedLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasPostPurchaseIssueCue(text: string): boolean {
  const normalized = normalizeEscalationMessage(text);
  if (!normalized) return false;
  return (
    /(kur|when).*(vjen|arrive|arrival|deliver|delivery|shipping)/.test(normalized) ||
    /(nuk me ka ardh|nuk ka ardh|nuk ka mberrit|still havent received|still haven't received|not delivered)/.test(normalized) ||
    /(produkt.*gabuar|artikull.*gabuar|gabuar.*produkt|gabuar.*artikull|wrong item|wrong product|wrong order|received.*wrong|got.*wrong|sent.*wrong|shipped.*wrong|wrong.*one|different.*product|different.*item|not what i ordered)/.test(normalized) ||
    /(tjeter.*produkt|produkt.*tjeter|tjeter.*artikull|artikull.*tjeter|derguat.*tjeter|derguan.*tjeter|erdhi.*tjeter|ka ardh.*tjeter|nuk eshte.*produkt|nuk eshte.*artikull)/.test(normalized) ||
    /(defekt|prish|problem me produkt|damaged|broken|faulty|defective)/.test(normalized)
  );
}

function hasDeliveryEtaOnlyCue(text: string): boolean {
  const normalized = normalizeEscalationMessage(text);
  if (!normalized) return false;

  const asksEta =
    /(kur|when).*(vjen|arrive|arrival|mberri|deliver|delivery|shipping)/.test(normalized) ||
    /(sa).*(kohe|ore|hours?).*(vjen|arrive|deliver|shipping)/.test(normalized);
  const mentionsOrderContext = /\b(order|porosi|porosia|paketa|paket)\b/.test(normalized);
  const mentionsProblemCue =
    /(nuk|ska|s'ka|still havent|still haven't|not delivered|vonesa|delay|problem|defekt|gabuar)/.test(
      normalized,
    );

  return asksEta && mentionsOrderContext && !mentionsProblemCue;
}

function looksLikeOrderAffirmation(text: string): boolean {
  const normalized = normalizeEscalationMessage(text);
  if (!normalized) return false;
  return (
    // Explicit short affirmations
    /^(po|ok|okej|yes|yep|sure|alright)\b/.test(normalized) ||
    // Direct order expressions: "dua ta porosis", "do order", "please order"
    /(dua|dush|do|doni|please|ju lutem).*(porosi|order)/.test(normalized) ||
    /(beje porosine|beje porosin|place the order|make the order)/.test(normalized) ||
    /^(po ju lutem|po beje|beje|ok beje)$/.test(normalized) ||
    // Question-form order intent: "can I order", "a mund ta porosis", "how do I order",
    // "i want to order", "want to order", "wish to order" — user is expressing ordering
    // intent even if phrased as a question or request.
    /(can|could|may|i want to|i'd like to|i would like to|wish to|how (do|can) i).*(order|porosi)/.test(normalized) ||
    /(a mund|mund ta|a mund ta).*(porosi|order)/.test(normalized) ||
    /(want|dua|dëshiroj|deshiroj).*(order|porosi)/.test(normalized) ||
    /(order|porosi).*(this|këtë|kete|product|produkt|it|ate)/.test(normalized)
  );
}

/** True when the customer message is only emoji / pictographs (no letters or digits). */
function isEmojiOnlyText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const withoutEmoji = t
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\s+/g, '');
  return withoutEmoji.length === 0;
}

// ---------------------------------------------------------------------------
// Per-tenant concurrent-job fairness guard
//
// Without this, one large tenant (flash sale, viral post) can flood the AI
// queue with hundreds of jobs. With AI_WORKER_CONCURRENCY=2 those jobs
// drain sequentially for minutes, completely starving all other tenants.
//
// This guard tracks how many AI reply jobs are actively running for each
// tenant using a Redis counter incremented on job start and decremented in
// a try/finally so it always returns to 0.  If a tenant already has
// AI_MAX_CONCURRENT_PER_TENANT jobs in flight, the current job re-delays
// itself (back into the BullMQ delayed set) for a short backoff and returns
// early — no work is lost, the job just waits its turn.
// ---------------------------------------------------------------------------
const AI_MAX_CONCURRENT_PER_TENANT = (() => {
  const n = parseInt(process.env.AI_MAX_CONCURRENT_PER_TENANT ?? '8', 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
})();
/** How long (ms) a job backs off before retrying when the tenant is at capacity. */
const AI_FAIRNESS_BACKOFF_MS = 3000;

// ---------------------------------------------------------------------------
// Atomic per-conversation rate-limit counter
//
// The old implementation used INCR + a separate EXPIRE: if the process
// crashed between those two commands the key had no TTL and the conversation
// was permanently locked (AI never replied again) until manual cleanup.
//
// This Lua script atomically increments the counter AND sets the TTL in a
// single Redis round-trip, with no window between the two operations.
// ---------------------------------------------------------------------------
const RATE_LIMIT_INCR_SCRIPT = `
local key   = KEYS[1]
local ttl   = tonumber(ARGV[1])
local count = redis.call('INCR', key)
if count == 1 then
  redis.call('EXPIRE', key, ttl)
end
return count
`;

export async function processAIReply(data: AIReplyJobData): Promise<void> {
  const { tenantId, channelId, conversationId, traceId } = data;
  console.info('[ai.reply] processAIReply start', { traceId, tenantId, conversationId });

  // ---- Per-tenant fairness ------------------------------------------------
  const tenantActiveKey = `ai_active_jobs:${tenantId}`;
  const activeCount = await redisConnection.incr(tenantActiveKey);
  // Safety TTL: if the process crashes mid-job the key will expire rather than
  // permanently blocking the tenant. 5 minutes >> any normal job duration.
  if (activeCount === 1) {
    await redisConnection.expire(tenantActiveKey, 300);
  }
  if (activeCount > AI_MAX_CONCURRENT_PER_TENANT) {
    // Decrement immediately — this job is not actually running yet.
    await redisConnection.decr(tenantActiveKey);
    // Re-delay into BullMQ. The job will be picked up once earlier jobs finish.
    await aiQueue.add(
      'ai.reply',
      data,
      {
        delay: AI_FAIRNESS_BACKOFF_MS,
        // Inherit the original jobId/dedup behaviour if present.
      },
    );
    console.info('[ai.reply] Tenant at concurrency limit — re-delayed job', {
      tenantId,
      conversationId,
      activeCount,
      maxAllowed: AI_MAX_CONCURRENT_PER_TENANT,
      backoffMs: AI_FAIRNESS_BACKOFF_MS,
    });
    return;
  }

  // Ensure the tenant counter is always decremented when this job finishes
  // (success, error, or early return). Without this, a crashed job permanently
  // reduces the tenant's available concurrency slot.
  let tenantSlotReleased = false;
  const releaseTenantSlot = async (): Promise<void> => {
    if (tenantSlotReleased) return;
    tenantSlotReleased = true;
    await redisConnection.decr(tenantActiveKey).catch(() => undefined);
  };

  try {

  // ---- Per-conversation rate limit (atomic) --------------------------------
  const parsedMax = parseInt(process.env.AI_MAX_REPLIES_PER_HOUR ?? '25', 10);
  const aiMaxRepliesPerHour =
    Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 25;
  const rateLimitKey = `ai_rate_limit:${conversationId}`;
  const rateCount = await redisConnection.eval(
    RATE_LIMIT_INCR_SCRIPT,
    1,
    rateLimitKey,
    '3600',
  ) as number;
  if (rateCount > aiMaxRepliesPerHour) {
    const client = await pool.connect();
    let alert: AIAlert | undefined;
    let messageContentForSocket: string | null = null;
    try {
      const { rows: msgRows } = await client.query<{ id: string; content: string | null }>(
        `SELECT id, content FROM messages
         WHERE conversation_id = $1 AND tenant_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [conversationId, tenantId],
      );
      const latestMessage = msgRows[0];
      await client.query('BEGIN');
      await setConversationAiPaused(conversationId, tenantId, true, client);
      if (latestMessage) {
        messageContentForSocket = latestMessage.content;
        alert = await createAIAlert(
          {
            tenant_id: tenantId,
            conversation_id: conversationId,
            message_id: latestMessage.id,
            reason: 'rate_limit_exceeded',
          },
          client,
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* no active transaction */
      }
      console.error('[ai.reply] Rate limit pause / alert failed', { conversationId, tenantId, err });
    } finally {
      client.release();
    }
    if (alert) {
      const channel = await findChannelById(channelId, tenantId);
      if (channel) {
        const conversation = await findConversationById(conversationId);
        const contactForAlert = conversation
          ? await findContactById(conversation.contact_id)
          : null;
        socketService.emitAIAlert(tenantId, {
          ...alert,
          message_content: messageContentForSocket,
          contact_name: contactForAlert?.name?.trim() || 'Customer',
          channel_type: channel.type,
          channel_name: channel.name,
        });
        socketService.emitConversationUpdated(tenantId, conversationId);
      }
    }
    console.warn('[ai.reply] AI rate limit exceeded for conversation', { conversationId, tenantId });
    return;
  }

  // Level 1: Global AI toggle
  const aiConfig = await findAIConfigByTenant(tenantId);
  if (!aiConfig?.is_active) {
    console.info('[ai.reply] AI globally disabled for tenant, skipping', { tenantId });
    return;
  }

  // Level 2: Per-channel toggle
  const channel = await findChannelById(channelId, tenantId);
  if (!channel) {
    console.warn('[ai.reply] Channel not found, skipping', { channelId, tenantId });
    return;
  }

  if (!channel.ai_enabled) {
    console.info('[ai.reply] AI disabled for channel, skipping', { channelId });
    return;
  }

  // Level 3: Per-conversation controls
  const conversation = await findConversationById(conversationId);
  if (!conversation) {
    console.warn('[ai.reply] Conversation not found, skipping', { conversationId });
    return;
  }

  if (conversation.ai_paused) {
    console.info('[ai.reply] AI paused for conversation, skipping', { conversationId });
    return;
  }

  if (conversation.human_override_until && new Date(conversation.human_override_until) > new Date()) {
    console.info('[ai.reply] Human override active, skipping', {
      conversationId,
      until: conversation.human_override_until,
    });
    // The hold auto-releases shortly; make sure the customer's latest message still gets a
    // reply afterwards instead of leaving the conversation silent.
    await rescheduleReplyAfterHumanHold(data, new Date(conversation.human_override_until));
    return;
  }

  const recentMessages = await findMessagesByConversation(conversationId, 25);
  const { latestInbound: lastInbound, mergedInboundText, mergedAttachmentUrls } =
    buildInboundBurstContext(recentMessages);
  if (!lastInbound) {
    console.info('[ai.reply] No inbound message found in conversation, skipping', { conversationId });
    return;
  }
  if (lastInbound.external_message_id !== data.messageExternalId) {
    console.info('[ai.reply] Skipping stale AI job because a newer inbound message exists', {
      conversationId,
      scheduledFor: data.messageExternalId,
      latestInboundExternalId: lastInbound.external_message_id,
    });
    return;
  }
  const inboundText = mergedInboundText.trim();
  if (inboundText.startsWith('Customer sent a reaction:')) {
    console.info('[ai.reply] Skipping automated reply for reaction-only inbound', { conversationId });
    return;
  }
  if (inboundText && isEmojiOnlyText(inboundText) && mergedAttachmentUrls.length === 0) {
    console.info('[ai.reply] Skipping automated reply for emoji-only inbound', { conversationId });
    return;
  }
  const attachmentUrls = mergedAttachmentUrls;

  if (!inboundText && attachmentUrls.length === 0) {
    console.info('[ai.reply] No text content or attachments in inbound message, skipping');
    return;
  }

  // Detect the conversation's reply language ONCE here and thread it through every canned-reply
  // path (cancellation/refund ack, post-purchase support, delivery ETA, AI generation,
  // post-processing strip helpers, and order-confirmation follow-up). This guarantees the entire
  // reply — including system-inserted lines — is in the same language as the customer's message.
  const replyLanguage = await detectReplyLanguage(inboundText, recentMessages);
  console.info(
    `[REPLY_LANGUAGE] tenantId: ${tenantId} conversationId: ${conversationId} language: ${replyLanguage} traceId: ${traceId ?? 'n/a'}`,
  );

  if (inboundText) {
    try {
      const cancellationRefundIntent = await detectCancellationOrRefundIntent(
        inboundText,
        recentMessages,
      );
      console.info(
        `[CANCEL/REFUND] tenantId: ${tenantId} conversationId: ${conversationId} is_cancel: ${cancellationRefundIntent.is_cancellation} is_refund: ${cancellationRefundIntent.is_refund} confidence: ${cancellationRefundIntent.confidence} reasoning: ${logJsonStringOrNull(cancellationRefundIntent.reason)}`,
      );
      const hasCancelOrRefundIntent =
        cancellationRefundIntent.is_cancellation || cancellationRefundIntent.is_refund;
      const confidentCancelOrRefund = cancellationRefundIntent.confidence > 0.8;

      if (hasCancelOrRefundIntent && confidentCancelOrRefund) {
        const candidateOrder = await findLatestOpenOrderForContactForEscalation(
          tenantId,
          conversation.contact_id,
        );

        // Fixed copy (not model-generated): same line as post-purchase holding message,
        // localized to the customer's current language.
        const ackText = HOLDING_MESSAGES[replyLanguage].postPurchaseSupport;

        const contactForSend = await findContactById(conversation.contact_id);
        let sendResult: Awaited<ReturnType<typeof sendMessage>> | null = null;
        const ackPrecheck = await shouldStillSendAutomatedReply({
          tenantId,
          channelId,
          conversationId,
          scheduledInboundExternalId: data.messageExternalId,
        });
        if (!ackPrecheck.ok) {
          console.info('[ai.reply] Skipping cancellation/refund ack send', {
            conversationId,
            scheduledFor: data.messageExternalId,
            reason: ackPrecheck.reason,
            ...ackPrecheck.logPayload,
          });
          return;
        }
        if (contactForSend) {
          sendResult = await sendMessage(channel, contactForSend.external_id, ackText);
        }

        const outboundAck = await createMessage({
          tenant_id: tenantId,
          conversation_id: conversationId,
          external_message_id: sendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
          direction: 'outbound',
          type: 'text',
          content: ackText,
          sent_by: 'ai',
        });

        const alerts: AIAlert[] = [];
        let escalatedOrder = candidateOrder;
        if (candidateOrder && cancellationRefundIntent.is_cancellation) {
          const updatedOrder = await markOrderCancellationRequested(
            candidateOrder.id,
            tenantId,
            cancellationRefundIntent.reason,
          );
          if (updatedOrder) escalatedOrder = updatedOrder;
        }
        if (candidateOrder && cancellationRefundIntent.is_refund) {
          const updatedOrder = await markOrderRefundRequested(
            candidateOrder.id,
            tenantId,
            cancellationRefundIntent.reason,
          );
          if (updatedOrder) escalatedOrder = updatedOrder;
        }
        if (cancellationRefundIntent.is_cancellation) {
          alerts.push(
            await createAIAlert({
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: lastInbound?.id ?? null,
              reason: 'cancellation_request',
            }),
          );
        }
        if (cancellationRefundIntent.is_refund) {
          alerts.push(
            await createAIAlert({
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: lastInbound?.id ?? null,
              reason: 'refund_request',
            }),
          );
        }

        await setConversationAiPaused(conversationId, tenantId, true);

        for (const alert of alerts) {
          socketService.emitAIAlert(tenantId, {
            ...alert,
            message_content: inboundText || null,
            contact_name: contactForSend?.name?.trim() || 'Customer',
            channel_type: channel.type,
            channel_name: channel.name,
          });
        }
        if (candidateOrder && escalatedOrder) {
          socketService.emitOrderActionRequired(tenantId, {
            order: escalatedOrder,
            reason: cancellationRefundIntent.reason,
          });
        }
        socketService.emitNewMessage(tenantId, outboundAck);
        socketService.emitConversationUpdated(tenantId, conversationId);

        if (!sendResult?.success && sendResult) {
          const errReason = sendResult.error ?? 'Failed to send acknowledgment';
          await updateMessageSendFailure(outboundAck.id, tenantId, 'failed', errReason);
          socketService.emitMessageSendFailed(tenantId, {
            messageId: outboundAck.id,
            conversationId,
            error: errReason,
          });
        }
        return;
      }

      const wrongProductIntent = await detectWrongProductIntent(inboundText, recentMessages);
      console.info(
        `[WRONG_PRODUCT] tenantId: ${tenantId} conversationId: ${conversationId} is_wrong_product: ${wrongProductIntent.is_wrong_product} confidence: ${wrongProductIntent.confidence} reasoning: ${logJsonStringOrNull(wrongProductIntent.reason)}`,
      );
      if (wrongProductIntent.is_wrong_product && wrongProductIntent.confidence > 0.8) {
        const wrongProductPrecheck = await shouldStillSendAutomatedReply({
          tenantId,
          channelId,
          conversationId,
          scheduledInboundExternalId: data.messageExternalId,
        });
        if (!wrongProductPrecheck.ok) {
          console.info('[ai.reply] Skipping wrong product holding message send', {
            conversationId,
            scheduledFor: data.messageExternalId,
            reason: wrongProductPrecheck.reason,
            ...wrongProductPrecheck.logPayload,
          });
          return;
        }

        const locale = inferHoldingMessageLocale(inboundText, replyLanguage);
        const wrongProductHoldingMessage = HOLDING_MESSAGES[locale].postPurchaseSupport;
        const client = await pool.connect();
        let alert: AIAlert | undefined;
        try {
          await client.query('BEGIN');
          await setConversationAiPaused(conversationId, tenantId, true, client);
          await setConversationHumanReplied(conversationId, tenantId, false, client);
          alert = await createAIAlert(
            {
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: lastInbound?.id ?? null,
              reason: 'post_purchase_support_request',
            },
            client,
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          console.error('[ai.reply] Wrong product escalation transaction failed', {
            conversationId,
            tenantId,
            err,
          });
        } finally {
          client.release();
        }

        const contactForSend = await findContactById(conversation.contact_id);
        let sendResult: Awaited<ReturnType<typeof sendMessage>> | null = null;
        if (contactForSend) {
          sendResult = await sendMessage(channel, contactForSend.external_id, wrongProductHoldingMessage);
        }

        const outboundAck = await createMessage({
          tenant_id: tenantId,
          conversation_id: conversationId,
          external_message_id: sendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
          direction: 'outbound',
          type: 'text',
          content: wrongProductHoldingMessage,
          sent_by: 'ai',
        });

        if (alert) {
          socketService.emitAIAlert(tenantId, {
            ...alert,
            message_content: inboundText || null,
            contact_name: contactForSend?.name?.trim() || 'Customer',
            channel_type: channel.type,
            channel_name: channel.name,
          });
        }
        socketService.emitNewMessage(tenantId, outboundAck);
        socketService.emitConversationUpdated(tenantId, conversationId);

        if (!sendResult?.success && sendResult) {
          const errReason = sendResult.error ?? 'Failed to send acknowledgment';
          await updateMessageSendFailure(outboundAck.id, tenantId, 'failed', errReason);
          socketService.emitMessageSendFailed(tenantId, {
            messageId: outboundAck.id,
            conversationId,
            error: errReason,
          });
        }
        return;
      }

      const isLikelyNewOrderSignal = await classifyNewOrderSignal(inboundText);
      const orderAffirmationIntent = await detectOrderAffirmationIntent(inboundText, recentMessages);
      const isLikelyOrderAffirmation =
        orderAffirmationIntent.is_order_affirmation && orderAffirmationIntent.confidence > 0.7;
      const shouldCheckPostPurchaseSupport =
        hasPostPurchaseIssueCue(inboundText) && !looksLikeOrderAffirmation(inboundText) && !isLikelyOrderAffirmation;
      const likelyDeliveryEtaOnlyByText = hasDeliveryEtaOnlyCue(inboundText);
      if (isLikelyNewOrderSignal) {
        console.info('[POST_PURCHASE_SUPPORT] skipped because message indicates new order intent', {
          conversationId,
          tenantId,
        });
      }
      if (isLikelyOrderAffirmation) {
        console.info(
          `[POST_PURCHASE_SUPPORT] skipped because message indicates order affirmation confidence: ${orderAffirmationIntent.confidence} reasoning: ${logJsonStringOrNull(orderAffirmationIntent.reason)}`,
        );
      }
      if (!shouldCheckPostPurchaseSupport || isLikelyNewOrderSignal) {
        console.info('[POST_PURCHASE_SUPPORT] skipped because no post-purchase issue cue found', {
          conversationId,
          tenantId,
          inboundText,
        });
      }
      const postPurchaseSupportIntent =
        shouldCheckPostPurchaseSupport && !isLikelyNewOrderSignal
          ? await detectPostPurchaseSupportIntent(inboundText, recentMessages)
          : {
              is_delivery_eta_query: false,
              is_not_delivered_complaint: false,
              is_wrong_product_issue: false,
              is_product_problem_issue: false,
              confidence: 0,
              reason: null as string | null,
            };
      const hasPostPurchaseSupportIntent =
        postPurchaseSupportIntent.is_delivery_eta_query ||
        postPurchaseSupportIntent.is_not_delivered_complaint ||
        postPurchaseSupportIntent.is_wrong_product_issue ||
        postPurchaseSupportIntent.is_product_problem_issue;
      const confidentPostPurchaseSupportIntent = postPurchaseSupportIntent.confidence > 0.8;
      console.info(
        `[POST_PURCHASE_SUPPORT] tenantId: ${tenantId} conversationId: ${conversationId} eta_query: ${postPurchaseSupportIntent.is_delivery_eta_query} not_delivered: ${postPurchaseSupportIntent.is_not_delivered_complaint} wrong_product: ${postPurchaseSupportIntent.is_wrong_product_issue} product_problem: ${postPurchaseSupportIntent.is_product_problem_issue} confidence: ${postPurchaseSupportIntent.confidence} reasoning: ${logJsonStringOrNull(postPurchaseSupportIntent.reason)}`,
      );

      // Auto-reply with the configured delivery time when the customer is only asking
      // about ETA (not a delay/issue complaint). The existing alert system for delays
      // and post-purchase issues below remains untouched.
      const isDeliveryEtaOnlyQuery =
        (postPurchaseSupportIntent.is_delivery_eta_query &&
          !postPurchaseSupportIntent.is_not_delivered_complaint &&
          !postPurchaseSupportIntent.is_wrong_product_issue &&
          !postPurchaseSupportIntent.is_product_problem_issue &&
          confidentPostPurchaseSupportIntent) ||
        likelyDeliveryEtaOnlyByText;

      if (isDeliveryEtaOnlyQuery) {
        const tenantForDelivery = await findTenantById(tenantId);
        const configuredDeliveryTime = tenantForDelivery?.delivery_time ?? null;
        if (configuredDeliveryTime) {
          const deliveryEtaReply = buildDeliveryEtaReply(configuredDeliveryTime, replyLanguage);
          const etaPrecheck = await shouldStillSendAutomatedReply({
            tenantId,
            channelId,
            conversationId,
            scheduledInboundExternalId: data.messageExternalId,
          });
          if (!etaPrecheck.ok) {
            console.info('[ai.reply] Skipping delivery ETA auto-reply send', {
              conversationId,
              scheduledFor: data.messageExternalId,
              reason: etaPrecheck.reason,
              ...etaPrecheck.logPayload,
            });
            return;
          }

          const contactForEtaSend = await findContactById(conversation.contact_id);
          let etaSendResult:
            | Awaited<ReturnType<typeof sendMessage>>
            | null = null;
          if (contactForEtaSend) {
            etaSendResult = await sendMessage(
              channel,
              contactForEtaSend.external_id,
              deliveryEtaReply,
            );
          }

          const outboundEta = await createMessage({
            tenant_id: tenantId,
            conversation_id: conversationId,
            external_message_id: etaSendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
            direction: 'outbound',
            type: 'text',
            content: deliveryEtaReply,
            sent_by: 'ai',
          });

          socketService.emitNewMessage(tenantId, outboundEta);
          socketService.emitConversationUpdated(tenantId, conversationId);

          if (!etaSendResult?.success && etaSendResult) {
            const errReason = etaSendResult.error ?? 'Failed to send delivery ETA reply';
            await updateMessageSendFailure(outboundEta.id, tenantId, 'failed', errReason);
            socketService.emitMessageSendFailed(tenantId, {
              messageId: outboundEta.id,
              conversationId,
              error: errReason,
            });
          }

          await touchConversationLastMessageAt(conversationId);
          console.info(
            `[DELIVERY_ETA_AUTO_REPLY] tenantId: ${tenantId} conversationId: ${conversationId} delivery_time: ${configuredDeliveryTime}`,
          );
          return;
        }

        console.info(
          `[DELIVERY_ETA_AUTO_REPLY] skipped because tenant has no delivery_time configured tenantId: ${tenantId} conversationId: ${conversationId}`,
        );
      }

      if (hasPostPurchaseSupportIntent && confidentPostPurchaseSupportIntent) {
        const postPurchasePrecheck = await shouldStillSendAutomatedReply({
          tenantId,
          channelId,
          conversationId,
          scheduledInboundExternalId: data.messageExternalId,
        });
        if (!postPurchasePrecheck.ok) {
          console.info('[ai.reply] Skipping post-purchase holding message send', {
            conversationId,
            scheduledFor: data.messageExternalId,
            reason: postPurchasePrecheck.reason,
            ...postPurchasePrecheck.logPayload,
          });
          return;
        }

        const locale = inferHoldingMessageLocale(inboundText, replyLanguage);
        const postPurchaseHoldingMessage = HOLDING_MESSAGES[locale].postPurchaseSupport;
        const client = await pool.connect();
        let alert: AIAlert | undefined;
        try {
          await client.query('BEGIN');
          await setConversationAiPaused(conversationId, tenantId, true, client);
          await setConversationHumanReplied(conversationId, tenantId, false, client);
          alert = await createAIAlert(
            {
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: lastInbound?.id ?? null,
              reason: 'post_purchase_support_request',
            },
            client,
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          console.error('[ai.reply] Post-purchase support escalation transaction failed', {
            conversationId,
            tenantId,
            err,
          });
        } finally {
          client.release();
        }

        const contactForSend = await findContactById(conversation.contact_id);
        let sendResult:
          | Awaited<ReturnType<typeof sendMessage>>
          | null = null;
        if (contactForSend) {
          sendResult = await sendMessage(
            channel,
            contactForSend.external_id,
            postPurchaseHoldingMessage,
          );
        }

        const outboundAck = await createMessage({
          tenant_id: tenantId,
          conversation_id: conversationId,
          external_message_id: sendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
          direction: 'outbound',
          type: 'text',
          content: postPurchaseHoldingMessage,
          sent_by: 'ai',
        });

        if (alert) {
          socketService.emitAIAlert(tenantId, {
            ...alert,
            message_content: inboundText || null,
            contact_name: contactForSend?.name?.trim() || 'Customer',
            channel_type: channel.type,
            channel_name: channel.name,
          });
        }
        socketService.emitNewMessage(tenantId, outboundAck);
        socketService.emitConversationUpdated(tenantId, conversationId);

        if (!sendResult?.success && sendResult) {
          const errReason = sendResult.error ?? 'Failed to send acknowledgment';
          await updateMessageSendFailure(outboundAck.id, tenantId, 'failed', errReason);
          socketService.emitMessageSendFailed(tenantId, {
            messageId: outboundAck.id,
            conversationId,
            error: errReason,
          });
        }
        return;
      }
      // ---- Order information update (customer correcting address / phone / name / notes) ----
      // Guards: skip if the message signals a new order or an order affirmation — those flows
      // must continue to generateReply so the data-confirmation message is sent and the order
      // creation logic at the tail of this function can fire.
      if (!isLikelyNewOrderSignal && !isLikelyOrderAffirmation) {
      const orderInfoUpdateIntent = await detectOrderInfoUpdateIntent(inboundText, recentMessages);
      console.info(
        `[ORDER_INFO_UPDATE] tenantId: ${tenantId} conversationId: ${conversationId} is_update: ${orderInfoUpdateIntent.is_order_info_update} confidence: ${orderInfoUpdateIntent.confidence} reason: ${logJsonStringOrNull(orderInfoUpdateIntent.reason)}`,
      );
      if (orderInfoUpdateIntent.is_order_info_update && orderInfoUpdateIntent.confidence > 0.82) {
        const extractedFields = orderInfoUpdateIntent.fields;
        const fieldsToUpdate: UpdateOrderCustomerInfoInput = {};
        if (extractedFields.delivery_address !== null) {
          fieldsToUpdate.delivery_address = extractedFields.delivery_address;
        }
        if (extractedFields.customer_name !== null) {
          fieldsToUpdate.customer_name = extractedFields.customer_name;
        }
        if (extractedFields.customer_phone !== null) {
          fieldsToUpdate.customer_phone = extractedFields.customer_phone;
        }
        if (extractedFields.notes !== null) {
          fieldsToUpdate.notes = extractedFields.notes;
        }

        if (Object.keys(fieldsToUpdate).length > 0) {
          // Use conversation-scoped lookup: only update an order that was created in
          // THIS conversation. Contact-level lookup would return orders from prior
          // conversations and incorrectly intercept first-time order data collection.
          const candidateOrder = await findLatestActiveOrderForConversation(
            tenantId,
            conversationId,
          );
          if (candidateOrder) {
            // Capture previous values for the audit trail before the update
            const previousValues: Record<string, unknown> = {};
            const newValues: Record<string, unknown> = {};
            for (const key of Object.keys(fieldsToUpdate) as (keyof UpdateOrderCustomerInfoInput)[]) {
              previousValues[key] = (candidateOrder as unknown as Record<string, unknown>)[key] ?? null;
              newValues[key] = fieldsToUpdate[key];
            }

            const updatedOrder = await updateOrderCustomerInfoForAI(
              candidateOrder.id,
              tenantId,
              fieldsToUpdate,
            );

            const orderInfoUpdatePrecheck = await shouldStillSendAutomatedReply({
              tenantId,
              channelId,
              conversationId,
              scheduledInboundExternalId: data.messageExternalId,
            });
            if (!orderInfoUpdatePrecheck.ok) {
              console.info('[ai.reply] Skipping order info update confirmation send', {
                conversationId,
                scheduledFor: data.messageExternalId,
                reason: orderInfoUpdatePrecheck.reason,
                ...orderInfoUpdatePrecheck.logPayload,
              });
              return;
            }

            const locale = inferHoldingMessageLocale(inboundText, replyLanguage);
            const confirmationText = HOLDING_MESSAGES[locale].orderInfoUpdated;
            const contactForSend = await findContactById(conversation.contact_id);
            let sendResult: Awaited<ReturnType<typeof sendMessage>> | null = null;
            if (contactForSend) {
              sendResult = await sendMessage(channel, contactForSend.external_id, confirmationText);
            }

            const outboundConfirm = await createMessage({
              tenant_id: tenantId,
              conversation_id: conversationId,
              external_message_id: sendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
              direction: 'outbound',
              type: 'text',
              content: confirmationText,
              sent_by: 'ai',
            });

            const alert = await createAIAlert({
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: lastInbound?.id ?? null,
              reason: 'order_info_updated',
              details: {
                order_id: candidateOrder.id,
                changed_fields: Object.keys(fieldsToUpdate),
                previous_values: previousValues,
                new_values: newValues,
              },
            });

            socketService.emitAIAlert(tenantId, {
              ...alert,
              message_content: inboundText || null,
              contact_name: contactForSend?.name?.trim() || 'Customer',
              channel_type: channel.type,
              channel_name: channel.name,
            });
            socketService.emitNewMessage(tenantId, outboundConfirm);
            socketService.emitConversationUpdated(tenantId, conversationId);
            if (updatedOrder) {
              socketService.emitOrderUpdated(tenantId, updatedOrder);
            }

            if (sendResult && !sendResult.success) {
              const errReason = sendResult.error ?? 'Failed to send order info update confirmation';
              await updateMessageSendFailure(outboundConfirm.id, tenantId, 'failed', errReason);
              socketService.emitMessageSendFailed(tenantId, {
                messageId: outboundConfirm.id,
                conversationId,
                error: errReason,
              });
            }

            console.info(`[ORDER_INFO_UPDATE] Updated order ${candidateOrder.id}`, {
              changedFields: Object.keys(fieldsToUpdate),
              tenantId,
              conversationId,
            });
            return;
          }

          console.info('[ORDER_INFO_UPDATE] No active order found in conversation, skipping update', {
            tenantId,
            conversationId,
          });
        }
      }
      } // end !isLikelyNewOrderSignal && !isLikelyOrderAffirmation guard
    } catch (err) {
      console.warn('[ai.reply] escalation detection path failed, continuing normal flow', {
        conversationId,
        tenantId,
        err,
      });
    }
  }

  const {
    reply: replyText,
    productCatalogContext,
    language: generatedLanguage,
    matchedProducts,
    attributeIntent,
    hadImages,
    productNotInCatalog: visionProductNotInCatalog,
  } = await generateReply(
      conversationId,
      tenantId,
      inboundText,
      attachmentUrls,
      undefined,
      replyLanguage,
    );

  if (replyText.trim() === '[NO_REPLY]') {
    return;
  }

  const replyLocale: ReplyLocale = generatedLanguage;

  const isOosCannedReply = isOutOfStockProductReply(replyText);

  // Use the products already found by generateReply — they are the exact same products
  // the AI used to build its answer, found via the same semantic+keyword search.
  // Re-running a separate search here would risk missing products referenced by nickname,
  // abbreviation, or follow-up pronoun (e.g. "kit produkt" / "this product").
  const usageCandidates = isOosCannedReply ? [] : matchedProducts;
  const usageTexts = usageCandidates
    .map((p) => p.usage_description?.trim())
    .filter((text): text is string => Boolean(text));
  const usageDescription = usageTexts.length > 0 ? usageTexts.join('\n---\n') : null;

  const usedVerbatimUsageDescription = usageDescription
    ? normalizeVerbatimComparison(replyText) === normalizeVerbatimComparison(usageDescription)
    : false;
  const usageQuestionIntent = inboundText
    ? await classifyUsageQuestionIntent(inboundText)
    : false;
  const usageRelated =
    Boolean(usageDescription) && (usageQuestionIntent || usedVerbatimUsageDescription);

  const usageHoldingMessage =
    HOLDING_MESSAGES[inferHoldingMessageLocale(inboundText, replyLocale)].usageEscalation;
  let finalReplyText = replyText;
  let usageEscalated = false;
  let usageQuestionUnanswered: boolean | null = null;

  if (usageRelated && usageDescription && !usedVerbatimUsageDescription) {
    try {
      const unanswered = await isUsageQuestionUnanswered(inboundText, usageDescription);
      usageQuestionUnanswered = unanswered;
      if (unanswered) {
        const client = await pool.connect();
        let alert: AIAlert | undefined;
        try {
          await client.query('BEGIN');
          await setConversationAiPaused(conversationId, tenantId, true, client);
          await setConversationHumanReplied(conversationId, tenantId, false, client);
          alert = await createAIAlert(
            {
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: lastInbound?.id ?? null,
              reason: 'usage_question_unanswered',
            },
            client,
          );
          await client.query('COMMIT');
          usageEscalated = true;
          finalReplyText = usageHoldingMessage;
        } catch (err) {
          await client.query('ROLLBACK');
          console.error('[ai.reply] Usage escalation transaction failed', { conversationId, tenantId, err });
        } finally {
          client.release();
        }

        if (alert) {
          const contactForAlert = await findContactById(conversation.contact_id);
          socketService.emitAIAlert(tenantId, {
            ...alert,
            message_content: inboundText || null,
            contact_name: contactForAlert?.name?.trim() || 'Customer',
            channel_type: channel.type,
            channel_name: channel.name,
          });
          socketService.emitConversationUpdated(tenantId, conversationId);
        }
      }
    } catch (err) {
      console.warn('[ai.reply] usage unanswered classifier failed, sending original reply', {
        conversationId,
        tenantId,
        err,
      });
    }
  }

  // Problem 2 safety net: customer asked a usage question but no usage_description
  // exists for the matched product (or no product was matched at all).
  // We must not let the AI answer from its general knowledge — escalate immediately.
  // Guard: skip when the intent classifier already identified this as a pure attribute
  // question (flavor, size, color, etc.) — those are answered from structured catalog
  // fields, not from usage_description, so missing usage text is expected and should
  // not trigger a usage escalation.
  if (!usageEscalated && usageQuestionIntent && !attributeIntent.is_attribute_question && !usageDescription && !isOosCannedReply) {
    const client = await pool.connect();
    let alert: AIAlert | undefined;
    try {
      await client.query('BEGIN');
      await setConversationAiPaused(conversationId, tenantId, true, client);
      await setConversationHumanReplied(conversationId, tenantId, false, client);
      alert = await createAIAlert(
        {
          tenant_id: tenantId,
          conversation_id: conversationId,
          message_id: lastInbound?.id ?? null,
          reason: 'usage_question_unanswered',
        },
        client,
      );
      await client.query('COMMIT');
      usageEscalated = true;
      finalReplyText = usageHoldingMessage;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[ai.reply] Usage escalation (no usage description) transaction failed', {
        conversationId,
        tenantId,
        err,
      });
    } finally {
      client.release();
    }

    if (alert) {
      const contactForAlert = await findContactById(conversation.contact_id);
      socketService.emitAIAlert(tenantId, {
        ...alert,
        message_content: inboundText || null,
        contact_name: contactForAlert?.name?.trim() || 'Customer',
        channel_type: channel.type,
        channel_name: channel.name,
      });
      socketService.emitConversationUpdated(tenantId, conversationId);
    }
  }

  if (!usageEscalated && isUsageEscalationHoldingMessage(finalReplyText)) {
    if (!usageQuestionIntent) {
      console.info('[ai.reply] Skipping usage escalation fallback because message is not a usage question', {
        conversationId,
        tenantId,
      });
    } else if (usageDescription && usageQuestionIntent) {
      if (usageQuestionUnanswered === null) {
        try {
          usageQuestionUnanswered = await isUsageQuestionUnanswered(inboundText, usageDescription);
        } catch (err) {
          console.warn('[ai.reply] usage unanswered classifier failed in fallback guard', {
            conversationId,
            tenantId,
            err,
          });
          usageQuestionUnanswered = false;
        }
      }

      if (usageQuestionUnanswered === false) {
        console.info('[ai.reply] Skipping usage escalation alert because usage description covers the question', {
          conversationId,
          tenantId,
        });
      } else {
        const client = await pool.connect();
        let alert: AIAlert | undefined;
        try {
          await client.query('BEGIN');
          await setConversationAiPaused(conversationId, tenantId, true, client);
          await setConversationHumanReplied(conversationId, tenantId, false, client);
          alert = await createAIAlert(
            {
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: lastInbound?.id ?? null,
              reason: 'usage_question_unanswered',
            },
            client,
          );
          await client.query('COMMIT');
          usageEscalated = true;
        } catch (err) {
          await client.query('ROLLBACK');
          console.error('[ai.reply] Usage escalation fallback transaction failed', {
            conversationId,
            tenantId,
            err,
          });
        } finally {
          client.release();
        }

        if (alert) {
          const contactForAlert = await findContactById(conversation.contact_id);
          socketService.emitAIAlert(tenantId, {
            ...alert,
            message_content: inboundText || null,
            contact_name: contactForAlert?.name?.trim() || 'Customer',
            channel_type: channel.type,
            channel_name: channel.name,
          });
          socketService.emitConversationUpdated(tenantId, conversationId);
        }
      }
    } else {
    const client = await pool.connect();
    let alert: AIAlert | undefined;
    try {
      await client.query('BEGIN');
      await setConversationAiPaused(conversationId, tenantId, true, client);
      await setConversationHumanReplied(conversationId, tenantId, false, client);
      alert = await createAIAlert(
        {
          tenant_id: tenantId,
          conversation_id: conversationId,
          message_id: lastInbound?.id ?? null,
          reason: 'usage_question_unanswered',
        },
        client,
      );
      await client.query('COMMIT');
      usageEscalated = true;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[ai.reply] Usage escalation fallback transaction failed', {
        conversationId,
        tenantId,
        err,
      });
    } finally {
      client.release();
    }

    if (alert) {
      const contactForAlert = await findContactById(conversation.contact_id);
      socketService.emitAIAlert(tenantId, {
        ...alert,
        message_content: inboundText || null,
        contact_name: contactForAlert?.name?.trim() || 'Customer',
        channel_type: channel.type,
        channel_name: channel.name,
      });
      socketService.emitConversationUpdated(tenantId, conversationId);
    }
    }
  }

  let productKnowledgeEscalated = false;

  // ---------------------------------------------------------------------------
  // PARTIAL PRODUCT ANSWER + attribute-level escalation
  //
  // When a customer asks about product information we now support THREE outcomes
  // instead of the previous all-or-nothing escalation:
  //   - complete : every requested detail is available  → send the AI reply as-is.
  //   - partial  : some details available, some missing → answer what we know AND
  //                append a "we'll notify you shortly" notice for the rest, then
  //                escalate ONLY the missing parts.
  //   - none     : nothing requested could be answered   → send a holding notice
  //                naming the missing info and escalate.
  //
  // Crucially, when a product HAS been identified we NEVER tell the customer it is
  // unavailable / not in the catalog — a missing attribute is a knowledge gap, not
  // a missing product. The "no matching products" branch below preserves the
  // existing guardrail (the AI asks the customer to clarify rather than escalating).
  // ---------------------------------------------------------------------------

  // Structured attributes the customer explicitly asked about (brand, flavor, size,
  // color, variant, weight, category). This also catches mixed "price + attribute"
  // questions that the price intent would otherwise suppress.
  const requestedStructuredAttributes = inboundText
    ? detectRequestedAttributes(inboundText, attributeIntent.attributes)
    : [];

  // A product-information question needs catalog facts: an explicit product-knowledge
  // / attribute intent, OR a detected structured attribute request. Pure price
  // questions ("how much is X") resolve to neither, so the AI's price answer is sent
  // untouched.
  const isProductInformationQuestion =
    Boolean(inboundText) &&
    (attributeIntent.is_product_knowledge_question || requestedStructuredAttributes.length > 0);

  if (!usageEscalated && isProductInformationQuestion && !isOosCannedReply) {
    if (hadImages) {
      // The vision pipeline inside generateReply already handled the photo query
      // (matched a product, asked for clarification, or stated we don't carry it).
      console.info('[ai.reply] Skipping product information gap handling — vision pipeline handled image query', {
        conversationId,
        tenantId,
        productNotInCatalog: visionProductNotInCatalog,
        matchedProductsCount: matchedProducts.length,
      });
    } else if (matchedProducts.length === 0) {
      // No product identified → do NOT escalate and do NOT claim the product is
      // missing. generateReply already instructed the model to ask the customer to
      // clarify. Product-not-found phrasing is reserved for genuinely missing products.
      console.info('[ai.reply] Skipping product information gap handling — no matching products', {
        conversationId,
        tenantId,
      });
    } else {
      // Build the knowledge a human/LLM can answer from: structured catalog facts plus
      // high-confidence packaging details read from the product's own images.
      let knowledgeContext = buildProductKnowledgeContext(matchedProducts);
      let imageUsableKeys = new Set<string>();
      try {
        const imageDerived = await getProductImageDerivedContext(tenantId, matchedProducts);
        if (imageDerived.block) {
          knowledgeContext += `\n\nVerified packaging details read from product images (treat as available, reliable catalog knowledge when answering):\n${imageDerived.block}`;
        }
        imageUsableKeys = new Set(imageDerived.usableKeys);
      } catch (err) {
        console.warn('[ai.reply] image-derived knowledge context failed', { conversationId, tenantId, err });
      }

      // Deterministic safety net: structured attributes that NO matched product can
      // provide (neither a catalog field nor a confident packaging read) are definitely
      // missing — independent of the LLM.
      const deterministicMissingKeys = computeMissingStructuredAttributes(
        requestedStructuredAttributes,
        matchedProducts.map((p) => getProductStructuredAttributes(p)),
        imageUsableKeys,
      );

      // LLM composer: grounded answer for what we know + labels for what we don't.
      const assessment = await assessProductInformationRequest(inboundText, knowledgeContext, {
        failClosed: true,
      });

      // Merge missing info: the LLM labels (customer language; covers free-form info
      // such as ingredients) unioned with the deterministic structured labels (a
      // guarantee we never silently drop a known-missing attribute), de-duplicated.
      const mergedMissing = dedupeInfoLabels([
        ...assessment.missing,
        ...localizedAttributeLabels(deterministicMissingKeys, replyLocale),
      ]);

      const status = deriveAnswerabilityStatus(assessment.answer, mergedMissing);

      // Escalate whenever the request is not fully answerable OR the assessment could
      // not be performed (fail-closed). A fully-answerable request keeps the original,
      // well-tuned AI reply untouched.
      const shouldEscalate = !assessment.ok || status !== 'complete';

      if (!shouldEscalate) {
        console.info('[ai.reply] Product information fully answerable — sending AI reply as-is', {
          conversationId,
          tenantId,
        });
      } else {
        // partial → keep known info + notice; none/failure → holding notice naming the
        // gap (or a generic notice when the gap could not be determined).
        const escalationReply =
          status === 'partial'
            ? composePartialAnswer(assessment.answer, mergedMissing, replyLocale)
            : buildMissingInfoHoldingMessage(mergedMissing, replyLocale);

        const client = await pool.connect();
        let alert: AIAlert | undefined;
        try {
          await client.query('BEGIN');
          await setConversationAiPaused(conversationId, tenantId, true, client);
          await setConversationHumanReplied(conversationId, tenantId, false, client);
          alert = await createAIAlert(
            {
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: lastInbound?.id ?? null,
              reason: 'product_question_unanswered',
              details: {
                kind: 'product_information_gap',
                partial: status === 'partial',
                missing_info: mergedMissing,
                requested_attributes: requestedStructuredAttributes,
                customer_question: inboundText,
                answered_info: status === 'partial' ? assessment.answer : null,
              },
            },
            client,
          );
          await client.query('COMMIT');
          productKnowledgeEscalated = true;
          finalReplyText = escalationReply;
        } catch (err) {
          await client.query('ROLLBACK');
          console.error('[ai.reply] Product information gap escalation transaction failed', {
            conversationId,
            tenantId,
            err,
          });
        } finally {
          client.release();
        }

        if (alert) {
          console.info('[ai.reply] Product information gap escalation created', {
            conversationId,
            tenantId,
            status,
            missingInfo: mergedMissing,
          });
          const contactForAlert = await findContactById(conversation.contact_id);
          socketService.emitAIAlert(tenantId, {
            ...alert,
            message_content: inboundText || null,
            contact_name: contactForAlert?.name?.trim() || 'Customer',
            channel_type: channel.type,
            channel_name: channel.name,
          });
          socketService.emitConversationUpdated(tenantId, conversationId);
        }
      }
    }
  }

  // Speculative health advice safety net.
  //
  // This guard fires AFTER all previous escalation paths have been evaluated.  If the AI
  // generated a reply that contains health-consultation language (e.g. "consult a health
  // professional", "consult a doctor", "it is important to consult...") AND:
  //   (a) the conversation was not already escalated, AND
  //   (b) the customer asked a usage / suitability question, AND
  //   (c) that advice pattern does NOT appear in the product's own usage description
  //       (i.e. it is not catalog-backed — the AI fabricated it from training knowledge)
  //
  // ...then we must NOT send the speculative advice to the customer.  We escalate
  // immediately with a holding message and create an alert for human review.
  //
  // This is the last line of defence for cases where the upstream classifiers
  // (classifyUsageQuestionIntent / isUsageQuestionUnanswered) were too permissive.
  let speculativeAdviceEscalated = false;
  if (
    !usageEscalated &&
    !productKnowledgeEscalated &&
    !isOosCannedReply &&
    usageQuestionIntent &&
    containsSpeculativeHealthAdvice(finalReplyText)
  ) {
    // Only escalate when the usage description itself does NOT already contain the same
    // health-consultation language — if the catalog says "consult a doctor if pregnant"
    // and the AI echoes that, it is valid catalog-backed advice, not speculation.
    const adviceIsFromCatalog = Boolean(
      usageDescription && containsSpeculativeHealthAdvice(usageDescription),
    );

    if (!adviceIsFromCatalog) {
      console.info(
        '[ai.reply] Speculative health advice detected in AI reply — escalating instead of sending',
        { conversationId, tenantId, replyPreview: finalReplyText.slice(0, 120) },
      );

      const speculativeHoldingMessage =
        HOLDING_MESSAGES[inferHoldingMessageLocale(inboundText, replyLocale)].usageEscalation;
      const client = await pool.connect();
      let alert: AIAlert | undefined;
      try {
        await client.query('BEGIN');
        await setConversationAiPaused(conversationId, tenantId, true, client);
        await setConversationHumanReplied(conversationId, tenantId, false, client);
        alert = await createAIAlert(
          {
            tenant_id: tenantId,
            conversation_id: conversationId,
            message_id: lastInbound?.id ?? null,
            reason: 'usage_question_unanswered',
          },
          client,
        );
        await client.query('COMMIT');
        speculativeAdviceEscalated = true;
        finalReplyText = speculativeHoldingMessage;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[ai.reply] Speculative advice escalation transaction failed', {
          conversationId,
          tenantId,
          err,
        });
      } finally {
        client.release();
      }

      if (alert) {
        const contactForAlert = await findContactById(conversation.contact_id);
        socketService.emitAIAlert(tenantId, {
          ...alert,
          message_content: inboundText || null,
          contact_name: contactForAlert?.name?.trim() || 'Customer',
          channel_type: channel.type,
          channel_name: channel.name,
        });
        socketService.emitConversationUpdated(tenantId, conversationId);
      }
    }
  }

  const knowledgeGapEscalated = usageEscalated || productKnowledgeEscalated || speculativeAdviceEscalated;

  let isOrderConfirmationReply = false;
  if (!knowledgeGapEscalated && inboundText && !isOosCannedReply) {
    isOrderConfirmationReply = await classifyOrderConfirmationReplyIntent(inboundText, finalReplyText);
    if (isOrderConfirmationReply) {
      const orderFollowUp = ORDER_CONFIRMATION_FOLLOW_UP[replyLocale];
      const tenantForOrderConfirmation = await findTenantById(tenantId);
      const configuredDeliveryTime = tenantForOrderConfirmation?.delivery_time ?? null;
      const deliveryLine = configuredDeliveryTime
        ? buildOrderConfirmationDeliveryLine(configuredDeliveryTime, replyLocale)
        : null;
      finalReplyText = ensureOrderConfirmationDeliveryAndFollowUp(
        finalReplyText,
        deliveryLine,
        orderFollowUp,
      );
    }
  }
  if (inboundText) {
    // Drop any fixed-phrase the model leaked in the OPPOSITE locale before we add the
    // canonical follow-up sentence below — this guarantees no language mixing in the reply.
    finalReplyText = stripFixedPhrasesOfOtherLocale(finalReplyText, replyLocale);
    const orderClosingAlreadyAskedInConversation =
      await hasAssistantAskedOrderClosingInConversation(recentMessages);

    // Data-confirmation gate: if the AI generated an order-confirmation reply (or the inbound
    // message provides delivery details after the order-closing question was already asked) but
    // the customer has not yet been asked to verify their details, override the reply with the
    // structured data-confirmation message. We also require that a customer name is present
    // somewhere in the conversation — if it's missing the AI should keep collecting data instead.
    // The order will only be registered once the customer confirms in the next turn.
    if (!knowledgeGapEscalated && !isOosCannedReply) {
      const dataConfirmationAlreadySent = hasAssistantAskedDataConfirmation(recentMessages);
      const inboundProvidesDetails = messageLooksLikeOrderDetailsPayload(inboundText);
      const customerNameKnown = extractCustomerNameFromMessages(recentMessages).firstName !== null;
      // Track whether a phone number has been provided in ANY recent message (not just the
      // current one). Used to identify the "customer submitted phone+address but forgot name"
      // case so we can ask for the name rather than silently failing.
      const phoneKnownFromMessages = extractPhoneNumberFromMessages(recentMessages) !== null;

      // True when the conversation is in an order-confirmation-like state: the AI just produced
      // an order-confirmation reply, or the customer submitted delivery details after the
      // order-closing question was already asked.
      const inOrderConfirmationLikeState =
        isOrderConfirmationReply ||
        (inboundProvidesDetails && orderClosingAlreadyAskedInConversation);

      // Full data-confirmation: all required fields (name + phone + address) are present.
      const shouldForceDataConfirmation =
        !dataConfirmationAlreadySent &&
        customerNameKnown &&
        inOrderConfirmationLikeState;

      // Missing-name guard: the customer has provided phone and delivery-address signals but
      // has NOT given their name yet. Without this override the AI might generate an order-
      // confirmation reply that bypasses the name requirement, leaving the conversation stuck
      // (no order is created because passesDraftOrderValidation requires hasCustomerName).
      // Only fire when the AI's own reply is NOT already a correctly-formatted data-confirmation
      // (which would happen when the AI correctly parsed a single-line "name phone address"
      // submission and produced the right verification message on its own).
      const aiReplyIsAlreadyDataConfirmation = messageIsDataConfirmationRequest(finalReplyText);
      const shouldRequestMissingName =
        !dataConfirmationAlreadySent &&
        !customerNameKnown &&
        phoneKnownFromMessages &&
        inOrderConfirmationLikeState &&
        !aiReplyIsAlreadyDataConfirmation;

      if (shouldForceDataConfirmation) {
        console.info('[DATA_CONFIRMATION] Overriding AI reply with data-verification request', {
          tenantId,
          conversationId,
          wasOrderConfirmationReply: isOrderConfirmationReply,
          inboundProvidesDetails,
          customerNameKnown,
        });
        finalReplyText = DATA_CONFIRMATION_MESSAGES[replyLocale];
        isOrderConfirmationReply = false;
      } else if (shouldRequestMissingName) {
        // The customer provided phone/address but not their name. Override the AI reply —
        // which may incorrectly confirm the order — with a specific name-request message.
        console.info('[DATA_CONFIRMATION] Overriding AI reply — customer name missing, asking for it', {
          tenantId,
          conversationId,
          wasOrderConfirmationReply: isOrderConfirmationReply,
          inboundProvidesDetails,
          phoneKnownFromMessages,
          customerNameKnown,
        });
        finalReplyText = MISSING_CUSTOMER_NAME_MESSAGES[replyLocale];
        isOrderConfirmationReply = false;
      }
    }

    // Fix: also strip the order-closing question when the customer's current message already
    // expresses a clear order intent — there is no point asking "do you want to order?" when
    // the customer just said they do or provided their delivery details.
    const inboundImpliesOrderIntent =
      looksLikeOrderAffirmation(inboundText) || messageLooksLikeOrderDetailsPayload(inboundText);
    const effectiveOrderClosingAsked = orderClosingAlreadyAskedInConversation || inboundImpliesOrderIntent;
    finalReplyText = await stripRepeatedOrderClosingQuestion(
      finalReplyText,
      effectiveOrderClosingAsked,
    );
    // Generic follow-up invitations ("më tregoni", "let me know", etc.) are only allowed in
    // (a) the first product reply and (b) order-confirmation replies. If the order-closing
    // was already asked (or implied by intent) and this is not an order-confirmation reply,
    // strip them.
    finalReplyText = stripGenericFollowUpInvitation(
      finalReplyText,
      effectiveOrderClosingAsked && !isOrderConfirmationReply,
    );
  }

  const qualityThreshold = getQualityThreshold();
  const explicitClosingReplies = [
    'Pa problem, kaloni bukur.',
    'Edhe ju gjithashtu, kalofshi bukur.',
    'No problem, take care.',
    'You too, have a great day.',
  ];
  const containsNegativeAvailabilityPhrase = await classifyNegativeAvailabilityReply(finalReplyText);
  const hasNoMatchingProducts =
    productCatalogContext.trim() === 'No matching products found in the catalog.';
  const skipEvaluationForHonestNegative =
    !knowledgeGapEscalated && containsNegativeAvailabilityPhrase && hasNoMatchingProducts;
  const skipEvaluationForOutOfStockCanned = !knowledgeGapEscalated && isOosCannedReply;
  const skipEvaluationForClosingReply =
    !knowledgeGapEscalated &&
    explicitClosingReplies.some(
      (sentence) =>
        normalizeForIncludesCheck(finalReplyText) ===
        normalizeForIncludesCheck(sentence),
    );
  const qualityEval = knowledgeGapEscalated
    ? null
    : skipEvaluationForHonestNegative ||
        skipEvaluationForOutOfStockCanned ||
        skipEvaluationForClosingReply
      ? {
          quality_score: 0.95,
          is_off_topic: false,
          is_unclear: false,
          is_irrelevant: false,
          reason: null,
          flagging_rule_triggered: null,
        }
      : await evaluateReply(inboundText, finalReplyText, tenantId, productCatalogContext);
  let qualityFailing =
    qualityEval !== null && evaluationTriggersAlert(qualityEval, qualityThreshold);
  const qualityScore = qualityEval?.quality_score ?? null;
  let flagReason =
    qualityEval && qualityFailing ? resolveStoredFlagReason(qualityEval, qualityThreshold) : null;
  const suppressibleOrderConfirmationFlags = new Set(['irrelevant', 'off_topic', 'low_confidence']);
  const suppressFalseQualityFlagOnOrderConfirmation =
    qualityEval !== null &&
    qualityFailing &&
    flagReason !== null &&
    suppressibleOrderConfirmationFlags.has(flagReason) &&
    isOrderConfirmationReply;
  const suppressFalseQualityFlagOnOrderDetailsCollection =
    qualityEval !== null &&
    qualityFailing &&
    flagReason !== null &&
    suppressibleOrderConfirmationFlags.has(flagReason) &&
    (await classifyOrderDetailsCollectionReplyIntent(inboundText, finalReplyText));
  if (suppressFalseQualityFlagOnOrderConfirmation || suppressFalseQualityFlagOnOrderDetailsCollection) {
    qualityFailing = false;
    flagReason = null;
    console.info(
      '[QUALITY EVAL] Suppressing false quality flag for likely order flow reply',
      {
        tenantId,
        conversationId,
        isOrderConfirmationReply: suppressFalseQualityFlagOnOrderConfirmation,
        isOrderDetailsCollectionReply: suppressFalseQualityFlagOnOrderDetailsCollection,
      },
    );
  }

  if (knowledgeGapEscalated) {
    console.info(
      `[QUALITY EVAL] tenantId: ${tenantId} conversationId: ${conversationId} skipped: knowledge_gap_escalated`,
    );
  } else if (skipEvaluationForHonestNegative) {
    console.info(
      `[QUALITY EVAL] tenantId: ${tenantId} conversationId: ${conversationId} skipped: honest_negative_no_matching_products`,
    );
  } else if (skipEvaluationForOutOfStockCanned) {
    console.info(
      `[QUALITY EVAL] tenantId: ${tenantId} conversationId: ${conversationId} skipped: out_of_stock_canned_reply`,
    );
  } else if (skipEvaluationForClosingReply) {
    console.info(
      `[QUALITY EVAL] tenantId: ${tenantId} conversationId: ${conversationId} skipped: closing_reply`,
    );
  } else if (!qualityEval) {
    console.info(
      `[QUALITY EVAL] tenantId: ${tenantId} conversationId: ${conversationId} score: n/a flagged: n/a rule: n/a reasoning: "evaluation_unavailable"`,
    );
  } else {
    const ruleDisplay =
      qualityEval.flagging_rule_triggered === null || qualityEval.flagging_rule_triggered === ''
        ? 'null'
        : JSON.stringify(qualityEval.flagging_rule_triggered);
    console.info(
      `[QUALITY EVAL] tenantId: ${tenantId} conversationId: ${conversationId} score: ${qualityEval.quality_score} flagged: ${qualityFailing} rule: ${ruleDisplay} reasoning: ${logJsonStringOrNull(qualityEval.reason)}`,
    );
  }

  // Presentation-only cleanup applied as the very last step so the sent message and
  // the persisted message match: strip Markdown emphasis (no bold product names) and
  // collapse excessive blank lines (no big vertical gaps on Instagram). This changes
  // formatting only, never the wording or any decision made above.
  finalReplyText = sanitizeOutboundMessageText(finalReplyText);

  const contact = await findContactById(conversation.contact_id);
  let sendResult:
    | Awaited<ReturnType<typeof sendMessage>>
    | null = null;
  // When usage escalation fired we already set ai_paused=true ourselves.
  // shouldStillSendAutomatedReply would read that flag and abort the send,
  // preventing the holding message from ever reaching the customer.
  // Skip the precheck in that case — we still need to deliver the holding message.
  const mainSendPrecheck = knowledgeGapEscalated
    ? ({ ok: true } as const)
    : await shouldStillSendAutomatedReply({
        tenantId,
        channelId,
        conversationId,
        scheduledInboundExternalId: data.messageExternalId,
      });
  if (!mainSendPrecheck.ok) {
    console.info('[ai.reply] Skipping AI send', {
      conversationId,
      scheduledFor: data.messageExternalId,
      reason: mainSendPrecheck.reason,
      ...('logPayload' in mainSendPrecheck ? mainSendPrecheck.logPayload : {}),
    });
    return;
  }
  if (contact) {
    sendResult = await sendMessage(channel, contact.external_id, finalReplyText);
  } else {
    console.error('[ai.reply] Contact not found for conversation', {
      contactId: conversation.contact_id,
    });
  }

  const outboundMessage = await createMessage({
    tenant_id: tenantId,
    conversation_id: conversationId,
    external_message_id: sendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
    direction: 'outbound',
    type: 'text',
    content: finalReplyText,
    sent_by: 'ai',
    quality_score: qualityScore,
    flagged: qualityFailing,
    flag_reason: flagReason,
    // Persist the products this reply identified so follow-up turns ("what are the
    // prices?", "what flavors?", "are these in stock?") can deterministically reuse
    // them instead of re-running a fragile text lookup that may fail and wrongly claim
    // the products are not in the catalog.
    product_ids: matchedProducts.map((p) => p.id),
  });

  if (qualityFailing && flagReason) {
    const client = await pool.connect();
    let alert: AIAlert | undefined;
    try {
      await client.query('BEGIN');
      alert = await createAIAlert(
        {
          tenant_id: tenantId,
          conversation_id: conversationId,
          message_id: outboundMessage.id,
          reason: flagReason,
        },
        client,
      );
      await setConversationAiPaused(conversationId, tenantId, true, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[ai.reply] Quality alert / pause failed', { conversationId, tenantId, err });
    } finally {
      client.release();
    }
    if (alert) {
      const contactForAlert = await findContactById(conversation.contact_id);
      socketService.emitAIAlert(tenantId, {
        ...alert,
        message_content: outboundMessage.content,
        contact_name: contactForAlert?.name?.trim() || 'Customer',
        channel_type: channel.type,
        channel_name: channel.name,
      });
      socketService.emitConversationUpdated(tenantId, conversationId);

      // ------------------------------------------------------------------
      // Feedback→fine-tuning loop
      //
      // A quality-flagged reply is evidence of a real accuracy problem —
      // exactly the kind of example the fine-tuning pipeline needs. By
      // auto-creating a feedback_log row here we close the loop: flagged
      // replies immediately appear in the fine-tuning candidate pool without
      // requiring a human to manually submit feedback first.
      //
      // corrected_response is left null; a human agent can fill it in via the
      // Feedback page. The fine-tuning job already handles pending rows with
      // no correction (it uses the original + the flag reason as signal).
      // ------------------------------------------------------------------
      void createFeedbackLog({
        tenant_id: tenantId,
        message_id: outboundMessage.id,
        conversation_id: conversationId,
        original_ai_response: outboundMessage.content ?? '',
        corrected_response: null,
        reason: flagReason ?? 'low_confidence',
      }).catch((err) => {
        console.warn('[ai.reply] Failed to auto-create feedback log for quality alert', {
          tenantId,
          conversationId,
          err,
        });
      });
    }
  }

  await touchConversationLastMessageAt(conversationId);

  void logEvent(tenantId, 'ai_reply_sent', {
    conversation_id: conversationId,
    channel_id: channelId,
    message_id: outboundMessage.id,
  });

  socketService.emitNewMessage(tenantId, outboundMessage);
  socketService.emitConversationUpdated(tenantId, conversationId);

  // Enqueue a delayed use case evaluation. The 4-hour delay acts as an inactivity window:
  // if the customer replies again within 4 hours the job fires and re-evaluates at that point.
  // jobId deduplication ensures that an explicit conversation-close enqueue (delay=0) with the
  // same jobId cancels this delayed version, preventing a redundant double-evaluation.
  void (aiQueue as unknown as { add: (name: string, data: unknown, opts?: unknown) => Promise<unknown> }).add(
    'evaluateConversationUseCase',
    { conversationId, tenantId },
    {
      delay: 4 * 60 * 60 * 1000,
      jobId: `eval-usecase-${conversationId}`,
      removeOnComplete: true,
      removeOnFail: false,
    },
  );

  if (!sendResult?.success) {
    const errReason = sendResult?.error ?? 'Contact not found for conversation';
    if (sendResult) {
      console.error('[ai.reply] Channel send failed', { conversationId, error: errReason });
    }
    await updateMessageSendFailure(outboundMessage.id, tenantId, 'failed', errReason);
    socketService.emitMessageSendFailed(tenantId, {
      messageId: outboundMessage.id,
      conversationId,
      error: errReason,
    });
    let alert: AIAlert | undefined;
    try {
      alert = await createAIAlert({
        tenant_id: tenantId,
        conversation_id: conversationId,
        message_id: outboundMessage.id,
        reason: 'message_send_failed',
      });
    } catch (alertErr) {
      console.error('[ai.reply] message_send_failed alert insert failed', {
        conversationId,
        tenantId,
        err: alertErr,
      });
    }
    if (alert) {
      const contactForAlert = await findContactById(conversation.contact_id);
      socketService.emitAIAlert(tenantId, {
        ...alert,
        message_content: outboundMessage.content,
        contact_name: contactForAlert?.name?.trim() || 'Customer',
        channel_type: channel.type,
        channel_name: channel.name,
      });
    }
  }

  try {
    if (!contact) {
      return;
    }

    const messagesForIntent = await findMessagesByConversation(conversationId, 40);
    const catalogProductNames = await findActiveProductNamesForTenant(tenantId);
    const intent = await detect(messagesForIntent, tenantId, catalogProductNames);
    const qtyDisplay = intent.quantity === null ? 'null' : String(intent.quantity);
    console.info(
      `[INTENT DETECTION] tenantId: ${tenantId} conversationId: ${conversationId} score: ${intent.intent_score} is_ready: ${intent.is_ready_to_order} product_name: ${logJsonStringOrNull(intent.product_name)} quantity: ${qtyDisplay} delivery_address: ${logJsonStringOrNull(intent.delivery_address)} reasoning: ${JSON.stringify(intent.reasoning)}`,
    );

    const parsedIntentThreshold = parseFloat(process.env.INTENT_THRESHOLD ?? '0.85');
    const intentOrderMinScore =
      Number.isFinite(parsedIntentThreshold) && parsedIntentThreshold > 0 && parsedIntentThreshold < 1
        ? parsedIntentThreshold
        : 0.85;
    const explicitNewOrder = await classifyNewOrderSignal(inboundText);
    const orderAffirmationIntent = await detectOrderAffirmationIntent(inboundText, messagesForIntent);
    const latestMessageAffirmsOrder =
      orderAffirmationIntent.is_order_affirmation === true && orderAffirmationIntent.confidence > 0.7;

    const hasDeliveryAddress =
      typeof intent.delivery_address === 'string' && intent.delivery_address.trim().length > 0;

    const meta = contact.metadata ?? {};
    const phoneRaw = meta.phone ?? meta.phone_number ?? meta.phoneNumber;
    const customerPhoneFromMetadata =
      typeof phoneRaw === 'string' && phoneRaw.trim() ? phoneRaw.trim() : null;
    const customerPhoneFromConversation = extractPhoneNumberFromMessages(messagesForIntent);
    const customerPhoneFromContactExternalId =
      channel.type === 'whatsapp' ? extractPhoneNumberCandidate(contact.external_id) : null;
    const customerPhone =
      customerPhoneFromMetadata ?? customerPhoneFromConversation ?? customerPhoneFromContactExternalId;
    const hasCustomerPhone = typeof customerPhone === 'string' && customerPhone.length > 0;

    const resolvedCustomerName = resolveCustomerNameForOrder({
      customerFirstNameFromIntent: intent.customer_first_name,
      contactName: contact.name,
      contactMetadata: meta,
      conversationMessages: messagesForIntent,
    });
    const hasCustomerName = resolvedCustomerName.firstName !== null;

    const recentCustomerAffirmation = messagesForIntent
      .slice(-20)
      .some(
        (msg) =>
          msg.sent_by === 'customer' &&
          typeof msg.content === 'string' &&
          looksLikeOrderAffirmation(msg.content),
      );

    const assistantAskedOrderClosingEarlier = await hasAssistantAskedOrderClosingInConversation(
      messagesForIntent,
    );
    const latestMessageProvidesOrderDetails = messageLooksLikeOrderDetailsPayload(inboundText);

    // Require the data-confirmation request to have been sent before we register the order.
    // This ensures the customer explicitly verified their name, phone, and address in the previous turn.
    // Exception: explicit new-order signals (customer asking for a repeat/additional order) are
    // allowed to bypass this gate since the details are already on file from the current session.
    const dataConfirmationSentBeforeCurrentTurn =
      hasAssistantAskedDataConfirmation(messagesForIntent);
    const shouldAffirmOrder =
      explicitNewOrder ||
      (dataConfirmationSentBeforeCurrentTurn &&
        (latestMessageAffirmsOrder ||
          recentCustomerAffirmation ||
          (latestMessageProvidesOrderDetails && assistantAskedOrderClosingEarlier)));

    // Structured log so every order-collection attempt is observable regardless of outcome.
    // Use [ORDER_COLLECTION_STATE] as the search key in your log aggregator.
    console.info(
      `[ORDER_COLLECTION_STATE] tenantId: ${tenantId} conversationId: ${conversationId}` +
      ` hasName: ${hasCustomerName} hasPhone: ${hasCustomerPhone} hasAddress: ${hasDeliveryAddress}` +
      ` dataConfirmationSent: ${dataConfirmationSentBeforeCurrentTurn}` +
      ` shouldAffirmOrder: ${shouldAffirmOrder} explicitNewOrder: ${explicitNewOrder}` +
      ` is_ready_to_order: ${intent.is_ready_to_order} intent_score: ${intent.intent_score}` +
      ` resolvedFirstName: ${logJsonStringOrNull(resolvedCustomerName.firstName)}` +
      ` intentFirstName: ${logJsonStringOrNull(intent.customer_first_name)}`,
    );

    const passesDraftOrderValidation =
      intent.is_ready_to_order === true &&
      intent.intent_score > intentOrderMinScore &&
      intent.product_name != null &&
      hasDeliveryAddress &&
      hasCustomerPhone &&
      hasCustomerName &&
      shouldAffirmOrder;

    if (!passesDraftOrderValidation) {
      console.info('[ai.reply] Skipping draft order creation due to failed validation', {
        conversationId,
        tenantId,
        explicitNewOrder,
        latestMessageAffirmsOrder,
        recentCustomerAffirmation,
        assistantAskedOrderClosingEarlier,
        latestMessageProvidesOrderDetails,
        dataConfirmationSentBeforeCurrentTurn,
        shouldAffirmOrder,
        orderAffirmationConfidence: orderAffirmationIntent.confidence,
        orderAffirmationReason: orderAffirmationIntent.reason,
        hasDeliveryAddress,
        hasCustomerPhone,
        hasCustomerName,
        customerFirstName: resolvedCustomerName.firstName,
      });
      return;
    }

    const nameFromIntent = intent.product_name?.trim();

    // Anchor product resolution on the customer's OWN recent wording (e.g. "the 50 servings
    // one") rather than trusting only the intent classifier's free-text product_name. This
    // prevents attaching the wrong variant to an order when several similar products were
    // recommended (e.g. Creatine 50 vs 60 Servings).
    const customerSelectionText = messagesForIntent
      .filter((m) => m.sent_by === 'customer' && typeof m.content === 'string')
      .slice(-4)
      .map((m) => m.content as string)
      .join('\n');

    const resolution = await resolveOrderProduct({
      tenantId,
      intentProductName: nameFromIntent ?? null,
      customerSelectionText,
    });
    const matchedProduct = resolution.product;

    console.info(
      `[ORDER_PRODUCT_RESOLUTION] tenantId: ${tenantId} conversationId: ${conversationId}` +
      ` intentProductName: ${logJsonStringOrNull(nameFromIntent ?? null)}` +
      ` reason: ${resolution.reason} ambiguous: ${resolution.ambiguous}` +
      ` selected: ${logJsonStringOrNull(matchedProduct?.name ?? null)}` +
      ` selectedId: ${logJsonStringOrNull(matchedProduct?.id ?? null)}` +
      ` candidates: ${JSON.stringify(resolution.candidates.map((c) => c.name))}`,
    );

    // When several variants remain plausible and the customer's wording does not pin one,
    // refuse to guess: creating an order for the wrong variant is worse than not creating one.
    // Instead, ask the customer to choose between the specific candidates so the next turn
    // carries a distinguishing attribute. We only ask once to avoid looping on the question.
    if (resolution.ambiguous) {
      console.warn(
        '[ORDER_PRODUCT_AMBIGUOUS] Skipping draft order: customer selection matched multiple variants',
        {
          conversationId,
          tenantId,
          intentProductName: nameFromIntent,
          candidateNames: resolution.candidates.map((c) => c.name),
        },
      );

      const clarificationLeadIn = VARIANT_CLARIFICATION_LEAD_IN[replyLocale];
      const alreadyAskedClarification = messagesForIntent
        .slice(-8)
        .some(
          (m) =>
            m.sent_by === 'ai' &&
            typeof m.content === 'string' &&
            m.content.includes(clarificationLeadIn),
        );

      if (!alreadyAskedClarification) {
        const clarificationText = buildVariantClarificationMessage(
          resolution.candidates.map((c) => c.name),
          replyLocale,
        );
        const clarifySendResult = await sendMessage(
          channel,
          contact.external_id,
          clarificationText,
        );
        const clarifyMessage = await createMessage({
          tenant_id: tenantId,
          conversation_id: conversationId,
          external_message_id: clarifySendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
          direction: 'outbound',
          type: 'text',
          content: clarificationText,
          sent_by: 'ai',
        });
        await touchConversationLastMessageAt(conversationId);
        socketService.emitNewMessage(tenantId, clarifyMessage);
        socketService.emitConversationUpdated(tenantId, conversationId);
        console.info('[ORDER_PRODUCT_CLARIFICATION_SENT]', {
          conversationId,
          tenantId,
          candidateNames: resolution.candidates.map((c) => c.name),
          sendSuccess: clarifySendResult?.success === true,
        });
      }
      return;
    }

    if (matchedProduct && matchedProduct.in_stock === false) {
      console.info('[ai.reply] Skipping draft order: product is out of stock', {
        conversationId,
        tenantId,
        productId: matchedProduct.id,
        productName: matchedProduct.name,
      });
      return;
    }

    const productName = matchedProduct?.name ?? nameFromIntent;
    if (!productName) {
      console.info('[ai.reply] Order intent detected but no product name to record', {
        conversationId,
        intent_score: intent.intent_score,
      });
      return;
    }

    if (!matchedProduct) {
      console.warn(
        '[ai.reply] Skipping draft order: product from intent could not be matched in catalog',
        {
          conversationId,
          tenantId,
          intentProductName: nameFromIntent,
        },
      );
      return;
    }

    const quantity = Math.max(1, intent.quantity ?? 1);
    const unitPrice = Number(matchedProduct.price);
    const totalPrice = unitPrice * quantity;

    const latestActiveOrder = await findLatestActiveOrderForConversation(tenantId, conversationId);
    if (latestActiveOrder) {
      const incomingProduct = normalizeLooseText(productName);
      const existingProduct = normalizeLooseText(latestActiveOrder.product_name);
      const productChanged = incomingProduct.length > 0 && incomingProduct !== existingProduct;

      if (!productChanged && !explicitNewOrder) {
        console.info('[ai.reply] Skipping duplicate order creation', {
          conversationId,
          existingOrderId: latestActiveOrder.id,
          productName,
          intent_score: intent.intent_score,
        });
        return;
      }
    }

    const humanInOrderWindow = await hasHumanParticipationInCurrentOrderWindow(
      conversationId,
      tenantId,
    );
    const isCommissionable = !humanInOrderWindow;
    const commissionAmount = isCommissionable
      ? Math.round(totalPrice * 0.05 * 100) / 100
      : null;
    console.info('[ai.reply] Commission decision for AI-created order', {
      conversationId,
      tenantId,
      isCommissionable,
      humanInOrderWindow,
    });

    const order = await createOrder({
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: conversation.contact_id,
      product_id: matchedProduct.id,
      product_name: productName,
      quantity,
      unit_price: unitPrice,
      total_price: totalPrice,
      status: 'draft',
      customer_name: resolvedCustomerName.fullName ?? 'Unknown',
      customer_phone: customerPhone,
      delivery_address: intent.delivery_address?.trim() ?? null,
      notes: null,
      detected_by: 'ai',
      is_commissionable: isCommissionable,
      commission_amount: commissionAmount,
    });

    void logEvent(tenantId, 'order_created', {
      order_id: order.id,
      conversation_id: conversationId,
      product_id: order.product_id,
      product_name: order.product_name,
      quantity: order.quantity,
    });

    socketService.emitOrderCreated(tenantId, order);
  } catch (err) {
    console.error('[ai.reply] Intent detection or draft order failed', {
      conversationId,
      tenantId,
      err,
    });
  }

  } finally {
    // Always release the per-tenant concurrency slot, even if the job threw
    // or returned early at any point inside the try block above.
    await releaseTenantSlot();
  }
}
