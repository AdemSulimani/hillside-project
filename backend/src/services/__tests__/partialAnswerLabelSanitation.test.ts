/**
 * Regression tests for the "we'll notify you about the WRONG attribute" bug.
 *
 * A customer asked about a product's PRICE and FLAVOR (flavor column NULL). The AI
 * answered price but appended "…notify you shortly regarding the BRAND." — naming an
 * attribute the customer never asked about. Root cause: the gap-assessor LLM's FREE-FORM
 * `missing[]` labels (which the model writes itself, primed by the prompt examples
 * ["brand"]/["marka"]) were passed through UNFILTERED whenever the deterministic-first
 * flag was off (the production default), so a mislabelled structured attribute reached the
 * customer.
 *
 * The fix makes `filterFreeFormInfoLabels` run UNCONDITIONALLY: structured-attribute labels
 * are owned solely by the deterministic keyed net (scoped to the REQUESTED attributes and
 * honouring name-inference); the LLM may only ever contribute allowlisted FREE-FORM gaps
 * (ingredients, usage, …). These tests exercise the exact merge processAIReply.ts composes
 * (now flag-independent), using the same pure helpers plus the real name-inference resolver
 * `getProductInferredAttributes` — no network/DB/OpenAI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Product } from '../../db/models/product';
import {
  detectRequestedAttributes,
  getProductInferredAttributes,
  type StructuredAttributeKey,
} from '../productRetrievalService';
import {
  buildMissingInfoHoldingMessage,
  composePartialAnswer,
  computeMissingStructuredAttributes,
  dedupeInfoLabels,
  deriveAnswerabilityStatus,
  filterFreeFormInfoLabels,
  localizedAttributeLabels,
  reconcileMissingAgainstAnswer,
  type InfoGapLocale,
} from '../productInformationGapHelpers';

function mockProduct(overrides: Partial<Product> & Pick<Product, 'name'>): Product {
  return {
    id: 'p1',
    tenant_id: 't1',
    brand: null,
    price: 18,
    discounted_price: null,
    description: null,
    usage_description: null,
    sku: null,
    category: null,
    tags: [],
    flavor: null,
    size: null,
    color: null,
    variant: null,
    weight: null,
    image_urls: [],
    is_active: true,
    in_stock: true,
    source_type: 'manual',
    extracted_text: null,
    metadata: null,
    deleted_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Product;
}

/**
 * Mirror of the processAIReply.ts gap-block merge AFTER the fix: the LLM labels are ALWAYS
 * sanitized (structured synonyms stripped), the missing-attribute net uses the EXPLICIT
 * requested set (no category-follow-up all-keys expansion), and the deterministic net owns
 * every structured label. Returns the composed customer-facing outcome; `reply === null`
 * means "no escalation — the original AI reply is sent as-is".
 */
function composeGapOutcome(opts: {
  inbound: string;
  assessmentAnswer: string;
  assessmentMissing: string[];
  intentAttributes?: StructuredAttributeKey[];
  products: Product[];
  locale: InfoGapLocale;
}): { finalMissing: string[]; reply: string | null } {
  const explicitRequested = detectRequestedAttributes(opts.inbound, opts.intentAttributes, {
    expandCategoryFollowUp: false,
  });
  const deterministicMissing = computeMissingStructuredAttributes(
    explicitRequested,
    opts.products.map((p) => getProductInferredAttributes(p)),
    new Set(),
  );
  const llmMissing = filterFreeFormInfoLabels(opts.assessmentMissing);
  const finalMissing = reconcileMissingAgainstAnswer(
    dedupeInfoLabels([...llmMissing, ...localizedAttributeLabels(deterministicMissing, opts.locale)]),
    opts.assessmentAnswer,
  );
  const status = deriveAnswerabilityStatus(opts.assessmentAnswer, finalMissing);
  const reply =
    status === 'complete'
      ? null
      : status === 'partial'
        ? composePartialAnswer(opts.assessmentAnswer, finalMissing, opts.locale)
        : buildMissingInfoHoldingMessage(finalMissing, opts.locale);
  return { finalMissing, reply };
}

const NO_BRAND = /\b(brand|marka|brandi)\b/i;

