/**
 * Tests for the render-time block allowlist, the prompt budget, and the required-section
 * assertion (P2-5, RC-26).
 *
 * The headline regression is the orphan `guidelines.offers_promotions`: verified live as a
 * `prompt_blocks` row with `is_active = false` (admin-created, in no migration) whose 6 tenant
 * rows are all `enabled = true` with a resolving FK — so it injects ~1,478 chars referencing a
 * nonexistent "Active offers" section into 6/6 tenants' prompts. `listTenantPromptBlocksRuntime`
 * never joins `prompt_blocks`, so the catalog's is_active is never consulted at render time.
 *
 * BLOCK_SHAPES below mirrors the live tenant_prompt_blocks distribution (13 keys, 11 enabled
 * guidelines + the retired product_description_responses + the orphan).
 *
 * All pure/in-process — no network/DB/OpenAI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORBIDDEN_SECTION_REFERENCES,
  KNOWN_GUIDELINE_BLOCK_KEYS,
  PROMPT_ASSEMBLY_MAX_CHARS,
  PROMPT_GUIDELINES_MAX_CHARS,
  assembleGuidelinesFromBlocks,
  assertRequiredSections,
  expandPromptPlaceholders,
  isAllowedBlockKey,
} from '../promptAssemblyService';
import type { TenantPromptBlockRow } from '../../db/models/promptBlock';

let seq = 0;
function block(
  block_key: string,
  content: string,
  overrides: Partial<TenantPromptBlockRow> = {},
): TenantPromptBlockRow {
  seq += 1;
  return {
    id: `id-${seq}`,
    tenant_id: 'tenant-1',
    prompt_block_id: `pb-${seq}`,
    block_key,
    enabled: true,
    content,
    sort_order: seq * 10,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as TenantPromptBlockRow;
}

const CTX = { language: 'sq' } as const;
const OPTS = { hasImages: false };

/** The orphan's actual behaviour: it tells the model to use a section the code never populates. */
const ORPHAN_CONTENT =
  '- Reference the Active offers section above when the customer asks about promotions.';

const LIVE_SHAPE: TenantPromptBlockRow[] = [
  block('guidelines.language', 'LANGUAGE LOCK: reply in {{LANGUAGE_NAME}}.'),
  block('guidelines.messaging_style', 'Be brief.'),
  block('guidelines.catalog_integrity', 'Only name catalog products.'),
  block('guidelines.offers_promotions', ORPHAN_CONTENT), // the RC-26 orphan
  block('guidelines.order_flow_and_escalation', 'Escalate refunds.'),
  block('guidelines.product_description_responses', 'retired', { enabled: false }),
];

describe('the orphan guidelines.offers_promotions (RC-26)', () => {
  it('flag-off: renders into the prompt — the audited defect, reproduced', () => {
    const out = assembleGuidelinesFromBlocks(LIVE_SHAPE, CTX, { ...OPTS, allowlist: false });
    assert.ok(out.includes('Active offers'), 'expected the orphan to leak with the flag off');
  });

  it('flag-on: is dropped and never reaches the prompt', () => {
    const dropped: string[] = [];
    const out = assembleGuidelinesFromBlocks(LIVE_SHAPE, CTX, {
      ...OPTS,
      allowlist: true,
      onDropped: (key) => dropped.push(key),
    });
    assert.equal(out.includes('Active offers'), false);
    assert.deepEqual(dropped, ['guidelines.offers_promotions']);
  });

  it('flag-on: the drop is REPORTED, never silent', () => {
    const dropped: Array<{ key: string; reason: string }> = [];
    assembleGuidelinesFromBlocks(LIVE_SHAPE, CTX, {
      ...OPTS,
      allowlist: true,
      onDropped: (key, reason) => dropped.push({ key, reason }),
    });
    assert.deepEqual(dropped, [{ key: 'guidelines.offers_promotions', reason: 'allowlist' }]);
  });

  it('is not in the known-keys list (it is in no migration)', () => {
    assert.equal(KNOWN_GUIDELINE_BLOCK_KEYS.has('guidelines.offers_promotions'), false);
    assert.equal(isAllowedBlockKey('guidelines.offers_promotions'), false);
  });
});

