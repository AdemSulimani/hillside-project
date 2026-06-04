import type { Message } from '../db/models/message';
import {
  findVariantSiblingProducts,
  searchProducts,
  type Product,
} from '../db/models/product';

export interface AttributeQueryIntentHint {
  is_attribute_question?: boolean;
  attributes?: StructuredAttributeKey[];
}

/** Max products retrieved when the customer is browsing or asking about a product group. */
export const CATEGORY_GROUP_MATCH_LIMIT = 25;

export type ProductQueryScope = 'specific_product' | 'category_or_group' | 'attribute_followup';

export type ProductMatchFn = (
  tenantId: string,
  searchText: string,
  limit: number,
) => Promise<Product[]>;

export type StructuredAttributeKey =
  | 'flavor'
  | 'size'
  | 'color'
  | 'variant'
  | 'weight'
  | 'brand'
  | 'category';

export const ALL_STRUCTURED_ATTRIBUTE_KEYS: StructuredAttributeKey[] = [
  'flavor',
  'size',
  'color',
  'variant',
  'weight',
  'brand',
  'category',
];

const ATTRIBUTE_FOLLOW_UP_PATTERNS: RegExp[] = [
  /\b(what|which|cfare|çfarë|cfare)\s+(flavou?rs?|tastes?|shije(?:t|sh)?)\b/i,
  /\b(what|which|cfare|çfarë|cfare)\s+(sizes?|madh[eë]si(?:t|ve)?)\b/i,
  /\b(what|which|cfare|çfarë|cfare)\s+(colors?|colours?|ngjyra(?:t|ve)?)\b/i,
  /\b(what|which|cfare|çfarë|cfare)\s+(variants?|variantet?)\b/i,
  /\b(what|which|cfare|çfarë|cfare)\s+(brands?|marka(?:t|ve)?)\b/i,
  /\b(what|which|cfare|çfarë|cfare)\s+(weights?|pesha(?:t|ve)?)\b/i,
  /\b(what|which|cfare|çfarë|cfare)\s+(types?|lloje(?:t|ve)?|product types?)\b/i,
  /\b(what|which|cfare|çfarë|cfare)\s+(options?|opsione(?:t|ve)?)\b/i,
  /\b(cilat|cila|sa)\s+(shije(?:t|sh)?|madh[eë]si(?:t|ve)?|ngjyra(?:t|ve)?|variantet?|marka(?:t|ve)?)\b/i,
  /\b(do you have|a keni|keni)\s+(other|tjet[eë]r|different|ndryshme)\s+(flavou?rs?|sizes?|colors?|variants?)\b/i,
  /\b(tell me|show me|list)\s+(the\s+)?(flavou?rs?|sizes?|colors?|variants?|options?)\b/i,
  /^(flavou?rs?|sizes?|colors?|variants?|brands?|shije(?:t|sh)?|madh[eë]si(?:t|ve)?|ngjyra(?:t|ve)?)(\s*[.!?]*)?$/i,
];

const CONTEXT_ONLY_FOLLOW_UP_PATTERNS: RegExp[] = [
  /^(sa\s+)?(kushton|kushtojne|kushtojnë|cmimi|cmim|çmimi|çmim|qmimi|price|cost)(\s*[.!?]*)?$/i,
  /^(tell me more|more about (it|this)|about (it|this)|this one|that one)(\s*[.!?]*)?$/,
  /^(me shum|më shumë|per te|për të|rreth tij|rreth kesaj)(\s*[.!?]*)?$/,
];

function normalizeMessageText(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s?!.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether the customer is asking about an attribute across a product group (e.g. "What flavors?"). */
export function isCategoryAttributeFollowUp(message: string, maxLength = 250): boolean {
  const t = normalizeMessageText(message);
  if (!t || t.length > maxLength) return false;
  return ATTRIBUTE_FOLLOW_UP_PATTERNS.some((re) => re.test(t));
}

function isContextOnlyFollowUp(message: string): boolean {
  const t = normalizeMessageText(message);
  if (!t || t.length > 100) return false;
  return CONTEXT_ONLY_FOLLOW_UP_PATTERNS.some((re) => re.test(t));
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'can', 'may', 'might', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
    'and', 'but', 'or', 'not', 'no', 'so', 'if', 'then', 'than', 'too',
    'that', 'this', 'what', 'which', 'who', 'when', 'where', 'how',
    'all', 'each', 'any', 'both', 'few', 'more', 'most', 'some',
    'dhe', 'nje', 'një', 'per', 'për', 'nga', 'me', 'ne', 'eshte', 'është',
    'dua', 'cfare', 'çfarë', 'keni', 'a', 'keni', 'produkt', 'produkte',
  ]);

  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

