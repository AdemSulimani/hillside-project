/**
 * P1-A — attribute backfill: populate the structured attribute columns (flavor, size, color,
 * variant, weight, brand) from each product's OWN text (name + description + usage_description +
 * tags).
 *
 * Why this exists: the import pipeline structurally never wrote these columns (the extraction DTO
 * had no members for them until P1-A), so on the real dev catalog flavor/brand are populated on
 * 1/257 rows and size/color/variant/weight on zero — while the values sit in the names
 * ("Carbo one 1kg Limon") and descriptions ("… i real pharm carbo one …"). Every runtime
 * availability decision then leans on regex vocabularies; the backfill moves the truth into the
 * columns once, at write time.
 *
 * Two extraction passes per product:
 *  1. DETERMINISTIC — `getProductInferredAttributes` (the same text-aware resolver the gap net
 *     uses), which is text-derived by construction.
 *  2. LLM — a batched extraction call (`product_processing` role), for values the regex
 *     vocabulary cannot know ("Dredhz", "Lemonad", "Exotic").
 *
 * Every LLM value must pass `verifyExtractedValue` — a verbatim-membership guard: the value (or a
 * known dialect variant) must occupy whole-token positions in the product's own text. An
 * extractor hallucination is thereby structurally unable to reach the catalog — the same
 * principle as the P1-B membership check on the send path.
 *
 * Pure helpers are exported for unit tests; the single LLM call site is `extractAttributesBatch`.
 */
import type OpenAI from 'openai';
import { resolveModel } from '../config/models';
import type { Product } from '../db/models/product';
import { containsPhrase } from './attributeClaimLexicon';
import { expandDialectVariants, foldDialect } from './dialectNormalization';
import { getProductInferredAttributes, getProductStructuredAttributes } from './productRetrievalService';

/**
 * The columns the backfill may write. `category` is deliberately excluded (253/257 populated).
 * `color` is deliberately excluded too: the 2026-07-26 dry-run showed every regex color candidate
 * on the real catalog was a product-LINE word ("Gold standard whey" → gold, "Black wolf" → black,
 * "blue Raspbery" → part of a flavor) — zero true colors exist in this niche, so a color pass can
 * only fabricate.
 */
export const BACKFILL_ATTRIBUTE_KEYS = ['flavor', 'size', 'variant', 'weight', 'brand'] as const;
export type BackfillAttributeKey = (typeof BACKFILL_ATTRIBUTE_KEYS)[number];

export type BackfillSource = 'regex' | 'llm';

export interface BackfillProposal {
  /** Column values to write (only keys whose column is currently empty appear). */
  updates: Partial<Record<BackfillAttributeKey, string>>;
  /** Per-key provenance, stamped into products.metadata.attribute_backfill.fields. */
  fields: Partial<Record<BackfillAttributeKey, BackfillSource>>;
  /** LLM values REJECTED by the verbatim-membership guard (report-only — never written). */
  rejected: Partial<Record<BackfillAttributeKey, string>>;
}

/** The provenance marker version; bump to make a re-run revisit already-stamped rows. */
export const BACKFILL_VERSION = 1;

/** The product's own text — the only evidence a value may be extracted from. NEVER extracted_text. */
export function productOwnText(product: Product): string {
  return [product.name, product.description ?? '', product.usage_description ?? '', product.tags.join(' ')]
    .filter(Boolean)
    .join('\n');
}

/**
 * Verbatim-membership guard: the value's folded form — or a single-token dialect substitution of
 * it ("çokollatë" vs a name that says "Qokolad") — must occupy whole-token positions in the fold
 * of the product's own text.
 */
export function verifyExtractedValue(value: string, product: Product): boolean {
  const folded = foldDialect(value);
  if (!folded) return false;
  const hay = foldDialect(productOwnText(product));
  if (!hay) return false;

  const tokens = folded.split(' ').filter(Boolean);
  const candidates = new Set<string>([folded]);
  tokens.forEach((token, i) => {
    for (const alt of expandDialectVariants([token])) {
      if (alt === token) continue;
      const substituted = [...tokens];
      substituted[i] = alt;
      candidates.add(substituted.join(' '));
    }
  });

  for (const candidate of candidates) {
    if (containsPhrase(hay, candidate)) return true;
  }
  return false;
}

/**
 * Merge the two extraction passes into one proposal for a product.
 *
 * Precedence per key: existing non-empty column (never overwritten, key omitted) → deterministic
 * regex value (text-derived by construction, always acceptable) → LLM value that survives the
 * verbatim-membership guard. Rejected LLM values are reported, never written.
 */
