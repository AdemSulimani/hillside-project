/**
 * P2-1 — Consolidated deterministic grounding gate + `facts_used` generation contract.
 *
 * The permanent replacement for the interim P0-2/P0-3 guard repointing. It collapses the
 * outbound price-hallucination filter, the product-name-hallucination filter, and the
 * fail-closed gap assessor's *structured* decision into ONE deterministic gate that:
 *
 *   1. Validates the reply against the tenant's FULL active catalog fact index (never this
 *      turn's volatile `matchedProducts` window — the RC-02 false-positive source).
 *   2. Takes TARGETED action on the specific failing span — a sentence carrying an
 *      ungrounded price or a fabricated product name is removed; grounded content is kept.
 *      This is the fix for the `fcd0af7e` pathology where a correct recommendation of two
 *      real in-stock products was blanket-replaced with a holding message.
 *   3. Has ONE explicit fail policy: on a catalog-index infra error the gate fails CLOSED
 *      and escalates with a DISTINCT RETRYABLE reason (`grounding_check_unavailable`) —
 *      the interim guards fell open here.
 *
 * The `facts_used` contract (RC-03) flips generation from "sample free prose, then guess the
 * facts" to "declare facts, validate the declaration": the customer reply is produced at
 * temperature 0 + fixed seed + a json_schema `response_format` returning `{ facts_used, prose }`.
 * The model's declared names seed the deterministic name check; the prose itself is the
 * authoritative deterministic backstop for prices (any price stated to the customer is
 * checked regardless of whether the model declared it).
 *
 * Intentionally performs NO I/O in its core: `evaluateGroundingFacts` is pure and fully
 * unit-testable, and `evaluateConsolidatedGrounding` takes its catalog/LLM collaborators as
 * injected `deps` (mirroring `verifySuspectedNamesAgainstCatalog`'s injectable lookup) so the
 * whole gate runs offline in tests with hand-authored fakes.
 */
import {
  extractStatedPrices,
  filterHallucinatedPrices,
  type CatalogPriceSet,
} from './priceConsistencyGuard';
import type { NameVerificationResult } from './catalogGuardReferenceService';
import { normalizeText } from './productTitleNormalization';
import { foldDialect } from './dialectNormalization';
import { locateClaimInProse, parseAttributeClaim } from './attributeClaimLexicon';
// Everything below is from the PURE attribute module — the redis/pg-backed
// catalogAttributeReferenceService is injected through `deps`, never imported here, so the gate
// stays offline-testable and the eval suite's walked import graph stays clean.
import {
  decideAttributeVerdicts,
  evidenceForRow,
  tenantWideEvidence,
  type AttributeGateMode,
  type CatalogAttributeIndex,
  type JudgeableAttributeClaim,
  type ProductRefResolution,
  type UngroundedAttribute,
} from './attributeGrounding';

// ---------------------------------------------------------------------------
// facts_used generation contract (RC-03)
// ---------------------------------------------------------------------------

export type FactType = 'price' | 'name' | 'attribute';

/** A single fact the model declares it used, so a guard strip can be re-judged against the catalog. */
export interface DeclaredFact {
  type: FactType;
  /** The product the fact is about (model's free-text reference; not a DB id). */
  product_ref: string;
  /** The stated value (a price like "18.00", a product name, or an attribute value). */
  value: string;
}

export interface FactsUsedCompletion {
  facts_used: DeclaredFact[];
  prose: string;
}

/**
 * The strict `json_schema` handed to `response_format` for the customer reply. The model may
 * only state prices/names/attributes present in the injected product-context ("FACTS") block,
 * and must declare each such fact in `facts_used`.
 */