/**
 * Pull the most recent substantive product query from the conversation so short
 * follow-ups like "What flavors?" can re-resolve the full matching product set.
 */
export function extractConversationProductAnchor(messages: Message[]): string | null {
  const recent = messages.slice(-10);

  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    if (msg.sent_by !== 'customer') continue;
    const text = (msg.content ?? '').trim();
    if (!text || text.length < 3) continue;
    if (isCategoryAttributeFollowUp(text) || isContextOnlyFollowUp(text)) continue;
    const keywords = extractKeywords(text);
    if (keywords.length > 0) return text;
  }

  const assistantTexts = recent
    .filter((m) => m.sent_by === 'ai')
    .slice(-3)
    .map((m) => (m.content ?? '').trim())
    .filter((t) => t.length > 0);

  if (assistantTexts.length > 0) {
    return assistantTexts.join('\n');
  }

  return null;
}

function dedupeProducts(products: Product[]): Product[] {
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const p of products) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/**
 * When several products already match, expand using anchor keywords from the
 * prior conversation turn (e.g. "creatine" from "Do you have creatine?").
 */
async function expandProductGroupMatches(
  tenantId: string,
  products: Product[],
  anchorText: string | null,
  limit: number,
): Promise<Product[]> {
  if (products.length === 0) return products;

  const expanded = [...products];

  if (anchorText) {
    const keywords = extractKeywords(anchorText).slice(0, 4);
    for (const kw of keywords) {
      if (kw.length < 4) continue;
      expanded.push(...(await searchProducts(tenantId, kw, limit)));
    }
  }

  return dedupeProducts(expanded).slice(0, limit);
}

/**
 * Resolve products for context-dependent follow-ups by anchoring on the prior
 * product/category discussion instead of the short follow-up text alone.
 */
export async function resolveProductsForContextualQuery(
  tenantId: string,
  inboundMessage: string,
  conversationHistory: Message[],
  matchProducts: ProductMatchFn,
  limit: number,
): Promise<Product[]> {
  const anchor = extractConversationProductAnchor(conversationHistory);
  const needsAnchor =
    isCategoryAttributeFollowUp(inboundMessage) || isContextOnlyFollowUp(inboundMessage);

  if (needsAnchor && anchor) {
    const fromAnchor = await matchProducts(tenantId, anchor, limit);
    if (fromAnchor.length > 0) {
      return expandProductGroupMatches(tenantId, fromAnchor, anchor, limit);
    }
  }

  if (needsAnchor) {
    const assistantTexts = conversationHistory
      .filter((m) => m.sent_by === 'ai')
      .slice(-4)
      .map((m) => (m.content ?? '').trim())
      .filter((t) => t.length > 0);

    if (assistantTexts.length > 0) {
      const combined = assistantTexts.join('\n');
      const fromHistory = await matchProducts(tenantId, combined, limit);
      if (fromHistory.length > 0) {
        return expandProductGroupMatches(tenantId, fromHistory, anchor, limit);
      }
    }
  }

  return [];
}

export function inboundTextLikelyReferencesProduct(
  inboundText: string,
  product: Product,
): boolean {
  const raw = inboundText.trim();
  if (!raw) return false;

  const fold = (value: string) =>
    value
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const hay = fold(raw);
  const name = fold(product.name ?? '');
  if (name.length >= 3 && hay.includes(name)) return true;

  const brand = product.brand?.trim();
  if (brand && brand.length >= 2) {
    const brandFold = fold(brand);
    const nameTokens = name.split(/\s+/).filter((w) => w.length >= 4);
    if (brandFold.length >= 2 && hay.includes(brandFold) && nameTokens.some((w) => hay.includes(w))) {
      return true;
    }
  }

  return false;
}