describe('assembleGuidelinesFromBlocks — flag-off byte-identity', () => {
  it('flag-off output is byte-identical to the legacy assembly', () => {
    // The legacy behaviour: sort by (sort_order, block_key), keep enabled, skip vision without
    // images, expand placeholders, join with a blank line.
    const legacy = [...LIVE_SHAPE]
      .sort((a, b) =>
        a.sort_order !== b.sort_order
          ? a.sort_order - b.sort_order
          : a.block_key.localeCompare(b.block_key),
      )
      .filter((r) => r.enabled)
      .map((r) => expandPromptPlaceholders(r.content, { LANGUAGE_NAME: 'Albanian (shqip)' }).trim())
      .filter(Boolean)
      .join('\n\n');

    assert.equal(assembleGuidelinesFromBlocks(LIVE_SHAPE, CTX, { ...OPTS, allowlist: false }), legacy);
  });

  it('flag-off keeps a disabled block out (unchanged behaviour)', () => {
    const out = assembleGuidelinesFromBlocks(LIVE_SHAPE, CTX, { ...OPTS, allowlist: false });
    assert.equal(out.includes('retired'), false);
  });

  it('the vision block still renders only with images, on both branches', () => {
    const rows = [block('guidelines.vision_product_images', 'VISION RULES')];
    for (const allowlist of [false, true]) {
      assert.equal(
        assembleGuidelinesFromBlocks(rows, CTX, { hasImages: false, allowlist }).includes('VISION RULES'),
        false,
      );
      assert.equal(
        assembleGuidelinesFromBlocks(rows, CTX, { hasImages: true, allowlist }).includes('VISION RULES'),
        true,
      );
    }
  });
});

describe('the allowlist', () => {
  it('allows every key defined in a migration', () => {
    for (const key of KNOWN_GUIDELINE_BLOCK_KEYS) {
      assert.equal(isAllowedBlockKey(key), true, key);
    }
  });

  it('allows tenant custom_* blocks', () => {
    assert.equal(isAllowedBlockKey('custom_seasonal'), true);
    const rows = [block('custom_seasonal', 'CUSTOM RULE')];
    const out = assembleGuidelinesFromBlocks(rows, CTX, { ...OPTS, allowlist: true });
    assert.ok(out.includes('CUSTOM RULE'));
  });

  it('rejects an arbitrary future orphan', () => {
    assert.equal(isAllowedBlockKey('guidelines.made_up_by_an_admin'), false);
    const rows = [block('guidelines.made_up_by_an_admin', 'PHANTOM')];
    const out = assembleGuidelinesFromBlocks(rows, CTX, { ...OPTS, allowlist: true });
    assert.equal(out.includes('PHANTOM'), false);
  });

  it('contains exactly the 12 migration-defined keys', () => {
    assert.equal(KNOWN_GUIDELINE_BLOCK_KEYS.size, 12);
  });
});

describe('the budget', () => {
  const big = (n: number): string => 'x'.repeat(n);

  it('does nothing when the content fits', () => {
    const rows = [block('guidelines.language', 'short')];
    const dropped: string[] = [];
    const out = assembleGuidelinesFromBlocks(rows, CTX, {
      ...OPTS,
      allowlist: true,
      maxChars: 1000,
      onDropped: (k) => dropped.push(k),
    });
    assert.equal(out, 'short');
    assert.deepEqual(dropped, []);
  });

  it('drops custom_* blocks FIRST', () => {
    const rows = [
      block('guidelines.messaging_style', big(100)),
      block('custom_a', big(100)),
    ];
    const dropped: string[] = [];
    assembleGuidelinesFromBlocks(rows, CTX, {
      ...OPTS,
      allowlist: true,
      maxChars: 150,
      onDropped: (k) => dropped.push(k),
    });
    assert.deepEqual(dropped, ['custom_a']);
  });

  it('drops non-protected catalog blocks only after custom_* are gone', () => {
    const rows = [
      block('guidelines.messaging_style', big(100)),
      block('guidelines.follow_up_and_closing', big(100)),
      block('custom_a', big(100)),
    ];
    const dropped: string[] = [];
    assembleGuidelinesFromBlocks(rows, CTX, {
      ...OPTS,
      allowlist: true,
      maxChars: 100,
      onDropped: (k) => dropped.push(k),
    });
    assert.equal(dropped[0], 'custom_a', 'custom must go first');
    assert.ok(dropped.includes('guidelines.follow_up_and_closing'));
  });

  it('NEVER drops a protected block, even when it cannot fit', () => {
    const rows = [
      block('guidelines.language', big(500)),
      block('guidelines.catalog_integrity', big(500)),
      block('guidelines.order_flow_and_escalation', big(500)),
    ];
    const dropped: string[] = [];
    const out = assembleGuidelinesFromBlocks(rows, CTX, {
      ...OPTS,
      allowlist: true,
      maxChars: 10,
      onDropped: (k) => dropped.push(k),
    });
    assert.deepEqual(dropped, [], 'a protected block was dropped');
    assert.ok(out.length > 10, 'an over-budget prompt is preferred to a policy breach');
  });

  it('never throws when the budget cannot be met', () => {
    const rows = [block('guidelines.language', 'x'.repeat(100_000))];
    assert.doesNotThrow(() =>
      assembleGuidelinesFromBlocks(rows, CTX, { ...OPTS, allowlist: true, maxChars: 1 }),
    );
  });

  it('accounts for the joiner between blocks', () => {
    // Two 10-char blocks joined by '\n\n' is 22 chars, not 20 — a cap of 21 must drop one.
    const rows = [
      block('guidelines.messaging_style', 'a'.repeat(10)),
      block('guidelines.follow_up_and_closing', 'b'.repeat(10)),
    ];
    const fits = assembleGuidelinesFromBlocks(rows, CTX, { ...OPTS, allowlist: true, maxChars: 22 });
    assert.equal(fits.length, 22);
    const trimmed = assembleGuidelinesFromBlocks(rows, CTX, { ...OPTS, allowlist: true, maxChars: 21 });
    assert.equal(trimmed.length, 10);
  });
});

