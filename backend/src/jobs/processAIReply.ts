import { knobBool, knobNumber, knobString } from '../config/knobs';
﻿import crypto from 'crypto';
import pool from '../db/pool';
import { logSafe, logSafeStructured, redactForLog } from '../utils/redact';
import { redisConnection } from './redisConnection';
import { findChannelById } from '../db/models/channel';
import {
  advanceOrderStage,
  findConversationByIdForTenant,
  markDataConfirmationSent,
  markOrderClosingAsked,
  persistLastRecommendedProductIds,
  persistOrderSlots,
  seedOrderStageState,
  setConversationAiPaused,
  setConversationHumanReplied,
  setStickyReplyLocale,
  touchConversationLastMessageAt,
  type OrderStage,
} from '../db/models/conversation';
import {
  decideOrderStage,
  deriveEffectiveOrderStage,
  detectNewOrderSignalLexical,
  detectOrderConsentLexical,
  normalizeStage,
} from '../services/orderStageMachine';
import { GHEG_LEXICONS, GHEG_POST_PURCHASE_EXTRA_PATTERNS } from '../services/ghegLexicons';
import { buildCommissionWindowQuery } from '../services/commissionWindow';
import {
  DATA_CONFIRMATION_MESSAGES,
  HOLDING_MESSAGES,
  MISSING_CUSTOMER_NAME_MESSAGES,
} from '../services/cannedReplyText';
import { findContactById } from '../db/models/contact';
import { findTenantById, type DeliveryTime } from '../db/models/tenant';
import {
  createMessage,
  findMessagesByConversation,
  type Message,
  updateMessageSendFailure,
} from '../db/models/message';
import {
  createAIAlert,
  hasOpenSensitiveAlertForConversation,
  type AIAlert,
} from '../db/models/aiAlert';
import type { LedgerDecisionEvent } from '../db/models/aiDecisionLedger';
import {
  buildLedgerRecord,
  enqueueLedgerViaOutbox,
  writeLedgerBestEffort,
  type BuildLedgerRecordInput,
} from './aiDecisionLedgerWriter';
import {
  compareSnapshotToLive,
  runWithReceiptSnapshot,
  type LiveGateState,
} from '../services/receiptSnapshot';
import { aiConfigVersion } from '../services/aiConfigCache';
import { buildAIReplyJobData, type AIReplyJobData } from './jobTypes';
import {
  decideAdmission,
  normalizeHop,
  admissionJobId,
  AdmissionShedError,
  DEFAULT_ADMISSION_POLICY,
} from './admissionControl';
import {
  TENANT_SLOT_ACQUIRE_SCRIPT,
  TENANT_SLOT_RELEASE_SCRIPT,
  tenantSlotKey,
  tenantSlotMember,
  parseAcquireResult,
} from '../services/tenantSlotLease';
import { insertOutboxTx } from '../db/models/outbox';
import { deriveReplyIdempotencyKey, type ReplySlot } from '../services/replyIdempotency';
import {
  createOrder,
  findLatestActiveOrderForConversation,
  findLatestOpenOrderForContactForEscalation,
  markOrderCancellationRequested,
  markOrderRefundRequested,
  updateOrderCustomerInfoForAI,
  type UpdateOrderCustomerInfoInput,
} from '../db/models/order';
import { findActiveProductNamesForTenant, type Product } from '../db/models/product';
import { resolveOrderProduct } from '../services/orderProductResolutionService';
import { findAIConfigByTenant } from '../db/models/aiConfig';
import {
  classifyFollowUpInvitationInReply,
  classifyNegativeAvailabilityReply,
  classifyNewOrderSignal,
  classifyOrderClosingQuestionReplyIntent,
  classifyOrderDetailsCollectionReplyIntent,
  classifyOrderConfirmationReplyIntent,
  classifySpeculativeHealthAdvice,
  classifyUsageQuestionIntent,
  classifyProductImageRequest,
  containsSpeculativeHealthAdvice,
  detectCancellationOrRefundIntent,
  detectOrderAffirmationIntent,
  detectOrderInfoUpdateIntent,
  detectPostPurchaseSupportIntent,
  detectWrongProductIntent,
  detectReplyLanguage,
  filterHallucinatedProductNames,
  generateReply,
  isOutOfStockProductReply,
  isUsageQuestionUnanswered,
  resolveProductsFromPersistedContext,
  STICKY_LOCALE_SLOT,
  SUMMARY_SLOT_BACKED,
  HISTORY_FETCH_LIMIT,
  type ReplyLocale,
} from '../services/aiService';
import {
  resolveProductsForImageRequest,
  augmentImageTargetsFromCatalog,
  decideImageRequestOutcome,
  buildImageReplyText,
} from '../services/productImageRequestService';
import type { ProductImageRef } from '../services/productImageRequestService';
import { markSelfSentMessageEcho } from '../services/outboundEchoRegistry';
import { extractCustomerNameFromMessages } from '../services/orderCustomerDetails';
import {
  buildOrderConfirmationDeliveryLine,
  ensureOrderConfirmationDeliveryAndFollowUp,
  stripModelDeliveryEtaMentions,
} from '../services/orderConfirmationFormatting';
import { sanitizeOutboundMessageText } from '../services/outboundMessageFormatting';
import { isProductRecommendationOrComparisonQuestion } from '../services/productDescriptionPromptService';
import {
  buildProductKnowledgeContext,
  detectRequestedAttributes,
  getProductInferredAttributes,
  isOtherOptionsFollowUp,
} from '../services/productRetrievalService';
import { getProductImageDerivedContext } from '../services/productImageAttributeService';
import { detectSpecifiedAttributes } from '../services/productAttributeAvailabilityService';
import { assessProductInformationRequest } from '../services/productInformationGapService';
import {
  buildCatalogPriceSet,
  filterHallucinatedPrices,
  type CatalogPriceSet,
} from '../services/priceConsistencyGuard';
import {
  getFullCatalogNameIndex,
  getFullCatalogPriceSet,
  replyNamesActiveCatalogProduct,
  verifySuspectedNamesAgainstCatalog,
} from '../services/catalogGuardReferenceService';
import {
  getFullCatalogAttributeIndex,
  resolveProductRef,
} from '../services/catalogAttributeReferenceService';
import type { AttributeGateMode } from '../services/attributeGrounding';
import {
  evaluateConsolidatedGrounding,
  GenerationContractError,
  type GroundingGateDeps,
} from '../services/groundingGate';
import { detectCrossMessagePriceInconsistency } from '../services/conversationFactConsistencyGuard';
import {
  GET_BACK_TO_YOU_MESSAGES,
  UNCERTAIN_ANSWER_ALERT_REASON,
  shouldEscalateUncertainAnswer,
} from '../services/uncertainAnswerFallbackGuard';
import {
  buildMissingInfoHoldingMessage,
  composePartialAnswer,
  computeMissingStructuredAttributes,
  decideGapEscalation,
  dedupeInfoLabels,
  deriveAnswerabilityStatus,
  filterFreeFormInfoLabels,
  localizedAttributeLabels,
  reconcileMissingAgainstAnswer,
  stripContradictoryMissingInfoNotice,
} from '../services/productInformationGapHelpers';
import {
  decideSensitivePathAction,
  decideSensitiveDetectorFailureRoute,
  SensitivePathEscalatedError,
} from '../services/sensitivePathFailClosed';
import {
  ProviderUnavailableError,
  rearmTurnDeadline,
  runWithTurnResilience,
  shouldDegradeTurn,
  summarizeTurnFailures,
  turnProviderFailures,
  type BreakerMode,
} from '../services/providerResilience';
// The breaker singleton lives where its knobs are read (openaiClient), and this job already loads
// that module transitively via aiService — so this import adds no new module-load surface.
import { providerBreaker } from '../services/openaiClient';
import {
  CONFIDENCE_CONTRACT_SYMMETRY,
  CONFIDENCE_HYSTERESIS_BAND,
  classifyConfidenceGate,
  isLikelyE164Phone,
  passesConfidenceGate,
} from '../services/classifierConfidenceContract';
import {
  shouldCountDeliveredReply,
  isOverDeliveredRateLimit,
  rateCountedMarkerKey,
  RATE_LIMIT_DELIVERED_INCR_SCRIPT,
} from '../services/rateLimitDeliveredCount';
import { shouldAutoResumeRateLimitPause } from '../services/aiResumePolicy';
import { getOrComputeClassifierVerdict } from '../services/classifierVerdictStore';
import { runWithOpenAICallTracking } from '../services/openaiCallTracker';
import { buildShadowBranch } from '../services/shadowComparison';
import { logger, runWithLogContext } from '../utils/logger';
import {
  evaluateReply,
  evaluationTriggersAlert,
  getQualityEvalMode,
  getQualityThreshold,
  resolveStoredFlagReason,
} from '../services/aiQualityService';
import { createFeedbackLog } from '../db/models/feedbackLog';
import { detect } from '../services/intentDetectionService';
import { sendMessage, sendImageMessage } from '../services/channelSenderService';
import { stageAndSend, isStageBeforeSendEnabled } from '../services/stageAndSend';
import { socketService } from '../services/socketService';
import { logEvent } from '../services/analyticsService';
import { getHumanHoldMinutes } from '../services/conversationService';
import { aiQueue } from './queues';

