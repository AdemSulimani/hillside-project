import { openai, OPENAI_CHAT_MODEL, OPENAI_VISION_MODEL } from './openaiClient';
import { findTenantById } from '../db/models/tenant';
import { findMessagesByConversation, type Message } from '../db/models/message';
import {
  searchProducts,
  searchProductsByDisjunctiveTerms,
  searchProductsBySimilarity,
  type Product,
} from '../db/models/product';
import { findAIConfigByTenant, type AIConfig } from '../db/models/aiConfig';
import {
  countTenantPromptBlocks,
  listTenantPromptBlocksRuntime,
  seedTenantPromptBlocksFromCatalog,
} from '../db/models/promptBlock';
import { assembleGuidelinesFromBlocks } from './promptAssemblyService';
import { permanentUrlToFilePath, fileToBase64DataUrl } from './attachmentStorageService';
import { generateEmbedding } from './embeddingService';
import { redisConnection } from '../jobs/redisConnection';

const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD || '0.75');

/** How many catalog rows we consider for matching + OOS canned detection (needs the named SKU in-list). */
const FOCUSED_PRODUCT_MATCH_LIMIT = 10;

/**
 * Reply language. The AI mirrors the customer's language: Albanian (`sq`) or English (`en`).
 * Default for ambiguous/empty input is `sq` to preserve legacy behaviour.
 */
export type ReplyLocale = 'sq' | 'en';

export const DEFAULT_REPLY_LOCALE: ReplyLocale = 'sq';

const CONTEXT_MAX_HISTORY_TOKENS = (() => {
  const raw = process.env.CONTEXT_MAX_HISTORY_TOKENS;
  if (raw === undefined || raw.trim() === '') return 6000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 6000;
})();
const RECENT_RAW_HISTORY_MESSAGES = 10;
const HISTORY_FETCH_LIMIT = 40;

/** Rough GPT token estimate: ~4 characters per token. */
function estimateTokens(text: string): number {
  return text.length / 4;
}

/** Parses `confidence` from structured JSON models (number or numeric string; 0–1 or 0–100). */
function parseModelClassifierConfidence(raw: unknown): number {
  let confidence = 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    confidence = raw > 1 ? raw / 100 : raw;
  } else if (typeof raw === 'string') {
    const n = parseFloat(raw.trim());
    if (Number.isFinite(n)) confidence = n > 1 ? n / 100 : n;
  }
  return Math.min(1, Math.max(0, confidence));
}

/** Matches normalized inbound text from webhookNormalizer (Feature 22). */
const SHARED_CONTENT_SYSTEM_APPEND =
  '\n\nKlienti ka ndare permbajtje me ju. Përdor kontekstin qe jepet per te dhene pergjigjen e pershtatshme dhe lidhe me produktet nga katalogu kur eshte relevante.';

const SHARED_POST_VISION_APPEND =
  ' Per postimet e Instagram-it (shares), mbeshtetu kryesisht te pamjet/parapamjet e bashkengjitura.';

function inboundTextIsPostShare(content: string): boolean {
  return content.trimStart().startsWith('Customer shared a post');
}

function inboundTextIsStoryThread(content: string): boolean {
  const t = content;
  return (
    t.includes('Customer mentioned you in their story') ||
    t.includes('Customer replied to your story') ||
    t.includes('Customer shared a story')
  );
}

function inboundTextIsGenericShare(content: string): boolean {
  return content.trimStart().startsWith('Customer shared content');
}

/** Post shares and story threads get the extra catalog-alignment instruction (not reel/product-only lines). */
function inboundNeedsSharedContentInstruction(content: string): boolean {
  return (
    inboundTextIsPostShare(content) ||
    inboundTextIsStoryThread(content) ||
    inboundTextIsGenericShare(content)
  );
}

const DEFAULT_AI_CONFIG: Pick<
  AIConfig,
  | 'tone'
  | 'personality_description'
  | 'restrictions'
  | 'platform_restrictions'
  | 'sales_strategy'
  | 'objection_handling'
  | 'qa_pairs'
  | 'is_active'
  | 'custom_model_id'
> = {
  tone: 'friendly and professional',
  personality_description: null,
  restrictions: [],
  platform_restrictions: [],
  sales_strategy: 'Be helpful, answer questions accurately, and gently guide towards a purchase when appropriate.',
  objection_handling: null,
  qa_pairs: [],
  is_active: true,
  custom_model_id: null,
};

async function loadAIConfig(tenantId: string) {
  const cacheKey = `ai_config:${tenantId}`;
  const cached = await redisConnection.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as AIConfig | typeof DEFAULT_AI_CONFIG;
      return {
        ...parsed,
        platform_restrictions: Array.isArray(parsed.platform_restrictions)
          ? parsed.platform_restrictions
          : [],
      };
    } catch {
      await redisConnection.del(cacheKey);
    }
  }

  const config = await findAIConfigByTenant(tenantId);
  const resolved = config ?? DEFAULT_AI_CONFIG;
  const normalized = {
    ...resolved,
    platform_restrictions: Array.isArray(resolved.platform_restrictions)
      ? resolved.platform_restrictions
      : [],
  };
  await redisConnection.set(cacheKey, JSON.stringify(normalized), 'EX', 900);
  return normalized;
}

async function ensureTenantPromptBlocksSeeded(tenantId: string): Promise<void> {
  const n = await countTenantPromptBlocks(tenantId);
  if (n === 0) {
    await seedTenantPromptBlocksFromCatalog(tenantId);
    await redisConnection.del(`tenant_prompt_blocks:${tenantId}`);
  }
}

async function loadTenantPromptBlocksCached(tenantId: string) {
  const cacheKey = `tenant_prompt_blocks:${tenantId}`;
  const cached = await redisConnection.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as Awaited<ReturnType<typeof listTenantPromptBlocksRuntime>>;
    } catch {
      await redisConnection.del(cacheKey);
    }
  }

  const rows = await listTenantPromptBlocksRuntime(tenantId);
  await redisConnection.set(cacheKey, JSON.stringify(rows), 'EX', 900);
  return rows;
}

async function loadTenant(tenantId: string) {
  const cacheKey = `tenant:${tenantId}`;
  const cached = await redisConnection.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as Awaited<ReturnType<typeof findTenantById>>;
    } catch {
      await redisConnection.del(cacheKey);
    }
  }

  const tenant = await findTenantById(tenantId);
  if (tenant) {
    await redisConnection.set(cacheKey, JSON.stringify(tenant), 'EX', 1800);
  }
  return tenant;
}

async function loadProductCatalog(tenantId: string): Promise<Product[]> {
  const cacheKey = `products:${tenantId}`;
  const cached = await redisConnection.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as Product[];
    } catch {
      await redisConnection.del(cacheKey);
    }
  }

  const products = await searchProducts(tenantId, '', 5);
  await redisConnection.set(cacheKey, JSON.stringify(products), 'EX', 120);
  return products;
}

export function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'can', 'may', 'might', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
    'through', 'after', 'before', 'above', 'below', 'and', 'but', 'or',
    'not', 'no', 'so', 'if', 'then', 'than', 'too', 'very', 'just',
    'that', 'this', 'what', 'which', 'who', 'when', 'where', 'how',
    'all', 'each', 'any', 'both', 'few', 'more', 'most', 'some',
    'hi', 'hello', 'hey', 'thanks', 'thank', 'please', 'ok', 'okay',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

const USAGE_QUESTION_KEYWORDS = [
  'how to use',
  'how do i use',
  'how should i use',
  'how to take',
  'how do i take',
  'dosage',
  'dose',
  'application',
  'apply',
  'instructions',
  'warning',
  'warnings',
  'side effects',
  'usage',
  'use it',
  'take it',
  'si ta përdor',
  'si e përdor',
  'si duhet ta përdor',
  'si ta marr',
  'si e marr',
  'dozimi',
  'dozë',
  'aplikim',
  'apliko',
  'udhëzime',
  'paralajmërim',
  'paralajmërime',
  'efekte anësore',
  'përdorim',
  'përdore',
  'merre',
  'perdor',
  'qysh me perdor',
];

const NEW_ORDER_SIGNAL_KEYWORDS = [
  'new order',
  'another order',
  'one more',
  'again',
  'also order',
  'order again',
  'porosi tjeter',
  'porosi tjetër',
  'edhe nje',
  'edhe një',
  'nje tjeter',
  'një tjetër',
  'dua edhe',
  'shto edhe',
];

const NEGATIVE_AVAILABILITY_KEYWORDS = [
  'nuk e kemi',
  'nuk kemi',
  'nuk gjendet',
  'not available',
  "don't have",
  'do not have',
  'not in stock',
  'not in our catalog',
  'nuk ndodhet',
  'nuk është në',
];

const ORDER_CONFIRMATION_INBOUND_FALLBACK_KEYWORDS = [
  'porosi',
  'porosine',
  'porosia',
  'dua',
  'me bej',
  'beje porosine',
  'do ta marr',
  'adresa',
  'adrese',
  'derges',
  'delivery',
  'address',
  'order',
  'confirm',
];

const ORDER_CONFIRMATION_REPLY_FALLBACK_KEYWORDS = [
  'porosia u konfirmua',
  'porosia u krijua',
  'porosia juaj',
  'porosine tuaj',
  'faleminderit porosia',
  'order confirmed',
  'order created',
  'your order is confirmed',
  'review in orders',
];

const ORDER_DETAILS_COLLECTION_REPLY_FALLBACK_KEYWORDS = [
  'adresen e plote',
  'adresën e plotë',
  'adresen e dërgesës',
  'adresën e dërgesës',
  'numrin e telefonit',
  'numerin e telefonit',
  'na jep',
  'na dergo',
  'na dërgo',
  'na shkruaj',
  'ploteso',
  'plotëso',
  'te vazhdojme porosine',
  'të vazhdojmë porosinë',
  'per te vazhduar porosine',
  'për të vazhduar porosinë',
  'shipping address',
  'delivery address',
  'full address',
  'phone number',
  'to proceed with your order',
  'complete your order',
];