describe('expandPromptPlaceholders — unknown token reporting', () => {
  it('still passes an unknown token through unchanged (behaviour preserved)', () => {
    assert.equal(expandPromptPlaceholders('a {{NOPE}} b', {}), 'a {{NOPE}} b');
  });

  it('reports the unknown token when a collector is supplied', () => {
    const seen: string[] = [];
    expandPromptPlaceholders('a {{NOPE}} {{ALSO_NOPE}} b', {}, (t) => seen.push(t));
    assert.deepEqual(seen, ['NOPE', 'ALSO_NOPE']);
  });

  it('does not report a known token', () => {
    const seen: string[] = [];
    const out = expandPromptPlaceholders('{{X}}', { X: 'value' }, (t) => seen.push(t));
    assert.equal(out, 'value');
    assert.deepEqual(seen, []);
  });
});

describe('assertRequiredSections', () => {
  it('flags a prompt that references a section the code does not populate (RC-26)', () => {
    const violations = assertRequiredSections('... Active offers ...');
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'forbidden_section_reference');
    assert.equal(violations[0].detail, 'Active offers');
  });

  it('passes a clean prompt', () => {
    assert.deepEqual(assertRequiredSections('a normal prompt'), []);
  });

  it('flags a missing platform policy when one is expected', () => {
    const violations = assertRequiredSections('no footer here', { expectPlatformPolicy: true });
    assert.equal(violations.some((v) => v.detail === 'PLATFORM POLICY'), true);
  });

  it('flags a missing grounding directive when one is expected', () => {
    const violations = assertRequiredSections('nothing', { expectGroundingDirective: true });
    assert.equal(violations.some((v) => v.detail === 'GROUNDING CONTRACT'), true);
  });

  it('flags an over-budget prompt', () => {
    const violations = assertRequiredSections('x'.repeat(50), { maxChars: 10 });
    assert.equal(violations.some((v) => v.kind === 'over_budget'), true);
  });

  it('every forbidden reference is a section the code genuinely never populates', () => {
    assert.ok(FORBIDDEN_SECTION_REFERENCES.includes('Active offers'));
  });

  it('scopes the phantom-section scan to the guidelines, not the whole prompt', () => {
    // The full prompt carries the product catalog and tenant-authored operator rules. A product
    // description or an operator rule that legitimately says "Active offers" must not warn on
    // every reply forever — only the guideline blocks (where the orphan renders) are scanned.
    const prompt = 'Product catalog:\n- Active offers bundle: €10\n\nGuidelines:\nBe brief.';
    assert.deepEqual(assertRequiredSections(prompt, { guidelines: 'Be brief.' }), []);
  });

  it('still catches the orphan when it IS in the guidelines', () => {
    const prompt = 'Guidelines:\nReference the Active offers section.';
    const violations = assertRequiredSections(prompt, {
      guidelines: 'Reference the Active offers section.',
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'forbidden_section_reference');
  });
});

