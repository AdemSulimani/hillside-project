import {
  ALL_STRUCTURED_ATTRIBUTE_KEYS,
  detectRequestedAttributes,
  isCategoryAttributeFollowUp,
  type StructuredAttributeKey,
} from './productRetrievalService';

export type ProductAttributeKey = StructuredAttributeKey;

export interface ProductAttributeIntentResult {
  is_attribute_question: boolean;
  is_product_knowledge_question: boolean;
  attributes: ProductAttributeKey[];
  source: 'regex' | 'keywords' | 'llm' | 'llm_with_keyword_fallback' | 'none';
}

/** Keywords that indicate catalog fact questions (EN + SQ). */
export const PRODUCT_KNOWLEDGE_QUESTION_KEYWORDS = [
  'flavor',
  'flavour',
  'taste',
  'size',
  'color',
  'colour',
  'variant',
  'weight',
  'brand',
  'ingredient',
  'specification',
  'spec',
  'packaging',
  'contain',
  'made of',
  'material',
  'vegan',
  'organic',
  'gluten',
  'allergen',
  'compatible',
  'compatibility',
  'shije',
  'madhesi',
  'madhësi',
  'ngjyr',
  'pesha',
  'marka',
  'perberes',
  'përberës',
  'specifikim',
  'paketim',
  'lloj',
  'tipi',
] as const;

const IMPLICIT_ATTRIBUTE_SELECTION_PATTERNS: Array<{
  attributes: ProductAttributeKey[];
  re: RegExp;
}> = [
  {
    attributes: ['flavor'],
    re: /\b(what|which)\b.{0,40}\b(flavou?rs?|tastes?|shije)\b/i,
  },
  {
    attributes: ['flavor'],
    re: /\b(i want|i need|only|just|prefer|dua|vetem|vetëm)\b.{0,30}\b(chocolate|vanilla|strawberry|banana|unflavored|unflavoured|shije)\b/i,
  },
  {
    attributes: ['color'],
    re: /\b(i want|i need|only|just|prefer|dua|vetem|vetëm)\b.{0,30}\b(red|blue|black|white|green|yellow|pink|ngjyr)\b/i,
  },
  {
    attributes: ['size', 'weight'],
    re: /\b(i want|i need|only|just|prefer|dua|vetem|vetëm)\b.{0,30}\b(\d+(?:\.\d+)?\s*(?:g|kg|ml|l|oz|lb|lbs))\b/i,
  },
  {
    attributes: ['size', 'weight'],
    re: /\b(available in|only the|the)\s+(\d+(?:\.\d+)?\s*(?:g|kg|ml|l|oz|lb|lbs))\b/i,
  },
];

export const ATTRIBUTE_FOLLOW_UP_MAX_LEN = 250;

export function hasProductKnowledgeKeywordCue(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return PRODUCT_KNOWLEDGE_QUESTION_KEYWORDS.some((kw) => normalized.includes(kw));
}

export function detectImplicitAttributeSelection(message: string): ProductAttributeKey[] {
  const trimmed = message.trim();
  if (!trimmed) return [];
  const found = new Set<ProductAttributeKey>();
  for (const { attributes, re } of IMPLICIT_ATTRIBUTE_SELECTION_PATTERNS) {
    if (re.test(trimmed)) {
      for (const attr of attributes) found.add(attr);
    }
  }
  return [...found];
}

/** Synchronous attribute / product-knowledge cues (no LLM). */
export function detectAttributeIntentFromKeywords(message: string): ProductAttributeIntentResult | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  if (isCategoryAttributeFollowUp(trimmed, ATTRIBUTE_FOLLOW_UP_MAX_LEN)) {
    const attributes = detectRequestedAttributes(trimmed);
    return {
      is_attribute_question: true,
      is_product_knowledge_question: true,
      attributes: attributes.length > 0 ? attributes : ALL_STRUCTURED_ATTRIBUTE_KEYS,
      source: 'regex',
    };
  }

  const explicitAttrs = detectRequestedAttributes(trimmed);
  const implicitAttrs = detectImplicitAttributeSelection(trimmed);
  const merged = [...new Set([...explicitAttrs, ...implicitAttrs])];

  if (merged.length > 0) {
    return {
      is_attribute_question: true,
      is_product_knowledge_question: true,
      attributes: merged,
      source: 'keywords',
    };
  }

  if (hasProductKnowledgeKeywordCue(trimmed)) {
    const cueAttrs = detectRequestedAttributes(trimmed);
    const cueImplicit = detectImplicitAttributeSelection(trimmed);
    const cueMerged = [...new Set([...cueAttrs, ...cueImplicit])];
    return {
      is_attribute_question: cueMerged.length > 0,
      is_product_knowledge_question: true,
      attributes: cueMerged,
      source: 'keywords',
    };
  }

  return null;
}

/** Whether the message is about product attributes (sync heuristic). */
export function isAttributeQuestionMessage(message: string): boolean {
  const hint = detectAttributeIntentFromKeywords(message);
  return hint?.is_attribute_question === true;
}