const ORDER_CLOSING_QUESTION_FALLBACK_KEYWORDS = [
  'a doni ta porosisni',
  'deshironi ta porosisni',
  'dëshironi ta porosisni',
  'doni ta porosisni',
  'doni me porosit',
  'doni me bo porosi',
  'a e porosisni',
  'do you want to order',
  'would you like to order',
  'want to order it',
];

function includesAnyKeyword(message: string, keywords: string[]): boolean {
  const t = message.trim().toLowerCase();
  if (!t) return false;
  return keywords.some((needle) => t.includes(needle));
}

function normalizeForIntentMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export async function classifyUsageQuestionIntent(message: string): Promise<boolean> {
  const inbound = message.trim();
  if (!inbound) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict intent classifier. Determine whether the customer message asks about product usage, dosage, instructions, application, side effects, or warnings in any language/slang/typo. Return only JSON: {"is_usage_question": true} or {"is_usage_question": false}.',
        },
        {
          role: 'user',
          content: `Customer message:\n${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_usage_question?: boolean };
      if (parsed.is_usage_question === true) return true;
      if (parsed.is_usage_question === false) return false;
    }
  } catch {
    // Fall through to keyword fallback when classifier is unavailable.
  }

  return includesAnyKeyword(inbound, USAGE_QUESTION_KEYWORDS);
}

export async function classifyNewOrderSignal(message: string): Promise<boolean> {
  const inbound = message.trim();
  if (!inbound) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict intent classifier. Determine whether the message indicates the customer wants to place an additional/new order (e.g., another one, order again) rather than just discussing an existing order. Return only JSON: {"is_new_order_signal": true} or {"is_new_order_signal": false}.',
        },
        {
          role: 'user',
          content: `Customer message:\n${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_new_order_signal?: boolean };
      if (parsed.is_new_order_signal === true) return true;
      if (parsed.is_new_order_signal === false) return false;
    }
  } catch {
    // Fall through to keyword fallback when classifier is unavailable.
  }

  return includesAnyKeyword(inbound, NEW_ORDER_SIGNAL_KEYWORDS);
}

export async function classifyNegativeAvailabilityReply(message: string): Promise<boolean> {
  const inbound = message.trim();
  if (!inbound) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict classifier. Detect if the assistant reply says the requested product is unavailable/out of stock/not carried (in any language). Return only JSON: {"is_negative_availability": true} or {"is_negative_availability": false}.',
        },
        {
          role: 'user',
          content: `Assistant reply:\n${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_negative_availability?: boolean };
      if (parsed.is_negative_availability === true) return true;
      if (parsed.is_negative_availability === false) return false;
    }
  } catch {
    // Fall through to keyword fallback when classifier is unavailable.
  }

  return includesAnyKeyword(inbound, NEGATIVE_AVAILABILITY_KEYWORDS);
}

export async function classifyOrderConfirmationReplyIntent(
  inboundMessage: string,
  replyMessage: string,
): Promise<boolean> {
  const inbound = inboundMessage.trim();
  const reply = replyMessage.trim();
  if (!reply) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict classifier. Determine whether the assistant reply is a valid order confirmation that directly acknowledges the customer order request/details (any language). Return only JSON: {"is_order_confirmation_reply": true} or {"is_order_confirmation_reply": false}. Return true only when the reply clearly confirms/acknowledges an order creation/confirmation; polite fillers alone are false.\n\nClassification guidance:\n- True: clearly confirms order creation/confirmation, often restating key order details (product, address, quantity, or next step in orders).\n- False: generic support response, product info, upsell, greeting, or unclear message with no explicit confirmation.\n\nExamples:\n1) Customer: "Po, guralisht! Për të bërë porosinë, më jep adresën e plotë të dërgesës."\nAssistant: "Faleminderit! Porosia për Mass Gainer Pro u konfirmua. Do të dërgohet në adresën e dhënë."\n=> true\n\n2) Customer: "A mundem me bo 1 porosi per kete produkt"\nAssistant: "Po, porosia u krijua me sukses. Mund ta shikoni te Orders."\n=> true\n\n3) Customer: "Sa kushton ky?"\nAssistant: "Ky produkt kushton 34.50$."\n=> false\n\n4) Customer: "A e keni ne stok?"\nAssistant: "Po, e kemi në stok. Dëshiron ta porosisësh?"\n=> false\n\n5) Customer: "Dua ta porosis."\nAssistant: "Faleminderit për interesimin! Si mund t’ju ndihmoj më tej?"\n=> false',
        },
        {
          role: 'user',
          content: `Customer message:\n${inbound || '(empty)'}\n\nAssistant reply:\n${reply}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 96,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_order_confirmation_reply?: boolean };
      if (parsed.is_order_confirmation_reply === true) return true;
      if (parsed.is_order_confirmation_reply === false) return false;
    }
  } catch {
    // Fall through to lexical fallback when classifier is unavailable.
  }

  const inboundNormalized = normalizeForIntentMatch(inbound);
  const replyNormalized = normalizeForIntentMatch(reply);
  const inboundLooksOrderRelated = includesAnyKeyword(
    inboundNormalized,
    ORDER_CONFIRMATION_INBOUND_FALLBACK_KEYWORDS,
  );
  const replyLooksLikeConfirmation = includesAnyKeyword(
    replyNormalized,
    ORDER_CONFIRMATION_REPLY_FALLBACK_KEYWORDS,
  );

  return inboundLooksOrderRelated && replyLooksLikeConfirmation;
}

export async function classifyOrderDetailsCollectionReplyIntent(
  inboundMessage: string,
  replyMessage: string,
): Promise<boolean> {
  const inbound = inboundMessage.trim();
  const reply = replyMessage.trim();
  if (!reply) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict classifier. Determine whether the assistant reply is collecting required delivery details to proceed with purchase in any language. In this system, valid requested delivery details are ONLY: phone number and full delivery/shipping address. Return only JSON: {"is_order_details_collection_reply": true} or {"is_order_details_collection_reply": false}. Return true only when the reply asks for phone number and/or full delivery address as the next ordering step. Return false if the reply asks for unrelated personal data (e.g., full name, surname, ID number, birthday) or unrelated chit-chat.',
        },
        {
          role: 'user',
          content: `Customer message:\n${inbound || '(empty)'}\n\nAssistant reply:\n${reply}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 96,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_order_details_collection_reply?: boolean };
      if (parsed.is_order_details_collection_reply === true) return true;
      if (parsed.is_order_details_collection_reply === false) return false;
    }
  } catch {
    // Fall through to lexical fallback when classifier is unavailable.
  }

  const replyNormalized = normalizeForIntentMatch(reply);
  return includesAnyKeyword(replyNormalized, ORDER_DETAILS_COLLECTION_REPLY_FALLBACK_KEYWORDS);
}

export async function classifyOrderClosingQuestionReplyIntent(message: string): Promise<boolean> {
  const reply = message.trim();
  if (!reply) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict classifier. Determine whether the assistant reply includes an order-closing question that asks the customer to place/proceed with an order (in any language). Return only JSON: {"is_order_closing_question": true} or {"is_order_closing_question": false}. Mark true for phrases like "A doni ta porosisni?" or "Would you like to order?".',
        },
        {
          role: 'user',
          content: `Assistant reply:\n${reply}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_order_closing_question?: boolean };
      if (parsed.is_order_closing_question === true) return true;
      if (parsed.is_order_closing_question === false) return false;
    }
  } catch {
    // Fall through to keyword fallback when classifier is unavailable.
  }

  const normalized = normalizeForIntentMatch(reply);
  return includesAnyKeyword(normalized, ORDER_CLOSING_QUESTION_FALLBACK_KEYWORDS);
}

async function customerAskedAboutPrice(message: string): Promise<boolean> {
  const inbound = message.trim();
  if (!inbound) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict intent classifier. Detect whether the customer message explicitly asks for product price/cost/payment amount (in any language, slang, shorthand, or misspelling). Return only JSON: {"is_price_question": true} or {"is_price_question": false}. Mark true only when price/cost is explicitly requested.',
        },
        {
          role: 'user',
          content: `Customer message:\n${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_price_question?: boolean };
      if (parsed.is_price_question === true) return true;
      if (parsed.is_price_question === false) return false;
    }
  } catch {
    // Fall through to lightweight lexical fallback if classifier is unavailable.
  }

  const t = inbound.toLowerCase();
  return [
    'price',
    'cost',
    'how much',
    'sa kushton',
    'cmim',
    'qmim',
    '$',
    '€',
  ].some((needle) => t.includes(needle));
}

const DISCOUNT_REQUEST_KEYWORDS = [
  'discount',
  'discounted',
  'cheaper',
  'lower price',
  'reduce',
  'reduction',
  'sale',
  'promo',
  'promotion',
  'deal',
  'offer',
  'coupon',
  'zbritje',
  'zbritj',
  'ulje',
  'me lire',
  'me lir',
  'me ulje',
  'me zbritje',
  'me zbritj',
  'oferte',
  'ofertë',
  'cmim me i lire',
  'qmim me i lire',
  'a ben dicka',
  'a ben gje',
  'a ka zbritje',
  'a ka ulje',
];

export async function customerAskedAboutDiscount(message: string): Promise<boolean> {
  const inbound = message.trim();
  if (!inbound) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict intent classifier. Detect whether the customer message asks for a discount, price reduction, sale, promotion, special offer, deal, or any form of lower price (in any language, slang, shorthand, or misspelling). This includes negotiation phrases like "can you go lower", "any discount", "make it cheaper", or in Albanian "a ka zbritje", "a ben dicka me cmimin", "me lire". Return only JSON: {"is_discount_request": true} or {"is_discount_request": false}.',
        },
        {
          role: 'user',
          content: `Customer message:\n${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_discount_request?: boolean };
      if (parsed.is_discount_request === true) return true;
      if (parsed.is_discount_request === false) return false;
    }
  } catch {
    // Fall through to lexical fallback if classifier is unavailable.
  }

  return includesAnyKeyword(inbound, DISCOUNT_REQUEST_KEYWORDS);
}

