/**
 * VOCABULARY-INDEPENDENT attribute-availability classifier.
 *
 * Problem this solves:
 *   The deterministic missing-attribute net (computeMissingStructuredAttributes) and
 *   the buildProductAttributeAggregation aggregator historically decided whether an
 *   attribute (flavor/color/size/weight/…) was present by matching the product text
 *   against a FIXED regex vocabulary (NAME_ATTRIBUTE_PATTERNS). Any value not in that
 *   list — a new flavor like "Tiramisu", an unusual color, an oddly-formatted size —
 *   was treated as "missing", which could resurrect the contradictory
 *   "we'll notify you shortly about the flavor" reply even though the catalog clearly
 *   states the value.
 *
 * This service asks an LLM, in ONE batched call, which of the REQUESTED attribute keys
 * are explicitly specified in at least one of the matched products' text/fields. It is
 * grounded (no guessing), fail-open (returns an empty set on any error so callers fall
 * back to the deterministic structured + regex signals), and cached per product set so
 * repeated turns in a conversation don't repeat the call.
 *
 * It NEVER asserts an attribute is missing — it only reports the keys it can CONFIRM are
 * present. Absence of confirmation is left to the deterministic net, preserving the
 * fail-closed escalation guarantee for genuinely-missing attributes.
 */
import type { Product } from '../db/models/product';
import { openai, OPENAI_CLASSIFIER_MODEL } from './openaiClient';
import {
  buildAvailabilityCacheKey,
  buildProductAvailabilityBlock,
  MAX_PRODUCTS_IN_PROMPT,
  parseSpecifiedAttributes,
  VALID_ATTRIBUTE_KEYS,
} from './productAttributeAvailabilityHelpers';
import type { StructuredAttributeKey } from './productRetrievalService';

/** Default abort timeout for the classifier call. */
const DEFAULT_TIMEOUT_MS = 6000;
/** In-memory cache TTL. Product `updated_at` is part of the key, so edits invalidate too. */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  expires: number;
  value: Set<StructuredAttributeKey>;
}
const availabilityCache = new Map<string, CacheEntry>();

const SYSTEM_PROMPT = `You are a precise product-catalog attribute detector for an online store.

You receive a list of REQUESTED attribute keys and one or more PRODUCTS (each with its name, brand, category, structured fields, description, packaging text, and tags).

For EACH requested key, decide whether AT LEAST ONE product EXPLICITLY specifies a concrete value for that attribute — anywhere in its text or fields, in ANY language (English, Albanian/Shqip, informal spellings, abbreviations).

Rules:
- Count a key as specified ONLY when a concrete value is actually present (e.g. flavor "Tiramisu", color "matte black", size "750 ml", weight "2.5 kg"). A new/unusual value still counts — do not rely on a fixed vocabulary.
- Do NOT infer, guess, or assume. If the value is not clearly stated, do not list the key.
- "category" counts as specified when a product type/category is stated. "variant" counts when a named variant/edition is stated.
- A price is NOT an attribute key here; ignore price.

Return JSON only: {"specified": string[]}
where "specified" is the subset of the requested keys that are explicitly present in at least one product. Use the exact key spellings provided. Empty array if none are specified.`;

/**
 * Return the subset of `requestedKeys` that the LLM can CONFIRM are explicitly specified
 * in at least one of `products`. Fail-open: returns an empty set on empty input, timeout,
 * transport error, or unparseable output — callers then rely on the deterministic
 * structured + regex availability signals (and the downstream reconciliation guards).
 */
export async function detectSpecifiedAttributes(
  requestedKeys: StructuredAttributeKey[],
  products: Product[],
  options?: { timeoutMs?: number },
): Promise<Set<StructuredAttributeKey>> {
  const keys = requestedKeys.filter((k) => VALID_ATTRIBUTE_KEYS.has(k));
  if (keys.length === 0 || products.length === 0) return new Set();

  const boundedProducts = products.slice(0, MAX_PRODUCTS_IN_PROMPT);
  const key = buildAvailabilityCacheKey(keys, boundedProducts);
  const now = Date.now();
  const cached = availabilityCache.get(key);
  if (cached && cached.expires > now) {
    return new Set(cached.value);
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const userContent = [
      `Requested attribute keys: ${keys.join(', ')}`,
      '',
      'Products:',
      boundedProducts.map((p, i) => buildProductAvailabilityBlock(p, i)).join('\n---\n'),
    ].join('\n');

    const completion = await openai.chat.completions.create(
      {
        model: OPENAI_CLASSIFIER_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 120,
      },
      { signal: controller.signal },
    );

    const raw = completion.choices[0]?.message?.content;
    if (!raw?.trim()) return new Set();

    const specified = parseSpecifiedAttributes(raw, keys);
    availabilityCache.set(key, { expires: now + CACHE_TTL_MS, value: new Set(specified) });
    return specified;
  } catch (err) {
    console.warn('[productAttributeAvailability] detection failed — failing open', { err });
    return new Set();
  } finally {
    clearTimeout(timer);
  }
}

/** Test/maintenance helper: clear the in-memory availability cache. */
export function __clearAvailabilityCacheForTests(): void {
  availabilityCache.clear();
}
