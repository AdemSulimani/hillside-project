import { openai, OPENAI_CHAT_MODEL, OPENAI_VISION_MODEL } from './openaiClient';
import { findTenantById } from '../db/models/tenant';
import { findMessagesByConversation, type Message } from '../db/models/message';
import { searchProducts, searchProductsBySimilarity, type Product } from '../db/models/product';
import { findAIConfigByTenant, type AIConfig } from '../db/models/aiConfig';
import { permanentUrlToFilePath, fileToBase64DataUrl } from './attachmentStorageService';
import { generateEmbedding } from './embeddingService';
import { redisConnection } from '../jobs/redisConnection';

const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD || '0.75');

const CONTEXT_MAX_HISTORY_TOKENS = (() => {
  const raw = process.env.CONTEXT_MAX_HISTORY_TOKENS;
  if (raw === undefined || raw.trim() === '') return 6000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 6000;
})();

/** Rough GPT token estimate: ~4 characters per token. */
function estimateTokens(text: string): number {
  return text.length / 4;
}

/** Matches normalized inbound text from webhookNormalizer (Feature 22). */
const SHARED_CONTENT_SYSTEM_APPEND =
  '\n\nThe customer has shared content with you. Use the context provided to respond appropriately and relate it to available products where relevant.';

const SHARED_POST_VISION_APPEND =
  ' For Instagram post shares, rely primarily on the attached preview image(s); any caption excerpt in the message may be shortened.';

function inboundTextIsPostShare(content: string): boolean {
  return content.trimStart().startsWith('Customer shared a post:');
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
  'tone' | 'personality_description' | 'restrictions' | 'sales_strategy' | 'objection_handling' | 'qa_pairs' | 'is_active' | 'custom_model_id'
> = {
  tone: 'friendly and professional',
  personality_description: null,
  restrictions: [],
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
      return JSON.parse(cached) as AIConfig | typeof DEFAULT_AI_CONFIG;
    } catch {
      await redisConnection.del(cacheKey);
    }
  }

  const config = await findAIConfigByTenant(tenantId);
  const resolved = config ?? DEFAULT_AI_CONFIG;
  await redisConnection.set(cacheKey, JSON.stringify(resolved), 'EX', 300);
  return resolved;
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
    await redisConnection.set(cacheKey, JSON.stringify(tenant), 'EX', 300);
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

