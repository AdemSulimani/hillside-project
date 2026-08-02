import { knobBool, knobNumber } from '../config/knobs';
import type { TenantPromptBlockRow } from '../db/models/promptBlock';

/** Mirrors `ReplyLocale` in aiService (kept separate to avoid circular imports). */
export type GuidelineAssemblyLocale = 'sq' | 'en';

const VISION_BLOCK_KEY = 'guidelines.vision_product_images';

/**
 * P2-5 (RC-26): render-time allowlist + prompt budget.
 *
 * THE DEFECT. `listTenantPromptBlocksRuntime` selects from `tenant_prompt_blocks` with NO join
 * to `prompt_blocks`, and this function filters only `row.enabled` — so the catalog's
 * `is_active` flag is never consulted at render time. An admin-created block
 * `guidelines.offers_promotions` (verified live: present in `prompt_blocks` with
 * `is_active = false`, absent from every migration, with all 6 tenant rows enabled and their FK
 * resolving) therefore injects ~1,478 chars into 6/6 tenants' prompts, instructing the model to
 * reference an "Active offers" section the code never populates → invented/confused offer talk.
 *
 * WHY A KEY ALLOWLIST rather than fixing the SQL to honour `is_active`:
 *   - The join is data-correct but untestable without a DB, and it would silently change
 *     `listTenantPromptBlocksRuntime` for EVERY caller — including catalogGuardReferenceService,
 *     which reads blocks into guard reference texts. Dropping a block there NARROWS the
 *     reference set, which WIDENS escalation: a side-effect at a distance in a safety path.
 *   - An allowlist also catches a future orphan that someone forgot to mark inactive, which the
 *     join never would.
 *   - This function is already pure, already the render decision point, and is the single choke
 *     point shared by both callers (the production reply path and the admin preview).
 * Fixing the SQL remains worth doing; it is deliberately deferred, not dropped.
 */
export const PROMPT_ALLOWLIST_BUDGET = knobBool('PROMPT_ALLOWLIST_BUDGET');

/**
 * Chars, not tokens, throughout: there is no tokenizer in this codebase and `estimateTokens` is
 * `text.length / 4` — a fiction calibrated for English that under-counts Albanian badly.
 * Laundering a char count through a fake token count would only obscure the number.
 *
 * TWO DISTINCT BUDGETS. These measure different things and must not share a knob:
 *
 *   PROMPT_GUIDELINES_MAX_CHARS — a TRUNCATING cap on the assembled guideline blocks alone
 *     (~17.9K live, ~16.4K once the orphan is dropped). This is the part P2-5 can actually
 *     shed, because block priority is known here and the footer is appended elsewhere.
 *
 *   PROMPT_ASSEMBLY_MAX_CHARS — a REPORTING threshold on the FULL assembled system prompt
 *     (guidelines + catalog + business profile + the always-on appends + the footer). Nothing
 *     is truncated against it: it is the RC-26 "the system prompt is unbudgeted" instrument.
 *
 * Both defaults are deliberately generous — flag-on should be observable-but-near-inert, then
 * tightened with ledger data. A cap that bites on day one is a cap that gets reverted. The audit
 * measured live prompts at 26–33K chars, so 34K reports genuine outliers rather than the status
 * quo; with a realistic 8K catalog and Step 3's ~2.2K footer the assembled prompt lands ~30.9K
 * (pinned by the interaction test).
 *
 * P3-5 (step 0): both used to be read by a local `readCharBudget(name, fallback)` doing
 * `process.env[name]` — an indirection that ACCIDENTALLY DEFEATED the manifest's own guard.
 * `knobs.test.ts`'s "no numeric knob is also parsed inline" check greps for the literal
 * `process.env.KEY` / `process.env['KEY']`, which a variable index never matches. The two parsers
 * then disagreed for real: `readCharBudget` accepted any positive integer, so
 * `PROMPT_GUIDELINES_MAX_CHARS=5` truncated every non-protected block at runtime while
 * `config:check` reported it out-of-band — exactly the two-sources-of-truth defect P2-7 removed.
 * They now read through `knobNumber`, so the band in the manifest is the band in force.
 *
 * Still module consts, not per-call reads: they are declared `frozen` (a mid-process change to a
 * prompt budget would make two replies in one conversation incomparable), and the assembly tests
 * import them as values.
 */
