import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE_LIST_COMPACT_APPEND,
  PRODUCT_DESCRIPTION_CONCISE_APPEND,
  SHORTEST_ANSWER_APPEND,
} from '../productDescriptionPromptService';
import { assembleGuidelinesFromBlocks } from '../promptAssemblyService';
import type { TenantPromptBlockRow } from '../../db/models/promptBlock';

/**
 * Content seeded by migration 061 for `guidelines.messaging_style`. Mirrored here so the
 * test fails if the migration text and the runtime brevity rule drift apart.
 */
const MESSAGING_STYLE_CONTENT_061 = `
- Brevity (HIGHEST PRIORITY): give the SHORTEST reply that fully and correctly answers the customer's current message. Lead with the direct answer. A one-word or single-line answer is correct and preferred whenever it fully answers — it does not need to be a complete sentence.
- Concrete examples of the expected length:
  - "Do you have this product?" -> "Yes."
  - "Do you have this brand?" -> "Yes."
  - "What is the price?" -> "€25"
- Do NOT restate the product or brand name the customer just referenced, and do NOT add filler such as "we have it available in our catalog".
- Never repeat or rephrase the customer's question, and never restate information the customer already gave you.
- No opening pleasantries or filler ("Of course!", "Sure", "Thanks for reaching out", "I'd be happy to help") — start with the answer.
- Stay warm, natural, and polite — concise, not cold or robotic. This is a messaging app, not email: scannable beats wordy. Keep the words needed for the answer to be clear and grammatical; cut everything that adds no information.
- Give a longer answer only when the question genuinely requires it or another guideline requires fixed/verbatim wording (usage instructions, discount phrases, order-confirmation footer, unavailable-product alternatives, multi-attribute aggregation, recommendations). Even then, add only what is necessary — no padding or redundancy.
- Do not use markdown formatting — reply in plain text suitable for a messaging app.
`.trim();

function makeBlock(overrides: Partial<TenantPromptBlockRow> = {}): TenantPromptBlockRow {
  return {
    block_key: 'guidelines.messaging_style',
    content: MESSAGING_STYLE_CONTENT_061,
    enabled: true,
    sort_order: 20,
    ...overrides,
  } as TenantPromptBlockRow;
}

describe('SHORTEST_ANSWER_APPEND (platform-enforced brevity rule)', () => {
  it('declares brevity the highest priority over tone/sales nudges', () => {
    assert.match(SHORTEST_ANSWER_APPEND, /HIGHEST PRIORITY/);
    assert.match(SHORTEST_ANSWER_APPEND, /SHORTEST reply/);
  });

  it('includes the concrete short-answer examples from the spec', () => {
    assert.match(SHORTEST_ANSWER_APPEND, /"Do you have this product\?" -> "Yes\."/);
    assert.match(SHORTEST_ANSWER_APPEND, /"Do you have this brand\?" -> "Yes\."/);
    assert.match(SHORTEST_ANSWER_APPEND, /"What is the price\?" -> "€25"/);
  });

  it('forbids restating known info and filler openers', () => {
    assert.match(SHORTEST_ANSWER_APPEND, /Do NOT restate the product or brand name/);
    assert.match(SHORTEST_ANSWER_APPEND, /No opening pleasantries or filler/);
    assert.match(SHORTEST_ANSWER_APPEND, /we have it available in our catalog/);
  });

  it('preserves the carve-out for answers that genuinely need to be longer', () => {
    assert.match(SHORTEST_ANSWER_APPEND, /verbatim usage\/dosage instructions/);
    assert.match(SHORTEST_ANSWER_APPEND, /order confirmations/);
    assert.match(SHORTEST_ANSWER_APPEND, /unavailable-product handling/);
    assert.match(SHORTEST_ANSWER_APPEND, /recommendations/);
  });

  it('stays natural — explicitly not cold or robotic', () => {
    assert.match(SHORTEST_ANSWER_APPEND, /not cold or robotic/);
  });

  it('does not contradict the order-closing policy: carves out the one allowed order question', () => {
    // The literal phrase "Would you like to order?" must not appear verbatim in the
    // brevity rule so the model does not echo it as a suggested reply template.
    assert.doesNotMatch(SHORTEST_ANSWER_APPEND, /Would you like to order\?/);
    // The rule explicitly bans all follow-up invitations and order-closing questions.
    assert.match(SHORTEST_ANSWER_APPEND, /NO FOLLOW-UP QUESTIONS OR INVITATIONS/);
    // Generic invitation examples stay forbidden.
    assert.match(SHORTEST_ANSWER_APPEND, /Let me know if you need anything/);
  });
});

describe('PRODUCT_DESCRIPTION_CONCISE_APPEND vs guidelines.recommendations consistency', () => {
  it('enforces names-only recommendations (must match the reconciled guideline block)', () => {
    assert.match(PRODUCT_DESCRIPTION_CONCISE_APPEND, /list ONLY the product name/);
    assert.match(
      PRODUCT_DESCRIPTION_CONCISE_APPEND,
      /Only provide descriptions when the customer explicitly follows up/,
    );
  });
});

describe('assembleGuidelinesFromBlocks with the migration-061 messaging style', () => {
  it('surfaces the brevity-first instruction and examples in the assembled guidelines', () => {
    const assembled = assembleGuidelinesFromBlocks(
      [makeBlock()],
      { language: 'en' },
      { hasImages: false },
    );
    assert.match(assembled, /Brevity \(HIGHEST PRIORITY\)/);
    assert.match(assembled, /"What is the price\?" -> "€25"/);
  });

  it('omits the block entirely when a tenant disables it', () => {
    const assembled = assembleGuidelinesFromBlocks(
      [makeBlock({ enabled: false })],
      { language: 'en' },
      { hasImages: false },
    );
    assert.equal(assembled, '');
  });
});

describe('PRICE_LIST_COMPACT_APPEND (category price listing cap)', () => {
  it('caps the list at 5 items', () => {
    assert.match(PRICE_LIST_COMPACT_APPEND, /5 most relevant/);
  });

  it('tells the customer how to request the full list', () => {
    assert.match(PRICE_LIST_COMPACT_APPEND, /full price list/i);
  });

  it('overrides the cap when the customer explicitly requests everything', () => {
    assert.match(PRICE_LIST_COMPACT_APPEND, /te gjitha/i);
    assert.match(PRICE_LIST_COMPACT_APPEND, /full list/i);
    assert.match(PRICE_LIST_COMPACT_APPEND, /list them all/i);
  });

  it('does not limit comparison / ranking questions', () => {
    assert.match(PRICE_LIST_COMPACT_APPEND, /comparison or ranking/i);
    assert.match(PRICE_LIST_COMPACT_APPEND, /do NOT limit/i);
  });

  it('does not limit a single named product query', () => {
    assert.match(PRICE_LIST_COMPACT_APPEND, /single specifically named product/i);
  });

  it('covers Albanian price comparison phrases', () => {
    assert.match(PRICE_LIST_COMPACT_APPEND, /cili kushton me pak/i);
    assert.match(PRICE_LIST_COMPACT_APPEND, /cila eshte me e lire/i);
  });
});
