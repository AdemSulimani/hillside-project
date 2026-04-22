import { openai, OPENAI_CHAT_MODEL, OPENAI_VISION_MODEL } from './openaiClient';
import { findTenantById } from '../db/models/tenant';
import { findMessagesByConversation, type Message } from '../db/models/message';
import { searchProducts, searchProductsBySimilarity, type Product } from '../db/models/product';
import { findAIConfigByTenant, type AIConfig } from '../db/models/aiConfig';
import { permanentUrlToFilePath, fileToBase64DataUrl } from './attachmentStorageService';
import { generateEmbedding } from './embeddingService';

const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD || '0.75');

/** Matches normalized inbound text from webhookNormalizer (Feature 22). */
const SHARED_CONTENT_SYSTEM_APPEND =
  '\n\nThe customer has shared content with you. Use the context provided to respond appropriately and relate it to available products where relevant.';

function inboundTextIsPostShare(content: string): boolean {
  return content.trimStart().startsWith('Customer shared a post:');
}

function inboundTextIsStoryMentionOrReply(content: string): boolean {
  const t = content;
  return (
    t.includes('Customer mentioned you in their story') || t.includes('Customer replied to your story')
  );
}

/** Post shares and story threads get the extra catalog-alignment instruction (not reel/product-only lines). */
function inboundNeedsSharedContentInstruction(content: string): boolean {
  return inboundTextIsPostShare(content) || inboundTextIsStoryMentionOrReply(content);
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
  const config = await findAIConfigByTenant(tenantId);
  return config ?? DEFAULT_AI_CONFIG;
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
      const parts = [`- ${p.name}: $${Number(p.price).toFixed(2)}`];
      if (p.description) parts.push(`  ${p.description}`);
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
  products: Product[],
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

  lines.push('', 'Product catalog:', formatProductCatalog(products));

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
  );

  return lines.join('\n');
}

type ChatMessageContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: ChatMessageContent };

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

function buildMessagesArray(
  systemPrompt: string,
  conversationHistory: Message[],
  inboundMessage: string,
  attachmentUrls: string[] = [],
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  for (const msg of conversationHistory) {
    const histUrls = normalizeAttachmentUrls(msg.attachment_urls);
    if (!msg.content?.trim() && histUrls.length === 0) continue;

    const role: 'user' | 'assistant' =
      msg.sent_by === 'customer' ? 'user' : 'assistant';

    messages.push({ role, content: (msg.content ?? '').trim() });
  }

  const lastMsg = messages[messages.length - 1];
  const lastUserText =
    typeof lastMsg?.content === 'string' ? lastMsg.content.trim() : '';
  const inboundTrimmed = inboundMessage.trim();
  const alreadyAppended =
    lastMsg?.role === 'user' &&
    (lastUserText === inboundTrimmed ||
      (inboundTrimmed === '' && lastUserText === ''));

  if (attachmentUrls.length > 0) {
    const imageUrls = resolveImageUrls(attachmentUrls);
    const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      { type: 'text', text: inboundTrimmed || 'The customer sent an image.' },
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

export async function generateReply(
  conversationId: string,
  tenantId: string,
  inboundMessage: string,
  attachmentUrlsRaw: unknown = [],
): Promise<string> {
  const attachmentUrls = normalizeAttachmentUrls(attachmentUrlsRaw);

  const [tenant, config, conversationHistory] = await Promise.all([
    findTenantById(tenantId),
    loadAIConfig(tenantId),
    findMessagesByConversation(conversationId, 10),
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
    products = await searchProducts(tenantId, '', 5);
  }

  const hasImages = attachmentUrls.length > 0;
  let systemPrompt = buildSystemPrompt(tenant.name, config, products);

  if (inboundNeedsSharedContentInstruction(inboundMessage)) {
    systemPrompt += SHARED_CONTENT_SYSTEM_APPEND;
  }

  // Story mention/reply preview URLs are stored on the inbound message as `attachment_urls` (same as
  // other images). `buildMessagesArray` turns any non-empty `attachmentUrls` into vision `image_url`
  // parts next to the user text (Step 16 path).
  const messages = buildMessagesArray(systemPrompt, conversationHistory, inboundMessage, attachmentUrls);

  const model = hasImages
    ? OPENAI_VISION_MODEL
    : (config.custom_model_id || OPENAI_CHAT_MODEL);

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

  return reply.trim();
}