export const PROMPT_GUIDELINES_MAX_CHARS = knobNumber('PROMPT_GUIDELINES_MAX_CHARS');
export const PROMPT_ASSEMBLY_MAX_CHARS = knobNumber('PROMPT_ASSEMBLY_MAX_CHARS');

/**
 * Every guideline block key ever defined in a migration — the allowlist's source of truth.
 * 036 (11 keys), 049 (category_product_aggregation), 050 (product_description_responses, later
 * retired by 056 but still present as a disabled row on all 6 tenants).
 *
 * NOT in this list, deliberately: `guidelines.offers_promotions` — admin-created, in no
 * migration, catalog-inactive, and the RC-26 orphan.
 */
export const KNOWN_GUIDELINE_BLOCK_KEYS: ReadonlySet<string> = new Set([
  'guidelines.language',
  'guidelines.messaging_style',
  'guidelines.catalog_integrity',
  'guidelines.price_currency_visibility',
  'guidelines.category_product_aggregation',
  'guidelines.discount_policy',
  'guidelines.product_usage_verbatim',
  'guidelines.follow_up_and_closing',
  'guidelines.recommendations',
  'guidelines.order_flow_and_escalation',
  'guidelines.vision_product_images',
  'guidelines.product_description_responses',
]);

/**
 * Blocks that must never be dropped by the budget: the language lock is the whole basis of
 * Albanian reply correctness, and catalog_integrity/order_flow are the safety-bearing rules.
 * These mirror the platform-locked set in the catalog.
 */
export const BUDGET_PROTECTED_BLOCK_KEYS: ReadonlySet<string> = new Set([
  'guidelines.language',
  'guidelines.catalog_integrity',
  'guidelines.order_flow_and_escalation',
  'guidelines.price_currency_visibility',
  'guidelines.category_product_aggregation',
]);

/**
 * Section names the assembled prompt must never reference, because the code does not populate
 * them. This is RC-26's own regression test — it is what makes the orphan's removal permanent
 * rather than a one-time cleanup.
 */
export const FORBIDDEN_SECTION_REFERENCES: readonly string[] = ['Active offers'];

/** A known catalog key, or a tenant's own custom block (`custom_*`, `prompt_block_id` NULL). */
export function isAllowedBlockKey(key: string): boolean {
  return KNOWN_GUIDELINE_BLOCK_KEYS.has(key) || key.startsWith('custom_');
}

/** Expand {{TOKEN}} placeholders in guideline blocks; unknown tokens stay unchanged. */
export function expandPromptPlaceholders(
  template: string,
  map: Record<string, string>,
  onUnknownToken?: (token: string) => void,
): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, token: string) => {
    if (Object.prototype.hasOwnProperty.call(map, token)) return map[token];
    // P2-5 (RC-26): an unknown token used to pass through silently, so a typo'd or retired
    // placeholder shipped a literal "{{FOO}}" to the model with nothing to notice it.
    onUnknownToken?.(token);
    return `{{${token}}}`;
  });
}

export type GuidelinePlaceholderContext = {
  language: GuidelineAssemblyLocale;
};