export const FACTS_USED_JSON_SCHEMA = {
  name: 'grounded_reply',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['facts_used', 'prose'],
    properties: {
      facts_used: {
        type: 'array',
        description: 'Every price, product name, or attribute value stated in prose, drawn ONLY from the product context.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'product_ref', 'value'],
          properties: {
            type: { type: 'string', enum: ['price', 'name', 'attribute'] },
            product_ref: { type: 'string' },
            value: { type: 'string' },
          },
        },
      },
      prose: {
        type: 'string',
        description: 'The customer-facing reply text.',
      },
    },
  },
} as const;

/**
 * Retryable failure of the `facts_used` contract — a truncated (`finish_reason:length`),
 * unparseable, or contract-violating completion. `generateReply` already throws on empty
 * content and the ai.reply job retries via BullMQ; this rides the same path so a malformed
 * structured output is retried, never sent as-is.
 */
export class GenerationContractError extends Error {
  readonly kind: 'truncated' | 'parse' | 'shape';
  constructor(message: string, kind: 'truncated' | 'parse' | 'shape') {
    super(message);
    this.name = 'GenerationContractError';
    this.kind = kind;
  }
}

/**
 * Parse a `facts_used` completion into `{ facts_used, prose }`. Throws `GenerationContractError`
 * (retryable) on truncation, invalid JSON, or a shape that violates the contract. `finishReason`
 * lets the caller classify a `max_tokens` truncation before the (necessarily invalid) JSON parse.
 */
export function parseFactsUsedCompletion(
  content: string | null | undefined,
  finishReason?: string | null,
): FactsUsedCompletion {
  if (finishReason === 'length') {
    throw new GenerationContractError('facts_used completion truncated at max_tokens', 'truncated');
  }
  const raw = (content ?? '').trim();
  if (!raw) throw new GenerationContractError('empty facts_used completion', 'parse');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GenerationContractError('facts_used completion is not valid JSON', 'parse');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new GenerationContractError('facts_used completion is not a JSON object', 'shape');
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.prose !== 'string' || !obj.prose.trim()) {
    throw new GenerationContractError('facts_used completion missing prose', 'shape');
  }

  // P3-1: an unrecognized `type` is DROPPED, not coerced.
  //
  // This previously defaulted to 'attribute', which was harmless only because the attribute bucket
  // was discarded unread. Now that declared attribute facts drive a customer-visible strip, that
  // default would route every malformed fact the model emits — a mistyped price, a truncated
  // enum, a hallucinated fourth type — into the attribute lane as a judgeable claim. Dropping is
  // the safe direction: an unparseable fact simply goes unjudged, which is the same outcome as the
  // model not declaring it.
  const facts: DeclaredFact[] = Array.isArray(obj.facts_used)
    ? (obj.facts_used as unknown[])
        .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
        .map((f) => {
          const type = String((f as Record<string, unknown>).type);
          const known = type === 'price' || type === 'name' || type === 'attribute';
          return {
            type: (known ? type : null) as FactType | null,
            product_ref: typeof f.product_ref === 'string' ? f.product_ref : '',
            value: typeof f.value === 'string' ? f.value.trim() : '',
          };
        })
        .filter((f): f is DeclaredFact => f.type !== null && f.value.length > 0)
    : [];

  return { facts_used: facts, prose: obj.prose };
}

// ---------------------------------------------------------------------------
// The gate verdict
// ---------------------------------------------------------------------------

export type GroundingStatus = 'grounded' | 'stripped' | 'escalate' | 'infra_error';

export type GroundingReason =
  | 'hallucinated_price'
  | 'hallucinated_product_name'
  | 'hallucinated_product_attribute'
  | 'grounding_check_unavailable';