export function detectProductQueryScope(
  message: string,
  products: Product[],
  attributeIntent?: AttributeQueryIntentHint,
): ProductQueryScope {
  if (
    isCategoryAttributeFollowUp(message) ||
    isContextOnlyFollowUp(message) ||
    attributeIntent?.is_attribute_question
  ) {
    return 'attribute_followup';
  }

  if (products.length <= 1) return 'specific_product';

  const referenced = products.filter((p) => inboundTextLikelyReferencesProduct(message, p));
  if (referenced.length === 1) return 'specific_product';

  return 'category_or_group';
}

export function getProductStructuredAttributes(
  product: Product,
): Partial<Record<StructuredAttributeKey, string | null>> {
  return {
    flavor: product.flavor?.trim() || null,
    size: product.size?.trim() || null,
    color: product.color?.trim() || null,
    variant: product.variant?.trim() || null,
    weight: product.weight?.trim() || null,
    brand: product.brand?.trim() || null,
    category: product.category?.trim() || null,
  };
}

const NAME_ATTRIBUTE_PATTERNS: Array<{ key: StructuredAttributeKey; re: RegExp }> = [
  {
    key: 'flavor',
    re: /\b(chocolate|vanilla|strawberry|berry|unflavored|unflavoured|banana|cookies?\s*&?\s*cream|mango|lemon|orange|mint|caramel|coffee|neutral|cookies? and cream)\b/i,
  },
  { key: 'color', re: /\b(red|blue|black|white|green|yellow|pink|purple|grey|gray|silver|gold)\b/i },
  { key: 'size', re: /\b(\d+(?:\.\d+)?\s*(?:g|kg|ml|l|oz|lb|lbs|capsules?|caps|tablets?|servings?))\b/i },
  { key: 'weight', re: /\b(\d+(?:\.\d+)?\s*(?:g|kg|oz|lb|lbs))\b/i },
];

function inferAttributeFromText(
  key: StructuredAttributeKey,
  product: Product,
): string | null {
  const structured = getProductStructuredAttributes(product)[key];
  if (structured) return structured;

  const hay = [
    product.name,
    product.description ?? '',
    product.extracted_text ?? '',
    product.tags.join(' '),
  ].join(' ');

  if (key === 'brand' && product.brand) return product.brand.trim();
  if (key === 'category' && product.category) return product.category.trim();

  for (const { key: patternKey, re } of NAME_ATTRIBUTE_PATTERNS) {
    if (patternKey !== key) continue;
    const match = hay.match(re);
    if (match?.[1]) return match[1].trim();
  }

  return null;
}

function attributeLabel(key: StructuredAttributeKey): string {
  const labels: Record<StructuredAttributeKey, string> = {
    flavor: 'Flavors',
    size: 'Sizes',
    color: 'Colors',
    variant: 'Variants',
    weight: 'Weights',
    brand: 'Brands',
    category: 'Categories / product types',
  };
  return labels[key];
}

export function detectRequestedAttributes(
  message: string,
  intentAttributes?: StructuredAttributeKey[],
): StructuredAttributeKey[] {
  const t = normalizeMessageText(message);
  const requested = new Set<StructuredAttributeKey>();

  if (intentAttributes?.length) {
    for (const attr of intentAttributes) {
      if (ALL_STRUCTURED_ATTRIBUTE_KEYS.includes(attr)) requested.add(attr);
    }
  }

  if (/\b(flavou?r|taste|shije)\b/.test(t)) requested.add('flavor');
  if (/\b(size|madh[eë]si)\b/.test(t)) requested.add('size');
  if (/\b(color|colour|ngjyr)\b/.test(t)) requested.add('color');
  if (/\b(variant)\b/.test(t)) requested.add('variant');
  if (/\b(weight|pesha)\b/.test(t)) requested.add('weight');
  if (/\b(brand|marka)\b/.test(t)) requested.add('brand');
  if (/\b(type|lloj|product type|categor)\b/.test(t)) requested.add('category');

  if (requested.size === 0 && isCategoryAttributeFollowUp(message)) {
    return ALL_STRUCTURED_ATTRIBUTE_KEYS;
  }

  return [...requested];
}