export function buildGuidelinePlaceholderMap(ctx: GuidelinePlaceholderContext): Record<string, string> {
  const isSq = ctx.language === 'sq';
  const languageName = isSq ? 'Albanian (shqip)' : 'English';
  const otherLanguageName = isSq ? 'English' : 'Albanian';

  const orderClosingExample = isSq ? 'A doni ta porosisni?' : 'Would you like to order it?';
  const orderClosingFallback = isSq
    ? 'Produkti është në dispozicion nëse doni ta porosisni'
    : 'The product is available if you would like to order it';

  const discountOfferExample = isSq
    ? "Mund t'jua ofrojmë me [discounted_price]."
    : 'We can offer it for [discounted_price].';

  const noFurtherDiscountSentence = isSq
    ? 'Më vjen keq, nuk mund të aplikohet zbritje shtesë. Çmimi që ju ofruam është final.'
    : 'I am sorry, no additional discount can be applied. The price we offered is final.';

  const noDiscountAvailableSentence = isSq
    ? 'Për këtë produkt nuk është e mundur asnjë zbritje, çmimi aktual është final.'
    : 'No discount is available for this product; the current price is final.';

  const orderConfirmationFollowUp = isSq
    ? 'Nëse keni pyetje të tjera ose doni të porosisni sërish, jam këtu për t\u2019ju ndihmuar.'
    : 'I\u2019m here if you have other questions or want to order again.';

  const dataConfirmationSentence = isSq
    ? 'Faleminderit për porosinë! A mund të konfirmoni që të dhënat që keni dhënë janë korrekte?'
    : 'Thank you for your order! Please confirm the information you provided is correct.';

  const postPurchaseIssueSentence = isSq
    ? 'Na vjen keq për problemin. Një anëtar i ekipit tonë do t\u2019ju përgjigjet së shpejti.'
    : 'Sorry about the issue. A team member will get back to you shortly.';

  const fixedPhraseLanguageDirective = isSq ? 'In Albanian use exactly' : 'In English use exactly';
  const orderConfirmationLanguageDirective = isSq
    ? 'in Albanian only (this is the ONLY follow-up allowed in an order-confirmation reply, and it must appear exactly once)'
    : 'in English only (this is the ONLY follow-up allowed in an order-confirmation reply, and it must appear exactly once)';
  const postPurchaseLanguageDirective = isSq
    ? 'reply with exactly one Albanian sentence and nothing else'
    : 'reply with exactly one English sentence and nothing else';

  return {
    LANGUAGE_NAME: languageName,
    OTHER_LANGUAGE_NAME: otherLanguageName,
    ORDER_CLOSING_EXAMPLE: orderClosingExample,
    ORDER_CLOSING_FALLBACK: orderClosingFallback,
    DISCOUNT_OFFER_EXAMPLE: discountOfferExample,
    DISCOUNT_RULE_NO_FURTHER: `${fixedPhraseLanguageDirective}: "${noFurtherDiscountSentence}"`,
    DISCOUNT_RULE_NONE_AVAILABLE: `${fixedPhraseLanguageDirective}: "${noDiscountAvailableSentence}"`,
    ORDER_CONFIRMATION_CLOSING_RULE: `- If you confirm that an order is placed/confirmed, end the message with this exact follow-up sentence ${orderConfirmationLanguageDirective}: "${orderConfirmationFollowUp}"`,
    DELIVERY_ETA_NOTE: `- When the business has configured a delivery-time window in the CRM, the platform inserts one ${languageName} sentence with that ETA immediately before that follow-up; do not add your own separate delivery-arrival time line in order-confirmation replies (avoid duplicating it).`,
    POST_PURCHASE_ESCALATION_RULE: `- If the customer reports a delivery delay/non-delivery, wrong item received, or product defect/problem after purchase, ${postPurchaseLanguageDirective}: "${postPurchaseIssueSentence}"`,
    DATA_CONFIRMATION_SENTENCE: `"${dataConfirmationSentence}"`,
  };
}

export interface GuidelineAssemblyOptions {
  hasImages: boolean;
  /** P2-5: apply the render-time key allowlist + char budget. Defaults to the flag. */
  allowlist?: boolean;
  /**
   * P2-5: TRUNCATING char budget for the assembled guideline blocks (not the whole prompt —
   * that is `PROMPT_ASSEMBLY_MAX_CHARS`, a reporting threshold). Only consulted when
   * `allowlist` is on.
   */
  maxChars?: number;
  /** P2-5: called for each `{{TOKEN}}` with no value — reported, never thrown. */
  onUnknownToken?: (token: string) => void;
  /** P2-5: called for each block the allowlist or the budget removed. */
  onDropped?: (blockKey: string, reason: 'allowlist' | 'budget') => void;
  /**
   * P3-5: called ONCE for every block this assembly considered — rendered or not — with the
   * content as STORED. This is the ledger's block-version provenance.
   *
   * A callback rather than a changed return type on purpose: `assembleGuidelinesFromBlocks`
   * returns a `string` to two callers (the reply path and the admin preview) and to
   * `conciseResponseRules.test.ts`; widening the return would churn all of them for information
   * only one caller wants. Mirrors `onDropped` / `onUnknownToken` above.
   *
   * `content` is the STORED template, pre-placeholder-expansion — see
   * `promptBlockContentHash`'s contract for why hashing the expanded text would make every
   * reply report an unknown version.
   */
  onBlock?: (block: {
    blockKey: string;
    content: string;
    rendered: boolean;
    dropReason?: PromptBlockDropReason;
  }) => void;
}

