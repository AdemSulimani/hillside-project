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
  findLatestConfirmedOrProcessingOrderForContact,
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
  findProductsForInboundMessage,
  generateReply,
  isUsageQuestionUnanswered,
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
import { openai } from '../services/openaiClient';

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
    .replace(/\r\n/g, '\n')
    .trim();
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

async function latestInboundStillMatches(
  conversationId: string,
  expectedExternalMessageId: string,
): Promise<boolean> {
  const latestMessages = await findMessagesByConversation(conversationId, 8);
  const latestInbound = [...latestMessages].reverse().find((msg) => msg.direction === 'inbound');
  if (!latestInbound) return false;
  return latestInbound.external_message_id === expectedExternalMessageId;
}

function isUsageEscalationHoldingMessage(value: string): boolean {
  const normalized = normalizeEscalationMessage(value);
  const exactCandidates = [
    'pershendetje, se shpejti do t\'ju kontaktoje nje specialist lidhur me kete ceshtje.',
    'pershendetje, se shpejti do tju kontaktoje nje specialist lidhur me kete ceshtje.',
  ];
  if (exactCandidates.some((candidate) => normalized === normalizeEscalationMessage(candidate))) {
    return true;
  }

  const looksLikeAlbanianEscalation =
    normalized.includes('specialist') &&
    (normalized.includes('kontaktoje') || normalized.includes('kontaktoj')) &&
    (normalized.includes('se shpejti') || normalized.includes('shpejt')) &&
    normalized.includes('ceshtje');

  return looksLikeAlbanianEscalation;
}

const HOLDING_MESSAGES = {
  sq: {
    postPurchaseSupport:
      'Përshëndetje, na vjen keq për problemin. Pas pak, një anëtar i ekipit tonë do t’ju përgjigjet.',
    usageEscalation:
      'Përshëndetje, së shpejti do t’ju kontaktojë një specialist lidhur me këtë çështje.',
  },
} as const;

const DELIVERY_TIME_LABEL_HOURS: Record<DeliveryTime, number> = {
  '24h': 24,
  '48h': 48,
  '72h': 72,
};

function buildDeliveryEtaReply(deliveryTime: DeliveryTime): string {
  const hours = DELIVERY_TIME_LABEL_HOURS[deliveryTime];
  return `Përshëndetje, porosia juaj do të mbërrijë brenda ${hours} orëve.`;
}

type HoldingMessageLocale = keyof typeof HOLDING_MESSAGES;
const ORDER_CONFIRMATION_FOLLOW_UP =
  {
    sq: 'Nëse keni ndonjë pyetje tjetër apo dëshironi të porosisni diçka tjetër, jam këtu për t’ju ndihmuar.',
  } as const;

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

function inferHoldingMessageLocale(text: string): HoldingMessageLocale {
  // Shqip-only mode.
  return 'sq';
}

