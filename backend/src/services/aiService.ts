import { knobBool, knobNumber, knobString } from '../config/knobs';
import { upsertPromptBlob } from '../db/models/promptBlob';
import { openai, OPENAI_CHAT_MODEL, OPENAI_CLASSIFIER_MODEL, OPENAI_VISION_MODEL } from './openaiClient';
import { withModelRole } from './openaiCallTracker';
import type { ProductImageRef } from './productImageRequestService';
import { filterProductsMentionedInTexts, productNameTokenMatch } from './productImageRequestService';
import {
  resolveInboundNamedProducts,
  resolveGramsToProducts,
  extractCandidateNameGrams,
} from './inboundNamePinning';
import {
  FACTS_USED_JSON_SCHEMA,
  parseFactsUsedCompletion,
  type DeclaredFact,
} from './groundingGate';
export type { ProductImageRef };
import { findTenantById } from '../db/models/tenant';
import {
  collectRecentlyDiscussedProductContext,
  collectRecentlyDiscussedProductIds,
  findMessagesByConversation,
  type Message,
} from '../db/models/message';
import {
  countActiveProducts,
  countProductsWithoutEmbeddings,
  findActiveProductsByIds,
  searchProducts,
  searchProductsByCatalogPhrases,
  searchProductsByDisjunctiveTerms,
  searchProductsBySimilarity,
  type Product,
} from '../db/models/product';
import { findAIConfigByTenant, type AIConfig } from '../db/models/aiConfig';
import { findConversationById } from '../db/models/conversation';
import {
  AI_CONFIG_VERSIONED_CACHE,
  aiConfigVersion,
  cacheSetIfNewer,
  normalizeAiConfig,
  promptBlocksVersion,
  readVersionedCache,
  readVersionedCacheWithVersion,
  versionedAiConfigKey,
  versionedPromptBlocksKey,
} from './aiConfigCache';
import { getReceiptSnapshot, isCachedConfigStale } from './receiptSnapshot';
import { isCannedHoldingCopy } from './cannedReplyText';
import { historyRoleFor, keepMessageInHistory } from './historyTranscript';
import {
  buildConversationSummary,
  type SummaryMessage,
  type SummaryProduct,
} from './conversationSummary';
import {
  forceSyncLockedBlocksForTenant,
  listTenantPromptBlocksRuntime,
  seedTenantPromptBlocksFromCatalog,
  type TenantPromptBlockRow,
} from '../db/models/promptBlock';
import {
  PROMPT_ALLOWLIST_BUDGET,
  PROMPT_ASSEMBLY_MAX_CHARS,
  assembleGuidelinesFromBlocks,
  assertRequiredSections,
  type AssemblyViolation,
} from './promptAssemblyService';
import { logSafe, logSafeStructured, redactPII } from '../utils/redact';
import { logger } from '../utils/logger';
import { createHash } from 'node:crypto';
import { computeCost } from './modelPricing';
import type {
  PromptAssemblyProvenance,
  PromptBlockProvenance,
  ReplyTelemetry,
  RetrievalTelemetry,
  RetrievalTelemetrySink,
} from './aiTelemetry';
import { promptBlockContentHash } from '../db/models/promptBlockVersion';
import {
  collectPromptAssemblyIssues,
  raisePromptAssemblyAlerts,
} from './promptAssemblyAlerts';
import {
  LOCKED_CATALOG_MARKER_KEY,
  tenantSyncMarkerKey,
} from './promptRegistryReconcile';
import {
  applySectionBudget,
  joinSections,
  type PromptSection,
  type SectionPriority,
} from './promptSectionBudget';
import { permanentUrlToFilePath, fileToBase64DataUrl } from './attachmentStorageService';
import {
  activeEmbeddingModel,
  getOrComputeQueryEmbedding,
  logSemanticSkipped,
  partitionBySimilarityBand,
  SEMANTIC_BAND_EXTRA_DEPTH,
  SEMANTIC_BAND_WEIGHT,
  SIMILARITY_HYSTERESIS_BAND,
} from './retrievalReliability';
import { matchProductsFromCustomerImages } from './productImageMatchingService';
import { getProductImageDerivedContext } from './productImageAttributeService';
import { redisConnection } from '../jobs/redisConnection';
import { enqueueMissingEmbeddingsForTenant } from '../jobs/reconcileProductEmbeddings';
import {
  buildCategoryAggregationInstructions,
  buildProductAttributeAggregation,
  CATEGORY_GROUP_MATCH_LIMIT,
  detectProductQueryScope,
  expandProductsForAttributeQuery,
  extractConversationProductAnchor,
  isCategoryAttributeFollowUp,
  resolveProductsForContextualQuery,
  type AttributeQueryIntentHint,
} from './productRetrievalService';
import {
  classifyProductAttributeIntent,
  isAttributeQuestionMessage,
  type ProductAttributeIntentResult,
} from './productAttributeIntentService';
import {
  computeCatalogTextEvidence,
  formatCatalogDescriptionExcerpts,
  formatCatalogDescriptionLine,
  formatCatalogUsageExcerpts,
  formatCatalogUsageLine,
  isProductDescriptionQuestion,
  isProductRecommendationOrComparisonQuestion,
  PRICE_LIST_COMPACT_APPEND,
  PRODUCT_DESCRIPTION_CONCISE_APPEND,
  PRODUCT_DESCRIPTION_TARGETED_APPEND,
  SHORTEST_ANSWER_APPEND,
  type CatalogTextDecision,
  type CatalogTextEvidenceResult,
  type CatalogTextMode,
} from './productDescriptionPromptService';
import {
  USAGE_QUESTION_KEYWORDS,
  includesAnyKeyword,
  matchesUsageQuestionKeyword,
  containsSpeculativeHealthAdvice,
} from './usageSuitabilityHelpers';
import {
  CONFIDENCE_CONTRACT_SYMMETRY,
  enforceConfidenceContract,
  hasUsableConfidence,
  normalizeClassifierConfidence,
  resolveEscalationConfidenceDetailed,
} from './classifierConfidenceContract';
import {
  DIALECT_NORMALIZATION,
  extractDialectKeywords,
  foldDialect,
} from './dialectNormalization';
import { GHEG_ALBANIAN_MARKERS, GHEG_LEXICONS, withGhegMarkers } from './ghegLexicons';
import { lexicallyAsksAboutPrice } from './priceIntentLexicon';
import { applyHistoryBudget } from './historyBudget';
import {
  RESTRICTIONS_FOOTER_ALL_TENANTS,
  buildRestrictionsFooter,
  usesPlatformPolicyDefault,
} from './platformPolicy';
import { resolveStickyLocale } from './stickyLocale';

export { USAGE_QUESTION_KEYWORDS, includesAnyKeyword, matchesUsageQuestionKeyword, containsSpeculativeHealthAdvice };

// 0.65 gives a better recall/precision balance for large catalogs where many
// products share semantic space (e.g. supplements, cosmetics). The old 0.75
// default caused too many false-negatives: correct products scored 0.70–0.74
// and were silently discarded, pushing execution into the 5-product fallback.
// Operators can override this via the SIMILARITY_THRESHOLD env variable.
//
// P2-7: read through the manifest, which supplies the NaN guard this line lacked. It was a bare
// `parseFloat(process.env.SIMILARITY_THRESHOLD || '0.65')`, so `SIMILARITY_THRESHOLD=o.65` (an easy
// typo) produced NaN — and since every `similarity >= NaN` is false, semantic retrieval went
// silently dead fleet-wide with no error. The band + boot warning now make that loud.
const SIMILARITY_THRESHOLD = knobNumber('SIMILARITY_THRESHOLD');
// P1-5: cap on the masked system-prompt copy stored in the decision ledger. Enough to see the
// persona/blocks/footer/injected directives without persisting the full 26–33K-char prompt.
const LEDGER_PROMPT_PREVIEW_MAX_CHARS = 12000;
// P2-4 (F2): when on, the FULL redacted system prompt is stored content-addressed in
// ai_prompt_blobs (migration 082) and the ledger row's prompt.system_hash joins to it.
const LEDGER_PROMPT_BLOBS = knobBool('LEDGER_PROMPT_BLOBS');
/** P3-5 (RC-26/RC-17): stamp block-version + assembly provenance into the ledger row. */
const PROMPT_BLOCK_REGISTRY = knobBool('PROMPT_BLOCK_REGISTRY');
/** P3-5 (RC-26): raise a deduped ai_alerts row for an orphan key / assembly violation. */
const PROMPT_ASSEMBLY_ALERTS = knobBool('PROMPT_ASSEMBLY_ALERTS');
/** P3-5: skip the per-reply locked-block force-sync when the catalog marker is unchanged. */
const PROMPT_SELF_HEAL_OFF_HOT_PATH = knobBool('PROMPT_SELF_HEAL_OFF_HOT_PATH');
/** P3-5 (R4/R16): an explicit price word in the inbound counts as price intent on its own. */
const PRICE_INTENT_LEXICAL_UNION = knobBool('PRICE_INTENT_LEXICAL_UNION');
/**
 * P3-5 (RC-26): whole-prompt budget mode — `off` | `shadow` | `enforce`. Declared `frozen`, so
 * read once here: two replies in one conversation assembled under different budgets would not be
 * comparable, which is exactly the drift the fingerprint exists to make visible.
 */
const PROMPT_SECTION_BUDGET_MODE = knobString('PROMPT_SECTION_BUDGET');
/**
 * P0-B follow-up scope (shares the GAP_FOCAL_PRODUCT_SCOPE knob with processAIReply's gap
 * machinery): at `on`, the persisted-context resolver narrows the discussed set to the products
 * the source AI reply actually WROTE OUT — `message.product_ids` persists the whole fused pool
 * (10–25 rows), and feeding the pool to a follow-up turn is what listed 4 unrelated creatines'
 * flavors and escalated "shija" after "Po, kemi BSN Creatine 216gr…".
 */
const GAP_FOCAL_PRODUCT_SCOPE_MODE = ((): 'off' | 'shadow' | 'on' => {
  const v = knobString('GAP_FOCAL_PRODUCT_SCOPE').trim().toLowerCase();
  return v === 'on' || v === 'shadow' ? v : 'off';
})();
// Log the live value once at startup so operators always know which threshold is active
// (the .env.example default of 0.65 and an overriding SIMILARITY_THRESHOLD=0.75 both
// used to be in circulation, causing silent config drift in deployed environments).
console.info('[aiService] SIMILARITY_THRESHOLD resolved to', SIMILARITY_THRESHOLD);

/** How many catalog rows we consider for matching + OOS canned detection (needs the named SKU in-list). */
const FOCUSED_PRODUCT_MATCH_LIMIT = 10;

/**
 * Reply language. The AI mirrors the customer's language: Albanian (`sq`) or English (`en`).
 * Default for ambiguous/empty input is `sq` to preserve legacy behaviour.
 */
export type ReplyLocale = 'sq' | 'en';

export const DEFAULT_REPLY_LOCALE: ReplyLocale = 'sq';

/**
 * P2-2 (RC-10): when ON, the resolved reply locale is a sticky per-conversation slot —
 * `detectReplyLanguage` reuses the persisted locale unless THIS turn carries a high-confidence
 * unambiguous opposite-language marker (hysteresis), so ambiguous turns (ok/po/yes/emoji) can't
 * flip the language mid-thread and the stochastic LLM language call is skipped entirely. The hard
 * `'sq'` default is then reached only when both the sticky slot and fresh detection are unknown.
 * Defaults OFF: flag-off preserves the per-turn detection byte-for-byte. The caller persists the
 * resolved locale.
 */
export const STICKY_LOCALE_SLOT =
  (process.env.STICKY_LOCALE_SLOT ?? 'false').trim().toLowerCase() === 'true';

/**
 * P2-3 (RC-16): when ON, the reassembled history excludes never-delivered (send-failed) non-customer
 * rows and relabels delivered-but-non-authoritative rows (flagged low-quality replies + canned
 * holding/escalation/procedural copy) from `assistant` to `system`, so the model stops
 * re-conditioning on its own bad or phantom prior output. Defaults OFF: flag-off keeps the binary
 * `sent_by==='customer' ? 'user' : 'assistant'` mapping byte-for-byte.
 */
const HISTORY_DELIVERY_FILTERED =
  (process.env.HISTORY_DELIVERY_FILTERED ?? 'false').trim().toLowerCase() === 'true';

/**
 * P2-3 (RC-13): when ON, the older-context summary is rebuilt from the PERSISTED slot store
 * (name/phone/address/order_stage + the last-recommendation anchor, migrations 077/078) plus a
 * bounded extractive tail — so load-bearing facts survive past the 40-row window and the AI never
 * re-asks a provided field or denies a previously-recommended in-stock product. Defaults OFF:
 * flag-off runs the legacy customer-message-only `summarizeOlderConversationContext` byte-for-byte
 * and writes no slots.
 */
export const SUMMARY_SLOT_BACKED =
  (process.env.SUMMARY_SLOT_BACKED ?? 'false').trim().toLowerCase() === 'true';

/**
 * Hard cap (characters) on the slot-backed summary's extractive tail — the RC-26 unbudgeted-prompt
 * guard. Read through the P2-7 manifest.
 */
const SUMMARY_SLOT_BACKED_MAX_TAIL_CHARS = knobNumber('SUMMARY_SLOT_BACKED_MAX_TAIL_CHARS');

const CONTEXT_MAX_HISTORY_TOKENS = (() => {
  const raw = process.env.CONTEXT_MAX_HISTORY_TOKENS;
  if (raw === undefined || raw.trim() === '') return 6000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 6000;
})();
const RECENT_RAW_HISTORY_MESSAGES = 10;

/**
 * Single source of truth for how many recent messages every AI decision path loads for
 * a conversation — the reply generator, the intent classifiers, and the burst/context
 * builder in processAIReply all use this. Keeping them identical prevents the situation
 * where intent routing and product resolution "see" a different slice of the conversation
 * than the generator that writes the reply, which previously produced contradictory
 * handling within a single turn. Configurable via env so it can be tuned without a deploy.
 */
export const HISTORY_FETCH_LIMIT = knobNumber('AI_HISTORY_FETCH_LIMIT');

/**
 * Sampling temperature for the customer-facing reply.
 *
 * ⚠️ A LOW temperature REDUCES run-to-run variation. It does NOT eliminate it, and this default
 * (0.3) is NOT deterministic. P2-7 (RC-03) corrected this comment, which previously asserted that a
 * low default "makes the assistant resolve the prompt the SAME way every time" — the audit's
 * live-replay disproved that directly at this exact setting: replaying one fixed prompt 8× produced
 * `distinctRepliesPerInput=[1,3,8]` for three inputs, and several of the 8 variants of one reply
 * fabricated product claims that passed the name guard and the quality eval (EV-044). The old
 * wording is how a reader concludes determinism is handled here when it is not.
 *
 * Actual determinism comes from the P2-1 facts_used contract (temperature 0 + a fixed AI_REPLY_SEED
 * + a json_schema response_format), which is gated behind FACTS_USED_CONTRACT and is DEFAULT OFF —
 * so the production reply path is still stochastic. `validateEnv` says so at boot rather than
 * leaving it to be inferred.
 *
 * Tunable via AI_REPLY_TEMPERATURE without a deploy. Banded [0,1] by the manifest: the API accepts
 * up to 2, but a customer-facing reply above ~1 is unusable prose, so the band is deliberately
 * tighter than the API's.
 */
const AI_REPLY_TEMPERATURE = knobNumber('AI_REPLY_TEMPERATURE');

/**
 * P2-1 (RC-03) — the `facts_used` generation contract. When ON, the customer reply is produced
 * DETERMINISTICALLY (temperature 0 + a fixed seed) with a json_schema `response_format` returning
 * `{ facts_used, prose }`, so the reply's asserted facts can be validated against the catalog by
 * the consolidated grounding gate. Default OFF preserves the legacy free-prose generation
 * byte-for-byte. Applied ONLY to the non-vision text path and skipped for `custom_model_id`
 * tenants (fine-tuned models may not support structured outputs — they keep legacy generation
 * until validated). Turning this on WITHOUT the gate is the shadow window: declared facts are
 * emitted + persisted while the legacy guards still decide.
 */
const FACTS_USED_CONTRACT =
  (process.env.FACTS_USED_CONTRACT ?? 'false').trim().toLowerCase() === 'true';

/**
 * Fixed seed for the deterministic reply completion (RC-03). Env-overridable.
 *
 * NOTE this seed reaches the API on exactly ONE path — the facts_used contract below. On the
 * default (flag-off) path no seed is sent at all.
 */
const AI_REPLY_SEED = knobNumber('AI_REPLY_SEED');

/**
 * max_tokens for the contract completion: the 768-token prose budget plus headroom for the
 * `facts_used` JSON wrapper. A truncated structured output (`finish_reason:length`) is treated as
 * a retryable generation failure by `parseFactsUsedCompletion`.
 */
const FACTS_CONTRACT_MAX_TOKENS = knobNumber('FACTS_CONTRACT_MAX_TOKENS');

/**
 * Appended to the system prompt ONLY when the contract is active, so the default prompt is
 * unchanged (respects the unbudgeted-prompt concern, RC-26). Instructs the model to ground every
 * stated fact in the product context and to declare it in `facts_used`.
 */
const GROUNDING_DIRECTIVE =
  '\n\n---\nGROUNDING CONTRACT: You may ONLY state prices, product names, and product ' +
  'attributes that appear in the product context above. Never invent or guess a price, product ' +
  'name, or attribute. Respond with a JSON object of two fields: "prose" (your reply to the ' +
  'customer, in the language you would normally use) and "facts_used" (every price, product ' +
  'name, and attribute value your prose states, each as {"type","product_ref","value"} taken ' +
  'verbatim from the product context). State no such fact and return an empty facts_used list.';

/** Rough GPT token estimate: ~4 characters per token. */
function estimateTokens(text: string): number {
  return text.length / 4;
}

/**
 * P1-3 (RC-07) log-only measurement (migration path step 1): emit a structured,
 * behaviour-neutral marker whenever a detector asserts its intent boolean but the model
 * omitted/invalidated `confidence` and it normalizes to 0 — the exact malformed-output case
 * where the legacy code boosted (four escalation paths) or silently forfeited the order
 * (affirmation path). Grep `[CONFIDENCE_CONTRACT]` to measure the real boost-applied
 * frequency before/after flipping CONFIDENCE_CONTRACT_SYMMETRY. (When P1-5's decision ledger
 * lands this becomes a ledger field; until then it is a log line.)
 */
function logMissingConfidenceContract(
  detector: string,
  rawConfidence: unknown,
  intentAsserted: boolean,
): void {
  if (!intentAsserted || normalizeClassifierConfidence(rawConfidence) !== 0) return;
  console.info(
    `[CONFIDENCE_CONTRACT] detector: ${detector} intentAsserted: true normalizedZero: true omitted: ${!hasUsableConfidence(rawConfidence)} symmetry: ${CONFIDENCE_CONTRACT_SYMMETRY}`,
  );
}

/**
 * Matches normalized inbound text from webhookNormalizer (Feature 22).
 *
 * P2-5 (RC-26/DP-pc-18): this append was hardcoded Albanian regardless of the resolved reply
 * locale, so an English conversation got an Albanian instruction injected into its prompt —
 * violating the `guidelines.language` LANGUAGE LOCK the very same prompt carries. It is now
 * locale-selected like every other fixed phrase. (The Albanian copy is kept byte-identical,
 * mixed diacritics and all, so flag-off/sq output is unchanged.)
 */
const SHARED_CONTENT_SYSTEM_APPEND_BY_LOCALE: Record<ReplyLocale, string> = {
  sq: '\n\nKlienti ka ndare permbajtje me ju. Përdor kontekstin qe jepet per te dhene pergjigjen e pershtatshme dhe lidhe me produktet nga katalogu kur eshte relevante.',
  en: '\n\nThe customer has shared content with you. Use the context provided to give a suitable reply and relate it to the catalog products where relevant.',
};

const SHARED_POST_VISION_APPEND_BY_LOCALE: Record<ReplyLocale, string> = {
  sq: ' Per postimet e Instagram-it (shares), mbeshtetu kryesisht te pamjet/parapamjet e bashkengjitura.',
  en: ' For Instagram post shares, rely primarily on the attached images/previews.',
};

function inboundTextIsPostShare(content: string): boolean {
  return content.trimStart().startsWith('Customer shared a post');
}

function inboundTextIsStoryThread(content: string): boolean {
  const t = content;
  return (
    t.includes('Customer mentioned you in their story') ||
    t.includes('Customer replied to your story') ||
    t.includes('Customer shared a story')
  );
}

function inboundTextIsGenericShare(content: string): boolean {
  return content.trimStart().startsWith('Customer shared content');
}

/** Post shares and story threads get the extra catalog-alignment instruction (not reel/product-only lines). */
function inboundNeedsSharedContentInstruction(content: string): boolean {
  return (
    inboundTextIsPostShare(content) ||
    inboundTextIsStoryThread(content) ||
    inboundTextIsGenericShare(content)
  );
}

const DEFAULT_AI_CONFIG: Pick<
  AIConfig,
  | 'tone'
  | 'personality_description'
  | 'restrictions'
  | 'platform_restrictions'
  | 'sales_strategy'
  | 'objection_handling'
  | 'qa_pairs'
  | 'is_active'
  | 'custom_model_id'
> = {
  tone: 'friendly and professional',
  personality_description: null,
  restrictions: [],
  platform_restrictions: [],
  sales_strategy: 'Be helpful, answer questions accurately, and gently guide towards a purchase when appropriate.',
  objection_handling: null,
  qa_pairs: [],
  is_active: true,
  custom_model_id: null,
};

async function loadAIConfig(tenantId: string) {
  // P2-3 (RC-17): versioned / compare-and-set path. Read the versioned key; on a miss, load the DB
  // row and populate with SET-IF-NEWER so a stale populate can never overwrite a newer write-through
  // (resurrection race closed). A missing config row (brand-new tenant mid-onboarding) is NOT cached
  // — we return the default and re-check DB next call so a version-0 default can never mask the real
  // row once it is created. Trust the TTL on a hit (no DB revalidation → immune to the benign
  // feedback_count → updated_at bump).
  if (AI_CONFIG_VERSIONED_CACHE) {
    const versionedKey = versionedAiConfigKey(tenantId);
    const hit = await readVersionedCacheWithVersion<AIConfig>(versionedKey);
    // P2-4 Part 2 (RC-17): the receipt-time staleness FLOOR. A cache hit is trusted on its TTL,
    // which is what leaves the 900s per-worker drift window: worker A can serve a persona/model
    // that was already superseded when this message arrived. If the cached version predates the
    // config in force AT RECEIPT, treat the hit as a miss and read through.
    //
    // Safe in one direction only, by construction: the version is `updated_at` as epoch micros off
    // a single DB clock and monotonic, so this can only force a FRESHER read, never pin a staler
    // one. A version at-or-above the floor is always acceptable — config edited after receipt is
    // fine to answer WITH; it is the GATE decision that must not move, and the gates are live.
    // Ambient (no snapshot in scope, flag off, or an older job) → unchanged legacy behaviour.
    if (hit && !isCachedConfigStale(hit.v, getReceiptSnapshot()?.aiConfigVersion ?? 0)) {
      return normalizeAiConfig(hit.data);
    }

    const config = await findAIConfigByTenant(tenantId);
    if (!config) return normalizeAiConfig(DEFAULT_AI_CONFIG);
    const normalized = normalizeAiConfig(config);
    await cacheSetIfNewer(versionedKey, aiConfigVersion(config.updated_at), normalized);
    return normalized;
  }

  const cacheKey = `ai_config:${tenantId}`;
  const cached = await redisConnection.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as AIConfig | typeof DEFAULT_AI_CONFIG;
      return {
        ...parsed,
        restrictions: Array.isArray(parsed.restrictions) ? parsed.restrictions : [],
        platform_restrictions: Array.isArray(parsed.platform_restrictions)
          ? parsed.platform_restrictions
          : [],
      };
    } catch {
      await redisConnection.del(cacheKey);
    }
  }

  const config = await findAIConfigByTenant(tenantId);
  const resolved = config ?? DEFAULT_AI_CONFIG;
  const normalized = {
    ...resolved,
    restrictions: Array.isArray(resolved.restrictions) ? resolved.restrictions : [],
    platform_restrictions: Array.isArray(resolved.platform_restrictions)
      ? resolved.platform_restrictions
      : [],
  };
  await redisConnection.set(cacheKey, JSON.stringify(normalized), 'EX', 900);
  return normalized;
}

async function clearTenantPromptBlockCaches(tenantId: string): Promise<void> {
  // P2-3 (F2): the versioned twin must be cleared alongside the legacy key — a DEL of only the
  // legacy key leaves the AI_CONFIG_VERSIONED_CACHE read path serving the pre-heal blocks.
  await redisConnection.del(
    `tenant_prompt_blocks:${tenantId}`,
    versionedPromptBlocksKey(tenantId),
  );
}

/**
 * P3-5 step 3: is this tenant's locked-block content already synced to the current catalog?
 *
 * A Redis GET of a global marker against a per-tenant one — no database work in the common case,
 * where the catalog has not changed since the tenant last synced.
 *
 * A CACHE MISS COUNTS AS UP-TO-DATE, deliberately. The tempting reading ("we don't know, so sync
 * to be safe") force-syncs every tenant on every cold start and after any eviction — which is
 * precisely the per-reply herd this change exists to remove, just relocated to restart time. The
 * bounded cost of the safe-looking-but-wrong alternative is worse than the bounded cost of this
 * one: a genuinely stale tenant waits for the reconcile sweep, which force-syncs unconditionally.
 */
async function tenantLockedBlocksAreCurrent(tenantId: string): Promise<boolean> {
  try {
    const [marker, synced] = await redisConnection.mget(
      LOCKED_CATALOG_MARKER_KEY,
      tenantSyncMarkerKey(tenantId),
    );
    if (!marker) return true; // no published marker yet — see above
    return marker === synced;
  } catch {
    // Redis unavailable. Same reasoning: do not turn a cache outage into a fleet-wide UPDATE storm
    // against the database that is still up.
    return true;
  }
}

/**
 * Ensure the tenant has prompt blocks, and (legacy path) self-heal locked ones.
 *
 * `rows` is the already-loaded block list, which is what removes the COUNT: `rows.length === 0` is
 * the same signal `countTenantPromptBlocks` was issuing a query to obtain. Returns true when the
 * caller must reload, because seeding changed the row set underneath it.
 */