/**
 * When an attribute question resolves to a single SKU, expand to variant siblings
 * so aggregation and answers cover all flavors/sizes in the product family.
 */
export async function expandProductsForAttributeQuery(
  tenantId: string,
  products: Product[],
  attributeIntent?: AttributeQueryIntentHint,
  limit = CATEGORY_GROUP_MATCH_LIMIT,
): Promise<Product[]> {
  if (!attributeIntent?.is_attribute_question) return products;
  if (products.length === 0) return products;
  if (products.length > 1) return dedupeProducts(products).slice(0, limit);

  const siblings = await findVariantSiblingProducts(tenantId, products[0], limit - 1);
  return dedupeProducts([...products, ...siblings]).slice(0, limit);
}

/**
 * Build a cross-product aggregation block so the LLM answers from the full
 * matching set instead of silently picking one SKU.
 */
export function buildProductAttributeAggregation(
  products: Product[],
  queryMessage: string,
  intentAttributes?: StructuredAttributeKey[],
): string | null {
  if (products.length <= 1) return null;

  const requested = detectRequestedAttributes(queryMessage, intentAttributes);
  const keys = requested.length > 0 ? requested : ALL_STRUCTURED_ATTRIBUTE_KEYS;

  const sections: string[] = [];

  for (const key of keys) {
    const valueMap = new Map<string, string[]>();

    for (const product of products) {
      const value = inferAttributeFromText(key, product);
      if (!value) continue;
      const normalized = value.toLowerCase();
      const names = valueMap.get(normalized) ?? [];
      if (!names.includes(product.name)) names.push(product.name);
      valueMap.set(normalized, names);
    }

    if (valueMap.size === 0) continue;

    const lines = [...valueMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([normalizedValue, productNames]) => {
        const sampleProduct = products.find((p) => productNames.includes(p.name));
        const displayValue =
          (sampleProduct ? inferAttributeFromText(key, sampleProduct) : null) ?? normalizedValue;
        return `  - ${displayValue}: ${productNames.join(', ')}`;
      });

    sections.push(`${attributeLabel(key)} across ${products.length} matching products:\n${lines.join('\n')}`);
  }

  if (sections.length === 0) {
    return (
      `[Product group context: ${products.length} matching products are in scope — ` +
      `${products.map((p) => p.name).join('; ')}. ` +
      `When answering attribute questions, consider ALL of these products. ` +
      `Do not answer from only one product unless the customer chose a specific one.]`
    );
  }

  return (
    `[Aggregated product-group attributes — use ALL values below when answering; ` +
    `never silently pick one product when multiple match]\n${sections.join('\n\n')}`
  );
}

export function buildCategoryAggregationInstructions(
  scope: ProductQueryScope,
  productCount: number,
): string {
  if (scope === 'specific_product' || productCount <= 1) return '';

  return `

Product-group answer rules (IMPORTANT):
- The customer is asking about ${productCount} matching products as a group${scope === 'attribute_followup' ? ' (attribute follow-up)' : ''}.
- Aggregate requested information across EVERY matching product in the catalog context and the aggregated attribute summary.
- List all distinct attribute values (flavors, sizes, colors, variants, brands, weights, types, etc.) found across the group.
- Never answer using only one product when multiple relevant products exist unless the customer explicitly chose one.
- If information is missing for some products, say what is known and what is not — do not guess.`;
}

/** Combined catalog text for knowledge-gap checks across a product group. */
export function buildProductKnowledgeContext(products: Product[]): string {
  return products
    .map((p) => {
      const attrs = getProductStructuredAttributes(p);
      const attrLines = Object.entries(attrs)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');

      return [
        `Product: ${p.name}`,
        p.brand ? `Brand: ${p.brand}` : null,
        p.category ? `Category: ${p.category}` : null,
        attrLines ? `Attributes: ${attrLines}` : null,
        p.description ? `Description: ${p.description}` : null,
        p.extracted_text ? `Extracted catalog text: ${p.extracted_text.slice(0, 800)}` : null,
        p.usage_description ? `Usage: ${p.usage_description}` : null,
        p.tags.length ? `Tags: ${p.tags.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n---\n');
}