function stripExactSentenceLine(text: string, sentence: string): string {
  const target = normalizeForIncludesCheck(sentence);
  const cleaned = text
    .split(/\r?\n/)
    .filter((line) => normalizeForIncludesCheck(line.replace(/^[-*]\s*/, '')) !== target)
    .join('\n');
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function enforceSingleLanguageSystemPhrases(
  text: string,
  _locale: HoldingMessageLocale,
): string {
  return text;
}

const KNOWN_ENGLISH_REPLY_LINES = [
  'If you have any other questions or would like to place another order, I am here to help.',
  "Hello, we're sorry for the issue. A member of our team will reply to you shortly.",
  'Hello, a specialist from our team will contact you shortly regarding this issue.',
] as const;

const KNOWN_ENGLISH_REPLY_LINES_NORMALIZED = new Set(
  KNOWN_ENGLISH_REPLY_LINES.map((line) => normalizeForIncludesCheck(line)),
);

function stripKnownEnglishPhrases(text: string): string {
  const cleanedLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return true;
      const normalizedLine = normalizeForIncludesCheck(line.replace(/^[-*]\s*/, ''));
      return !KNOWN_ENGLISH_REPLY_LINES_NORMALIZED.has(normalizedLine);
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
    /(produkt.*gabuar|wrong item|wrong product|received.*wrong)/.test(normalized) ||
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
  const attachmentUrls = mergedAttachmentUrls;

  if (!inboundText && attachmentUrls.length === 0) {
    console.info('[ai.reply] No text content or attachments in inbound message, skipping');
    return;
  }

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
        const candidateOrder = await findLatestConfirmedOrProcessingOrderForContact(
          tenantId,
          conversation.contact_id,
        );

        if (candidateOrder) {
          const ackSystemPrompt = [
            'You are a customer support assistant handling a sensitive order issue.',
            'Write one short empathetic acknowledgment message in plain text.',
            'Requirements:',
            '- Acknowledge the customer request warmly and empathetically.',
            '- Thank the customer for letting the business know.',
            '- Ask for the reason only if not already provided.',
            '- Assure them a team member will follow up shortly.',
            '- Do NOT promise approvals, outcomes, or exact timelines.',
            '- Keep it concise and suitable for chat.',
          ].join('\n');
          const askForReason = cancellationRefundIntent.reason ? 'no' : 'yes';
          const ackCompletion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
              { role: 'system', content: ackSystemPrompt },
              {
                role: 'user',
                content: [
                  `Customer message: ${inboundText}`,
                  `Intent cancellation: ${cancellationRefundIntent.is_cancellation ? 'yes' : 'no'}`,
                  `Intent refund: ${cancellationRefundIntent.is_refund ? 'yes' : 'no'}`,
                  `Customer already provided reason: ${askForReason === 'yes' ? 'no' : 'yes'}`,
                ].join('\n'),
              },
            ],
            temperature: 0.4,
            max_tokens: 220,
          });
          const ackText =
            ackCompletion.choices[0]?.message?.content?.trim() ||
            'Thank you for letting us know. We are sorry to hear this and our team will review your request shortly.';

          const contactForSend = await findContactById(conversation.contact_id);
          let sendResult:
            | Awaited<ReturnType<typeof sendMessage>>
            | null = null;
          const stillLatestBeforeAck = await latestInboundStillMatches(
            conversationId,
            data.messageExternalId,
          );
          if (!stillLatestBeforeAck) {
            console.info('[ai.reply] Skipping cancellation/refund ack because newer inbound arrived', {
              conversationId,
              scheduledFor: data.messageExternalId,
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
          if (cancellationRefundIntent.is_cancellation) {
            const updatedOrder = await markOrderCancellationRequested(
              candidateOrder.id,
              tenantId,
              cancellationRefundIntent.reason,
            );
            if (updatedOrder) escalatedOrder = updatedOrder;
            const alert = await createAIAlert({
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: lastInbound?.id ?? null,
              reason: 'cancellation_request',
            });
            alerts.push(alert);
          }
          if (cancellationRefundIntent.is_refund) {
            const updatedOrder = await markOrderRefundRequested(
              candidateOrder.id,
              tenantId,
              cancellationRefundIntent.reason,
            );
            if (updatedOrder) escalatedOrder = updatedOrder;
            const alert = await createAIAlert({
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: lastInbound?.id ?? null,
              reason: 'refund_request',
            });
            alerts.push(alert);
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
          socketService.emitOrderActionRequired(tenantId, {
            order: escalatedOrder,
            reason: cancellationRefundIntent.reason,
          });
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
          const deliveryEtaReply = buildDeliveryEtaReply(configuredDeliveryTime);
          const stillLatestBeforeEtaAck = await latestInboundStillMatches(
            conversationId,
            data.messageExternalId,
          );
          if (!stillLatestBeforeEtaAck) {
            console.info('[ai.reply] Skipping delivery ETA auto-reply because newer inbound arrived', {
              conversationId,
              scheduledFor: data.messageExternalId,
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
        const locale = inferHoldingMessageLocale(inboundText);
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
        const stillLatestBeforePostPurchaseAck = await latestInboundStillMatches(
          conversationId,
          data.messageExternalId,
        );
        if (!stillLatestBeforePostPurchaseAck) {
          console.info('[ai.reply] Skipping post-purchase holding message because newer inbound arrived', {
            conversationId,
            scheduledFor: data.messageExternalId,
          });
          return;
        }
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

  const { reply: replyText, productCatalogContext } = await generateReply(
    conversationId,
    tenantId,
    inboundText,
    attachmentUrls,
  );

  if (replyText.trim() === '[NO_REPLY]') {
    return;
  }

  const usageCandidates = inboundText ? await findProductsForInboundMessage(tenantId, inboundText, 5) : [];
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

  const usageHoldingMessage = HOLDING_MESSAGES[inferHoldingMessageLocale(inboundText)].usageEscalation;
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
  if (!usageEscalated && inboundText) {
    isOrderConfirmationReply = await classifyOrderConfirmationReplyIntent(inboundText, finalReplyText);
    const orderFollowUp = ORDER_CONFIRMATION_FOLLOW_UP[inferHoldingMessageLocale(inboundText)];
    if (
      isOrderConfirmationReply &&
      !normalizeForIncludesCheck(finalReplyText).includes(
        normalizeForIncludesCheck(orderFollowUp),
      )
    ) {
      finalReplyText = `${finalReplyText.trim()}\n\n${orderFollowUp}`;
    }
  }
  if (inboundText) {
    finalReplyText = stripKnownEnglishPhrases(finalReplyText);
    const orderClosingAlreadyAskedInConversation =
      await hasAssistantAskedOrderClosingInConversation(recentMessages);
    finalReplyText = await stripRepeatedOrderClosingQuestion(
      finalReplyText,
      orderClosingAlreadyAskedInConversation,
    );
    // Generic follow-up invitations ("më tregoni", "let me know", etc.) are only allowed in
    // (a) the first product reply and (b) order-confirmation replies. If the order-closing
    // was already asked and this is not an order-confirmation reply, strip them.
    finalReplyText = stripGenericFollowUpInvitation(
      finalReplyText,
      orderClosingAlreadyAskedInConversation && !isOrderConfirmationReply,
    );
  }

  const qualityThreshold = getQualityThreshold();
  const explicitClosingReplies = [
    'Pa problem, kaloni bukur.',
    'Edhe ju gjithashtu, kalofshi bukur.',
  ];
  const containsNegativeAvailabilityPhrase = await classifyNegativeAvailabilityReply(finalReplyText);
  const hasNoMatchingProducts =
    productCatalogContext.trim() === 'No matching products found in the catalog.';
  const skipEvaluationForHonestNegative =
    !usageEscalated && containsNegativeAvailabilityPhrase && hasNoMatchingProducts;
  const skipEvaluationForClosingReply =
    !usageEscalated &&
    explicitClosingReplies.some(
      (sentence) =>
        normalizeForIncludesCheck(finalReplyText) ===
        normalizeForIncludesCheck(sentence),
    );
  const qualityEval = usageEscalated
    ? null
    : skipEvaluationForHonestNegative || skipEvaluationForClosingReply
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
  const stillLatestBeforeSend = await latestInboundStillMatches(
    conversationId,
    data.messageExternalId,
  );
  if (!stillLatestBeforeSend) {
    console.info('[ai.reply] Skipping AI send because newer inbound arrived during processing', {
      conversationId,
      scheduledFor: data.messageExternalId,
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
    const shouldAffirmOrder =
      latestMessageAffirmsOrder ||
      explicitNewOrder ||
      recentCustomerAffirmation ||
      (latestMessageProvidesOrderDetails && assistantAskedOrderClosingEarlier);

    const passesDraftOrderValidation =
      intent.is_ready_to_order === true &&
      intent.intent_score > intentOrderMinScore &&
      intent.product_name != null &&
      hasDeliveryAddress &&
      hasCustomerPhone &&
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
        shouldAffirmOrder,
        orderAffirmationConfidence: orderAffirmationIntent.confidence,
        orderAffirmationReason: orderAffirmationIntent.reason,
        hasDeliveryAddress,
        hasCustomerPhone,
      });
      return;
    }

    const nameFromIntent = intent.product_name?.trim();
    const matchedProduct = nameFromIntent
      ? await findProductByNameCaseInsensitive(tenantId, nameFromIntent)
      : null;

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
      customer_name: contact.name || 'Unknown',
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