export interface GroundingVerdict {
  status: GroundingStatus;
  /**
   * The reply text to send. `grounded` → prose unchanged; `stripped` → prose with the failing
   * sentence(s) removed; `escalate`/`infra_error` → prose unchanged (the caller substitutes the
   * locale holding message when `escalate` is true).
   */
  text: string;
  /** True when the caller must replace `text` with a holding message + create an alert + pause. */
  escalate: boolean;
  reason?: GroundingReason;
  /** Distinguishes a genuine catalog-lookup failure (fail-closed) from a content escalation. */
  failClosed?: boolean;
  /** Raw price tokens stated in prose with no full-catalog match. */
  ungroundedPrices: string[];
  /** Product names asserted (declared or prose-surfaced) with no full-catalog match. */
  ungroundedNames: string[];
  /**
   * Declared attribute claims the resolved catalog row REFUTES (P3-1).
   *
   * OPTIONAL and OMITTED — never `[]` — when the attribute lane is off, because
   * `groundingGateDetails` is persisted verbatim into `ai_alerts.details` JSONB. Emitting an empty
   * array would change every flag-off escalation record, breaking the byte-for-byte flag-off
   * guarantee the whole P0/P1/P2 flag discipline rests on.
   */
  ungroundedAttributes?: UngroundedAttribute[];
  /** `shadow` mode only: what WOULD have been flagged, for the cutover bake-in. */
  shadowAttributes?: UngroundedAttribute[];
}

const PRICE_EPSILON = 0.01;

/** Split into sentence-ish spans on terminal punctuation and newlines. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * TARGETED action: remove only the sentences that carry an ungrounded price value or a
 * fabricated product name, keeping every grounded sentence intact. Never a blanket replace.
 */
