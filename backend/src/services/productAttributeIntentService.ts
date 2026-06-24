import { openai, OPENAI_CHAT_MODEL } from './openaiClient';
import {
  detectAttributeIntentFromKeywords,
  type ProductAttributeIntentResult,
  type ProductAttributeKey,
} from './productAttributeIntentHeuristics';

export type { ProductAttributeIntentResult, ProductAttributeKey };
export {
  detectAttributeIntentFromKeywords,
  detectImplicitAttributeSelection,
  hasProductKnowledgeKeywordCue,
  isAttributeQuestionMessage,
  PRODUCT_KNOWLEDGE_QUESTION_KEYWORDS,
} from './productAttributeIntentHeuristics';

const EMPTY_INTENT: ProductAttributeIntentResult = {
  is_attribute_question: false,
  is_product_knowledge_question: false,
  attributes: [],
  source: 'none',
};

const SUBSTANTIVE_MESSAGE_MIN_LEN = 2;

function parseAttributeIntentJson(raw: string): ProductAttributeIntentResult | null {
  try {
    const parsed = JSON.parse(raw) as {
      is_attribute_question?: boolean;
      is_product_knowledge_question?: boolean;
      attributes?: unknown;
    };

    const validKeys = new Set<string>([
      'flavor',
      'size',
      'color',
      'variant',
      'weight',
      'brand',
      'category',
    ]);

    const attributes = Array.isArray(parsed.attributes)
      ? parsed.attributes
          .filter((k): k is ProductAttributeKey => typeof k === 'string' && validKeys.has(k))
      : [];

    const isAttribute = parsed.is_attribute_question === true;
    const isKnowledge = parsed.is_product_knowledge_question === true;

    if (!isAttribute && !isKnowledge) {
      return {
        is_attribute_question: false,
        is_product_knowledge_question: false,
        attributes: [],
        source: 'llm',
      };
    }

    return {
      is_attribute_question: isAttribute,
      is_product_knowledge_question: isKnowledge || isAttribute,
      attributes,
      source: 'llm',
    };
  } catch {
    return null;
  }
}

/** Trust the LLM verdict; keywords may only enrich attributes when the LLM already flagged product knowledge. */
function mergeKeywordFallback(
  llmResult: ProductAttributeIntentResult,
  keywordHint: ProductAttributeIntentResult | null,
): ProductAttributeIntentResult {
  if (!keywordHint || !llmResult.is_product_knowledge_question) return llmResult;
  if (llmResult.attributes.length === 0 && keywordHint.attributes.length > 0) {
    return { ...llmResult, attributes: keywordHint.attributes, source: 'llm_with_keyword_fallback' };
  }
  return llmResult;
}

/**
 * Classifies product-attribute questions and broader catalog-fact (product knowledge) questions.
 * Always attempts an LLM pass for substantive messages; keyword/regex fast paths avoid veto gaps.
 */
export async function classifyProductAttributeIntent(
  message: string,
): Promise<ProductAttributeIntentResult> {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length < SUBSTANTIVE_MESSAGE_MIN_LEN) {
    return EMPTY_INTENT;
  }

  const keywordHint = detectAttributeIntentFromKeywords(trimmed);
  if (keywordHint?.source === 'regex') {
    return keywordHint;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content: `You classify customer messages about product catalog facts.

Return JSON only:
{
  "is_attribute_question": boolean,
  "is_product_knowledge_question": boolean,
  "attributes": string[]
}

Set is_attribute_question true when the customer asks about or selects catalog attributes: flavor, size, color, variant, weight, brand, or category (product type).

Set is_product_knowledge_question true when the customer needs factual catalog information about a product: attribute questions, ingredients/material/details from the product description, servings/quantity per container (e.g. "how many servings", "sa doza", "how many capsules"), and stock/availability of an already-identified product (e.g. "is it in stock", "a keni ne stok", "do you have it available"). False for: usage/dosage/how-to-take ONLY, price/cost questions (even when they include an attribute qualifier such as "price of the orange-flavored one", "how much does the large one cost", "what is the cost of the strawberry variant"), pure recommendations and comparisons (e.g. "which one would you recommend?", "which is better?", "cilen me sugjeron?", "cilen mkishe than ti me marr?", "which one should I choose?", "me e mire?", "cilen te marr?"), greetings, order placement, and business-info questions (location, address, opening hours, contact details, delivery methods/policy, about the business).

Handle ANY language, dialect, slang, shorthand, and misspellings (e.g. "qfar shijesh", "shejset", "cila marke", "a ka stok"). Classify by meaning, not exact spelling.

Important: A message whose PRIMARY intent is asking for price or cost is a price question regardless of any attribute qualifier used to identify the product. Examples that must return false/false: "What is the price of the first product, the orange-flavored one?", "Sa kushton versioni i madh?", "How much is the chocolate flavor?"

Business-info examples (always false): "Where are you located?", "Ku gjendeni?", "What are your opening hours?", "Do you offer home delivery?"

For mixed messages (e.g. size + how to take), set BOTH is_attribute_question and is_product_knowledge_question true and list relevant attributes.

attributes: subset of [flavor, size, color, variant, weight, brand, category] only — empty for ingredient/material/packaging/spec questions (those use description, not structured attributes). Use category for product type questions.`,
        },
        { role: 'user', content: trimmed },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 128,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const llmResult = parseAttributeIntentJson(raw.trim());
      if (llmResult) {
        return mergeKeywordFallback(llmResult, keywordHint);
      }
    }
  } catch {
    // Fall through to keyword hint
  }

  if (keywordHint) return keywordHint;

  return EMPTY_INTENT;
}
