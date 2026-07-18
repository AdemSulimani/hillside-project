/**
 * P3-1 — the declared-attribute grounding predicate. PURE: no I/O, no clock, no randomness.
 *
 * THE GAP THIS CLOSES. `docs/audit/16-remediation-plan.md` §P3-1 records a live, unguarded
 * fabrication class: "a false SENTENCE built from true WORDS". The model declares attribute facts
 * (`{type:'attribute'}`) under the `facts_used` contract, but `evaluateConsolidatedGrounding`
 * consumed only `f.type === 'name'` and threw the rest away. "Mega mass 3kg Vanil është pa sheqer"
 * names a real product in real words; only the proposition is invented, so neither the name guard,
 * the price guard, nor P3-4's token-membership checker can see it.
 *
 * WHY CONTRADICTION-ONLY, NOT MEMBERSHIP. The roadmap's wording is "validate declared attribute
 * facts against the injected catalog" — i.e. flag what is absent. Measured on the real catalog
 * that is not implementable safely: of 257 active rows, 218 say NOTHING about sugar, and most
 * supplements genuinely ARE sugar-free — the merchant simply never wrote it down. There is no
 * deterministic way to separate "silent because obviously true" from "silent because false", so
 * flagging silence would strip TRUE sentences at scale. A grounding escalation pauses the
 * conversation with no automatic exit (`AI_AUTO_RESUME` covers only `rate_limit_exceeded`), so the
 * cost of each false positive is a permanently silenced merchant thread.
 *
 * SILENCE THEREFORE NEVER FLAGS, AT ANY MODE. The lane fires only where the catalog actively
 * DISAGREES. That is what preserves P0-2's safety property — the reason the RC-02 repointing was
 * low-risk was that widening the reference set could only ever REMOVE a flag. Contradiction-only
 * is the closest analogue available here.
 *
 * The roadmap's own acceptance case needs no silence rung, which is what makes this scoping honest
 * rather than convenient. `Mega mass 3kg Vanil`'s description reads "Sheqer i reduktuar: ... është
 * më e ulët në sheqer" — REDUCED sugar. "pa sheqer" (sugar-FREE) is refuted by the catalog's own
 * text, not merely unsupported by it.
 *
 * SUPPORT IS CHECKED FIRST AND SUPPORT WINS. Four real rows carry both an exclusion phrase and a
 * contradiction marker for sugar (e.g. `Premium EAA zero`: "suplement pluhur pa sheqer" AND "me
 * sheqer të reduktuar"). Without support-first ordering those four are false positives.
 */
import {
  bridgeTermsIn,
  containsPhrase,
  hasContradictionMarker,
  hasExclusionMarker,
  hasNonAssertiveFrame,
  SUBSTANCE_LEXICON,
  type AttributeClaim,
} from './attributeClaimLexicon';

export type AttributeGateMode = 'off' | 'shadow' | 'enforce';
export type AttributeSupport = 'supported' | 'contradicted' | 'silent';

/**
 * Whether the claim was judged against ONE resolved catalog row or against the tenant's whole
 * catalog. Only `product` scope may ever contradict: a tenant-wide contradiction would mean
 * "some other product contains sugar, therefore this claim is false", which is a non-sequitur.
 * Tenant scope exists solely as a RESCUE path when `product_ref` cannot be resolved.
 */
export type AttributeScope = 'product' | 'tenant';

export interface AttributeEvidence {
  /** Folded clauses of name + category + description + usage_description, in document order. */
  clauses: string[];
  /** False when the row carries no usable free text — 37/257 real rows are in this class. */
  populated: boolean;
  /** True when the index hit its row cap. Makes every claim contradiction-INELIGIBLE. */
  truncated: boolean;
}

/**
 * The index SHAPE lives here, in the pure module, while the Redis/Postgres machinery that fills it
 * lives in `catalogAttributeReferenceService`. That split is load-bearing: `groundingGate` needs
 * these types and these two projections, and routing it through the I/O module would put
 * `redisConnection` and `db/pool` on an import path the offline eval suite walks.
 */
export interface CatalogAttributeRow {
  id: string;
  name: string;
  /** `normalizeText(name)` — the key the containment resolver compares against. */
  normName: string;
  /** Folded clauses of name + category + description + usage_description, in document order. */
  clauses: string[];
  /** False when the row carries no free text beyond its own name/category. */
  populated: boolean;
}

export interface CatalogAttributeIndex {
  rows: CatalogAttributeRow[];
  /** True when the row cap was hit — makes every claim contradiction-ineligible downstream. */
  truncated: boolean;
}

export interface ProductRefResolution {
  row: CatalogAttributeRow | null;
  via: 'name_index' | 'trigram' | 'ambiguous' | 'unresolved' | 'lookup_error';
}

/** Evidence view of one resolved row, carrying the index-level `truncated` flag forward. */
export function evidenceForRow(
  row: CatalogAttributeRow | null,
  index: CatalogAttributeIndex,
): AttributeEvidence {
  if (!row) return { clauses: [], populated: false, truncated: index.truncated };
  return { clauses: row.clauses, populated: row.populated, truncated: index.truncated };
}

/**
 * Tenant-wide evidence — RESCUE ONLY. Used when `product_ref` did not resolve, so that a claim the
 * catalog supports somewhere is not flagged merely for lack of a resolution. Always passed at
 * `scope: 'tenant'`, which `evaluateAttributeClaim` refuses to contradict.
 */