// P2-4 Part 2: the ai.reply payload contract moved to `jobTypes` (alongside InboundWebhookJobData)
// so the producers can import it without pulling this 4700-line module in at runtime. Re-exported
// here because aiQueue/outboxRelay/workers already import it from this path.
export type { AIReplyJobData } from './jobTypes';

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
      { candidate: logSafe(firstName) },
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

  const conversation = await findConversationByIdForTenant(conversationId, tenantId);
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

  const latestMessages = await findMessagesByConversation(conversationId, 8, tenantId);
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

  const latestMessages = await findMessagesByConversation(conversationId, 8, tenantId);
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
const COMMISSION_SESSION_GAP_HOURS = knobNumber('COMMISSION_SESSION_GAP_HOURS');

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
  orderEventAt: Date | null = null,
  anchorOnOrderEvent = false,
): Promise<boolean> {
  // P2-2 (RC-22): the query is built by a pure helper so the anchoring change is unit-testable.
  // Flag-off reproduces the legacy NOW()-relative query byte-for-byte.
  const query = buildCommissionWindowQuery({
    conversationId,
    tenantId,
    sessionGapHours: COMMISSION_SESSION_GAP_HOURS,
    orderEventAt,
    anchorOnOrderEvent,
  });
  const { rows } = await pool.query<{ human_in_window: boolean }>(query.text, query.values);
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

// LOCALE EXTENSION: to support a new reply locale, add an entry to ALL of the
// following Record<ReplyLocale, …> tables:
//   HOLDING_MESSAGES, DATA_CONFIRMATION_MESSAGES, MISSING_CUSTOMER_NAME_MESSAGES  — now the
//     shared source of truth in services/cannedReplyText.ts (re-imported above; P2-3), and
//   ORDER_CONFIRMATION_FOLLOW_UP, VARIANT_CLARIFICATION_LEAD_IN below in this file.
// Also update productInformationGapHelpers.ts (see its InfoGapLocale checklist) and
// aiService.ts (ReplyLocale union + locale-dispatch tables there).

/**
 * Master switch for the additive uncertain-answer fallback layer (defaults ON).
 * When a tenant explicitly sets UNCERTAIN_ANSWER_FALLBACK_ENABLED=false the guard
 * never fires and the raw AI reply behaviour is preserved unchanged.
 */
const UNCERTAIN_ANSWER_FALLBACK_ENABLED =
  (process.env.UNCERTAIN_ANSWER_FALLBACK_ENABLED ?? 'true').trim().toLowerCase() !== 'false';

/**
 * P0-2 (RC-02): when ON, the price and product-name hallucination guards validate the
 * reply against the tenant's FULL active catalog (plus AI-config ground-truth prices)
 * instead of this turn's volatile `matchedProducts` retrieval window, and they run
 * even when that window is empty. Defaults OFF: flag-off preserves the legacy
 * matchedProducts-scoped behaviour byte-for-byte. Flip per environment (staging
 * first, EV-011/013/015 replay as the gate) per the remediation plan.
 */
const GUARD_VALIDATE_AGAINST_FULL_CATALOG =
  (process.env.GUARD_VALIDATE_AGAINST_FULL_CATALOG ?? 'false').trim().toLowerCase() === 'true';

/**
 * P3-5 (RC-25, rules R6/R13): extend the SAME full-catalog widening to the uncertain-answer
 * guard's alternatives carve-out, which `GUARD_VALIDATE_AGAINST_FULL_CATALOG` left behind on
 * this-turn's retrieval window. Flag-off is the legacy `matchedProducts.length > 0` byte-for-byte.
 */
const UNCERTAIN_GUARD_CATALOG_ALTERNATIVES = knobBool('UNCERTAIN_GUARD_CATALOG_ALTERNATIVES');

/**
 * P3-5 (RC-26, rule R10): run the model-authored-ETA strip on ordinary replies too, not only on
 * classifier-detected order confirmations. Strip-only — never injects a delivery line.
 */
const ETA_STRIP_ALL_REPLIES = knobBool('ETA_STRIP_ALL_REPLIES');

/**
 * P0-3 (RC-01): when ON, the product-information gap gate escalates only on
 * deterministic evidence — a requested structured attribute genuinely absent from
 * every signal (catalog fields, packaging reads, the availability classifier) or an
 * allowlisted free-form info gap (ingredients, usage, …). The LLM assessor's
 * stochastic `missing` labels alone never escalate, and an assessor that ERRORED
 * (transport/parse/empty) fails OPEN — the grounded AI reply is sent as-is instead of
 * being replaced with a holding message. Defaults OFF: flag-off preserves the legacy
 * fail-closed, LLM-driven behaviour byte-for-byte. Flip per environment (staging
 * first, IN1/IN3 golden-set replay as the gate) per the remediation plan.
 */
const GAP_GATE_DETERMINISTIC_FIRST =
  (process.env.GAP_GATE_DETERMINISTIC_FIRST ?? 'false').trim().toLowerCase() === 'true';

/**
 * P2-1 (RC-02/RC-01/RC-03): the CONSOLIDATED deterministic grounding gate. When ON, one gate
 * replaces the legacy price + product-name hallucination guards (validating the reply's asserted
 * prices/names against the tenant's FULL active catalog with TARGETED per-span action, never a
 * blanket replace) and forces the product-info gap gate onto its deterministic-first decision
 * (retiring the fail-closed assessor). Its single fail policy: a catalog-index infra error
 * escalates with the distinct retryable reason `grounding_check_unavailable` (fail CLOSED).
 * Defaults OFF: flag-off runs the legacy guards byte-for-byte. Meaningful with the facts_used
 * contract (FACTS_USED_CONTRACT); the gate also has a deterministic prose backstop so it still
 * validates when no facts were declared.
 */
const GROUNDING_GATE_CONSOLIDATED =
  (process.env.GROUNDING_GATE_CONSOLIDATED ?? 'false').trim().toLowerCase() === 'true';

/**
 * Minimum grounded characters that must survive a targeted strip before the gate escalates the
 * whole turn to a holding message instead. Keeps a reply that is nothing but a fabricated fact
 * from being sent as an empty/degenerate message. Read through the P2-7 manifest.
 */
const GROUNDING_GATE_STRIP_FLOOR = knobNumber('GROUNDING_GATE_STRIP_FLOOR');

/**
 * P3-1: the declared-attribute grounding lane — `off` | `shadow` | `enforce`.
 *
 * Read through `knobString` rather than a bare `process.env` compare. The three flags above are
 * pre-existing raw reads and are NOT the precedent to copy: the manifest is what makes a knob
 * band-checked, documented and fingerprinted, and this one is fingerprinted for a concrete reason
 * — two workers on different rungs would strip different replies from identical input.
 */
const GROUNDING_GATE_ATTRIBUTE_FACTS = knobString(
  'GROUNDING_GATE_ATTRIBUTE_FACTS',
) as AttributeGateMode;
const GROUNDING_ATTR_MAX_CLAIMS = knobNumber('GROUNDING_ATTR_MAX_CLAIMS');

/**
 * P0-4 (RC-19, RC-22): when ON, the pre-reply sensitive-escalation subsystem fails
 * CLOSED instead of open. A SENSITIVE detector throw (cancellation/refund,
 * wrong-product, post-purchase, order-info) routes to the safe escalation path
 * (pause + human_replied=false + alert + neutral holding message) instead of silently
 * downgrading to a normal sales reply; any other pre-send throw in the block re-throws
 * so BullMQ retries; and the post-send intent/draft-order swallow surfaces as a durable
 * `order_detection_failed` alert. A re-throw is scoped to the pre-send window so a retry
 * can never double-send a delivered reply/ack (RC-20). Defaults OFF: flag-off preserves
 * the legacy fail-OPEN umbrella (warn + continue) byte-for-byte. Flip per environment
 * (staging first, fault-injection replay as the gate) per the remediation plan.
 */
const SENSITIVE_PATH_FAIL_CLOSED =
  (process.env.SENSITIVE_PATH_FAIL_CLOSED ?? 'false').trim().toLowerCase() === 'true';

/**
 * P2-6 (RC-19): the graceful-degradation floor — ONE safe outcome when the provider fails
 * mid-turn, replacing ~21 independent fail-open guesses.
 *
 * The gate is TURN-level and reads a COUNTER, not an exception, and that is the whole design.
 * A `ProviderUnavailableError` cannot be caught reliably: ~21 classifiers in aiService.ts
 * swallow any error into a fail-open default (`classifySpeculativeHealthAdvice` returns
 * `false` — "no unsafe advice here" — on a transport error), and the sensitive umbrella below
 * swallows what escapes them. Worse, `generateReply` runs FIRST and is the biggest budget
 * consumer, so a per-turn deadline preferentially starves the GUARDS while preserving the
 * reply — shipping a fast unguarded reply where today we'd get a slow guarded one. Reading the
 * store at the pre-send gate is immune to both.
 *
 * This is also why the caps must never ship without it: on its own, a cap shorter than a blip
 * aborts the refund detector, the umbrella logs "continuing normal flow", and a SALES reply
 * goes to a refund demand — RC-19, but faster. Defaults OFF (byte-for-byte legacy).
 *
 * Read PER CALL (not frozen into a module const) because the manifest declares it
 * `binding: 'per-call'`, and the two must agree. A frozen read would be the worst of both: the
 * knob is excluded from the config fingerprint *because* it is per-call, so a fleet where one
 * worker missed the env update would report a single hash — "the fleet agrees" — while half the
 * workers shipped replies whose guards had fail-opened. It also has to share a lifetime with
 * OPENAI_CIRCUIT_BREAKER, which IS genuinely per-call: the breaker's rationale says it must never
 * be enabled without this flag, and two knobs with different lifetimes can't honour that pairing
 * during a rollout.
 */
function gracefulDegradeMode(): boolean {
  return knobBool('GRACEFUL_DEGRADE_MODE');
}

/**
 * P2-6: the breaker mode, per-call for the same reason as above (an incident must be able to flip
 * it without a redeploy). Passed to `snapshot()` only so a monitor-mode fleet is not recorded in
 * the ledger as if it were enforcing.
 */
function breakerMode(): BreakerMode {
  return knobString('OPENAI_CIRCUIT_BREAKER') as BreakerMode;
}

/**
 * P2-6: the shared per-turn OpenAI budget (ms). 0 (default) = off.
 *
 * Read once at module load because the knob is declared `binding: 'frozen'` — the manifest's
 * binding field drives config-fingerprint participation (RC-06's drift axis), so a `frozen`
 * knob that is actually re-read per call would make the fingerprint a lie.
 */
const OPENAI_TURN_DEADLINE_MS = knobNumber('OPENAI_TURN_DEADLINE_MS');

/**
 * TEST-ONLY fault injection for the P0-4 staging validation ("refund demand during an
 * OpenAI blip"). Set to a sensitive-detector label — 'cancellation_refund' |
 * 'wrong_product' | 'post_purchase' | 'order_info' | 'any' — and that detector throws
 * before running, inside runSensitiveDetector's try, so the forced failure takes exactly
 * the production error path (escalate under SENSITIVE_PATH_FAIL_CLOSED, warn+continue
 * legacy otherwise). NEVER set in production; it is logged loudly at boot when armed and
 * inert when unset.
 */
const TEST_FORCE_DETECTOR_ERROR = (process.env.TEST_FORCE_DETECTOR_ERROR ?? '')
  .trim()
  .toLowerCase();
if (TEST_FORCE_DETECTOR_ERROR) {
  console.warn(
    '[ai.reply] TEST_FORCE_DETECTOR_ERROR is ARMED — sensitive detector(s) will deliberately throw',
    { target: TEST_FORCE_DETECTOR_ERROR },
  );
}

/**
 * P0-6 (RC-18): when ON, the per-conversation 25/h budget counts only real DELIVERED
 * replies. The pre-gate INCR (which charged every job attempt — retries, stale-skipped,
 * disabled-AI, and fairness/lock/human-hold reschedules — and so tripped the cap on
 * phantom increments → permanent silence) is replaced by (a) a read-only pre-send cap
 * check and (b) an atomic count-once increment AFTER a reply is actually delivered, keyed
 * idempotently on the inbound message id so a BullMQ retry can never double-count. The
 * rolling-1h EXPIRE is set on the first real increment. Defaults OFF: flag-off preserves
 * the legacy pre-gate INCR path byte-for-byte. Flip per environment (staging first) per
 * the remediation plan.
 */
const RATE_LIMIT_COUNT_DELIVERED_ONLY =
  (process.env.RATE_LIMIT_COUNT_DELIVERED_ONLY ?? 'false').trim().toLowerCase() === 'true';

/**
 * P2-2 (RC-07/08/22): the deterministic order_stage machine. Tri-state:
 *  - 'off'   (default): the legacy LLM order-classifiers decide; the FSM never runs; no slot-store
 *            writes — flag-off preserves the legacy path byte-for-byte.
 *  - 'shadow': legacy still decides + acts, but the deterministic FSM verdict is computed and any
 *            divergence is logged ([ORDER_STAGE_DIVERGENCE]) + recorded in the P1-5 ledger; the slot
 *            store is populated so state accumulates for the next turn (the parity-measurement window).
 *  - 'on':   the FSM is authoritative for order creation and the three LLM order-classifiers
 *            (classifyNewOrderSignal, detectOrderAffirmationIntent, the order-closing loop) are
 *            skipped — RC-07's boost asymmetry and RC-22's 7-conjunct flip vanish (no confidence
 *            field on the consent path). Flip per environment (staging first, shadow-parity + the
 *            boundary/determinism corpus as the gate) per the remediation plan.
 */
const ORDER_STAGE_MACHINE_MODE = ((): 'off' | 'shadow' | 'on' => {
  const v = (process.env.ORDER_STAGE_MACHINE ?? 'off').trim().toLowerCase();
  return v === 'on' || v === 'shadow' ? v : 'off';
})();

/**
 * P2-2 (RC-22): when ON, the AI-order commission human-participation check anchors on the stored
 * consent-inbound timestamp instead of NOW() and bounds the window at that timestamp, so a retry /
 * late run (or a human reply during retry latency) cannot flip is_commissionable. Defaults OFF:
 * flag-off preserves the NOW()-relative query byte-for-byte.
 */
const COMMISSION_STORED_TIMESTAMP =
  (process.env.COMMISSION_STORED_TIMESTAMP ?? 'false').trim().toLowerCase() === 'true';

/**
 * P1-1 (RC-20): when the outbox relay owns dispatch (both flags on), the staged reply's
 * deterministic side-effects — the `ai_reply_sent` analytics event, the use-case-eval enqueue,
 * the delivered-reply rate count, and the send-failure / missing-image alerts — are written as
 * outbox rows INSIDE the flip transaction and performed exactly-once by the relay. The inline
 * tail versions below are skipped, so a crash between the flip commit and the tail can no
 * longer lose them. Off → the legacy inline tail runs as before (mirrors `outboxOwnsDelivery`
 * in processInboundMessage.ts).
 */
const OUTBOX_OWNS_REPLY_EFFECTS =
  (process.env.OUTBOX_RELAY_ENABLED ?? 'false').trim().toLowerCase() === 'true' &&
  (process.env.OUTBOX_DISPATCH_ENABLED ?? 'false').trim().toLowerCase() === 'true';

/**
 * P0-5 (RC-14, RC-06): when ON, a `rate_limit_exceeded` pause auto-expires — a new inbound
 * whose delivered-only (P0-6) rate counter has rolled over, with no open sensitive alert
 * and no active human hold, clears the pause and answers instead of leaving the
 * conversation permanently silent. (The alert-resolution default-resume half of P0-5 lives
 * in `aiAlertController`.) Defaults OFF: flag-off leaves every pause exiting only via an
 * explicit human resume, byte-for-byte. Flip per environment (staging first) per the
 * remediation plan.
 */
const AI_AUTO_RESUME =
  (process.env.AI_AUTO_RESUME ?? 'false').trim().toLowerCase() === 'true';

/**
 * Cap on how many full-catalog names are handed to the name-guard LLM classifier when
 * the retrieval window is empty. The deterministic full-catalog verification that
 * follows is uncapped, so a name outside this sample is still rescued — the cap only
 * bounds prompt size for very large catalogs.
 */
const NAME_GUARD_LLM_CATALOG_CAP = (() => {
  const n = parseInt(process.env.NAME_GUARD_LLM_CATALOG_CAP || '150', 10);
  return Number.isFinite(n) && n > 0 ? n : 150;
})();

/**
 * P1-3 (RC-08) boundary observability: when CONFIDENCE_CONTRACT_SYMMETRY is ON, emit a
 * structured marker whenever a confidence/score falls inside the abstain band around a hard
 * gate — the boundary phrasing that used to flip outcome-class run-to-run. Grep
 * `[CONFIDENCE_GATE]` to measure how often decisions land in the band. Inert when the flag is
 * OFF. The log line is unconditional; the operator alert additionally requires `alertEligible`
 * — the caller's assertion that the in-band score was the binding constraint on the gated
 * action (all other preconditions held), so only genuine boundary ambiguities reach a human.
 */
function logConfidenceGateBoundary(
  gate: string,
  confidence: number,
  threshold: number,
  ctx: { tenantId: string; conversationId: string; inboundExternalId?: string },
  alertEligible: boolean,
): void {
  if (!CONFIDENCE_CONTRACT_SYMMETRY) return;
  const verdict = classifyConfidenceGate({
    confidence,
    threshold,
    band: CONFIDENCE_HYSTERESIS_BAND,
    applySymmetry: true,
  });
  if (verdict !== 'abstain') return;
  console.info(
    `[CONFIDENCE_GATE] gate: ${gate} verdict: abstain confidence: ${confidence} threshold: ${threshold} band: ${CONFIDENCE_HYSTERESIS_BAND} tenantId: ${ctx.tenantId} conversationId: ${ctx.conversationId}`,
  );
  // The operator ALERT below fires only when `alertEligible` — when the in-band score was the
  // BINDING constraint on the gated action. The log line above stays unconditional (P1-3
  // observability). An in-band score on a gate whose other preconditions already fail is not an
  // ambiguity a human can act on: an order-intent score of 0.80 while name/phone/address are
  // still missing means no order was possible at ANY score and the AI is mid-collection — an
  // alert there is noise on every healthy order flow. Likewise a boolean-intent gate whose
  // verdict was negative (is_refund=false at 0.82) is not a near-missed refund.
  if (!alertEligible) return;
  // P1-3 (RC-08): an in-band score is a genuine ambiguity — the gated action does not fire,
  // but a human should see it (a refund demand at 0.82 must not vanish into a normal sales
  // reply with only a log line, and an in-band order-intent score is a warm lead worth a
  // follow-up). Non-pausing, fail_closed=false (a real boundary case, not a degradation),
  // deduped per (conversation, gate, inbound) so a BullMQ retry cannot double-alert. Entirely
  // best-effort: an alert failure never touches the reply path. The UI also polls alerts, so
  // no per-alert socket payload is needed here (mirrors the outbox relay's alert dispatch).
  void (async () => {
    try {
      if (ctx.inboundExternalId) {
        const marker = `ai_abstain_alert:${ctx.conversationId}:${gate}:${ctx.inboundExternalId}`;
        const set = await redisConnection
          .set(marker, '1', 'EX', 6 * 3600, 'NX')
          .catch(() => null);
        if (set !== 'OK') return;
      }
      await createAIAlert({
        tenant_id: ctx.tenantId,
        conversation_id: ctx.conversationId,
        message_id: null,
        reason: 'confidence_band_abstain',
        details: { gate, confidence, threshold, band: CONFIDENCE_HYSTERESIS_BAND },
      });
      socketService.emitConversationUpdated(ctx.tenantId, ctx.conversationId);
    } catch (err) {
      console.warn('[CONFIDENCE_GATE] abstain alert failed (ignored)', {
        gate,
        conversationId: ctx.conversationId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

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
  _orderClosingAlreadyAskedInConversation: boolean,
): Promise<string> {
  const reply = (replyText ?? '').trim();
  if (!reply) return reply;
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
 * Strips generic follow-up invitations from the AI reply when `shouldStrip` is true.
 *
 * Examples of stripped phrases: "më tregoni", "më shkruani", "let me know",
 * "feel free to ask", "anything else?", "nëse keni pyetje jemi këtu",
 * "don't hesitate to reach out".
 *
 * This is applied to ALL non-order-confirmation replies unconditionally, enforcing
 * the business rule that product, price, stock, and comparison replies must end
 * immediately after the answer — no closing invitation appended.
 *
 * Uses `classifyFollowUpInvitationInReply` (LLM-first, regex fallback) for the
 * whole-reply gate so novel phrasings beyond the known list are caught. Per-sentence
 * stripping uses the fast synchronous regex to isolate exactly which sentence to drop.
 */
async function stripGenericFollowUpInvitation(
  replyText: string,
  shouldStrip: boolean,
): Promise<string> {
  const reply = (replyText ?? '').trim();
  if (!reply) return reply;
  if (!shouldStrip) return reply;

  // LLM-first whole-reply check: catches novel phrasings beyond the known regex list.
  const hasInvitation = await classifyFollowUpInvitationInReply(reply);
  if (!hasInvitation) return reply;

  // Per-sentence stripping: regex identifies exactly which sentence(s) to remove.
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

  // The LLM confirmed an invitation exists but the regex couldn't isolate the sentence
  // (novel phrasing). Remove the last sentence as the safest heuristic — follow-up
  // invitations are almost always the closing sentence of a reply.
  if (sentences.length > 1) {
    return sentences.slice(0, -1).join(' ').trim();
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
    /(defekt|prish|problem me produkt|damaged|broken|faulty|defective)/.test(normalized) ||
    // P2-5 (RC-25): Gheg negation/copula parity with hasDeliveryEtaOnlyCue below, which
    // already accepts ska|s'ka. Two cues reading the same message disagreed on dialect:
    // a Gheg "ska ardh" was a complaint to one and invisible to the other.
    (GHEG_LEXICONS && GHEG_POST_PURCHASE_EXTRA_PATTERNS.some((re) => re.test(normalized)))
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
    // P1-3 edge case: common Albanian/Gheg consents the lexicon previously missed —
    // "në rregull" (alright; diacritics are stripped by the normalizer), "mirë" (fine),
    // "dakord" (agreed), "pranoj" (I accept), and the Gheg imperatives "bone"/"boje"/
    // "kryeje" ("do it" / "complete it"), incl. "veç/vec bone" ("just do it"). These are
    // only consulted as order consent AFTER a data-confirmation request was sent (see
    // recentCustomerAffirmation), so a stray "mirë" in open conversation cannot create
    // an order on its own.
    /^(ne rregull|nrregull|mire|shume mire|dakord|pranoj|pranoje)\b/.test(normalized) ||
    /^((vec|veq)\s+)?(bone|boje|kryeje|kryej)\b/.test(normalized) ||
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
  return knobNumber('AI_MAX_CONCURRENT_PER_TENANT');
})();
/**
 * Legacy flat backoff, used only when `AI_FAIRNESS_MODE=legacy` (the default).
 *
 * P3-2 note: this was a hard-coded literal outside the knob manifest and outside `.env.example`, so
 * the one number governing the re-add loop's aggressiveness could not be tuned without a deploy.
 * The bounded path reads `AI_FAIRNESS_BASE_DELAY_MS` instead.
 */
const AI_FAIRNESS_BACKOFF_MS = 3000;

/**
 * P3-2 Step 9: `bounded` replaces the C-79 re-add loop with lease-based slots, a deterministic
 * job id, exponential jittered backoff and a hop budget. `legacy` (default) preserves today's
 * path byte-for-byte, including the flat 3 s re-add and the `INCR`/`DECR` counter.
 */
const AI_FAIRNESS_BOUNDED = knobString('AI_FAIRNESS_MODE') === 'bounded';

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

// The atomic "count this delivered reply once" script (P0-6, RC-18) lives in
// services/rateLimitDeliveredCount.ts alongside the other pure pieces, so the
// integration suite can exercise it against a real Redis without importing this
// module; countDeliveredReplyOnce below is its only production caller.

/**
 * Charge the 25/h budget for a delivered reply exactly once (P0-6). Idempotent by the
 * per-inbound marker, so a BullMQ retry that re-reaches the persist step (self-heal path)
 * does not double-count. Best-effort: a Redis error must never break an already-delivered
 * reply, so failures are swallowed.
 */
async function countDeliveredReplyOnce(
  counterKey: string,
  markerKey: string,
  ttlSeconds = 3600,
): Promise<void> {
  await redisConnection
    .eval(RATE_LIMIT_DELIVERED_INCR_SCRIPT, 2, counterKey, markerKey, String(ttlSeconds))
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Per-conversation processing lock
//
// The worker runs multiple AI jobs concurrently, and there is no other
// guarantee that two jobs for the SAME conversation (e.g. a retried job plus a
// newer inbound's job, or two rapid inbounds) won't execute at the same time.
// Concurrent/out-of-order processing of one conversation scrambles the loaded
// history and product context and can produce contradictory replies. This lock
// serializes processing per conversation: only one job runs at a time; the rest
// re-delay themselves until the lock is free. The stale-inbound guard inside the
// job then ensures the surviving job answers the latest message.
//
// SET NX PX gives an atomic acquire-with-TTL; the TTL bounds the lock so a
// crashed job cannot wedge a conversation permanently. Release is token-checked
// so a job can never delete a lock that a later job acquired after TTL expiry.
// ---------------------------------------------------------------------------
const CONVERSATION_LOCK_TTL_MS = (() => {
  return knobNumber('AI_CONVERSATION_LOCK_TTL_MS');
})();

const CONVERSATION_LOCK_RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * P2-6 (F1): BullMQ attempt position, threaded from the worker so the final attempt of a
 * provider-caused failure can resolve to the degradation floor instead of dead-lettering into
 * customer silence. Absent (direct calls, tests) → treated as final: when in doubt, the customer
 * gets the holding message rather than nothing.
 */
export interface AIReplyAttemptInfo {
  /** `job.attemptsMade` as seen inside the processor (BullMQ v5: includes the current attempt). */
  made: number;
  /** `job.opts.attempts` — the configured maximum. */
  total: number;
}

export async function processAIReply(data: AIReplyJobData, attempt?: AIReplyAttemptInfo): Promise<void> {
  // P1-5 (C-108): every OpenAI call this job makes — classifiers, embeddings, and the main
  // reply — is recorded (model + usage + USD cost, no text) into an AsyncLocalStorage context
  // the ledger writer folds into `usage.calls`, so per-reply COGS covers all ~18–25 calls,
  // not just the main completion.
  //
  // P2-4 Part 1 (C-109): nest a log-correlation scope inside the call tracker so every log line
  // and Sentry event under this job carries the per-message ids without threading them through
  // any signature. `correlationId` is the per-message key (burst-merge collapses `traceId`), so
  // grep-by-correlationId reconstructs one reply's whole lifecycle across generateReply + the
  // classifiers. Both scopes only nest the existing single call — no control-flow change.
  //
  // P2-4 Part 2 (RC-17): a third scope, same rationale — it carries the receipt snapshot down to
  // `loadAIConfig` (six frames below) as a cache staleness floor, without a `generateReply`
  // signature change. Undefined snapshot → every consumer behaves exactly as before.
  //
  // P2-6 (RC-19): a fourth scope — the shared per-turn OpenAI budget + this turn's provider-failure
  // ledger. Same reason the others nest here: it reaches all ~25 call sites through the wrapper on
  // the SDK singleton without touching one of them. Outside this scope (product imports, crons, the
  // offline eval) the wrapper is a pure pass-through. With OPENAI_TURN_DEADLINE_MS at its default 0
  // there is no deadline, but the store still records failures — which is exactly the step-1
  // rollout (degrade on, caps off).
  return runWithOpenAICallTracking(() =>
    runWithLogContext(
      {
        traceId: data.traceId ?? null,
        correlationId: data.messageExternalId,
        tenantId: data.tenantId,
        conversationId: data.conversationId,
        component: 'processAIReply',
      },
      () =>
        runWithReceiptSnapshot(data.receiptSnapshot, () =>
          runWithTurnResilience(OPENAI_TURN_DEADLINE_MS, () => processAIReplyInner(data, attempt)),
        ),
    ),
  );
}

async function processAIReplyInner(data: AIReplyJobData, attempt?: AIReplyAttemptInfo): Promise<void> {
  const { tenantId, channelId, conversationId, traceId } = data;
  logger.info('[ai.reply] processAIReply start', { traceId, tenantId, conversationId });

  // ---- P1-5: AI decision ledger accumulator -------------------------------
  // Per-classifier decision events, pushed co-located with each gate's existing [X] log. The
  // correlation id is per-message (the logical inbound this reply answers) so burst-merge does
  // not collapse it. All ledger writes are gated by AI_DECISION_LEDGER_ENABLED (default off).
  const decisionEvents: LedgerDecisionEvent[] = [];
  const recordDecision = (event: LedgerDecisionEvent): void => {
    decisionEvents.push(event);
  };
  const ledgerCorrelationId = data.messageExternalId;

  /**
   * P2-4 (F1): every ledger row this job writes — answered turns included, not just gate drops —
   * carries the receipt-vs-live comparison by default. An answered turn that raced a mid-window
   * toggle was previously invisible: only drop rows recorded the snapshot, so "processed under
   * state that had changed since receipt" could never be queried for the turns that were actually
   * ANSWERED. Null until the gate state is loaded (pre-gate drops keep their explicit payloads —
   * an explicit `receiptSnapshot` in the input always wins over this default).
   */
  let liveGateStateForLedger: (() => Partial<LiveGateState>) | null = null;
  const answeredReceiptComparison = () =>
    liveGateStateForLedger
      ? compareSnapshotToLive(data.receiptSnapshot, liveGateStateForLedger(), Date.now())
      : null;
  const buildJobLedgerRecord = (input: BuildLedgerRecordInput) =>
    buildLedgerRecord({ receiptSnapshot: answeredReceiptComparison() ?? undefined, ...input });

  /**
   * P2-4 Part 2 (RC-06): leave an artifact when this job DROPS a received message.
   *
   * Every gate below is `console.info` + bare `return`, and the file's first ledger write is ~500
   * lines further down — so a dropped message produced no queryable record at all. That is RC-06's
   * literal complaint ("no artifact that a received message was discarded"), and it is the half the
   * receipt snapshot exists to close: the gates keep reading LIVE state (see
   * services/receiptSnapshot.ts for why snapshot-governance is unsafe), and this records what the
   * state was at receipt, what it was at evaluation, and whether the two disagree.
   *
   * A `diverged` entry means the outcome turned on a mid-window toggle rather than on content —
   * exactly the identical-messages-diverge signal RC-06 describes and nothing could previously see.
   *
   * Per-gate reply slot: `deriveReplyIdempotencyKey` is slot-keyed and the insert is ON CONFLICT DO
   * NOTHING, so a single `'none'` slot would let the first drop of an inbound mask every later one
   * (a job re-enqueued by the fairness/lock backoff can legitimately drop at a different gate).
   * Fire-and-forget: a telemetry write must never affect the drop itself.
   */
  const recordGateDrop = (
    gate: string,
    live: Partial<LiveGateState>,
    // 'dropped' — the message is discarded, permanently. 'deferred' — rescheduled, will still be
    // answered. Distinguishing them matters: a deferral is not a lost message, and conflating the
    // two would make the RC-06 drop-rate metric read high for turns that were merely delayed.
    outcome: 'dropped' | 'deferred' = 'dropped',
  ): void => {
    const comparison = compareSnapshotToLive(data.receiptSnapshot, live, Date.now());
    void writeLedgerBestEffort(
      buildJobLedgerRecord({
        tenantId,
        conversationId,
        correlationId: ledgerCorrelationId,
        traceId,
        replySlot: `none:gate:${gate}`,
        decisionKind: `no_reply:${gate}`,
        messageId: null,
        decisionEvents,
        guardVerdicts: { gate, outcome },
        receiptSnapshot: comparison,
      }),
    );
  };

  /**
   * P3-2 Step 9 (C-79): defer this job with a bounded, jittered, collapsing re-add — or shed it
   * loudly once the hop budget is exhausted.
   *
   * The legacy path re-added with a flat 3 s delay and NO jobId, so N starved jobs became N new
   * jobs every 3 s, each with `attemptsMade` reset to 0. A shed here is deliberately an EXCEPTION,
   * not a `return`: `failureHandler` attaches to `worker.on('failed')` only, so a bare return is a
   * *successful* job — no dead_letter row, no Sentry, no `ai_reply_undelivered` alert, and a
   * customer message silently gone.
   *
   * It must NOT pause the conversation. Capacity is a global, our-side condition; `ai_paused` has
   * no automatic exit (`AI_AUTO_RESUME` defaults off and covers only `rate_limit_exceeded`), so
   * pausing would convert a transient burst into permanent per-conversation silence — the exact
   * fan-out the P2-6 degradation floor is forbidden from causing.
   */
  const deferOrShed = async (gate: 'tenant_capacity' | 'conversation_busy'): Promise<void> => {
    const decision = decideAdmission({
      hop: data.fairnessHop,
      gate,
      // The only entropy source in the path. Kept out of `decideAdmission` so the decision itself
      // stays a pure, testable mapping.
      jitter: Math.random(),
      policy: {
        baseDelayMs: knobNumber('AI_FAIRNESS_BASE_DELAY_MS'),
        maxDelayMs: knobNumber('AI_FAIRNESS_MAX_DELAY_MS'),
        maxHops: knobNumber('AI_FAIRNESS_MAX_HOPS'),
        jitterRatio: DEFAULT_ADMISSION_POLICY.jitterRatio,
      },
    });

    if (decision.action === 'shed') {
      recordGateDrop(gate, {}, 'dropped');
      console.warn('[ai.reply] Admission shed — hop budget exhausted', {
        tenantId,
        conversationId,
        gate,
        hops: decision.hops,
      });
      throw new AdmissionShedError(decision.reason, decision.hops, gate);
    }

    // Recorded as 'deferred', never 'dropped': the message is still going to be answered, and
    // conflating the two would make the RC-06 drop-rate metric read high for merely-delayed turns.
    recordGateDrop(gate, {}, 'deferred');
    await aiQueue.add(
      'ai.reply',
      buildAIReplyJobData({ ...data, fairnessHop: decision.nextHop }),
      {
        delay: decision.delayMs,
        // THE line that stops the amplifier: BullMQ ignores an add whose jobId already exists, so
        // concurrent deferrals of the same inbound at the same hop collapse into ONE job.
        jobId: admissionJobId(conversationId, data.messageExternalId, decision.nextHop),
      },
    );
    console.info('[ai.reply] Admission deferred', {
      tenantId,
      conversationId,
      gate,
      hop: normalizeHop(data.fairnessHop),
      nextHop: decision.nextHop,
      delayMs: decision.delayMs,
    });
  };

  // ---- Per-conversation serialization lock ---------------------------------
  // Acquired BEFORE the tenant slot (P3-2 Step 9c). The legacy order took a slot, immediately
  // discovered the conversation was busy, and gave the slot straight back — briefly consuming
  // capacity that a runnable job for another conversation could have used.
  const conversationLockKey = `ai_conv_lock:${conversationId}`;
  const conversationLockToken = crypto.randomUUID();
  const conversationLockAcquired = await redisConnection
    .set(conversationLockKey, conversationLockToken, 'PX', CONVERSATION_LOCK_TTL_MS, 'NX')
    .then((res) => res === 'OK')
    .catch(() => false);

  if (!conversationLockAcquired) {
    if (AI_FAIRNESS_BOUNDED) {
      await deferOrShed('conversation_busy');
      return;
    }
    await aiQueue.add('ai.reply', data, { delay: AI_FAIRNESS_BACKOFF_MS });
    console.info('[ai.reply] Conversation busy — re-delayed job to serialize processing', {
      tenantId,
      conversationId,
      backoffMs: AI_FAIRNESS_BACKOFF_MS,
    });
    return;
  }

  let conversationLockReleased = false;
  const releaseConversationLock = async (): Promise<void> => {
    if (conversationLockReleased) return;
    conversationLockReleased = true;
    await redisConnection
      .eval(CONVERSATION_LOCK_RELEASE_SCRIPT, 1, conversationLockKey, conversationLockToken)
      .catch(() => undefined);
  };

  // ---- Per-tenant fairness ------------------------------------------------
  const tenantActiveKey = `ai_active_jobs:${tenantId}`;
  const slotToken = tenantSlotMember(conversationId, conversationLockToken);
  let tenantSlotReleased = false;
  let releaseTenantSlot: () => Promise<void>;
  let admitted: boolean;
  let activeCount = 0;

  if (AI_FAIRNESS_BOUNDED) {
    // Lease-based (P3-2 Step 9a). Each slot expires independently, so a crashed job costs ONE slot
    // for one TTL instead of corrupting a shared counter — the legacy `INCR`/`DECR` pair could go
    // negative and TTL-less once its single un-refreshed `EXPIRE` fired mid-flight, silently
    // disabling the cap for exactly the burst-traffic tenant it exists to contain.
    const raw = await redisConnection
      .eval(
        TENANT_SLOT_ACQUIRE_SCRIPT,
        1,
        tenantSlotKey(tenantId),
        String(Date.now()),
        String(CONVERSATION_LOCK_TTL_MS),
        slotToken,
        String(AI_MAX_CONCURRENT_PER_TENANT),
      )
      .catch(() => null);
    // Fail OPEN on a Redis error: refusing to reply because the fairness bookkeeping blipped would
    // trade a capacity concern for customer silence.
    const parsed = raw === null ? { acquired: true, active: 0 } : parseAcquireResult(raw);
    admitted = parsed.acquired;
    activeCount = parsed.active;
    releaseTenantSlot = async (): Promise<void> => {
      if (tenantSlotReleased) return;
      tenantSlotReleased = true;
      await redisConnection
        .eval(TENANT_SLOT_RELEASE_SCRIPT, 1, tenantSlotKey(tenantId), slotToken)
        .catch(() => undefined);
    };
  } else {
    activeCount = await redisConnection.incr(tenantActiveKey);
    // Safety TTL: if the process crashes mid-job the key will expire rather than
    // permanently blocking the tenant. 5 minutes >> any normal job duration.
    if (activeCount === 1) {
      await redisConnection.expire(tenantActiveKey, 300);
    }
    admitted = activeCount <= AI_MAX_CONCURRENT_PER_TENANT;
    if (!admitted) {
      // Decrement immediately — this job is not actually running yet.
      await redisConnection.decr(tenantActiveKey);
    }
    releaseTenantSlot = async (): Promise<void> => {
      if (tenantSlotReleased) return;
      tenantSlotReleased = true;
      await redisConnection.decr(tenantActiveKey).catch(() => undefined);
    };
  }

  if (!admitted) {
    // Release the lock we already hold so the conversation is not blocked while we wait for
    // capacity — the deferred job re-acquires it on its next hop.
    await releaseConversationLock();
    if (AI_FAIRNESS_BOUNDED) {
      await deferOrShed('tenant_capacity');
      return;
    }
    await aiQueue.add('ai.reply', data, { delay: AI_FAIRNESS_BACKOFF_MS });
    console.info('[ai.reply] Tenant at concurrency limit — re-delayed job', {
      tenantId,
      conversationId,
      activeCount,
      maxAllowed: AI_MAX_CONCURRENT_PER_TENANT,
      backoffMs: AI_FAIRNESS_BACKOFF_MS,
    });
    return;
  }

  // P2-6 (F1): the degradation floor is defined deep inside the try (it closes over the loaded
  // conversation/channel/history), so the outer catch below can only reach it through this hoisted
  // reference — which doubles as the "prerequisites are loaded" guard: still null ⇒ the throw
  // happened before the floor could safely run.
  let degradeFloorFn: (() => Promise<boolean>) | null = null;
  // Flipped to false at the send transition: a throw after that point may have a reply on the
  // wire, and stacking a holding message on top of (or instead of) a delivered reply is worse
  // than the retry/DLQ path.
  let preSendPhase = true;
  const isFinalAttempt = attempt == null || attempt.made >= attempt.total;

  try {

  // ---- Per-conversation rate limit (atomic) --------------------------------
  const aiMaxRepliesPerHour = knobNumber('AI_MAX_REPLIES_PER_HOUR');
  const rateLimitKey = `ai_rate_limit:${conversationId}`;
  let overLimit = false;
  if (RATE_LIMIT_COUNT_DELIVERED_ONLY) {
    // P0-6 (RC-18): count only DELIVERED replies. Enforce the cap here with a READ-ONLY
    // check (the increment happens post-send), so retries / stale-skipped / disabled-AI /
    // rescheduled jobs never burn budget. Skip the cap entirely for an inbound we've
    // ALREADY counted — that is a retry of a delivered reply that should self-heal, not
    // re-pause (a naive GET >= max would read the boundary count and spuriously re-pause
    // the very reply that hit the cap). Fail OPEN on a Redis error: let the reply through
    // rather than silence the customer on a blip.
    const rateMarkerKey = rateCountedMarkerKey(conversationId, data.messageExternalId);
    const alreadyCounted =
      (await redisConnection.exists(rateMarkerKey).catch(() => 0)) === 1;
    if (!alreadyCounted) {
      const currentCount =
        parseInt((await redisConnection.get(rateLimitKey).catch(() => '0')) ?? '0', 10) || 0;
      overLimit = isOverDeliveredRateLimit(currentCount, aiMaxRepliesPerHour);
    }
  } else {
    // Legacy: charge every job attempt before the gates (the RC-18 behaviour, preserved
    // byte-for-byte when the flag is off).
    const rateCount = (await redisConnection.eval(
      RATE_LIMIT_INCR_SCRIPT,
      1,
      rateLimitKey,
      '3600',
    )) as number;
    overLimit = rateCount > aiMaxRepliesPerHour;
  }
  if (overLimit) {
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
      // P0-5: record the pause reason so the rate-limit auto-expiry (part 3) can identify
      // and clear this pause once the (delivered-only, P0-6) counter has rolled over.
      await setConversationAiPaused(conversationId, tenantId, true, client, 'rate_limit_exceeded');
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
      logger.error('[ai.reply] Rate limit pause / alert failed', err, { conversationId, tenantId });
    } finally {
      client.release();
    }
    if (alert) {
      const channel = await findChannelById(channelId, tenantId);
      if (channel) {
        const conversation = await findConversationByIdForTenant(conversationId, tenantId);
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
    recordGateDrop('rate_limit', {});
    return;
  }

  // Level 1: Global AI toggle
  const aiConfig = await findAIConfigByTenant(tenantId);
  if (!aiConfig?.is_active) {
    console.info('[ai.reply] AI globally disabled for tenant, skipping', { tenantId });
    recordGateDrop('ai_globally_disabled', {
      aiActive: aiConfig?.is_active ?? false,
      aiConfigVersion: aiConfigVersion(aiConfig?.updated_at ?? null),
    });
    return;
  }

  // Level 2: Per-channel toggle
  const channel = await findChannelById(channelId, tenantId);
  if (!channel) {
    console.warn('[ai.reply] Channel not found, skipping', { channelId, tenantId });
    recordGateDrop('channel_not_found', { aiActive: aiConfig.is_active });
    return;
  }

  if (!channel.ai_enabled) {
    console.info('[ai.reply] AI disabled for channel, skipping', { channelId });
    recordGateDrop('ai_disabled_for_channel', {
      aiActive: aiConfig.is_active,
      aiConfigVersion: aiConfigVersion(aiConfig.updated_at),
      channelAiEnabled: channel.ai_enabled,
    });
    return;
  }

  // Level 3: Per-conversation controls
  const conversation = await findConversationByIdForTenant(conversationId, tenantId);
  if (!conversation) {
    console.warn('[ai.reply] Conversation not found, skipping', { conversationId });
    recordGateDrop('conversation_not_found', {
      aiActive: aiConfig.is_active,
      channelAiEnabled: channel.ai_enabled,
    });
    return;
  }

  /** The live gate state this job evaluated — the RC-06 comparison target for the drops below. */
  const liveGateState = (): Partial<LiveGateState> => ({
    aiActive: aiConfig.is_active,
    aiConfigVersion: aiConfigVersion(aiConfig.updated_at),
    channelAiEnabled: channel.ai_enabled,
    conversationAiPaused: conversation.ai_paused,
    humanOverrideUntil: conversation.human_override_until
      ? new Date(conversation.human_override_until).toISOString()
      : null,
  });
  // P2-4 (F1): from here on, every ledger row defaults to the receipt-vs-live comparison.
  liveGateStateForLedger = liveGateState;

  if (conversation.ai_paused) {
    // P0-5 (RC-14) part 3: a rate_limit_exceeded pause auto-expires once the delivered-only
    // (P0-6) counter has rolled over. Runs inside the per-conversation lock (acquired
    // above), so the resume write cannot race another job for this conversation. All
    // Redis/DB probes fail SAFE (treat as "do not resume") so a blip never spuriously
    // resumes a paused conversation.
    let autoResumed = false;
    if (AI_AUTO_RESUME && conversation.ai_paused_reason === 'rate_limit_exceeded') {
      const rateKeyExists =
        (await redisConnection.exists(`ai_rate_limit:${conversationId}`).catch(() => 1)) === 1;
      const humanOverrideActive =
        !!conversation.human_override_until &&
        new Date(conversation.human_override_until) > new Date();
      const hasOpenSensitiveAlert = await hasOpenSensitiveAlertForConversation(
        conversationId,
        tenantId,
      ).catch(() => true);
      if (
        shouldAutoResumeRateLimitPause({
          autoResumeEnabled: AI_AUTO_RESUME,
          aiPaused: true,
          reason: conversation.ai_paused_reason,
          rateKeyExists,
          hasOpenSensitiveAlert,
          humanOverrideActive,
        })
      ) {
        await setConversationAiPaused(conversationId, tenantId, false);
        // Keep the in-memory object consistent for the rest of the job (the resume also
        // cleared the pause metadata and any human hold in the DB).
        conversation.ai_paused = false;
        conversation.ai_paused_reason = null;
        conversation.ai_paused_at = null;
        conversation.human_override_until = null;
        autoResumed = true;
        console.info('[ai.reply] Auto-resumed rate-limit pause — counter rolled over', {
          conversationId,
          tenantId,
        });
      }
    }
    if (!autoResumed) {
      console.info('[ai.reply] AI paused for conversation, skipping', { conversationId });
      // Note the gate above is deliberately still the LIVE row: the auto-resume block is nested
      // inside it and holds this job's only pause-clearing write, so a snapshot-governed gate would
      // skip the resume and strand the conversation — the RC-14 dead-end P0-5 closed.
      recordGateDrop('ai_paused', liveGateState());
      return;
    }
  }

  if (conversation.human_override_until && new Date(conversation.human_override_until) > new Date()) {
    console.info('[ai.reply] Human override active, skipping', {
      conversationId,
      until: conversation.human_override_until,
    });
    // The hold auto-releases shortly; make sure the customer's latest message still gets a
    // reply afterwards instead of leaving the conversation silent.
    // The hold is the ONE gate with a genuine backstop — it is only ever written atomically
    // alongside a human message — and it DEFERS rather than drops, so it stays live and keeps the
    // reschedule. Recorded as 'deferred': the turn is delayed, not lost.
    recordGateDrop('human_override_active', liveGateState(), 'deferred');
    await rescheduleReplyAfterHumanHold(data, new Date(conversation.human_override_until));
    return;
  }

  const recentMessages = await findMessagesByConversation(conversationId, HISTORY_FETCH_LIMIT, tenantId);
  const { latestInbound: lastInbound, mergedInboundText, mergedAttachmentUrls } =
    buildInboundBurstContext(recentMessages);
  if (!lastInbound) {
    console.info('[ai.reply] No inbound message found in conversation, skipping', { conversationId });
    // P2-4 (F8): even this oddball drop leaves an artifact — RC-06's accounting must not exclude
    // a class of discarded messages just because the drop reason is rare.
    recordGateDrop('no_inbound', liveGateState());
    return;
  }
  if (lastInbound.external_message_id !== data.messageExternalId) {
    console.info('[ai.reply] Skipping stale AI job because a newer inbound message exists', {
      conversationId,
      scheduledFor: data.messageExternalId,
      latestInboundExternalId: lastInbound.external_message_id,
    });
    // P2-4 (F8): 'deferred', not 'dropped' — the newer inbound's own job answers the conversation,
    // so this message is superseded rather than lost; conflating the two would inflate the RC-06
    // drop-rate metric on every burst.
    recordGateDrop('superseded_by_newer_inbound', liveGateState(), 'deferred');
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
  const replyLanguage = await detectReplyLanguage(
    inboundText,
    recentMessages,
    STICKY_LOCALE_SLOT ? (conversation.reply_locale ?? null) : null,
  );
  // P2-2 (RC-10): persist the resolved locale as the sticky slot for subsequent turns.
  if (STICKY_LOCALE_SLOT && conversation.reply_locale !== replyLanguage) {
    await setStickyReplyLocale(conversationId, tenantId, replyLanguage).catch((e) =>
      logger.warn('[STICKY_LOCALE] persist failed', { conversationId, err: String(e) }),
    );
  }
  logger.info('[REPLY_LANGUAGE]', {
    tenantId,
    conversationId,
    language: replyLanguage,
    traceId,
  });

  // P0-4 (RC-19): tracks whether the sensitive special-path block has already put an
  // outbound message on the wire. A fail-closed re-throw for a BullMQ retry must never
  // fire once a send/ack has gone out, or the retry would re-run the whole job and
  // double-send it (RC-20). Set to true immediately after every send in the block.
  let sensitivePathOutboundSent = false;

  // P1-1 (RC-20): stage-and-send for the canned pre-reply sends (holding / ack / confirm /
  // clarify). When staging is enabled for this channel the text is staged durably BEFORE the
  // send under its own reply slot, so a BullMQ retry after a crash can never deliver a second
  // copy of the canned message or persist a duplicate row under a fresh ai_uuid. Returns null
  // when staging is off — the call site keeps its legacy send-then-createMessage path
  // byte-for-byte. (The side-effects around these sends — alerts, pauses, order flags — keep
  // their legacy retry semantics; only the send+persist pair is made idempotent here.)
  const stageCannedReply = async (args: {
    replySlot: ReplySlot;
    text: string;
    contact: Awaited<ReturnType<typeof findContactById>>;
  }): Promise<{
    outboundMessage?: Message;
    sendResult: Awaited<ReturnType<typeof sendMessage>> | null;
    wasFirstDelivery: boolean;
  } | null> => {
    if (!isStageBeforeSendEnabled(channel.type)) return null;
    const result = await stageAndSend({
      tenantId,
      conversationId,
      channelType: channel.type,
      logicalInboundExternalId: data.messageExternalId,
      replySlot: args.replySlot,
      replyText: args.text,
      send: (text) =>
        args.contact
          ? sendMessage(channel, args.contact.external_id, text)
          : Promise.resolve({ success: false, error: 'Contact not found for conversation' }),
    });
    return {
      outboundMessage: result.outboundMessage,
      sendResult: result.sendResult ?? null,
      wasFirstDelivery: result.wasFirstDelivery,
    };
  };

  // P0-4 (RC-19): the safe escalation path invoked when a SENSITIVE pre-reply detector
  // (cancellation/refund, wrong-product, post-purchase, order-info) throws. Instead of
  // silently downgrading to a normal sales reply, pause the AI, keep human_replied=false,
  // raise an alert, and send the neutral holding message — the same fail-closed outcome
  // a positive classification would have produced. The pause+alert commit runs BEFORE the
  // send, so if it fails nothing is on the wire and the umbrella can safely re-throw.
  const escalateSensitivePathOnDetectorError = async (): Promise<void> => {
    const precheck = await shouldStillSendAutomatedReply({
      tenantId,
      channelId,
      conversationId,
      scheduledInboundExternalId: data.messageExternalId,
    });

    const locale = inferHoldingMessageLocale(inboundText, replyLanguage);
    const holdingMessage = HOLDING_MESSAGES[locale].postPurchaseSupport;

    const client = await pool.connect();
    let alert: AIAlert | undefined;
    try {
      await client.query('BEGIN');
      await setConversationAiPaused(conversationId, tenantId, true, client, 'uncertain_answer_escalated');
      await setConversationHumanReplied(conversationId, tenantId, false, client);
      alert = await createAIAlert(
        {
          tenant_id: tenantId,
          conversation_id: conversationId,
          message_id: lastInbound?.id ?? null,
          reason: 'uncertain_answer_escalated',
          // P1-5: this escalation is a fail-closed degradation (a sensitive detector threw), not a
          // genuine positive classification — distinguish it for on-call.
          fail_closed: true,
        },
        client,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err; // nothing sent yet → let the umbrella re-throw for a BullMQ retry
    } finally {
      client.release();
    }

    // The pause + alert are durably committed above — the fail-closed guarantee (AI
    // paused, human notified, human_replied=false) is already met. Everything below
    // (send, persist, emit) is BEST-EFFORT: a throw here must NOT propagate, or the
    // umbrella catch would treat it as a plain error and fall through to generateReply,
    // sending a normal sales reply on top of (or instead of) the escalation. Swallow +
    // log instead so runSensitiveDetector still reaches the sentinel and the caller returns.
    try {
      if (!precheck.ok) {
        // A newer inbound or an already-sent reply raced us: skip the holding send to
        // avoid a duplicate/racing message. The conversation is already paused with an
        // alert, so a human still reviews it. Emit the alert so the UI reflects the pause.
        console.info('[ai.reply] sensitive-path escalation skipping holding send', {
          conversationId,
          tenantId,
          reason: precheck.reason,
          ...precheck.logPayload,
        });
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
        return;
      }

      const contactForSend = await findContactById(conversation.contact_id);
      let sendResult: Awaited<ReturnType<typeof sendMessage>> | null = null;
      let outboundAck: Message;
      const canned = await stageCannedReply({
        replySlot: 'holding:sensitive',
        text: holdingMessage,
        contact: contactForSend,
      });
      if (canned) {
        sendResult = canned.sendResult;
        if (contactForSend) sensitivePathOutboundSent = true;
        if (!canned.outboundMessage) return; // retry of a sent row with no resolvable message
        outboundAck = canned.outboundMessage;
      } else {
        if (contactForSend) {
          sendResult = await sendMessage(channel, contactForSend.external_id, holdingMessage);
          sensitivePathOutboundSent = true;
        }

        outboundAck = await createMessage({
          tenant_id: tenantId,
          conversation_id: conversationId,
          external_message_id: sendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
          direction: 'outbound',
          type: 'text',
          content: holdingMessage,
          sent_by: 'ai',
        });
      }

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

      if (sendResult && !sendResult.success) {
        const errReason = sendResult.error ?? 'Failed to send escalation holding message';
        await updateMessageSendFailure(outboundAck.id, tenantId, 'failed', errReason);
        socketService.emitMessageSendFailed(tenantId, {
          messageId: outboundAck.id,
          conversationId,
          error: errReason,
        });
      }
    } catch (bestEffortErr) {
      logger.error('[ai.reply] sensitive-path escalation post-commit step failed', bestEffortErr, {
        conversationId,
        tenantId,
      });
    }
  };

  /**
   * P2-6 (RC-19): the graceful-degradation floor — the ONE safe outcome for a turn in which the
   * provider failed.
   *
   * Invoked from the pre-send gate when `turnProviderFailures()` is non-empty, i.e. at least one
   * OpenAI call this turn did not produce a real answer — whether it fast-failed on an open
   * breaker, blew the cap, was starved of budget, or 5xx'd — REGARDLESS of whether some classifier
   * then swallowed it into a confident-looking fail-open default. A reply built on that is a reply
   * whose safety guards silently did not run, so we do not send it.
   *
   * Structure (NOT effects) mirrors `escalateSensitivePathOnDetectorError` above: the durable
   * part is committed in ONE transaction FIRST (so it holds even if the send fails), then a
   * best-effort holding send that can never propagate. The committed part here is the ALERT
   * ONLY — deliberately NO pause and NO human_replied write (see the block comment inside the
   * transaction below; the tests in providerDegradation.test.ts pin exactly this).
   *
   * NOTE the `if (canned) … else …` pair rather than `stageCannedReply` alone: that helper returns
   * null whenever AI_REPLY_STAGE_BEFORE_SEND is off — its default — so relying on it by itself
   * would pause the conversation, raise the alert, and send the customer SILENCE. That is strictly
   * worse than the status quo, where the throw propagates and BullMQ retries into a real reply.
   */
  const degradeToHoldingAndEscalate = async (): Promise<boolean> => {
    const failures = turnProviderFailures();
    const summary = summarizeTurnFailures(failures);
    logger.error('[ai.reply] provider failed mid-turn — degrading to holding + escalate', undefined, {
      conversationId,
      tenantId,
      failures: summary,
      breaker: providerBreaker.snapshot(breakerMode()),
    });

    const precheck = await shouldStillSendAutomatedReply({
      tenantId,
      channelId,
      conversationId,
      scheduledInboundExternalId: data.messageExternalId,
    });

    // RC-20: the sensitive block may already have put an ack on the wire and THEN thrown — with
    // SENSITIVE_PATH_FAIL_CLOSED off the umbrella logs "continuing normal flow" and falls through
    // to here. `shouldStillSendAutomatedReply` re-checks the gates and superseding inbounds, but it
    // does not know what THIS job already sent, so it would not catch it. The alert is still owed
    // either way — but never stack a second message on top of the ack.
    const holdingSendAllowed = precheck.ok && !sensitivePathOutboundSent;

    const locale = inferHoldingMessageLocale(inboundText, replyLanguage);
    const holdingMessage = HOLDING_MESSAGES[locale].providerUnavailable;

    const client = await pool.connect();
    let alert: AIAlert | undefined;
    try {
      await client.query('BEGIN');
      /**
       * DELIBERATELY NO `ai_paused = true` HERE — unlike every other escalation in this file.
       *
       * A pause means "a human must own this conversation now", and it is STICKY: the only exits
       * are a human toggle or an alert resolved with `resume_ai:true` (`AI_AUTO_RESUME` is
       * per-reason and defaults off, and only covers `rate_limit_exceeded`). That is right for a
       * refund or a complaint — the conversation itself needs a person.
       *
       * A provider outage is not that. Nothing about the CONVERSATION is unsafe; our dependency was
       * down for a moment. And this is the only escalation reason driven by a GLOBAL condition, so
       * it fans out where a per-conversation reason never does: one 5-minute OpenAI blip would pause
       * every conversation that happened to be mid-turn, and a merchant with 200 live threads would
       * come back to 200 permanently AI-disabled ones, each needing a manual un-pause. The cure
       * would be far worse than the disease P2-6 treats.
       *
       * So the floor here is: a neutral holding message (the customer is not left on read) + a
       * durable, distinct, RETRYABLE alert (the merchant can follow up and sees what happened). The
       * next inbound is answered normally the moment the provider is healthy — which is exactly what
       * "retryable" is supposed to mean. Nothing unsafe was sent, so nothing needs to be held.
       *
       * Note `human_replied` is NOT touched either: it is a sticky billing flag, and forcing it
       * false on a conversation a human HAS replied to would silently re-qualify it for use-case
       * billing.
       */
      alert = await createAIAlert(
        {
          tenant_id: tenantId,
          conversation_id: conversationId,
          message_id: lastInbound?.id ?? null,
          // Distinct + retryable (mirrors P2-1's `grounding_check_unavailable`): this turn is not
          // unanswerable, it is merely unanswered.
          reason: 'provider_unavailable',
          // Not a genuine classification — the turn degraded because the provider failed.
          fail_closed: true,
        },
        client,
      );
      await client.query('COMMIT');
    } catch (err) {
      // ROLLBACK guarded: on a dead connection an unguarded ROLLBACK throws and REPLACES the real
      // error (the rate-limit block above uses the same idiom).
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      if (sensitivePathOutboundSent) {
        // RC-20: an ack from the sensitive block is already on the wire, so a re-throw would
        // re-run the job and double-send it. Mirrors the umbrella's own `post_send` → 'stop'
        // policy. (The earlier draft claimed "nothing on the wire yet" here — provably false:
        // `holdingSendAllowed` above exists precisely because it may not be.)
        logger.error('[ai.reply] degrade escalation failed after an ack was sent — stopping', err, {
          conversationId,
          tenantId,
        });
        return true;
      }
      throw err; // pre-send: nothing is on the wire, so a BullMQ retry is safe
    }
    client.release();

    // Committed above ⇒ the floor's durable guarantee — the retryable provider_unavailable alert
    // (and nothing else: no pause, no human_replied write) — is already met. Everything below is
    // BEST-EFFORT and must never propagate.
    try {
      if (!holdingSendAllowed) {
        console.info('[ai.reply] degraded-turn escalation skipping holding send', {
          conversationId,
          tenantId,
          reason: precheck.ok ? 'outbound_already_sent_this_job' : precheck.reason,
          ...(precheck.ok ? {} : precheck.logPayload),
        });
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
        return true;
      }

      const contactForSend = await findContactById(conversation.contact_id);
      let degradedSendResult: Awaited<ReturnType<typeof sendMessage>> | null = null;
      let outboundHolding: Message;
      const canned = await stageCannedReply({
        replySlot: 'holding:degraded',
        text: holdingMessage,
        contact: contactForSend,
      });
      if (canned) {
        degradedSendResult = canned.sendResult;
        if (!canned.outboundMessage) return true; // retry of an already-sent row
        outboundHolding = canned.outboundMessage;
      } else {
        if (contactForSend) {
          degradedSendResult = await sendMessage(channel, contactForSend.external_id, holdingMessage);
        }
        outboundHolding = await createMessage({
          tenant_id: tenantId,
          conversation_id: conversationId,
          external_message_id: degradedSendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
          direction: 'outbound',
          type: 'text',
          content: holdingMessage,
          sent_by: 'ai',
        });
      }

      if (alert) {
        socketService.emitAIAlert(tenantId, {
          ...alert,
          message_content: inboundText || null,
          contact_name: contactForSend?.name?.trim() || 'Customer',
          channel_type: channel.type,
          channel_name: channel.name,
        });
      }
      socketService.emitNewMessage(tenantId, outboundHolding);
      socketService.emitConversationUpdated(tenantId, conversationId);

      if (degradedSendResult && !degradedSendResult.success) {
        const errReason = degradedSendResult.error ?? 'Failed to send degraded holding message';
        await updateMessageSendFailure(outboundHolding.id, tenantId, 'failed', errReason);
        socketService.emitMessageSendFailed(tenantId, {
          messageId: outboundHolding.id,
          conversationId,
          error: errReason,
        });
      }
    } catch (bestEffortErr) {
      logger.error('[ai.reply] degraded-turn post-commit step failed', bestEffortErr, {
        conversationId,
        tenantId,
      });
    }
    return true;
  };
  degradeFloorFn = degradeToHoldingAndEscalate;

  // P0-4 (RC-19): wraps a SENSITIVE detector call so a transport/parse throw fails CLOSED.
  // Flag off → rethrow to the umbrella (legacy warn + continue → normal reply). Flag on →
  // escalate to a human (holding message + alert + pause) and throw the sentinel, which the
  // umbrella catch turns into a clean return — never a sales reply. If the escalation itself
  // throws before sending, that error propagates (pre-send) so the umbrella re-throws/retries.
  //
  // The `label` exists for the TEST_FORCE_DETECTOR_ERROR fault-injection hook: the staging
  // validation for this fix ("refund demand during an OpenAI blip") needs a reproducible way
  // to make a specific detector throw. The forced throw happens INSIDE the try so it takes
  // exactly the production error path.
  const runSensitiveDetector = async <T>(
    label: 'cancellation_refund' | 'wrong_product' | 'post_purchase' | 'order_info',
    fn: () => Promise<T>,
  ): Promise<T> => {
    try {
      if (
        TEST_FORCE_DETECTOR_ERROR &&
        (TEST_FORCE_DETECTOR_ERROR === label || TEST_FORCE_DETECTOR_ERROR === 'any')
      ) {
        throw new Error(`TEST_FORCE_DETECTOR_ERROR: forced ${label} detector failure`);
      }
      return await fn();
    } catch (err) {
      // P0-4 × P2-6 (dev validation Finding 4): a PROVIDER-caused detector failure routes to the
      // no-pause degrade floor when the floor is on — the detectors run first in the turn, so a
      // global outage always struck them before the pre-send degrade gate could classify the
      // turn, and the fail-closed pause fanned out to every mid-turn conversation. The ALS check
      // is required: a raw 5xx propagates as the original SDK error, so `instanceof` alone
      // misses it (the wrapper records the failure BEFORE rethrowing). Deliberately NOT
      // GenerationContractError — detectors cannot produce it (the outer catch's triple differs
      // on purpose). A non-provider detector failure (a code bug — conversation-specific) keeps
      // the fail-closed escalate+pause byte-for-byte, as does TEST_FORCE_DETECTOR_ERROR.
      const providerCausedDetectorFailure =
        turnProviderFailures().length > 0 || err instanceof ProviderUnavailableError;
      const route = decideSensitiveDetectorFailureRoute({
        failClosed: SENSITIVE_PATH_FAIL_CLOSED,
        providerCaused: providerCausedDetectorFailure,
        degradeModeOn: gracefulDegradeMode(),
      });
      if (route === 'rethrow') {
        throw err;
      }
      if (route === 'degrade') {
        // No try/catch: a pre-send floor throw must propagate to the umbrella → BullMQ retry
        // (same contract as the escalate path). The floor commits the retryable alert itself
        // and is double-send-guarded; the sentinel is thrown only after it returns, so the
        // umbrella stops the turn cleanly and the pre-send degrade gate is never reached.
        await degradeToHoldingAndEscalate();
        void writeLedgerBestEffort(
          buildJobLedgerRecord({
            tenantId,
            conversationId,
            correlationId: ledgerCorrelationId,
            traceId,
            replySlot: 'holding:degraded',
            decisionKind: 'escalation:provider_unavailable',
            messageId: null,
            decisionEvents,
            guardVerdicts: {
              providerBreaker: providerBreaker.snapshot(breakerMode()),
              providerFailures: summarizeTurnFailures(turnProviderFailures()),
              degraded: true,
              degradedFrom: `sensitive_detector:${label}`,
            },
          }),
        );
        throw new SensitivePathEscalatedError();
      }
      await escalateSensitivePathOnDetectorError();
      throw new SensitivePathEscalatedError();
    }
  };

  if (inboundText) {
    try {
      // P1-3 (RC-08): the verdict is persisted per (conversation, logical inbound) so a BullMQ
      // retry consumes the first attempt's verdict instead of re-rolling the classifier.
      const cancellationRefundIntent = await runSensitiveDetector('cancellation_refund', () =>
        getOrComputeClassifierVerdict({
          conversationId,
          inboundExternalId: data.messageExternalId,
          detector: 'cancellation_refund',
          compute: () => detectCancellationOrRefundIntent(inboundText, recentMessages),
        }),
      );
      console.info(
        `[CANCEL/REFUND] tenantId: ${tenantId} conversationId: ${conversationId} is_cancel: ${cancellationRefundIntent.is_cancellation} is_refund: ${cancellationRefundIntent.is_refund} confidence: ${cancellationRefundIntent.confidence} reasoning: ${logJsonStringOrNull(cancellationRefundIntent.reason)}`,
      );
      const hasCancelOrRefundIntent =
        cancellationRefundIntent.is_cancellation || cancellationRefundIntent.is_refund;
      logConfidenceGateBoundary(
        'cancellation_refund',
        cancellationRefundIntent.confidence,
        0.8,
        { tenantId, conversationId, inboundExternalId: data.messageExternalId },
        hasCancelOrRefundIntent,
      );
      const confidentCancelOrRefund = passesConfidenceGate(
        cancellationRefundIntent.confidence,
        0.8,
        CONFIDENCE_CONTRACT_SYMMETRY,
      );
      recordDecision({
        classifier: 'cancellation_refund',
        raw_score: cancellationRefundIntent.confidence ?? null,
        threshold: 0.8,
        boost_applied: cancellationRefundIntent.confidence_boost_applied === true,
        passed: hasCancelOrRefundIntent && confidentCancelOrRefund,
        branch: hasCancelOrRefundIntent && confidentCancelOrRefund ? 'escalate' : 'continue',
      });

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
        let outboundAck: Message;
        const canned = await stageCannedReply({
          replySlot: 'ack:order',
          text: ackText,
          contact: contactForSend,
        });
        if (canned) {
          sendResult = canned.sendResult;
          // P0-4: an ack is (or already was, on a retry) on the wire — no fail-closed re-throw.
          if (contactForSend) sensitivePathOutboundSent = true;
          if (!canned.outboundMessage) return; // retry of a sent row with no resolvable message
          outboundAck = canned.outboundMessage;
        } else {
          if (contactForSend) {
            sendResult = await sendMessage(channel, contactForSend.external_id, ackText);
            sensitivePathOutboundSent = true; // P0-4: an ack is on the wire — no fail-closed re-throw past here (RC-20)
          }

          outboundAck = await createMessage({
            tenant_id: tenantId,
            conversation_id: conversationId,
            external_message_id: sendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
            direction: 'outbound',
            type: 'text',
            content: ackText,
            sent_by: 'ai',
          });
        }

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

        await setConversationAiPaused(conversationId, tenantId, true, pool, cancellationRefundIntent.is_cancellation ? 'cancellation_request' : 'refund_request');

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
        void writeLedgerBestEffort(
          buildJobLedgerRecord({
            tenantId,
            conversationId,
            correlationId: ledgerCorrelationId,
            traceId,
            replySlot: 'holding:sensitive',
            decisionKind: cancellationRefundIntent.is_cancellation
              ? 'escalation:cancellation'
              : 'escalation:refund',
            messageId: outboundAck.id,
            decisionEvents,
          }),
        );
        return;
      }

      const wrongProductIntent = await runSensitiveDetector('wrong_product', () =>
        getOrComputeClassifierVerdict({
          conversationId,
          inboundExternalId: data.messageExternalId,
          detector: 'wrong_product',
          compute: () => detectWrongProductIntent(inboundText, recentMessages),
        }),
      );
      console.info(
        `[WRONG_PRODUCT] tenantId: ${tenantId} conversationId: ${conversationId} is_wrong_product: ${wrongProductIntent.is_wrong_product} confidence: ${wrongProductIntent.confidence} reasoning: ${logJsonStringOrNull(wrongProductIntent.reason)}`,
      );
      logConfidenceGateBoundary(
        'wrong_product',
        wrongProductIntent.confidence,
        0.8,
        { tenantId, conversationId, inboundExternalId: data.messageExternalId },
        wrongProductIntent.is_wrong_product === true,
      );
      const wrongProductEscalate =
        wrongProductIntent.is_wrong_product &&
        passesConfidenceGate(wrongProductIntent.confidence, 0.8, CONFIDENCE_CONTRACT_SYMMETRY);
      recordDecision({
        classifier: 'wrong_product',
        raw_score: wrongProductIntent.confidence ?? null,
        threshold: 0.8,
        boost_applied: wrongProductIntent.confidence_boost_applied === true,
        passed: wrongProductEscalate,
        branch: wrongProductEscalate ? 'escalate' : 'continue',
      });
      if (wrongProductEscalate) {
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
          await setConversationAiPaused(conversationId, tenantId, true, client, 'post_purchase_support_request');
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
          logger.error('[ai.reply] Wrong product escalation transaction failed', err, {
            conversationId,
            tenantId,
          });
        } finally {
          client.release();
        }

        const contactForSend = await findContactById(conversation.contact_id);
        let sendResult: Awaited<ReturnType<typeof sendMessage>> | null = null;
        let outboundAck: Message;
        const canned = await stageCannedReply({
          replySlot: 'ack:wrong_product',
          text: wrongProductHoldingMessage,
          contact: contactForSend,
        });
        if (canned) {
          sendResult = canned.sendResult;
          if (contactForSend) sensitivePathOutboundSent = true;
          if (!canned.outboundMessage) return; // retry of a sent row with no resolvable message
          outboundAck = canned.outboundMessage;
        } else {
          if (contactForSend) {
            sendResult = await sendMessage(channel, contactForSend.external_id, wrongProductHoldingMessage);
            sensitivePathOutboundSent = true; // P0-4: an ack is on the wire — no fail-closed re-throw past here (RC-20)
          }

          outboundAck = await createMessage({
            tenant_id: tenantId,
            conversation_id: conversationId,
            external_message_id: sendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
            direction: 'outbound',
            type: 'text',
            content: wrongProductHoldingMessage,
            sent_by: 'ai',
          });
        }

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
        void writeLedgerBestEffort(
          buildJobLedgerRecord({
            tenantId,
            conversationId,
            correlationId: ledgerCorrelationId,
            traceId,
            replySlot: 'ack:wrong_product',
            decisionKind: 'escalation:wrong_product',
            messageId: outboundAck.id,
            decisionEvents,
          }),
        );
        return;
      }

      // P2-2: in `on` the FSM path replaces these two LLM classifiers with deterministic lexicons
      // (used here only to decide whether to skip the post-purchase-support check).
      const isLikelyNewOrderSignal =
        ORDER_STAGE_MACHINE_MODE === 'on'
          ? detectNewOrderSignalLexical(inboundText)
          : await classifyNewOrderSignal(inboundText);
      const orderAffirmationIntent =
        ORDER_STAGE_MACHINE_MODE === 'on'
          ? {
              is_order_affirmation: detectOrderConsentLexical(inboundText),
              confidence: 1,
              reason: null as string | null,
            }
          : await getOrComputeClassifierVerdict({
              conversationId,
              inboundExternalId: data.messageExternalId,
              detector: 'order_affirmation',
              compute: () => detectOrderAffirmationIntent(inboundText, recentMessages),
            });
      const isLikelyOrderAffirmation =
        ORDER_STAGE_MACHINE_MODE === 'on'
          ? orderAffirmationIntent.is_order_affirmation === true
          : orderAffirmationIntent.is_order_affirmation &&
            passesConfidenceGate(orderAffirmationIntent.confidence, 0.7, CONFIDENCE_CONTRACT_SYMMETRY);
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
          // P1-6: free-text-out reference, never raw customer text.
          inboundText: logSafe(inboundText),
        });
      }
      const postPurchaseSupportIntent =
        shouldCheckPostPurchaseSupport && !isLikelyNewOrderSignal
          ? await runSensitiveDetector('post_purchase', () =>
              getOrComputeClassifierVerdict({
                conversationId,
                inboundExternalId: data.messageExternalId,
                detector: 'post_purchase',
                compute: () => detectPostPurchaseSupportIntent(inboundText, recentMessages),
              }),
            )
          : {
              is_delivery_eta_query: false,
              is_not_delivered_complaint: false,
              is_wrong_product_issue: false,
              is_product_problem_issue: false,
              confidence: 0,
              confidence_boost_applied: false as boolean | undefined,
              reason: null as string | null,
            };
      const hasPostPurchaseSupportIntent =
        postPurchaseSupportIntent.is_delivery_eta_query ||
        postPurchaseSupportIntent.is_not_delivered_complaint ||
        postPurchaseSupportIntent.is_wrong_product_issue ||
        postPurchaseSupportIntent.is_product_problem_issue;
      logConfidenceGateBoundary(
        'post_purchase',
        postPurchaseSupportIntent.confidence,
        0.8,
        { tenantId, conversationId, inboundExternalId: data.messageExternalId },
        hasPostPurchaseSupportIntent,
      );
      const confidentPostPurchaseSupportIntent = passesConfidenceGate(
        postPurchaseSupportIntent.confidence,
        0.8,
        CONFIDENCE_CONTRACT_SYMMETRY,
      );
      console.info(
        `[POST_PURCHASE_SUPPORT] tenantId: ${tenantId} conversationId: ${conversationId} eta_query: ${postPurchaseSupportIntent.is_delivery_eta_query} not_delivered: ${postPurchaseSupportIntent.is_not_delivered_complaint} wrong_product: ${postPurchaseSupportIntent.is_wrong_product_issue} product_problem: ${postPurchaseSupportIntent.is_product_problem_issue} confidence: ${postPurchaseSupportIntent.confidence} reasoning: ${logJsonStringOrNull(postPurchaseSupportIntent.reason)}`,
      );

      recordDecision({
        classifier: 'post_purchase_support',
        raw_score: postPurchaseSupportIntent.confidence ?? null,
        threshold: 0.8,
        boost_applied: postPurchaseSupportIntent.confidence_boost_applied === true,
        passed: hasPostPurchaseSupportIntent && confidentPostPurchaseSupportIntent,
        branch:
          hasPostPurchaseSupportIntent && confidentPostPurchaseSupportIntent
            ? 'escalate'
            : 'continue',
      });

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
          let outboundEta: Message;
          const cannedEta = await stageCannedReply({
            replySlot: 'ack:eta',
            text: deliveryEtaReply,
            contact: contactForEtaSend,
          });
          if (cannedEta) {
            etaSendResult = cannedEta.sendResult;
            if (contactForEtaSend) sensitivePathOutboundSent = true;
            if (!cannedEta.outboundMessage) return; // retry of a sent row with no resolvable message
            outboundEta = cannedEta.outboundMessage;
          } else {
            if (contactForEtaSend) {
              etaSendResult = await sendMessage(
                channel,
                contactForEtaSend.external_id,
                deliveryEtaReply,
              );
              sensitivePathOutboundSent = true; // P0-4: a reply is on the wire — no fail-closed re-throw past here (RC-20)
            }

            outboundEta = await createMessage({
              tenant_id: tenantId,
              conversation_id: conversationId,
              external_message_id: etaSendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
              direction: 'outbound',
              type: 'text',
              content: deliveryEtaReply,
              sent_by: 'ai',
            });
          }

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

          // P0-6 (RC-18): an ETA auto-reply is a delivered reply — charge the budget.
          // This path does not pause the conversation, so without counting it a customer
          // looping on "when will it arrive?" would get unlimited canned replies per hour
          // (legacy attempt-counting capped them at 25).
          if (
            shouldCountDeliveredReply({
              countDeliveredOnly: RATE_LIMIT_COUNT_DELIVERED_ONLY,
              sendSucceeded: etaSendResult?.success === true,
            })
          ) {
            await countDeliveredReplyOnce(
              rateLimitKey,
              rateCountedMarkerKey(conversationId, data.messageExternalId),
            );
          }

          await touchConversationLastMessageAt(conversationId);
          console.info(
            `[DELIVERY_ETA_AUTO_REPLY] tenantId: ${tenantId} conversationId: ${conversationId} delivery_time: ${configuredDeliveryTime}`,
          );
          void writeLedgerBestEffort(
            buildJobLedgerRecord({
              tenantId,
              conversationId,
              correlationId: ledgerCorrelationId,
              traceId,
              replySlot: 'ack:eta',
              decisionKind: 'ack:delivery_eta',
              messageId: outboundEta.id,
              decisionEvents,
            }),
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
          await setConversationAiPaused(conversationId, tenantId, true, client, 'post_purchase_support_request');
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
          logger.error('[ai.reply] Post-purchase support escalation transaction failed', err, {
            conversationId,
            tenantId,
          });
        } finally {
          client.release();
        }

        const contactForSend = await findContactById(conversation.contact_id);
        let sendResult:
          | Awaited<ReturnType<typeof sendMessage>>
          | null = null;
        let outboundAck: Message;
        const canned = await stageCannedReply({
          replySlot: 'holding:post_purchase',
          text: postPurchaseHoldingMessage,
          contact: contactForSend,
        });
        if (canned) {
          sendResult = canned.sendResult;
          if (contactForSend) sensitivePathOutboundSent = true;
          if (!canned.outboundMessage) return; // retry of a sent row with no resolvable message
          outboundAck = canned.outboundMessage;
        } else {
          if (contactForSend) {
            sendResult = await sendMessage(
              channel,
              contactForSend.external_id,
              postPurchaseHoldingMessage,
            );
            sensitivePathOutboundSent = true; // P0-4: an ack is on the wire — no fail-closed re-throw past here (RC-20)
          }

          outboundAck = await createMessage({
            tenant_id: tenantId,
            conversation_id: conversationId,
            external_message_id: sendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
            direction: 'outbound',
            type: 'text',
            content: postPurchaseHoldingMessage,
            sent_by: 'ai',
          });
        }

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
        void writeLedgerBestEffort(
          buildJobLedgerRecord({
            tenantId,
            conversationId,
            correlationId: ledgerCorrelationId,
            traceId,
            replySlot: 'holding:sensitive',
            decisionKind: 'escalation:post_purchase',
            messageId: outboundAck.id,
            decisionEvents,
          }),
        );
        return;
      }
      // ---- Order information update (customer correcting address / phone / name / notes) ----
      // Guards: skip if the message signals a new order or an order affirmation — those flows
      // must continue to generateReply so the data-confirmation message is sent and the order
      // creation logic at the tail of this function can fire.
      if (!isLikelyNewOrderSignal && !isLikelyOrderAffirmation) {
      const orderInfoUpdateIntent = await runSensitiveDetector('order_info', () =>
        getOrComputeClassifierVerdict({
          conversationId,
          inboundExternalId: data.messageExternalId,
          detector: 'order_info_update',
          compute: () => detectOrderInfoUpdateIntent(inboundText, recentMessages),
        }),
      );
      console.info(
        `[ORDER_INFO_UPDATE] tenantId: ${tenantId} conversationId: ${conversationId} is_update: ${orderInfoUpdateIntent.is_order_info_update} confidence: ${orderInfoUpdateIntent.confidence} reason: ${logJsonStringOrNull(orderInfoUpdateIntent.reason)}`,
      );
      logConfidenceGateBoundary(
        'order_info_update',
        orderInfoUpdateIntent.confidence,
        0.82,
        { tenantId, conversationId, inboundExternalId: data.messageExternalId },
        orderInfoUpdateIntent.is_order_info_update === true,
      );
      const orderInfoUpdateEscalate =
        orderInfoUpdateIntent.is_order_info_update &&
        passesConfidenceGate(orderInfoUpdateIntent.confidence, 0.82, CONFIDENCE_CONTRACT_SYMMETRY);
      recordDecision({
        classifier: 'order_info_update',
        raw_score: orderInfoUpdateIntent.confidence ?? null,
        threshold: 0.82,
        boost_applied: orderInfoUpdateIntent.confidence_boost_applied === true,
        passed: orderInfoUpdateEscalate,
        branch: orderInfoUpdateEscalate ? 'update_order' : 'continue',
      });
      if (orderInfoUpdateEscalate) {
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
            let outboundConfirm: Message;
            const canned = await stageCannedReply({
              replySlot: 'ack:order_info',
              text: confirmationText,
              contact: contactForSend,
            });
            if (canned) {
              sendResult = canned.sendResult;
              if (contactForSend) sensitivePathOutboundSent = true;
              if (!canned.outboundMessage) return; // retry of a sent row with no resolvable message
              outboundConfirm = canned.outboundMessage;
            } else {
              if (contactForSend) {
                sendResult = await sendMessage(channel, contactForSend.external_id, confirmationText);
                sensitivePathOutboundSent = true; // P0-4: a confirmation is on the wire — no fail-closed re-throw past here (RC-20)
              }

              outboundConfirm = await createMessage({
                tenant_id: tenantId,
                conversation_id: conversationId,
                external_message_id: sendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
                direction: 'outbound',
                type: 'text',
                content: confirmationText,
                sent_by: 'ai',
              });
            }

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

            // P0-6 (RC-18): the confirmation is a delivered reply and this path does not
            // pause — count it so repeated order-info updates stay bounded by the 25/h cap.
            if (
              shouldCountDeliveredReply({
                countDeliveredOnly: RATE_LIMIT_COUNT_DELIVERED_ONLY,
                sendSucceeded: sendResult?.success === true,
              })
            ) {
              await countDeliveredReplyOnce(
                rateLimitKey,
                rateCountedMarkerKey(conversationId, data.messageExternalId),
              );
            }

            console.info(`[ORDER_INFO_UPDATE] Updated order ${candidateOrder.id}`, {
              changedFields: Object.keys(fieldsToUpdate),
              tenantId,
              conversationId,
            });
            void writeLedgerBestEffort(
              buildJobLedgerRecord({
                tenantId,
                conversationId,
                correlationId: ledgerCorrelationId,
                traceId,
                replySlot: 'ack:order',
                decisionKind: 'ack:order_info_update',
                messageId: outboundConfirm.id,
                decisionEvents,
              }),
            );
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
      if (err instanceof SensitivePathEscalatedError) {
        // P0-4 (RC-19): a sensitive detector threw and we already escalated (holding
        // message + alert + pause). Return WITHOUT falling through to generateReply —
        // that fall-through is the exact fail-open this fixes — and without re-throwing
        // (the escalation already happened; a retry would double-send the holding message).
        return;
      }
      const action = decideSensitivePathAction(
        sensitivePathOutboundSent ? 'post_send' : 'pre_send',
        SENSITIVE_PATH_FAIL_CLOSED,
      );
      if (action === 'retry') {
        // P0-4 (RC-19): fail closed. Surface the error so BullMQ retries instead of
        // silently downgrading a sensitive escalation into a normal sales reply. Scoped
        // to the pre-send window (sensitivePathOutboundSent === false) so a retry can
        // never double-send an ack that already went out (RC-20).
        throw err;
      }
      if (action === 'stop') {
        // P0-4 (RC-19): an ack/holding reply for this inbound is already on the wire.
        // Re-throwing would double-send it on retry (RC-20), and falling through would
        // follow the sensitive ack with a normal sales reply — the exact fail-open this
        // subsystem exists to prevent. End the job here; committed side effects stand.
        logger.error('[ai.reply] escalation path failed after an ack was sent — stopping (fail-closed)', err, {
          conversationId,
          tenantId,
        });
        return;
      }
      console.warn('[ai.reply] escalation detection path failed, continuing normal flow', {
        conversationId,
        tenantId,
        err,
      });
    }
  }

  // Start product image request classification in parallel with AI text generation
  // so we pay no extra latency on the happy (non-image-request) path.
  const imageRequestClassificationPromise = classifyProductImageRequest(inboundText).catch(
    () => null,
  );

  const {
    reply: replyText,
    productCatalogContext,
    language: generatedLanguage,
    matchedProducts,
    attributeIntent,
    hadImages,
    productNotInCatalog: visionProductNotInCatalog,
    telemetry: replyTelemetry,
    factsUsed,
  } = await generateReply(
      conversationId,
      tenantId,
      inboundText,
      attachmentUrls,
      undefined,
      replyLanguage,
      traceId, // P1-5: thread the correlation id into aiService (closes C-109).
    );

  // Await the image classification result — it should already be resolved since
  // generateReply took much longer than a single fast JSON classifier call.
  const imageClassification = await imageRequestClassificationPromise;

  // Resolved at end of image-request handling block (below); declared here so
  // they stay in scope for the image-send step and the alert-creation step.
  let productsToSendImages: Product[] = [];
  let productsWithMissingImages: Product[] = [];
  // Set when a detected photo request resolved to ZERO products (classifier hit but no
  // target matched) — the turn ships a holding line instead of the raw model reply, and
  // this drives the product_image_unavailable alert's `unresolved_reference` details.
  let imageRequestUnresolvedDetails: {
    refs: ProductImageRef[];
    matched_count: number;
    recent_count: number;
    discussed_count: number;
  } | null = null;

  if (replyText.trim() === '[NO_REPLY]') {
    // P1-5: a [NO_REPLY] still made a decision — record it so billing-class divergence (a turn the
    // AI chose not to answer) is visible in the ledger, not silent.
    void writeLedgerBestEffort(
      buildJobLedgerRecord({
        tenantId,
        conversationId,
        correlationId: ledgerCorrelationId,
        traceId,
        replySlot: 'none',
        decisionKind: 'no_reply',
        telemetry: replyTelemetry,
        decisionEvents,
        factsUsed,
      }),
    );
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
          await setConversationAiPaused(conversationId, tenantId, true, client, 'usage_question_unanswered');
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
          logger.error('[ai.reply] Usage escalation transaction failed', err, { conversationId, tenantId });
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
      await setConversationAiPaused(conversationId, tenantId, true, client, 'usage_question_unanswered');
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
      logger.error('[ai.reply] Usage escalation (no usage description) transaction failed', err, {
        conversationId,
        tenantId,
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
          await setConversationAiPaused(conversationId, tenantId, true, client, 'usage_question_unanswered');
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
          logger.error('[ai.reply] Usage escalation fallback transaction failed', err, {
            conversationId,
            tenantId,
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
      await setConversationAiPaused(conversationId, tenantId, true, client, 'usage_question_unanswered');
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
      logger.error('[ai.reply] Usage escalation fallback transaction failed', err, {
        conversationId,
        tenantId,
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
  // Set to true when a multi-product query has missing attributes for SOME (not all)
  // products — used to suppress Layer 3 contradictory-notice stripping, which would
  // otherwise remove a valid "we'll notify you" notice for the products that lack the
  // attribute just because another product's value appears in the same reply.
  let isMultiProductGap = false;

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
  //
  // Recommendation / comparison questions ("which one would you recommend?", "cilen me
  // sugjeron?", "cilen mkishe than ti me marr?") are explicitly excluded: the AI has
  // all the catalog data needed to compare products and answer directly. Triggering the
  // product-information-gap assessment on these questions causes a spurious "specialist
  // will contact you" alert because the catalog knowledge contains no "recommendation"
  // fact — which is a false positive, not a genuine knowledge gap.
  const isProductRecommendationQuestion =
    Boolean(inboundText) && isProductRecommendationOrComparisonQuestion(inboundText);
  if (isProductRecommendationQuestion) {
    logger.info('[ai.reply] Detected recommendation/comparison question — skipping product-information-gap escalation', {
      conversationId,
      tenantId,
      messagePreview: logSafe(inboundText),
    });
  }
  // P2-5 (RC-25): an inventory-browsing question ("do you have more, or only these?") is not a
  // product-information request — the catalog either holds more items or it doesn't, and the gap
  // assessor has no "more" fact to look up. EV-010 (alert d3db5dac) is the canonical failure:
  // Gheg "A keni ma shum a veq aito / Qito" slipped every deterministic net ('ma shum' missed
  // `me shum[eë]`; 'aito'/'Qito' missed the deictic list), reached the English-prompted assessor,
  // and came back as `missing_info: ["ma shum"]` — the word "more" filed to a specialist as an
  // unavailable catalog attribute. This exclusion mirrors isProductRecommendationQuestion above;
  // the lexicon that powers it is Gheg-extended in ghegLexicons.ts.
  const isOtherOptionsBrowsingQuestion =
    GHEG_LEXICONS && Boolean(inboundText) && isOtherOptionsFollowUp(inboundText);
  if (isOtherOptionsBrowsingQuestion) {
    logger.info('[ai.reply] Detected other-options browsing question — skipping product-information-gap escalation', {
      conversationId,
      tenantId,
      messagePreview: logSafe(inboundText),
    });
  }

  const isProductInformationQuestion =
    Boolean(inboundText) &&
    !isProductRecommendationQuestion &&
    !isOtherOptionsBrowsingQuestion &&
    (attributeIntent.is_product_knowledge_question || requestedStructuredAttributes.length > 0);

  // P2-1: the consolidated gate subsumes the gap assessor's structured decision, so it forces the
  // deterministic-first path (the LLM's stochastic !ok/`missing` can never decide an escalation on
  // its own). Equivalent to GAP_GATE_DETERMINISTIC_FIRST but also engaged by the consolidated flag.
  const gapDeterministicFirst = GAP_GATE_DETERMINISTIC_FIRST || GROUNDING_GATE_CONSOLIDATED;

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
      // P2-5 (RC-25): the curation loop, recorded HERE — at the only point the fail-closed gap
      // assessor genuinely runs, after the usage/OOS/vision/no-match guards above have all
      // declined to skip it. Recording earlier (on `isProductInformationQuestion` alone) would
      // claim a fall-through for photo questions and zero-match turns that never reach the
      // assessor at all, burying the real signal.
      //
      // Every routing lexicon returns a bare `false` on a miss with no log, no metric and no
      // ledger row, so a dialect-coverage effort has nothing to measure against. This records
      // each message the deterministic routers declined to claim before it hit the assessor —
      // that set IS the list of uncovered Gheg forms to curate. Gated on GHEG_LEXICONS so the
      // ledger is not filled with rows the curation loop cannot act on. `classifier`/`branch`
      // are free-form on LedgerDecisionEvent, so this needs no schema change.
      if (GHEG_LEXICONS) {
        recordDecision({
          classifier: 'gheg_lexicon',
          raw_score: null,
          threshold: null,
          boost_applied: false,
          passed: false,
          branch: `fall_through:gap_assessor:attrs=${requestedStructuredAttributes.length}:matched=${matchedProducts.length}`,
        });
      }

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

      // Vocabulary-independent availability signal: an LLM confirms which requested
      // attributes are explicitly specified in the matched products' text/fields. This
      // makes the "is it present?" check robust to values absent from the fixed regex
      // vocabulary (a new flavor like "Tiramisu", an unusual color/size/weight), so the
      // deterministic net can never flag — and therefore never contradict — a value the
      // catalog actually states. Fail-open: an empty set on error falls back to the
      // deterministic structured + regex signals below.
      let aiSpecifiedKeys = new Set<string>();
      try {
        aiSpecifiedKeys = await detectSpecifiedAttributes(
          requestedStructuredAttributes,
          matchedProducts,
        );
      } catch (err) {
        console.warn('[ai.reply] attribute availability classifier failed', {
          conversationId,
          tenantId,
          err,
        });
      }

      // Deterministic safety net: structured attributes that NO matched product can
      // provide are definitely missing — independent of the LLM. We treat an attribute
      // as AVAILABLE when ANY of three signals confirm it: (1) the text-aware resolver
      // (getProductInferredAttributes — structured column OR regex match in the name/
      // description/extracted text/tags), (2) a high-confidence packaging read from the
      // product image, or (3) the vocabulary-independent AI classifier. Only attributes
      // none of these can confirm are escalated, so a known value is never contradicted.
      const availableKeys = new Set<string>([...imageUsableKeys, ...aiSpecifiedKeys]);
      const deterministicMissingKeys = computeMissingStructuredAttributes(
        requestedStructuredAttributes,
        matchedProducts.map((p) => getProductInferredAttributes(p)),
        availableKeys,
      );

      // LLM composer: grounded answer for what we know + labels for what we don't.
      const assessment = await assessProductInformationRequest(inboundText, knowledgeContext, {
        failClosed: true,
      });

      // Deterministic-first (P0-3, RC-01): the LLM's stochastic `missing` labels may
      // only contribute allowlisted FREE-FORM info gaps (ingredients, usage, …).
      // Structured attributes are decided solely by the deterministic net below, and
      // question echoes ("ma shum", "cila eshte me e mire") are suppressed. Legacy
      // mode passes the labels through untouched.
      const llmMissingLabels = gapDeterministicFirst
        ? filterFreeFormInfoLabels(assessment.missing)
        : assessment.missing;
      if (gapDeterministicFirst && assessment.errored) {
        console.warn('[ai.reply] gap assessor errored — deterministic-first gate failing OPEN to deterministic evidence only', {
          conversationId,
          tenantId,
          deterministicMissingKeys,
        });
      }

      // Merge missing info: the LLM labels (customer language; covers free-form info
      // such as ingredients) unioned with the deterministic structured labels (a
      // guarantee we never silently drop a known-missing attribute), de-duplicated.
      // Then reconcile against the grounded answer: never escalate an attribute the
      // answer already states (final guard against self-contradicting partial replies).
      const mergedMissing = reconcileMissingAgainstAnswer(
        dedupeInfoLabels([
          ...llmMissingLabels,
          ...localizedAttributeLabels(deterministicMissingKeys, replyLocale),
        ]),
        assessment.answer,
      );

      // ---------------------------------------------------------------------------
      // Multi-product per-product gap detection.
      //
      // The cross-product signals above (computeMissingStructuredAttributes with
      // availableKeys, and the LLM assessment) treat an attribute as "available" when
      // AT LEAST ONE matched product carries it.  When the customer asks about the same
      // attribute across several products, this masks any products that are missing it:
      //   • Product A has flavor → "flavor is available" → nothing escalated for B & C.
      //   • reconcileMissingAgainstAnswer then removes "flavor" from missing because
      //     the answer already states it for Product A.
      //
      // This block catches those "partially available" gaps by checking each requested
      // attribute against EVERY individual product using only per-product inferred
      // attributes (deliberately NOT using cross-product availableKeys / aiSpecifiedKeys,
      // which would mask the per-product absence).  Any attribute that is missing for
      // at least one product is added to the missing set, bypassing reconciliation —
      // the answer may mention it for Product A, but the notice is still valid for B/C.
      // ---------------------------------------------------------------------------
      const perProductMissingLabels: string[] = [];
      if (matchedProducts.length > 1) {
        for (const key of requestedStructuredAttributes) {
          // Already flagged as globally missing by the deterministic net → skip.
          if (deterministicMissingKeys.includes(key)) continue;
          // Per-product check: is this attribute absent from at least one product?
          const anyProductMissingIt = matchedProducts.some((p) => {
            const val = getProductInferredAttributes(p)[key];
            return !(typeof val === 'string' && val.trim().length > 0);
          });
          if (anyProductMissingIt) {
            perProductMissingLabels.push(...localizedAttributeLabels([key], replyLocale));
          }
        }
      }

      // Combine and deduplicate: per-product labels bypass reconciliation so that the
      // "we'll notify you" notice is preserved even when the answer already states the
      // attribute for the products that have it.
      const finalMergedMissing = dedupeInfoLabels([...mergedMissing, ...perProductMissingLabels]);
      if (perProductMissingLabels.length > 0) {
        isMultiProductGap = true;
      }

      const status = deriveAnswerabilityStatus(assessment.answer, finalMergedMissing);

      // Legacy: escalate whenever the request is not fully answerable OR the
      // assessment could not be performed (fail-closed). Deterministic-first (P0-3):
      // escalate only on deterministically-backed missing info — an errored assessor
      // with a clean deterministic net sends the AI reply as-is (fail-open). A
      // fully-answerable request keeps the original, well-tuned AI reply untouched.
      const shouldEscalate = decideGapEscalation(assessment, status, gapDeterministicFirst);
      recordDecision({
        classifier: 'product_info_gap',
        raw_score: null,
        threshold: null,
        boost_applied: false,
        passed: shouldEscalate,
        branch: shouldEscalate ? 'escalate' : 'answer_as_is',
      });

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
            ? composePartialAnswer(assessment.answer, finalMergedMissing, replyLocale)
            : buildMissingInfoHoldingMessage(finalMergedMissing, replyLocale);

        const client = await pool.connect();
        let alert: AIAlert | undefined;
        try {
          await client.query('BEGIN');
          await setConversationAiPaused(conversationId, tenantId, true, client, 'product_question_unanswered');
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
                missing_info: finalMergedMissing,
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
          logger.error('[ai.reply] Product information gap escalation transaction failed', err, {
            conversationId,
            tenantId,
          });
        } finally {
          client.release();
        }

        if (alert) {
          console.info('[ai.reply] Product information gap escalation created', {
            conversationId,
            tenantId,
            status,
            missingInfo: finalMergedMissing,
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
    // AI-backed classifier: LLM-first (catches novel phrasings the keyword list misses),
    // keyword fallback. The sync containsSpeculativeHealthAdvice is kept for the catalog
    // check below — catalog text is structured data where phrase matching is sufficient.
    (await classifySpeculativeHealthAdvice(finalReplyText))
  ) {
    // Only escalate when the usage description itself does NOT already contain the same
    // health-consultation language — if the catalog says "consult a doctor if pregnant"
    // and the AI echoes that, it is valid catalog-backed advice, not speculation.
    const adviceIsFromCatalog = Boolean(
      usageDescription && containsSpeculativeHealthAdvice(usageDescription),
    );

    if (!adviceIsFromCatalog) {
      logger.info(
        '[ai.reply] Speculative health advice detected in AI reply — escalating instead of sending',
        { conversationId, tenantId, replyPreview: logSafeStructured(finalReplyText) },
      );

      const speculativeHoldingMessage =
        HOLDING_MESSAGES[inferHoldingMessageLocale(inboundText, replyLocale)].usageEscalation;
      const client = await pool.connect();
      let alert: AIAlert | undefined;
      try {
        await client.query('BEGIN');
        await setConversationAiPaused(conversationId, tenantId, true, client, 'usage_question_unanswered');
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
        logger.error('[ai.reply] Speculative advice escalation transaction failed', err, {
          conversationId,
          tenantId,
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
    } else if (ETA_STRIP_ALL_REPLIES) {
      // P3-5 (RC-26, rule R10): "Do not promise delivery times unless confirmed."
      //
      // The strip and the inject are two different jobs, and only the inject belongs to order
      // confirmations. Before this, BOTH ran only on classifier-detected confirmation turns — so a
      // model-authored "arrives in 2 days" in an ordinary product or availability reply was sent
      // untouched, which is the enforcement gap the audit recorded ("covers only
      // classifier-detected order-confirmation replies"). A wrong ETA is a promise the business
      // did not make, and it is no less wrong for arriving on a non-confirmation turn.
      //
      // Deliberately STRIP-ONLY here: `deliveryLine` is passed so the tenant's configured ETA is
      // recognised and preserved, but nothing is injected. Volunteering a delivery time on a turn
      // the customer never asked about would be the opposite error — and R10 says "unless
      // confirmed", not "always state it".
      const tenantForEta = await findTenantById(tenantId);
      const configuredEta = tenantForEta?.delivery_time ?? null;
      finalReplyText = stripModelDeliveryEtaMentions(
        finalReplyText,
        configuredEta ? buildOrderConfirmationDeliveryLine(configuredEta, replyLocale) : null,
      );
    }
  }
  if (inboundText) {
    // Drop any fixed-phrase the model leaked in the OPPOSITE locale before we add the
    // canonical follow-up sentence below — this guarantees no language mixing in the reply.
    finalReplyText = stripFixedPhrasesOfOtherLocale(finalReplyText, replyLocale);
    // P2-2: in `on` the persisted order_closing_asked marker (+ a deterministic regex scan for the
    // pre-seed window) replaces the ~40-call order-closing LLM loop.
    const orderClosingAlreadyAskedInConversation =
      ORDER_STAGE_MACHINE_MODE === 'on'
        ? conversation.order_closing_asked === true ||
          recentMessages.some(
            (m) => m.sent_by !== 'customer' && messageContainsOrderClosingAsk(m.content ?? ''),
          )
        : await hasAssistantAskedOrderClosingInConversation(recentMessages);

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
    // Generic follow-up invitations ("më tregoni", "let me know", "feel free to ask", etc.)
    // are stripped from ALL non-order-confirmation replies regardless of conversation state.
    // Order-confirmation replies are the only exception because the fixed follow-up sentence
    // (e.g. "konfirmoni nëse dëshironi ...") is part of the required confirmation format.
    finalReplyText = await stripGenericFollowUpInvitation(
      finalReplyText,
      !isOrderConfirmationReply,
    );

    // P2-2 (shadow/on): persist the deterministic order_stage markers from the ACTUALLY-SENT reply.
    // Monotone writes (safe under retry). data_confirmation_sent enters awaiting_confirmation;
    // order_closing_asked replaces the ~40-call LLM loop with an O(1) persisted boolean.
    if (ORDER_STAGE_MACHINE_MODE !== 'off') {
      const currentStage = normalizeStage(conversation.order_stage);
      if (messageIsDataConfirmationRequest(finalReplyText)) {
        await markDataConfirmationSent(conversationId, tenantId).catch((e) =>
          logger.warn('[ORDER_STAGE] data-confirmation marker write failed', { conversationId, err: String(e) }),
        );
        await advanceOrderStage(
          conversationId,
          tenantId,
          decideOrderStage(currentStage, { kind: 'assistant_data_confirmation_sent' }).nextStage,
        ).catch(() => undefined);
      } else if (messageContainsOrderClosingAsk(finalReplyText)) {
        await markOrderClosingAsked(conversationId, tenantId).catch((e) =>
          logger.warn('[ORDER_STAGE] order-closing marker write failed', { conversationId, err: String(e) }),
        );
        await advanceOrderStage(
          conversationId,
          tenantId,
          decideOrderStage(currentStage, { kind: 'assistant_order_closing_asked' }).nextStage,
        ).catch(() => undefined);
      }
    }
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
  /**
   * P3-4 (RC-15): how the eval participates in this turn.
   *
   *   enforce — unchanged: score, and let a failing score flag + alert + PAUSE.
   *   shadow  — score and record in the ledger, but take no action. The parallel/log-only window
   *             that produces the data `npm run eval:quality` compares the offline scorer against.
   *   off     — skip the call entirely.
   *
   * `off` short-circuits to the SAME synthetic 0.95 the three skip predicates above already use,
   * so no new code path is introduced — only a new reason to take an existing one.
   */
  const qualityEvalMode = getQualityEvalMode();
  const skipEvaluationForMode = qualityEvalMode === 'off';
  const qualityEval = knowledgeGapEscalated
    ? null
    : skipEvaluationForMode ||
        skipEvaluationForHonestNegative ||
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
  const qualityWouldFail =
    qualityEval !== null && evaluationTriggersAlert(qualityEval, qualityThreshold);
  // In `shadow` the verdict is observed but never acted on: no flag, no alert, no pause.
  let qualityFailing = qualityEvalMode === 'enforce' && qualityWouldFail;
  const qualityScore = qualityEval?.quality_score ?? null;
  recordDecision({
    classifier: 'quality_eval',
    raw_score: qualityScore,
    threshold: qualityThreshold,
    boost_applied: false,
    // Record what the eval CONCLUDED, not what was enforced — otherwise a shadow window would
    // write "everything passed" and the parity comparison it exists to feed would have no signal.
    passed: qualityWouldFail,
    branch:
      qualityEvalMode === 'enforce'
        ? qualityWouldFail
          ? 'flagged'
          : 'ok'
        : `${qualityEvalMode}:${qualityWouldFail ? 'would_flag' : 'ok'}`,
  });
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
      `[QUALITY EVAL] tenantId: ${tenantId} conversationId: ${conversationId} score: ${qualityEval.quality_score} flagged: ${qualityFailing} rule: ${ruleDisplay} reasoning: ${logSafeStructured(logJsonStringOrNull(qualityEval.reason))}`,
    );
  }

  // ---------------------------------------------------------------------------
  // P2-1 — Consolidated deterministic grounding gate (RC-02/RC-01/RC-03).
  //
  // When GROUNDING_GATE_CONSOLIDATED is on, ONE gate replaces the legacy price + product-name
  // hallucination guards below: it validates the reply's asserted prices/names against the
  // tenant's FULL active catalog (never this turn's matchedProducts window) and takes TARGETED
  // action on the failing span — only the sentence carrying an ungrounded price or fabricated
  // name is removed; grounded content is kept (the fcd0af7e fix). If too little grounded content
  // survives (< GROUNDING_GATE_STRIP_FLOOR) it escalates to a holding message. A catalog-index
  // infra error fails CLOSED with the distinct retryable reason `grounding_check_unavailable`.
  //
  // Escalations funnel through a single `groundingGateEscalated` flag with a dynamic reason,
  // handled atomically in the flip txn (staged path) and the legacy inline path below.
  // ---------------------------------------------------------------------------
  let groundingGateEscalated = false;
  let groundingGateReason = 'hallucinated_product_name';
  let groundingGateFailClosed = false;
  let groundingGateDetails: Record<string, unknown> | null = null;
  /**
   * P3-5 (R6/R13): declared `name` facts the consolidated gate did NOT flag as ungrounded — i.e.
   * products the reply named that the gate confirmed against the active catalog. Read far below by
   * the uncertain-answer carve-out. Stays 0 when the gate is off or ineligible, in which case that
   * carve-out falls back to the deterministic name-index scan.
   */
  let groundedDeclaredNameCount = 0;

  if (GROUNDING_GATE_CONSOLIDATED) {
    const gateEligible = !knowledgeGapEscalated && !isOosCannedReply && !isOrderConfirmationReply;
    if (gateEligible) {
      const gateDeps: GroundingGateDeps = {
        getPriceSet: getFullCatalogPriceSet,
        getNameIndex: getFullCatalogNameIndex,
        suspectNames: filterHallucinatedProductNames,
        verifyNames: (t, suspects, index) =>
          verifySuspectedNamesAgainstCatalog(t, suspects, index),
        // P3-1: injected, never imported by the gate — keeps the gate offline-testable. Both are
        // only ever reached once a declared attribute claim has already been parsed AND located in
        // the prose, so a turn with no attribute claim costs zero Redis reads and zero queries.
        getAttributeIndex: getFullCatalogAttributeIndex,
        resolveProductRef: (t, productRef, index) => resolveProductRef(t, productRef, index),
      };
      const verdict = await evaluateConsolidatedGrounding({
        tenantId,
        prose: finalReplyText,
        factsUsed,
        deps: gateDeps,
        nameLlmCap: NAME_GUARD_LLM_CATALOG_CAP,
        stripFloor: GROUNDING_GATE_STRIP_FLOOR,
        attributeMode: GROUNDING_GATE_ATTRIBUTE_FACTS,
        attributeMaxClaims: GROUNDING_ATTR_MAX_CLAIMS,
      });
      // P3-1: `declared` and `observed` are what make a SHADOW window legible. A lane that flags
      // nothing is ambiguous between "no fabrications" and "the model stopped declaring attribute
      // facts at all" — and a dead guard that looks green is precisely the failure this audit item
      // exists to prevent. Recording the declared count separates the two.
      const declaredAttributeCount = (factsUsed ?? []).filter((f) => f.type === 'attribute').length;
      const observedAttributes = verdict.ungroundedAttributes ?? verdict.shadowAttributes ?? [];
      // P3-5 (R6/R13): declared names minus the ones the gate could not ground = names this reply
      // stated that ARE real active products. The gate has already done the catalog resolution, so
      // reusing its result costs nothing and is more precise than a text scan over the prose.
      groundedDeclaredNameCount = Math.max(
        0,
        (factsUsed ?? []).filter((f) => f.type === 'name').length - verdict.ungroundedNames.length,
      );
      recordDecision({
        classifier: 'grounding_gate',
        raw_score: verdict.ungroundedPrices.length + verdict.ungroundedNames.length,
        threshold: null,
        boost_applied: false,
        passed: verdict.escalate || verdict.status === 'stripped',
        branch: verdict.status,
      });
      if (GROUNDING_GATE_ATTRIBUTE_FACTS !== 'off') {
        recordDecision({
          classifier: 'grounding_attribute_lane',
          raw_score: observedAttributes.length,
          threshold: null,
          boost_applied: false,
          passed: observedAttributes.length > 0,
          branch:
            `${GROUNDING_GATE_ATTRIBUTE_FACTS}:declared=${declaredAttributeCount}` +
            `:contradicted=${observedAttributes.length}` +
            `:scopes=${observedAttributes.map((a) => a.scope).join('|') || 'none'}`,
        });
      }

      if (verdict.escalate) {
        groundingGateEscalated = true;
        groundingGateReason = verdict.reason ?? 'grounding_check_unavailable';
        groundingGateFailClosed = verdict.failClosed ?? false;
        groundingGateDetails = {
          gate: 'consolidated_grounding',
          status: verdict.status,
          reason: groundingGateReason,
          ungroundedPrices: verdict.ungroundedPrices,
          ungroundedNames: verdict.ungroundedNames,
          // Spread, so the key is ABSENT when the attribute lane contributed nothing. `details` is
          // persisted verbatim into ai_alerts.details JSONB, and an unconditional `[]` would
          // change every flag-off escalation record.
          ...(verdict.ungroundedAttributes
            ? { ungroundedAttributes: verdict.ungroundedAttributes }
            : {}),
          originalReplyPreview: finalReplyText.slice(0, 200),
        };
        logger.warn('[GROUNDING GATE] Reply not fully grounded — escalating to holding message', {
          tenantId,
          conversationId,
          status: verdict.status,
          reason: groundingGateReason,
          ungroundedPrices: verdict.ungroundedPrices,
          ungroundedNames: verdict.ungroundedNames,
          replyPreview: logSafeStructured(finalReplyText),
        });
        finalReplyText = HOLDING_MESSAGES[replyLocale].productKnowledgeEscalation;
        // Quality flags were computed against the now-replaced reply; clear them.
        qualityFailing = false;
        flagReason = null;
      } else if (verdict.status === 'stripped') {
        logger.warn('[GROUNDING GATE] Ungrounded span(s) stripped — sending grounded remainder', {
          tenantId,
          conversationId,
          ungroundedPrices: verdict.ungroundedPrices,
          ungroundedNames: verdict.ungroundedNames,
          replyPreview: logSafeStructured(finalReplyText),
        });
        finalReplyText = verdict.text;
      }
    }
  }

  // Price-consistency guard (per-reply): hard gate — if the reply states a concrete
  // price that is NOT present in the reference price set, replace the reply with a
  // specialist holding message and schedule a post-send alert + AI pause.
  // Fail-open: skipped when another escalation already fired or when the reference set
  // carries no prices (can't validate nothing).
  //
  // With GUARD_VALIDATE_AGAINST_FULL_CATALOG on (P0-2, RC-02) the reference set is the
  // tenant's FULL active catalog plus AI-config ground-truth prices — never this turn's
  // volatile retrieval window — so a correct price for a real active product cannot be
  // flagged just because retrieval missed that product. The guard then also runs when
  // the window is empty, but skips order-confirmation replies: their totals
  // (quantity × unit price) are legitimate arithmetic present in no fact set.
  // Flag off preserves the legacy matchedProducts-scoped behaviour unchanged.
  let priceHallucinationEscalated = false;
  let priceHallucinationDetails: Record<string, unknown> | null = null;

  const priceGuardEligible =
    !GROUNDING_GATE_CONSOLIDATED && // P2-1: the consolidated gate above owns price grounding when on.
    !knowledgeGapEscalated &&
    !isOosCannedReply &&
    (GUARD_VALIDATE_AGAINST_FULL_CATALOG
      ? !isOrderConfirmationReply
      : matchedProducts.length > 0);

  if (priceGuardEligible) {
    let catalogPriceSet: CatalogPriceSet;
    let priceGuardScope: 'full_catalog' | 'matched_products' = 'matched_products';
    if (GUARD_VALIDATE_AGAINST_FULL_CATALOG) {
      try {
        catalogPriceSet = await getFullCatalogPriceSet(tenantId);
        priceGuardScope = 'full_catalog';
      } catch (err) {
        // Reference fetch failure must never widen escalation: fall back to the legacy
        // matched-products set (empty window ⇒ empty set ⇒ guard fails open).
        console.warn('[PRICE GUARD] Full-catalog price set unavailable — falling back to matched products', {
          tenantId,
          conversationId,
          err,
        });
        catalogPriceSet = buildCatalogPriceSet(matchedProducts);
      }
    } else {
      catalogPriceSet = buildCatalogPriceSet(matchedProducts);
    }
    const hallucinatedPrices = filterHallucinatedPrices(finalReplyText, catalogPriceSet);
    recordDecision({
      classifier: 'price_hallucination_guard',
      raw_score: hallucinatedPrices.length,
      threshold: null,
      boost_applied: false,
      passed: hallucinatedPrices.length > 0,
      branch: hallucinatedPrices.length > 0 ? 'escalate' : 'pass',
    });
    if (hallucinatedPrices.length > 0) {
      logger.warn('[PRICE GUARD] Reply states price(s) not in catalog — escalating to holding message', {
        tenantId,
        conversationId,
        validationScope: priceGuardScope,
        statedPrices: hallucinatedPrices.map((p) => p.raw),
        catalogPrices: catalogPriceSet.prices.slice(0, 100),
        catalogPriceCount: catalogPriceSet.prices.length,
        replyPreview: logSafeStructured(finalReplyText),
      });
      priceHallucinationDetails = {
        validationScope: priceGuardScope,
        statedPrices: hallucinatedPrices.map((p) => p.raw),
        catalogPrices: catalogPriceSet.prices.slice(0, 100),
        catalogPriceCount: catalogPriceSet.prices.length,
        originalReplyPreview: finalReplyText.slice(0, 200),
      };
      priceHallucinationEscalated = true;
      // Replace the hallucinated-price reply with a safe holding message. Using the
      // product-knowledge escalation copy because the issue is incorrect catalog data
      // in the reply, requiring a specialist to provide the accurate price.
      finalReplyText = HOLDING_MESSAGES[replyLocale].productKnowledgeEscalation;
      // Clear quality-eval flags: they were computed against the replaced reply and are
      // no longer applicable to the (safe) holding message being sent instead.
      qualityFailing = false;
      flagReason = null;
    }

    // Cross-turn price consistency (advisory only): log when the current reply
    // contradicts a price stated by the AI in a recent prior turn. Left as a warning
    // because a genuine price change is legitimate and would produce false positives if
    // escalated. Human agents can review via the conversation history.
    if (!priceHallucinationEscalated) {
      const crossTurnInconsistencies = detectCrossMessagePriceInconsistency(
        finalReplyText,
        recentMessages,
      );
      if (crossTurnInconsistencies.length > 0) {
        logger.warn('[PRICE GUARD] Cross-turn price inconsistency detected', {
          tenantId,
          conversationId,
          inconsistencies: crossTurnInconsistencies,
          replyPreview: logSafeStructured(finalReplyText),
        });
      }
    }
  }

  // Product-name hallucination guard: block any reply that names a specific product
  // not present in the reference catalog. Architecturally mirrors the price
  // hallucination guard: when fired it replaces the reply with a safe holding message,
  // creates an alert, and pauses AI so a human specialist can follow up.
  //
  // With GUARD_VALIDATE_AGAINST_FULL_CATALOG on (P0-2, RC-02) the LLM classifier's
  // output is treated as SUSPECTS only: each suspected name is deterministically
  // re-verified against the FULL active catalog (normalized name index, then a
  // pg_trgm similarity lookup) and only names with no catalog match escalate. This
  // stops the guard from flagging a real product the AI itself named earlier just
  // because this turn's retrieval window rotated away from it. The guard then also
  // runs when the window is empty, using a capped catalog sample as the LLM reference
  // (the deterministic verification stays uncapped). Flag off preserves the legacy
  // matchedProducts-scoped behaviour unchanged.
  //
  // Skipped when: nothing to validate against, another escalation already fired, the
  // reply is a canned OOS message, or the guard itself errors out (fail-open — the
  // guard must never silently suppress a valid reply).
  let productNameHallucinationEscalated = false;
  let productNameHallucinationDetails: Record<string, unknown> | null = null;

  if (
    !GROUNDING_GATE_CONSOLIDATED && // P2-1: the consolidated gate above owns name grounding when on.
    !knowledgeGapEscalated &&
    !priceHallucinationEscalated &&
    !isOosCannedReply &&
    (GUARD_VALIDATE_AGAINST_FULL_CATALOG || matchedProducts.length > 0)
  ) {
    try {
      let referenceNames = matchedProducts
        .map((p) => p.name?.trim())
        .filter((n): n is string => Boolean(n));
      let fullCatalogNameIndex: string[] | null = null;
      if (GUARD_VALIDATE_AGAINST_FULL_CATALOG) {
        // Any failure here lands in the outer catch → fail-open, same as an LLM error.
        fullCatalogNameIndex = await getFullCatalogNameIndex(tenantId);
        if (referenceNames.length === 0) {
          referenceNames = fullCatalogNameIndex.slice(0, NAME_GUARD_LLM_CATALOG_CAP);
        }
      }

      const nameGuardResult = await filterHallucinatedProductNames(finalReplyText, referenceNames);
      let confirmedNames = nameGuardResult.suspectedNames;
      if (
        nameGuardResult.hasHallucination &&
        GUARD_VALIDATE_AGAINST_FULL_CATALOG &&
        fullCatalogNameIndex
      ) {
        const verification = await verifySuspectedNamesAgainstCatalog(
          tenantId,
          nameGuardResult.suspectedNames,
          fullCatalogNameIndex,
        );
        confirmedNames = verification.confirmed;
        if (verification.rescued.length > 0) {
          console.info('[PRODUCT NAME GUARD] Suspect(s) matched the full active catalog — not hallucinations', {
            tenantId,
            conversationId,
            rescued: verification.rescued,
          });
        }
      }

      recordDecision({
        classifier: 'product_name_hallucination_guard',
        raw_score: confirmedNames.length,
        threshold: null,
        boost_applied: false,
        passed: confirmedNames.length > 0,
        branch: confirmedNames.length > 0 ? 'escalate' : 'pass',
      });
      if (confirmedNames.length > 0) {
        logger.warn('[PRODUCT NAME GUARD] Reply names product(s) not in catalog — escalating to holding message', {
          tenantId,
          conversationId,
          validationScope: GUARD_VALIDATE_AGAINST_FULL_CATALOG ? 'full_catalog' : 'matched_products',
          suspectedNames: confirmedNames,
          catalogNames: referenceNames.slice(0, 50),
          replyPreview: logSafeStructured(finalReplyText),
        });
        productNameHallucinationDetails = {
          validationScope: GUARD_VALIDATE_AGAINST_FULL_CATALOG ? 'full_catalog' : 'matched_products',
          suspectedNames: confirmedNames,
          catalogNames: referenceNames.slice(0, 50),
          originalReplyPreview: finalReplyText.slice(0, 200),
        };
        productNameHallucinationEscalated = true;
        finalReplyText = HOLDING_MESSAGES[replyLocale].productKnowledgeEscalation;
        qualityFailing = false;
        flagReason = null;
      }
    } catch (err) {
      console.warn('[PRODUCT NAME GUARD] Guard check failed — continuing with original reply', {
        tenantId,
        conversationId,
        err,
      });
    }
  }

  // Uncertain-answer fallback guard (additive safety layer — runs last among the
  // content guards). When the about-to-be-sent reply is a generic
  // knowledge/uncertainty deflection ("we don't have information about that",
  // "I'm not sure", "I don't know", "we don't carry that product") and NO earlier
  // escalation already handled this turn, replace it with a polite holding message
  // and escalate to a human. This prevents unprofessional deflections and hands
  // genuinely-uncertain cases to the business instead of risking a wrong answer.
  //
  // Reuses the upstream negative-availability classifier result and adds
  // deterministic knowledge/uncertainty detection. Excludes the deliberate
  // out-of-stock canned reply and order-flow replies so normal behaviour is never
  // affected. The actual pause/alert/flag happens after the message is persisted
  // (mirrors the price/name hallucination guards) so the alert can link to it.
  let uncertainAnswerEscalated = false;
  let uncertainAnswerDetails: Record<string, unknown> | null = null;

  // P3-5 (RC-25/RC-26, rules R6/R13): the carve-out's reference set.
  //
  // THE DEFECT. `hasMatchingProductsInContext` was `matchedProducts.length > 0` — THIS TURN's
  // retrieval window. The guard's own doc comment states the intent as "the catalog context
  // contained matching alternatives the AI could offer", and the two diverge exactly when
  // retrieval misses. R6 ("if a product is not available, clearly say so") and R13 ("say it is
  // unavailable and suggest 2-3 alternatives") MANDATE that reply — and the guard replaced it
  // with a holding message and paused the conversation, a pause with no automatic exit. The
  // prompt told the model to do something the pipeline then punished it for.
  //
  // THE FIX is the same widening P0-2 gave the price and name guards: also accept "the reply
  // named a product that exists in the FULL ACTIVE CATALOG". Note what this is NOT — it is not
  // "the tenant has any active product", which would make the predicate true for every stocked
  // tenant and silently delete the negative-availability lane rather than fix it.
  //
  // Two sources, most precise first:
  //   1. the consolidated gate already RESOLVED the model's declared `name` facts against the
  //      active catalog, so a declared name it did not flag is a confirmed real product;
  //   2. otherwise a deterministic word-boundary scan over the cached active-name index.
  const uncertainGuardAlreadyEscalated =
    knowledgeGapEscalated ||
    priceHallucinationEscalated ||
    productNameHallucinationEscalated ||
    groundingGateEscalated;

  // Computed ONLY when the guard can actually read it. `shouldEscalateUncertainAnswer` consults
  // `hasMatchingProductsInContext` on exactly one branch — negative-availability, after four
  // earlier short-circuits — so evaluating it unconditionally would put a catalog fetch on every
  // normal reply for a value thrown away. The retrieval window being empty is also a precondition:
  // a populated window already suppresses, and the catalog scan could only agree with it.
  let replyNamedRealProduct = false;
  if (
    UNCERTAIN_GUARD_CATALOG_ALTERNATIVES &&
    matchedProducts.length === 0 &&
    containsNegativeAvailabilityPhrase &&
    !uncertainGuardAlreadyEscalated &&
    !isOosCannedReply &&
    !isOrderConfirmationReply
  ) {
    if (groundedDeclaredNameCount > 0) {
      replyNamedRealProduct = true;
    } else {
      try {
        const nameIndex = await getFullCatalogNameIndex(tenantId);
        replyNamedRealProduct = replyNamesActiveCatalogProduct(finalReplyText, nameIndex);
      } catch (err) {
        // Reference fetch failure must never WIDEN escalation beyond the legacy behaviour: fall
        // back to false, which is exactly what the pre-P3-5 code passed in this situation.
        console.warn('[UNCERTAIN ANSWER GUARD] Catalog name index unavailable — using legacy scope', {
          tenantId,
          conversationId,
          err,
        });
      }
    }
  }

  if (
    shouldEscalateUncertainAnswer({
      replyText: finalReplyText,
      enabled: UNCERTAIN_ANSWER_FALLBACK_ENABLED,
      alreadyEscalated: uncertainGuardAlreadyEscalated,
      isOosCannedReply,
      isOrderFlowReply: isOrderConfirmationReply,
      negativeAvailabilityDetected: containsNegativeAvailabilityPhrase,
      hasMatchingProductsInContext: matchedProducts.length > 0 || replyNamedRealProduct,
    })
  ) {
    logger.warn('[UNCERTAIN ANSWER GUARD] Reply is a generic deflection — escalating to holding message', {
      tenantId,
      conversationId,
      negativeAvailabilityDetected: containsNegativeAvailabilityPhrase,
      replyPreview: logSafeStructured(finalReplyText),
    });
    uncertainAnswerDetails = {
      kind: 'uncertain_answer_fallback',
      negative_availability_detected: containsNegativeAvailabilityPhrase,
      customer_question: inboundText || null,
      originalReplyPreview: finalReplyText.slice(0, 200),
    };
    uncertainAnswerEscalated = true;
    finalReplyText = GET_BACK_TO_YOU_MESSAGES[replyLocale === 'sq' ? 'sq' : 'en'];
    // The quality flags were computed against the replaced reply and no longer apply
    // to the safe holding message being sent instead.
    qualityFailing = false;
    flagReason = null;
  }

  // Final consistency guard: strip any "we'll notify you shortly regarding X" notice
  // whose attribute the reply has ALREADY answered, so a single message can never both
  // state a value and promise to provide that same value later. Runs on the fully
  // composed text (covers every upstream path) and is a no-op when no contradiction
  // exists. Locale narrows to the notice copy's supported locales ('sq' | 'en').
  //
  // In multi-product partial escalations the notice legitimately names an attribute that
  // appears in the reply for one product but is genuinely missing for others — the
  // multiProduct flag prevents it from being stripped in that case.
  finalReplyText = stripContradictoryMissingInfoNotice(
    finalReplyText,
    replyLocale === 'sq' ? 'sq' : 'en',
    { multiProduct: isMultiProductGap && productKnowledgeEscalated },
  );

  // Presentation-only cleanup applied as the very last step so the sent message and
  // the persisted message match: strip Markdown emphasis (no bold product names) and
  // collapse excessive blank lines (no big vertical gaps on Instagram). This changes
  // formatting only, never the wording or any decision made above.
  finalReplyText = sanitizeOutboundMessageText(finalReplyText);

  // ---- Product image request handling ------------------------------------
  // Detect when the customer explicitly asked to see a product photo and, if so,
  // resolve which product(s) they want, override the AI's text reply with a clean
  // canned confirmation, and queue up image messages to send after the text.
  //
  // This block runs AFTER all guards (usage, knowledge-gap, price, name, uncertain)
  // so image sending is always skipped when an escalation already fired.
  const anyEscalationFired =
    usageEscalated ||
    knowledgeGapEscalated ||
    priceHallucinationEscalated ||
    productNameHallucinationEscalated ||
    groundingGateEscalated ||
    uncertainAnswerEscalated;

  if (imageClassification?.is_image_request && !anyEscalationFired) {
    const imgLocale = replyLocale === 'sq' ? 'sq' : 'en';
    try {
      // Load products discussed in recent AI messages so positional references
      // like "the second one" resolve against the full set the customer has seen.
      const recentHistoryProducts = await resolveProductsFromPersistedContext(
        tenantId,
        recentMessages,
        10,
      );
      // The texts of recent AI replies are the scope guard for broad references: the
      // persisted product_ids are the whole retrieval pool, but the customer has only
      // SEEN the products the AI actually wrote out in these messages.
      const recentAiTexts = recentMessages
        .filter((m) => m.sent_by === 'ai' && typeof m.content === 'string' && m.content.trim())
        .slice(-4)
        .map((m) => m.content as string);
      const resolution = resolveProductsForImageRequest(
        imageClassification.product_refs,
        matchedProducts,
        recentHistoryProducts,
        recentAiTexts,
      );

      // Recover named products whose image lives on a catalog row that wasn't in this
      // turn's context (or resolved to an imageless sibling variant). This is what turns
      // a spurious "we'll send the photo shortly" back into an actual image send when the
      // business HAS uploaded a photo for the product the customer asked about.
      const targetProducts = await augmentImageTargetsFromCatalog(
        tenantId,
        imageClassification.product_refs,
        resolution.targets,
      );

      const decision = decideImageRequestOutcome(targetProducts);
      productsToSendImages = decision.withImages;
      productsWithMissingImages = decision.missingImages;

      // A detected photo request NEVER ships the raw model reply: the model has no
      // photo-sending knowledge, so its text on these turns is at best redundant and at
      // worst an improvised "I can't send photos" apology (the original Bug #2). Every
      // outcome — images, missing images, or nothing resolved — gets canned copy.
      finalReplyText = buildImageReplyText(imgLocale, decision.withImages, decision.missingImages);

      if (decision.outcome === 'holding_unresolved') {
        imageRequestUnresolvedDetails = {
          refs: imageClassification.product_refs ?? [],
          matched_count: matchedProducts.length,
          recent_count: recentHistoryProducts.length,
          discussed_count: resolution.trace.discussedCount,
        };
        console.warn('[image_request] unresolved — holding text sent', {
          conversationId,
          tenantId,
          ...imageRequestUnresolvedDetails,
        });
      }

      recordDecision({
        classifier: 'product_image_request',
        raw_score: targetProducts.length,
        threshold: null,
        boost_applied: false,
        passed: decision.outcome === 'send_images',
        branch: decision.outcome,
      });

      console.info('[image_request] resolution', {
        conversationId,
        tenantId,
        refs: imageClassification.product_refs,
        contextPoolSize: resolution.trace.contextPoolSize,
        discussedCount: resolution.trace.discussedCount,
        matches: resolution.trace.matches,
        capped: resolution.trace.capped,
        augmentedIds: targetProducts
          .filter((p) => !resolution.targets.some((t) => t.id === p.id))
          .map((p) => p.id),
        outcome: decision.outcome,
        productsWithImages: decision.withImages.map((p) => p.id),
        productsWithoutImages: decision.missingImages.map((p) => p.id),
      });
    } catch (imageResolutionErr) {
      // Same invariant under failure: holding copy, never the raw model reply.
      finalReplyText = buildImageReplyText(imgLocale, [], []);
      imageRequestUnresolvedDetails = {
        refs: imageClassification.product_refs ?? [],
        matched_count: matchedProducts.length,
        recent_count: 0,
        discussed_count: 0,
      };
      console.warn(
        '[ai.reply] Product image request resolution failed — holding reply sent',
        {
          conversationId,
          tenantId,
          error:
            imageResolutionErr instanceof Error
              ? imageResolutionErr.message
              : String(imageResolutionErr),
        },
      );
    }
  }
  // ---- End product image request handling --------------------------------

  // Alert details shared by the staged (outbox) and legacy alert sites below: a photo
  // request that left some products photo-less, or one that resolved to nothing at all.
  const imageAlertDetails:
    | {
        kind: 'missing_image' | 'unresolved_reference';
        product_ids: string[];
        product_names: string[];
        refs?: ProductImageRef[];
        matched_count?: number;
        recent_count?: number;
        discussed_count?: number;
      }
    | null =
    productsWithMissingImages.length > 0
      ? {
          kind: 'missing_image',
          product_ids: productsWithMissingImages.map((p) => p.id),
          product_names: productsWithMissingImages.map((p) => p.name),
        }
      : imageRequestUnresolvedDetails
        ? {
            kind: 'unresolved_reference',
            product_ids: [],
            product_names: [],
            ...imageRequestUnresolvedDetails,
          }
        : null;

  const contact = await findContactById(conversation.contact_id);

  // When the turn was replaced by a generic holding/escalation message (knowledge gap, price or
  // product-name hallucination), the customer was NOT shown these products, so their ids must not
  // be persisted (a later follow-up would silently reuse products never presented). Computed here
  // so the staged and legacy persist paths agree.
  const replyWasHoldingOrEscalation =
    knowledgeGapEscalated ||
    priceHallucinationEscalated ||
    productNameHallucinationEscalated ||
    groundingGateEscalated ||
    uncertainAnswerEscalated;
  const persistedProductIds = replyWasHoldingOrEscalation ? [] : matchedProducts.map((p) => p.id);

  // P2-3 (RC-13): persist the last-recommended product anchor so the slot-backed summary can
  // re-inject a still-in-stock prior recommendation even after it slides past the 40-row window. The
  // writer REPLACES on a non-empty list and skips empty (holding/escalation), so a later holding turn
  // never wipes a real prior anchor. Computed here → covers both the staged and legacy persist paths.
  if (SUMMARY_SLOT_BACKED && persistedProductIds.length > 0) {
    await persistLastRecommendedProductIds(conversationId, tenantId, persistedProductIds).catch((e) =>
      logger.warn('[P2-3] persistLastRecommendedProductIds failed', {
        conversationId,
        err: String(e),
      }),
    );
  }

  // Product image send (idempotent via the ai_img_sent marker). Extracted so both the staged
  // (P1-1) and legacy reply paths deliver images identically.
  const sendProductImagesForReply = async (): Promise<void> => {
    const imgIdemKey = `ai_img_sent:${conversationId}:${data.messageExternalId}`;
    const imagesAlreadySent =
      productsToSendImages.length > 0
        ? !!(await redisConnection.get(imgIdemKey).catch(() => null))
        : false;
    if (imagesAlreadySent) {
      console.warn('[ai.reply] Product image(s) already delivered on a prior attempt — skipping duplicate image send', {
        conversationId,
        scheduledFor: data.messageExternalId,
      });
      return;
    }
    if (productsToSendImages.length > 0 && contact) {
      let allImagesSent = true;
      for (const imageProduct of productsToSendImages) {
        const imageUrl = imageProduct.image_urls[0];
        if (!imageUrl) continue;
        try {
          const imageResult = await sendImageMessage(channel, contact.external_id, imageUrl);
          if (imageResult.success) {
            await markSelfSentMessageEcho(imageResult.graphMessageId);
            console.info('[ai.reply] Product image sent', {
              conversationId,
              tenantId,
              productId: imageProduct.id,
              productName: imageProduct.name,
            });
          } else {
            allImagesSent = false;
            logger.error('[ai.reply] Product image send failed', imageResult.error, {
              conversationId,
              tenantId,
              productId: imageProduct.id,
            });
          }
        } catch (imgErr) {
          allImagesSent = false;
          logger.error('[ai.reply] Product image send threw unexpectedly', imgErr, {
            conversationId,
            tenantId,
            productId: imageProduct.id,
          });
        }
      }
      if (allImagesSent) {
        await redisConnection.set(imgIdemKey, '1', 'EX', 3600).catch(() => undefined);
      }
    }
  };

  // ---- P2-6 (RC-19): the graceful-degradation gate. ----
  //
  // THE one decision point for the whole turn's provider posture, placed here because this is the
  // last moment before anything reaches the customer and every pre-send guard has now run (or
  // silently not run). If any OpenAI call this turn failed, the reply above was assembled from
  // guards that may have fail-opened — `classifySpeculativeHealthAdvice` returning `false` on a
  // transport error is indistinguishable, at this point, from it returning `false` because the
  // text is clean. So we do not send it: holding + escalate instead.
  //
  // Deliberately reads a counter rather than catching an exception — see GRACEFUL_DEGRADE_MODE.
  const turnFailures = turnProviderFailures();
  if (shouldDegradeTurn(turnFailures, gracefulDegradeMode())) {
    await degradeToHoldingAndEscalate();
    // Record the degradation in the ledger BEFORE returning. The verdict literal below is never
    // reached on this path, so without this the ledger would only ever show a healthy breaker —
    // exactly the state nobody needs to investigate.
    void writeLedgerBestEffort(
      buildJobLedgerRecord({
        tenantId,
        conversationId,
        correlationId: ledgerCorrelationId,
        traceId,
        replySlot: 'holding:degraded',
        decisionKind: 'escalation:provider_unavailable',
        messageId: lastInbound?.id ?? null,
        decisionEvents,
        guardVerdicts: {
          providerBreaker: providerBreaker.snapshot(breakerMode()),
          providerFailures: summarizeTurnFailures(turnFailures),
          degraded: true,
        },
      }),
    );
    return;
  }

  // P2-6: re-arm — NOT clear — the turn's OpenAI budget before the send.
  //
  // The audit's edge case is "the deadline must not abort mid-send (scope to pre-send)". But simply
  // nulling the budget would hand `runOrderDetectionTail()` an UNBOUNDED one, and that tail makes
  // OpenAI calls from inside the very try whose `finally` releases `ai_conv_lock` — re-creating the
  // exact lock-expiry defect P2-6 exists to remove. A fresh budget bounds the tail without letting
  // pre-send spend starve it (a starved order detection forfeits a commissionable order).
  rearmTurnDeadline(OPENAI_TURN_DEADLINE_MS);

  // P2-6 (F1): past this point a throw may race an in-flight send — the outer catch must not
  // substitute the holding floor for a reply that might already be on the wire.
  preSendPhase = false;

  let sendResult:
    | Awaited<ReturnType<typeof sendMessage>>
    | null = null;
  let outboundMessage: Message;
  let alreadySent = false;

  // ---- P1-1 (RC-20): durable stage-before-send when enabled for this channel ----
  // P1-5: the guard verdicts + the branch the reply took, shared by the staging row and the
  // decision ledger.
  const ledgerGuardVerdicts = {
    knowledgeGapEscalated,
    priceHallucinationEscalated,
    productNameHallucinationEscalated,
    groundingGateEscalated,
    groundingGateReason: groundingGateEscalated ? groundingGateReason : null,
    uncertainAnswerEscalated,
    // P2-6: which config served this reply, and whether the provider misbehaved on the way. Scalars
    // only — `guard_verdicts` is already Record<string, unknown>, so this needs no migration.
    providerBreaker: providerBreaker.snapshot(breakerMode()),
    providerFailures: summarizeTurnFailures(turnFailures),
    degraded: false,
    // P2-3/P2-4 audit gap: when ANY guard changed the text, persist the pre-guard draft
    // (hash + redacted capped preview) — makes "the delivered corrected text is history, the
    // flagged draft is ledger-recorded" true. Null when the draft shipped untouched (no bloat
    // on the common path). Redacted through the same PII boundary as the prompt preview.
    draft:
      finalReplyText === replyText
        ? null
        : {
            hash: crypto.createHash('sha256').update(replyText).digest('hex'),
            char_count: replyText.length,
            preview: String(redactForLog(replyText)).slice(0, 2000),
          },
  };
  const ledgerDecisionKind = groundingGateEscalated
    ? `escalation:grounding:${groundingGateReason}`
    : productNameHallucinationEscalated
      ? 'escalation:product_name'
      : priceHallucinationEscalated
        ? 'escalation:price'
        : knowledgeGapEscalated
          ? 'escalation:knowledge_gap'
          : uncertainAnswerEscalated
            ? 'escalation:uncertain'
            : 'reply';
  const stageEnabled = isStageBeforeSendEnabled(channel.type);
  // P1-1 (RC-20): with staging on AND the relay owning dispatch, the deterministic tail
  // side-effects are outbox rows written in the flip txn (exactly-once via the relay); the
  // inline tail versions are skipped.
  const outboxOwnedEffects = stageEnabled && OUTBOX_OWNS_REPLY_EFFECTS;
  // The stable key for this logical reply — the same key stageAndSend derives internally; used
  // here to build the per-effect outbox dedupe keys.
  const mainReplyIdemKey = deriveReplyIdempotencyKey({
    conversationId,
    logicalInboundExternalId: data.messageExternalId,
    replySlot: 'main',
  });
  // Escalation/quality alerts created ATOMICALLY inside the flip txn (staged path) are captured
  // here so their socket emits + the feedback-log side-effect can run after the commit.
  let flipEscalationAlert: AIAlert | undefined;
  let flipQualityAlert: AIAlert | undefined;
  // True when this attempt is a retry of a reply the first attempt already delivered+persisted.
  // The deterministic side-effects committed with the flip (or ran on the first attempt); only
  // the order-detection tail below re-runs, guarded by its completion marker + the existing
  // duplicate-order dedupe.
  let isRetryOfDeliveredReply = false;
  if (stageEnabled) {
    const staged = await stageAndSend({
      tenantId,
      conversationId,
      channelType: channel.type,
      logicalInboundExternalId: data.messageExternalId,
      replySlot: 'main',
      replyText: finalReplyText,
      qualityScore,
      flagged: qualityFailing,
      flagReason,
      productIds: persistedProductIds,
      guardVerdicts: ledgerGuardVerdicts,
      // P1-5: write the decision-ledger row THROUGH the outbox in the SAME flip txn as the reply
      // persist (under a SAVEPOINT, so a ledger failure can never roll back a delivered reply).
      // P1-1 (RC-20): the escalation/quality pause + alert and the deterministic side-effect
      // outbox rows are part of the SAME transaction, so a delivered holding message can never
      // commit without its pause/alert, and a crash after the commit can never lose the
      // analytics / use-case / rate-count / send-failure effects.
      onFlip: async (client, message, sendSucceeded) => {
        await enqueueLedgerViaOutbox(
          client,
          buildJobLedgerRecord({
            tenantId,
            conversationId,
            correlationId: ledgerCorrelationId,
            traceId,
            replySlot: 'main',
            decisionKind: ledgerDecisionKind,
            messageId: message.id,
            telemetry: replyTelemetry,
            decisionEvents,
            guardVerdicts: ledgerGuardVerdicts,
            factsUsed,
          }),
        );

        // Escalation pause + alert, atomic with the delivered holding message. Mirrors the
        // legacy inline blocks below (which are skipped when staging is on). The guard kinds
        // are mutually exclusive by construction of the guard phase.
        if (priceHallucinationEscalated) {
          flipEscalationAlert = await createAIAlert(
            {
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: message.id,
              reason: 'hallucinated_price',
              details: priceHallucinationDetails,
            },
            client,
          );
          await setConversationAiPaused(conversationId, tenantId, true, client, 'hallucinated_price');
        } else if (productNameHallucinationEscalated) {
          flipEscalationAlert = await createAIAlert(
            {
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: message.id,
              reason: 'hallucinated_product_name',
              details: productNameHallucinationDetails,
            },
            client,
          );
          await setConversationAiPaused(conversationId, tenantId, true, client, 'hallucinated_product_name');
        } else if (uncertainAnswerEscalated) {
          flipEscalationAlert = await createAIAlert(
            {
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: message.id,
              reason: UNCERTAIN_ANSWER_ALERT_REASON,
              details: uncertainAnswerDetails,
            },
            client,
          );
          await setConversationAiPaused(conversationId, tenantId, true, client, 'uncertain_answer_escalated');
          await setConversationHumanReplied(conversationId, tenantId, false, client);
        } else if (groundingGateEscalated) {
          // P2-1: the consolidated grounding gate escalated (ungrounded fact or catalog-index
          // infra error). Dynamic reason; `grounding_check_unavailable` carries fail_closed=true.
          flipEscalationAlert = await createAIAlert(
            {
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: message.id,
              reason: groundingGateReason,
              details: groundingGateDetails,
              fail_closed: groundingGateFailClosed,
            },
            client,
          );
          await setConversationAiPaused(conversationId, tenantId, true, client, groundingGateReason);
          // Deliberately NO human_replied write here (unlike the uncertain-answer block above):
          // it is the sticky "any human reply ever" flag and the sole human-participation input
          // to use-case billability. Forcing it false on a gate escalation (incl. a transient
          // grounding_check_unavailable) would re-qualify a human-touched conversation for the
          // use-case fee once the alert is resolved with resume_ai. Pinned by
          // replyPathSourceInvariants.test.ts.
        }
        if (qualityFailing && flagReason) {
          flipQualityAlert = await createAIAlert(
            {
              tenant_id: tenantId,
              conversation_id: conversationId,
              message_id: message.id,
              reason: flagReason,
            },
            client,
          );
          await setConversationAiPaused(conversationId, tenantId, true, client, flagReason);
        }

        // Deterministic side-effects as exactly-once outbox rows (relay-dispatched).
        if (OUTBOX_OWNS_REPLY_EFFECTS) {
          if (sendSucceeded) {
            await insertOutboxTx(client, {
              tenant_id: tenantId,
              conversation_id: conversationId,
              topic: 'analytics.ai_reply_sent',
              dedupe_key: `analytics.ai_reply_sent:${mainReplyIdemKey}`,
              payload: {
                conversation_id: conversationId,
                channel_id: channelId,
                message_id: message.id,
              },
            });
            await insertOutboxTx(client, {
              tenant_id: tenantId,
              conversation_id: conversationId,
              topic: 'usecase.eval',
              dedupe_key: `usecase.eval:${mainReplyIdemKey}`,
              payload: { conversationId, tenantId },
            });
            if (
              shouldCountDeliveredReply({
                countDeliveredOnly: RATE_LIMIT_COUNT_DELIVERED_ONLY,
                sendSucceeded: true,
              })
            ) {
              await insertOutboxTx(client, {
                tenant_id: tenantId,
                conversation_id: conversationId,
                topic: 'reply.ratecount',
                dedupe_key: `reply.ratecount:${mainReplyIdemKey}`,
                payload: {
                  rate_limit_key: rateLimitKey,
                  marker_key: rateCountedMarkerKey(conversationId, data.messageExternalId),
                },
              });
            }
          } else {
            await insertOutboxTx(client, {
              tenant_id: tenantId,
              conversation_id: conversationId,
              topic: 'alert.message_send_failed',
              dedupe_key: `alert.message_send_failed:${mainReplyIdemKey}`,
              payload: { conversation_id: conversationId, message_id: message.id },
            });
          }
          if (imageAlertDetails) {
            await insertOutboxTx(client, {
              tenant_id: tenantId,
              conversation_id: conversationId,
              topic: 'alert.product_image_unavailable',
              dedupe_key: `alert.product_image_unavailable:${mainReplyIdemKey}`,
              payload: {
                conversation_id: conversationId,
                message_id: message.id,
                details: imageAlertDetails,
              },
            });
          }
        }
      },
      send: (text) =>
        contact
          ? sendMessage(channel, contact.external_id, text)
          : Promise.resolve({ success: false, error: 'Contact not found for conversation' }),
    });
    if (!staged.wasFirstDelivery) {
      // Retry of an already-delivered reply: the message row, the escalation pause/alert, and
      // (when the relay owns dispatch) every deterministic side-effect committed with the first
      // attempt's flip. Re-emit the socket best-effort, then fall through ONLY to the
      // order-detection tail (marker-guarded below) so a crash mid-tail on the first attempt
      // cannot silently forfeit a draft order/commission (RC-20/RC-22).
      if (staged.outboundMessage) {
        socketService.emitNewMessage(tenantId, staged.outboundMessage);
        socketService.emitConversationUpdated(tenantId, conversationId);
      }
      console.info('[ai.reply] Reply already delivered on a prior attempt — resuming tail only', {
        conversationId,
        scheduledFor: data.messageExternalId,
      });
      if (!staged.outboundMessage) {
        // No persisted row to anchor the tail on (should not happen) — nothing to self-heal.
        return;
      }
      isRetryOfDeliveredReply = true;
      outboundMessage = staged.outboundMessage;
      sendResult = staged.sendResult ?? null;
      finalReplyText = staged.replyText;
      // Self-heal product images too — the ai_img_sent marker no-ops anything already delivered.
      await sendProductImagesForReply();
    } else {
    outboundMessage = staged.outboundMessage!;
    sendResult = staged.sendResult ?? null;
    finalReplyText = staged.replyText;
    await sendProductImagesForReply();
    // Post-commit emits + feedback-log for alerts created atomically inside the flip.
    if (flipEscalationAlert || flipQualityAlert) {
      const contactForFlipAlert = await findContactById(conversation.contact_id);
      for (const flipAlert of [flipEscalationAlert, flipQualityAlert]) {
        if (!flipAlert) continue;
        socketService.emitAIAlert(tenantId, {
          ...flipAlert,
          message_content: outboundMessage.content,
          contact_name: contactForFlipAlert?.name?.trim() || 'Customer',
          channel_type: channel.type,
          channel_name: channel.name,
        });
      }
      socketService.emitConversationUpdated(tenantId, conversationId);
      if (flipQualityAlert) {
        // Feedback→fine-tuning loop (see the legacy quality block below for rationale).
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
    }
  } else {
  // ---- Idempotent send guard ----------------------------------------------
  // If the channel send on a PRIOR attempt succeeded but a later step (e.g.
  // persisting the outbound message) failed, BullMQ retries the whole job. This
  // marker — keyed by the inbound message this reply answers — ensures the retry
  // does NOT deliver a second copy of the reply to the customer. We still fall
  // through to persist the outbound row (reusing the original channel message id)
  // so the conversation record self-heals.
  const sendIdemKey = `ai_send_done:${conversationId}:${data.messageExternalId}`;
  const priorSendMarker = await redisConnection.get(sendIdemKey).catch(() => null);
  alreadySent = !!priorSendMarker;
  const priorGraphMessageId =
    priorSendMarker && priorSendMarker !== '1' ? priorSendMarker : null;

  // When usage escalation fired we already set ai_paused=true ourselves.
  // shouldStillSendAutomatedReply would read that flag and abort the send,
  // preventing the holding message from ever reaching the customer.
  // Skip the precheck in that case — we still need to deliver the holding message.
  // Also skip it when a prior attempt already sent this reply: re-running the
  // precheck on retry could abort and leave the sent message unpersisted.
  const mainSendPrecheck = knowledgeGapEscalated || alreadySent
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
    // P2-4 Part 2 (RC-17): a reply that was GENERATED (tokens already spent, every guard already
    // run) and then suppressed by the pre-send re-validation used to leave zero ledger rows — the
    // one decision the rest of P2-4 exists to make observable. Record it.
    //
    // Distinct slot: `deriveReplyIdempotencyKey` is slot-keyed and the insert is
    // ON CONFLICT (idempotency_key) DO NOTHING, so reusing 'main' would let this suppressed row
    // permanently mask the delivered row a later retry writes.
    void writeLedgerBestEffort(
      buildJobLedgerRecord({
        tenantId,
        conversationId,
        correlationId: ledgerCorrelationId,
        traceId,
        replySlot: 'main:suppressed',
        decisionKind: `suppressed:${mainSendPrecheck.reason}`,
        messageId: null,
        telemetry: replyTelemetry,
        decisionEvents,
        guardVerdicts: ledgerGuardVerdicts,
        factsUsed,
      }),
    );
    return;
  }
  if (alreadySent) {
    console.warn('[ai.reply] Reply already delivered on a prior attempt — skipping duplicate send', {
      conversationId,
      scheduledFor: data.messageExternalId,
    });
  } else if (contact) {
    sendResult = await sendMessage(channel, contact.external_id, finalReplyText);
    // Record the successful delivery so a retry cannot double-send. Stores the
    // channel message id (when available) so the persisted row stays consistent.
    if (sendResult?.success) {
      await redisConnection
        .set(sendIdemKey, sendResult.graphMessageId ?? '1', 'EX', 3600)
        .catch(() => undefined);
      // Remember this send id so Meta's echo of it (which arrives before this reply's row is
      // persisted below) is recognised as our own and never mistaken for a human-agent handoff.
      await markSelfSentMessageEcho(sendResult.graphMessageId);
    }
  } else {
    logger.error('[ai.reply] Contact not found for conversation', undefined, {
      contactId: conversation.contact_id,
    });
  }

    // Send product image messages immediately after the confirming text (idempotent via marker).
    await sendProductImagesForReply();

    outboundMessage = await createMessage({
      tenant_id: tenantId,
      conversation_id: conversationId,
      external_message_id:
        sendResult?.graphMessageId ?? priorGraphMessageId ?? `ai_${crypto.randomUUID()}`,
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
      product_ids: persistedProductIds,
    });

    // P1-5: the legacy path has no flip transaction to hook, so write the ledger row best-effort
    // (direct, redacted, never throws) after the message persists.
    void writeLedgerBestEffort(
      buildJobLedgerRecord({
        tenantId,
        conversationId,
        correlationId: ledgerCorrelationId,
        traceId,
        replySlot: 'main',
        decisionKind: ledgerDecisionKind,
        messageId: outboundMessage.id,
        telemetry: replyTelemetry,
        decisionEvents,
        guardVerdicts: ledgerGuardVerdicts,
        // P2-4 Part 2 (RC-01/RC-02): mirror the staged path — without this the LEGACY path
        // (the default, AI_REPLY_STAGE_BEFORE_SEND=false) writes facts_used NULL on every
        // delivered reply, so a grounding-gate strip cannot be re-judged from the ledger.
        factsUsed,
      }),
    );
  }
  // ---- End send / persist (staged or legacy) --------------------------------

  // P0-6 (RC-18): charge the 25/h budget only now that a reply has actually been
  // delivered AND persisted. This is the single point every delivered path converges on:
  // the fresh-send branch (sendResult.success) and the crash-after-send self-heal branch
  // (alreadySent — which skips the re-send but still reaches this createMessage) both pass
  // through here, so counting with `sendResult?.success || alreadySent` and keying on the
  // stable inbound id yields exactly one budget unit across retries (the marker no-ops the
  // rest). Flag off → shouldCountDeliveredReply() is false and the legacy pre-gate INCR
  // owns counting instead.
  const wasDelivered = sendResult?.success === true || alreadySent;
  // P1-1: when the outbox owns the effects (or this is a retry of a delivered reply, whose
  // count committed with the first attempt's flip), the inline count is skipped.
  if (
    !outboxOwnedEffects &&
    !isRetryOfDeliveredReply &&
    shouldCountDeliveredReply({
      countDeliveredOnly: RATE_LIMIT_COUNT_DELIVERED_ONLY,
      sendSucceeded: wasDelivered,
    })
  ) {
    await countDeliveredReplyOnce(
      rateLimitKey,
      rateCountedMarkerKey(conversationId, data.messageExternalId),
    );
  }

  // Product image unavailable alert: fires when the customer explicitly asked for a
  // product photo but the catalog entry has no image_urls (`kind: 'missing_image'`) OR the
  // request resolved to no product at all (`kind: 'unresolved_reference'` — the customer got
  // a holding line and someone must follow up with the right photo). Does NOT pause the AI —
  // the business should manually send the photo while the conversation continues.
  // One alert per turn covers all missing-image products in a single notification.
  // P1-1: outbox-owned (or committed with the first attempt) when staged — inline skipped.
  if (imageAlertDetails && !outboxOwnedEffects && !isRetryOfDeliveredReply) {
    try {
      const missingImageAlert = await createAIAlert({
        tenant_id: tenantId,
        conversation_id: conversationId,
        message_id: outboundMessage.id,
        reason: 'product_image_unavailable',
        details: imageAlertDetails,
      });
      const contactForMissingAlert = await findContactById(conversation.contact_id);
      socketService.emitAIAlert(tenantId, {
        ...missingImageAlert,
        message_content: inboundText || null,
        contact_name: contactForMissingAlert?.name?.trim() || 'Customer',
        channel_type: channel.type,
        channel_name: channel.name,
      });
      socketService.emitConversationUpdated(tenantId, conversationId);
    } catch (missingImageAlertErr) {
      logger.error('[ai.reply] Product image unavailable alert creation failed', missingImageAlertErr, {
        conversationId,
        tenantId,
      });
    }
  }

  // Price-hallucination alert: created after the holding message is persisted so the
  // alert can link to the outbound message ID. Pauses AI so a human agent can provide
  // the correct price. Does not create a feedback-log row (the original reply was not
  // sent, so there is no correctable model output; the catalog data needs fixing).
  // P1-1: on the staged path this pause+alert ran ATOMICALLY inside the flip txn — skip inline.
  if (priceHallucinationEscalated && !stageEnabled) {
    const client = await pool.connect();
    let priceAlert: AIAlert | undefined;
    try {
      await client.query('BEGIN');
      priceAlert = await createAIAlert(
        {
          tenant_id: tenantId,
          conversation_id: conversationId,
          message_id: outboundMessage.id,
          reason: 'hallucinated_price',
          details: priceHallucinationDetails,
        },
        client,
      );
      await setConversationAiPaused(conversationId, tenantId, true, client, 'hallucinated_price');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('[ai.reply] Price hallucination alert / pause failed', err, {
        conversationId,
        tenantId,
      });
    } finally {
      client.release();
    }
    if (priceAlert) {
      const contactForAlert = await findContactById(conversation.contact_id);
      socketService.emitAIAlert(tenantId, {
        ...priceAlert,
        message_content: outboundMessage.content,
        contact_name: contactForAlert?.name?.trim() || 'Customer',
        channel_type: channel.type,
        channel_name: channel.name,
      });
      socketService.emitConversationUpdated(tenantId, conversationId);
    }
  }

  // Product-name hallucination alert: created after the holding message is persisted so
  // the alert can reference the outbound message ID. Pauses AI so a human specialist can
  // provide the correct product information. Mirrors the price hallucination alert pattern.
  // P1-1: on the staged path this pause+alert ran ATOMICALLY inside the flip txn — skip inline.
  if (productNameHallucinationEscalated && !stageEnabled) {
    const client = await pool.connect();
    let nameAlert: AIAlert | undefined;
    try {
      await client.query('BEGIN');
      nameAlert = await createAIAlert(
        {
          tenant_id: tenantId,
          conversation_id: conversationId,
          message_id: outboundMessage.id,
          reason: 'hallucinated_product_name',
          details: productNameHallucinationDetails,
        },
        client,
      );
      await setConversationAiPaused(conversationId, tenantId, true, client, 'hallucinated_product_name');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('[ai.reply] Product name hallucination alert / pause failed', err, {
        conversationId,
        tenantId,
      });
    } finally {
      client.release();
    }
    if (nameAlert) {
      const contactForAlert = await findContactById(conversation.contact_id);
      socketService.emitAIAlert(tenantId, {
        ...nameAlert,
        message_content: outboundMessage.content,
        contact_name: contactForAlert?.name?.trim() || 'Customer',
        channel_type: channel.type,
        channel_name: channel.name,
      });
      socketService.emitConversationUpdated(tenantId, conversationId);
    }
  }

  // Uncertain-answer fallback alert: created after the holding message is persisted so
  // the alert can reference the outbound message ID. Pauses AI and flags the conversation
  // for human review so the business can reply directly with a reliable answer. Mirrors
  // the price/name hallucination alert pattern.
  // P1-1: on the staged path this pause+alert ran ATOMICALLY inside the flip txn — skip inline.
  if (uncertainAnswerEscalated && !stageEnabled) {
    const client = await pool.connect();
    let uncertainAlert: AIAlert | undefined;
    try {
      await client.query('BEGIN');
      uncertainAlert = await createAIAlert(
        {
          tenant_id: tenantId,
          conversation_id: conversationId,
          message_id: outboundMessage.id,
          reason: UNCERTAIN_ANSWER_ALERT_REASON,
          details: uncertainAnswerDetails,
        },
        client,
      );
      await setConversationAiPaused(conversationId, tenantId, true, client, 'uncertain_answer_escalated');
      await setConversationHumanReplied(conversationId, tenantId, false, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('[ai.reply] Uncertain answer alert / pause failed', err, {
        conversationId,
        tenantId,
      });
    } finally {
      client.release();
    }
    if (uncertainAlert) {
      const contactForAlert = await findContactById(conversation.contact_id);
      socketService.emitAIAlert(tenantId, {
        ...uncertainAlert,
        message_content: outboundMessage.content,
        contact_name: contactForAlert?.name?.trim() || 'Customer',
        channel_type: channel.type,
        channel_name: channel.name,
      });
      socketService.emitConversationUpdated(tenantId, conversationId);
    }
  }

  // P2-1: consolidated grounding-gate escalation alert + pause (legacy inline path). On the staged
  // path this ran ATOMICALLY inside the flip txn — skip inline. Mirrors the uncertain-answer block.
  if (groundingGateEscalated && !stageEnabled) {
    const client = await pool.connect();
    let groundingAlert: AIAlert | undefined;
    try {
      await client.query('BEGIN');
      groundingAlert = await createAIAlert(
        {
          tenant_id: tenantId,
          conversation_id: conversationId,
          message_id: outboundMessage.id,
          reason: groundingGateReason,
          details: groundingGateDetails,
          fail_closed: groundingGateFailClosed,
        },
        client,
      );
      await setConversationAiPaused(conversationId, tenantId, true, client, groundingGateReason);
      // Deliberately NO human_replied write — see the staged-flip twin above: wiping the sticky
      // billing flag on a gate escalation re-qualifies human-touched conversations for use-case
      // billing. Pinned by replyPathSourceInvariants.test.ts.
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('[ai.reply] Grounding-gate alert / pause failed', err, {
        conversationId,
        tenantId,
      });
    } finally {
      client.release();
    }
    if (groundingAlert) {
      const contactForAlert = await findContactById(conversation.contact_id);
      socketService.emitAIAlert(tenantId, {
        ...groundingAlert,
        message_content: outboundMessage.content,
        contact_name: contactForAlert?.name?.trim() || 'Customer',
        channel_type: channel.type,
        channel_name: channel.name,
      });
      socketService.emitConversationUpdated(tenantId, conversationId);
    }
  }

  // P1-1: on the staged path this pause+alert (and the feedback log) ran via the flip txn.
  if (qualityFailing && flagReason && !stageEnabled) {
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
      await setConversationAiPaused(conversationId, tenantId, true, client, flagReason);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('[ai.reply] Quality alert / pause failed', err, { conversationId, tenantId });
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

  if (!isRetryOfDeliveredReply) {
    await touchConversationLastMessageAt(conversationId);
  }

  // P1-1: outbox-owned (or committed with the first attempt's flip) when staged — inline skipped.
  if (!outboxOwnedEffects && !isRetryOfDeliveredReply) {
    void logEvent(tenantId, 'ai_reply_sent', {
      conversation_id: conversationId,
      channel_id: channelId,
      message_id: outboundMessage.id,
    });
  }

  if (!isRetryOfDeliveredReply) {
    socketService.emitNewMessage(tenantId, outboundMessage);
    socketService.emitConversationUpdated(tenantId, conversationId);
  }

  // Enqueue a delayed use case evaluation. The 4-hour delay acts as an inactivity window:
  // if the customer replies again within 4 hours the job fires and re-evaluates at that point.
  // jobId deduplication ensures that an explicit conversation-close enqueue (delay=0) with the
  // same jobId cancels this delayed version, preventing a redundant double-evaluation.
  // P1-1: outbox-owned when staged (exactly-once via the relay) — inline skipped. No
  // removeOnFail override: the queue-level trim (removeOnFail: 500) applies (EV-042).
  if (!outboxOwnedEffects && !isRetryOfDeliveredReply) {
    void (aiQueue as unknown as { add: (name: string, data: unknown, opts?: unknown) => Promise<unknown> }).add(
      'evaluateConversationUseCase',
      { conversationId, tenantId },
      {
        delay: 4 * 60 * 60 * 1000,
        jobId: `eval-usecase-${conversationId}`,
        removeOnComplete: true,
      },
    );
  }

  if (!sendResult?.success && !isRetryOfDeliveredReply) {
    const errReason = sendResult?.error ?? 'Contact not found for conversation';
    if (sendResult) {
      logger.error('[ai.reply] Channel send failed', errReason, { conversationId });
    }
    await updateMessageSendFailure(outboundMessage.id, tenantId, 'failed', errReason);
    socketService.emitMessageSendFailed(tenantId, {
      messageId: outboundMessage.id,
      conversationId,
      error: errReason,
    });
    // P1-1: outbox-owned when staged (written in the flip txn, relay raises it) — inline skipped.
    let alert: AIAlert | undefined;
    if (!outboxOwnedEffects) {
      try {
        alert = await createAIAlert({
          tenant_id: tenantId,
          conversation_id: conversationId,
          message_id: outboundMessage.id,
          reason: 'message_send_failed',
        });
      } catch (alertErr) {
        logger.error('[ai.reply] message_send_failed alert insert failed', alertErr, {
          conversationId,
          tenantId,
        });
      }
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

  // P1-1 (RC-20/RC-22): the order-detection tail is crash-resumable. Its completion is recorded
  // in a Redis marker; a retry of an already-delivered reply re-runs ONLY this tail when the
  // marker is absent (a crash interrupted the first attempt mid-tail). Safe to re-run: the
  // existing-order dedupe below skips a draft order the first attempt already created, and the
  // rate-count / clarify sends inside are marker-idempotent.
  const orderDetectionDoneKey = `ai_tail_done:${conversationId}:${data.messageExternalId}`;
  if (isRetryOfDeliveredReply) {
    const tailDone = await redisConnection.get(orderDetectionDoneKey).catch(() => null);
    if (tailDone) {
      return;
    }
    console.info('[ai.reply] Resuming interrupted order-detection tail on retry', {
      conversationId,
      scheduledFor: data.messageExternalId,
    });
  }
  let orderDetectionTailErrored = false;
  const runOrderDetectionTail = async (): Promise<void> => {
  try {
    if (!contact) {
      return;
    }

    const messagesForIntent = await findMessagesByConversation(conversationId, HISTORY_FETCH_LIMIT, tenantId);
    const catalogProductNames = await findActiveProductNamesForTenant(tenantId);
    // P1-3 (RC-08): verdicts persisted per (conversation, logical inbound) — a retry/tail-resume
    // consumes the first attempt's scores instead of re-rolling the classifiers.
    const intent = await getOrComputeClassifierVerdict({
      conversationId,
      inboundExternalId: data.messageExternalId,
      detector: 'purchase_intent',
      compute: () => detect(messagesForIntent, tenantId, catalogProductNames),
    });
    const qtyDisplay = intent.quantity === null ? 'null' : String(intent.quantity);
    console.info(
      `[INTENT DETECTION] tenantId: ${tenantId} conversationId: ${conversationId} score: ${intent.intent_score} is_ready: ${intent.is_ready_to_order} product_name: ${logJsonStringOrNull(intent.product_name)} quantity: ${qtyDisplay} delivery_address: ${logJsonStringOrNull(intent.delivery_address)} reasoning: ${JSON.stringify(intent.reasoning)}`,
    );

    // P2-7 (I6/RC-06): read through the manifest so an out-of-band value is REPORTED at boot rather
    // than silently reverting. This gate previously accepted only `>0 && <1` and fell back to 0.85
    // with no log at all — so `INTENT_THRESHOLD=1`, a plausible way to express "never auto-create
    // orders", quietly became 0.85 and created orders aggressively: the exact opposite of the
    // operator's intent, invisibly. The manifest's [0,1] band + the boot warning make it loud.
    const intentOrderMinScore = knobNumber('INTENT_THRESHOLD');
    // P2-2: in `on`, the two order-cluster LLM classifiers are replaced by deterministic lexicons —
    // there is no confidence field on the consent path, so RC-07's boost asymmetry cannot arise.
    const orderStageOn = ORDER_STAGE_MACHINE_MODE === 'on';
    const explicitNewOrder = orderStageOn
      ? detectNewOrderSignalLexical(inboundText)
      : await classifyNewOrderSignal(inboundText);
    const orderAffirmationIntent = orderStageOn
      ? {
          is_order_affirmation: detectOrderConsentLexical(inboundText),
          confidence: 1,
          reason: null as string | null,
        }
      : await getOrComputeClassifierVerdict({
          conversationId,
          inboundExternalId: data.messageExternalId,
          detector: 'order_affirmation',
          compute: () => detectOrderAffirmationIntent(inboundText, messagesForIntent),
        });
    if (!orderStageOn) {
      logConfidenceGateBoundary(
        'order_affirmation',
        orderAffirmationIntent.confidence,
        0.7,
        { tenantId, conversationId, inboundExternalId: data.messageExternalId },
        orderAffirmationIntent.is_order_affirmation === true,
      );
    }
    const latestMessageAffirmsOrder = orderStageOn
      ? orderAffirmationIntent.is_order_affirmation === true
      : orderAffirmationIntent.is_order_affirmation === true &&
        passesConfidenceGate(orderAffirmationIntent.confidence, 0.7, CONFIDENCE_CONTRACT_SYMMETRY);

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
    // P1-3 (RC-07): E.164-shape signal for the order-stage deterministic slot check. Surfaced
    // for observability only — it never blocks order creation (tightening hasCustomerPhone to
    // E.164 would regress revenue on loosely-formatted but valid numbers). It lets us measure
    // how often a missing/low-confidence affirmation is nonetheless corroborated by a
    // structurally-valid phone alongside the non-empty address + consent-lexicon slots — the
    // deterministic path that keeps the order-affirmation symmetry from forfeiting revenue.
    const customerPhoneLooksE164 = isLikelyE164Phone(customerPhone);

    const resolvedCustomerName = resolveCustomerNameForOrder({
      customerFirstNameFromIntent: intent.customer_first_name,
      contactName: contact.name,
      contactMetadata: meta,
      conversationMessages: messagesForIntent,
    });
    const hasCustomerName = resolvedCustomerName.firstName !== null;

    // P2-3 (RC-13): persist the resolved order slots (name/phone/address) so the slot-backed summary
    // can always re-inject them, even after they slide out of the 40-row history window. COALESCE-keep
    // (never nulls a previously-known value); best-effort — a write blip must not break the reply.
    if (SUMMARY_SLOT_BACKED) {
      await persistOrderSlots(conversationId, tenantId, {
        name: resolvedCustomerName.firstName,
        phone: customerPhone,
        address:
          typeof intent.delivery_address === 'string' && intent.delivery_address.trim()
            ? intent.delivery_address.trim()
            : null,
      }).catch((e) =>
        logger.warn('[P2-3] persistOrderSlots failed', { conversationId, err: String(e) }),
      );
    }

    // Only treat a customer message as an order affirmation when it came AFTER the
    // data-confirmation request was sent. Scanning all recent messages broadly risks
    // treating a "po" (yes) or "ok" from an unrelated earlier exchange (e.g. confirming
    // their use-case, answering a product question) as order consent.
    const dataConfirmationIdx = messagesForIntent.reduce(
      (lastIdx, msg, idx) =>
        msg.sent_by !== 'customer' && messageIsDataConfirmationRequest(msg.content ?? '')
          ? idx
          : lastIdx,
      -1,
    );
    const messagesAfterDataConfirmation =
      dataConfirmationIdx >= 0 ? messagesForIntent.slice(dataConfirmationIdx + 1) : [];
    const recentCustomerAffirmation = messagesAfterDataConfirmation.some(
      (msg) =>
        msg.sent_by === 'customer' &&
        typeof msg.content === 'string' &&
        looksLikeOrderAffirmation(msg.content),
    );

    const assistantAskedOrderClosingEarlier = orderStageOn
      ? conversation.order_closing_asked === true ||
        messagesForIntent.some(
          (m) => m.sent_by !== 'customer' && messageContainsOrderClosingAsk(m.content ?? ''),
        )
      : await hasAssistantAskedOrderClosingInConversation(messagesForIntent);
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
      ` hasName: ${hasCustomerName} hasPhone: ${hasCustomerPhone} phoneE164Shape: ${customerPhoneLooksE164} hasAddress: ${hasDeliveryAddress}` +
      ` dataConfirmationSent: ${dataConfirmationSentBeforeCurrentTurn}` +
      ` shouldAffirmOrder: ${shouldAffirmOrder} explicitNewOrder: ${explicitNewOrder}` +
      ` is_ready_to_order: ${intent.is_ready_to_order} intent_score: ${intent.intent_score}` +
      ` resolvedFirstName: ${logJsonStringOrNull(resolvedCustomerName.firstName)}` +
      ` intentFirstName: ${logJsonStringOrNull(intent.customer_first_name)}`,
    );

    // The non-score draft-order conjuncts. When any of these is false the intent score is not
    // the binding constraint — no order was possible at any score — so an in-band score is the
    // normal mid-collection state, not an ambiguity worth an operator alert.
    const orderSlotsBindOnScore =
      intent.is_ready_to_order === true &&
      intent.product_name != null &&
      hasDeliveryAddress &&
      hasCustomerPhone &&
      hasCustomerName &&
      shouldAffirmOrder;
    logConfidenceGateBoundary(
      'order_intent_score',
      intent.intent_score,
      intentOrderMinScore,
      { tenantId, conversationId, inboundExternalId: data.messageExternalId },
      orderSlotsBindOnScore,
    );
    const legacyPassesDraftOrderValidation =
      orderSlotsBindOnScore &&
      passesConfidenceGate(intent.intent_score, intentOrderMinScore, CONFIDENCE_CONTRACT_SYMMETRY);

    // P2-2 (RC-07/08/22): the deterministic order_stage FSM. In `shadow` it is computed and any
    // divergence from the legacy gate is logged + recorded in the P1-5 ledger (legacy still
    // decides); in `on` it is authoritative and the three order-cluster LLM classifiers above were
    // skipped. The consent path has NO confidence field, so RC-07's asymmetry and RC-22's 7-conjunct
    // boundary flip vanish by construction.
    let fsmShouldCreateOrder = false;
    if (ORDER_STAGE_MACHINE_MODE !== 'off') {
      const effectiveStage = deriveEffectiveOrderStage(
        conversation.order_stage,
        dataConfirmationSentBeforeCurrentTurn,
        intent,
      );
      fsmShouldCreateOrder = decideOrderStage(effectiveStage, {
        kind: 'inbound',
        slots: {
          hasProduct: intent.product_name != null,
          hasAddress: hasDeliveryAddress,
          hasPhone: hasCustomerPhone,
          hasName: hasCustomerName,
          isReadyToOrder: intent.is_ready_to_order === true,
          intentScorePasses: passesConfidenceGate(
            intent.intent_score,
            intentOrderMinScore,
            CONFIDENCE_CONTRACT_SYMMETRY,
          ),
        },
        signals: {
          consentDetected: recentCustomerAffirmation || detectOrderConsentLexical(inboundText),
          newOrderDetected: detectNewOrderSignalLexical(inboundText),
          providesOrderDetails: latestMessageProvidesOrderDetails,
        },
        orderClosingAsked: assistantAskedOrderClosingEarlier === true,
      }).shouldCreateOrder;

      // One-time deterministic seed of a legacy NULL row (no-op once order_stage is set).
      if (conversation.order_stage == null) {
        await seedOrderStageState(conversationId, tenantId, {
          stage: effectiveStage,
          dataConfirmationSent: dataConfirmationSentBeforeCurrentTurn,
          orderClosingAsked: assistantAskedOrderClosingEarlier === true,
        }).catch((e) => logger.warn('[ORDER_STAGE] seed failed', { conversationId, err: String(e) }));
      }

      if (ORDER_STAGE_MACHINE_MODE === 'shadow') {
        // P3-4: the branch string is now built by the shared encoder rather than inline here, so
        // P3-1's retired classifiers get one idiom instead of ~20 hand-rolled ones. The emitted
        // string is byte-identical to what this block wrote before — pinned by shadowComparison.test.ts,
        // because changing it would orphan every historical ledger row.
        const shadow = buildShadowBranch({
          classifier: 'order_stage',
          legacy: legacyPassesDraftOrderValidation,
          deterministic: fsmShouldCreateOrder,
          context: { stage: effectiveStage },
        });
        if (!shadow.agree) {
          console.warn('[ORDER_STAGE_DIVERGENCE] deterministic FSM disagrees with legacy gate', {
            conversationId,
            tenantId,
            stage: effectiveStage,
            legacy: legacyPassesDraftOrderValidation,
            fsm: fsmShouldCreateOrder,
          });
        }
        // P2-2 (dev validation Finding 3): this verdict must reach the ledger as its OWN row.
        // The turn's 'main' row was built and serialized inside stageAndSend's onFlip — the
        // order-detection tail runs after that seal, so a push into decisionEvents here is
        // provably dropped and eval:shadow (the cutover gate) reads zero observations forever.
        // A distinct replySlot is mandatory (the idempotency key is slot-keyed, ON CONFLICT DO
        // NOTHING — 'main' would collide silently), and `usage` MUST be nulled: buildLedgerRecord
        // pulls the turn's entire tracked call list, and the P3-6 cost readers sum per-row with
        // no slot filter, so inheriting it would double every order-detection turn's COGS. A
        // crash-retry of the tail re-derives the same key, so the second insert is idempotent.
        void writeLedgerBestEffort({
          ...buildJobLedgerRecord({
            tenantId,
            conversationId,
            correlationId: ledgerCorrelationId,
            traceId,
            replySlot: 'shadow:order_stage',
            decisionKind: 'order_shadow',
            decisionEvents: [
              {
                classifier: 'order_stage',
                raw_score: null,
                threshold: null,
                boost_applied: false,
                passed: shadow.passed,
                branch: shadow.branch,
              },
            ],
          }),
          usage: null,
        });
      }
    }

    const passesDraftOrderValidation =
      ORDER_STAGE_MACHINE_MODE === 'on' ? fsmShouldCreateOrder : legacyPassesDraftOrderValidation;

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
        let clarifySendResult: Awaited<ReturnType<typeof sendMessage>> | null = null;
        let clarifyMessage: Message;
        const cannedClarify = await stageCannedReply({
          replySlot: 'clarify',
          text: clarificationText,
          contact,
        });
        if (cannedClarify) {
          clarifySendResult = cannedClarify.sendResult;
          if (!cannedClarify.outboundMessage) return; // retry of a sent row with no resolvable message
          clarifyMessage = cannedClarify.outboundMessage;
        } else {
          clarifySendResult = await sendMessage(
            channel,
            contact.external_id,
            clarificationText,
          );
          clarifyMessage = await createMessage({
            tenant_id: tenantId,
            conversation_id: conversationId,
            external_message_id: clarifySendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
            direction: 'outbound',
            type: 'text',
            content: clarificationText,
            sent_by: 'ai',
          });
        }
        await touchConversationLastMessageAt(conversationId);
        socketService.emitNewMessage(tenantId, clarifyMessage);
        socketService.emitConversationUpdated(tenantId, conversationId);
        // P0-6 (RC-18): normally a no-op — the main reply already set this inbound's
        // count-once marker — but when the main send failed and only this clarification
        // was delivered, it charges the one budget unit the inbound is due.
        if (
          shouldCountDeliveredReply({
            countDeliveredOnly: RATE_LIMIT_COUNT_DELIVERED_ONLY,
            sendSucceeded: clarifySendResult?.success === true,
          })
        ) {
          await countDeliveredReplyOnce(
            rateLimitKey,
            rateCountedMarkerKey(conversationId, data.messageExternalId),
          );
        }
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

      // An order already exists in this conversation. Even when the resolved product
      // differs from the existing one, only allow a new order when the CURRENT message
      // itself signals new-order intent. Historical affirmations (recentCustomerAffirmation)
      // from the now-completed order flow must not re-trigger order creation on unrelated
      // follow-up messages (e.g. "Do you have any other creatine products?").
      if (!explicitNewOrder && !latestMessageAffirmsOrder) {
        console.info('[ai.reply] Skipping follow-up order: existing order found and current message carries no new-order signal', {
          conversationId,
          existingOrderId: latestActiveOrder.id,
          existingProduct: latestActiveOrder.product_name,
          incomingProduct: productName,
          intent_score: intent.intent_score,
        });
        return;
      }
    }

    const humanInOrderWindow = await hasHumanParticipationInCurrentOrderWindow(
      conversationId,
      tenantId,
      COMMISSION_STORED_TIMESTAMP ? (lastInbound?.created_at ?? null) : null,
      COMMISSION_STORED_TIMESTAMP,
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

    // P2-2 (shadow/on): advance the FSM to `confirmed` and stamp the RC-22 commission anchor (the
    // consent-inbound timestamp + its external id). COALESCE-keep writers make this idempotent under
    // the crash-resumable tail; the existing-order dedupe above prevents a duplicate order.
    if (ORDER_STAGE_MACHINE_MODE !== 'off') {
      await advanceOrderStage(conversationId, tenantId, 'confirmed', {
        consentAt: lastInbound?.created_at ?? null,
        consentInboundId: data.messageExternalId,
      }).catch((e) => logger.warn('[ORDER_STAGE] confirm write failed', { conversationId, err: String(e) }));
    }
  } catch (err) {
    orderDetectionTailErrored = true;
    logger.error('[ai.reply] Intent detection or draft order failed', err, {
      conversationId,
      tenantId,
    });
    if (SENSITIVE_PATH_FAIL_CLOSED) {
      // P0-4 (RC-22): this block runs AFTER the reply has been sent, so re-throwing would
      // re-run the whole job and double-send the delivered reply (RC-20). Instead of the
      // silent green job that forfeits a potential AI-order commission with no trace,
      // surface the failure as a durable alert so the merchant can review whether an order
      // was missed. (Retry becomes safe fleet-wide once P1-1 makes the pipeline idempotent.)
      try {
        const alert = await createAIAlert({
          tenant_id: tenantId,
          conversation_id: conversationId,
          message_id: lastInbound?.id ?? null,
          reason: 'order_detection_failed',
          // P1-5: fail-closed — the post-send intent/draft-order step threw and was surfaced as an
          // alert rather than swallowed; not a genuine detection.
          fail_closed: true,
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
      } catch (alertErr) {
        logger.error('[ai.reply] Failed to raise order_detection_failed alert', alertErr, {
          conversationId,
          tenantId,
        });
      }
    }
  }
  };
  await runOrderDetectionTail();
  if (!orderDetectionTailErrored) {
    // Completed (including its deterministic "no order" early returns) — a later retry of this
    // reply skips the tail. Not set on the swallowed-error path so a crash-retry re-runs it.
    await redisConnection.set(orderDetectionDoneKey, '1', 'EX', 6 * 3600).catch(() => undefined);
  }

  } catch (err) {
    // P2-6 (F1): the pre-send gate floors only turns whose generation RETURNED after a recorded
    // provider failure — a hard throw (the main completion itself, or any reply-path call after
    // the fail-open catches) used to propagate past it, so a sustained outage exhausted BullMQ's
    // 3 attempts into DLQ + ai_reply_undelivered and the customer got SILENCE, never the
    // templated holding reply. Route exactly the LAST attempt of a provider-caused, pre-send
    // failure to the same floor:
    //  - earlier attempts still rethrow — a transient blip retries into a REAL reply, which is
    //    strictly better than holding copy;
    //  - non-provider errors (DB faults, code bugs) always rethrow — masking them behind a
    //    holding message would hide real defects from the DLQ;
    //  - SensitivePathEscalatedError is already a safe terminal outcome (alert + pause
    //    committed) — flooring it would stack a second alert on a paused conversation;
    //  - post-send throws (preSendPhase=false) rethrow — a reply may already be on the wire.
    const providerCaused =
      err instanceof ProviderUnavailableError ||
      err instanceof GenerationContractError ||
      turnProviderFailures().length > 0;
    if (
      gracefulDegradeMode() &&
      isFinalAttempt &&
      preSendPhase &&
      providerCaused &&
      !(err instanceof SensitivePathEscalatedError) &&
      degradeFloorFn != null
    ) {
      logger.error(
        '[ai.reply] final attempt failed on a provider fault pre-send — degrading to the floor instead of dead-lettering',
        err,
        { tenantId, conversationId, attempt: attempt ?? null },
      );
      try {
        await degradeFloorFn();
        return;
      } catch (floorErr) {
        // The floor itself failed (e.g. the alert txn) — surface the ORIGINAL provider fault to
        // the failure classifier; the floor error is secondary.
        logger.error('[ai.reply] degradation floor failed on the final attempt', floorErr, {
          tenantId,
          conversationId,
        });
      }
    }
    throw err;
  } finally {
    // Always release the per-conversation lock and the per-tenant concurrency
    // slot, even if the job threw or returned early at any point in the try
    // block above. The lock is released first so a waiting job for the same
    // conversation can proceed as soon as possible.
    await releaseConversationLock();
    await releaseTenantSlot();
  }
}