function extractKeywords(text: string): string[] {
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

function formatProductCatalog(products: Product[]): string {
  if (products.length === 0) return 'No matching products found in the catalog.';

  return products
    .map((p) => {
      const typeText = p.tags.length > 0 ? p.tags.join(', ') : 'N/A';
      const parts = [
        `- Brand: ${getProductBrand(p) ?? 'Unknown'}, Product: ${p.name}, Type: ${typeText}`,
        `  Price: $${Number(p.price).toFixed(2)}`,
      ];
      if (p.description) parts.push(`  ${p.description}`);
      if (p.usage_description) {
        parts.push('  Usage description:');
        parts.push(`  ${p.usage_description}`);
      }
      if (p.category) parts.push(`  Category: ${p.category}`);
      if (p.tags.length > 0) parts.push(`  Tags: ${p.tags.join(', ')}`);
      if (p.stock_quantity !== null) parts.push(`  In stock: ${p.stock_quantity}`);
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

function buildSystemPrompt(
  businessName: string,
  config: typeof DEFAULT_AI_CONFIG,
  productCatalogContext: string,
  hasImages: boolean,
): string {
  const lines: string[] = [
    `You are the AI sales assistant for "${businessName}".`,
    `Your tone should be: ${config.tone}.`,
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

  if (config.restrictions.length > 0) {
    lines.push(
      '',
      `RESTRICTIONS — you MUST follow these rules:\n${config.restrictions.map((r) => `- ${r}`).join('\n')}`,
    );
  }

  lines.push('', 'Product catalog:', productCatalogContext);

  const qa = formatQAPairs(config.qa_pairs);
  if (qa) lines.push(qa);

  lines.push(
    '',
    'Guidelines:',
    '- Keep replies concise and conversational — this is a chat, not an email.',
    '- If the customer asks about a product you don\'t have, say so honestly.',
    '- Never fabricate product details, prices, or availability.',
    '- If a question is outside your scope, politely let the customer know a human agent can help.',
    '- Do not use markdown formatting — reply in plain text suitable for a messaging app.',
    '- If the customer sends an image, describe what you see and relate it to the available product catalog.',
    '- When a customer asks how to use a product, how to take it, dosage, application instructions, or anything related to product usage, you must return the usage description for that product EXACTLY as written, word for word, without modifying, summarizing, paraphrasing, or adding anything to it. Do not change a single word. If the usage description answers the customer\'s question, return it verbatim and nothing else.',
  );

  if (hasImages) {
    lines.push(
      '',
      'When a customer sends an image of a product, you must follow this exact process in order:',
      'Step 1 - Identify the product in the image as specifically as possible. Extract: the brand name, product name, flavor or variant, size or weight, and any other distinguishing details visible on the packaging.',
      'Step 2 - Search the provided product catalog for an exact or near-exact match. A match is only valid if the brand name AND product type match. A different brand of the same product type is NOT a match.',
      'Step 3 - Apply one of these three responses only:',
      'Response A - Exact match found: You have that exact product or a version of it from the same brand. Confirm availability with the price and details from your catalog.',
      'Response B - Similar product, different brand: You have a similar product but a different brand. Be honest - say you do not carry that exact brand but offer your alternative. Example: "We do not carry [Brand X] specifically, but we do have [Your Brand] which is a similar mass gainer - would you like details on that?"',
      'Response C - No match at all: You do not have anything similar. Tell the customer honestly and ask if they are looking for something specific you might be able to help with.',
      'Never confirm you have a product just because the product category matches. Brand accuracy matters.',
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

    let confidence = 0;
    const confRaw = parsed.confidence;
    if (typeof confRaw === 'number' && Number.isFinite(confRaw)) {
      confidence = confRaw > 1 ? confRaw / 100 : confRaw;
    }
    confidence = Math.min(1, Math.max(0, confidence));

    return {
      is_cancellation: parsed.is_cancellation === true,
      is_refund: parsed.is_refund === true,
      reason: reasonRaw && reasonRaw.length > 0 ? reasonRaw : null,
      confidence,
    };
  } catch {
    return { is_cancellation: false, is_refund: false, reason: null, confidence: 0 };
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

function formatCustomerMessageContentForPrompt(msg: Message): string {
  const body = (msg.content ?? '').trim();
  const snap = msg.reply_to_content?.trim();
  if (msg.sent_by === 'customer' && snap) {
    return `Customer replied to: '${snap}' — saying: '${body}'`;
  }
  return body;
}

function buildMessagesArray(
  systemPrompt: string,
  conversationHistory: Message[],
  inboundMessage: string,
  attachmentUrls: string[] = [],
  visionContext: string | null = null,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  for (const msg of conversationHistory) {
    const histUrls = normalizeAttachmentUrls(msg.attachment_urls);
    const role: 'user' | 'assistant' =
      msg.sent_by === 'customer' ? 'user' : 'assistant';
    const textContent =
      role === 'user' ? formatCustomerMessageContentForPrompt(msg) : (msg.content ?? '').trim();
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
      ? formatCustomerMessageContentForPrompt(lastCustomerInHistory).trim()
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

async function isConversationEnding(
  messageContent: string,
  conversationHistory: Message[],
): Promise<boolean> {
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
): Promise<{ reply: string; productCatalogContext: string }> {
  const attachmentUrls = normalizeAttachmentUrls(attachmentUrlsRaw);
  const { visionUrls } = partitionVisionAttachments(attachmentUrls);
  const hasImages = visionUrls.length > 0;
  const [tenant, config, conversationHistory, cachedCatalogProducts] = await Promise.all([
    loadTenant(tenantId),
    loadAIConfig(tenantId),
    findMessagesByConversation(conversationId, 10),
    loadProductCatalog(tenantId),
  ]);

  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  let products: Product[] = [];

  const searchText = inboundMessage.trim();
  if (searchText) {
    try {
      const queryEmbedding = await generateEmbedding(searchText);
      const similar = await searchProductsBySimilarity(tenantId, queryEmbedding, 5);
      products = similar.filter((p) => p.similarity >= SIMILARITY_THRESHOLD);
    } catch (err) {
      console.warn('[aiService] Semantic search failed, falling back to keyword search', err);
    }
  }

  if (products.length === 0) {
    const keywords = extractKeywords(searchText);
    if (keywords.length > 0) {
      const searchQuery = keywords.slice(0, 5).join(' ');
      products = await searchProducts(tenantId, searchQuery, 5);
    }
  }

  if (products.length === 0) {
    products = cachedCatalogProducts;
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
        extractedMatches = await searchProducts(tenantId, structuredQuery, 8);
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
      } else if (extractedMatches.length > 0) {
        products = extractedMatches;
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

  const productCatalogContext = formatProductCatalog(products);
  let systemPrompt = buildSystemPrompt(tenant.name, config, productCatalogContext, hasImages);

  if (inboundNeedsSharedContentInstruction(inboundMessage)) {
    systemPrompt += SHARED_CONTENT_SYSTEM_APPEND;
    if (inboundTextIsPostShare(inboundMessage)) {
      systemPrompt += SHARED_POST_VISION_APPEND;
    }
  }

  const systemPromptTokenEstimate = estimateTokens(systemPrompt);
  const inboundTokenEstimate = estimateTokens(inboundMessage.trim());
  const historyMessageTokenEstimates = conversationHistory.map((msg) =>
    estimateTokens(
      msg.sent_by === 'customer'
        ? formatCustomerMessageContentForPrompt(msg)
        : (msg.content ?? '').trim(),
    ),
  );

  const originalHistoryCount = conversationHistory.length;
  let historyForPrompt = conversationHistory;
  let historyTokenTotal = historyMessageTokenEstimates.reduce((sum, t) => sum + t, 0);

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
    return { reply: '[NO_REPLY]', productCatalogContext };
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
  );

  const model = hasImages
    ? OPENAI_VISION_MODEL
    : (config.custom_model_id || process.env.OPENAI_CHAT_MODEL?.trim() || 'gpt-4o');

  const completion = await openai.chat.completions.create({
    model,
    messages: messages as Parameters<typeof openai.chat.completions.create>[0]['messages'],
    temperature: 0.7,
    max_tokens: 1024,
  });

  const reply = completion.choices[0]?.message?.content;
  if (!reply) {
    throw new Error('OpenAI returned an empty response');
  }

  return { reply: reply.trim(), productCatalogContext };
}