describe('partial-answer label sanitation (wrong-attribute regression)', () => {
  it('the reported bug: price+flavor on "Carbo one 1kg Limon" never names brand', () => {
    // flavor column is NULL but the NAME carries "Limon" → name-inference marks flavor
    // available → deterministic net emits nothing; the LLM assessor mislabels the gap as
    // "brand"/"marka" → sanitized away. Result: no wrong attribute, reply sent as-is.
    for (const [inbound, assessmentMissing, answer, locale] of [
      ['How much is it and what flavor?', ['brand'], 'It costs €18.', 'en'],
      ['Sa kushton dhe cfare shije ka?', ['marka'], 'Kushton €18.', 'sq'],
    ] as const) {
      const { finalMissing, reply } = composeGapOutcome({
        inbound,
        assessmentAnswer: answer,
        assessmentMissing: [...assessmentMissing],
        products: [mockProduct({ name: 'Carbo one 1kg Limon', category: 'Tjera (others)' })],
        locale,
      });
      assert.deepEqual(finalMissing, [], `finalMissing should be empty for: ${inbound}`);
      assert.equal(reply, null, `no escalation expected for: ${inbound}`);
    }
  });

  it('genuinely-missing flavor (no name cue) IS named correctly — flavor, never brand', () => {
    const { finalMissing, reply } = composeGapOutcome({
      inbound: 'How much and what flavor?',
      assessmentAnswer: 'It costs €39.99.',
      assessmentMissing: ['brand'], // LLM mislabels — must be dropped
      products: [mockProduct({ name: 'Iso Protein Pro', price: 39.99 })],
      locale: 'en',
    });
    assert.deepEqual(finalMissing, ['flavor']);
    assert.ok(reply && /flavor/i.test(reply), 'notice must name flavor');
    assert.ok(reply && !NO_BRAND.test(reply), 'notice must NOT name brand');
  });

  it('a genuine FREE-FORM gap (ingredients) still survives the filter', () => {
    const { finalMissing, reply } = composeGapOutcome({
      inbound: 'What are the ingredients?',
      assessmentAnswer: 'It costs €39.99.',
      assessmentMissing: ['ingredients'],
      products: [mockProduct({ name: 'Iso Protein Pro', brand: 'Acme', price: 39.99 })],
      locale: 'en',
    });
    assert.deepEqual(finalMissing, ['ingredients']);
    assert.ok(reply && /ingredients/i.test(reply));
  });

  it('multiple genuinely-missing requested attributes are all named; no unrequested attr', () => {
    const { finalMissing, reply } = composeGapOutcome({
      inbound: 'How much, what flavor and what size?',
      assessmentAnswer: 'It costs €39.99.',
      assessmentMissing: ['brand'],
      products: [mockProduct({ name: 'Iso Protein Pro', price: 39.99 })],
      locale: 'en',
    });
    assert.deepEqual([...finalMissing].sort(), ['flavor', 'size']);
    assert.ok(reply && /flavor/i.test(reply) && /size/i.test(reply));
    assert.ok(reply && !NO_BRAND.test(reply));
  });

  it('adversarial: any set of UNREQUESTED structured synonyms/echoes is stripped', () => {
    const { finalMissing, reply } = composeGapOutcome({
      inbound: 'what flavor?',
      assessmentAnswer: 'It costs €39.99.',
      assessmentMissing: ['marka', 'pesha', 'ngjyra', 'ma shum', 'cila eshte me e mire'],
      products: [mockProduct({ name: 'Iso Protein Pro', price: 39.99 })],
      locale: 'sq',
    });
    // Only the requested-and-genuinely-missing attribute survives.
    assert.deepEqual(finalMissing, localizedAttributeLabels(['flavor'], 'sq'));
    assert.ok(reply && !/\b(marka|pesha|ngjyra)\b/i.test(reply));
  });

  it('browse follow-up ("what options?") flags no structured attribute as missing', () => {
    // explicit requested set is empty (fallback expansion opted out), so a null-brand
    // product does not get every column enumerated, and the LLM "marka" is stripped.
    const { finalMissing, reply } = composeGapOutcome({
      inbound: 'what options do you have?',
      assessmentAnswer: 'We have several products.',
      assessmentMissing: ['marka'],
      products: [mockProduct({ name: 'Iso Protein Pro' })],
      locale: 'sq',
    });
    assert.deepEqual(finalMissing, []);
    assert.equal(reply, null);
  });
});