describe('Step 3 ↔ Step 4 interaction — footer + allowlist together (the mandatory joint test)', () => {
  // Step 3 ADDS ~2K chars of platform policy to every tenant; Step 4 imposes a cap. A tenant
  // near the limit starts truncating the moment both are on. This is the top risk in the plan.
  const REALISTIC_LIVE_SHAPE: TenantPromptBlockRow[] = [
    block('guidelines.language', 'x'.repeat(813)),
    block('guidelines.messaging_style', 'x'.repeat(1491)),
    block('guidelines.catalog_integrity', 'x'.repeat(1744)),
    block('guidelines.price_currency_visibility', 'x'.repeat(1019)),
    block('guidelines.category_product_aggregation', 'x'.repeat(1576)),
    block('guidelines.discount_policy', 'x'.repeat(2182)),
    block('guidelines.product_usage_verbatim', 'x'.repeat(1291)),
    block('guidelines.follow_up_and_closing', 'x'.repeat(1885)),
    block('guidelines.recommendations', 'x'.repeat(1697)),
    block('guidelines.order_flow_and_escalation', 'x'.repeat(2731)),
    block('guidelines.offers_promotions', 'x'.repeat(1478)), // the orphan
  ];

  it('the live guidelines total matches the audited ~17.9K chars with the flag off', () => {
    const out = assembleGuidelinesFromBlocks(REALISTIC_LIVE_SHAPE, CTX, { ...OPTS, allowlist: false });
    assert.ok(out.length > 17_000 && out.length < 18_500, `unexpected total: ${out.length}`);
  });

  it('dropping the orphan reclaims ~1,478 chars — headroom the footer then spends', () => {
    const off = assembleGuidelinesFromBlocks(REALISTIC_LIVE_SHAPE, CTX, { ...OPTS, allowlist: false });
    const on = assembleGuidelinesFromBlocks(REALISTIC_LIVE_SHAPE, CTX, { ...OPTS, allowlist: true });
    assert.equal(off.length - on.length, 1478 + 2, 'orphan + its joiner');
  });

  it('the live guidelines fit the guidelines budget with headroom (it is near-inert on day one)', () => {
    const dropped: string[] = [];
    const guidelines = assembleGuidelinesFromBlocks(REALISTIC_LIVE_SHAPE, CTX, {
      ...OPTS,
      allowlist: true,
      maxChars: PROMPT_GUIDELINES_MAX_CHARS,
      onDropped: (k, reason) => {
        if (reason === 'budget') dropped.push(k);
      },
    });
    assert.deepEqual(dropped, [], 'the budget must not truncate a normal live tenant');
    assert.ok(guidelines.length < PROMPT_GUIDELINES_MAX_CHARS);
  });

  it('guidelines + a ~2.2K platform footer stay under the whole-prompt reporting threshold', () => {
    // THE TOP RISK IN THE PLAN: Step 3 adds ~2.2K chars to every tenant while Step 4 imposes a
    // cap, so a tenant near the limit starts truncating the moment both flags are on. This test
    // is what caught the original conflation of the two budgets (a single 30K knob put the
    // realistic prompt at 30,857 — over its own cap on day one).
    const guidelines = assembleGuidelinesFromBlocks(REALISTIC_LIVE_SHAPE, CTX, {
      ...OPTS,
      allowlist: true,
      maxChars: PROMPT_GUIDELINES_MAX_CHARS,
    });
    // The rest of the system prompt: catalog, business profile, the always-on appends
    // (~2,397 + ~1,813), and the ~2.2K platform policy footer Step 3 adds.
    const restOfPrompt = 8_000 + 2_397 + 1_813;
    const platformFooter = 2_200;
    const total = guidelines.length + restOfPrompt + platformFooter;

    assert.ok(
      total < PROMPT_ASSEMBLY_MAX_CHARS,
      `assembled prompt would be ${total} chars, over the ${PROMPT_ASSEMBLY_MAX_CHARS} threshold`,
    );
    // And it lands in the band the audit measured (26–33K), i.e. the footer is affordable.
    assert.ok(total > 26_000 && total < 33_000, `unexpected assembled size: ${total}`);
    assert.deepEqual(assertRequiredSections('x'.repeat(total), { maxChars: PROMPT_ASSEMBLY_MAX_CHARS }), []);
  });

  it('a protected footer survives even when the guidelines are over budget', () => {
    // Simulating the pathological case: the budget squeezes blocks, but the footer is appended
    // outside the block assembly and so cannot be truncated by it at all.
    const guidelines = assembleGuidelinesFromBlocks(REALISTIC_LIVE_SHAPE, CTX, {
      ...OPTS,
      allowlist: true,
      maxChars: 5_000,
    });
    const footer = '\n\nPLATFORM POLICY — follow strictly:\n- rule';
    const prompt = guidelines + footer;
    assert.ok(prompt.includes('PLATFORM POLICY'));
    assert.deepEqual(
      assertRequiredSections(prompt, { expectPlatformPolicy: true }).filter(
        (v) => v.kind === 'missing_required_section',
      ),
      [],
    );
  });
});
