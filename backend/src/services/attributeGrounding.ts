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
import { expandDialectVariants } from './dialectNormalization';

export type AttributeGateMode = 'off' | 'shadow' | 'enforce';
/**
 * `supported`/`contradicted`/`silent` come from the exclusion lane; `absent` is the membership
 * lane's flag outcome (P1-B): a declared VALUE claim whose folded form (or dialect variant)
 * appears nowhere in the referenced product's own evidence. Membership does not have the
 * silence problem the docblock above describes — the grounding contract requires declared facts
 * verbatim from the product context, so "absent from the referenced row" means the model bound a
 * value to the wrong product (cross-product transfer) or invented it outright.
 */
export type AttributeSupport = 'supported' | 'contradicted' | 'silent' | 'absent';

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
  /**
   * SUPPORT-ONLY clauses: folded packaging-image fingerprint text. The generator's prompt
   * injects verified packaging reads as "available, reliable catalog knowledge", so a claim the
   * model took from them is grounded and must never flag as absent (live FP: "1.81 kg" for
   * Nitro Tech Ripped — description NULL, value on the packaging). Vision reads are too noisy
   * to CONTRADICT with, so these clauses may rescue a claim but never create a flag.
   * Optional: absent means "no packaging evidence" (identical to []).
   */
  supportOnlyClauses?: string[];
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
  /** Folded packaging-image fingerprint clauses — support-only evidence (see AttributeEvidence). */
  auxClauses?: string[];
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
  if (!row) return { clauses: [], supportOnlyClauses: [], populated: false, truncated: index.truncated };
  return {
    clauses: row.clauses,
    supportOnlyClauses: row.auxClauses ?? [],
    populated: row.populated,
    truncated: index.truncated,
  };
}

/**
 * Tenant-wide evidence — RESCUE ONLY. Used when `product_ref` did not resolve, so that a claim the
 * catalog supports somewhere is not flagged merely for lack of a resolution. Always passed at
 * `scope: 'tenant'`, which `evaluateAttributeClaim` refuses to contradict.
 */
export function tenantWideEvidence(index: CatalogAttributeIndex): AttributeEvidence {
  const clauses: string[] = [];
  const supportOnlyClauses: string[] = [];
  for (const row of index.rows) {
    clauses.push(...row.clauses);
    if (row.auxClauses) supportOnlyClauses.push(...row.auxClauses);
  }
  return { clauses, supportOnlyClauses, populated: clauses.length > 0, truncated: index.truncated };
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
  // Support-only packaging clauses participate here (a "Sugar Free" label read rescues a
  // "pa sheqer" claim) but are excluded from the contradiction pass below — the safe direction.
  for (const substance of claim.substances) {
    for (const clause of [...evidence.clauses, ...(evidence.supportOnlyClauses ?? [])]) {
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
 * MEMBERSHIP predicate for a declared VALUE claim (P1-B — the "Qershi" fabrication class).
 *
 * Tri-state: `supported` when the claim's folded form (or a known dialect/content variant —
 * qokolad↔cokollate↔chocolate, dredhze↔luleshtrydhe) occupies whole-token positions in ANY of the
 * referenced row's evidence clauses; `absent` when it does not; `silent` when the claim is not
 * judgeable at all.
 *
 * The false-positive discipline mirrors the exclusion lane exactly:
 *  - tenant scope never flags (rescue-only — an unresolved/ambiguous product_ref must not turn
 *    into a strip against the wrong row);
 *  - a truncated index never flags (the missing rows could carry the resolution);
 *  - unlike the exclusion lane there is deliberately NO `populated` requirement: the product NAME
 *    is itself a legitimate evidence clause for a value claim ("Creatine 500gr Qershi" grounds
 *    "Qershi" from its name alone), and post-backfill the structured-attributes clause is too.
 */
/**
 * Phrase variants of a folded value claim: the claim itself plus every single-token dialect
 * substitution ("shije qokollad" → "shije cokollate", "shije chocolate", …).
 * `expandDialectVariants` is token-level and additive; one substitution at a time keeps the set
 * small and deterministic.
 */
function valueClaimVariants(folded: string): string[] {
  const tokens = folded.split(' ').filter(Boolean);
  const variants = new Set<string>([folded]);
  tokens.forEach((token, i) => {
    for (const alt of expandDialectVariants([token])) {
      if (alt === token) continue;
      const substituted = [...tokens];
      substituted[i] = alt;
      variants.add(substituted.join(' '));
    }
  });
  return [...variants];
}

export function evaluateValueClaimMembership(
  claim: AttributeClaim,
  evidence: AttributeEvidence,
  scope: AttributeScope,
): AttributeSupport {
  if (claim.kind !== 'value' || !claim.membershipEligible) return 'silent';

  const variants = valueClaimVariants(claim.folded);
  for (const clause of [...evidence.clauses, ...(evidence.supportOnlyClauses ?? [])]) {
    for (const variant of variants) {
      if (variant && containsPhrase(clause, variant)) return 'supported';
    }
  }

  if (scope !== 'product' || evidence.truncated) return 'silent';
  return 'absent';
}

/**
 * Fold a set of located claims into the flagged/observed lists.
 *
 * Claims route by kind: `exclusion` claims through the contradiction-only predicate,
 * `value` claims through the membership predicate. `contradicted` and `absent` are the two
 * flaggable outcomes.
 *
 * `flagged` drives customer-visible action and is empty at every mode except `enforce`.
 * `observed` is every flaggable verdict the lane saw, at every mode except `off` — it is what the
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
    const support =
      item.claim.kind === 'value'
        ? evaluateValueClaimMembership(item.claim, item.evidence, item.scope)
        : evaluateAttributeClaim(item.claim, item.evidence, item.scope);
    if (support !== 'contradicted' && support !== 'absent') continue;
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