/**
 * Why a block considered by the assembly did not reach the prompt.
 *
 * `empty` is its own reason rather than being folded into one of the others: a block whose content
 * expands to nothing is a CONFIGURATION mistake (someone blanked it, or every placeholder in it
 * resolved away), and it is invisible in the assembled prompt by definition. Recording it as
 * `disabled` would misattribute it to a deliberate toggle.
 */
export type PromptBlockDropReason =
  | 'allowlist'
  | 'budget'
  | 'disabled'
  | 'vision_absent'
  | 'empty';

export function assembleGuidelinesFromBlocks(
  rows: TenantPromptBlockRow[],
  placeholderCtx: GuidelinePlaceholderContext,
  opts: GuidelineAssemblyOptions,
): string {
  const applyAllowlist = opts.allowlist ?? PROMPT_ALLOWLIST_BUDGET;
  const maxChars = opts.maxChars ?? PROMPT_GUIDELINES_MAX_CHARS;

  const map = buildGuidelinePlaceholderMap(placeholderCtx);
  const sorted = [...rows].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.block_key.localeCompare(b.block_key);
  });

  // P3-5: every block this assembly LOOKED at, with the content as stored. Emitted through
  // `onBlock` at the end rather than inline, because a block kept by the loop can still be dropped
  // by the budget below — reporting it as rendered mid-loop would be a lie the ledger then records.
  const considered: Array<{
    blockKey: string;
    content: string;
    rendered: boolean;
    dropReason?: PromptBlockDropReason;
  }> = [];
  const reject = (row: TenantPromptBlockRow, dropReason: PromptBlockDropReason): void => {
    considered.push({ blockKey: row.block_key, content: row.content, rendered: false, dropReason });
  };

  const kept: Array<{ key: string; text: string }> = [];
  for (const row of sorted) {
    if (!row.enabled) {
      reject(row, 'disabled');
      continue;
    }
    if (row.block_key === VISION_BLOCK_KEY && !opts.hasImages) {
      reject(row, 'vision_absent');
      continue;
    }
    // P2-5 (RC-26): reject blocks with no migration-defined parent — the orphan
    // `guidelines.offers_promotions` is exactly this.
    if (applyAllowlist && !isAllowedBlockKey(row.block_key)) {
      opts.onDropped?.(row.block_key, 'allowlist');
      reject(row, 'allowlist');
      continue;
    }
    const expanded = expandPromptPlaceholders(row.content, map, opts.onUnknownToken).trim();
    if (expanded) {
      kept.push({ key: row.block_key, text: expanded });
      considered.push({ blockKey: row.block_key, content: row.content, rendered: true });
    } else {
      reject(row, 'empty');
    }
  }

  const emit = (budgetDropped?: ReadonlySet<string>): void => {
    if (!opts.onBlock) return;
    for (const block of considered) {
      if (block.rendered && budgetDropped?.has(block.blockKey)) {
        opts.onBlock({ ...block, rendered: false, dropReason: 'budget' });
      } else {
        opts.onBlock(block);
      }
    }
  };

  if (!applyAllowlist) {
    emit();
    return kept.map((k) => k.text).join('\n\n');
  }

  const budgetDropped = new Set<string>();
  const assembled = applyGuidelineBudget(kept, maxChars, (blockKey, reason) => {
    if (reason === 'budget') budgetDropped.add(blockKey);
    opts.onDropped?.(blockKey, reason);
  });
  emit(budgetDropped);
  return assembled;
}

