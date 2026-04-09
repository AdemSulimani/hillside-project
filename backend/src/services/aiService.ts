import { groq, GROQ_MODEL } from './groqClient';
import { findTenantById } from '../db/models/tenant';
import { findMessagesByConversation, type Message } from '../db/models/message';
import { searchProducts, type Product } from '../db/models/product';
import pool from '../db/pool';

interface AIConfig {
  tone: string;
  restrictions: string | null;
  sales_strategy: string;
  qa_pairs: { question: string; answer: string }[];
}

const DEFAULT_AI_CONFIG: AIConfig = {
  tone: 'friendly and professional',
  restrictions: null,
  sales_strategy: 'Be helpful, answer questions accurately, and gently guide towards a purchase when appropriate.',
  qa_pairs: [],
};

async function loadAIConfig(tenantId: string): Promise<AIConfig> {
  try {
    const { rows } = await pool.query<AIConfig>(
      'SELECT tone, restrictions, sales_strategy, qa_pairs FROM ai_configs WHERE tenant_id = $1 LIMIT 1',
      [tenantId],
    );
    if (rows[0]) return rows[0];
  } catch {
    // ai_configs table doesn't exist yet (created in Step 12) — use defaults
  }

  return DEFAULT_AI_CONFIG;
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
  config: AIConfig,
  products: Product[],
): string {
  const lines: string[] = [
    `You are the AI sales assistant for "${businessName}".`,
    `Your tone should be: ${config.tone}.`,
    '',
    `Sales strategy: ${config.sales_strategy}`,
  ];

  if (config.restrictions) {
    lines.push('', `RESTRICTIONS — you MUST follow these rules: ${config.restrictions}`);
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
  );

  return lines.join('\n');
}

function buildMessagesArray(
  systemPrompt: string,
  conversationHistory: Message[],
  inboundMessage: string,
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: systemPrompt },
  ];

  for (const msg of conversationHistory) {
    if (!msg.content) continue;

    const role: 'user' | 'assistant' =
      msg.sent_by === 'customer' ? 'user' : 'assistant';

    messages.push({ role, content: msg.content });
  }

  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== inboundMessage) {
    messages.push({ role: 'user', content: inboundMessage });
  }

  return messages;
}

export async function generateReply(
  conversationId: string,
  tenantId: string,
  inboundMessage: string,
): Promise<string> {
  const [tenant, config, conversationHistory] = await Promise.all([
    findTenantById(tenantId),
    loadAIConfig(tenantId),
    findMessagesByConversation(conversationId, 10),
  ]);

  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  const keywords = extractKeywords(inboundMessage);
  let products: Product[] = [];
  if (keywords.length > 0) {
    const searchQuery = keywords.slice(0, 5).join(' ');
    products = await searchProducts(tenantId, searchQuery, 5);
  }

  if (products.length === 0) {
    products = await searchProducts(tenantId, '', 5);
  }

  const systemPrompt = buildSystemPrompt(tenant.name, config, products);
  const messages = buildMessagesArray(systemPrompt, conversationHistory, inboundMessage);

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 1024,
  });

  const reply = completion.choices[0]?.message?.content;
  if (!reply) {
    throw new Error('Groq returned an empty response');
  }

  return reply.trim();
}