async function ensureTenantPromptBlocksSeeded(
  tenantId: string,
  rows: TenantPromptBlockRow[],
): Promise<boolean> {
  if (rows.length === 0) {
    await seedTenantPromptBlocksFromCatalog(tenantId);
    await clearTenantPromptBlockCaches(tenantId);
    return true;
  }

  if (PROMPT_SELF_HEAL_OFF_HOT_PATH) {
    // The force-sync moved to the reconcile sweep (services/promptRegistryReconcile.ts). It has to
    // live SOMEWHERE: this per-reply UPDATE is what actually repairs the "an exact-string migration
    // sync missed this tenant" class — migration 052 exists solely because of that class — so
    // deleting it without a replacement would leave those tenants stale forever.
    if (await tenantLockedBlocksAreCurrent(tenantId)) return false;
  }

  // Self-healing: push any catalog changes to locked blocks that this tenant
  // may have missed (e.g. due to exact-string migration sync failures).
  // Flag-off this runs on every generateReply call, but the UPDATE is a no-op when content
  // is already current, so the cost is a single cheap equality-check query.
  const updated = await forceSyncLockedBlocksForTenant(tenantId);
  if (PROMPT_SELF_HEAL_OFF_HOT_PATH) {
    // Record that this tenant is now current so the next reply takes the Redis-only path. Set on
    // BOTH branches — a tenant we just repaired is as current as one that needed nothing, and
    // marking only the quiet branch would make every repair cost a second redundant sync.
    // Best-effort: a failed marker write costs one no-op UPDATE next turn, nothing more.
    const marker = await redisConnection.get(LOCKED_CATALOG_MARKER_KEY).catch(() => null);
    if (marker) {
      await redisConnection.set(tenantSyncMarkerKey(tenantId), marker).catch(() => undefined);
    }
  }
  if (updated.length > 0) {
    await clearTenantPromptBlockCaches(tenantId);
    console.info('[aiService] Self-healed locked prompt blocks for tenant', {
      tenantId,
      updatedKeys: updated,
    });
    return true;
  }
  return false;
}

async function loadTenantPromptBlocksCached(tenantId: string) {
  // P2-3 (RC-17): the prompt-blocks twin shares the ai_config resurrection shape. Under the flag it
  // uses the SAME versioned populate (SET-IF-NEWER, version = newest block updated_at). Block
  // mutators keep DELETE-based invalidation via invalidateTenantAiCaches (there is no cheap
  // fresh-list write-through), so a narrow residual window remains after an edit — bounded by the
  // every-reply locked-block self-heal, which (since the P2-audit F2 fix) DELs BOTH the legacy and
  // the versioned key on drift, and block edits are rare. Behind AI_CONFIG_VERSIONED_CACHE;
  // flag-off is the legacy EX 900 path byte-for-byte.
  if (AI_CONFIG_VERSIONED_CACHE) {
    const versionedKey = versionedPromptBlocksKey(tenantId);
    const hit = await readVersionedCache<Awaited<ReturnType<typeof listTenantPromptBlocksRuntime>>>(
      versionedKey,
    );
    if (hit) return hit;
    const rows = await listTenantPromptBlocksRuntime(tenantId);
    // P3-5: never cache an EMPTY list. The seed-if-empty check below reads `rows.length === 0`, so
    // caching an empty array would pin the "this tenant has no blocks" state for the full TTL and
    // the seed would run on every reply while every reply also shipped an empty guidelines
    // section. Harmless before P3-5 only because a COUNT query, not the cache, made that decision.
    if (rows.length > 0) await cacheSetIfNewer(versionedKey, promptBlocksVersion(rows), rows);
    return rows;
  }

  const cacheKey = `tenant_prompt_blocks:${tenantId}`;
  const cached = await redisConnection.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as Awaited<ReturnType<typeof listTenantPromptBlocksRuntime>>;
    } catch {
      await redisConnection.del(cacheKey);
    }
  }

  const rows = await listTenantPromptBlocksRuntime(tenantId);
  // P3-5: see the versioned branch above — an empty list must not be cached.
  if (rows.length > 0) await redisConnection.set(cacheKey, JSON.stringify(rows), 'EX', 900);
  return rows;
}

async function loadTenant(tenantId: string) {
  const cacheKey = `tenant:${tenantId}`;
  const cached = await redisConnection.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as Awaited<ReturnType<typeof findTenantById>>;
    } catch {
      await redisConnection.del(cacheKey);
    }
  }

  const tenant = await findTenantById(tenantId);
  if (tenant) {
    await redisConnection.set(cacheKey, JSON.stringify(tenant), 'EX', 1800);
  }
  return tenant;
}

// Maximum number of products returned by the alphabetical fallback catalog.
// Raised from 5 to 20 so that the AI has a broader view when semantic/keyword
// search both miss (e.g. vague greeting messages on first contact).
const FALLBACK_CATALOG_LIMIT = 20;

async function loadProductCatalog(tenantId: string): Promise<Product[]> {
  const cacheKey = `products:${tenantId}`;
  const cached = await redisConnection.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as Product[];
    } catch {
      await redisConnection.del(cacheKey);
    }
  }

  const products = await searchProducts(tenantId, '', FALLBACK_CATALOG_LIMIT);
  await redisConnection.set(cacheKey, JSON.stringify(products), 'EX', 120);
  return products;
}

export function extractKeywords(text: string): string[] {
  // P2-5 (RC-25): the dialect-normalized path folds diacritics + Gheg function words and uses
  // the single unified stopword list, so this arm finally agrees with its sibling
  // `extractCatalogSearchPhrases` below — today one searches `%çokollatë%` while the other
  // searches `%cokollate%`, from the same message, in the same call.
  if (DIALECT_NORMALIZATION) return extractDialectKeywords(text);

  const stopWords = new Set([
    // English
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
    // Albanian — common function words that don't carry product meaning
    'dhe', 'një', 'nje', 'për', 'per', 'nga', 'me', 'në', 'ne', 'është',
    'eshte', 'jam', 'jemi', 'janë', 'jane', 'ka', 'kam', 'kemi', 'kanë',
    'kane', 'do', 'dua', 'duam', 'mund', 'që', 'qe', 'si', 'çfarë',
    'cfar', 'cfare', 'kur', 'ku', 'kjo', 'ky', 'ato', 'ata', 'ajo',
    'ai', 'na', 'ju', 'ata', 'ato', 'të', 'te', 'se', 'por', 'ose',
    'nuk', 'jo', 'po', 'edhe', 'fare', 'shumë', 'shume', 'pak', 'mirë',
    'mire', 'keq', 'sot', 'dje', 'nesër', 'neser', 'tani', 'keni',
    'faleminderit', 'pershendetje', 'mirupafshim', 'ndihme',
  ]);

  return text
    .toLowerCase()
    // Keep Unicode letters (including ë, ç, and all other scripts) and digits.
    // The old [^a-z0-9\s] stripped Albanian characters, producing garbled tokens
    // like "biobalancn" instead of "biobalancë" which then matched nothing.
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

/** Multi-word phrases and known category/tag labels extracted for catalog lookup. */
export function extractCatalogSearchPhrases(text: string): string[] {
  // P2-5 (RC-25): this arm already folds diacritics, so normalization only adds the Gheg
  // function-word rewrite — which is what lets the known-pattern table below see a Gheg query
  // at all ("naj produkt tmir per shtim peshe" folds to "ndonje produkt te mire per shtim
  // peshe" and reaches the 'shtim peshe' pattern).
  const normalized = DIALECT_NORMALIZATION
    ? foldDialect(text)
    : text
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

  if (!normalized) return [];

  const phrases = new Set<string>();

  const knownPatterns: Array<{ re: RegExp; phrase: string }> = [
    { re: /\bshtim\s+peshe\b|\bshtimin\s+e\s+peshes\b|\bne\s+shtim\s+peshe\b/, phrase: 'shtim peshe' },
    { re: /\bhumbje\s+peshe\b|\bne\s+humbje\s+peshe\b|\bper\s+humbje\s+peshe\b/, phrase: 'humbje peshe' },
    { re: /\bmasa\s+muskulore\b|\bmuscle\s+mass\b|\bweight\s+gain\b/, phrase: 'masa muskulore' },
    { re: /\bproteina\b|\bprotein\b/, phrase: 'proteina' },
    { re: /\bmass\s+gainer\b|\bmassgainer\b/, phrase: 'mass gainer' },
    { re: /\bwhey\b/, phrase: 'whey' },
    { re: /\bcreatine\b|\bkreatine\b/, phrase: 'creatine' },
    { re: /\bvitamina\b|\bvitamins?\b/, phrase: 'vitamina' },
  ];

  for (const { re, phrase } of knownPatterns) {
    if (re.test(normalized)) phrases.add(phrase);
  }

  const words = normalized.split(' ').filter((w) => w.length >= 2);
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    if (bigram.length >= 5) phrases.add(bigram);
  }

  return [...phrases];
}

/** Whether the customer is browsing/recommending by goal, category, or tag (not a single SKU). */
export function hasCategoryShoppingIntent(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;

  return (
    /\b(shtim|humbje)\s+peshe\b/.test(normalized) ||
    /\ba\s+keni\b.*\bprodukt/.test(normalized) ||
    /\bprodukt\b.*\b(per|për|te\s+mire|të\s+mirë)\b/.test(normalized) ||
    /\b(recommend|suggestion|suggest|what\s+do\s+you\s+have|which\s+product)\b/i.test(
      normalized,
    ) ||
    /\b(cfare|çfarë)\s+produkt/.test(normalized) ||
    /\b(masa\s+muskulore|mass\s+gainer|massgainer|weight\s+gain)\b/.test(normalized)
  );
}

/**
 * A retrieval source list plus a weight. Higher weight = the source contributes more
 * to the fused score. Order within `products` is treated as the source's own ranking.
 */
interface WeightedSource {
  name: string;
  products: Product[];
  weight: number;
}

/**
 * Reciprocal Rank Fusion (RRF) constant. Larger k flattens the contribution of rank
 * position; 60 is the value from the original RRF paper and the common default.
 */
const RRF_K = 60;

/**
 * Fuses multiple ranked retrieval sources into a single relevance-ordered list.
 *
 * The previous strategy concatenated sources in a fixed priority order and kept
 * first-seen — which buried the high-precision semantic results behind unranked
 * substring (ILIKE) matches, and let lexical noise evict the correct product when the
 * result cap was hit. RRF instead rewards products that rank highly across multiple
 * sources, so a product found by BOTH semantic and keyword search outranks one found
 * only by a noisy substring match, regardless of source order.
 *
 *   score(p) = Σ_sources  weight / (RRF_K + rank_in_source(p))
 */
function fuseByRRF(sources: WeightedSource[], limit: number): Product[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, Product>();

  for (const source of sources) {
    source.products.forEach((p, idx) => {
      if (!byId.has(p.id)) byId.set(p.id, p);
      const contribution = source.weight / (RRF_K + idx + 1);
      scores.set(p.id, (scores.get(p.id) ?? 0) + contribution);
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => byId.get(id))
    .filter((p): p is Product => p !== undefined);
}

/** Short follow-up about usage/dosage with no product name (e.g. "Si ta perdor?"). */
export function isUsageOnlyFollowUp(message: string): boolean {
  const t = message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s?!.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!t || t.length > 100) return false;

  const usageCues = [
    'si ta perdor',
    'si e perdor',
    'si duhet ta perdor',
    'si ta marr',
    'how to use',
    'how do i use',
    'how should i use',
    'usage',
    'dozimi',
    'dozë',
    'dose',
    'dosage',
    'instructions',
    'udhezime',
    'udhëzime',
    'perdorim',
    'përdorim',
    'apliko',
    'apply it',
    'take it',
  ];

  const hasUsageCue = usageCues.some((n) => t.includes(n));
  const words = t.split(/\s+/).filter((w) => w.length > 1);
  return hasUsageCue && words.length <= 8;
}

/**
 * Vague reference to the product just discussed (e.g. "tell me more", "about it").
 */
export function isVagueProductReferenceFollowUp(message: string): boolean {
  const t = message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s?!.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!t || t.length > 80) return false;

  const patterns = [
    /^(tell me more|more about (it|this)|about (it|this)|this one|that one)(\s*[.!?]*)?$/,
    /^(me shum|më shumë|per te|për të|rreth tij|rreth kesaj)(\s*[.!?]*)?$/,
    /^(what is it|what does it do|cfare eshte|çfarë është)(\s*[.!?]*)?$/,
    /^(describe (it|this)|description)(\s*[.!?]*)?$/,
  ];

  if (patterns.some((re) => re.test(t))) return true;

  const vagueCues = ['this product', 'that product', 'ky produkt', 'kete produkt', 'këtë produkt'];
  const words = t.split(/\s+/).filter((w) => w.length > 1);
  return vagueCues.some((n) => t.includes(n)) && words.length <= 6;
}

/**
 * Customer is referring back to a product that was identified from a photo sent in
 * a previous turn (e.g. "I want the product from the photo I sent you").
 * Without this guard, the message contains no product name, all searches return empty,
 * and the AI loses context and claims the product is unavailable.
 */
export function isPhotoProductReferenceFollowUp(message: string): boolean {
  const t = message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s?!.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!t || t.length > 300) return false;

  const hasPhotoCue =
    /\b(photo|image|picture|foto|foton|imazh|imazhin|fotografin|fotografia|pic|pics)\b/.test(t);
  const hasPhotoSendCue =
    /\b(sent|send|dergova|dergove|ndava|ndave|postova|postove|bashkengjitur|bashkengjita)\b/.test(t);
  const hasProductCue =
    /\b(product|produkt|produktin|produktit|produktet|item|artikull|artikullin)\b/.test(t);

  return (hasPhotoCue || hasPhotoSendCue) && hasProductCue;
}

/** Follow-up that refers to the product from prior turns without naming it. */
export function needsConversationProductContext(message: string): boolean {
  return (
    isPriceOnlyFollowUp(message) ||
    isUsageOnlyFollowUp(message) ||
    isVagueProductReferenceFollowUp(message) ||
    isCategoryAttributeFollowUp(message) ||
    isAttributeQuestionMessage(message) ||
    isPhotoProductReferenceFollowUp(message)
  );
}

/** Short follow-up asking only for price (e.g. "Sa kushton?") with no product name. */
export function isPriceOnlyFollowUp(message: string): boolean {
  const t = message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s?!.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!t || t.length > 80) return false;

  // `t` is already lowercased and diacritic-stripped above, so ascii forms cover the
  // diacritic spellings. Allow an optional trailing deictic pronoun ("... kto/keto/them").
  if (
    /^(sa\s+)?(kushton|kushtojn|kushtojne|kushtoj|kushtoi|kushtuan|cmimi|cmim|qmimi|qmim|price|cost|how much)(\s+(kto|keto|kete|keta|ato|ate|atyre|tyre|this|these|them|it))?(\s*[.!?]*)?$/i.test(
      t,
    )
  ) {
    return true;
  }

  const hasPriceCue = [
    'kushton',
    'kushtojn',
    'kushtojne',
    'kushtoj',
    'kushtoi',
    'kushtuan',
    'cmim',
    'qmim',
    'price',
    'cost',
    'how much',
    'sa kushton',
    'sa ben',
  ].some((n) => t.includes(n));
  const words = t.split(/\s+/).filter((w) => w.length > 1);
  return hasPriceCue && words.length <= 6;
}

// P1-4 (RC-04): the aborting-timeout + shared/negative query-embedding cache + dimension guard
// + `activeEmbeddingModel` now live in `retrievalReliability.ts` (a pure/injectable module so
// the abort/timeout/fail-open branches are unit-testable without a live OpenAI/Redis). The old
// non-cancelling `Promise.race` + per-process Map this replaced re-raced every timed-out query
// and diverged across workers. Callers use `getOrComputeQueryEmbedding` (imported above).

/**
 * Unified product retrieval: all sources (category/tag phrases, semantic vector search,
 * keyword ILIKE) run in parallel where possible and are fused with Reciprocal Rank
 * Fusion (RRF) so the final order reflects cross-source agreement, not source priority.
 *
 * RRF source weights:
 *   - semantic (dense vector): 2.0 — highest precision
 *   - category/tag phrase:     1.5 — structured, high precision
 *   - phrase direct (ILIKE):   1.2
 *   - keyword ILIKE:           1.0 — broad recall, lower precision
 */
export async function matchProductsForCustomerMessage(
  tenantId: string,
  searchText: string,
  limit: number,
  // P1-5: optional retrieval-telemetry sink. When provided, populated with the similarity scores,
  // threshold outcomes and semanticSkipped that RRF otherwise drops before the caller sees them.
  telemetrySink?: RetrievalTelemetrySink,
  // P3-2 (C-125): upper bound on the tenant's retrievable catalog, used only to skip a provably
  // useless wider HNSW pass. `generateReply` already awaits `countActiveProducts` on the same turn,
  // so passing it costs nothing; the other call sites have no count in scope and pass nothing,
  // which reproduces the legacy behaviour exactly.
  eligibleCatalogCount?: number | null,
): Promise<Product[]> {
  const trimmed = searchText.trim();
  if (!trimmed) return [];

  const t0 = Date.now();
  const phrases = extractCatalogSearchPhrases(trimmed);
  const keywords = extractKeywords(trimmed);
  const categoryIntent = hasCategoryShoppingIntent(trimmed);

  // Run all retrieval paths in parallel — semantic + both lexical paths. The query embedding
  // now aborts at the deadline, negative-caches a skip, and is dimension-guarded (P1-4/RC-04).
  const [categoryTagMatches, embeddingVector, keywordMatches] = await Promise.all([
    searchProductsByCatalogPhrases(tenantId, phrases, limit),
    getOrComputeQueryEmbedding(trimmed, { tenantId }),
    keywords.length > 0
      ? searchProductsByDisjunctiveTerms(tenantId, keywords, limit)
      : Promise.resolve([] as Product[]),
  ]);

  let semanticCandidates: Product[] = [];
  // Hysteresis band (P1-4): candidates in [threshold - band, threshold) join a SEPARATE
  // low-weight `semantic_band` RRF source. With SIMILARITY_HYSTERESIS_BAND=0 (default) this is
  // always empty → retrieved sets identical to the legacy `>= threshold` filter.
  let semanticBandCandidates: Product[] = [];
  let semanticSkipped = false;
  // P1-5 retrieval-telemetry capture (scores are dropped by RRF below, so grab them here).
  let skipReason: string | null = null;
  let coreCount = 0;
  let bandCount = 0;
  let retrievalTop: Array<{ id: string; similarity: number }> = [];
  if (embeddingVector) {
    try {
      const similar = await searchProductsBySimilarity(
        tenantId,
        embeddingVector,
        // Fetch a little extra depth when the band is active so band candidates (which rank
        // just below the top-N core matches) are not starved by the SQL LIMIT.
        SIMILARITY_HYSTERESIS_BAND > 0 ? limit + SEMANTIC_BAND_EXTRA_DEPTH : limit,
        activeEmbeddingModel(),
        eligibleCatalogCount ?? null,
      );
      const partitioned = partitionBySimilarityBand(
        similar,
        SIMILARITY_THRESHOLD,
        SIMILARITY_HYSTERESIS_BAND,
      );
      semanticCandidates = partitioned.core;
      semanticBandCandidates = partitioned.band;
      coreCount = partitioned.core.length;
      bandCount = partitioned.band.length;
      // Top candidates WITH scores — records how far the correct products fell vs. the threshold
      // (the §15.2 gap the fcd0af7e incident needed manual SQL to recover).
      retrievalTop = similar
        .slice(0, 8)
        .map((p) => ({ id: p.id, similarity: p.similarity }));
    } catch {
      semanticSkipped = true;
      skipReason = 'similarity_query_error';
      // The embedding path skip (timeout/error/dim-mismatch) is already logged+counted inside
      // getOrComputeQueryEmbedding; this counts the distinct similarity-query (DB) failure.
      logSemanticSkipped('similarity_query_error', tenantId);
    }
  } else {
    semanticSkipped = true;
    skipReason = 'embedding_unavailable';
  }

  const phraseDirect: Product[] = [];
  for (const phrase of phrases) {
    if (!phrase.includes(' ') && phrase.length < 6) continue;
    phraseDirect.push(...(await searchProducts(tenantId, phrase, limit)));
  }

  // For pure category-shopping intent (e.g. "show me weight-gain products") semantic
  // broad-recall can return tangential products — category/tag matches are more precise.
  const sources: WeightedSource[] = categoryIntent && categoryTagMatches.length > 0
    ? [
        { name: 'category_tag', products: categoryTagMatches, weight: 1.5 },
        { name: 'phrase_direct', products: phraseDirect, weight: 1.2 },
        { name: 'keyword', products: keywordMatches, weight: 1.0 },
      ]
    : [
        { name: 'semantic', products: semanticCandidates, weight: 2.0 },
        // Hysteresis-band source (P1-4): empty unless SIMILARITY_HYSTERESIS_BAND > 0. A lone
        // band hit scores weight/(RRF_K+rank) below any core/category #1, so it never
        // dominates — it only ranks with corroboration (the intended boundary stabiliser).
        ...(semanticBandCandidates.length > 0
          ? [{ name: 'semantic_band', products: semanticBandCandidates, weight: SEMANTIC_BAND_WEIGHT }]
          : []),
        { name: 'category_tag', products: categoryTagMatches, weight: 1.5 },
        { name: 'phrase_direct', products: phraseDirect, weight: 1.2 },
        { name: 'keyword', products: keywordMatches, weight: 1.0 },
      ];

  const results = fuseByRRF(sources, limit);

  // Structured retrieval log — one line per call, easy to grep / ingest into a log
  // aggregator. Captures enough to reconstruct what was retrieved vs. what was correct.
  logger.info('[retrieval]', {
    tenantId,
    query: logSafe(trimmed),
    categoryIntent,
    semanticSkipped,
    sources: sources.map((s) => ({ name: s.name, count: s.products.length })),
    fused: results.length,
    topIds: results.slice(0, 5).map((p) => p.id),
    topNames: results.slice(0, 5).map((p) => p.name),
    elapsedMs: Date.now() - t0,
  });

  if (semanticSkipped && trimmed.length > 0) {
    logger.warn('[retrieval] Semantic path skipped — embedding unavailable or timed out', {
      tenantId,
      queryLength: trimmed.length,
    });
  }

  if (telemetrySink) {
    telemetrySink.value = {
      semanticSkipped,
      skipReason,
      threshold: SIMILARITY_THRESHOLD,
      coreCount,
      bandCount,
      sources: sources.map((s) => ({ name: s.name, count: s.products.length })),
      top: retrievalTop,
      productIds: results.map((p) => p.id),
    };
  }

  return results;
}

/** Products the assistant recently mentioned — used for "Sa kushton?" style follow-ups. */
export async function resolveProductsFromConversationHistory(
  tenantId: string,
  messages: Message[],
  limit: number,
): Promise<Product[]> {
  const assistantTexts = messages
    .filter((m) => m.sent_by === 'ai')
    .slice(-4)
    .map((m) => (m.content ?? '').trim())
    .filter((t) => t.length > 0);

  if (assistantTexts.length === 0) return [];

  const combined = assistantTexts.join('\n');
  const matched = await matchProductsForCustomerMessage(tenantId, combined, limit);
  if (matched.length > 0) return matched;

  const seen = new Set<string>();
  const out: Product[] = [];
  for (const text of [...assistantTexts].reverse()) {
    const rows = await searchProducts(tenantId, text.slice(0, 300), limit);
    for (const p of rows) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
        if (out.length >= limit) return out;
      }
    }
  }

  return out;
}

/**
 * Deterministically reload the products the AI most recently identified in the
 * conversation by reading the persisted `product_ids` off the latest AI message that
 * surfaced any products, then fetching those active catalog rows by ID.
 *
 * This is the primary, reliable source of "the products we just discussed" for
 * follow-up questions (price, brand, flavor, ingredients, stock, variants, …). Unlike
 * the text-based resolvers it cannot be defeated by anchor-extraction picking the
 * follow-up itself, by AI phrasing not matching catalog names, by embedding gaps, or
 * by semantic-search timeouts — so the AI never loses a product it already recommended.
 */
export async function resolveProductsFromPersistedContext(
  tenantId: string,
  messages: Message[],
  limit: number,
): Promise<Product[]> {
  const { ids, sourceText } = collectRecentlyDiscussedProductContext(messages);
  if (ids.length === 0) return [];
  const products = await findActiveProductsByIds(tenantId, ids);

  // GAP_FOCAL_PRODUCT_SCOPE=on: the customer has only SEEN the products the source reply wrote
  // out — narrow the pool to those (Tier A full-name / Tier B lead-tokens, the same principle the
  // photo path uses). FAIL-OPEN: an image-only or paraphrased reply that names nothing keeps the
  // full pool, so a follow-up can never lose every product.
  if (GAP_FOCAL_PRODUCT_SCOPE_MODE !== 'off' && sourceText) {
    const mentioned = filterProductsMentionedInTexts(products, [sourceText]);
    if (mentioned.length > 0) {
      if (GAP_FOCAL_PRODUCT_SCOPE_MODE === 'shadow') {
        console.info('[aiService] follow-up scope (shadow): would narrow persisted context', {
          pool: products.length,
          mentioned: mentioned.length,
        });
      } else {
        return mentioned.slice(0, limit);
      }
    }
  }

  return products.slice(0, limit);
}

/**
 * Unified resolver for context-dependent follow-ups. Tries, in order of reliability:
 *   1. Persisted product IDs from the most recent AI recommendation (deterministic).
 *   2. Anchor-based re-resolution against the prior substantive product query.
 *   3. Re-search of recent assistant reply text.
 *
 * The deterministic persisted path is attempted first so a follow-up about previously
 * identified products is answered from those exact products whenever they were recorded.
 *
 * `pinned` (inbound-name pinning, inboundNamePinning.ts) is PREPENDED to every result:
 * a product the customer explicitly named in THIS message must be in the pool even when
 * the follow-up classifier routed the turn to stale persisted context — otherwise the
 * model, seeing only the prior turn's products, follows R6 and falsely denies a product
 * that exists (live bug: "Sa kushton nitro tech ripped?" after a Beast pre-workout turn).
 */
async function resolveContextualProductSet(
  tenantId: string,
  searchText: string,
  conversationHistory: Message[],
  limit: number,
  pinned: Product[] = [],
): Promise<Product[]> {
  const merge = (base: Product[]): Product[] => {
    if (pinned.length === 0) return base;
    const pinnedIds = new Set(pinned.map((p) => p.id));
    return [...pinned, ...base.filter((p) => !pinnedIds.has(p.id))].slice(0, limit);
  };

  const persisted = await resolveProductsFromPersistedContext(tenantId, conversationHistory, limit);
  if (persisted.length > 0) return merge(persisted);

  const fromContext = await resolveProductsForContextualQuery(
    tenantId,
    searchText,
    conversationHistory,
    matchProductsForCustomerMessage,
    limit,
    true,
  );
  if (fromContext.length > 0) return merge(fromContext);

  return merge(await resolveProductsFromConversationHistory(tenantId, conversationHistory, limit));
}

/**
 * Whether the customer's message is a follow-up that refers to products already
 * discussed (rather than introducing a new product/category to search for). Used as
 * the gate for the deterministic "reuse previously identified products" safety net so
 * the AI never claims a product it already recommended is missing.
 */
