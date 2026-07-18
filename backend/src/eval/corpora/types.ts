/**
 * P3-4 — shared shape for every eval corpus.
 *
 * OWNER: AI platform. Corpus curation is a standing surface, not a one-off — the remediation plan
 * says so explicitly for the Gheg set ("an ongoing surface — assign an owner"), and the same is true
 * of every corpus here. When a new failure class reaches production, it becomes a case in one of
 * these files; that is the whole maintenance contract.
 *
 * THE PROVENANCE RULE. Every case carries `source` naming the audit evidence it came from (EV-nnn,
 * an IN-n live-replay input, or a conversation id). `corpusProvenance.test.ts` asserts the citation
 * exists and matches an evidence pattern. This is not bureaucracy: a regression corpus whose cases
 * have no provenance rots into anonymous magic strings that nobody dares change, and then into a
 * suite people delete. The convention is inherited from `eval/ghegFluency/corpus.ts` (P2-5).
 *
 * Leaf module — types and one type-only import. Nothing here reaches `openaiClient`.
 */
import type { StructuredAttributeKey } from '../../services/productRetrievalService';
import type { StructuredAttributeMap } from '../../services/productInformationGapHelpers';

/** The discrete outcome label a case asserts. Discrete on purpose — RC-01/RC-25 both say so:
 *  "the decision is a discrete escalate/answer label, checkable exactly" — no LLM judge. */
export type ExpectedOutcome = 'answer' | 'escalate';

export interface EvalCase {
  /** Stable id, quoted in every failure message. Never renumber — failures are grepped. */
  readonly id: string;
  /** The customer message, exactly as typed (typos and missing diacritics included). */
  readonly text: string;
  /** English gloss, so the corpus stays readable to a non-Albanian speaker. */
  readonly gloss: string;
  readonly locale: 'sq' | 'en';
  readonly dialect: 'standard' | 'gheg' | 'english';
  /** Provenance — REQUIRED. Must cite an EV-nnn, IN-n, or conversation id. */
  readonly source: string;
}

/**
 * A gap-gate case: the customer question plus the catalog state that answers it.
 *
 * `products` is the STRUCTURED attribute view of the rows the retrieval returned — the same shape
 * `computeMissingStructuredAttributes` consumes. Note that in IN1 every row's `brand` is null, and
 * the customer never asked about brand: that combination is the exact RC-01 trap, where the English
 * assessor reported `missing:['marka']` for an attribute nobody requested.
 */
export interface GapGateCase extends EvalCase {
  /** The structured attributes the customer actually asked about. Often empty (plain availability). */
  readonly requested: readonly StructuredAttributeKey[];
  /** The matched catalog rows' structured attributes. */
  readonly products: readonly StructuredAttributeMap[];
  /** Attribute keys confidently read from product packaging images. */
  readonly imageUsableKeys?: readonly string[];
  /** The label under test. */
  readonly expect: ExpectedOutcome;
  /** Why this outcome is correct — the reviewer's shortcut. */
  readonly rationale: string;
}