/**
 * Lightweight heuristic backstop for the LLM language classifier. Detects clear Albanian/English
 * markers; returns null when the message is too ambiguous (very short, emoji-only, digits,
 * affirmation tokens like "ok"/"po"/"yes" that exist in both languages or in slang).
 *
 * Diacritics are NOT required to detect Albanian — typos and Latin-only spellings are normal in
 * messaging apps, so we lowercase + strip diacritics before matching.
 */
function heuristicallyDetectLanguage(text: string): ReplyLocale | null {
  const raw = text.trim();
  if (!raw) return null;

  if (/[ËëÇç]/.test(raw)) return 'sq';

  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const ALBANIAN_MARKERS = [
    'pershendetje', 'mirdita', 'naten e mire', 'faleminderit', 'flm', 'fln',
    'porosi', 'porosit', 'porosis', 'cmim', 'qmim', 'stok', 'produkt', 'produkti',
    'doni', 'deshironi', 'mund', 'kemi', 'kam', 'keni', 'jam', 'jeni',
    'nuk', 'pse', 'ku', 'kur', 'sa kushton', 'a keni', 'a kemi', 'me lir',
    'gjendet', 'derges', 'adres', 'ju lutem', 'mire', 'kalofshi', 'kalofsh',
    'mund te', 'mundeni', 'jashte stoku',
  ];
  const ENGLISH_MARKERS = [
    'hello', 'hi there', 'hey', 'good morning', 'good afternoon', 'good evening',
    'thanks', 'thank you', 'please', 'sorry', 'how much', 'do you have',
    'is this', 'is it', 'are you', 'are these', 'i need', 'i want', 'i would like',
    'can you', 'could you', 'would you', 'available', 'in stock', 'out of stock',
    'shipping', 'delivery', 'address', 'order', 'product', 'price', 'cost',
    'discount', 'cheaper', 'refund', 'cancel',
  ];

  const albanianHits = ALBANIAN_MARKERS.filter((needle) => normalized.includes(needle)).length;
  const englishHits = ENGLISH_MARKERS.filter((needle) => normalized.includes(needle)).length;

  if (albanianHits >= 1 && albanianHits > englishHits) return 'sq';
  if (englishHits >= 1 && englishHits > albanianHits) return 'en';
  return null;
}

/**
 * Detects whether the AI should reply in Albanian (`sq`) or English (`en`).
 *
 * The latest customer message drives the decision. For very short or ambiguous messages
 * ("ok", "po", "yes", emojis, numbers), we feed the recent customer turns to the LLM as
 * tie-breaking context so the conversation does not flip languages mid-thread. The classifier
 * is asked to return ONLY `sq` or `en`; we never emit any other locale.
 */