function isProductFollowUpReference(
  message: string,
  attributeIntent: ProductAttributeIntentResult,
  customerAskedPrice: boolean,
  customerAskedDiscount: boolean,
): boolean {
  if (
    customerAskedPrice ||
    customerAskedDiscount ||
    attributeIntent.is_attribute_question ||
    attributeIntent.is_product_knowledge_question ||
    needsConversationProductContext(message) ||
    isProductDescriptionQuestion(message) ||
    // Usage/dosage follow-ups ("Sa her ndite muna me perdor?") name no product and are
    // built from stopword-heavy tokens — a fresh search matches unrelated products, the
    // usage guards then judge THOSE products' (missing) usage text, and a perfectly
    // answerable question escalates (live bug: Nitro Tech Ripped, usage text present).
    matchesUsageQuestionKeyword(message)
  ) {
    return true;
  }

  // Deictic reference to the product(s) just discussed, with no new product noun
  // (e.g. "are these in stock?", "a keni keto", "i want them"). Kept short so it does
  // not hijack genuinely new product queries.
  const t = message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s?!.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > 80) return false;
  const words = t.split(/\s+/).filter((w) => w.length > 0);
  if (words.length > 8) return false;
  return /\b(this|that|these|those|it|them|they|kjo|ky|kto|keto|kete|keta|ato|ate|atyre|tyre)\b/.test(t);
}


const NEW_ORDER_SIGNAL_KEYWORDS = [
  'new order',
  'another order',
  'one more',
  'again',
  'also order',
  'order again',
  'porosi tjeter',
  'porosi tjetër',
  'edhe nje',
  'edhe një',
  'nje tjeter',
  'një tjetër',
  'dua edhe',
  'shto edhe',
];

const NEGATIVE_AVAILABILITY_KEYWORDS = [
  'nuk e kemi',
  'nuk kemi',
  'nuk gjendet',
  'not available',
  "don't have",
  'do not have',
  'not in stock',
  'not in our catalog',
  'nuk ndodhet',
  'nuk është në',
];

const ORDER_CONFIRMATION_INBOUND_FALLBACK_KEYWORDS = [
  'porosi',
  'porosine',
  'porosia',
  'dua',
  'me bej',
  'beje porosine',
  'do ta marr',
  'adresa',
  'adrese',
  'derges',
  'delivery',
  'address',
  'order',
  'confirm',
];

const ORDER_CONFIRMATION_REPLY_FALLBACK_KEYWORDS = [
  'porosia u konfirmua',
  'porosia u krijua',
  'porosia juaj',
  'porosine tuaj',
  'faleminderit porosia',
  'order confirmed',
  'order created',
  'your order is confirmed',
  'review in orders',
];

const ORDER_DETAILS_COLLECTION_REPLY_FALLBACK_KEYWORDS = [
  'adresen e plote',
  'adresën e plotë',
  'adresen e dërgesës',
  'adresën e dërgesës',
  'numrin e telefonit',
  'numerin e telefonit',
  'na jep',
  'na dergo',
  'na dërgo',
  'na shkruaj',
  'ploteso',
  'plotëso',
  'te vazhdojme porosine',
  'të vazhdojmë porosinë',
  'per te vazhduar porosine',
  'për të vazhduar porosinë',
  'shipping address',
  'delivery address',
  'full address',
  'phone number',
  'emrin',
  'emri',
  'first name',
  'your name',
  'to proceed with your order',
  'complete your order',
];

const ORDER_CLOSING_QUESTION_FALLBACK_KEYWORDS = [
  'a doni ta porosisni',
  'deshironi ta porosisni',
  'dëshironi ta porosisni',
  'doni ta porosisni',
  'doni me porosit',
  'doni me bo porosi',
  'a e porosisni',
  'do you want to order',
  'would you like to order',
  'want to order it',
];

function normalizeForIntentMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export async function classifyUsageQuestionIntent(message: string): Promise<boolean> {
  const inbound = message.trim();
  if (!inbound) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict intent classifier. Determine whether the customer message asks about ANY of the following (in any language, slang, or with typos):\n' +
            '- Product usage, dosage, instructions, application method\n' +
            '- Side effects or warnings\n' +
            '- Whether the product is safe or suitable for a specific person, health condition, or lifestyle (e.g. "I don\'t work out, can I use this?", "Is this suitable for me?", "Can I use this without exercising?")\n' +
            '- Whether there are any problems, risks, or issues using the product in specific personal circumstances\n' +
            '- Compatibility with a specific diet, health situation, or personal condition\n' +
            '- Any question of the form "can I use this?", "is this ok for me?", "any problem if I...?", "is this suitable for...?"\n' +
            'Return only JSON: {"is_usage_question": true} or {"is_usage_question": false}.',
        },
        {
          role: 'user',
          content: `Customer message:\n${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_usage_question?: boolean };
      if (parsed.is_usage_question === true) return true;
      if (parsed.is_usage_question === false) return false;
    }
  } catch {
    // Fall through to keyword fallback when classifier is unavailable.
  }

  return includesAnyKeyword(inbound, USAGE_QUESTION_KEYWORDS);
}

export async function classifyNewOrderSignal(message: string): Promise<boolean> {
  const inbound = message.trim();
  if (!inbound) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict intent classifier. Determine whether the message indicates the customer wants to place an additional/new order (e.g., another one, order again) rather than just discussing an existing order. Return only JSON: {"is_new_order_signal": true} or {"is_new_order_signal": false}.',
        },
        {
          role: 'user',
          content: `Customer message:\n${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_new_order_signal?: boolean };
      if (parsed.is_new_order_signal === true) return true;
      if (parsed.is_new_order_signal === false) return false;
    }
  } catch {
    // Fall through to keyword fallback when classifier is unavailable.
  }

  return includesAnyKeyword(inbound, NEW_ORDER_SIGNAL_KEYWORDS);
}

export async function classifyNegativeAvailabilityReply(message: string): Promise<boolean> {
  const inbound = message.trim();
  if (!inbound) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict classifier. Detect if the assistant reply says the requested product is unavailable/out of stock/not carried (in any language). Return only JSON: {"is_negative_availability": true} or {"is_negative_availability": false}.',
        },
        {
          role: 'user',
          content: `Assistant reply:\n${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_negative_availability?: boolean };
      if (parsed.is_negative_availability === true) return true;
      if (parsed.is_negative_availability === false) return false;
    }
  } catch {
    // Fall through to keyword fallback when classifier is unavailable.
  }

  return includesAnyKeyword(inbound, NEGATIVE_AVAILABILITY_KEYWORDS);
}

export async function classifyOrderConfirmationReplyIntent(
  inboundMessage: string,
  replyMessage: string,
): Promise<boolean> {
  const inbound = inboundMessage.trim();
  const reply = replyMessage.trim();
  if (!reply) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict classifier. Determine whether the assistant reply is a valid order confirmation that directly acknowledges the customer order request/details (any language). Return only JSON: {"is_order_confirmation_reply": true} or {"is_order_confirmation_reply": false}. Return true only when the reply clearly confirms/acknowledges an order creation/confirmation; polite fillers alone are false.\n\nClassification guidance:\n- True: clearly confirms order creation/confirmation, often restating key order details (product, address, quantity, or next step in orders).\n- False: generic support response, product info, upsell, greeting, or unclear message with no explicit confirmation.\n\nExamples:\n1) Customer: "Po, guralisht! Për të bërë porosinë, më jep adresën e plotë të dërgesës."\nAssistant: "Faleminderit! Porosia për Mass Gainer Pro u konfirmua. Do të dërgohet në adresën e dhënë."\n=> true\n\n2) Customer: "A mundem me bo 1 porosi per kete produkt"\nAssistant: "Po, porosia u krijua me sukses. Mund ta shikoni te Orders."\n=> true\n\n3) Customer: "Sa kushton ky?"\nAssistant: "Ky produkt kushton 34.50$."\n=> false\n\n4) Customer: "A e keni ne stok?"\nAssistant: "Po, e kemi në stok. Dëshiron ta porosisësh?"\n=> false\n\n5) Customer: "Dua ta porosis."\nAssistant: "Faleminderit për interesimin! Si mund t’ju ndihmoj më tej?"\n=> false',
        },
        {
          role: 'user',
          content: `Customer message:\n${inbound || '(empty)'}\n\nAssistant reply:\n${reply}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 96,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_order_confirmation_reply?: boolean };
      if (parsed.is_order_confirmation_reply === true) return true;
      if (parsed.is_order_confirmation_reply === false) return false;
    }
  } catch {
    // Fall through to lexical fallback when classifier is unavailable.
  }

  const inboundNormalized = normalizeForIntentMatch(inbound);
  const replyNormalized = normalizeForIntentMatch(reply);
  const inboundLooksOrderRelated = includesAnyKeyword(
    inboundNormalized,
    ORDER_CONFIRMATION_INBOUND_FALLBACK_KEYWORDS,
  );
  const replyLooksLikeConfirmation = includesAnyKeyword(
    replyNormalized,
    ORDER_CONFIRMATION_REPLY_FALLBACK_KEYWORDS,
  );

  return inboundLooksOrderRelated && replyLooksLikeConfirmation;
}

export async function classifyOrderDetailsCollectionReplyIntent(
  inboundMessage: string,
  replyMessage: string,
): Promise<boolean> {
  const inbound = inboundMessage.trim();
  const reply = replyMessage.trim();
  if (!reply) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict classifier. Determine whether the assistant reply is collecting required delivery details to proceed with purchase in any language. In this system, valid requested delivery details are: customer first name, phone number, and full delivery/shipping address. Last name is NOT a required detail and should not be counted. Return only JSON: {"is_order_details_collection_reply": true} or {"is_order_details_collection_reply": false}. Return true only when the reply asks for one or more of those required details as the next ordering step. Return false if the reply asks for unrelated personal data (e.g., last name, ID number, birthday, email) or unrelated chit-chat.',
        },
        {
          role: 'user',
          content: `Customer message:\n${inbound || '(empty)'}\n\nAssistant reply:\n${reply}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 96,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_order_details_collection_reply?: boolean };
      if (parsed.is_order_details_collection_reply === true) return true;
      if (parsed.is_order_details_collection_reply === false) return false;
    }
  } catch {
    // Fall through to lexical fallback when classifier is unavailable.
  }

  const replyNormalized = normalizeForIntentMatch(reply);
  return includesAnyKeyword(replyNormalized, ORDER_DETAILS_COLLECTION_REPLY_FALLBACK_KEYWORDS);
}

export async function classifyOrderClosingQuestionReplyIntent(message: string): Promise<boolean> {
  const reply = message.trim();
  if (!reply) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict classifier. Determine whether the assistant reply includes an order-closing question that asks the customer to place/proceed with an order (in any language). Return only JSON: {"is_order_closing_question": true} or {"is_order_closing_question": false}. Mark true for phrases like "A doni ta porosisni?" or "Would you like to order?".',
        },
        {
          role: 'user',
          content: `Assistant reply:\n${reply}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_order_closing_question?: boolean };
      if (parsed.is_order_closing_question === true) return true;
      if (parsed.is_order_closing_question === false) return false;
    }
  } catch {
    // Fall through to keyword fallback when classifier is unavailable.
  }

  const normalized = normalizeForIntentMatch(reply);
  return includesAnyKeyword(normalized, ORDER_CLOSING_QUESTION_FALLBACK_KEYWORDS);
}

export async function customerAskedAboutPrice(message: string): Promise<boolean> {
  const inbound = message.trim();
  if (!inbound) return false;

  const lexical = lexicallyAsksAboutPrice(inbound);

  // P3-5 (R4/R16): UNION, not fallback — the audit's wording is "treat 'customer asked price' as a
  // union of classifier + gap-assessor signals", and this is the pre-generation half of it.
  //
  // Why it must be pre-generation: `includePrice` (aiService:4267) is `customerAskedPrice ||
  // customerAskedDiscount`, so a missed price intent means the catalog is injected with NO price
  // lines at all. The model then cannot state a price, and the fail-closed gap assessor truthfully
  // reports `missing_info: ["çmimi"]` and escalates. EV-010 is therefore NOT an assessor false
  // positive — the assessor was right; the price was genuinely absent from its context. Filtering
  // price out of `missing_info` (the other fix the audit floats) would suppress a TRUE signal and
  // ship a reply that never answers the question. The root cause is upstream, and this is it.
  //
  // Safe by construction: it can only ADD prices, and only when the customer's own message
  // contains an explicit price word — which is precisely what R4's "price only when explicitly
  // asked" means. It also SKIPS the classifier call entirely on the clearest cases, so the common
  // path gets cheaper rather than more expensive.
  if (PRICE_INTENT_LEXICAL_UNION && lexical) {
    console.info('[price_classifier] lexical=true — skipping classifier', logSafe(inbound));
    return true;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a price-intent classifier. Determine whether the customer is asking about price, cost, or how much something costs — in any language, dialect, slang, shorthand, or with misspellings. ' +
            'Also return true for price-comparison and price-ranking questions such as "which is cheapest?", "which costs more?", "which is most expensive?", "cili eshte me i lire?", "cili kushton me pak?", "compare prices", "krahasim cmimesh" — these require price data to answer. ' +
            'Albanian direct-price examples that MUST return true: "sa kushton?", "sa kushtojn?", "sa kushtojne?", "sa kushtoi?", "sa ben?", "cmimi?", "qmimi?". ' +
            'Return only JSON: {"is_price_question": true} or {"is_price_question": false}.',
        },
        {
          role: 'user',
          content: `Customer message:\n${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_price_question?: boolean };
      if (parsed.is_price_question === true) {
        console.info('[price_classifier] result=true message_preview:', logSafe(inbound));
        return true;
      }
      if (parsed.is_price_question === false) {
        console.info('[price_classifier] result=false message_preview:', logSafe(inbound));
        return false;
      }
      console.warn('[price_classifier] unexpected shape — falling back to lexical', { raw: logSafeStructured(raw) });
    }
  } catch (err) {
    console.warn('[price_classifier] classifier failed — falling back to lexical', {
      error: err instanceof Error ? err.message : String(err),
      message_preview: logSafe(inbound),
    });
  }

  // Classifier errored or returned an unparseable shape — the legacy fallback, unchanged.
  return lexical;
}

const DISCOUNT_REQUEST_KEYWORDS = [
  'discount',
  'discounted',
  'cheaper',
  'lower price',
  'reduce',
  'reduction',
  'sale',
  'promo',
  'promotion',
  'deal',
  'offer',
  'coupon',
  'zbritje',
  'zbritj',
  'ulje',
  'me lire',
  'me lir',
  'me ulje',
  'me zbritje',
  'me zbritj',
  'oferte',
  'ofertë',
  'cmim me i lire',
  'qmim me i lire',
  'a ben dicka',
  'a ben gje',
  'a ka zbritje',
  'a ka ulje',
];

export async function customerAskedAboutDiscount(message: string): Promise<boolean> {
  const inbound = message.trim();
  if (!inbound) return false;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict intent classifier. Detect whether the customer message asks for a discount, price reduction, sale, promotion, special offer, deal, or any form of lower price (in any language, slang, shorthand, or misspelling). This includes negotiation phrases like "can you go lower", "any discount", "make it cheaper", or in Albanian "a ka zbritje", "a ben dicka me cmimin", "me lire". Return only JSON: {"is_discount_request": true} or {"is_discount_request": false}.',
        },
        {
          role: 'user',
          content: `Customer message:\n${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_discount_request?: boolean };
      if (parsed.is_discount_request === true) return true;
      if (parsed.is_discount_request === false) return false;
    }
  } catch {
    // Fall through to lexical fallback if classifier is unavailable.
  }

  return includesAnyKeyword(inbound, DISCOUNT_REQUEST_KEYWORDS);
}

/**
 * AI-backed speculative-health-advice detector.
 *
 * Upgrades `containsSpeculativeHealthAdvice` from a fixed phrase list to an open
 * vocabulary: novel phrasings the keyword list has never seen — "I'd recommend
 * checking with a specialist", "it would be wise to see a health expert", new
 * Albanian formulations, etc. — are now caught by the LLM.
 *
 * Architecture (fast → precise):
 *   1. Keyword fast-path: if the existing phrase list already flags the text the
 *      LLM call is skipped entirely (zero extra latency for known patterns).
 *   2. LLM pass: open-vocabulary semantic check that catches anything the list
 *      missed.
 *   3. Fail-open on error: returns false so a transient OpenAI outage never
 *      silently suppresses a valid reply.
 *
 * The catalog usage-description check (adviceIsFromCatalog) deliberately keeps
 * the synchronous keyword version — catalog text is our own structured data, not
 * free-form model output, so the phrase list is fully adequate there and the
 * extra round-trip would be wasteful.
 */
export async function classifySpeculativeHealthAdvice(text: string): Promise<boolean> {
  if (!text.trim()) return false;

  // Fast path: keyword list catches the most common known phrases instantly.
  if (containsSpeculativeHealthAdvice(text)) return true;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict safety classifier for a product sales chatbot. ' +
            'Determine whether the text contains ANY recommendation that the customer consult, speak to, or seek advice from a doctor, physician, specialist, dietitian, nutritionist, or any health/medical professional — in ANY language, phrasing, or wording, including novel or indirect formulations such as "I would recommend checking with a specialist", "it would be wise to see a health expert", "consider speaking to your GP", or the Albanian equivalents. ' +
            'Return ONLY JSON: {"contains_speculative_health_advice": true} or {"contains_speculative_health_advice": false}.',
        },
        { role: 'user', content: text },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content?.trim();
    if (raw) {
      const parsed = JSON.parse(raw) as { contains_speculative_health_advice?: boolean };
      if (typeof parsed.contains_speculative_health_advice === 'boolean') {
        return parsed.contains_speculative_health_advice;
      }
    }
  } catch (err) {
    console.warn('[speculative_health_classifier] classifier failed — falling open', {
      error: err instanceof Error ? err.message : String(err),
      text_preview: logSafe(text),
    });
  }

  // Keyword check already returned false above; LLM failed → fail-open.
  return false;
}

/**
 * AI-backed follow-up invitation detector for outbound AI replies.
 *
 * The existing regex patterns (`FOLLOW_UP_INVITATION_PATTERNS` in processAIReply.ts)
 * cover a fixed list of known phrases ("let me know", "feel free to ask",
 * "më tregoni", …). Novel formulations — "don't hesitate to reach out",
 * "po keni pyetje tjera ju lutem shkruani", "nëse ka ndonjë pyetje jemi këtu" —
 * escape them entirely.
 *
 * Architecture (fast → precise):
 *   1. Regex fast-path (inline copy of known patterns): instant for phrases
 *      already in the list. The copy here stays in sync with processAIReply.ts
 *      by intention — if you add a pattern there, add it here too; the LLM
 *      backstop covers the gap in between.
 *   2. LLM pass: catches any novel invitation phrasing.
 *   3. Fail-open on error: returns false so a transient failure never causes a
 *      wrongly-stripped reply.
 *
 * This is used in processAIReply.ts as the initial whole-reply check gate.
 * Per-sentence stripping still uses the fast regex (FOLLOW_UP_INVITATION_PATTERNS)
 * to identify WHICH sentence to remove — once the LLM has confirmed the reply
 * contains an invitation sentence, the regex narrows it down.
 */
export async function classifyFollowUpInvitationInReply(reply: string): Promise<boolean> {
  const text = (reply ?? '').trim();
  if (!text) return false;

  // Fast path: normalize and run the known patterns.
  const normalized = normalizeForIntentMatch(text);
  const KNOWN_PATTERNS: RegExp[] = [
    /(^|\s)(me|m)\s+tregon[ij]?(\s|$|[.,!?])/u,
    /(^|\s)(me|m)\s+shkrua(j|ni|jeni)?(\s|$|[.,!?])/u,
    /(^|\s)(me|m)\s+kontakto(n[ij]?|j)?(\s|$|[.,!?])/u,
    /\blet me know\b/u,
    /\bfeel free to (ask|reach|contact|message)\b/u,
    /\b(is there )?anything else\b/u,
    /\bif you (have|need|want).*(let me know|just ask|tell me)\b/u,
  ];
  if (KNOWN_PATTERNS.some((re) => re.test(normalized))) return true;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict classifier for a sales chatbot reply filter. ' +
            'Determine whether the assistant reply contains ANY sentence that invites the customer to follow up with further questions, contact the business, or reach out again — in ANY language or phrasing, including novel or informal formulations such as "don\'t hesitate to reach out", "we\'re always here", "po keni pyetje tjera shkruani", "nëse keni ndonjë pyetje jemi këtu", or similar. ' +
            'Do NOT flag order-related follow-ups like "would you like to order?" — only flag general follow-up invitations that say the customer may ask more questions or contact the business. ' +
            'Return ONLY JSON: {"contains_follow_up_invitation": true} or {"contains_follow_up_invitation": false}.',
        },
        { role: 'user', content: text },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content?.trim();
    if (raw) {
      const parsed = JSON.parse(raw) as { contains_follow_up_invitation?: boolean };
      if (typeof parsed.contains_follow_up_invitation === 'boolean') {
        return parsed.contains_follow_up_invitation;
      }
    }
  } catch (err) {
    console.warn('[follow_up_invitation_classifier] classifier failed — falling open', {
      error: err instanceof Error ? err.message : String(err),
      reply_preview: logSafe(text),
    });
  }

  return false;
}

/**
 * LLM classifier (semantic, not keyword-based) that decides whether a message is a
 * follow-up about the product(s) already discussed earlier in the conversation —
 * asking for ANY detail or attribute (price, brand, flavor, size, color, variant,
 * weight, category, ingredients, description, servings, stock/availability, images, …)
 * — rather than requesting a different/new product or changing topic.
 *
 * It is robust to misspellings, slang, and dialect that the regex/keyword heuristics
 * miss (e.g. "sa kshtjn", "qfar shejsh", "a ka stok"). The already-discussed product
 * names are passed as context so the model can reject genuinely new product requests.
 *
 * Used only as a last-resort gate before the AI would otherwise claim a product the
 * customer already saw is unavailable, so the extra latency is paid on the rare empty-
 * retrieval path, never on the happy path. Fails closed (returns false) when the LLM is
 * unavailable; the caller has already applied the cheap heuristic gate by then.
 */
export async function classifyContextualProductFollowUp(
  message: string,
  discussedProducts: Product[],
): Promise<boolean> {
  const inbound = message.trim();
  if (!inbound) return false;

  const names = discussedProducts
    .map((p) => p.name?.trim())
    .filter((n): n is string => Boolean(n))
    .slice(0, 10);

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You decide whether a customer message is a FOLLOW-UP question about the product(s) already discussed earlier in this conversation, as opposed to a request for a DIFFERENT/new product or an unrelated topic. ' +
            'A follow-up asks for any detail or attribute of the already-discussed product(s): price, brand, flavor, size, color, variant, weight, category/type, ingredients, description/details, servings/quantity, stock/availability, images, etc. — usually without naming a new product, often using references like "this/these/it/them/the first one" (English) or "kjo/këto/ato/kët/tij/i pari" (Albanian). ' +
            'Handle ANY language, dialect, slang, shorthand, and misspellings (e.g. "sa kshtjn", "qfar shejsh", "a ka stok", "cila marke"). Classify by MEANING, not exact spelling. ' +
            'Return false when the customer names or asks for a DIFFERENT product or category than those already discussed, or changes topic (greeting, order placement, business info, delivery, etc.). ' +
            'Return only JSON: {"is_followup": true} or {"is_followup": false}.',
        },
        {
          role: 'user',
          content:
            `Products already discussed: ${names.length > 0 ? names.join('; ') : '(unspecified)'}\n` +
            `Customer message: ${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 16,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { is_followup?: boolean };
      if (typeof parsed.is_followup === 'boolean') {
        console.info('[followup_classifier] result=' + parsed.is_followup + ' message_preview:', logSafe(inbound));
        return parsed.is_followup;
      }
    }
  } catch (err) {
    console.warn('[followup_classifier] classifier failed — falling back to heuristics', {
      error: err instanceof Error ? err.message : String(err),
      message_preview: logSafe(inbound),
    });
  }

  return false;
}

export interface OtherProductOptionsIntentResult {
  is_other_options_request: boolean;
  /**
   * The product category/type the customer is asking about (e.g. "protein", "creatine").
   * Null when the category couldn't be determined or the intent wasn't detected.
   */
  category_hint: string | null;
}

/**
 * Fast synchronous heuristic for detecting "other options" intent.
 * Used as a fallback when the LLM classifier is unavailable, and as a
 * pre-screen to skip the LLM call on obviously non-matching messages.
 */
function otherOptionsHeuristic(message: string): boolean {
  const t = message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!t || t.length > 300) return false;

  const OTHER_OPTIONS_PATTERNS: RegExp[] = [
    // "any/are there/do you have other|more options/products/alternatives"
    /\b(any|are there|do you have|a keni|keni)\s+(other|more|different|tjet[ëe]r|ndryshme)\s*\w*\s*(options?|products?|choices?|alternatives?|opsione|produkte|zgjedhje)\b/i,
    // "other/more/alternative X options/products"
    /\b(other|more|alternative|tjet[ëe]r)\s+\w+\s+(options?|products?|opsione|produkte)\b/i,
    // "what else / anything else"
    /\b(what else|anything else|else do you (have|carry|sell)|cfare tjeter|tjetere|ndonje tjeter)\b/i,
    // "show/suggest/recommend me more/other"
    /\b(show|suggest|recommend)\s+(me\s+)?(more|other|different|tjeter)\b/i,
    // Albanian: "me shumë alternativa/opsione"
    /\bme\s+(shum[ëe]|alternativa|opsione|mundesi)\b/i,
    // Albanian: "a keni / keni ... tjetër/more" (single additional word in between)
    /\b(a\s+keni|keni)\s+\w+\s+(tjet[ëe]r|me\s+teper|tjeter|me shume)\b/i,
    // Albanian plural "tjera" / "tjetra" — "a keni tjera", "keni tjera", "a ka tjera"
    // "tjera" is the plural of "tjetër" (= "others/other ones"), not covered by tjet[ëe]r
    /\b(a\s+keni|keni|a\s+ka|ka)\s+(tjera|tjetra)\b/i,
    // "ndonjë tjetër" / "ndonje tjeter" — "any other"
    /\bndonj[eë]\s+tjet[eë]r\b/i,
    // "more options" / "other options" standalone
    /\b(more|other)\s+options?\b/i,
    // "any alternatives" / "any other alternatives"
    /\bany\s+(other\s+)?alternatives?\b/i,
  ];

  return OTHER_OPTIONS_PATTERNS.some((re) => re.test(t));
}

/**
 * Classifies whether the customer is asking to see DIFFERENT / MORE / OTHER products or
 * alternatives beyond what has already been shown — in any language, dialect, slang, or with
 * typos. This cannot be reliably detected with regex alone because natural language varies
 * enormously (e.g. "got anything else in that line?", "show me the rest", "ndonjë tjetër?").
 *
 * Approach: LLM classifier (primary) with a keyword/regex heuristic fallback. The heuristic
 * is also used as a pre-screen to skip the LLM call on obviously non-matching messages so we
 * only pay for the classifier when the message is plausibly relevant.
 *
 * When "other options" intent is detected the caller should:
 *   1. Use CATEGORY_GROUP_MATCH_LIMIT (not FOCUSED_PRODUCT_MATCH_LIMIT) to retrieve
 *      more products from the catalog.
 *   2. Perform a fresh category search (skip the persisted-product contextual resolver)
 *      so the customer is shown products they haven't already been shown.
 */
export async function classifyOtherProductOptionsIntent(
  message: string,
): Promise<OtherProductOptionsIntentResult> {
  const inbound = message.trim();
  const falseResult: OtherProductOptionsIntentResult = { is_other_options_request: false, category_hint: null };

  if (!inbound) return falseResult;

  // Fast pre-screen: skip LLM call for very short messages that clearly aren't
  // "other options" requests (greetings, single-word replies, etc.).
  const couldBeOtherOptions =
    inbound.length >= 5 &&
    !/^(ok|yes|no|po|jo|hi|hello|hey|sure|thanks|ok po|spo)(\s*[!.?])?$/i.test(inbound.trim());

  if (!couldBeOtherOptions) return falseResult;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict intent classifier for an e-commerce assistant. ' +
            'Determine whether the customer is asking to see MORE / DIFFERENT / OTHER products or alternatives ' +
            'beyond what they have already been shown — in any language, dialect, slang, or with typos.\n\n' +
            'Return TRUE when the message expresses intent such as:\n' +
            '  "are there other options?", "any more alternatives?", "what else do you have?",\n' +
            '  "show me more", "any other products in this category?", "do you have anything else?",\n' +
            '  "other variants", "other choices", "tjetër?", "më shumë alternativa", "a keni tjeter",\n' +
            '  "ndonjë tjetër?", "got anything else?", "show me the rest of the range".\n\n' +
            'Return FALSE when the message is:\n' +
            '  - asking about details/price/attributes of a specific product already discussed,\n' +
            '  - a first-time product inquiry with no prior context,\n' +
            '  - an order placement or affirmation,\n' +
            '  - a greeting, closing, or topic unrelated to product browsing.\n\n' +
            'Also extract the product category/type the customer is asking about when clear ' +
            '(e.g. "protein", "creatine", "weight gainer"). Return null for category_hint when ' +
            'the category is not mentioned or cannot be determined.\n\n' +
            'Return only JSON: {"is_other_options_request": true, "category_hint": "protein"} ' +
            'or {"is_other_options_request": false, "category_hint": null}.',
        },
        {
          role: 'user',
          content: `Customer message:\n${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 64,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as {
        is_other_options_request?: boolean;
        category_hint?: string | null;
      };
      if (typeof parsed.is_other_options_request === 'boolean') {
        const result: OtherProductOptionsIntentResult = {
          is_other_options_request: parsed.is_other_options_request,
          category_hint:
            typeof parsed.category_hint === 'string' && parsed.category_hint.trim()
              ? parsed.category_hint.trim()
              : null,
        };
        console.info('[other_options_classifier]', {
          result: result.is_other_options_request,
          category_hint: result.category_hint,
          message_preview: logSafe(inbound),
        });
        return result;
      }
    }
  } catch (err) {
    console.warn('[other_options_classifier] Classifier failed — falling back to heuristic', {
      error: err instanceof Error ? err.message : String(err),
      message_preview: logSafe(inbound),
    });
  }

  // Keyword/regex fallback when classifier is unavailable.
  return { is_other_options_request: otherOptionsHeuristic(inbound), category_hint: null };
}