export function mergeBackfillValues(
  product: Product,
  llmValues: Partial<Record<BackfillAttributeKey, string>>,
): BackfillProposal {
  const structured = getProductStructuredAttributes(product);
  const inferred = getProductInferredAttributes(product);
  const proposal: BackfillProposal = { updates: {}, fields: {}, rejected: {} };

  for (const key of BACKFILL_ATTRIBUTE_KEYS) {
    if (structured[key]) continue; // column already carries a value — never overwrite

    const regexValue = inferred[key]?.trim();
    if (regexValue) {
      proposal.updates[key] = regexValue;
      proposal.fields[key] = 'regex';
      continue;
    }

    const llmValue = llmValues[key]?.trim();
    if (!llmValue) continue;
    if (verifyExtractedValue(llmValue, product)) {
      proposal.updates[key] = llmValue.slice(0, 255);
      proposal.fields[key] = 'llm';
    } else {
      proposal.rejected[key] = llmValue.slice(0, 255);
    }
  }

  return proposal;
}

const BACKFILL_SYSTEM_PROMPT = `You extract structured product attributes from catalog text.

For EACH numbered product you receive, extract these attributes ONLY when their value is literally present in that product's own text (name, description, usage, tags):
- flavor: the flavor (e.g. "Limon", "Qershi", "Dredhz"); use the unflavored marker itself ("pa aromë", "pa shije") when the text states the product is unflavored
- size: the package size or count (e.g. "1kg", "216gr", "90 tableta")
- variant: the named variant
- weight: the weight (e.g. "216gr", "3kg")
- brand: the brand or manufacturer name

Rules:
- Copy each value VERBATIM from the product's own text — never translate, normalize, guess, or infer.
- Omit an attribute entirely when the text does not state it. Non-supplement items (bags, clothing, equipment) usually have no flavor — omit it.
- A product-line word is not an attribute ("Gold standard whey" is a name, not a color or variant).
- Never use another product's text as evidence.
- Return ONLY a JSON object: {"products": [{"index": <number>, "flavor"?: string, "size"?: string, "variant"?: string, "weight"?: string, "brand"?: string}, ...]} with one entry per product, in order.`;

/** Build the numbered user prompt for one batch. Exported for tests. */
export function buildBackfillUserPrompt(products: Product[]): string {
  return products
    .map((p, i) => {
      const lines = [
        `Product ${i + 1}:`,
        `  name: ${p.name}`,
        p.description ? `  description: ${p.description}` : null,
        p.usage_description ? `  usage: ${p.usage_description}` : null,
        p.tags.length ? `  tags: ${p.tags.join(', ')}` : null,
      ];
      return lines.filter(Boolean).join('\n');
    })
    .join('\n\n');
}

/** Parse the batch response into per-product value maps (index-aligned, invalid entries dropped). */
export function parseBackfillResponse(
  raw: string,
  productCount: number,
): Array<Partial<Record<BackfillAttributeKey, string>>> {
  const out: Array<Partial<Record<BackfillAttributeKey, string>>> = Array.from(
    { length: productCount },
    () => ({}),
  );
  try {
    const parsed = JSON.parse(raw) as { products?: unknown };
    if (!Array.isArray(parsed.products)) return out;
    for (const entry of parsed.products) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const index = Number(record.index);
      if (!Number.isInteger(index) || index < 1 || index > productCount) continue;
      for (const key of BACKFILL_ATTRIBUTE_KEYS) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
          out[index - 1][key] = value.trim();
        }
      }
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * One batched extraction call. Kept out of the pure helpers so tests never import the OpenAI
 * client; callers (the backfill CLI) inject nothing — the shared singleton is used directly.
 */
export async function extractAttributesBatch(
  products: Product[],
): Promise<Array<Partial<Record<BackfillAttributeKey, string>>>> {
  if (products.length === 0) return [];
  // Deferred import keeps this module import-safe for unit tests (openaiClient throws at module
  // load without an API key).
  const { openai } = await import('./openaiClient');
  const { withModelRole } = await import('./openaiCallTracker');
  const client: OpenAI = openai;

  const response = await withModelRole('product_processing', () =>
    client.chat.completions.create({
      model: resolveModel('product_processing'),
      messages: [
        { role: 'system', content: BACKFILL_SYSTEM_PROMPT },
        { role: 'user', content: buildBackfillUserPrompt(products) },
      ],
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }),
  );

  const content = response.choices[0]?.message?.content ?? '';
  return parseBackfillResponse(content, products.length);
}