export function tenantWideEvidence(index: CatalogAttributeIndex): AttributeEvidence {
  const clauses: string[] = [];
  for (const row of index.rows) clauses.push(...row.clauses);
  return { clauses, populated: clauses.length > 0, truncated: index.truncated };
}

export interface UngroundedAttribute {
  /** The value exactly as declared, for the alert/ledger record. */
  value: string;
  /** The folded phrase actually located in the prose — the only legal strip key. */
  proseSpan: string;
  /** The model's free-text product reference, as declared. */
  productRef: string;
  /** The catalog name it resolved to, or null when unresolved. */
  matchedProduct: string | null;
  support: AttributeSupport;
  scope: AttributeScope;
}

/** One claim, already parsed, located in prose, and paired with its evidence. */
export interface JudgeableAttributeClaim {
  claim: AttributeClaim;
  productRef: string;
  proseSpan: string;
  evidence: AttributeEvidence;
  matchedProduct: string | null;
  scope: AttributeScope;
}

/** Does this clause assert the ABSENCE of `substance` (directly, or via a support-only bridge)? */
function clauseSupportsExclusion(clause: string, substance: string): boolean {
  if (!hasExclusionMarker(clause)) return false;
  const forms = SUBSTANCE_LEXICON.get(substance) ?? [];
  if (forms.some((form) => containsPhrase(clause, form))) return true;
  // "pa produkte qumështi" entails lactose-free. The bridge is consulted HERE and nowhere else.
  return bridgeTermsIn(clause, substance);
}

/**
 * Does this clause assert the PRESENCE of `substance`?
 *
 * Three conjuncts, each of which independently suppresses a measured false-positive class:
 *  - a contradiction marker must be present (a bare mention asserts nothing);
 *  - the clause must NOT also carry an exclusion marker (belt-and-braces on support-first — the
 *    real `Premium EAA zero` clause carries "pa sheqer" and "përmban" together);
 *  - the clause must not be a non-assertive framing ("intoleranca ndaj laktozës" describes the
 *    AUDIENCE, not the composition — real text from `BEEF AMINO 300 Tableta`).
 *
 * Bridge terms are deliberately NOT consulted: milk protein does not entail lactose.
 */
function clauseContradictsExclusion(clause: string, substance: string): boolean {
  const forms = SUBSTANCE_LEXICON.get(substance) ?? [];
  if (!forms.some((form) => containsPhrase(clause, form))) return false;
  if (!hasContradictionMarker(clause)) return false;
  if (hasExclusionMarker(clause)) return false;
  if (hasNonAssertiveFrame(clause)) return false;
  return true;
}

/**
 * Three-valued verdict for one claim: `supported` | `contradicted` | `silent`.
 *
 * Support is evaluated over EVERY clause before contradiction is considered at all — the ordering
 * is the fix for the four both-signals rows, and it is why this returns a tri-state rather than a
 * boolean. Only `silent` and `contradicted` are distinguishable in effect (`silent` passes), but
 * naming `supported` separately is what makes the shadow window legible.
 */
export function evaluateAttributeClaim(
  claim: AttributeClaim,
  evidence: AttributeEvidence,
  scope: AttributeScope,
): AttributeSupport {
  if (!claim.eligible || claim.substances.length === 0) return 'silent';

  // ---- Pass 1: SUPPORT, across the whole evidence set, at any scope. ---------------------
  for (const substance of claim.substances) {
    for (const clause of evidence.clauses) {
      if (clauseSupportsExclusion(clause, substance)) return 'supported';
    }
  }

  // ---- Pass 2: CONTRADICTION, only under the three preconditions. ------------------------
  // Tenant scope may never contradict (rescue-only). An unpopulated row has nothing to say. A
  // truncated index may be missing the very clause that would have supported the claim, so
  // contradicting on a partial view could flag a true statement.
  if (scope !== 'product' || !evidence.populated || evidence.truncated) return 'silent';

  for (const substance of claim.substances) {
    for (const clause of evidence.clauses) {
      if (clauseContradictsExclusion(clause, substance)) return 'contradicted';
    }
  }

  return 'silent';
}

/**
 * Fold a set of located claims into the flagged/observed lists.
 *
 * `flagged` drives customer-visible action and is empty at every mode except `enforce`.
 * `observed` is every contradiction the lane saw, at every mode except `off` — it is what the
 * shadow window reads. Keeping both means enabling `enforce` changes only whether the list is
 * ACTED on, never what was computed, so a shadow bake-in genuinely predicts the cutover.
 */
export function decideAttributeVerdicts(input: {
  claims: JudgeableAttributeClaim[];
  mode: AttributeGateMode;
}): { flagged: UngroundedAttribute[]; observed: UngroundedAttribute[] } {
  if (input.mode === 'off') return { flagged: [], observed: [] };

  const observed: UngroundedAttribute[] = [];
  for (const item of input.claims) {
    const support = evaluateAttributeClaim(item.claim, item.evidence, item.scope);
    if (support !== 'contradicted') continue;
    observed.push({
      value: item.claim.raw,
      proseSpan: item.proseSpan,
      productRef: item.productRef,
      matchedProduct: item.matchedProduct,
      support,
      scope: item.scope,
    });
  }

  return { flagged: input.mode === 'enforce' ? observed : [], observed };
}