/**
 * Lightweight heuristic backstop for the LLM language classifier. Detects clear Albanian/English
 * markers; returns null when the message is too ambiguous (very short, emoji-only, digits,
 * affirmation tokens like "ok"/"po"/"yes" that exist in both languages or in slang).
 *
 * Diacritics are NOT required to detect Albanian — typos and Latin-only spellings are normal in
 * messaging apps, so we lowercase + strip diacritics before matching.
 */
function heuristicallyDetectLanguage(text: string): ReplyLocale | null {
  const raw = text.trim();
  if (!raw) return null;

  if (/[ËëÇç]/.test(raw)) return 'sq';

  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const ALBANIAN_MARKERS = [
    'pershendetje', 'mirdita', 'naten e mire', 'faleminderit', 'flm', 'fln',
    'porosi', 'porosit', 'porosis', 'cmim', 'qmim', 'stok', 'produkt', 'produkti',
    'doni', 'deshironi', 'mund', 'kemi', 'kam', 'keni', 'jam', 'jeni',
    'nuk', 'pse', 'ku', 'kur', 'sa kushton', 'a keni', 'a kemi', 'me lir',
    'gjendet', 'derges', 'adres', 'ju lutem', 'mire', 'kalofshi', 'kalofsh',
    'mund te', 'mundeni', 'jashte stoku',
  ];
  const ENGLISH_MARKERS = [
    'hello', 'hi there', 'hey', 'good morning', 'good afternoon', 'good evening',
    'thanks', 'thank you', 'please', 'sorry', 'how much', 'do you have',
    'is this', 'is it', 'are you', 'are these', 'i need', 'i want', 'i would like',
    'can you', 'could you', 'would you', 'available', 'in stock', 'out of stock',
    'shipping', 'delivery', 'address', 'order', 'product', 'price', 'cost',
    'discount', 'cheaper', 'refund', 'cancel',
  ];

  // P2-5 (RC-10/RC-25): the marker list is Tosk-leaning, so a pure-Gheg turn ("Qysh o moti
  // sot", "O shef qa bone") hits nothing and returns null — which costs a paid LLM language
  // call, and under P2-2's STICKY_LOCALE_SLOT this heuristic is the SOLE inbound-marker
  // source (the LLM call is skipped), so a null silently keeps the previous locale instead
  // of steering it. Some Gheg markers must be space-padded (' ma ' — bare 'ma' is a
  // substring of countless product names), so the haystack is padded to let them match at
  // the string boundaries. That padding is a provable no-op for the legacy needles: none of
  // them starts or ends with a space. Flag-off is byte-identical.
  const albanianMarkers = withGhegMarkers(ALBANIAN_MARKERS, GHEG_ALBANIAN_MARKERS);
  const haystack = GHEG_LEXICONS ? ` ${normalized} ` : normalized;

  const albanianHits = albanianMarkers.filter((needle) => haystack.includes(needle)).length;
  const englishHits = ENGLISH_MARKERS.filter((needle) => haystack.includes(needle)).length;

  if (albanianHits >= 1 && albanianHits > englishHits) return 'sq';
  if (englishHits >= 1 && englishHits > albanianHits) return 'en';
  return null;
}

/**
 * Detects whether the AI should reply in Albanian (`sq`) or English (`en`).
 *
 * The latest customer message drives the decision. For very short or ambiguous messages
 * ("ok", "po", "yes", emojis, numbers), we feed the recent customer turns to the LLM as
 * tie-breaking context so the conversation does not flip languages mid-thread. The classifier
 * is asked to return ONLY `sq` or `en`; we never emit any other locale.
 */