export async function detectReplyLanguage(
  inboundMessage: string,
  conversationHistory: Message[] = [],
): Promise<ReplyLocale> {
  const inbound = inboundMessage.trim();

  const customerHistory = conversationHistory
    .filter((msg) => msg.sent_by === 'customer')
    .map((msg) => (msg.content ?? '').trim())
    .filter((text) => text.length > 0);
  const recentCustomerTexts = customerHistory.slice(-4);
  const sampleForHeuristic =
    inbound || recentCustomerTexts[recentCustomerTexts.length - 1] || '';

  if (!sampleForHeuristic) return DEFAULT_REPLY_LOCALE;

  // Fast path: if the latest message has unambiguous language signals, skip the API call.
  const heuristicForInbound = heuristicallyDetectLanguage(inbound);
  if (heuristicForInbound !== null) {
    return heuristicForInbound;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict language classifier for an Albanian/English customer-support assistant. Decide whether the LATEST customer message should be answered in Albanian ("sq") or English ("en"). Only those two outputs are allowed. Rules:\n- If the latest message is clearly Albanian (with or without diacritics), return "sq".\n- If the latest message is clearly English, return "en".\n- For very short or ambiguous messages (e.g., "ok", "po", "yes", "no", emojis, numbers, single product names), use the language of the recent prior customer messages. If those are also absent or ambiguous, return "sq".\n- Mixed messages: pick the language of the majority of meaningful words.\nReturn only JSON: {"language":"sq"} or {"language":"en"}.',
        },
        {
          role: 'user',
          content: `Recent customer messages (oldest to newest):\n${
            recentCustomerTexts.length > 0
              ? recentCustomerTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')
              : '(none)'
          }\n\nLatest customer message to classify:\n${inbound || '(empty)'}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 32,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { language?: string };
      if (parsed.language === 'en') return 'en';
      if (parsed.language === 'sq') return 'sq';
    }
  } catch {
    // Fall through to heuristic over the most recent customer turn(s).
  }

  for (let i = recentCustomerTexts.length - 1; i >= 0; i -= 1) {
    const guess = heuristicallyDetectLanguage(recentCustomerTexts[i]);
    if (guess !== null) return guess;
  }
  return DEFAULT_REPLY_LOCALE;
}

function assistantAlreadyAddressedDiscount(conversationHistory: Message[]): boolean {
  const assistantMessages = conversationHistory.filter((msg) => msg.sent_by !== 'customer');
  if (assistantMessages.length === 0) return false;

  return assistantMessages.some((msg) => {
    const normalized = normalizeForIntentMatch(msg.content ?? '');
    if (!normalized) return false;
    return (
      /\b(zbritj|ulje|me lire|me lir|cmim final|qmim final|cmimi aktual|qmimi aktual|nuk mund te aplikohet|nuk mund te bejme zbritje|asnje zbritje|nuk ka zbritje)\b/.test(
        normalized,
      ) ||
      /\b(discount|reduction|final price|no further discount|no additional discount|cannot offer)\b/.test(
        normalized,
      )
    );
  });
}

/**
 * Detects whether a previous assistant reply has already communicated that the price is final
 * (no additional discount possible, or the displayed price is final because no discount is configured).
 * Used to silence repeated discount requests once the matter has been finalized.
 */
function assistantAlreadyFinalizedDiscount(conversationHistory: Message[]): boolean {
  const assistantMessages = conversationHistory.filter((msg) => msg.sent_by !== 'customer');
  if (assistantMessages.length === 0) return false;

  return assistantMessages.some((msg) => {
    const normalized = normalizeForIntentMatch(msg.content ?? '');
    if (!normalized) return false;

    // Albanian: "çmim ... final" / "çmimi aktual është final" (after diacritic stripping).
    const albanianFinalPrice =
      /\b(final|finale)\b/.test(normalized) &&
      /\b(cmim|cmimi|qmim|qmimi)\b/.test(normalized);

    // Albanian: "nuk mund të aplikohet zbritje shtesë" / "asnjë zbritje" / "nuk është e mundur asnjë zbritje".
    const albanianNoFurtherDiscount =
      /\b(zbritje shtese|zbritj shtese|asnje zbritje|asnje zbritj|nuk ka zbritje|nuk ka zbritj|nuk eshte e mundur asnje zbritje|nuk eshte e mundur asnje zbritj|nuk mund te aplikohet|nuk mund te bejme zbritje|nuk mund te beje zbritje)\b/.test(
        normalized,
      );

    // English fallback.
    const englishFinalPrice =
      /\b(final price|price is final|no further discount|no additional discount|no more discount|cannot offer (any|further|additional))\b/.test(
        normalized,
      );

    return albanianFinalPrice || albanianNoFurtherDiscount || englishFinalPrice;
  });
}

/** Lexical catalog lookup for inbound customer text (short phrase or full question). */
export async function findProductsForInboundMessage(
  tenantId: string,
  inboundMessage: string,
  limit = 5,
): Promise<Product[]> {
  const searchText = inboundMessage.trim();
  if (!searchText) return [];
  const direct = await searchProducts(tenantId, searchText, limit);
  if (direct.length > 0) return direct;
  const keywords = extractKeywords(searchText);
  if (keywords.length === 0) return [];
  return searchProductsByDisjunctiveTerms(tenantId, keywords, limit);
}

/**
 * Exact replies (per language) when the customer is asking about one focused catalog match that
 * is out of stock. The locale is decided by `detectReplyLanguage` upstream.
 */
export const OUT_OF_STOCK_PRODUCT_REPLY: Record<ReplyLocale, string> = {
  sq: 'Përshëndetje, produkti për momentin është jashtë stokut. Nëse jeni të interesuar për ndonjë produkt tjetër, mund te ju ndihmoj.',
  en: 'Hello, this product is currently out of stock. If you are interested in any other product, I would be happy to help.',
};

export function getOutOfStockProductReply(locale: ReplyLocale): string {
  return OUT_OF_STOCK_PRODUCT_REPLY[locale];
}

export function isOutOfStockProductReply(reply: string): boolean {
  const trimmed = reply.trim();
  return (
    trimmed === OUT_OF_STOCK_PRODUCT_REPLY.sq ||
    trimmed === OUT_OF_STOCK_PRODUCT_REPLY.en
  );
}

function looksLikeSimpleGreetingOrClosing(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (t.length > 80) return false;
  return (
    /^(hi|hello|hey|hej|faleminderit|thanks|thank you|ok|okej)(\s*[!.?])?\s*$/i.test(lower) ||
    /^(përshëndetje|pershendetje|mirdita)(\s*[!.?])?\s*$/i.test(lower)
  );
}

/** Lowercase, strip diacritics, collapse punctuation to spaces (Albanian-friendly loose match). */
function foldForProductReference(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Whether the inbound text likely names this product (used when several catalog rows matched).
 * Uses SKU, diacritic-insensitive name match, compact name, token overlap, and brand + name word.
 */
function inboundTextLikelyReferencesProduct(inboundMessage: string, product: Product): boolean {
  const raw = inboundMessage.trim();
  if (!raw) return false;

  const sku = product.sku?.trim();
  if (sku && sku.length >= 3) {
    const skuKey = normalizeForMatch(sku);
    const msgKey = normalizeForMatch(raw);
    if (skuKey.length >= 3 && msgKey.includes(skuKey)) return true;
  }

  const nameRaw = product.name?.trim() ?? '';
  if (!nameRaw) return false;

  const hay = foldForProductReference(raw);
  const name = foldForProductReference(nameRaw);
  if (!name) return false;

  if (name.length >= 3 && hay.includes(name)) return true;

  const nameCompact = name.replace(/\s/g, '');
  const hayCompact = hay.replace(/\s/g, '');
  if (nameCompact.length >= 4 && hayCompact.includes(nameCompact)) return true;

  const tokens = name.split(/\s+/).filter((w) => w.length > 0);
  const significant = tokens.filter((w) => w.length >= 4);
  const check = significant.length > 0 ? significant : tokens.filter((w) => w.length >= 3);
  if (check.length === 0) return false;
  const hits = check.filter((w) => hay.includes(w));
  if (hits.length >= Math.ceil(check.length * 0.5)) return true;

  const brand = getProductBrand(product);
  if (brand && brand.trim().length >= 2) {
    const b = foldForProductReference(brand);
    if (b.length >= 2 && hay.includes(b) && significant.some((w) => hay.includes(w))) return true;
  }

  return false;
}

export function formatProductCatalog(
  products: Product[],
  options?: { includePrice?: boolean; includeDiscount?: boolean },
): string {
  const includePrice = options?.includePrice ?? true;
  const includeDiscount = options?.includeDiscount ?? false;
  if (products.length === 0) return 'No matching products found in the catalog.';

  return products
    .map((p) => {
      const typeText = p.tags.length > 0 ? p.tags.join(', ') : 'N/A';
      const parts = [
        `- Brand: ${getProductBrand(p) ?? 'Unknown'}, Product: ${p.name}, Type: ${typeText}`,
      ];
      if (includePrice) {
        parts.push(`  Price: €${Number(p.price).toFixed(2)}`);
      }
      if (includeDiscount || includePrice) {
        const discounted = p.discounted_price;
        if (discounted !== null && discounted !== undefined) {
          const discountedNum = Number(discounted);
          if (Number.isFinite(discountedNum)) {
            parts.push(
              `  Discounted price (maximum offer when customer asks for a discount): €${discountedNum.toFixed(2)}`,
            );
          }
        } else if (includeDiscount) {
          parts.push('  Discounted price: not configured (no discount available)');
        }
      }
      if (p.description) parts.push(`  ${p.description}`);
      if (p.usage_description) {
        parts.push('  Usage description:');
        parts.push(`  ${p.usage_description}`);
      }
      if (p.category) parts.push(`  Category: ${p.category}`);
      if (p.tags.length > 0) parts.push(`  Tags: ${p.tags.join(', ')}`);
      parts.push(
        `  Stock status (agent-only; do not mention unless the customer asks about availability/stock): ${p.in_stock === false ? 'out of stock' : 'in stock'}`,
      );
      return parts.join('\n');
    })
    .join('\n');
}

function formatQAPairs(pairs: { question: string; answer: string }[]): string {
  if (pairs.length === 0) return '';

  const formatted = pairs
    .map((pair) => `Q: ${pair.question}\nA: ${pair.answer}`)
    .join('\n\n');

  return `\n\nFrequently Asked Questions:\n${formatted}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCatalogBrandProductPairs(
  productCatalogContext: string,
): Array<{ brand: string; product: string }> {
  if (!productCatalogContext.trim()) return [];
  const pairs: Array<{ brand: string; product: string }> = [];
  const lines = productCatalogContext.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = /^-\s*Brand:\s*(.+?),\s*Product:\s*(.+?),\s*Type:/i.exec(line);
    if (!match) continue;
    const brand = match[1]?.trim();
    const product = match[2]?.trim();
    if (!brand || !product) continue;
    if (brand.toLowerCase() === 'unknown') continue;
    pairs.push({ brand, product });
  }
  return pairs;
}

function normalizeProductMentionsForReply(
  reply: string,
  productCatalogContext: string,
): string {
  let normalized = reply;
  const quoteChars = `"'“”‘’`;
  const escapedQuoteChars = `"'“”‘’`;
  const pairs = extractCatalogBrandProductPairs(productCatalogContext);

  for (const { brand, product } of pairs) {
    const escapedBrand = escapeRegExp(brand);
    const escapedProduct = escapeRegExp(product);
    const brandPlusProduct = new RegExp(`\\b${escapedBrand}\\s+${escapedProduct}\\b`, 'giu');
    normalized = normalized.replace(brandPlusProduct, product);

    const wrappedProduct = new RegExp(
      `[\"'“”‘’]\\s*(${escapedProduct})\\s*[\"'“”‘’]`,
      'giu',
    );
    normalized = normalized.replace(wrappedProduct, '$1');

    const leadingQuotedProduct = new RegExp(
      `([\\s(\\[{:,;-])["'“”‘’]\\s*(${escapedProduct})(?=[\\s)\\]}.!?,;:-]|$)`,
      'giu',
    );
    normalized = normalized.replace(leadingQuotedProduct, '$1$2');
  }

  // Remove quote artifacts after Albanian product-article words.
  normalized = normalized.replace(
    new RegExp(`\\b(produkti|produktin|produktit|produktet)\\s*[${escapedQuoteChars}]+`, 'giu'),
    '$1 ',
  );
  // Remove quote artifacts before punctuation and duplicated whitespace.
  normalized = normalized
    .replace(new RegExp(`[${escapedQuoteChars}]+(?=[.,!?;:])`, 'gu'), '')
    .replace(/\s{2,}/g, ' ');

  // If there are unmatched quote chars left in message, strip them to avoid odd rendering.
  const quoteCount = [...normalized].filter((ch) => quoteChars.includes(ch)).length;
  if (quoteCount % 2 === 1) {
    normalized = normalized.replace(new RegExp(`[${escapedQuoteChars}]`, 'gu'), '');
  }

  return normalized.trim();
}

/**
 * Strips leading/trailing whitespace and collapses internal newlines to a single space.
 * Used for single-line fields (business name, tone, niche) to prevent prompt structure
 * injection via newline characters embedded in tenant-controlled strings.
 */
function sanitizeSingleLineField(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** CRM "My Business" niche + description; injected so the model can answer location / about-us style questions. */
export function formatBusinessProfileForPrompt(
  tenantNiche?: string | null,
  tenantDescription?: string | null,
): string | null {
  const niche = typeof tenantNiche === 'string' ? sanitizeSingleLineField(tenantNiche) : '';
  const desc = typeof tenantDescription === 'string' ? tenantDescription.trim() : '';
  if (!niche && !desc) return null;
  const parts: string[] = ['Business profile (from My Business in the CRM):'];
  if (niche) parts.push(`Industry / niche: ${niche}`);
  if (desc) parts.push(`Details:\n${desc}`);
  return parts.join('\n');
}

/** Core CRM assistant prompt body (guidelines assembled separately from tenant prompt_blocks). */
export function buildRetailAISystemPrompt(
  businessName: string,
  config: typeof DEFAULT_AI_CONFIG & { platform_restrictions?: string[] },
  productCatalogContext: string,
  assembledGuidelines: string,
  tenantNiche?: string | null,
  tenantDescription?: string | null,
): string {
  const safeName = sanitizeSingleLineField(businessName);
  const safeTone = sanitizeSingleLineField(config.tone);

  const lines: string[] = [
    `You are the AI sales assistant for "${safeName}".`,
    `Your tone should be: ${safeTone}.`,
  ];

  if (config.personality_description) {
    lines.push(`Personality: ${config.personality_description}`);
  }

  if (config.sales_strategy) {
    lines.push('', `Sales strategy: ${config.sales_strategy}`);
  }

  if (config.objection_handling) {
    lines.push('', `Objection handling approach: ${config.objection_handling}`);
  }

  const businessProfile = formatBusinessProfileForPrompt(tenantNiche, tenantDescription);
  if (businessProfile) {
    lines.push('', businessProfile);
  }

  lines.push('', 'Product catalog:', productCatalogContext);

  const qa = formatQAPairs(config.qa_pairs);
  if (qa) lines.push(qa);

  const gl = assembledGuidelines.trim();
  if (gl) {
    lines.push('', 'Guidelines:', gl);
  }

  const restrictions = config.restrictions ?? [];
  if (restrictions.length > 0) {
    lines.push(
      '',
      `OPERATOR BUSINESS RULES — you MUST follow:\n${restrictions.map((r) => `- ${r}`).join('\n')}`,
    );
  }

  const platformRestrictions = config.platform_restrictions ?? [];
  if (platformRestrictions.length > 0) {
    lines.push(
      '',
      `PLATFORM POLICY — follow strictly:\n${platformRestrictions.map((r) => `- ${r}`).join('\n')}`,
    );
  }

  return lines.join('\n');
}

export async function isUsageQuestionUnanswered(
  inboundMessage: string,
  productUsageDescription: string,
): Promise<boolean> {
  const completion = await openai.chat.completions.create({
    model: OPENAI_CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You are a strict classifier. Determine whether the customer usage question is unanswered by the provided product usage description. Return only JSON: {"is_unanswered": true} or {"is_unanswered": false}. Mark true only when the usage description does not provide the requested usage information.',
      },
      {
        role: 'user',
        content: `Customer message:\n${inboundMessage}\n\nProduct usage description:\n${productUsageDescription}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 64,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) return false;

  try {
    const parsed = JSON.parse(raw) as { is_unanswered?: boolean };
    return parsed.is_unanswered === true;
  } catch {
    return false;
  }
}

export async function detectCancellationOrRefundIntent(
  inboundMessage: string,
  conversationHistory: Message[],
): Promise<{
  is_cancellation: boolean;
  is_refund: boolean;
  reason: string | null;
  confidence: number;
}> {
  const historySlice = conversationHistory.slice(-8);
  const historyText = historySlice
    .map((msg) => {
      const who = msg.sent_by === 'customer' ? 'Customer' : 'Agent';
      return `${who}: ${(msg.content ?? '').trim()}`;
    })
    .join('\n');

  const completion = await openai.chat.completions.create({
    model: OPENAI_CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a precise intent classifier. Determine if a customer is requesting to cancel or refund a SPECIFIC PRODUCT ORDER they have already placed with this business.
Only return is_cancellation: true if:

The customer explicitly says they want to cancel an order they already placed
The context makes clear this is about a completed purchase, not a hypothetical or future one
They are not talking about cancelling a subscription, newsletter, or other non-product service

Only return is_refund: true if:

The customer explicitly says they want a refund for something they already purchased and paid for
The context makes clear money was exchanged for a product

Return is_cancellation: false and is_refund: false for:

Questions about the return or cancellation policy
Hypothetical questions like 'what if I want to cancel?'
Cancelling something unrelated to a product order
General complaints without a refund request

Return JSON: { is_cancellation: boolean, is_refund: boolean, reason: string | null, confidence: number }`,
      },
      {
        role: 'user',
        content: `Conversation context:\n${historyText || '(none)'}\n\nLatest customer message:\n${inboundMessage}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 200,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) {
    return { is_cancellation: false, is_refund: false, reason: null, confidence: 0 };
  }

  try {
    const parsed = JSON.parse(raw) as {
      is_cancellation?: boolean;
      is_refund?: boolean;
      reason?: string | null;
      confidence?: number;
    };
    const reasonRaw = typeof parsed.reason === 'string' ? parsed.reason.trim() : null;

    const is_cancellation = parsed.is_cancellation === true;
    const is_refund = parsed.is_refund === true;
    let confidence = parseModelClassifierConfidence(parsed.confidence);
    if ((is_cancellation || is_refund) && confidence === 0) {
      confidence = 0.9;
    }

    return {
      is_cancellation,
      is_refund,
      reason: reasonRaw && reasonRaw.length > 0 ? reasonRaw : null,
      confidence,
    };
  } catch {
    return { is_cancellation: false, is_refund: false, reason: null, confidence: 0 };
  }
}

export async function detectPostPurchaseSupportIntent(
  inboundMessage: string,
  conversationHistory: Message[],
): Promise<{
  is_delivery_eta_query: boolean;
  is_not_delivered_complaint: boolean;
  is_wrong_product_issue: boolean;
  is_product_problem_issue: boolean;
  confidence: number;
  reason: string | null;
}> {
  const historySlice = conversationHistory.slice(-8);
  const historyText = historySlice
    .map((msg) => {
      const who = msg.sent_by === 'customer' ? 'Customer' : 'Agent';
      return `${who}: ${(msg.content ?? '').trim()}`;
    })
    .join('\n');

  const completion = await openai.chat.completions.create({
    model: OPENAI_CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a strict support-intent classifier for post-purchase issues.
Detect only these intents about an order that has already been placed:
1) delivery ETA query (customer asks when the package/product will arrive),
2) not delivered complaint (customer says they still have not received it),
3) wrong product issue (customer says they received the wrong item),
4) product problem issue (damaged/defective/problematic product received).

Set booleans to true only when the latest message clearly refers to a completed purchase/order context.
Set all booleans false for:
- pre-purchase shipping policy questions,
- generic delivery information not tied to their own order,
- vague complaints without delivery/product issue context.

Return JSON exactly:
{
  "is_delivery_eta_query": boolean,
  "is_not_delivered_complaint": boolean,
  "is_wrong_product_issue": boolean,
  "is_product_problem_issue": boolean,
  "confidence": number,
  "reason": string | null
}`,
      },
      {
        role: 'user',
        content: `Conversation context:\n${historyText || '(none)'}\n\nLatest customer message:\n${inboundMessage}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 240,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) {
    return {
      is_delivery_eta_query: false,
      is_not_delivered_complaint: false,
      is_wrong_product_issue: false,
      is_product_problem_issue: false,
      confidence: 0,
      reason: null,
    };
  }

  try {
    const parsed = JSON.parse(raw) as {
      is_delivery_eta_query?: boolean;
      is_not_delivered_complaint?: boolean;
      is_wrong_product_issue?: boolean;
      is_product_problem_issue?: boolean;
      confidence?: number;
      reason?: string | null;
    };

    const is_delivery_eta_query = parsed.is_delivery_eta_query === true;
    const is_not_delivered_complaint = parsed.is_not_delivered_complaint === true;
    const is_wrong_product_issue = parsed.is_wrong_product_issue === true;
    const is_product_problem_issue = parsed.is_product_problem_issue === true;
    let confidence = parseModelClassifierConfidence(parsed.confidence);
    const anyIntent =
      is_delivery_eta_query ||
      is_not_delivered_complaint ||
      is_wrong_product_issue ||
      is_product_problem_issue;
    if (anyIntent && confidence === 0) {
      confidence = 0.9;
    }
    const reasonRaw = typeof parsed.reason === 'string' ? parsed.reason.trim() : null;

    return {
      is_delivery_eta_query,
      is_not_delivered_complaint,
      is_wrong_product_issue,
      is_product_problem_issue,
      confidence,
      reason: reasonRaw && reasonRaw.length > 0 ? reasonRaw : null,
    };
  } catch {
    return {
      is_delivery_eta_query: false,
      is_not_delivered_complaint: false,
      is_wrong_product_issue: false,
      is_product_problem_issue: false,
      confidence: 0,
      reason: null,
    };
  }
}

export async function detectOrderAffirmationIntent(
  inboundMessage: string,
  conversationHistory: Message[],
): Promise<{ is_order_affirmation: boolean; confidence: number; reason: string | null }> {
  const historySlice = conversationHistory.slice(-8);
  const historyText = historySlice
    .map((msg) => {
      const who = msg.sent_by === 'customer' ? 'Customer' : 'Agent';
      return `${who}: ${(msg.content ?? '').trim()}`;
    })
    .join('\n');

  const completion = await openai.chat.completions.create({
    model: OPENAI_CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a strict intent classifier for order-confirmation replies.
Detect whether the latest customer message is an affirmation to proceed with an order (including short confirmations) rather than a complaint.

Return is_order_affirmation: true for messages like:
- "po", "po ju lutem", "ok", "yes", "sure", "vazhdo", "beje porosine", "place it"
- especially when prior assistant message asks to proceed/order.

Return is_order_affirmation: false when the customer is reporting post-purchase issues (delivery delay, non-delivery, wrong item, damaged/defective product), asking for cancellation/refund, or asking unrelated questions.

Return JSON exactly:
{ "is_order_affirmation": boolean, "confidence": number, "reason": string | null }`,
      },
      {
        role: 'user',
        content: `Conversation context:\n${historyText || '(none)'}\n\nLatest customer message:\n${inboundMessage}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 180,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) return { is_order_affirmation: false, confidence: 0, reason: null };

  try {
    const parsed = JSON.parse(raw) as {
      is_order_affirmation?: boolean;
      confidence?: number;
      reason?: string | null;
    };
    let confidence = 0;
    if (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)) {
      confidence = parsed.confidence > 1 ? parsed.confidence / 100 : parsed.confidence;
    }
    confidence = Math.min(1, Math.max(0, confidence));
    const reasonRaw = typeof parsed.reason === 'string' ? parsed.reason.trim() : null;
    return {
      is_order_affirmation: parsed.is_order_affirmation === true,
      confidence,
      reason: reasonRaw && reasonRaw.length > 0 ? reasonRaw : null,
    };
  } catch {
    return { is_order_affirmation: false, confidence: 0, reason: null };
  }
}

type ChatMessageContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: ChatMessageContent };
type VisionProductExtraction = {
  brand_name: string | null;
  product_name: string | null;
  product_type: string;
  flavor: string | null;
  size: string | null;
  confidence: number;
};

function normalizeAttachmentUrls(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((u): u is string => typeof u === 'string' && u.length > 0);
  }
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return normalizeAttachmentUrls(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

function resolveImageUrls(attachmentUrls: string[]): string[] {
  const resolved: string[] = [];
  for (const url of attachmentUrls) {
    const filePath = permanentUrlToFilePath(url);
    if (filePath) {
      const dataUrl = fileToBase64DataUrl(filePath);
      if (dataUrl) {
        resolved.push(dataUrl);
        continue;
      }
    }
    resolved.push(url);
  }
  return resolved;
}

/** URLs the chat vision API can consume as `image_url` (not MP4/HTML, etc.). */
function urlLooksLikeVisionImage(url: string): boolean {
  const u = url.toLowerCase();
  if (u.endsWith('.mp4') || u.includes('.mp4?')) return false;
  if (u.endsWith('.webm') || u.includes('.webm?')) return false;
  if (u.endsWith('.mov') || u.includes('.mov?')) return false;
  if (u.includes('/video/upload/')) return false;
  if (u.includes('mime_video') || u.includes('resource_type=video')) return false;
  return true;
}

function partitionVisionAttachments(attachmentUrls: string[]): {
  visionUrls: string[];
  hadSkippedVideo: boolean;
} {
  const visionUrls = attachmentUrls.filter(urlLooksLikeVisionImage);
  const hadSkippedVideo = visionUrls.length < attachmentUrls.length;
  return { visionUrls, hadSkippedVideo };
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getProductBrand(product: Product): string | null {
  const maybeBrand = (product as Product & { brand?: string | null }).brand;
  return typeof maybeBrand === 'string' && maybeBrand.trim().length > 0 ? maybeBrand.trim() : null;
}

function isBrandLikelyInCatalog(brandName: string, products: Product[]): boolean {
  const normalizedBrand = normalizeForMatch(brandName);
  if (!normalizedBrand) return false;

  return products.some((product) => {
    const candidates = [
      getProductBrand(product) ?? '',
      product.name ?? '',
      product.description ?? '',
      ...(product.tags ?? []),
    ];
    return candidates.some((candidate) =>
      normalizeForMatch(candidate).includes(normalizedBrand),
    );
  });
}

async function extractProductInfoFromImages(
  inboundMessage: string,
  attachmentUrls: string[],
): Promise<VisionProductExtraction | null> {
  if (attachmentUrls.length === 0) return null;

  const { visionUrls } = partitionVisionAttachments(attachmentUrls);
  if (visionUrls.length === 0) return null;

  const resolvedImageUrls = resolveImageUrls(visionUrls);
  if (resolvedImageUrls.length === 0) return null;

  const completion = await openai.chat.completions.create({
    model: OPENAI_VISION_MODEL || 'gpt-4o',
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 220,
    messages: [
      {
        role: 'system',
        content:
          'You are a strict product-image extractor. Extract only visible/credible product information from the image(s). Return ONLY valid JSON with keys: brand_name (string|null), product_name (string|null), product_type (string), flavor (string|null), size (string|null), confidence (number from 0 to 1). Set missing values to null. Use concise values.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Step 1 only: extract structured product information from these image(s). Customer message context: "${inboundMessage.trim() || 'No text provided.'}"`,
          },
          ...resolvedImageUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<VisionProductExtraction>;
    return {
      brand_name: typeof parsed.brand_name === 'string' && parsed.brand_name.trim() ? parsed.brand_name.trim() : null,
      product_name: typeof parsed.product_name === 'string' && parsed.product_name.trim() ? parsed.product_name.trim() : null,
      product_type: typeof parsed.product_type === 'string' && parsed.product_type.trim() ? parsed.product_type.trim() : 'unknown',
      flavor: typeof parsed.flavor === 'string' && parsed.flavor.trim() ? parsed.flavor.trim() : null,
      size: typeof parsed.size === 'string' && parsed.size.trim() ? parsed.size.trim() : null,
      confidence: typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? parsed.confidence : 0,
    };
  } catch {
    return null;
  }
}

/**
 * True when this customer message has been edited AFTER an outbound message landed in the same
 * conversation history slice. In that case the AI/agent already replied to the original text,
 * so we expose the diff to the model so it can correct itself; for never-replied edits we just
 * use the new content directly because the original is irrelevant context.
 */
function customerMessageEditedAfterOutbound(msg: Message, history: Message[]): boolean {
  if (msg.sent_by !== 'customer') return false;
  if (msg.edit_count <= 0 || !msg.edited_at) return false;
  const editedAtMs = msg.edited_at.getTime();
  for (const other of history) {
    if (other.id === msg.id) continue;
    if (other.direction !== 'outbound') continue;
    const created = other.created_at instanceof Date ? other.created_at : new Date(other.created_at);
    const createdMs = created.getTime();
    if (!Number.isFinite(createdMs)) continue;
    // Outbound created strictly after the customer message AND before the most recent edit
    // → the customer edited the original after we replied.
    if (createdMs > new Date(msg.created_at).getTime() && createdMs < editedAtMs) {
      return true;
    }
  }
  return false;
}

function truncateForEditHint(text: string, max = 280): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

function formatCustomerMessageContentForPrompt(
  msg: Message,
  context?: { editedAfterOutbound?: boolean },
): string {
  const body = (msg.content ?? '').trim();
  const snap = msg.reply_to_content?.trim();
  let core = body;
  if (msg.sent_by === 'customer' && snap) {
    core = `Customer replied to: '${snap}' — saying: '${body}'`;
  }
  // Only surface the original text to the model when the AI/agent has already replied to it;
  // otherwise the pre-edit version is noise and could confuse the model into using stale context.
  if (
    context?.editedAfterOutbound &&
    msg.original_content != null &&
    msg.original_content.trim() !== body
  ) {
    const original = truncateForEditHint(msg.original_content);
    const updated = truncateForEditHint(body || '(empty)');
    return [
      '[The customer edited their earlier message after you replied to it.',
      `Original: "${original}"`,
      `Now reads: "${updated}"`,
      'Treat the new text as the canonical request and gracefully correct any prior reply that no longer matches.]',
      core,
    ].join('\n');
  }
  return core;
}

function summarizeOlderConversationContext(messages: Message[]): string | null {
  if (messages.length === 0) return null;

  const total = messages.length;
  const customerMessages = messages.filter((msg) => msg.sent_by === 'customer');
  const agentMessages = messages.filter((msg) => msg.sent_by !== 'customer');
  const first = messages[0];
  const last = messages[messages.length - 1];

  const firstText = (first.content ?? '').trim();
  const lastText = (last.content ?? '').trim();
  const firstPreview = firstText ? firstText.replace(/\s+/g, ' ').slice(0, 140) : null;
  const lastPreview = lastText ? lastText.replace(/\s+/g, ' ').slice(0, 140) : null;

  const customerHighlights = customerMessages
    .map((msg) =>
      formatCustomerMessageContentForPrompt(msg, {
        editedAfterOutbound: customerMessageEditedAfterOutbound(msg, messages),
      })
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((txt) => txt.length > 0)
    .slice(-2)
    .map((txt) => `"${txt.slice(0, 120)}${txt.length > 120 ? '...' : ''}"`);

  const parts: string[] = [
    `Earlier context summary (${total} older messages): customer sent ${customerMessages.length} message(s), assistant/agent sent ${agentMessages.length}.`,
  ];

  if (firstPreview) {
    parts.push(`The earlier thread starts with: "${firstPreview}${firstText.length > 140 ? '...' : ''}".`);
  }
  if (lastPreview) {
    parts.push(`Before the recent 10-message window, it most recently included: "${lastPreview}${lastText.length > 140 ? '...' : ''}".`);
  }
  if (customerHighlights.length > 0) {
    parts.push(`Notable recent customer points from that older segment: ${customerHighlights.join(' | ')}.`);
  }

  return parts.join(' ');
}

function buildMessagesArray(
  systemPrompt: string,
  conversationHistory: Message[],
  inboundMessage: string,
  attachmentUrls: string[] = [],
  visionContext: string | null = null,
  olderHistorySummary: string | null = null,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  if (olderHistorySummary) {
    messages.push({
      role: 'assistant',
      content: olderHistorySummary,
    });
  }

  for (const msg of conversationHistory) {
    const histUrls = normalizeAttachmentUrls(msg.attachment_urls);
    const role: 'user' | 'assistant' =
      msg.sent_by === 'customer' ? 'user' : 'assistant';
    const textContent =
      role === 'user'
        ? formatCustomerMessageContentForPrompt(msg, {
            editedAfterOutbound: customerMessageEditedAfterOutbound(msg, conversationHistory),
          })
        : (msg.content ?? '').trim();
    if (!textContent && histUrls.length === 0) continue;

    messages.push({ role, content: textContent });
  }

  const lastMsg = messages[messages.length - 1];
  const lastUserText =
    typeof lastMsg?.content === 'string' ? lastMsg.content.trim() : '';
  const inboundTrimmed = inboundMessage.trim();
  const lastCustomerInHistory = [...conversationHistory]
    .reverse()
    .find((m) => m.sent_by === 'customer');
  const expectedLastUserFromHistory =
    lastCustomerInHistory &&
    (lastCustomerInHistory.content ?? '').trim() === inboundTrimmed
      ? formatCustomerMessageContentForPrompt(lastCustomerInHistory, {
          editedAfterOutbound: customerMessageEditedAfterOutbound(
            lastCustomerInHistory,
            conversationHistory,
          ),
        }).trim()
      : inboundTrimmed;
  const alreadyAppended =
    lastMsg?.role === 'user' &&
    (lastUserText === inboundTrimmed ||
      lastUserText === expectedLastUserFromHistory ||
      (inboundTrimmed === '' && lastUserText === ''));

  if (attachmentUrls.length > 0) {
    const { visionUrls, hadSkippedVideo } = partitionVisionAttachments(attachmentUrls);
    const imageUrls = resolveImageUrls(visionUrls);
    let textForParts = inboundTrimmed || (imageUrls.length > 0 ? 'The customer sent an image.' : '');
    if (visionContext) {
      textForParts =
        `Vision two-step context:\n${visionContext}\n\nStep requirement for image handling: extract the brand name first, then attempt catalog matching.\n\nCustomer message:\n${textForParts || '(no text)'}`;
    }
    if (hadSkippedVideo) {
      const videoNote =
        imageUrls.length === 0
          ? '\n\n(Attached: a short video, e.g. an Instagram story clip. You cannot view video in this interface. Use any written context from the customer; if they ask about what is in the story, politely ask them to describe it or name the product.)'
          : '\n\n(There is additionally a short video attachment you cannot view here.)';
      textForParts = (textForParts || 'The customer sent a message.') + videoNote;
    }
    const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      { type: 'text', text: textForParts },
      ...imageUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
    ];

    if (alreadyAppended) {
      messages[messages.length - 1] = { role: 'user', content: parts };
    } else {
      messages.push({ role: 'user', content: parts });
    }
  } else if (!alreadyAppended) {
    messages.push({ role: 'user', content: inboundTrimmed });
  }

  return messages;
}

const CONVERSATION_ENDING_ANALYST_SYSTEM =
  "You are a conversation analyst. Your only job is to determine if a message signals that a conversation is ending. This includes any form of goodbye, thank you and goodbye combined, polite dismissal, or closing pleasantry in ANY language including formal and informal versions, slang, abbreviations, and regional variations. For example in Albanian 'klm' means 'kalofshi mirë' which is have a nice day. 'fln' means 'faleminderit' which is thank you. Consider all such abbreviations and slang as ending signals. Return only a JSON object with a single boolean field: { is_ending: true } or { is_ending: false }";

const CLOSING_REPLY_SYSTEM_APPEND_TEMPLATE_BY_LOCALE: Record<ReplyLocale, string> = {
  sq: `
Final-closing behavior:
- If the latest customer message is a closing/thank-you/goodbye signal, reply with exactly one short polite closing sentence.
- Keep it brief (around 2-7 words), warm, and natural in Albanian.
- Reply ONLY in Albanian. Use this exact sentence: "__CLOSING_SENTENCE__".
- Do not ask any follow-up question.
- Do not continue the sales flow or introduce new topics.
`.trim(),
  en: `
Final-closing behavior:
- If the latest customer message is a closing/thank-you/goodbye signal, reply with exactly one short polite closing sentence.
- Keep it brief (around 2-7 words), warm, and natural in English.
- Reply ONLY in English. Use this exact sentence: "__CLOSING_SENTENCE__".
- Do not ask any follow-up question.
- Do not continue the sales flow or introduce new topics.
`.trim(),
};

/** Closing-reply sentences (per locale + per flavor) used when the customer is wrapping up. */
export const CLOSING_REPLY_SENTENCES: Record<ReplyLocale, { no_thanks: string; greeting: string }> = {
  sq: {
    no_thanks: 'Pa problem, kaloni bukur.',
    greeting: 'Edhe ju gjithashtu, kalofshi bukur.',
  },
  en: {
    no_thanks: 'No problem, take care.',
    greeting: 'You too, have a great day.',
  },
};

export function getClosingReplySentences(locale: ReplyLocale): {
  no_thanks: string;
  greeting: string;
} {
  return CLOSING_REPLY_SENTENCES[locale];
}

function normalizeClosingSignalText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function looksLikePoliteThanksClosing(messageContent: string): boolean {
  const normalized = normalizeClosingSignalText(messageContent);
  if (!normalized) return false;

  const explicitClosingPatterns = [
    /\b(jo|ska nevoje|ska nevoj|nuk ka nevoje|nuk ka nevoj)\s+(faleminderit|flm|fln)\b/,
    /\b(faleminderit|faleminderit shume|flm|flm shume|fln|rrofsh|ju faleminderit)\b/,
    /\b(no thanks|no thank you|thanks|thanks a lot|thank you|thank you very much|thx|ty)\b/,
  ];
  if (explicitClosingPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const shortMessageWordCount = normalized.split(' ').filter(Boolean).length;
  const hasThanksToken =
    /\b(faleminderit|flm|fln|rrofsh|thanks|thank you|thx|ty)\b/.test(normalized);
  const hasClosingToken =
    /\b(bye|goodbye|good night|good day|klm|kalofsh|kalofshi|kaloni bukur|nat e mire|naten e mire|diten e mire)\b/.test(
      normalized,
    );
  if (shortMessageWordCount <= 6 && hasThanksToken) {
    return true;
  }
  return shortMessageWordCount <= 8 && hasClosingToken;
}

type ClosingFlavor = 'no_thanks' | 'greeting';

function classifyClosingFlavor(messageContent: string): ClosingFlavor {
  const normalized = normalizeClosingSignalText(messageContent);
  if (!normalized) return 'greeting';

  const noThanksPatterns = [
    /\b(jo|sjo)\b/,
    /\b(ska nevoje|ska nevoj|s ka nevoje|s ka nevoj)\b/,
    /\b(nuk ka nevoje|nuk ka nevoj)\b/,
    /\b(no thanks|no thank you)\b/,
  ];

  if (noThanksPatterns.some((pattern) => pattern.test(normalized))) {
    return 'no_thanks';
  }

  return 'greeting';
}

function getPreviousAssistantMessageBeforeLatestCustomer(
  conversationHistory: Message[],
): Message | undefined {
  if (conversationHistory.length === 0) return undefined;
  const latestIndex = conversationHistory.length - 1;
  const latest = conversationHistory[latestIndex];
  if (latest.sent_by !== 'customer') return undefined;

  for (let i = latestIndex - 1; i >= 0; i -= 1) {
    if (conversationHistory[i].sent_by !== 'customer') {
      return conversationHistory[i];
    }
  }
  return undefined;
}

function assistantMessageAskedForOrder(messageContent: string): boolean {
  const normalized = normalizeForIntentMatch(messageContent);
  if (!normalized) return false;

  const explicitOrderQuestionPatterns = [
    /\b(a doni ta porosisni|deshironi ta porosisni|deshiron ta porositesh)\b/,
    /\b(doni ta porosisni|doni me porosit|doni me bo porosi)\b/,
    /\b(would you like to order|do you want to order)\b/,
  ];
  if (explicitOrderQuestionPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const hasOrderKeyword = /\b(porosi|porosis|porosit|order)\b/.test(normalized);
  return hasOrderKeyword && messageContent.includes('?');
}

function hasAssistantAskedForOrderInConversation(conversationHistory: Message[]): boolean {
  return conversationHistory.some(
    (msg) =>
      msg.sent_by !== 'customer' &&
      assistantMessageAskedForOrder((msg.content ?? '').trim()),
  );
}

async function isConversationEnding(
  messageContent: string,
  conversationHistory: Message[],
): Promise<boolean> {
  if (looksLikePoliteThanksClosing(messageContent)) {
    return true;
  }

  const lastThree = conversationHistory.slice(-3);
  const formattedLastFew = lastThree
    .map((msg) => {
      const roleLabel = msg.sent_by === 'customer' ? 'Customer' : 'AI';
      return `${roleLabel}: ${(msg.content ?? '').trim()}`;
    })
    .join('\n');

  const userText = `Last few messages of conversation:\n${formattedLastFew || '(none)'}\n\nLatest customer message: ${messageContent}`;

  const completion = await openai.chat.completions.create({
    model: OPENAI_CHAT_MODEL,
    messages: [
      { role: 'system', content: CONVERSATION_ENDING_ANALYST_SYSTEM },
      { role: 'user', content: userText },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 64,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) return false;

  try {
    const parsed = JSON.parse(raw) as { is_ending?: boolean };
    return parsed.is_ending === true;
  } catch {
    return false;
  }
}

export async function generateReply(
  conversationId: string,
  tenantId: string,
  inboundMessage: string,
  attachmentUrlsRaw: unknown = [],
  productCatalogContext?: string,
  precomputedLanguage?: ReplyLocale,
): Promise<{ reply: string; productCatalogContext: string; language: ReplyLocale }> {
  const attachmentUrls = normalizeAttachmentUrls(attachmentUrlsRaw);
  const { visionUrls } = partitionVisionAttachments(attachmentUrls);
  const hasImages = visionUrls.length > 0;
  const [tenant, config, conversationHistoryWindow, cachedCatalogProducts] = await Promise.all([
    loadTenant(tenantId),
    loadAIConfig(tenantId),
    findMessagesByConversation(conversationId, HISTORY_FETCH_LIMIT),
    productCatalogContext ? Promise.resolve([] as Product[]) : loadProductCatalog(tenantId),
  ]);
  const olderHistory =
    conversationHistoryWindow.length > RECENT_RAW_HISTORY_MESSAGES
      ? conversationHistoryWindow.slice(0, -RECENT_RAW_HISTORY_MESSAGES)
      : [];
  const olderHistorySummary = summarizeOlderConversationContext(olderHistory);
  const conversationHistory =
    conversationHistoryWindow.length > RECENT_RAW_HISTORY_MESSAGES
      ? conversationHistoryWindow.slice(-RECENT_RAW_HISTORY_MESSAGES)
      : conversationHistoryWindow;
  const [customerAskedPrice, customerAskedDiscount, detectedLanguage] = await Promise.all([
    customerAskedAboutPrice(inboundMessage),
    customerAskedAboutDiscount(inboundMessage),
    precomputedLanguage
      ? Promise.resolve(precomputedLanguage)
      : detectReplyLanguage(inboundMessage, conversationHistoryWindow),
  ]);
  const language: ReplyLocale = detectedLanguage;

  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  // Silence repeated discount requests: once the AI has already told the customer that no
  // additional discount is available / that the displayed price is final, any further
  // discount-related message from the same customer is ignored (no AI reply at all).
  // Scan the full fetched window (not just the recent 10) so finalization is not forgotten
  // in longer conversations.
  if (
    customerAskedDiscount &&
    assistantAlreadyFinalizedDiscount(conversationHistoryWindow)
  ) {
    console.info(
      `[DISCOUNT_FINALIZED_SILENT] tenantId: ${tenantId} conversationId: ${conversationId} reason: customer keeps asking for a discount after the final price was already communicated`,
    );
    return {
      reply: '[NO_REPLY]',
      productCatalogContext:
        typeof productCatalogContext === 'string' && productCatalogContext.trim().length > 0
          ? productCatalogContext
          : '',
      language,
    };
  }

  let products: Product[] = [];
  let usedFullCatalogFallback = false;

  const searchText = inboundMessage.trim();
  if (searchText) {
    try {
      const queryEmbedding = await generateEmbedding(searchText);
      const similar = await searchProductsBySimilarity(
        tenantId,
        queryEmbedding,
        FOCUSED_PRODUCT_MATCH_LIMIT,
      );
      products = similar.filter((p) => p.similarity >= SIMILARITY_THRESHOLD);
    } catch (err) {
      console.warn('[aiService] Semantic search failed, falling back to keyword search', err);
    }
  }

  if (products.length === 0) {
    const keywords = extractKeywords(searchText);
    if (keywords.length > 0) {
      products = await searchProductsByDisjunctiveTerms(
        tenantId,
        keywords,
        FOCUSED_PRODUCT_MATCH_LIMIT,
      );
    }
  }

  if (products.length === 0) {
    products = cachedCatalogProducts;
    usedFullCatalogFallback = true;
  }

  let visionContext: string | null = null;
  if (hasImages) {
    const extracted = await extractProductInfoFromImages(inboundMessage, attachmentUrls);
    if (extracted) {
      const structuredQuery = [
        extracted.brand_name,
        extracted.product_name,
        extracted.product_type,
        extracted.flavor,
        extracted.size,
      ]
        .filter(Boolean)
        .join(' ');

      let extractedMatches: Product[] = [];
      if (structuredQuery) {
        extractedMatches = await searchProducts(tenantId, structuredQuery, FOCUSED_PRODUCT_MATCH_LIMIT);
      }

      const normalizedBrand = extracted.brand_name?.trim().toLowerCase() ?? null;
      const exactBrandMatches = normalizedBrand
        ? extractedMatches.filter((product) =>
            (getProductBrand(product) ?? '').toLowerCase() === normalizedBrand,
          )
        : [];
      const likelyNonMatchByBrand = extracted.brand_name
        ? !isBrandLikelyInCatalog(extracted.brand_name, cachedCatalogProducts)
        : false;

      if (exactBrandMatches.length > 0) {
        products = exactBrandMatches;
        usedFullCatalogFallback = false;
      } else if (extractedMatches.length > 0) {
        products = extractedMatches;
        usedFullCatalogFallback = false;
      }

      visionContext = [
        'Step 1 extraction JSON:',
        JSON.stringify(extracted),
        '',
        'Step 2 catalog checks:',
        `- Exact brand matches found: ${exactBrandMatches.length}`,
        `- Similar matches found: ${extractedMatches.length}`,
        `- Brand likely absent from catalog: ${likelyNonMatchByBrand ? 'yes' : 'no'}`,
        '',
        'Interpretation rule: if brand likely absent or only different-brand results exist, do not claim exact availability.',
      ].join('\n');
    }
  }

  const resolvedProductCatalogContext =
    typeof productCatalogContext === 'string' && productCatalogContext.trim().length > 0
      ? productCatalogContext
      : formatProductCatalog(products, {
          includePrice: customerAskedPrice || customerAskedDiscount,
          includeDiscount: customerAskedDiscount,
        });

  const primaryFocusedProduct = products[0];
  const referencedOosProduct =
    searchText.length > 0
      ? products.find(
          (p) => p.in_stock === false && inboundTextLikelyReferencesProduct(searchText, p),
        )
      : undefined;
  const primaryOosForCanned =
    referencedOosProduct ??
    (primaryFocusedProduct && primaryFocusedProduct.in_stock === false ? primaryFocusedProduct : null);

  const allFocusedOutOfStock =
    products.length > 0 && products.every((p) => p.in_stock === false);
  const singleFocusedMatch = products.length === 1;
  const multiMatchOosOk =
    singleFocusedMatch ||
    allFocusedOutOfStock ||
    referencedOosProduct !== undefined ||
    (searchText.length > 0 &&
      primaryFocusedProduct &&
      inboundTextLikelyReferencesProduct(searchText, primaryFocusedProduct)) ||
    (searchText.length === 0 &&
      hasImages &&
      (singleFocusedMatch || allFocusedOutOfStock));

  const shouldReturnOutOfStockCanned =
    typeof productCatalogContext !== 'string' &&
    !usedFullCatalogFallback &&
    products.length > 0 &&
    primaryOosForCanned &&
    multiMatchOosOk &&
    !looksLikeSimpleGreetingOrClosing(inboundMessage) &&
    (searchText.length > 0 || hasImages);

  if (shouldReturnOutOfStockCanned) {
    return {
      reply: getOutOfStockProductReply(language),
      productCatalogContext: resolvedProductCatalogContext,
      language,
    };
  }

  await ensureTenantPromptBlocksSeeded(tenantId);
  const tenantPromptBlocks = await loadTenantPromptBlocksCached(tenantId);
  const assembledGuidelines = assembleGuidelinesFromBlocks(tenantPromptBlocks, { language }, { hasImages });

  let systemPrompt = buildRetailAISystemPrompt(
    tenant.name,
    config,
    resolvedProductCatalogContext,
    assembledGuidelines,
    tenant.niche,
    tenant.description,
  );

  if (inboundNeedsSharedContentInstruction(inboundMessage)) {
    systemPrompt += SHARED_CONTENT_SYSTEM_APPEND;
    if (inboundTextIsPostShare(inboundMessage)) {
      systemPrompt += SHARED_POST_VISION_APPEND;
    }
  }

  const systemPromptTokenEstimate = estimateTokens(systemPrompt);
  const inboundTokenEstimate = estimateTokens(inboundMessage.trim());
  const olderHistorySummaryTokens = estimateTokens(olderHistorySummary ?? '');
  const historyMessageTokenEstimates = conversationHistory.map((msg) =>
    estimateTokens(
      msg.sent_by === 'customer'
        ? formatCustomerMessageContentForPrompt(msg)
        : (msg.content ?? '').trim(),
    ),
  );

  const originalHistoryCount = conversationHistory.length;
  let historyForPrompt = conversationHistory;
  let historyTokenTotal =
    historyMessageTokenEstimates.reduce((sum, t) => sum + t, 0) + olderHistorySummaryTokens;

  while (historyTokenTotal > CONTEXT_MAX_HISTORY_TOKENS && historyForPrompt.length > 3) {
    const [removed, ...rest] = historyForPrompt;
    historyForPrompt = rest;
    historyTokenTotal -= estimateTokens((removed.content ?? '').trim());
  }

  if (historyForPrompt.length !== originalHistoryCount) {
    console.warn(
      '[aiService] Conversation history truncated for context length protection',
      JSON.stringify({
        tenantId,
        conversationId,
        olderSummaryIncluded: Boolean(olderHistorySummary),
        olderSummarizedMessageCount: olderHistory.length,
        originalMessageCount: originalHistoryCount,
        truncatedMessageCount: historyForPrompt.length,
        estimatedTokenCount: historyTokenTotal,
      }),
    );
  }

  let conversationEnding = false;
  try {
    conversationEnding = await isConversationEnding(
      inboundMessage.trim(),
      historyForPrompt,
    );
  } catch {
    conversationEnding = false;
  }

  if (conversationEnding && !inboundMessage.includes('?')) {
    const closingFlavor = classifyClosingFlavor(inboundMessage);
    const closingSentencesForLocale = getClosingReplySentences(language);
    const closingSentence =
      closingFlavor === 'no_thanks'
        ? closingSentencesForLocale.no_thanks
        : closingSentencesForLocale.greeting;

    const previousAssistant = getPreviousAssistantMessageBeforeLatestCustomer(historyForPrompt);
    const previousAssistantText = (previousAssistant?.content ?? '').trim();
    // Suppress a repeat closing in any locale: detect prior bot closings across both languages.
    const allKnownClosingReplies = new Set([
      ...Object.values(CLOSING_REPLY_SENTENCES.sq),
      ...Object.values(CLOSING_REPLY_SENTENCES.en),
    ]);

    if (previousAssistantText && allKnownClosingReplies.has(previousAssistantText)) {
      return {
        reply: '[NO_REPLY]',
        productCatalogContext: resolvedProductCatalogContext,
        language,
      };
    }

    const closingAppend = CLOSING_REPLY_SYSTEM_APPEND_TEMPLATE_BY_LOCALE[language].replace(
      '__CLOSING_SENTENCE__',
      closingSentence,
    );
    systemPrompt += `\n\n${closingAppend}`;
  }

  // Story mention/reply preview URLs are stored on the inbound message as `attachment_urls` (same as
  // other images). `buildMessagesArray` turns any non-empty `attachmentUrls` into vision `image_url`
  // parts next to the user text (Step 16 path).
  const messages = buildMessagesArray(
    systemPrompt,
    historyForPrompt,
    inboundMessage,
    attachmentUrls,
    visionContext,
    olderHistorySummary,
  );

  const model = hasImages
    ? OPENAI_VISION_MODEL
    : (config.custom_model_id || process.env.OPENAI_CHAT_MODEL?.trim() || 'gpt-4o');

  const completion = await openai.chat.completions.create({
    model,
    messages: messages as Parameters<typeof openai.chat.completions.create>[0]['messages'],
    temperature: 0.7,
    // Cap length to discourage rambling; still enough for verbatim usage text and required fixed phrases.
    max_tokens: 768,
  });

  const reply = completion.choices[0]?.message?.content;
  if (!reply) {
    throw new Error('OpenAI returned an empty response');
  }

  return {
    reply: normalizeProductMentionsForReply(reply.trim(), resolvedProductCatalogContext),
    productCatalogContext: resolvedProductCatalogContext,
    language,
  };
}
