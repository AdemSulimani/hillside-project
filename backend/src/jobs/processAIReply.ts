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
} from '../db/models/order';
import { findProductByNameCaseInsensitive } from '../db/models/product';
import { findAIConfigByTenant } from '../db/models/aiConfig';
import {
  classifyNegativeAvailabilityReply,
  classifyNewOrderSignal,
  classifyOrderClosingQuestionReplyIntent,
  classifyOrderDetailsCollectionReplyIntent,
  classifyOrderConfirmationReplyIntent,
  classifyUsageQuestionIntent,
  detectCancellationOrRefundIntent,
  detectOrderAffirmationIntent,
  detectPostPurchaseSupportIntent,
  detectWrongProductIntent,
  detectReplyLanguage,
  generateReply,
  isOutOfStockProductReply,
  isUsageQuestionUnanswered,
  type ReplyLocale,
} from '../services/aiService';
import {
  evaluateReply,
  evaluationTriggersAlert,
  getQualityThreshold,
  resolveStoredFlagReason,
} from '../services/aiQualityService';
import { detect } from '../services/intentDetectionService';
import { sendMessage } from '../services/channelSenderService';
import { socketService } from '../services/socketService';
import { logEvent } from '../services/analyticsService';
import { aiQueue } from './queues';

export interface AIReplyJobData {
  tenantId: string;
  channelId: string;
  conversationId: string;
  messageExternalId: string;
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

function resolveCustomerNameForOrder(args: {
  customerFirstNameFromIntent: string | null;
  customerLastNameFromIntent: string | null;
  contactName: string;
  contactMetadata: Record<string, unknown>;
}): { firstName: string | null; lastName: string | null; fullName: string | null } {
  const meta = args.contactMetadata ?? {};
  let firstName = args.customerFirstNameFromIntent?.trim() || null;
  let lastName = args.customerLastNameFromIntent?.trim() || null;

  if (!firstName) {
    firstName = readMetaString(meta, ['first_name', 'firstName', 'given_name']);
  }
  if (!lastName) {
    lastName = readMetaString(meta, ['last_name', 'lastName', 'family_name']);
  }

  const contactName = args.contactName.trim();
  if (contactName && !isFallbackContactLabel(contactName)) {
    const parts = contactName.split(/\s+/).filter((part) => part.length > 0);
    if (!firstName && !lastName && parts.length >= 2) {
      firstName = parts[0];
      lastName = parts.slice(1).join(' ');
    }
  }

  const fullName =
    firstName && lastName ? `${firstName} ${lastName}`.trim() : null;
  return { firstName, lastName, fullName };
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

const HOLDING_MESSAGES: Record<ReplyLocale, { postPurchaseSupport: string; usageEscalation: string }> = {
  sq: {
    postPurchaseSupport:
      'Përshëndetje, na vjen keq për problemin. Pas pak, një anëtar i ekipit tonë do t’ju përgjigjet.',
    usageEscalation:
      'Përshëndetje, së shpejti do t’ju kontaktojë një specialist lidhur me këtë çështje.',
  },
  en: {
    postPurchaseSupport:
      'Hello, we are sorry for the issue. A member of our team will get back to you shortly.',
    usageEscalation:
      'Hello, a specialist from our team will contact you shortly regarding this matter.',
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
    ? `Përshëndetje, porosia juaj do të mbërrijë brenda ${hours} orëve.`
    : `Hello, your order will arrive within ${hours} hours.`;
}

type HoldingMessageLocale = ReplyLocale;
const ORDER_CONFIRMATION_FOLLOW_UP: Record<ReplyLocale, string> = {
  sq: 'Nëse keni ndonjë pyetje tjetër apo dëshironi të porosisni diçka tjetër, jam këtu për t’ju ndihmuar.',
  en: 'If you have any other questions or would like to place another order, I am here to help.',
};

/**
 * Sent after all order details have been collected, asking the customer to verify
 * their name, phone, and address before the order is registered. Must match verbatim so
 * messageIsDataConfirmationRequest can identify it in conversation history.
 */
const DATA_CONFIRMATION_MESSAGES: Record<ReplyLocale, string> = {
  sq: 'Faleminderit për porosinë tuaj! Për të shmanguar çdo gabim, a mund të konfirmoni që të dhënat që keni dhënë janë korrekte?',
  en: 'Thank you for your order! To avoid any mistakes, could you please confirm that the information you provided is correct?',
};

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

/** CRM-configured ETA line for order-confirmation replies (before the standard follow-up). */
function buildOrderConfirmationDeliveryLine(
  deliveryTime: DeliveryTime,
  locale: ReplyLocale,
): string {
  const hours = DELIVERY_TIME_LABEL_HOURS[deliveryTime];
  return locale === 'sq'
    ? `Produkti do të mbërrijë brenda ${hours} orëve.`
    : `Your product will arrive within ${hours} hours.`;
}

function insertDeliveryLineBeforeOrderFollowUp(
  text: string,
  deliveryLine: string,
  orderFollowUp: string,
): string {
  const fuNorm = normalizeForIncludesCheck(orderFollowUp);
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const paraIdx = paragraphs.findIndex((p) => normalizeForIncludesCheck(p) === fuNorm);
  if (paraIdx >= 0) {
    return [...paragraphs.slice(0, paraIdx), deliveryLine, ...paragraphs.slice(paraIdx)].join('\n\n');
  }

  const needles = [
    orderFollowUp.trim(),
    orderFollowUp.trim().replace(/\u2019/g, "'"),
    orderFollowUp.trim().replace(/'/g, '\u2019'),
  ];
  for (const needle of needles) {
    const idx = text.lastIndexOf(needle);
    if (idx !== -1) {
      const before = text.slice(0, idx).trimEnd();
      const fromFollowUp = text.slice(idx).trimStart();
      return `${before}\n\n${deliveryLine}\n\n${fromFollowUp}`;
    }
  }

  const marker = '\nNëse keni ndonjë pyetje tjetër';
  const mIdx = text.lastIndexOf(marker);
  if (mIdx >= 0) {
    const before = text.slice(0, mIdx).trimEnd();
    const fromFollowUp = text.slice(mIdx + 1).trimStart();
    return `${before}\n\n${deliveryLine}\n\n${fromFollowUp}`;
  }

  return `${text.trim()}\n\n${deliveryLine}`;
}

function ensureOrderConfirmationDeliveryAndFollowUp(
  replyText: string,
  deliveryLine: string | null,
  orderFollowUp: string,
): string {
  let text = replyText.trim();
  const fuNorm = normalizeForIncludesCheck(orderFollowUp);
  const hasFollowUp = normalizeForIncludesCheck(text).includes(fuNorm);

  if (
    deliveryLine &&
    !normalizeForIncludesCheck(text).includes(normalizeForIncludesCheck(deliveryLine))
  ) {
    text = hasFollowUp
      ? insertDeliveryLineBeforeOrderFollowUp(text, deliveryLine, orderFollowUp)
      : `${text}\n\n${deliveryLine}`;
  }

  if (!normalizeForIncludesCheck(text).includes(fuNorm)) {
    text = `${text.trim()}\n\n${orderFollowUp}`;
  }

  return text;
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
    ORDER_CONFIRMATION_FOLLOW_UP.sq,
  ],
  en: [
    HOLDING_MESSAGES.en.postPurchaseSupport,
    HOLDING_MESSAGES.en.usageEscalation,
    ORDER_CONFIRMATION_FOLLOW_UP.en,
    // Legacy English variants previously authored by the model — kept so we still strip them
    // when running in Albanian mode and the model accidentally falls back to old wording.
    "Hello, we're sorry for the issue. A member of our team will reply to you shortly.",
    'Hello, a specialist from our team will contact you shortly regarding this issue.',
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
    /^(po|ok|okej|yes|yep|sure|alright)\b/.test(normalized) ||
    /(dua|dush|do|doni|please|ju lutem).*(porosi|order)/.test(normalized) ||
    /(beje porosine|beje porosin|place the order|make the order)/.test(normalized) ||
    /^(po ju lutem|po beje|beje|ok beje)$/.test(normalized)
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

export async function processAIReply(data: AIReplyJobData): Promise<void> {
  const { tenantId, channelId, conversationId } = data;

  const parsedMax = parseInt(process.env.AI_MAX_REPLIES_PER_HOUR ?? '25', 10);
  const aiMaxRepliesPerHour =
    Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 25;
  const rateLimitKey = `ai_rate_limit:${conversationId}`;
  const rateCount = await redisConnection.incr(rateLimitKey);
  if (rateCount === 1) {
    await redisConnection.expire(rateLimitKey, 3600);
  }
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
    `[REPLY_LANGUAGE] tenantId: ${tenantId} conversationId: ${conversationId} language: ${replyLanguage}`,
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
    } catch (err) {
      console.warn('[ai.reply] escalation detection path failed, continuing normal flow', {
        conversationId,
        tenantId,
        err,
      });
    }
  }

  const { reply: replyText, productCatalogContext, language: generatedLanguage, matchedProducts } =
    await generateReply(
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
  const productWithUsage = usageCandidates.find((p) => typeof p.usage_description === 'string' && p.usage_description.trim() !== '');
  const usageDescription = productWithUsage?.usage_description?.trim() ?? null;

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
  if (!usageEscalated && usageQuestionIntent && !usageDescription && !isOosCannedReply) {
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

  let isOrderConfirmationReply = false;
  if (!usageEscalated && inboundText && !isOosCannedReply) {
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
    // the customer has not yet been asked to verify their phone + address, override the reply
    // with the structured data-confirmation message. The order will only be registered once
    // the customer confirms their details in the next turn.
    if (!usageEscalated && !isOosCannedReply) {
      const dataConfirmationAlreadySent = hasAssistantAskedDataConfirmation(recentMessages);
      const inboundProvidesDetails = messageLooksLikeOrderDetailsPayload(inboundText);
      const shouldForceDataConfirmation =
        !dataConfirmationAlreadySent &&
        (isOrderConfirmationReply ||
          (inboundProvidesDetails && orderClosingAlreadyAskedInConversation));
      if (shouldForceDataConfirmation) {
        console.info('[DATA_CONFIRMATION] Overriding AI reply with data-verification request', {
          tenantId,
          conversationId,
          wasOrderConfirmationReply: isOrderConfirmationReply,
          inboundProvidesDetails,
        });
        finalReplyText = DATA_CONFIRMATION_MESSAGES[replyLocale];
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
    !usageEscalated && containsNegativeAvailabilityPhrase && hasNoMatchingProducts;
  const skipEvaluationForOutOfStockCanned = !usageEscalated && isOosCannedReply;
  const skipEvaluationForClosingReply =
    !usageEscalated &&
    explicitClosingReplies.some(
      (sentence) =>
        normalizeForIncludesCheck(finalReplyText) ===
        normalizeForIncludesCheck(sentence),
    );
  const qualityEval = usageEscalated
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

  if (usageEscalated) {
    console.info(
      `[QUALITY EVAL] tenantId: ${tenantId} conversationId: ${conversationId} skipped: usage_escalated`,
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

  const contact = await findContactById(conversation.contact_id);
  let sendResult:
    | Awaited<ReturnType<typeof sendMessage>>
    | null = null;
  // When usage escalation fired we already set ai_paused=true ourselves.
  // shouldStillSendAutomatedReply would read that flag and abort the send,
  // preventing the holding message from ever reaching the customer.
  // Skip the precheck in that case — we still need to deliver the holding message.
  const mainSendPrecheck = usageEscalated
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
    const intent = await detect(messagesForIntent, tenantId);
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
      customerLastNameFromIntent: intent.customer_last_name,
      contactName: contact.name,
      contactMetadata: meta,
    });
    const hasCustomerName = resolvedCustomerName.fullName !== null;

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
    const dataConfirmationSentBeforeCurrentTurn = hasAssistantAskedDataConfirmation(recentMessages);
    const shouldAffirmOrder =
      explicitNewOrder ||
      (dataConfirmationSentBeforeCurrentTurn &&
        (latestMessageAffirmsOrder ||
          recentCustomerAffirmation ||
          (latestMessageProvidesOrderDetails && assistantAskedOrderClosingEarlier)));

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
        customerLastName: resolvedCustomerName.lastName,
      });
      return;
    }

    const nameFromIntent = intent.product_name?.trim();
    const matchedProduct = nameFromIntent
      ? await findProductByNameCaseInsensitive(tenantId, nameFromIntent)
      : null;

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

    const quantity = Math.max(1, intent.quantity ?? 1);
    const unitPrice = matchedProduct ? Number(matchedProduct.price) : 0;
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

    const { rows: humanRows } = await pool.query<{ human_replied: boolean }>(
      'SELECT human_replied FROM conversations WHERE id = $1 LIMIT 1',
      [conversationId],
    );
    const humanReplied = humanRows[0]?.human_replied === true;
    const isCommissionable = !humanReplied;
    const commissionAmount = isCommissionable
      ? Math.round(totalPrice * 0.05 * 100) / 100
      : null;

    const order = await createOrder({
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: conversation.contact_id,
      product_id: matchedProduct?.id ?? null,
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
}