const JOINER = '\n\n';

/** Total assembled length for a set of blocks, joined by the standard separator. */
function assembledLength(blocks: ReadonlyArray<{ text: string }>): number {
  if (blocks.length === 0) return 0;
  return blocks.reduce((sum, b) => sum + b.text.length, 0) + JOINER.length * (blocks.length - 1);
}

/**
 * Drops blocks until the assembled guidelines fit the budget.
 *
 * Order — least load-bearing first, and within each tier the LAST-sorted block goes first (the
 * earliest `sort_order` blocks are the foundational ones):
 *   1. `custom_*` tenant blocks
 *   2. non-protected catalog blocks
 *   3. stop — protected blocks are never dropped
 *
 * Still over budget after 1 and 2 means only protected blocks remain: report and return them
 * anyway. An over-budget prompt is a degradation; a prompt missing the language lock or the
 * catalog-integrity rules is a correctness and policy breach. Never throws.
 */
function applyGuidelineBudget(
  blocks: Array<{ key: string; text: string }>,
  maxChars: number,
  onDropped?: (blockKey: string, reason: 'allowlist' | 'budget') => void,
): string {
  const kept = [...blocks];

  const dropOne = (predicate: (key: string) => boolean): boolean => {
    for (let i = kept.length - 1; i >= 0; i--) {
      if (predicate(kept[i].key)) {
        onDropped?.(kept[i].key, 'budget');
        kept.splice(i, 1);
        return true;
      }
    }
    return false;
  };

  while (assembledLength(kept) > maxChars) {
    if (dropOne((key) => key.startsWith('custom_'))) continue;
    if (dropOne((key) => !BUDGET_PROTECTED_BLOCK_KEYS.has(key))) continue;
    break;
  }

  return kept.map((k) => k.text).join(JOINER);
}

export interface AssemblyViolation {
  kind: 'missing_required_section' | 'forbidden_section_reference' | 'over_budget';
  detail: string;
}

/**
 * Asserts the structural invariants of a fully assembled system prompt.
 *
 * Returns violations rather than throwing: in production these are logged and recorded, never
 * fatal (the house convention — a degraded prompt still beats a dropped customer message).
 * Tests assert the list is empty.
 */
export function assertRequiredSections(
  prompt: string,
  ctx: {
    expectPlatformPolicy?: boolean;
    expectGroundingDirective?: boolean;
    maxChars?: number;
    /**
     * The assembled guideline blocks alone. The forbidden-section scan runs against THIS, not the
     * full prompt: the orphan's phantom "Active offers" reference lives in a guideline block,
     * whereas the full prompt also carries the product catalog and tenant-authored operator rules
     * — a product description or an operator rule that legitimately says "Active offers" would
     * otherwise warn on every single reply, forever. Omit to scan the whole prompt (tests).
     */
    guidelines?: string;
  } = {},
): AssemblyViolation[] {
  const violations: AssemblyViolation[] = [];

  if (ctx.expectPlatformPolicy && !prompt.includes('PLATFORM POLICY')) {
    violations.push({ kind: 'missing_required_section', detail: 'PLATFORM POLICY' });
  }
  if (ctx.expectGroundingDirective && !prompt.includes('GROUNDING CONTRACT')) {
    violations.push({ kind: 'missing_required_section', detail: 'GROUNDING CONTRACT' });
  }

  // RC-26: the prompt must reference no section the code does not populate.
  const forbiddenScope = ctx.guidelines ?? prompt;
  for (const section of FORBIDDEN_SECTION_REFERENCES) {
    if (forbiddenScope.includes(section)) {
      violations.push({ kind: 'forbidden_section_reference', detail: section });
    }
  }

  if (ctx.maxChars !== undefined && prompt.length > ctx.maxChars) {
    violations.push({
      kind: 'over_budget',
      detail: `${prompt.length} > ${ctx.maxChars}`,
    });
  }

  return violations;
}