function stripUngroundedSentences(
  prose: string,
  ungroundedPriceValues: number[],
  ungroundedNames: string[],
  ungroundedAttributes: UngroundedAttribute[] = [],
): string {
  const normNames = ungroundedNames.map((n) => normalizeText(n)).filter((n) => n.length >= 3);
  const kept = splitSentences(prose).filter((sentence) => {
    const statedValues = extractStatedPrices(sentence).map((p) => p.value);
    const carriesBadPrice = statedValues.some((v) =>
      ungroundedPriceValues.some((u) => Math.abs(u - v) <= PRICE_EPSILON),
    );
    if (carriesBadPrice) return false;
    const normSentence = normalizeText(sentence);
    const carriesBadName = normNames.some((n) => normSentence.includes(n));
    if (carriesBadName) return false;
    if (ungroundedAttributes.length > 0 && sentenceCarriesAttribute(sentence, ungroundedAttributes)) {
      return false;
    }
    return true;
  });
  return kept.join(' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * A sentence carries a refuted attribute claim only when it states BOTH the claim phrase AND the
 * product it was made about.
 *
 * Requiring the product reference is what keeps this from re-creating the `fcd0af7e` pathology one
 * dimension down. A reply can legitimately contain "Green proten është pa sheqer" (true) next to
 * "Mega mass 3kg Vanil është pa sheqer" (refuted); both fold to contain the same claim phrase, so a
 * phrase-only strip would delete the correct sentence too. When the claim and its product never
 * co-occur in one sentence nothing is stripped, and `evaluateGroundingFacts` escalates instead —
 * we know a refuted claim is in the text but cannot excise it surgically.
 */
function sentenceCarriesAttribute(
  sentence: string,
  ungroundedAttributes: UngroundedAttribute[],
): boolean {
  const folded = foldDialect(sentence);
  if (!folded) return false;
  const norm = normalizeText(sentence);
  return ungroundedAttributes.some((attr) => {
    if (!attr.proseSpan || !folded.includes(attr.proseSpan)) return false;
    const ref = normalizeText(attr.matchedProduct ?? attr.productRef);
    return ref.length >= 3 && norm.includes(ref);
  });
}

/**
 * Pure grounding verdict: `(prose, priceSet, precomputed ungroundedNames) → verdict`.
 *
 * Prices are validated directly against the full-catalog price set from the prose (the
 * deterministic backstop — every price shown to the customer is checked). Names are validated
 * upstream (pg_trgm needs I/O) and their confirmed-ungrounded set is passed in. A reply with no
 * ungrounded facts is `grounded` (sent unchanged). Otherwise the failing sentences are stripped;
 * if too little grounded content survives (< `stripFloor`) the gate escalates to a holding message.
 */
export function evaluateGroundingFacts(input: {
  prose: string;
  priceSet: CatalogPriceSet;
  ungroundedNames: string[];
  stripFloor: number;
  /** P3-1. OPTIONAL so every pre-existing 4-field call site compiles unchanged. */
  ungroundedAttributes?: UngroundedAttribute[];
}): GroundingVerdict {
  const prose = input.prose ?? '';
  const ungroundedStated = filterHallucinatedPrices(prose, input.priceSet);
  const ungroundedPrices = ungroundedStated.map((p) => p.raw);
  const ungroundedPriceValues = ungroundedStated.map((p) => p.value);
  const ungroundedNames = [...new Set(input.ungroundedNames.filter((n) => Boolean(n && n.trim())))];
  const ungroundedAttributes = input.ungroundedAttributes ?? [];
  // Spread, so the key is ABSENT (not `[]`) whenever the lane contributed nothing — see the
  // GroundingVerdict docblock: this is what keeps flag-off `ai_alerts.details` byte-identical.
  const attrField =
    ungroundedAttributes.length > 0 ? { ungroundedAttributes } : ({} as Record<string, never>);

  if (
    ungroundedPrices.length === 0 &&
    ungroundedNames.length === 0 &&
    ungroundedAttributes.length === 0
  ) {
    return { status: 'grounded', text: prose, escalate: false, ungroundedPrices, ungroundedNames };
  }

  const stripped = stripUngroundedSentences(
    prose,
    ungroundedPriceValues,
    ungroundedNames,
    ungroundedAttributes,
  );
  // Every refuted attribute must actually be GONE from the surviving text before we call this a
  // strip. The attribute strip additionally requires the product reference in the same sentence,
  // so when a claim and its product never co-occur nothing is excised — and sending the remainder
  // would ship text we know carries a refuted claim. Scoped to the attribute lane on purpose: the
  // price and name paths keep their original semantics exactly.
  const attributesExcised =
    ungroundedAttributes.length === 0 ||
    !sentenceCarriesAttribute(stripped, ungroundedAttributes);
  if (attributesExcised && stripped.length >= Math.max(0, input.stripFloor)) {
    return {
      status: 'stripped',
      text: stripped,
      escalate: false,
      ungroundedPrices,
      ungroundedNames,
      ...attrField,
    };
  }

  // Not enough grounded content survives a targeted strip → hand the turn to a human.
  // Precedence is unchanged for the pre-existing dimensions: with no attributes the expression is
  // value-identical to the original name-then-price ternary.
  const reason: GroundingReason =
    ungroundedNames.length > 0
      ? 'hallucinated_product_name'
      : ungroundedPrices.length > 0
        ? 'hallucinated_price'
        : 'hallucinated_product_attribute';
  return {
    status: 'escalate',
    text: prose,
    escalate: true,
    reason,
    failClosed: false,
    ungroundedPrices,
    ungroundedNames,
    ...attrField,
  };
}

// ---------------------------------------------------------------------------
// Async orchestration (injectable deps → offline-testable)
// ---------------------------------------------------------------------------

export interface GroundingGateDeps {
  /** Full active-catalog price set (P0-2 `getFullCatalogPriceSet`). */
  getPriceSet: (tenantId: string) => Promise<CatalogPriceSet>;
  /** Full active-catalog name index (P0-2 `getFullCatalogNameIndex`). */
  getNameIndex: (tenantId: string) => Promise<string[]>;
  /** LLM name-suspect surfacer for names asserted in prose but not declared (`filterHallucinatedProductNames`). */
  suspectNames: (
    prose: string,
    referenceNames: string[],
  ) => Promise<{ hasHallucination: boolean; suspectedNames: string[] }>;
  /** Deterministic name verification against the full catalog (`verifySuspectedNamesAgainstCatalog`). */
  verifyNames: (
    tenantId: string,
    suspects: string[],
    nameIndex: string[],
  ) => Promise<NameVerificationResult>;
  /**
   * P3-1 free-text attribute evidence index. OPTIONAL — an absent dep disables the attribute lane
   * entirely, so every pre-existing 4-property `deps` literal keeps compiling and behaving.
   */
  getAttributeIndex?: (tenantId: string) => Promise<CatalogAttributeIndex>;
  /** P3-1 `product_ref` → catalog row resolver. OPTIONAL, same reason. */
  resolveProductRef?: (
    tenantId: string,
    productRef: string,
    index: CatalogAttributeIndex,
  ) => Promise<ProductRefResolution>;
}

/**
 * Orchestrate the consolidated gate for a customer reply. Fetches the full-catalog reference
 * sets, surfaces + deterministically verifies asserted names, then delegates to the pure
 * `evaluateGroundingFacts`.
 *
 * Fail policy: a throw from the catalog-index fetch fails CLOSED with the distinct retryable
 * reason `grounding_check_unavailable`. The name suspecter/verifier are a best-effort residue —
 * their failure fails OPEN (no name escalation), matching the legacy guards and avoiding
 * over-escalation.
 */
export async function evaluateConsolidatedGrounding(input: {
  tenantId: string;
  prose: string;
  factsUsed: DeclaredFact[] | null | undefined;
  deps: GroundingGateDeps;
  nameLlmCap: number;
  stripFloor: number;
  /** P3-1 declared-attribute lane. OPTIONAL, defaults `'off'` — flag-off is byte-for-byte legacy. */
  attributeMode?: AttributeGateMode;
  /** P3-1 per-reply bound on judged attribute claims. Overflow FAILS OPEN (let through). */
  attributeMaxClaims?: number;
}): Promise<GroundingVerdict> {
  const prose = input.prose ?? '';

  let priceSet: CatalogPriceSet;
  let nameIndex: string[];
  try {
    [priceSet, nameIndex] = await Promise.all([
      input.deps.getPriceSet(input.tenantId),
      input.deps.getNameIndex(input.tenantId),
    ]);
  } catch {
    return {
      status: 'infra_error',
      text: prose,
      escalate: true,
      reason: 'grounding_check_unavailable',
      failClosed: true,
      ungroundedPrices: [],
      ungroundedNames: [],
    };
  }

  // Name candidates: the model's declared name facts ∪ the LLM suspecter's output. Only names
  // that actually appear in prose can drive a customer-facing strip.
  const declaredNames = (input.factsUsed ?? [])
    .filter((f) => f.type === 'name')
    .map((f) => f.value.trim())
    .filter(Boolean);

  const referenceNames = nameIndex.slice(0, Math.max(0, input.nameLlmCap));
  let suspected: string[] = [];
  try {
    const res = await input.deps.suspectNames(prose, referenceNames);
    suspected = res.suspectedNames ?? [];
  } catch {
    suspected = [];
  }

  const candidates = [...new Set([...declaredNames, ...suspected].map((n) => n.trim()).filter(Boolean))];
  let ungroundedNames: string[] = [];
  if (candidates.length > 0) {
    try {
      const verification = await input.deps.verifyNames(input.tenantId, candidates, nameIndex);
      const proseNorm = normalizeText(prose);
      ungroundedNames = verification.confirmed.filter((name) => {
        const n = normalizeText(name);
        return n.length >= 3 && proseNorm.includes(n);
      });
    } catch {
      ungroundedNames = [];
    }
  }

  const attribute = await judgeDeclaredAttributes(input, prose);

  const verdict = evaluateGroundingFacts({
    prose,
    priceSet,
    ungroundedNames,
    stripFloor: input.stripFloor,
    ungroundedAttributes: attribute.flagged,
  });
  return attribute.observed.length > 0 && attribute.flagged.length === 0
    ? { ...verdict, shadowAttributes: attribute.observed }
    : verdict;
}

/**
 * P3-1 — judge the declared `attribute` facts.
 *
 * FAIL-OPEN THROUGHOUT, and deliberately asymmetric with the price/name index above, which fails
 * CLOSED. That asymmetry is the point, not an oversight: the price/name reference sets are proven
 * and structurally complete, so their unavailability genuinely means "cannot validate". This lane
 * is new, judges free prose, and can only ever ADD flags — so an infrastructure blip must leave
 * the reply alone rather than pause a conversation that has no automatic exit. Pinned by test so
 * it is not later "harmonised" into fail-closed.
 *
 * LAZY: no index fetch, no Redis GET, no query happens until pure parsing has produced at least one
 * eligible claim actually present in the prose. On greetings, price questions and order
 * confirmations that is zero, at every mode.
 */
async function judgeDeclaredAttributes(
  input: {
    tenantId: string;
    factsUsed: DeclaredFact[] | null | undefined;
    deps: GroundingGateDeps;
    attributeMode?: AttributeGateMode;
    attributeMaxClaims?: number;
  },
  prose: string,
): Promise<{ flagged: UngroundedAttribute[]; observed: UngroundedAttribute[] }> {
  const mode: AttributeGateMode = input.attributeMode ?? 'off';
  const none = { flagged: [], observed: [] };
  if (mode === 'off') return none;
  const { getAttributeIndex, resolveProductRef } = input.deps;
  if (!getAttributeIndex || !resolveProductRef) return none;

  const maxClaims = Math.max(0, input.attributeMaxClaims ?? 8);
  if (maxClaims === 0) return none;

  // The declared-attribute filter. The literal `f.type === 'attribute'` below is what fires P3-4's
  // source-text tripwire in eval/harness/__tests__/tokenMembership.test.ts — that test asserts this
  // exact byte sequence is ABSENT and must be deleted when this lane lands. Writing it any other
  // way (double quotes, a helper predicate, a switch) would leave the tripwire green and the
  // "unguarded at every layer" note silently stale.
  const declaredAttributes = (input.factsUsed ?? []).filter((f) => f.type === 'attribute');
  if (declaredAttributes.length === 0) return none;

  const proseFolded = foldDialect(prose);
  if (!proseFolded) return none;

  // Declaration order, not sorted — the cap must be a stable prefix of what the model said.
  const located: Array<{ productRef: string; claim: ReturnType<typeof parseAttributeClaim>; proseSpan: string }> = [];
  for (const fact of declaredAttributes) {
    if (located.length >= maxClaims) break;
    const claim = parseAttributeClaim(fact.value);
    if (!claim.eligible) continue;
    const proseSpan = locateClaimInProse(claim, proseFolded);
    if (!proseSpan) continue;
    located.push({ productRef: fact.product_ref ?? '', claim, proseSpan });
  }
  if (located.length === 0) return none;

  let index: CatalogAttributeIndex;
  try {
    index = await getAttributeIndex(input.tenantId);
  } catch (err) {
    console.warn('[grounding_gate] attribute index unavailable — attribute lane inert this turn', {
      tenantId: input.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return none;
  }

  const resolutions = new Map<string, ProductRefResolution>();
  const claims: JudgeableAttributeClaim[] = [];
  for (const item of located) {
    let resolution = resolutions.get(item.productRef);
    if (!resolution) {
      try {
        resolution = await resolveProductRef(input.tenantId, item.productRef, index);
      } catch {
        resolution = { row: null, via: 'lookup_error' };
      }
      resolutions.set(item.productRef, resolution);
    }
    const scope = resolution.row ? 'product' : 'tenant';
    claims.push({
      claim: item.claim,
      productRef: item.productRef,
      proseSpan: item.proseSpan,
      matchedProduct: resolution.row?.name ?? null,
      scope,
      evidence: resolution.row
        ? evidenceForRow(resolution.row, index)
        : tenantWideEvidence(index),
    });
  }

  return decideAttributeVerdicts({ claims, mode });
}