export async function detectReplyLanguage(
  inboundMessage: string,
  conversationHistory: Message[] = [],
  stickyLocale: ReplyLocale | null = null,
): Promise<ReplyLocale> {
  const inbound = inboundMessage.trim();

  // P2-2 (RC-10) sticky-locale slot: reuse the conversation's resolved locale unless THIS turn
  // carries a high-confidence unambiguous opposite-language marker (hysteresis allowing a genuine
  // mid-conversation switch). Skips the stochastic LLM language call and stops ambiguous turns
  // from flipping the language.
  if (STICKY_LOCALE_SLOT && stickyLocale) {
    return resolveStickyLocale(stickyLocale, heuristicallyDetectLanguage(inbound));
  }

  const customerHistory = conversationHistory
    .filter((msg) => msg.sent_by === 'customer')
    .map((msg) => (msg.content ?? '').trim())
    .filter((text) => text.length > 0);
  const recentCustomerTexts = customerHistory.slice(-4);
  const sampleForHeuristic =
    inbound || recentCustomerTexts[recentCustomerTexts.length - 1] || '';

  if (!sampleForHeuristic) return DEFAULT_REPLY_LOCALE;

  // Fast path: if the latest message has unambiguous language signals, skip the API call.
  const heuristicForInbound = heuristicallyDetectLanguage(inbound);
  if (heuristicForInbound !== null) {
    return heuristicForInbound;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict language classifier for an Albanian/English customer-support assistant. Decide whether the LATEST customer message should be answered in Albanian ("sq") or English ("en"). Only those two outputs are allowed. Rules:\n- If the latest message is clearly Albanian (with or without diacritics), return "sq".\n- If the latest message is clearly English, return "en".\n- For very short or ambiguous messages (e.g., "ok", "po", "yes", "no", emojis, numbers, single product names), use the language of the recent prior customer messages. If those are also absent or ambiguous, return "sq".\n- Mixed messages: pick the language of the majority of meaningful words.\nReturn only JSON: {"language":"sq"} or {"language":"en"}.',
        },
        {
          role: 'user',
          content: `Recent customer messages (oldest to newest):\n${
            recentCustomerTexts.length > 0
              ? recentCustomerTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')
              : '(none)'
          }\n\nLatest customer message to classify:\n${inbound || '(empty)'}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 32,
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw?.trim()) {
      const parsed = JSON.parse(raw) as { language?: string };
      if (parsed.language === 'en') return 'en';
      if (parsed.language === 'sq') return 'sq';
    }
  } catch {
    // Fall through to heuristic over the most recent customer turn(s).
  }

  for (let i = recentCustomerTexts.length - 1; i >= 0; i -= 1) {
    const guess = heuristicallyDetectLanguage(recentCustomerTexts[i]);
    if (guess !== null) return guess;
  }
  return DEFAULT_REPLY_LOCALE;
}

function assistantAlreadyAddressedDiscount(conversationHistory: Message[]): boolean {
  const assistantMessages = conversationHistory.filter((msg) => msg.sent_by !== 'customer');
  if (assistantMessages.length === 0) return false;

  return assistantMessages.some((msg) => {
    const normalized = normalizeForIntentMatch(msg.content ?? '');
    if (!normalized) return false;
    return (
      /\b(zbritj|ulje|me lire|me lir|cmim final|qmim final|cmimi aktual|qmimi aktual|nuk mund te aplikohet|nuk mund te bejme zbritje|asnje zbritje|nuk ka zbritje)\b/.test(
        normalized,
      ) ||
      /\b(discount|reduction|final price|no further discount|no additional discount|cannot offer)\b/.test(
        normalized,
      )
    );
  });
}

/**
 * Detects whether a previous assistant reply has already communicated that the price is final
 * (no additional discount possible, or the displayed price is final because no discount is configured).
 * Used to silence repeated discount requests once the matter has been finalized.
 */
function assistantAlreadyFinalizedDiscount(conversationHistory: Message[]): boolean {
  const assistantMessages = conversationHistory.filter((msg) => msg.sent_by !== 'customer');
  if (assistantMessages.length === 0) return false;

  return assistantMessages.some((msg) => {
    const normalized = normalizeForIntentMatch(msg.content ?? '');
    if (!normalized) return false;

    // Albanian: "çmim ... final" / "çmimi aktual është final" (after diacritic stripping).
    const albanianFinalPrice =
      /\b(final|finale)\b/.test(normalized) &&
      /\b(cmim|cmimi|qmim|qmimi)\b/.test(normalized);

    // Albanian: "nuk mund të aplikohet zbritje shtesë" / "asnjë zbritje" / "nuk është e mundur asnjë zbritje".
    const albanianNoFurtherDiscount =
      /\b(zbritje shtese|zbritj shtese|asnje zbritje|asnje zbritj|nuk ka zbritje|nuk ka zbritj|nuk eshte e mundur asnje zbritje|nuk eshte e mundur asnje zbritj|nuk mund te aplikohet|nuk mund te bejme zbritje|nuk mund te beje zbritje)\b/.test(
        normalized,
      );

    // English fallback.
    const englishFinalPrice =
      /\b(final price|price is final|no further discount|no additional discount|no more discount|cannot offer (any|further|additional))\b/.test(
        normalized,
      );

    return albanianFinalPrice || albanianNoFurtherDiscount || englishFinalPrice;
  });
}

/** Lexical + semantic + tag/category catalog lookup for inbound customer text. */
export async function findProductsForInboundMessage(
  tenantId: string,
  inboundMessage: string,
  limit = 5,
): Promise<Product[]> {
  return matchProductsForCustomerMessage(tenantId, inboundMessage, limit);
}

/**
 * Exact replies (per language) when the customer is asking about one focused catalog match that
 * is out of stock. The locale is decided by `detectReplyLanguage` upstream.
 */
export const OUT_OF_STOCK_PRODUCT_REPLY: Record<ReplyLocale, string> = {
  sq: 'Përshëndetje, produkti për momentin është jashtë stokut. Nëse jeni të interesuar për ndonjë produkt tjetër, mund te ju ndihmoj.',
  en: 'Hello, this product is currently out of stock. If you are interested in any other product, I would be happy to help.',
};

export function getOutOfStockProductReply(locale: ReplyLocale): string {
  return OUT_OF_STOCK_PRODUCT_REPLY[locale];
}

export function isOutOfStockProductReply(reply: string): boolean {
  const trimmed = reply.trim();
  return (
    trimmed === OUT_OF_STOCK_PRODUCT_REPLY.sq ||
    trimmed === OUT_OF_STOCK_PRODUCT_REPLY.en
  );
}

function looksLikeSimpleGreetingOrClosing(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (t.length > 80) return false;
  return (
    /^(hi|hello|hey|hej|faleminderit|thanks|thank you|ok|okej)(\s*[!.?])?\s*$/i.test(lower) ||
    /^(përshëndetje|pershendetje|mirdita)(\s*[!.?])?\s*$/i.test(lower)
  );
}

/** Lowercase, strip diacritics, collapse punctuation to spaces (Albanian-friendly loose match). */
function foldForProductReference(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Whether the inbound text likely names this product (used when several catalog rows matched).
 * Uses SKU, diacritic-insensitive name match, compact name, token overlap, and brand + name word.
 */
function inboundTextLikelyReferencesProduct(inboundMessage: string, product: Product): boolean {
  const raw = inboundMessage.trim();
  if (!raw) return false;

  const sku = product.sku?.trim();
  if (sku && sku.length >= 3) {
    const skuKey = normalizeForMatch(sku);
    const msgKey = normalizeForMatch(raw);
    if (skuKey.length >= 3 && msgKey.includes(skuKey)) return true;
  }

  const nameRaw = product.name?.trim() ?? '';
  if (!nameRaw) return false;

  const hay = foldForProductReference(raw);
  const name = foldForProductReference(nameRaw);
  if (!name) return false;

  if (name.length >= 3 && hay.includes(name)) return true;

  const nameCompact = name.replace(/\s/g, '');
  const hayCompact = hay.replace(/\s/g, '');
  if (nameCompact.length >= 4 && hayCompact.includes(nameCompact)) return true;

  const tokens = name.split(/\s+/).filter((w) => w.length > 0);
  const significant = tokens.filter((w) => w.length >= 4);
  const check = significant.length > 0 ? significant : tokens.filter((w) => w.length >= 3);
  if (check.length === 0) return false;
  const hits = check.filter((w) => hay.includes(w));
  if (hits.length >= Math.ceil(check.length * 0.5)) return true;

  const brand = getProductBrand(product);
  if (brand && brand.trim().length >= 2) {
    const b = foldForProductReference(brand);
    if (b.length >= 2 && hay.includes(b) && significant.some((w) => hay.includes(w))) return true;
  }

  return false;
}

export type FormatProductCatalogOptions = {
  includePrice?: boolean;
  includeDiscount?: boolean;
  totalCatalogCount?: number;
  /** Brief summaries by default to prevent the model from copying long descriptions. */
  descriptionMode?: CatalogTextMode;
  usageDescriptionMode?: CatalogTextMode | 'omit';
  /**
   * P0-2: per-product evidence-aware render decisions (product id → decision).
   * A decision escalates that product's field to 'full' or 'extract' (brief +
   * verbatim overlapping sentences); products without a decision keep the
   * turn-global modes above. A 'full' turn-global mode always wins.
   */
  textDecisions?: Map<string, CatalogTextDecision>;
  /** Customer photo did not match any catalog product — do not ask for more details. */
  productNotInCatalog?: boolean;
};

export function formatProductCatalog(
  products: Product[],
  options?: FormatProductCatalogOptions,
): string {
  const includePrice = options?.includePrice ?? true;
  const includeDiscount = options?.includeDiscount ?? false;
  const totalCatalogCount = options?.totalCatalogCount ?? 0;
  const descriptionMode: CatalogTextMode = options?.descriptionMode ?? 'brief';
  const usageDescriptionMode: CatalogTextMode | 'omit' =
    options?.usageDescriptionMode ?? 'brief';

  if (products.length === 0) {
    if (options?.productNotInCatalog) {
      return (
        '[The customer\'s product photo does not match anything in the catalog. ' +
        'Tell the customer honestly and briefly that you do not carry this product. ' +
        'Do NOT ask for a clearer photo or more product details. ' +
        'Do NOT provide general product information from the image.]'
      );
    }
    if (totalCatalogCount > 0) {
      return (
        `[This business has ${totalCatalogCount} active product(s) in its catalog. ` +
        `No products closely matched the current query — do NOT claim a product does not exist. ` +
        `Ask the customer to clarify the product name or provide more details so you can look it up accurately.]`
      );
    }
    return 'No matching products found in the catalog.';
  }

  const catalogLines = products
    .map((p) => {
      const typeText = p.tags.length > 0 ? p.tags.join(', ') : 'N/A';
      const parts = [
        `- Brand: ${getProductBrand(p) ?? 'Unknown'}, Product: ${p.name}, Type: ${typeText}`,
      ];
      if (includePrice) {
        parts.push(`  Price: €${Number(p.price).toFixed(2)}`);
      }
      if (includeDiscount || includePrice) {
        const discounted = p.discounted_price;
        if (discounted !== null && discounted !== undefined) {
          const discountedNum = Number(discounted);
          if (Number.isFinite(discountedNum)) {
            parts.push(
              `  Discounted price (maximum offer when customer asks for a discount): €${discountedNum.toFixed(2)}`,
            );
          }
        } else if (includeDiscount) {
          parts.push('  Discounted price: not configured (no discount available)');
        }
      }
      const decision = options?.textDecisions?.get(p.id);
      const effectiveDescriptionMode: CatalogTextMode =
        descriptionMode === 'full' || decision?.descriptionMode === 'full' ? 'full' : 'brief';
      const descriptionLine = formatCatalogDescriptionLine(p.description, effectiveDescriptionMode);
      if (descriptionLine) parts.push(descriptionLine);
      if (effectiveDescriptionMode !== 'full' && decision?.descriptionMode === 'extract') {
        const excerptLine = formatCatalogDescriptionExcerpts(decision.descriptionExcerpts ?? []);
        if (excerptLine) parts.push(excerptLine);
      }
      const effectiveUsageMode: CatalogTextMode | 'omit' =
        usageDescriptionMode === 'full' || decision?.usageMode === 'full'
          ? 'full'
          : decision?.usageMode === 'extract'
            ? 'brief'
            : usageDescriptionMode;
      parts.push(...formatCatalogUsageLine(p.usage_description, effectiveUsageMode));
      if (effectiveUsageMode !== 'full' && decision?.usageMode === 'extract') {
        parts.push(...formatCatalogUsageExcerpts(decision.usageExcerpts ?? []));
      }
      if (p.category) parts.push(`  Category: ${p.category}`);
      const attrParts: string[] = [];
      if (p.flavor) attrParts.push(`Flavor: ${p.flavor}`);
      if (p.size) attrParts.push(`Size: ${p.size}`);
      if (p.color) attrParts.push(`Color: ${p.color}`);
      if (p.variant) attrParts.push(`Variant: ${p.variant}`);
      if (p.weight) attrParts.push(`Weight: ${p.weight}`);
      if (attrParts.length > 0) parts.push(`  ${attrParts.join(', ')}`);
      if (p.tags.length > 0) parts.push(`  Tags: ${p.tags.join(', ')}`);
      parts.push(
        `  Stock status (agent-only; do not mention unless the customer asks about availability/stock): ${p.in_stock === false ? 'out of stock' : 'in stock'}`,
      );
      return parts.join('\n');
    })
    .join('\n');

  // When the catalog has more products than are shown, append a clear instruction
  // so the AI does not falsely claim a product doesn't exist just because it is
  // absent from the current context window. CRITICAL: the note must also explicitly
  // prohibit naming or inventing products from the hidden portion — without this
  // the model may hallucinate product names for the "missing" slots when the
  // customer asks for other/more options in a category.
  const hiddenCount = totalCatalogCount > products.length ? totalCatalogCount - products.length : 0;
  if (hiddenCount > 0) {
    return (
      catalogLines +
      `\n\n[Note: Only the ${products.length} most relevant product(s) are shown above. ` +
      `The full catalog contains ${totalCatalogCount} active product(s). ` +
      `IMPORTANT: Do NOT name, invent, or reference any specific product not listed above — only recommend products explicitly shown in this catalog section. ` +
      `If the customer asks about a product not listed here, do NOT say it does not exist — ` +
      `ask the customer to clarify the product name or provide more details so you can look it up accurately. ` +
      `CRITICAL: If you recommended a product in a previous conversation turn and it is not shown in the current catalog section, ` +
      `that product IS in the catalog — do NOT say it is unavailable or missing. ` +
      `The catalog section shown here is a filtered view for this specific query, not the complete catalog.]`
    );
  }

  return catalogLines;
}

function formatQAPairs(pairs: { question: string; answer: string }[]): string {
  if (pairs.length === 0) return '';

  const formatted = pairs
    .map((pair) => `Q: ${pair.question}\nA: ${pair.answer}`)
    .join('\n\n');

  return `\n\nFrequently Asked Questions:\n${formatted}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCatalogBrandProductPairs(
  productCatalogContext: string,
): Array<{ brand: string; product: string }> {
  if (!productCatalogContext.trim()) return [];
  const pairs: Array<{ brand: string; product: string }> = [];
  const lines = productCatalogContext.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = /^-\s*Brand:\s*(.+?),\s*Product:\s*(.+?),\s*Type:/i.exec(line);
    if (!match) continue;
    const brand = match[1]?.trim();
    const product = match[2]?.trim();
    if (!brand || !product) continue;
    if (brand.toLowerCase() === 'unknown') continue;
    pairs.push({ brand, product });
  }
  return pairs;
}

function normalizeProductMentionsForReply(
  reply: string,
  productCatalogContext: string,
): string {
  let normalized = reply;
  const quoteChars = `"'“”‘’`;
  const escapedQuoteChars = `"'“”‘’`;
  const pairs = extractCatalogBrandProductPairs(productCatalogContext);

  for (const { brand, product } of pairs) {
    const escapedBrand = escapeRegExp(brand);
    const escapedProduct = escapeRegExp(product);
    const brandPlusProduct = new RegExp(`\\b${escapedBrand}\\s+${escapedProduct}\\b`, 'giu');
    normalized = normalized.replace(brandPlusProduct, product);

    const wrappedProduct = new RegExp(
      `[\"'“”‘’]\\s*(${escapedProduct})\\s*[\"'“”‘’]`,
      'giu',
    );
    normalized = normalized.replace(wrappedProduct, '$1');

    const leadingQuotedProduct = new RegExp(
      `([\\s(\\[{:,;-])["'“”‘’]\\s*(${escapedProduct})(?=[\\s)\\]}.!?,;:-]|$)`,
      'giu',
    );
    normalized = normalized.replace(leadingQuotedProduct, '$1$2');
  }

  // Remove quote artifacts after Albanian product-article words.
  normalized = normalized.replace(
    new RegExp(`\\b(produkti|produktin|produktit|produktet)\\s*[${escapedQuoteChars}]+`, 'giu'),
    '$1 ',
  );
  // Remove quote artifacts before punctuation and duplicated whitespace.
  normalized = normalized
    .replace(new RegExp(`[${escapedQuoteChars}]+(?=[.,!?;:])`, 'gu'), '')
    .replace(/\s{2,}/g, ' ');

  // If there are unmatched quote chars left in message, strip them to avoid odd rendering.
  const quoteCount = [...normalized].filter((ch) => quoteChars.includes(ch)).length;
  if (quoteCount % 2 === 1) {
    normalized = normalized.replace(new RegExp(`[${escapedQuoteChars}]`, 'gu'), '');
  }

  return normalized.trim();
}

/**
 * Strips leading/trailing whitespace and collapses internal newlines to a single space.
 * Used for single-line fields (business name, tone, niche) to prevent prompt structure
 * injection via newline characters embedded in tenant-controlled strings.
 */
function sanitizeSingleLineField(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** Maximum characters of business description injected into the system prompt. */
const BUSINESS_DESCRIPTION_MAX_CHARS = 2000;

/** CRM "My Business" profile; injected so the model can answer location / about-us style questions. */
export function formatBusinessProfileForPrompt(
  tenantNiche?: string | null,
  tenantDescription?: string | null,
  tenantDeliveryMethods?: string[] | null,
): string | null {
  const niche = typeof tenantNiche === 'string' ? sanitizeSingleLineField(tenantNiche) : '';
  const rawDesc = typeof tenantDescription === 'string' ? tenantDescription.trim() : '';
  const desc =
    rawDesc.length > BUSINESS_DESCRIPTION_MAX_CHARS
      ? rawDesc.slice(0, BUSINESS_DESCRIPTION_MAX_CHARS).trimEnd() + '…'
      : rawDesc;
  const deliveryMethods = Array.isArray(tenantDeliveryMethods)
    ? tenantDeliveryMethods.map((m) => sanitizeSingleLineField(String(m))).filter(Boolean)
    : [];

  if (!niche && !desc && deliveryMethods.length === 0) return null;

  const parts: string[] = ['Business profile (from My Business in the CRM):'];
  if (niche) parts.push(`Industry / niche: ${niche}`);
  if (desc) parts.push(`Details:\n${desc}`);
  if (deliveryMethods.length > 0) {
    parts.push(`Delivery methods: ${deliveryMethods.join(', ')}`);
  }
  return parts.join('\n');
}

/** Core CRM assistant prompt body (guidelines assembled separately from tenant prompt_blocks). */
export function buildRetailAISystemPrompt(
  businessName: string,
  config: typeof DEFAULT_AI_CONFIG & { platform_restrictions?: string[] },
  productCatalogContext: string,
  assembledGuidelines: string,
  tenantNiche?: string | null,
  tenantDescription?: string | null,
  tenantDeliveryMethods?: string[] | null,
): string {
  const safeName = sanitizeSingleLineField(businessName);
  const safeTone = sanitizeSingleLineField(config.tone);

  const lines: string[] = [
    `You are the AI sales assistant for "${safeName}".`,
    `Your tone should be: ${safeTone}.`,
  ];

  if (config.personality_description) {
    lines.push(`Personality: ${config.personality_description}`);
  }

  if (config.sales_strategy) {
    lines.push('', `Sales strategy: ${config.sales_strategy}`);
  }

  if (config.objection_handling) {
    lines.push('', `Objection handling approach: ${config.objection_handling}`);
  }

  const businessProfile = formatBusinessProfileForPrompt(
    tenantNiche,
    tenantDescription,
    tenantDeliveryMethods,
  );
  if (businessProfile) {
    lines.push('', businessProfile);
  }

  lines.push('', 'Product catalog:', productCatalogContext);

  const qa = formatQAPairs(config.qa_pairs);
  if (qa) lines.push(qa);

  const gl = assembledGuidelines.trim();
  if (gl) {
    lines.push('', 'Guidelines:', gl);
  }

  return lines.join('\n');
}

/**
 * P2-5: the footer builder moved to `platformPolicy.ts` so it stays pure and unit-testable
 * (importing aiService pulls in the OpenAI client). Re-exported here to keep the existing
 * import sites working.
 */
export { buildRestrictionsFooter };

const USAGE_UNANSWERED_SYSTEM_PROMPT = `You are a strict semantic classifier. Determine whether the product usage description SPECIFICALLY AND DIRECTLY answers the customer's question.

The text may be in Albanian (Shqip) or English, including informal spellings or missing diacritics.

STRICT RULES — apply in order:

1. SUITABILITY / PERSONAL CIRCUMSTANCE QUESTIONS (highest priority):
   If the customer asks whether the product is suitable, safe, or problematic for their specific personal situation, health condition, or lifestyle (e.g. "I don't work out, can I use this?", "Is this suitable for me?", "Any problem if I don't exercise?", "I'm pregnant, is this ok?"), the usage description MUST EXPLICITLY mention that specific circumstance to return {"is_unanswered": false}.
   General usage instructions (dosage, frequency, how to take) do NOT answer suitability questions about personal circumstances.
   If the specific circumstance is not explicitly addressed → return {"is_unanswered": true}.

2. SPECIFIC DETAIL QUESTIONS:
   If the customer asks about a specific detail (e.g. "how many times per day", "can I mix with water"), the usage description must contain that specific information to return {"is_unanswered": false}.

3. GENERAL USAGE QUESTIONS:
   Return {"is_unanswered": false} only when the usage description clearly and directly addresses what the customer asked — not merely when it is on the same general topic.

4. WHEN IN DOUBT → return {"is_unanswered": true} (fail closed — escalate rather than guess).

Examples:
- Customer: "sa here ne dite" / Description includes "Perdoret 1 here ne dite" → {"is_unanswered": false}
- Customer: "how many times per day" / Description includes "Use once per day" → {"is_unanswered": false}
- Customer: "can pregnant women use it" / Description only mentions frequency → {"is_unanswered": true}
- Customer: "I don't work out, is there any problem?" / Description says "Take 2 scoops before workout" → {"is_unanswered": true}
- Customer: "Is this suitable for me if I don't exercise?" / Description says "Best used with regular training" → {"is_unanswered": true}
- Customer: "Can I use this without exercising?" / Description says "Take daily as directed" → {"is_unanswered": true}

Return only JSON: {"is_unanswered": true} or {"is_unanswered": false}.`;

/**
 * P0-1 widened lane (USAGE_GUARD_EVIDENCE): same strict contract, but the evidence is
 * the full catalog knowledge context (name, category, price, structured attributes,
 * Description:, Usage:, tags, verified packaging reads) rather than usage_description
 * alone — a usage answer stated in the description column counts as answered. The
 * fail-closed rule (4) is unchanged: silence still escalates.
 */
const USAGE_UNANSWERED_CATALOG_EVIDENCE_SYSTEM_PROMPT = `You are a strict semantic classifier. Determine whether the CATALOG EVIDENCE for the product(s) SPECIFICALLY AND DIRECTLY answers the customer's question about product usage.

The catalog evidence may contain product name, category, price, structured attributes, a "Description:" section, a "Usage:" section, tags, and verified packaging details read from product images. Information found in ANY of these sections counts as available catalog knowledge — a usage instruction stated inside the description counts exactly as much as one in the usage section.

The text may be in Albanian (Shqip) or English, including informal spellings or missing diacritics.

STRICT RULES — apply in order:

1. SUITABILITY / PERSONAL CIRCUMSTANCE QUESTIONS (highest priority):
   If the customer asks whether the product is suitable, safe, or problematic for their specific personal situation, health condition, or lifestyle (e.g. "I don't work out, can I use this?", "Is this suitable for me?", "Any problem if I don't exercise?", "I'm pregnant, is this ok?"), the catalog evidence MUST EXPLICITLY mention that specific circumstance to return {"is_unanswered": false}.
   General usage instructions (dosage, frequency, how to take) do NOT answer suitability questions about personal circumstances. Never generalize from a different circumstance (e.g. "not recommended for children under 12" says NOTHING about pregnancy).
   If the specific circumstance is not explicitly addressed → return {"is_unanswered": true}.

2. SPECIFIC DETAIL QUESTIONS:
   If the customer asks about a specific detail (e.g. "how many times per day", "can I mix with water"), the catalog evidence must contain that specific information to return {"is_unanswered": false}.

3. GENERAL USAGE QUESTIONS:
   Return {"is_unanswered": false} only when the catalog evidence clearly and directly addresses what the customer asked — not merely when it is on the same general topic.

4. WHEN IN DOUBT → return {"is_unanswered": true} (fail closed — escalate rather than guess).

Examples:
- Customer: "sa here ne dite" / Evidence includes "Perdoret 1 here ne dite" (in Description or Usage) → {"is_unanswered": false}
- Customer: "how many times per day" / Description says "Take one scoop daily after training" → {"is_unanswered": false}
- Customer: "can pregnant women use it" / Evidence only mentions frequency or age limits → {"is_unanswered": true}
- Customer: "I don't work out, is there any problem?" / Evidence says "Take 2 scoops before workout" → {"is_unanswered": true}
- Customer: "how do I prepare it" / Evidence has only name, price and flavor → {"is_unanswered": true}

Return only JSON: {"is_unanswered": true} or {"is_unanswered": false}.`;

export async function isUsageQuestionUnanswered(
  inboundMessage: string,
  productUsageDescription: string,
  evidenceKind: 'usage' | 'catalog' = 'usage',
): Promise<boolean> {
  const completion = await openai.chat.completions.create({
    model: OPENAI_CLASSIFIER_MODEL,
    messages: [
      {
        role: 'system',
        content:
          evidenceKind === 'catalog'
            ? USAGE_UNANSWERED_CATALOG_EVIDENCE_SYSTEM_PROMPT
            : USAGE_UNANSWERED_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content:
          evidenceKind === 'catalog'
            ? `Customer message:\n${inboundMessage}\n\nCatalog evidence:\n${productUsageDescription}`
            : `Customer message:\n${inboundMessage}\n\nProduct usage description:\n${productUsageDescription}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 64,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) return false;

  try {
    const parsed = JSON.parse(raw) as { is_unanswered?: boolean };
    return parsed.is_unanswered === true;
  } catch {
    return false;
  }
}

// P2-2 (Phase 6 "Remove 1"): the dead `classifyProductKnowledgeQuestionIntent` +
// `isProductKnowledgeQuestionUnanswered` pair (zero call sites, fail-closed-by-default) was
// deleted here — carrying it invited accidental future wiring with the RC-01 fail-closed semantics.
export { classifyProductAttributeIntent, type ProductAttributeIntentResult };

export async function detectCancellationOrRefundIntent(
  inboundMessage: string,
  conversationHistory: Message[],
): Promise<{
  is_cancellation: boolean;
  is_refund: boolean;
  reason: string | null;
  confidence: number;
  /** P1-3 (RC-07): the legacy missing-confidence boost fired for this verdict (ledger field). */
  confidence_boost_applied?: boolean;
}> {
  const historySlice = conversationHistory.slice(-8);
  const historyText = historySlice
    .map((msg) => {
      const who = msg.sent_by === 'customer' ? 'Customer' : 'Agent';
      return `${who}: ${(msg.content ?? '').trim()}`;
    })
    .join('\n');

  const completion = await openai.chat.completions.create({
    model: OPENAI_CLASSIFIER_MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a precise intent classifier. Determine if a customer is requesting to cancel or refund a SPECIFIC PRODUCT ORDER they have already placed with this business.
Only return is_cancellation: true if:

The customer explicitly says they want to cancel an order they already placed
The context makes clear this is about a completed purchase, not a hypothetical or future one
They are not talking about cancelling a subscription, newsletter, or other non-product service

Only return is_refund: true if:

The customer explicitly says they want a refund for something they already purchased and paid for
The context makes clear money was exchanged for a product

Return is_cancellation: false and is_refund: false for:

Questions about the return or cancellation policy
Hypothetical questions like 'what if I want to cancel?'
Cancelling something unrelated to a product order
General complaints without a refund request

Return JSON: { is_cancellation: boolean, is_refund: boolean, reason: string | null, confidence: number }`,
      },
      {
        role: 'user',
        content: `Conversation context:\n${historyText || '(none)'}\n\nLatest customer message:\n${inboundMessage}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 200,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) {
    return { is_cancellation: false, is_refund: false, reason: null, confidence: 0 };
  }

  try {
    const parsed = JSON.parse(raw) as {
      is_cancellation?: boolean;
      is_refund?: boolean;
      reason?: string | null;
      confidence?: number;
    };
    const reasonRaw = typeof parsed.reason === 'string' ? parsed.reason.trim() : null;

    const is_cancellation = parsed.is_cancellation === true;
    const is_refund = parsed.is_refund === true;
    const intentAsserted = is_cancellation || is_refund;
    // P1-3: enforce the required-confidence contract (measurement + range check; the fail
    // direction stays owned by the resolve below) and record whether the legacy boost fired.
    const contract = enforceConfidenceContract(parsed, 'cancellation_refund');
    logMissingConfidenceContract('cancellation_refund', parsed.confidence, intentAsserted);
    const resolved = resolveEscalationConfidenceDetailed({
      raw: contract.rawConfidence,
      intentAsserted,
      legacyBoost: 0.9,
      applySymmetry: CONFIDENCE_CONTRACT_SYMMETRY,
    });

    return {
      is_cancellation,
      is_refund,
      reason: reasonRaw && reasonRaw.length > 0 ? reasonRaw : null,
      confidence: resolved.confidence,
      confidence_boost_applied: resolved.boostApplied,
    };
  } catch {
    return { is_cancellation: false, is_refund: false, reason: null, confidence: 0 };
  }
}

export async function detectWrongProductIntent(
  inboundMessage: string,
  conversationHistory: Message[],
): Promise<{
  is_wrong_product: boolean;
  reason: string | null;
  confidence: number;
  /** P1-3 (RC-07): the legacy missing-confidence boost fired for this verdict (ledger field). */
  confidence_boost_applied?: boolean;
}> {
  const historySlice = conversationHistory.slice(-8);
  const historyText = historySlice
    .map((msg) => {
      const who = msg.sent_by === 'customer' ? 'Customer' : 'Agent';
      return `${who}: ${(msg.content ?? '').trim()}`;
    })
    .join('\n');

  const completion = await openai.chat.completions.create({
    model: OPENAI_CLASSIFIER_MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a precise intent classifier. Determine if a customer is reporting that they received the wrong product for an order they already placed.

Only return is_wrong_product: true if:
- The customer clearly states they received the wrong item, a different product than ordered, or something they did not order.
- The context confirms this is about a completed purchase/delivery they received, not a future or hypothetical one.

Return is_wrong_product: false for:
- Questions about what products are available.
- Pre-purchase questions or general product inquiries.
- Complaints about product quality, damage, or defects (not wrong item).
- Delivery delays or non-delivery (package not arrived yet).
- Vague complaints without clear mention of receiving a wrong item.

Return JSON: { "is_wrong_product": boolean, "reason": string | null, "confidence": number }`,
      },
      {
        role: 'user',
        content: `Conversation context:\n${historyText || '(none)'}\n\nLatest customer message:\n${inboundMessage}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 200,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) {
    return { is_wrong_product: false, reason: null, confidence: 0 };
  }

  try {
    const parsed = JSON.parse(raw) as {
      is_wrong_product?: boolean;
      reason?: string | null;
      confidence?: number;
    };
    const reasonRaw = typeof parsed.reason === 'string' ? parsed.reason.trim() : null;
    const is_wrong_product = parsed.is_wrong_product === true;
    const contract = enforceConfidenceContract(parsed, 'wrong_product');
    logMissingConfidenceContract('wrong_product', parsed.confidence, is_wrong_product);
    const resolved = resolveEscalationConfidenceDetailed({
      raw: contract.rawConfidence,
      intentAsserted: is_wrong_product,
      legacyBoost: 0.9,
      applySymmetry: CONFIDENCE_CONTRACT_SYMMETRY,
    });
    return {
      is_wrong_product,
      reason: reasonRaw && reasonRaw.length > 0 ? reasonRaw : null,
      confidence: resolved.confidence,
      confidence_boost_applied: resolved.boostApplied,
    };
  } catch {
    return { is_wrong_product: false, reason: null, confidence: 0 };
  }
}

export async function detectPostPurchaseSupportIntent(
  inboundMessage: string,
  conversationHistory: Message[],
): Promise<{
  is_delivery_eta_query: boolean;
  is_not_delivered_complaint: boolean;
  is_wrong_product_issue: boolean;
  is_product_problem_issue: boolean;
  confidence: number;
  /** P1-3 (RC-07): the legacy missing-confidence boost fired for this verdict (ledger field). */
  confidence_boost_applied?: boolean;
  reason: string | null;
}> {
  const historySlice = conversationHistory.slice(-8);
  const historyText = historySlice
    .map((msg) => {
      const who = msg.sent_by === 'customer' ? 'Customer' : 'Agent';
      return `${who}: ${(msg.content ?? '').trim()}`;
    })
    .join('\n');

  const completion = await openai.chat.completions.create({
    model: OPENAI_CLASSIFIER_MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a strict support-intent classifier for post-purchase issues.
Detect only these intents about an order that has already been placed:
1) delivery ETA query (customer asks when the package/product will arrive),
2) not delivered complaint (customer says they still have not received it),
3) wrong product issue (customer says they received the wrong item),
4) product problem issue (damaged/defective/problematic product received).

Set booleans to true only when the latest message clearly refers to a completed purchase/order context.
Set all booleans false for:
- pre-purchase shipping policy questions,
- generic delivery information not tied to their own order,
- vague complaints without delivery/product issue context.

Return JSON exactly:
{
  "is_delivery_eta_query": boolean,
  "is_not_delivered_complaint": boolean,
  "is_wrong_product_issue": boolean,
  "is_product_problem_issue": boolean,
  "confidence": number,
  "reason": string | null
}`,
      },
      {
        role: 'user',
        content: `Conversation context:\n${historyText || '(none)'}\n\nLatest customer message:\n${inboundMessage}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 240,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) {
    return {
      is_delivery_eta_query: false,
      is_not_delivered_complaint: false,
      is_wrong_product_issue: false,
      is_product_problem_issue: false,
      confidence: 0,
      reason: null,
    };
  }

  try {
    const parsed = JSON.parse(raw) as {
      is_delivery_eta_query?: boolean;
      is_not_delivered_complaint?: boolean;
      is_wrong_product_issue?: boolean;
      is_product_problem_issue?: boolean;
      confidence?: number;
      reason?: string | null;
    };

    const is_delivery_eta_query = parsed.is_delivery_eta_query === true;
    const is_not_delivered_complaint = parsed.is_not_delivered_complaint === true;
    const is_wrong_product_issue = parsed.is_wrong_product_issue === true;
    const is_product_problem_issue = parsed.is_product_problem_issue === true;
    const anyIntent =
      is_delivery_eta_query ||
      is_not_delivered_complaint ||
      is_wrong_product_issue ||
      is_product_problem_issue;
    const contract = enforceConfidenceContract(parsed, 'post_purchase');
    logMissingConfidenceContract('post_purchase', parsed.confidence, anyIntent);
    const resolved = resolveEscalationConfidenceDetailed({
      raw: contract.rawConfidence,
      intentAsserted: anyIntent,
      legacyBoost: 0.9,
      applySymmetry: CONFIDENCE_CONTRACT_SYMMETRY,
    });
    const reasonRaw = typeof parsed.reason === 'string' ? parsed.reason.trim() : null;

    return {
      is_delivery_eta_query,
      is_not_delivered_complaint,
      is_wrong_product_issue,
      is_product_problem_issue,
      confidence: resolved.confidence,
      confidence_boost_applied: resolved.boostApplied,
      reason: reasonRaw && reasonRaw.length > 0 ? reasonRaw : null,
    };
  } catch {
    return {
      is_delivery_eta_query: false,
      is_not_delivered_complaint: false,
      is_wrong_product_issue: false,
      is_product_problem_issue: false,
      confidence: 0,
      reason: null,
    };
  }
}

export async function detectOrderAffirmationIntent(
  inboundMessage: string,
  conversationHistory: Message[],
): Promise<{ is_order_affirmation: boolean; confidence: number; reason: string | null }> {
  const historySlice = conversationHistory.slice(-8);
  const historyText = historySlice
    .map((msg) => {
      const who = msg.sent_by === 'customer' ? 'Customer' : 'Agent';
      return `${who}: ${(msg.content ?? '').trim()}`;
    })
    .join('\n');

  const completion = await openai.chat.completions.create({
    model: OPENAI_CLASSIFIER_MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a strict intent classifier for order-confirmation replies.
Detect whether the latest customer message is an affirmation to proceed with an order (including short confirmations) rather than a complaint.

Return is_order_affirmation: true for messages like:
- "po", "po ju lutem", "ok", "yes", "sure", "vazhdo", "beje porosine", "place it"
- especially when prior assistant message asks to proceed/order.

Return is_order_affirmation: false when the customer is reporting post-purchase issues (delivery delay, non-delivery, wrong item, damaged/defective product), asking for cancellation/refund, or asking unrelated questions.

Return JSON exactly:
{ "is_order_affirmation": boolean, "confidence": number, "reason": string | null }`,
      },
      {
        role: 'user',
        content: `Conversation context:\n${historyText || '(none)'}\n\nLatest customer message:\n${inboundMessage}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 180,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) return { is_order_affirmation: false, confidence: 0, reason: null };

  try {
    const parsed = JSON.parse(raw) as {
      is_order_affirmation?: boolean;
      confidence?: number;
      reason?: string | null;
    };
    // Order/affirmation path (DP-GPR-16): unified onto the shared contract normalizer — it
    // carries NO boost, so a missing/zero confidence leaves confidence low and the caller's
    // gate abstains (the deterministic order-stage slot check in processAIReply.ts is what
    // preserves revenue, symmetrically with the escalation paths).
    const contract = enforceConfidenceContract(parsed, 'order_affirmation');
    logMissingConfidenceContract(
      'order_affirmation',
      parsed.confidence,
      parsed.is_order_affirmation === true,
    );
    const confidence = normalizeClassifierConfidence(contract.rawConfidence);
    const reasonRaw = typeof parsed.reason === 'string' ? parsed.reason.trim() : null;
    return {
      is_order_affirmation: parsed.is_order_affirmation === true,
      confidence,
      reason: reasonRaw && reasonRaw.length > 0 ? reasonRaw : null,
    };
  } catch {
    return { is_order_affirmation: false, confidence: 0, reason: null };
  }
}

export interface OrderInfoUpdateFields {
  delivery_address: string | null;
  customer_phone: string | null;
  customer_name: string | null;
  notes: string | null;
}

/**
 * Detects whether the customer's latest message is providing updated information
 * for an order they have already placed (corrected address, phone, name, or notes).
 * Also extracts the new field values from the message and conversation context.
 *
 * Intended to run AFTER the cancel/refund, wrong-product, and post-purchase-support
 * detectors so those higher-priority escalations always win.
 */
export async function detectOrderInfoUpdateIntent(
  inboundMessage: string,
  conversationHistory: Message[],
): Promise<{
  is_order_info_update: boolean;
  fields: OrderInfoUpdateFields;
  confidence: number;
  /** P1-3 (RC-07): the legacy missing-confidence boost fired for this verdict (ledger field). */
  confidence_boost_applied?: boolean;
  reason: string | null;
}> {
  const defaultResult = {
    is_order_info_update: false,
    fields: { delivery_address: null, customer_phone: null, customer_name: null, notes: null },
    confidence: 0,
    reason: null,
  };

  const inbound = inboundMessage.trim();
  if (!inbound) return defaultResult;

  const historySlice = conversationHistory.slice(-10);
  const historyText = historySlice
    .map((msg) => {
      const who = msg.sent_by === 'customer' ? 'Customer' : 'Agent';
      return `${who}: ${(msg.content ?? '').trim()}`;
    })
    .join('\n');

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content: `You are a precise intent classifier and information extractor for an order management system.

Determine whether the customer's LATEST message is providing new/updated information for an order they have ALREADY placed (correcting a delivery address, phone number, name, or delivery notes).

This IS an order info update when ANY of the following apply:
- The agent previously asked the customer for a new address/phone/name/notes, and the customer is now providing that value.
- The customer explicitly says they want to change/update/correct their address, phone, name, or delivery notes AND provides the new value in the same message.
- The customer says "I made a mistake, my [field] is actually [value]".
- The customer says "my new address is ...", "change my phone to ...", "my name is actually ...", etc.

This is NOT an order info update when:
- The customer is providing info for the FIRST time as part of placing a new order (not a correction).
- The customer is only asking to change something WITHOUT providing the new value (e.g. "can I change my address?" — no new value given).
- The customer is asking for a cancellation or refund.
- The customer is asking a general question or making small talk.
- The message is ambiguous and could equally be a new-order data payload.

Extract the new field values ONLY from the latest customer message (use context to disambiguate, but extract values from the latest message):
- delivery_address: The COMPLETE new delivery address (street, number, city, any detail the customer provides).
- customer_phone: The new phone number (preserve digits, spaces, dashes as provided).
- customer_name: The new first name or full name.
- notes: New delivery instructions, special requests, or notes.

Return null for any field the customer is NOT updating in this message.

Return ONLY JSON:
{
  "is_order_info_update": boolean,
  "fields": {
    "delivery_address": string | null,
    "customer_phone": string | null,
    "customer_name": string | null,
    "notes": string | null
  },
  "confidence": number,
  "reason": string | null
}`,
        },
        {
          role: 'user',
          content: `Conversation context (most recent messages):\n${historyText || '(none)'}\n\nLatest customer message:\n${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 350,
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw?.trim()) return defaultResult;

    const parsed = JSON.parse(raw) as {
      is_order_info_update?: boolean;
      fields?: {
        delivery_address?: string | null;
        customer_phone?: string | null;
        customer_name?: string | null;
        notes?: string | null;
      };
      confidence?: number;
      reason?: string | null;
    };

    const is_order_info_update = parsed.is_order_info_update === true;
    const contract = enforceConfidenceContract(parsed, 'order_info_update');
    logMissingConfidenceContract('order_info_update', parsed.confidence, is_order_info_update);
    const resolved = resolveEscalationConfidenceDetailed({
      raw: contract.rawConfidence,
      intentAsserted: is_order_info_update,
      legacyBoost: 0.85,
      applySymmetry: CONFIDENCE_CONTRACT_SYMMETRY,
    });

    const reasonRaw = typeof parsed.reason === 'string' ? parsed.reason.trim() : null;
    const fields: OrderInfoUpdateFields = {
      delivery_address:
        typeof parsed.fields?.delivery_address === 'string'
          ? parsed.fields.delivery_address.trim() || null
          : null,
      customer_phone:
        typeof parsed.fields?.customer_phone === 'string'
          ? parsed.fields.customer_phone.trim() || null
          : null,
      customer_name:
        typeof parsed.fields?.customer_name === 'string'
          ? parsed.fields.customer_name.trim() || null
          : null,
      notes:
        typeof parsed.fields?.notes === 'string'
          ? parsed.fields.notes.trim() || null
          : null,
    };

    return {
      is_order_info_update,
      fields,
      confidence: resolved.confidence,
      confidence_boost_applied: resolved.boostApplied,
      reason: reasonRaw && reasonRaw.length > 0 ? reasonRaw : null,
    };
  } catch (err) {
    console.warn('[order_info_update_classifier] failed, returning default', {
      error: err instanceof Error ? err.message : String(err),
      message_preview: logSafe(inbound),
    });
    return defaultResult;
  }
}

type ChatMessageContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: ChatMessageContent };

function normalizeAttachmentUrls(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((u): u is string => typeof u === 'string' && u.length > 0);
  }
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return normalizeAttachmentUrls(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

function resolveImageUrls(attachmentUrls: string[]): string[] {
  const resolved: string[] = [];
  for (const url of attachmentUrls) {
    const filePath = permanentUrlToFilePath(url);
    if (filePath) {
      const dataUrl = fileToBase64DataUrl(filePath);
      if (dataUrl) {
        resolved.push(dataUrl);
        continue;
      }
    }
    resolved.push(url);
  }
  return resolved;
}

/** URLs the chat vision API can consume as `image_url` (not MP4/HTML, etc.). */
function urlLooksLikeVisionImage(url: string): boolean {
  const u = url.toLowerCase();
  if (u.endsWith('.mp4') || u.includes('.mp4?')) return false;
  if (u.endsWith('.webm') || u.includes('.webm?')) return false;
  if (u.endsWith('.mov') || u.includes('.mov?')) return false;
  if (u.includes('/video/upload/')) return false;
  if (u.includes('mime_video') || u.includes('resource_type=video')) return false;
  return true;
}

function partitionVisionAttachments(attachmentUrls: string[]): {
  visionUrls: string[];
  hadSkippedVideo: boolean;
} {
  const visionUrls = attachmentUrls.filter(urlLooksLikeVisionImage);
  const hadSkippedVideo = visionUrls.length < attachmentUrls.length;
  return { visionUrls, hadSkippedVideo };
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getProductBrand(product: Product): string | null {
  const maybeBrand = (product as Product & { brand?: string | null }).brand;
  return typeof maybeBrand === 'string' && maybeBrand.trim().length > 0 ? maybeBrand.trim() : null;
}

/**
 * True when this customer message has been edited AFTER an outbound message landed in the same
 * conversation history slice. In that case the AI/agent already replied to the original text,
 * so we expose the diff to the model so it can correct itself; for never-replied edits we just
 * use the new content directly because the original is irrelevant context.
 */
function customerMessageEditedAfterOutbound(msg: Message, history: Message[]): boolean {
  if (msg.sent_by !== 'customer') return false;
  if (msg.edit_count <= 0 || !msg.edited_at) return false;
  const editedAtMs = msg.edited_at.getTime();
  for (const other of history) {
    if (other.id === msg.id) continue;
    if (other.direction !== 'outbound') continue;
    const created = other.created_at instanceof Date ? other.created_at : new Date(other.created_at);
    const createdMs = created.getTime();
    if (!Number.isFinite(createdMs)) continue;
    // Outbound created strictly after the customer message AND before the most recent edit
    // → the customer edited the original after we replied.
    if (createdMs > new Date(msg.created_at).getTime() && createdMs < editedAtMs) {
      return true;
    }
  }
  return false;
}

function truncateForEditHint(text: string, max = 280): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

function formatCustomerMessageContentForPrompt(
  msg: Message,
  context?: { editedAfterOutbound?: boolean },
): string {
  const body = (msg.content ?? '').trim();
  const snap = msg.reply_to_content?.trim();
  let core = body;
  if (msg.sent_by === 'customer' && snap) {
    core = `Customer replied to: '${snap}' — saying: '${body}'`;
  }
  // Only surface the original text to the model when the AI/agent has already replied to it;
  // otherwise the pre-edit version is noise and could confuse the model into using stale context.
  if (
    context?.editedAfterOutbound &&
    msg.original_content != null &&
    msg.original_content.trim() !== body
  ) {
    const original = truncateForEditHint(msg.original_content);
    const updated = truncateForEditHint(body || '(empty)');
    return [
      '[The customer edited their earlier message after you replied to it.',
      `Original: "${original}"`,
      `Now reads: "${updated}"`,
      'Treat the new text as the canonical request and gracefully correct any prior reply that no longer matches.]',
      core,
    ].join('\n');
  }
  return core;
}

function summarizeOlderConversationContext(messages: Message[]): string | null {
  if (messages.length === 0) return null;

  const total = messages.length;
  const customerMessages = messages.filter((msg) => msg.sent_by === 'customer');
  const agentMessages = messages.filter((msg) => msg.sent_by !== 'customer');
  const first = messages[0];
  const last = messages[messages.length - 1];

  const firstText = (first.content ?? '').trim();
  const lastText = (last.content ?? '').trim();
  const firstPreview = firstText ? firstText.replace(/\s+/g, ' ').slice(0, 140) : null;
  const lastPreview = lastText ? lastText.replace(/\s+/g, ' ').slice(0, 140) : null;

  const customerHighlights = customerMessages
    .map((msg) =>
      formatCustomerMessageContentForPrompt(msg, {
        editedAfterOutbound: customerMessageEditedAfterOutbound(msg, messages),
      })
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((txt) => txt.length > 0)
    .slice(-2)
    .map((txt) => `"${txt.slice(0, 120)}${txt.length > 120 ? '...' : ''}"`);

  const parts: string[] = [
    `Earlier context summary (${total} older messages): customer sent ${customerMessages.length} message(s), assistant/agent sent ${agentMessages.length}.`,
  ];

  if (firstPreview) {
    parts.push(`The earlier thread starts with: "${firstPreview}${firstText.length > 140 ? '...' : ''}".`);
  }
  if (lastPreview) {
    parts.push(`Before the recent 10-message window, it most recently included: "${lastPreview}${lastText.length > 140 ? '...' : ''}".`);
  }
  if (customerHighlights.length > 0) {
    parts.push(`Notable recent customer points from that older segment: ${customerHighlights.join(' | ')}.`);
  }

  return parts.join(' ');
}

/**
 * P2-3 (RC-13): the slot-backed replacement for `summarizeOlderConversationContext`. Pulls the
 * persisted slots (name/phone/address/order_stage) + the last-recommendation anchor — which survive
 * beyond the 40-row window — from the conversation row, resolves the anchor to still-active/in-stock
 * products (so a since-deleted product is never re-offered and an in-stock prior recommendation is
 * never denied), and hands them with the older segment to the pure projector. Best-effort reads: a
 * DB blip degrades to the extractive tail rather than throwing.
 */
async function buildSlotBackedOlderSummary(
  tenantId: string,
  conversationId: string,
  olderHistory: Message[],
): Promise<string | null> {
  const conversation = await findConversationById(conversationId).catch(() => null);
  const recIds = Array.isArray(conversation?.slot_last_recommended_product_ids)
    ? (conversation!.slot_last_recommended_product_ids as string[])
    : [];
  let recommendedProducts: SummaryProduct[] = [];
  if (recIds.length > 0) {
    const products = await findActiveProductsByIds(tenantId, recIds).catch(() => [] as Product[]);
    recommendedProducts = products.map((p) => ({
      name: p.name,
      price: p.price != null ? Number(p.price) : null,
      discountedPrice: p.discounted_price != null ? Number(p.discounted_price) : null,
    }));
  }
  const olderMessages: SummaryMessage[] = olderHistory.map((msg) => ({
    isCustomer: msg.sent_by === 'customer',
    text:
      msg.sent_by === 'customer'
        ? formatCustomerMessageContentForPrompt(msg, {
            editedAfterOutbound: customerMessageEditedAfterOutbound(msg, olderHistory),
          })
        : (msg.content ?? '').trim(),
  }));
  return buildConversationSummary({
    slots: {
      name: conversation?.slot_customer_name ?? null,
      phone: conversation?.slot_customer_phone ?? null,
      address: conversation?.slot_delivery_address ?? null,
      orderStage: conversation?.order_stage ?? null,
    },
    recommendedProducts,
    olderMessages,
    maxTailChars: SUMMARY_SLOT_BACKED_MAX_TAIL_CHARS,
  });
}

function buildMessagesArray(
  systemPrompt: string,
  conversationHistory: Message[],
  inboundMessage: string,
  attachmentUrls: string[] = [],
  visionContext: string | null = null,
  olderHistorySummary: string | null = null,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  if (olderHistorySummary) {
    // Inject as a clearly-labeled SYSTEM context note rather than an assistant turn. As an
    // assistant message the model treats the recap as its own prior statements and tends to
    // "double down" on it; as labeled background context it is used for grounding only and is
    // not mistaken for something the assistant actually said to the customer.
    messages.push({
      role: 'system',
      content: `[Background context — summary of earlier messages, not a prior reply]\n${olderHistorySummary}`,
    });
  }

  for (const msg of conversationHistory) {
    const histUrls = normalizeAttachmentUrls(msg.attachment_urls);
    // P2-3 (RC-16): under the flag, a delivered-but-non-authoritative non-customer row (a flagged
    // low-quality reply or canned holding/escalation copy) maps to `system` instead of `assistant`
    // so the model does not treat it as its own authoritative prior statement. Flag-off keeps the
    // binary customer→user / else→assistant mapping byte-for-byte.
    const role: 'user' | 'assistant' | 'system' = HISTORY_DELIVERY_FILTERED
      ? historyRoleFor(msg, isCannedHoldingCopy)
      : msg.sent_by === 'customer'
        ? 'user'
        : 'assistant';
    const rawText =
      role === 'user'
        ? formatCustomerMessageContentForPrompt(msg, {
            editedAfterOutbound: customerMessageEditedAfterOutbound(msg, conversationHistory),
          })
        : (msg.content ?? '').trim();
    if (!rawText && histUrls.length === 0) continue;

    const textContent =
      role === 'system'
        ? `[Prior lower-quality/holding assistant reply — context only, not authoritative]\n${rawText}`
        : rawText;
    messages.push({ role, content: textContent });
  }

  const lastMsg = messages[messages.length - 1];
  const lastUserText =
    typeof lastMsg?.content === 'string' ? lastMsg.content.trim() : '';
  const inboundTrimmed = inboundMessage.trim();
  const lastCustomerInHistory = [...conversationHistory]
    .reverse()
    .find((m) => m.sent_by === 'customer');
  const expectedLastUserFromHistory =
    lastCustomerInHistory &&
    (lastCustomerInHistory.content ?? '').trim() === inboundTrimmed
      ? formatCustomerMessageContentForPrompt(lastCustomerInHistory, {
          editedAfterOutbound: customerMessageEditedAfterOutbound(
            lastCustomerInHistory,
            conversationHistory,
          ),
        }).trim()
      : inboundTrimmed;
  const alreadyAppended =
    lastMsg?.role === 'user' &&
    (lastUserText === inboundTrimmed ||
      lastUserText === expectedLastUserFromHistory ||
      (inboundTrimmed === '' && lastUserText === ''));

  if (attachmentUrls.length > 0) {
    const { visionUrls, hadSkippedVideo } = partitionVisionAttachments(attachmentUrls);
    const imageUrls = resolveImageUrls(visionUrls);
    let textForParts = inboundTrimmed || (imageUrls.length > 0 ? 'The customer sent an image.' : '');
    if (visionContext) {
      textForParts =
        `Vision two-step context:\n${visionContext}\n\nStep requirement for image handling: extract the brand name first, then attempt catalog matching.\n\nCustomer message:\n${textForParts || '(no text)'}`;
    }
    if (hadSkippedVideo) {
      const videoNote =
        imageUrls.length === 0
          ? '\n\n(Attached: a short video, e.g. an Instagram story clip. You cannot view video in this interface. Use any written context from the customer; if they ask about what is in the story, politely ask them to describe it or name the product.)'
          : '\n\n(There is additionally a short video attachment you cannot view here.)';
      textForParts = (textForParts || 'The customer sent a message.') + videoNote;
    }
    const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      { type: 'text', text: textForParts },
      ...imageUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
    ];

    if (alreadyAppended) {
      messages[messages.length - 1] = { role: 'user', content: parts };
    } else {
      messages.push({ role: 'user', content: parts });
    }
  } else if (!alreadyAppended) {
    messages.push({ role: 'user', content: inboundTrimmed });
  }

  return messages;
}

const CONVERSATION_ENDING_ANALYST_SYSTEM =
  "You are a conversation analyst. Your only job is to determine if a message signals that a conversation is ending. This includes any form of goodbye, thank you and goodbye combined, polite dismissal, or closing pleasantry in ANY language including formal and informal versions, slang, abbreviations, and regional variations. For example in Albanian 'klm' means 'kalofshi mirë' which is have a nice day. 'fln' means 'faleminderit' which is thank you. Consider all such abbreviations and slang as ending signals. Return only a JSON object with a single boolean field: { is_ending: true } or { is_ending: false }";

const CLOSING_REPLY_SYSTEM_APPEND_TEMPLATE_BY_LOCALE: Record<ReplyLocale, string> = {
  sq: `
Final-closing behavior:
- If the latest customer message is a closing/thank-you/goodbye signal, reply with exactly one short polite closing sentence.
- Keep it brief (around 2-7 words), warm, and natural in Albanian.
- Reply ONLY in Albanian. Use this exact sentence: "__CLOSING_SENTENCE__".
- Do not ask any follow-up question.
- Do not continue the sales flow or introduce new topics.
`.trim(),
  en: `
Final-closing behavior:
- If the latest customer message is a closing/thank-you/goodbye signal, reply with exactly one short polite closing sentence.
- Keep it brief (around 2-7 words), warm, and natural in English.
- Reply ONLY in English. Use this exact sentence: "__CLOSING_SENTENCE__".
- Do not ask any follow-up question.
- Do not continue the sales flow or introduce new topics.
`.trim(),
};

/**
 * Photo-capability contract, appended to every retail system prompt. The deterministic photo
 * flow (image classifier + canned override in processAIReply) owns actual dispatch; this only
 * stops the model from DENYING the capability on turns where that flow does not fire.
 */
const PHOTO_CAPABILITY_APPEND_BY_LOCALE: Record<ReplyLocale, string> = {
  sq: `
Fotot e produkteve:
- Kur klienti kërkon foto të një produkti, sistemi e dërgon foton automatikisht bashkë me përgjigjen tënde.
- MOS thuaj kurrë që nuk mund të dërgosh foto dhe mos u justifiko për fotot.
- Mos e përshkruaj foton dhe mos premto vetë dërgimin e saj — përgjigju shkurt e natyrshëm vetëm për produktet që kërkoi klienti.
`.trim(),
  en: `
Product photos:
- When the customer asks for a product photo, the system sends the photo automatically along with your reply.
- NEVER say you cannot send photos, and never apologize about photos.
- Do not describe the photo or promise to send it yourself — reply briefly and naturally, covering only the products the customer asked about.
`.trim(),
};

/** Closing-reply sentences (per locale + per flavor) used when the customer is wrapping up. */
export const CLOSING_REPLY_SENTENCES: Record<ReplyLocale, { no_thanks: string; greeting: string }> = {
  sq: {
    no_thanks: 'Pa problem, kaloni bukur.',
    greeting: 'Edhe ju gjithashtu, kalofshi bukur.',
  },
  en: {
    no_thanks: 'No problem, take care.',
    greeting: 'You too, have a great day.',
  },
};

export function getClosingReplySentences(locale: ReplyLocale): {
  no_thanks: string;
  greeting: string;
} {
  return CLOSING_REPLY_SENTENCES[locale];
}

function normalizeClosingSignalText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function looksLikePoliteThanksClosing(messageContent: string): boolean {
  const normalized = normalizeClosingSignalText(messageContent);
  if (!normalized) return false;

  const explicitClosingPatterns = [
    /\b(jo|ska nevoje|ska nevoj|nuk ka nevoje|nuk ka nevoj)\s+(faleminderit|flm|fln)\b/,
    /\b(faleminderit|faleminderit shume|flm|flm shume|fln|rrofsh|ju faleminderit)\b/,
    /\b(no thanks|no thank you|thanks|thanks a lot|thank you|thank you very much|thx|ty)\b/,
  ];
  if (explicitClosingPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const shortMessageWordCount = normalized.split(' ').filter(Boolean).length;
  const hasThanksToken =
    /\b(faleminderit|flm|fln|rrofsh|thanks|thank you|thx|ty)\b/.test(normalized);
  const hasClosingToken =
    /\b(bye|goodbye|good night|good day|klm|kalofsh|kalofshi|kaloni bukur|nat e mire|naten e mire|diten e mire)\b/.test(
      normalized,
    );
  if (shortMessageWordCount <= 6 && hasThanksToken) {
    return true;
  }
  return shortMessageWordCount <= 8 && hasClosingToken;
}

type ClosingFlavor = 'no_thanks' | 'greeting';

function classifyClosingFlavor(messageContent: string): ClosingFlavor {
  const normalized = normalizeClosingSignalText(messageContent);
  if (!normalized) return 'greeting';

  const noThanksPatterns = [
    /\b(jo|sjo)\b/,
    /\b(ska nevoje|ska nevoj|s ka nevoje|s ka nevoj)\b/,
    /\b(nuk ka nevoje|nuk ka nevoj)\b/,
    /\b(no thanks|no thank you)\b/,
  ];

  if (noThanksPatterns.some((pattern) => pattern.test(normalized))) {
    return 'no_thanks';
  }

  return 'greeting';
}

function getPreviousAssistantMessageBeforeLatestCustomer(
  conversationHistory: Message[],
): Message | undefined {
  if (conversationHistory.length === 0) return undefined;
  const latestIndex = conversationHistory.length - 1;
  const latest = conversationHistory[latestIndex];
  if (latest.sent_by !== 'customer') return undefined;

  for (let i = latestIndex - 1; i >= 0; i -= 1) {
    if (conversationHistory[i].sent_by !== 'customer') {
      return conversationHistory[i];
    }
  }
  return undefined;
}

function assistantMessageAskedForOrder(messageContent: string): boolean {
  const normalized = normalizeForIntentMatch(messageContent);
  if (!normalized) return false;

  const explicitOrderQuestionPatterns = [
    /\b(a doni ta porosisni|deshironi ta porosisni|deshiron ta porositesh)\b/,
    /\b(doni ta porosisni|doni me porosit|doni me bo porosi)\b/,
    /\b(would you like to order|do you want to order)\b/,
  ];
  if (explicitOrderQuestionPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const hasOrderKeyword = /\b(porosi|porosis|porosit|order)\b/.test(normalized);
  return hasOrderKeyword && messageContent.includes('?');
}

function hasAssistantAskedForOrderInConversation(conversationHistory: Message[]): boolean {
  return conversationHistory.some(
    (msg) =>
      msg.sent_by !== 'customer' &&
      assistantMessageAskedForOrder((msg.content ?? '').trim()),
  );
}

async function isConversationEnding(
  messageContent: string,
  conversationHistory: Message[],
): Promise<boolean> {
  if (looksLikePoliteThanksClosing(messageContent)) {
    return true;
  }

  const lastThree = conversationHistory.slice(-3);
  const formattedLastFew = lastThree
    .map((msg) => {
      const roleLabel = msg.sent_by === 'customer' ? 'Customer' : 'AI';
      return `${roleLabel}: ${(msg.content ?? '').trim()}`;
    })
    .join('\n');

  const userText = `Last few messages of conversation:\n${formattedLastFew || '(none)'}\n\nLatest customer message: ${messageContent}`;

  const completion = await openai.chat.completions.create({
    model: OPENAI_CLASSIFIER_MODEL,
    messages: [
      { role: 'system', content: CONVERSATION_ENDING_ANALYST_SYSTEM },
      { role: 'user', content: userText },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 64,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) return false;

  try {
    const parsed = JSON.parse(raw) as { is_ending?: boolean };
    return parsed.is_ending === true;
  } catch {
    return false;
  }
}

export interface ProductNameHallucinationResult {
  hasHallucination: boolean;
  /** Specific product names in the reply that could not be matched to any catalog entry. */
  suspectedNames: string[];
}

/**
 * Post-generation product-name hallucination guard. Checks whether the AI reply names
 * any specific products that are NOT present in the provided catalog name list.
 *
 * Architecture mirrors filterHallucinatedPrices but uses an LLM classifier because
 * product names cannot be reliably extracted with regex across languages, abbreviations,
 * and brand variants. The LLM performs fuzzy matching so "MyBrand Protein" is not
 * flagged when "MyBrand Protein Powder 1kg" is in the catalog.
 *
 * The caller chooses the reference list: the per-turn matched products (legacy) or a
 * sample of the full active catalog. With the full-catalog guard flag on, this
 * classifier's output is treated as SUSPECTS only — each name is deterministically
 * re-verified against the entire catalog before it may escalate (processAIReply).
 *
 * Fail-open: returns { hasHallucination: false } on any error so the reply is never
 * blocked due to a guard failure. Only fires when catalogNames is non-empty.
 */
export async function filterHallucinatedProductNames(
  replyText: string,
  referenceCatalogNames: string[],
): Promise<ProductNameHallucinationResult> {
  const empty: ProductNameHallucinationResult = { hasHallucination: false, suspectedNames: [] };

  if (!replyText.trim()) return empty;

  const catalogNames = referenceCatalogNames
    .map((n) => n?.trim())
    .filter((n): n is string => Boolean(n));

  if (catalogNames.length === 0) return empty;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict catalog-grounding validator for an e-commerce assistant reply.\n\n' +
            'Task: identify specific product names mentioned in the reply that do NOT appear in the provided catalog list.\n\n' +
            'Rules:\n' +
            '- Only flag SPECIFIC product names (proper nouns, brand+product combos like "SuperWhey Pro X").\n' +
            '- Do NOT flag generic category terms used descriptively (e.g. "protein powder", "creatine", "whey", "supplement").\n' +
            '- Use fuzzy matching: treat a reply name as matching if it is a partial form, abbreviation, or diacritic variant of a catalog name ' +
            '(e.g. "MyBrand Protein" matches "MyBrand Protein Powder 1kg"; "Carbo One" matches "Carbo One 1kg me shije limon").\n' +
            '- Be conservative — only flag when you are confident the name does not match any listed catalog product.\n' +
            '- If the reply does not name any specific products, or all named products match the catalog, return an empty list.\n\n' +
            'Return only JSON: {"hallucinated_names": ["name1", "name2"]} or {"hallucinated_names": []}',
        },
        {
          role: 'user',
          content:
            `Known catalog products (the ONLY products the assistant may name):\n` +
            `${catalogNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\n` +
            `Assistant reply to validate:\n${replyText.slice(0, 1200)}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 128,
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw?.trim()) return empty;

    const parsed = JSON.parse(raw) as { hallucinated_names?: unknown };
    const names = Array.isArray(parsed.hallucinated_names)
      ? (parsed.hallucinated_names as unknown[])
          .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
          .map((n) => n.trim())
      : [];

    return { hasHallucination: names.length > 0, suspectedNames: names };
  } catch (err) {
    // Fail-open: never block a reply solely due to guard failure.
    console.warn('[product_name_guard] Guard classifier failed — failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}

export async function generateReply(
  conversationId: string,
  tenantId: string,
  inboundMessage: string,
  attachmentUrlsRaw: unknown = [],
  productCatalogContext?: string,
  precomputedLanguage?: ReplyLocale,
  // The originating per-webhook trace id, kept only for the legacy `[ai.generation]` log field.
  // @deprecated P2-4 Part 1 — correlation is now carried ambiently via `runWithLogContext` (ALS),
  // so `logger` picks up traceId + the per-message correlationId without this param. Retained to
  // avoid a call-site churn in this pass; remove in a follow-up once the log field is migrated.
  traceId?: string,
): Promise<{
  reply: string;
  productCatalogContext: string;
  language: ReplyLocale;
  matchedProducts: Product[];
  attributeIntent: ProductAttributeIntentResult;
  /** True when the inbound message included one or more image attachments. */
  hadImages: boolean;
  /** True when the vision pipeline identified the photo product as not in the catalog. */
  productNotInCatalog: boolean;
  /** True when the customer's message was classified as asking about price or cost. */
  customerAskedPrice: boolean;
  /**
   * Products the customer explicitly named in this message, resolved deterministically
   * from the full catalog (inbound-name pinning). Used by the false-denial backstop:
   * a reply that denies availability of one of these must never ship. Undefined on the
   * canned early-return paths.
   */
  inboundNamedProducts?: Product[];
  /** P1-5: per-reply decision-ledger telemetry. Present on the main LLM path; undefined on the
   * canned early-return paths (discount-finalized / OOS / repeat-closing — no model call). */
  telemetry?: ReplyTelemetry;
  /** P2-1 (RC-03): the reply's declared facts_used. Present only when the facts_used contract is
   * active (non-vision text path, non-custom model); undefined otherwise. */
  factsUsed?: DeclaredFact[];
}> {
  // P1-5: retrieval-telemetry sink, populated by the fresh matchProducts calls below. Stays
  // undefined when the reply reuses persisted/contextual products (no fresh retrieval this turn).
  const retrievalSink: RetrievalTelemetrySink = {};
  const attachmentUrls = normalizeAttachmentUrls(attachmentUrlsRaw);
  const { visionUrls } = partitionVisionAttachments(attachmentUrls);
  const hasImages = visionUrls.length > 0;
  const [tenant, config, conversationHistoryWindow, cachedCatalogProducts, totalCatalogCount] = await Promise.all([
    loadTenant(tenantId),
    loadAIConfig(tenantId),
    findMessagesByConversation(conversationId, HISTORY_FETCH_LIMIT),
    productCatalogContext ? Promise.resolve([] as Product[]) : loadProductCatalog(tenantId),
    countActiveProducts(tenantId),
  ]);
  // P2-3 (RC-16): delivery-filter the fetched window (drop never-delivered send-failed non-customer
  // rows) BEFORE the older/recent split, so both the summary and the transcript role loop operate on
  // kept rows only. Flag-off uses the raw window byte-for-byte. Language detection below still reads
  // the raw `conversationHistoryWindow` (a failed send should not influence anything, but we keep the
  // filter scoped to prompt assembly to stay surgical).
  const historyWindowForPrompt = HISTORY_DELIVERY_FILTERED
    ? conversationHistoryWindow.filter(keepMessageInHistory)
    : conversationHistoryWindow;
  const olderHistory =
    historyWindowForPrompt.length > RECENT_RAW_HISTORY_MESSAGES
      ? historyWindowForPrompt.slice(0, -RECENT_RAW_HISTORY_MESSAGES)
      : [];
  // P2-3 (RC-13): the slot-backed summary carries persisted facts + the last recommendation past the
  // window (only when an older segment exists — a short conversation keeps every fact in the recent
  // raw window). Flag-off runs the legacy customer-message-only summarizer byte-for-byte.
  const olderHistorySummary = SUMMARY_SLOT_BACKED
    ? olderHistory.length > 0
      ? await buildSlotBackedOlderSummary(tenantId, conversationId, olderHistory)
      : null
    : summarizeOlderConversationContext(olderHistory);
  const conversationHistory =
    historyWindowForPrompt.length > RECENT_RAW_HISTORY_MESSAGES
      ? historyWindowForPrompt.slice(-RECENT_RAW_HISTORY_MESSAGES)
      : historyWindowForPrompt;
  const [customerAskedPrice, customerAskedDiscount, detectedLanguage, attributeIntent, otherOptionsIntent] =
    await Promise.all([
      customerAskedAboutPrice(inboundMessage),
      customerAskedAboutDiscount(inboundMessage),
      precomputedLanguage
        ? Promise.resolve(precomputedLanguage)
        : detectReplyLanguage(inboundMessage, conversationHistoryWindow),
      classifyProductAttributeIntent(inboundMessage),
      // Detects "are there any other options?" style requests so we use the wider
      // category search limit and skip the persisted-product resolver (which would
      // return the same products the customer has already seen).
      classifyOtherProductOptionsIntent(inboundMessage),
    ]);
  const language: ReplyLocale = detectedLanguage;
  // "Do you have other brands/weights?" is already handled deterministically by
  // isCategoryAttributeFollowUp — don't let the other-options classifier override it.
  // Also exclude when classifyProductAttributeIntent (already LLM-based) already determined
  // this is an attribute question: attribute questions need the persisted product context for
  // aggregation, not a fresh search. This means novel phrasings like "can you show me
  // different brands?" land in the contextual-resolver path, not the fresh-search path.
  const isOtherOptionsRequest =
    otherOptionsIntent.is_other_options_request &&
    !isCategoryAttributeFollowUp(inboundMessage) &&
    !attributeIntent.is_attribute_question;

  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  // Silence repeated discount requests: once the AI has already told the customer that no
  // additional discount is available / that the displayed price is final, any further
  // discount-related message from the same customer is ignored (no AI reply at all).
  // Scan the full fetched window (not just the recent 10) so finalization is not forgotten
  // in longer conversations.
  if (
    customerAskedDiscount &&
    assistantAlreadyFinalizedDiscount(conversationHistoryWindow)
  ) {
    console.info(
      `[DISCOUNT_FINALIZED_SILENT] tenantId: ${tenantId} conversationId: ${conversationId} reason: customer keeps asking for a discount after the final price was already communicated`,
    );
    return {
      reply: '[NO_REPLY]',
      productCatalogContext:
        typeof productCatalogContext === 'string' && productCatalogContext.trim().length > 0
          ? productCatalogContext
          : '',
      language,
      matchedProducts: [],
      attributeIntent,
      hadImages: false,
      productNotInCatalog: false,
      customerAskedPrice,
    };
  }

  let products: Product[] = [];
  let usedFullCatalogFallback = false;
  // Products the customer explicitly named in THIS message, resolved deterministically
  // from the full catalog (inboundNamePinning). Pinned into the contextual pool and
  // returned so the false-denial guard can verify any availability denial against them.
  let inboundNamedProducts: Product[] = [];

  const searchText = inboundMessage.trim();
  const attributeIntentHint: AttributeQueryIntentHint = attributeIntent;
  // A price-comparison or recommendation follow-up ("which is the cheapest?",
  // "cila osht ma e lira?", "which do you recommend?") names no product — it refers to
  // the set the assistant just discussed.
  const isComparisonOrRecommendation = isProductRecommendationOrComparisonQuestion(searchText);
  const contextualMatchLimit =
    needsConversationProductContext(searchText) ||
    isCategoryAttributeFollowUp(searchText) ||
    attributeIntent.is_attribute_question ||
    // A comparison ("which is cheapest?") must consider the WHOLE discussed group, not a
    // focused subset, or the chosen "cheapest/most expensive" would be wrong.
    isComparisonOrRecommendation ||
    // "Are there any other protein options?" → use the full category retrieval limit so
    // we surface as many real catalog products as possible before the LLM replies.
    isOtherOptionsRequest
      ? CATEGORY_GROUP_MATCH_LIMIT
      : FOCUSED_PRODUCT_MATCH_LIMIT;

  // Context-only follow-ups (price, usage, attributes, "tell me more") must use the
  // product group the assistant just discussed — not re-search the short follow-up alone.
  // resolveContextualProductSet prefers the deterministic persisted product IDs from the
  // most recent recommendation, then falls back to anchor-based and assistant-text lookups.
  //
  // attributeIntent.is_attribute_question covers novel phrasings that the regex in
  // needsConversationProductContext() misses — e.g. "can you show me different brands?",
  // "what manufacturers do you carry?", "a keni ndonje marka tjeter?" — all correctly
  // detected by classifyProductAttributeIntent (which runs on every message via Promise.all)
  // but not by fixed keyword patterns. Routing those through resolveContextualProductSet
  // ensures they aggregate against the product group already in context, not a raw search.
  //
  // Exception: "other options" requests intentionally skip this resolver. The customer is
  // asking for DIFFERENT products — returning the same persisted set from the prior turn
  // would give them exactly what they're asking to go beyond.
  // A price-comparison or recommendation follow-up ("which is the cheapest?",
  // "cila osht ma e lira?", "which do you recommend?") names no product — it refers to
  // the set the assistant just discussed. Routing it through the contextual resolver
  // (persisted IDs first) avoids a fresh keyword search that matches unrelated products
  // on stop-words (e.g. "cila"/"ma"/"lira") and then wrongly reports the discussed
  // products as unavailable. resolveContextualProductSet falls back gracefully to a fresh
  // search when there is no prior context (a genuinely new comparison question).
  const needsContextualResolver =
    !isOtherOptionsRequest &&
    (needsConversationProductContext(searchText) ||
      attributeIntent.is_attribute_question ||
      isComparisonOrRecommendation ||
      // Usage/dosage questions route through the discussed products: their wording carries
      // no product identity ("Sa her ndite muna me perdor?"), so a fresh fusion search
      // returns stopword matches and the usage guards then escalate an answerable question
      // (the product's own usage_description never enters the evidence). A usage question
      // that DOES name a product is unaffected — inbound-name pins are prepended to the
      // contextual set and always win.
      matchesUsageQuestionKeyword(searchText) ||
      // Description/ingredient follow-ups ("Qfar permban?", "Per qfare sherben?") are the
      // same failure class: no product identity in the wording, so without this signal
      // they fresh-search stopwords and the description gap-check judges the wrong
      // products. Deterministic and recommendation-safe; named products win via pins.
      isProductDescriptionQuestion(searchText));

  if (isOtherOptionsRequest) {
    // Use the category_hint from the classifier when available (most specific), otherwise
    // fall back to the prior substantive product query from conversation history (the anchor).
    // Using the anchor instead of the raw "other options" message text ("do you have other
    // protein?") produces far more relevant results because the anchor contains the actual
    // product/category name that the catalog was indexed on.
    //
    // Pass skipMostRecentCustomerMessage=true so the anchor function unconditionally
    // skips the inbound "other options" message — the LLM already confirmed the intent,
    // so we don't need regex to re-detect it. This covers novel phrasings, slang, and
    // dialect forms (e.g. "trego me tjeter", "show me the rest", "got anything else?")
    // that a regex fallback would miss.
    const anchor = extractConversationProductAnchor(conversationHistoryWindow, {
      skipMostRecentCustomerMessage: true,
    });

    // Secondary fallback: when the anchor is null (no substantive prior customer query —
    // e.g. the AI proactively introduced products and the customer only asked follow-ups),
    // derive the search category from the products already recommended in this conversation.
    // This ensures "a keni tjera?" still finds more products in the SAME category rather
    // than returning empty results or searching with the follow-up text itself.
    let freshSearchQuery = otherOptionsIntent.category_hint ?? anchor ?? null;
    if (!freshSearchQuery) {
      try {
        const persistedFromHistory = await resolveProductsFromPersistedContext(
          tenantId,
          conversationHistoryWindow,
          contextualMatchLimit,
        );
        if (persistedFromHistory.length > 0) {
          const derivedTerms = [
            ...new Set([
              ...persistedFromHistory.map((p) => p.category).filter(Boolean),
              ...persistedFromHistory.flatMap((p) => p.tags),
            ]),
          ]
            .slice(0, 6)
            .join(' ');
          if (derivedTerms.trim()) freshSearchQuery = derivedTerms.trim();
        }
      } catch (err) {
        console.warn('[aiService] Other-options persisted-product category fallback failed', err);
      }
    }

    console.info('[aiService] Other-options request detected — fresh category search', {
      conversationId,
      tenantId,
      categoryHint: otherOptionsIntent.category_hint,
      anchor: anchor ? logSafe(anchor) : null,
      freshSearchQuery: freshSearchQuery ? logSafe(freshSearchQuery) : null,
    });
    if (freshSearchQuery) {
      try {
        products = await matchProductsForCustomerMessage(
          tenantId,
          freshSearchQuery,
          contextualMatchLimit,
          retrievalSink,
          totalCatalogCount,
        );
      } catch (err) {
        console.warn('[aiService] Other-options anchor search failed', err);
      }
    }
  } else if (needsContextualResolver) {
    // Inbound-name pinning: the follow-up classifier can route a message that EXPLICITLY
    // names a product ("Sa kushton nitro tech ripped?") into stale persisted context and
    // skip fresh retrieval entirely. Resolve any named products deterministically from the
    // full catalog and force-include them in the pool — never throws, [] when the message
    // names nothing.
    inboundNamedProducts = await resolveInboundNamedProducts(tenantId, searchText);
    products = await resolveContextualProductSet(
      tenantId,
      searchText,
      conversationHistoryWindow,
      contextualMatchLimit,
      inboundNamedProducts,
    );
  }

  if (products.length === 0 && searchText) {
    try {
      products = await matchProductsForCustomerMessage(
        tenantId,
        searchText,
        contextualMatchLimit,
        retrievalSink,
        totalCatalogCount,
      );
    } catch (err) {
      console.warn('[aiService] Product matching failed', err);
    }
  }

  // Fresh-path inbound-name gap detector. Fusion can miss a product the customer
  // EXPLICITLY NAMED — live probe "A e keni kreatinen?" ended with an EMPTY pool and a
  // blind "Po.": ILIKE cannot bridge the Albanianized k↔c spelling, the variants map
  // covers lemmas only, and embedding similarity fell short. Extract the message's name
  // grams (pure, [] for ordinary chat turns) and, only for grams NO fused row matches,
  // run the deterministic pinning ladder and prepend the hits. Gated off the contextual
  // branch (it already ran the SAME ladder at its pinning step — a gram that failed there
  // fails identically here) and off other-options turns (anchor-derived pools).
  if (!isOtherOptionsRequest && !needsContextualResolver && searchText) {
    try {
      const grams = extractCandidateNameGrams(searchText);
      const unmatchedGrams = grams.filter(
        (g) => !products.some((p) => productNameTokenMatch(g, p.name)),
      );
      if (unmatchedGrams.length > 0) {
        const pinned = await resolveGramsToProducts(tenantId, unmatchedGrams);
        if (pinned.length > 0) {
          // [] on this path by construction (only the contextual branch assigns earlier).
          inboundNamedProducts = pinned;
          const pinnedIds = new Set(pinned.map((p) => p.id));
          products = [
            ...pinned,
            ...products.filter((p) => !pinnedIds.has(p.id)),
          ].slice(0, contextualMatchLimit);
        }
      }
    } catch (err) {
      console.warn('[aiService] Inbound-name gap detection failed', err);
    }
  }

  // If matching missed the discussed product on a context follow-up, try history.
  // isPhotoProductReferenceFollowUp covers messages like "I want the product from the
  // photo I sent you" where the current message has no product name but refers back to
  // a product identified by the vision pipeline in a prior turn.
  // attributeIntent.is_attribute_question covers longer natural-language attribute questions
  // like "What is the brand of this product?" that don't match the short-form regex patterns
  // but are clearly about the previously discussed product.
  if (
    products.length === 0 &&
    (customerAskedPrice ||
      customerAskedDiscount ||
      attributeIntent.is_attribute_question ||
      attributeIntent.is_product_knowledge_question ||
      isUsageOnlyFollowUp(searchText) ||
      isVagueProductReferenceFollowUp(searchText) ||
      isCategoryAttributeFollowUp(searchText) ||
      isPhotoProductReferenceFollowUp(searchText)) &&
    conversationHistoryWindow.length > 0
  ) {
    products = await resolveContextualProductSet(
      tenantId,
      searchText,
      conversationHistoryWindow,
      contextualMatchLimit,
    );
  }

  // Deterministic safety net: never claim a previously identified product is missing.
  // If every retrieval path above came back empty but the customer is following up about
  // products the AI already discussed, reuse the persisted product IDs from the most
  // recent recommendation instead of producing a "not in catalog" reply.
  //
  // The follow-up decision is made by the cheap heuristics first and, only if they don't
  // already match, by an LLM classifier — so misspelled/dialect/slang follow-ups about
  // ANY attribute ("sa kshtjn", "qfar shejsh", "a ka stok", "cila marke") are caught by
  // meaning, not exact keywords. The LLM call is paid only on this rare empty-retrieval
  // path where we have persisted products to fall back on, never on the happy path.
  if (products.length === 0 && conversationHistoryWindow.length > 0) {
    const persisted = await resolveProductsFromPersistedContext(
      tenantId,
      conversationHistoryWindow,
      contextualMatchLimit,
    );
    if (persisted.length > 0) {
      const heuristicFollowUp = isProductFollowUpReference(
        searchText,
        attributeIntent,
        customerAskedPrice,
        customerAskedDiscount,
      );
      const isFollowUp =
        heuristicFollowUp || (await classifyContextualProductFollowUp(searchText, persisted));
      if (isFollowUp) {
        products = persisted;
        console.info('[aiService] Reused persisted product context for follow-up', {
          conversationId,
          tenantId,
          productIds: persisted.map((p) => p.id),
          query: logSafe(searchText),
          detectedBy: heuristicFollowUp ? 'heuristic' : 'classifier',
        });
      }
    }
  }

  // Warn when both retrieval paths returned 0 results for a non-empty query.
  // The most common cause for this with large catalogs is products having
  // embedding = NULL (bulk imports where the embedding job queue fell behind or
  // errored). This log helps operators diagnose the problem quickly.
  if (products.length === 0 && searchText.length > 0 && totalCatalogCount > 0) {
    countProductsWithoutEmbeddings(tenantId)
      .then(async (missing) => {
        if (missing > 0) {
          // Self-heal: immediately queue high-priority embedding jobs for this
          // tenant's un-embedded products so the *next* message in the conversation
          // is answered correctly — no manual "Backfill embeddings" action and no
          // waiting for the periodic reconcile. Idempotent via jobId dedup.
          const requeued = await enqueueMissingEmbeddingsForTenant(tenantId).catch(() => 0);
          console.warn(
            '[aiService] No products matched for non-empty query — embedding coverage gap detected; auto-healing',
            {
              tenantId,
              conversationId,
              totalActiveProducts: totalCatalogCount,
              productsWithoutEmbedding: missing,
              coveragePct: Math.round(((totalCatalogCount - missing) / totalCatalogCount) * 100),
              embeddingJobsRequeued: requeued,
            },
          );
        }
      })
      .catch(() => {
        // Diagnostic — never block the reply path
      });
  }

  if (products.length === 0) {
    // Only fall back to the alphabetical catalog sample when the customer hasn't
    // asked about a specific product (empty text, simple greeting, etc.).
    // For specific product queries that neither semantic nor keyword search could
    // satisfy — most commonly because embeddings are missing after a bulk import,
    // or because the product name uses unusual spelling — showing 20 unrelated
    // alphabetical products is actively harmful: the AI may hallucinate answers
    // based on those irrelevant rows.  Passing an empty list here instead triggers
    // the "catalog has N products, ask the customer to clarify" guardrail message
    // in formatProductCatalog(), which is the safest and most honest response.
    const meaningfulSearchText = searchText.length > 0 && extractKeywords(searchText).length > 0;
    if (!meaningfulSearchText) {
      products = cachedCatalogProducts;
      usedFullCatalogFallback = true;
    }
    // For meaningful queries with 0 matches, products stays [] → guardrail fires.
  }

  let visionContext: string | null = null;
  let imageMatchConfidence = 1;
  let shouldAskImageClarification = false;
  let productNotInCatalog = false;

  if (hasImages) {
    const imageMatchOutcome = await matchProductsFromCustomerImages({
      tenantId,
      inboundMessage,
      attachmentUrls,
      textMatchedProducts: products,
      limit: FOCUSED_PRODUCT_MATCH_LIMIT,
    });

    imageMatchConfidence = imageMatchOutcome.matchConfidence;
    shouldAskImageClarification = imageMatchOutcome.shouldAskClarification;
    productNotInCatalog = imageMatchOutcome.productNotInCatalog;
    visionContext = imageMatchOutcome.visionContext;

    if (productNotInCatalog) {
      products = [];
      usedFullCatalogFallback = false;
    } else if (imageMatchOutcome.products.length > 0) {
      products = imageMatchOutcome.products;
      usedFullCatalogFallback = false;
    }
  }

  products = await expandProductsForAttributeQuery(
    tenantId,
    products,
    attributeIntentHint,
    contextualMatchLimit,
  );

  const queryScope = detectProductQueryScope(searchText, products, attributeIntentHint);

  const usageQuestionTurn = isUsageOnlyFollowUp(searchText);
  const descriptionQuestionTurn =
    isProductDescriptionQuestion(searchText) || isVagueProductReferenceFollowUp(searchText);

  // P0-2 (description investigation): evidence-aware per-product text modes. The regex
  // gates above have a fixed cue vocabulary, so a factual question without a cue word
  // ("a eshte pa sheqer?") rendered every description as the blind 200-char brief slice —
  // the answer could be physically absent from the prompt. The deterministic scan
  // escalates exactly the products whose own text holds question tokens beyond the brief
  // boundary. `shadow` computes + logs without changing the render; `on` applies it.
  const catalogTextEvidenceMode = ((): 'off' | 'shadow' | 'on' => {
    const v = knobString('CATALOG_TEXT_EVIDENCE_MODE').trim().toLowerCase();
    return v === 'on' || v === 'shadow' ? v : 'off';
  })();
  let catalogTextEvidence: CatalogTextEvidenceResult | null = null;
  if (
    catalogTextEvidenceMode !== 'off' &&
    searchText.trim().length > 0 &&
    products.length > 0 &&
    !(typeof productCatalogContext === 'string' && productCatalogContext.trim().length > 0)
  ) {
    try {
      catalogTextEvidence = computeCatalogTextEvidence(searchText, products);
      if (catalogTextEvidence.briefOnlyMiss) {
        console.info('[aiService] catalog_text_evidence', {
          tenantId,
          mode: catalogTextEvidenceMode,
          fullCount: catalogTextEvidence.fullCount,
          extractCount: catalogTextEvidence.extractCount,
          briefOnlyMiss: catalogTextEvidence.briefOnlyMiss,
          regexFullDescription: descriptionQuestionTurn,
          regexFullUsage: usageQuestionTurn,
          products: products.length,
        });
      }
    } catch (err) {
      console.warn('[aiService] catalog text evidence scan failed — rendering legacy modes', {
        tenantId,
        err,
      });
    }
  }
  const appliedTextDecisions =
    catalogTextEvidenceMode === 'on' && catalogTextEvidence && catalogTextEvidence.decisions.size > 0
      ? catalogTextEvidence.decisions
      : undefined;

  let resolvedProductCatalogContext =
    typeof productCatalogContext === 'string' && productCatalogContext.trim().length > 0
      ? productCatalogContext
      : formatProductCatalog(products, {
          includePrice: customerAskedPrice || customerAskedDiscount,
          includeDiscount: customerAskedDiscount,
          totalCatalogCount,
          descriptionMode: descriptionQuestionTurn ? 'full' : 'brief',
          usageDescriptionMode: usageQuestionTurn ? 'full' : 'brief',
          textDecisions: appliedTextDecisions,
          productNotInCatalog,
        });

  if (products.length > 1) {
    const aggregation = buildProductAttributeAggregation(
      products,
      searchText,
      attributeIntent.attributes,
    );
    if (aggregation) {
      resolvedProductCatalogContext += `\n\n${aggregation}`;
    }
  }

  // Verified packaging-derived attributes: when a matched product's structured catalog
  // fields are empty, surface high-confidence facts read by the vision system from the
  // product's own images (brand, flavor, servings, and any other readable label fact).
  // This lets the AI answer from images instead of escalating when the answer is on the
  // packaging. Applies to BOTH text-only and photo-upload conversations. Skipped when
  // the product is not in the catalog (nothing to enrich).
  let imageDerivedAttributeContext: string | null = null;
  if (products.length > 0 && !productNotInCatalog) {
    try {
      const imageDerived = await getProductImageDerivedContext(tenantId, products);
      imageDerivedAttributeContext = imageDerived.block;
      if (imageDerivedAttributeContext) {
        resolvedProductCatalogContext += `\n\n${imageDerivedAttributeContext}`;
      }
    } catch (err) {
      console.warn('[aiService] image-derived attribute context failed', { tenantId, err });
    }
  }

  const primaryFocusedProduct = products[0];
  const referencedOosProduct =
    searchText.length > 0
      ? products.find(
          (p) => p.in_stock === false && inboundTextLikelyReferencesProduct(searchText, p),
        )
      : undefined;
  const primaryOosForCanned =
    referencedOosProduct ??
    (primaryFocusedProduct && primaryFocusedProduct.in_stock === false ? primaryFocusedProduct : null);

  const allFocusedOutOfStock =
    products.length > 0 && products.every((p) => p.in_stock === false);
  const singleFocusedMatch = products.length === 1;
  const multiMatchOosOk =
    singleFocusedMatch ||
    allFocusedOutOfStock ||
    referencedOosProduct !== undefined ||
    (searchText.length > 0 &&
      primaryFocusedProduct &&
      inboundTextLikelyReferencesProduct(searchText, primaryFocusedProduct)) ||
    (searchText.length === 0 &&
      hasImages &&
      (singleFocusedMatch || allFocusedOutOfStock));

  const shouldReturnOutOfStockCanned =
    typeof productCatalogContext !== 'string' &&
    !usedFullCatalogFallback &&
    products.length > 0 &&
    primaryOosForCanned &&
    multiMatchOosOk &&
    !looksLikeSimpleGreetingOrClosing(inboundMessage) &&
    (searchText.length > 0 || hasImages);

  if (shouldReturnOutOfStockCanned) {
    return {
      reply: getOutOfStockProductReply(language),
      productCatalogContext: resolvedProductCatalogContext,
      language,
      matchedProducts: products,
      attributeIntent,
      hadImages: hasImages,
      productNotInCatalog,
      customerAskedPrice,
    };
  }

  // P3-5 step 3: LOAD FIRST, then seed/heal. The old order issued a `countTenantPromptBlocks`
  // query before every single reply purely to answer a question the loaded rows answer for free.
  let tenantPromptBlocks = await loadTenantPromptBlocksCached(tenantId);
  if (await ensureTenantPromptBlocksSeeded(tenantId, tenantPromptBlocks)) {
    tenantPromptBlocks = await loadTenantPromptBlocksCached(tenantId);
  }
  // P2-5 (RC-26): drops are reported, never silent — a truncated or filtered prompt that looks
  // complete is exactly how the orphan block survived unnoticed in 6/6 tenants.
  const droppedBlocks: Array<{ key: string; reason: string }> = [];
  const unknownTokens: string[] = [];
  // P3-5 (RC-26/RC-17): block-version provenance. Hashed IN-PROCESS from content already in
  // memory — the reply path never reads or writes `prompt_block_versions`. A lazy per-reply
  // upsert would put a Postgres write on the hottest path AND destroy the governance alarm, by
  // self-registering every hash on first sight so "content that reached production through a path
  // that never registered" would become unobservable.
  const promptBlockProvenance: PromptBlockProvenance[] = [];
  const assembledGuidelines = assembleGuidelinesFromBlocks(
    tenantPromptBlocks,
    { language },
    {
      hasImages,
      onDropped: (key, reason) => droppedBlocks.push({ key, reason }),
      onUnknownToken: (token) => unknownTokens.push(token),
      onBlock: ({ blockKey, content, rendered, dropReason }) => {
        promptBlockProvenance.push({
          key: blockKey,
          hash: promptBlockContentHash(content),
          rendered,
          ...(dropReason ? { drop_reason: dropReason } : {}),
        });
      },
    },
  );
  if (droppedBlocks.length > 0 || unknownTokens.length > 0) {
    console.warn(
      '[aiService] Prompt block assembly dropped content',
      JSON.stringify({ tenantId, conversationId, droppedBlocks, unknownTokens }),
    );
  }

  // P3-5 (RC-26): the prompt is assembled as a DECLARED SECTION LIST rather than a `+=` string.
  //
  // Same bytes: each section carries its own leading separator and `joinSections` is plain
  // concatenation in declaration order, so an unbounded budget reproduces the previous prompt
  // exactly (pinned by promptSectionBudget.test.ts). What the list adds is a priority per section,
  // which is what makes the RC-26 ceiling enforceable instead of merely reported — you cannot
  // truncate "by declared priority" if nothing ever declared one.
  //
  // PRIORITIES. `protected` is the persona/catalog/guidelines core, the business-rules footer, and
  // the grounding contract. `high` is the anti-fabrication vision guidance. `normal` is situational
  // instruction. `low` is the brevity/format polish — the honest test being whether losing the
  // section makes the reply WORDIER (droppable) or WRONG (not).
  //
  // The injected product catalog lives inside the `protected` base section, deliberately: the
  // guards validate replies against the FULL ACTIVE CATALOG, so a product trimmed out of the
  // prompt becomes one the model cannot see but the guard still accepts — "we don't carry that"
  // about an in-stock item, passing every check. See promptSectionBudget.ts.
  const promptSections: PromptSection[] = [];
  const section = (id: string, text: string, priority: SectionPriority): void => {
    if (text) promptSections.push({ id, text, priority });
  };

  section(
    'base',
    buildRetailAISystemPrompt(
      tenant.name,
      config,
      resolvedProductCatalogContext,
      assembledGuidelines,
      tenant.niche,
      tenant.description,
      tenant.delivery_methods,
    ),
    'protected',
  );

  if (inboundNeedsSharedContentInstruction(inboundMessage)) {
    // P2-5 (DP-pc-18): locale-selected — this used to inject Albanian into English prompts,
    // contradicting the language lock carried by the same prompt.
    section('shared_content', SHARED_CONTENT_SYSTEM_APPEND_BY_LOCALE[language], 'normal');
    if (inboundTextIsPostShare(inboundMessage)) {
      section('shared_post_vision', SHARED_POST_VISION_APPEND_BY_LOCALE[language], 'normal');
    }
  }

  if (hasImages && productNotInCatalog) {
    section('image_not_in_catalog', `

Product not in catalog (IMPORTANT):
- The customer's photo does not match any product in the catalog.
- Tell the customer honestly and briefly that you do not carry this product.
- Do NOT ask for a clearer photo, product name, or any additional details.
- Do NOT describe ingredients, benefits, or other general information about the product.
- You may offer to help find something else from the catalog.`, 'high');
  } else if (hasImages && shouldAskImageClarification) {
    section('image_match_uncertain', `

Product-image match uncertainty (IMPORTANT):
- The customer's photo could not be matched to the catalog with high confidence.
- Do NOT claim you have the exact product shown unless match confidence is high.
- Ask a brief clarifying question (clearer photo showing the label, product name, or which item if multiple visible).
- You may mention similar catalog items only if listed in the product catalog context, with honest uncertainty.
- Never invent product names, prices, or availability.`, 'high');
  }

  const aggregationInstructions = buildCategoryAggregationInstructions(queryScope, products.length);
  section('category_aggregation', aggregationInstructions, 'normal');

  // When the customer is asking for other/more/different products, add an explicit guard
  // against the AI incorrectly saying a previously recommended product "is not in the
  // catalog". The catalog section here is a fresh search result — it does NOT contain
  // everything that was shown in prior turns, but that does not make prior products invalid.
  if (isOtherOptionsRequest) {
    section('other_options', `

Customer is asking for more/other products in the same category (IMPORTANT):
- Present the products listed in the catalog section above as fresh alternatives.
- Do NOT say that any product you recommended in a previous conversation turn "is not in the catalog" or "is not available" — prior recommendations were real catalog products. The current catalog section is a new search result, not a replacement of what came before.
- Do NOT recommend products from a completely different category unless the customer explicitly asks to change categories.
- If you found no new alternatives to show, say so honestly rather than inventing products or switching categories without being asked.`, 'normal');
  }

  // The four style appends are the `low` tier, and they are declared in the order they must be
  // KEPT — the budget drops the last-declared first, so under pressure the most situational
  // (targeted description, compact price list) go before the two always-on brevity rules.
  section('shortest_answer', SHORTEST_ANSWER_APPEND, 'low');
  section('description_concise', PRODUCT_DESCRIPTION_CONCISE_APPEND, 'low');
  if (customerAskedPrice && products.length > 5) {
    section('price_list_compact', PRICE_LIST_COMPACT_APPEND, 'low');
  }
  // P0-2: the targeted-description instruction is no longer coupled to the same regex
  // that gates the full-text render — any turn that actually carries escalated (full or
  // extracted) description text gets the "answer ONLY what they asked" instruction too.
  if (descriptionQuestionTurn || appliedTextDecisions !== undefined) {
    section('description_targeted', PRODUCT_DESCRIPTION_TARGETED_APPEND, 'low');
  }
  if (attributeIntent.is_attribute_question) {
    section('attribute_question', `

Product attribute question (IMPORTANT):
- Answer using catalog facts, the aggregated attribute summary, and any "Verified packaging details read from product images" block when present.
- List every distinct attribute value across ALL matching products in scope.
- Keep it compact: give the values directly with no preamble and no restating of the question; group products that share a value rather than repeating it.
- If the requested attribute is missing from BOTH the catalog and the verified packaging details, say you do not have that detail — do not guess.`, 'normal');
  }

  if (imageDerivedAttributeContext) {
    section('image_derived_attributes', `

Using packaging-derived details (IMPORTANT — source precedence):
- Prefer the structured catalog data above. When a detail is missing there but appears in the "Verified packaging details read from product images" block, you MAY answer using that value.
- These packaging values were read directly from the product's own photos by the vision system, so they are reliable enough to state — briefly note that the detail comes from the product image/label (e.g. "based on the product packaging, ...").
- Only use values listed in that block. Never infer, estimate, or guess a value that is not shown there or in the catalog. If a detail is absent from both sources, say you do not have it.
- Do not contradict the structured catalog: if the catalog already states a value, use the catalog value.`, 'high');
  }

  // Same value as before the section refactor: the estimate has always measured the prompt as it
  // stands at THIS point, before the closing append, footer and grounding directive are added.
  // (P2-5 documented that as defect (a) — it is read only in the warn payload below.)
  const systemPromptTokenEstimate = estimateTokens(joinSections(promptSections));
  const inboundTokenEstimate = estimateTokens(inboundMessage.trim());
  const olderHistorySummaryTokens = estimateTokens(olderHistorySummary ?? '');
  const historyMessageTokenEstimates = conversationHistory.map((msg) =>
    estimateTokens(
      msg.sent_by === 'customer'
        ? formatCustomerMessageContentForPrompt(msg)
        : (msg.content ?? '').trim(),
    ),
  );

  const originalHistoryCount = conversationHistory.length;

  // P2-5 (RC-26): the eviction loop moved to the pure `applyHistoryBudget` so its two accounting
  // defects are testable and explicit. `reserveSummary` gates both fixes together:
  //   (b) the total is decremented with the SAME estimates that seeded it (legacy subtracted the
  //       raw content while seeding with the formatted form — the totals drifted apart);
  //   (c) the un-evictable older-summary weight is RESERVED out of the budget instead of being
  //       added to a total the loop can never reduce (which pinned it at the 4-message floor).
  // Flag-off reproduces the legacy arithmetic byte-for-byte.
  const historyBudgetResult = applyHistoryBudget({
    items: conversationHistory,
    itemTokens: historyMessageTokenEstimates,
    // Only the legacy branch reads these (it subtracted raw-content estimates while seeding with
    // the formatted form — defect b). Built lazily so the fixed path does not map + trim the whole
    // history on every reply for a result it discards.
    evictionTokens: PROMPT_ALLOWLIST_BUDGET
      ? historyMessageTokenEstimates
      : conversationHistory.map((msg) => estimateTokens((msg.content ?? '').trim())),
    summaryTokens: olderHistorySummaryTokens,
    maxTokens: CONTEXT_MAX_HISTORY_TOKENS,
    reserveSummary: PROMPT_ALLOWLIST_BUDGET,
  });
  const historyForPrompt = historyBudgetResult.kept;
  const historyTokenTotal = historyBudgetResult.total;

  if (historyForPrompt.length !== originalHistoryCount) {
    console.warn(
      '[aiService] Conversation history truncated for context length protection',
      JSON.stringify({
        tenantId,
        conversationId,
        olderSummaryIncluded: Boolean(olderHistorySummary),
        olderSummarizedMessageCount: olderHistory.length,
        originalMessageCount: originalHistoryCount,
        truncatedMessageCount: historyForPrompt.length,
        estimatedTokenCount: historyTokenTotal,
        summaryTokensReserved: PROMPT_ALLOWLIST_BUDGET ? Math.ceil(olderHistorySummaryTokens) : 0,
      }),
    );
  }

  let conversationEnding = false;
  try {
    conversationEnding = await isConversationEnding(
      inboundMessage.trim(),
      historyForPrompt,
    );
  } catch {
    conversationEnding = false;
  }

  if (conversationEnding && !inboundMessage.includes('?')) {
    const closingFlavor = classifyClosingFlavor(inboundMessage);
    const closingSentencesForLocale = getClosingReplySentences(language);
    const closingSentence =
      closingFlavor === 'no_thanks'
        ? closingSentencesForLocale.no_thanks
        : closingSentencesForLocale.greeting;

    const previousAssistant = getPreviousAssistantMessageBeforeLatestCustomer(historyForPrompt);
    const previousAssistantText = (previousAssistant?.content ?? '').trim();
    // Suppress a repeat closing in any locale: detect prior bot closings across both languages.
    const allKnownClosingReplies = new Set([
      ...Object.values(CLOSING_REPLY_SENTENCES.sq),
      ...Object.values(CLOSING_REPLY_SENTENCES.en),
    ]);

    if (previousAssistantText && allKnownClosingReplies.has(previousAssistantText)) {
      return {
        reply: '[NO_REPLY]',
        productCatalogContext: resolvedProductCatalogContext,
        language,
        matchedProducts: products,
        attributeIntent,
        hadImages: hasImages,
        productNotInCatalog,
        customerAskedPrice,
      };
    }

    const closingAppend = CLOSING_REPLY_SYSTEM_APPEND_TEMPLATE_BY_LOCALE[language].replace(
      '__CLOSING_SENTENCE__',
      closingSentence,
    );
    section('closing_reply', `\n\n${closingAppend}`, 'normal');
  }

  // Photo-capability contract. The customer-facing photo flow is deterministic (the image
  // classifier + canned override in processAIReply own detection, dispatch, and the reply
  // text), but the model must still never CLAIM it cannot send photos: on turns where the
  // classifier misses (keyword-dodging phrasings), the raw model reply is what ships, and
  // without this instruction the model improvises "nuk mund të dërgojmë foto" apologies
  // (live Bug #2, conversation 21288070, 2026-07-20). Always on — this is capability truth,
  // not tenant policy. Per-product image availability is deliberately NOT in the catalog
  // context: the deterministic path is the authority on what actually gets sent.
  section('photo_capability', `\n\n${PHOTO_CAPABILITY_APPEND_BY_LOCALE[language]}`, 'normal');

  // Operator restrictions and platform policy are appended after all product, guideline and
  // runtime appends that could otherwise dilute them. P2-5: the locale is threaded through so
  // the platform rulebook renders in the customer's language rather than always in Albanian
  // (the mistake SHARED_CONTENT_SYSTEM_APPEND makes — DP-pc-18).
  //
  // PRIORITY LADDER (P2-5, RC-26) — the prompt now states one order and renders in it:
  //   grounding contract > platform policy > operator rules > brevity > guidelines
  // Only the P2-1 grounding directive is appended after this footer, and deliberately so: it
  // constrains the OUTPUT CONTRACT (what may be asserted and how the reply is shaped), not the
  // business policy, so it cannot dilute operator or platform rules.
  // `protected`: the whole point of the footer is last-position priority over everything above it.
  // Dropping the business rules to save chars would invert the ladder the prompt itself declares,
  // and the item's own edge case says required sections are never the truncated ones.
  const restrictionsFooter = buildRestrictionsFooter(config, language);
  section('restrictions_footer', restrictionsFooter, 'protected');

  // P2-1 (RC-03): the facts_used contract applies only to the non-vision text path and is skipped
  // for custom (fine-tuned) models that may not support structured outputs. When active, the model
  // must ground every stated fact in the product context and declare it — the directive is appended
  // AFTER the restrictions footer so it never dilutes operator policy, and ONLY when active so the
  // default prompt is unchanged.
  const useFactsContract = FACTS_USED_CONTRACT && !hasImages && !config.custom_model_id;
  if (useFactsContract) {
    // `protected`: without the directive the model does not emit `facts_used`, so
    // `parseFactsUsedCompletion` throws a GenerationContractError and the reply becomes a retry.
    // Truncating this does not degrade the answer — it deletes it.
    section('grounding_directive', GROUNDING_DIRECTIVE, 'protected');
  }

  // P3-5: the prompt is complete. Join it, applying the ceiling under `enforce`.
  //
  // `shadow` computes exactly what `enforce` would drop and records it in ledger provenance while
  // emitting the untruncated prompt — the item's migration path says to measure the prompt-size
  // distribution before cutting anything, and a mode that reports without acting is how that
  // measurement is obtained from real traffic rather than guessed.
  const sectionBudget = applySectionBudget(
    promptSections,
    PROMPT_SECTION_BUDGET_MODE === 'off' ? Infinity : PROMPT_ASSEMBLY_MAX_CHARS,
  );
  let systemPrompt =
    PROMPT_SECTION_BUDGET_MODE === 'enforce' ? sectionBudget.prompt : joinSections(promptSections);
  if (PROMPT_SECTION_BUDGET_MODE === 'enforce' && sectionBudget.droppedIds.length > 0) {
    console.warn(
      '[aiService] System prompt over budget — sections dropped by declared priority',
      JSON.stringify({
        tenantId,
        conversationId,
        droppedIds: sectionBudget.droppedIds,
        totalChars: sectionBudget.totalChars,
        maxChars: PROMPT_ASSEMBLY_MAX_CHARS,
      }),
    );
  }

  // P2-5 (RC-26) defect (a): `systemPromptTokenEstimate` / `inboundTokenEstimate` were computed
  // mid-assembly and NEVER read — dead assignments measuring an INCOMPLETE prompt (the footer and
  // grounding directive are appended after them). The system prompt was therefore never budgeted
  // at all: the 6000-token cap applied to history only while the unbudgeted 26–33K-char system
  // prompt sat beside it, competing for attention. This is the first point at which the prompt is
  // actually complete, so the assertion belongs here.
  //
  // Reports; never throws and never truncates here. Block-level budgeting happens inside
  // `assembleGuidelinesFromBlocks`, which knows the priority order and can protect the footer —
  // an over-budget prompt is a degradation, a prompt missing platform policy is a policy breach.
  let promptViolations: AssemblyViolation[] = [];
  if (PROMPT_ALLOWLIST_BUDGET) {
    promptViolations = assertRequiredSections(systemPrompt, {
      expectPlatformPolicy: RESTRICTIONS_FOOTER_ALL_TENANTS,
      expectGroundingDirective: useFactsContract,
      maxChars: PROMPT_ASSEMBLY_MAX_CHARS,
      // Scope the phantom-section scan to the guideline blocks: the full prompt also carries the
      // product catalog and tenant-authored rules, where "Active offers" could legitimately occur.
      guidelines: assembledGuidelines,
    });
    if (promptViolations.length > 0) {
      console.warn(
        '[aiService] System prompt assembly violations',
        JSON.stringify({
          tenantId,
          conversationId,
          violations: promptViolations,
          systemPromptChars: systemPrompt.length,
          systemPromptTokenEstimate: Math.ceil(systemPromptTokenEstimate),
          inboundTokenEstimate: Math.ceil(inboundTokenEstimate),
        }),
      );
    }
  }

  // P3-5 (RC-25/RC-26): the structural assembly outcome, recorded per reply.
  //
  // `platform_policy_present` is computed from the FOOTER STRING, not from the flag: the flag says
  // what we intended, the footer says what the model was actually given. RC-25's claim was that
  // the business rules reach 1 of 6 tenants — answering that needs the observed value, and a
  // divergence between the two is itself the finding.
  //
  // Recorded on EVERY reply, not only on violations. "No violation" and "the assertion never ran"
  // are different states, and only the first is evidence.
  const platformPolicyRendered = restrictionsFooter.includes('PLATFORM POLICY');
  const promptAssemblyProvenance: PromptAssemblyProvenance = {
    footer_present: restrictionsFooter.length > 0,
    platform_policy_present: platformPolicyRendered,
    platform_policy_source: !platformPolicyRendered
      ? 'none'
      : usesPlatformPolicyDefault(config)
        ? 'code_rulebook'
        : 'tenant_override',
    grounding_directive_present: useFactsContract,
    violations: promptViolations.map((v) => ({ kind: v.kind, detail: v.detail })),
    unknown_tokens: unknownTokens,
    // Recorded in `shadow` too — that is the whole point of shadow: `dropped` says what ENFORCE
    // would have cut, while the prompt actually sent was untruncated.
    sections: PROMPT_SECTION_BUDGET_MODE === 'off' ? undefined : sectionBudget.sections,
    over_budget: systemPrompt.length > PROMPT_ASSEMBLY_MAX_CHARS,
  };

  // P3-5 (RC-26): the same facts, as a durable deduped alert rather than only a console.warn.
  // Fire-and-forget — a governance alert must never delay or fail a customer reply.
  if (PROMPT_ASSEMBLY_ALERTS) {
    const issues = collectPromptAssemblyIssues({
      droppedBlocks,
      violations: promptAssemblyProvenance.violations,
      unknownTokens,
    });
    if (issues.length > 0) {
      void raisePromptAssemblyAlerts(tenantId, issues).catch(() => undefined);
    }
  }

  // Story mention/reply preview URLs are stored on the inbound message as `attachment_urls` (same as
  // other images). `buildMessagesArray` turns any non-empty `attachmentUrls` into vision `image_url`
  // parts next to the user text (Step 16 path).
  const messages = buildMessagesArray(
    systemPrompt,
    historyForPrompt,
    inboundMessage,
    attachmentUrls,
    visionContext,
    olderHistorySummary,
  );

  // P2-7 (M8/guard 5): both branches now resolve through the single chain in config/models.ts —
  // OPENAI_VISION_MODEL and OPENAI_CHAT_MODEL are `resolveModel(...)` evaluated once at module load.
  //
  // This also collapses the last per-call model read. The text branch used to re-read
  // `process.env.OPENAI_CHAT_MODEL` on every reply while the ~22 classifiers in this same file used
  // the frozen const, so a mid-process env change would move the REPLY model but not the classifiers
  // — the reply and the guards judging it could run on different models. Frozen is also what makes
  // the P2-7 config fingerprint meaningful: it hashes the frozen set at boot, and a knob that is
  // re-read later would make that hash a lie.
  //
  // M1 (the vision branch ignoring `config.custom_model_id`) is DELIBERATE and pre-existing: a
  // fine-tune of a text model may not serve images. It is a known, separately-owned defect — P2-7
  // preserves it exactly and only documents it here so the next reader sees a choice rather than an
  // oversight. A unit test pins both branches.
  const model = hasImages
    ? OPENAI_VISION_MODEL
    : (config.custom_model_id?.trim() || OPENAI_CHAT_MODEL);

  // Keep the "be extra careful when the image match is uncertain" intent: never exceed the
  // already-conservative 0.3 in that case, while the normal path uses the configured low
  // default for reproducible answers.
  const replyTemperature =
    hasImages && (productNotInCatalog || shouldAskImageClarification || imageMatchConfidence < 0.65)
      ? Math.min(AI_REPLY_TEMPERATURE, 0.3)
      : AI_REPLY_TEMPERATURE;

  // Cap length to discourage rambling; still enough for verbatim usage text and required fixed
  // phrases. With the facts_used contract (RC-03) the reply is produced DETERMINISTICALLY
  // (temperature 0 + a fixed seed) as a json_schema { facts_used, prose } object, with extra token
  // headroom for the JSON wrapper.
  const replyMaxTokens = useFactsContract ? FACTS_CONTRACT_MAX_TOKENS : 768;
  const effectiveReplyTemperature = useFactsContract ? 0 : replyTemperature;
  const effectiveReplySeed = useFactsContract ? AI_REPLY_SEED : null;
  // P3-6: label the ONE customer-facing generation with its role. In the default config every
  // chat-family role resolves to the same `gpt-4o`, so the requested model id cannot distinguish
  // the reply from the ~20 classifier calls around it — and "what does the reply itself cost vs
  // the fan-out" is the first question a tiering decision asks. A tenant's `custom_model_id` is
  // likewise unmapped to any role, so without this label a fine-tuned tenant's reply would be
  // unattributable. `withModelRole` is a no-op outside a tracking context.
  const completion = await withModelRole(hasImages ? 'vision' : 'chat', () =>
    openai.chat.completions.create({
      model,
      messages: messages as Parameters<typeof openai.chat.completions.create>[0]['messages'],
      temperature: effectiveReplyTemperature,
      max_tokens: replyMaxTokens,
      ...(useFactsContract
        ? {
            seed: AI_REPLY_SEED,
            response_format: { type: 'json_schema' as const, json_schema: FACTS_USED_JSON_SCHEMA },
          }
        : {}),
    }),
  );

  const finishReason = completion.choices[0]?.finish_reason ?? null;

  // With the contract on, the completion is a { facts_used, prose } JSON object: parse it and send
  // `prose`. A truncated / unparseable / contract-violating output throws GenerationContractError
  // (retryable) so the ai.reply job retries rather than sending malformed text.
  let reply: string;
  let factsUsed: DeclaredFact[] | undefined;
  if (useFactsContract) {
    const parsedContract = parseFactsUsedCompletion(
      completion.choices[0]?.message?.content,
      finishReason,
    );
    reply = parsedContract.prose;
    factsUsed = parsedContract.facts_used;
  } else {
    const rawReply = completion.choices[0]?.message?.content;
    if (!rawReply) {
      throw new Error('OpenAI returned an empty response');
    }
    reply = rawReply;
  }

  // ---- P1-5: capture the decision telemetry that was previously discarded at this line ----
  const usage = completion.usage ?? null;
  const redactedSystemPrompt = redactPII(systemPrompt);
  const systemPromptHash = createHash('sha256').update(systemPrompt).digest('hex');
  // P2-4 (F2): persist the FULL redacted system prompt, content-addressed and deduped, so the
  // ledger row's system_hash recovers the whole thing — not just the 12K preview head.
  // Fire-and-forget: a blob write must never slow or fail a reply.
  if (LEDGER_PROMPT_BLOBS) {
    void upsertPromptBlob(systemPromptHash, tenantId, redactedSystemPrompt).catch(() => undefined);
  }
  const telemetry: ReplyTelemetry = {
    prompt: {
      hash: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
      systemHash: systemPromptHash,
      charCount: systemPrompt.length,
      tokenEstimate: estimateTokens(systemPrompt),
      // Masked, size-capped copy of the SYSTEM prompt (persona/blocks/footer/injected directives —
      // the §15.2 reconstruction target). redactPII keeps structure while masking any embedded PII.
      preview: redactedSystemPrompt.slice(0, LEDGER_PROMPT_PREVIEW_MAX_CHARS),
      // P3-5: the block versions and the structural outcome. Behind the flag so the ledger's row
      // shape is unchanged until the registry exists to resolve the hashes against — a hash with
      // nothing to resolve it to is noise, not provenance.
      blocks: PROMPT_BLOCK_REGISTRY ? promptBlockProvenance : null,
      assembly: PROMPT_BLOCK_REGISTRY ? promptAssemblyProvenance : null,
    },
    model: {
      requested: model,
      served: completion.model ?? null,
      /**
       * P3-6: reports whether the custom model was ACTUALLY USED, not whether one is configured.
       *
       * This read `Boolean(config.custom_model_id)`, which on an image turn said `true` while the
       * VISION model was served — the M1 drop above means a tenant's fine-tune is configured and
       * ignored on exactly those turns. That made the field a claim about config wearing the
       * costume of a claim about behaviour, and it is the field cost attribution and the model-
       * drift alert both key on: a per-conversation "two different models served" check would
       * have read `customModelUsed: true` on both a text turn that used the fine-tune and an image
       * turn that did not, and reported agreement where the whole point was to catch divergence.
       *
       * The ROUTING is untouched — M1 stays deliberate and stays pinned by
       * `config/__tests__/models.test.ts`. Only the telemetry now tells the truth about it.
       */
      customModelUsed: !hasImages && Boolean(config.custom_model_id?.trim()),
      temperature: effectiveReplyTemperature,
      maxTokens: replyMaxTokens,
      seed: effectiveReplySeed, // P2-1 (RC-03): fixed seed sent when the facts_used contract is on.
      finishReason,
      truncated: finishReason === 'length',
      systemFingerprint: completion.system_fingerprint ?? null,
    },
    usage: {
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
      // P3-6: price the cached prefix. `prompt_tokens_details.cached_tokens` is a SUBSET of
      // prompt_tokens, so `computeCost` re-prices rather than adding a term.
      usdCost: computeCost(model, {
        prompt_tokens: usage?.prompt_tokens ?? null,
        completion_tokens: usage?.completion_tokens ?? null,
        total_tokens: usage?.total_tokens ?? null,
        cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
      }),
    },
    retrieval: retrievalSink.value ?? null,
  };
  // Structured cost/telemetry log — observable immediately, before the ledger relay drains
  // (migration-path step 2). No customer text; the query is already redacted in the [retrieval] log.
  logger.info('[ai.generation]', {
    conversationId,
    tenantId,
    traceId: traceId ?? null,
    model: telemetry.model.requested,
    served: telemetry.model.served,
    temperature: telemetry.model.temperature,
    finishReason: telemetry.model.finishReason,
    truncated: telemetry.model.truncated,
    promptTokens: telemetry.usage.promptTokens,
    completionTokens: telemetry.usage.completionTokens,
    usdCost: telemetry.usage.usdCost,
    semanticSkipped: telemetry.retrieval?.semanticSkipped ?? null,
  });

  return {
    reply: normalizeProductMentionsForReply(reply.trim(), resolvedProductCatalogContext),
    productCatalogContext: resolvedProductCatalogContext,
    language,
    // When the alphabetical catalog sample was injected as generic context (e.g. a
    // greeting), those rows are not products matched to the customer's query — exclude
    // them so they are not persisted as "previously discussed products" and wrongly
    // reused on a later follow-up.
    matchedProducts: usedFullCatalogFallback ? [] : products,
    attributeIntent,
    hadImages: hasImages,
    productNotInCatalog,
    customerAskedPrice,
    inboundNamedProducts,
    telemetry,
    // P2-1 (RC-03): the reply's declared facts (present only when the facts_used contract is on).
    // Fed to the consolidated grounding gate and persisted in the decision ledger.
    factsUsed,
  };
}

// ---------------------------------------------------------------------------
// Product image request classifier
// ---------------------------------------------------------------------------

export interface ProductImageRequestClassification {
  is_image_request: boolean;
  /**
   * Which product(s) the customer wants images of.
   * Empty when is_image_request is false.
   * When is_image_request is true and the customer gave no specific reference,
   * defaults to [{ type: 'current', value: null }] so the resolver picks the
   * most recently discussed product.
   */
  product_refs: ProductImageRef[];
}

/**
 * Fast synchronous pre-screen: returns true only when the message could plausibly
 * be an image request, allowing us to skip the LLM call for the vast majority of
 * messages (price queries, order placements, greetings, etc.).
 */
function mightBeImageRequest(message: string): boolean {
  const t = message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');

  if (!t || t.length < 4) return false;

  // English and Albanian image / send keywords. The Albanian nouns accept inflection
  // suffixes ("foton", "foto", "fotot", "fotove", "imazhin", "pamjen"…) — live miss
  // 2026-07-20: "a muni me ma dergu foton e nitro techit" dodged the bare \bfoto\b
  // boundary and the whole deterministic photo flow silently never ran.
  return (
    /\b(photo|image|picture|pic)s?\b/.test(t) ||
    /\bfoto\w*\b/.test(t) ||
    /\bimazh\w*\b/.test(t) ||
    /\bfotografi\w*\b/.test(t) ||
    /\bpamje\w*\b/.test(t) ||
    // Albanian: "dërgomë/dërgoji/dërgoni foto" — "send me the photo"
    /\bdergom[eë]?\b/.test(t) ||
    /\bdergoj[ei]?\b/.test(t) ||
    /\bdergon[i]?\b/.test(t) ||
    // Albanian: "shfaq" (show), "shiko" (look/view) combined with a known photo word
    (/\b(shfaq|shiko)\b/.test(t) && /\b(foto\w*|imazh\w*|pamje\w*)\b/.test(t))
  );
}

/**
 * Classifies whether a customer message is explicitly asking to see a product
 * image/photo, and identifies which product(s) they are asking about.
 *
 * Uses a fast pre-screen heuristic to skip the LLM for non-image messages, then
 * falls back to an LLM JSON classifier (temperature=0) for uncertain cases.
 *
 * Returns a safe false result on any error so it never disrupts the main AI pipeline.
 */
export async function classifyProductImageRequest(
  message: string,
): Promise<ProductImageRequestClassification> {
  const falseResult: ProductImageRequestClassification = {
    is_image_request: false,
    product_refs: [],
  };

  const inbound = message.trim();
  if (!inbound) return falseResult;

  // Skip the LLM entirely when the message cannot possibly be an image request.
  if (!mightBeImageRequest(inbound)) return falseResult;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CLASSIFIER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You classify whether a customer explicitly asks to see a product photo/image/picture. ' +
            'Return JSON:\n' +
            '{\n' +
            '  "is_image_request": boolean,\n' +
            '  "product_refs": [\n' +
            '    { "type": "position"|"name"|"all"|"current", "value": string|null }\n' +
            '  ]\n' +
            '}\n\n' +
            'Rules:\n' +
            '• is_image_request=true ONLY when the customer explicitly asks to see/receive a product photo, image, or picture.\n' +
            '• product_refs describes WHICH product(s) they want:\n' +
            '  – type="position": customer said "the first/second/third one" etc. value="1"/"2"/"3"\n' +
            '  – type="name": customer named a product. value=exact name as written by the customer.\n' +
            '  – type="all": customer wants images of all discussed products ("all of them", "both", "të gjithë"). value=null.\n' +
            '  – type="current": customer used a vague pronoun ("it", "this one", "ky/ajo/atë"). value=null.\n' +
            '• List each product separately when the customer asks for more than one.\n' +
            '• When no product is specified, use [{"type":"current","value":null}].\n' +
            '• is_image_request=false when the customer is NOT asking for a product image ' +
            '(e.g. asking about price, ordering, availability, descriptions, complaints).\n' +
            '• Handle Albanian, English, dialect, slang, abbreviations, and misspellings.',
        },
        {
          role: 'user',
          content: `Customer message: ${inbound}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 96,
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw?.trim()) return falseResult;

    const parsed = JSON.parse(raw) as {
      is_image_request?: unknown;
      product_refs?: unknown;
    };

    if (typeof parsed.is_image_request !== 'boolean') return falseResult;
    if (!parsed.is_image_request) return falseResult;

    const refs: ProductImageRef[] = [];
    if (Array.isArray(parsed.product_refs)) {
      for (const item of parsed.product_refs) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const r = item as Record<string, unknown>;
        const type = r.type;
        if (
          type !== 'position' &&
          type !== 'name' &&
          type !== 'all' &&
          type !== 'current'
        ) continue;
        refs.push({
          type: type as ProductImageRef['type'],
          value: typeof r.value === 'string' ? r.value : null,
        });
      }
    }

    console.info('[image_request_classifier] is_image_request=true', {
      product_refs: refs,
      message_preview: logSafe(inbound),
    });

    return {
      is_image_request: true,
      product_refs: refs.length > 0 ? refs : [{ type: 'current', value: null }],
    };
  } catch (err) {
    console.warn('[image_request_classifier] Classifier failed — returning false', {
      error: err instanceof Error ? err.message : String(err),
      message_preview: logSafe(inbound),
    });
    return falseResult;
  }
}
