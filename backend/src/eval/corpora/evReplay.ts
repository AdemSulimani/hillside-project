/**
 * P3-4 — the EV-replay corpus (RC-02).
 *
 * ALL THREE "HALLUCINATION" ALERTS IN THE DEV DATABASE WERE FALSE POSITIVES. That is the finding
 * this corpus pins, and it is worth stating plainly because it inverts the usual reading of an
 * alert: the guards meant to prevent hallucination were the single largest source of false
 * escalations, and every one of them fired on a factually CORRECT reply about an active, in-stock
 * catalog row (EV-013 cross-checked each against `products WHERE deleted_at IS NULL`).
 *
 * The mechanism (RC-02): the price guard, the name guard and the gap assessor all judged the reply
 * against `matchedProducts` — the ~10–25 rows retrieved for THIS turn — rather than against the
 * catalog. Retrieval is keyword-driven and volatile, so a follow-up with no product keywords
 * ("Cilen mkishe than ti me marr prej qitynve") retrieves an unrelated top-10, and the guard then
 * cannot "see" products the AI itself named two turns earlier.
 *
 * ⚠️ THE PRE-FIX/POST-FIX SWITCH HERE IS NOT A FLAG. Unlike RC-01 — where `decideGapEscalation`
 * carries both policies — the P0-2 fix changed WHICH REFERENCE SET IS INJECTED, not a branch inside
 * the pure gate. So the meta-test flips `GroundingGateDeps.getPriceSet` / `getNameIndex` between
 * `RETRIEVAL_WINDOW_*` (pre-fix) and `FULL_CATALOG_*` (post-fix). Anyone reading these suites
 * expecting "flag off = pre-fix" will misread them; that is why both sets are exported.
 *
 * OWNER: AI platform.
 * Pure data + one pure builder. No DB, network or OpenAI key.
 */
import { buildPriceSetFromCatalogRows } from '../../services/catalogGuardReferenceService';

/**
 * EV-013's active catalog rows, verbatim: every "suspected hallucinated" name resolved to an
 * active, in-stock product with a non-null embedding, and the "hallucinated" €18.00 is exactly the
 * price of Carbo one 1kg Limon / Carbo One 1kg Orange. Prices are strings, as pg returns numerics.
 */
export const FULL_CATALOG_ROWS: ReadonlyArray<{ price: string; discounted_price: string | null }> = [
  { price: '95.00', discounted_price: null }, // Mega mass 7kg Qokolad
  { price: '55.00', discounted_price: null }, // Mega mass 3kg Vanil
  { price: '52.00', discounted_price: null }, // Mass gainer 3kg Qokolad
  { price: '55.00', discounted_price: null }, // Mega mass 3kg Qokolad
  { price: '18.00', discounted_price: null }, // Carbo One 1kg Orange
  { price: '18.00', discounted_price: null }, // Carbo one 1kg Limon
];

/** The same rows' names, plus the unrelated retrieval window that EV-011 recorded as `catalogNames`. */
export const FULL_CATALOG_NAMES: readonly string[] = [
  'Mega mass 7kg Qokolad',
  'Mega mass 3kg Vanil',
  'Mass gainer 3kg Qokolad',
  'Mega mass 3kg Qokolad',
  'Carbo One 1kg Orange',
  'Carbo one 1kg Limon',
  // EV-011's unrelated top-10 — active catalog rows too, just not the ones the reply was about:
  'Melatonine 180tab',
  'Pure Creatine 100 capsul',
  'Pure Creatine 250gr pa shije',
  'Amino after-load 400gr Manto',
  'Amino Energy 30 Servime',
  'Arginine 100caps',
  'BCAA+Glutamine 180tab',
  'C4 Original 30 servime shije Bostani',
  'C4 Original 30servime shije Mjedre',
  'C4 Original 60servime Shije Bostani',
];

/**
 * THE PRE-FIX REFERENCE SET — what the guards actually compared against in the fcd0af7e turn.
 * EV-011 recorded it: an unrelated top-10 with no mass-gainer row in it. The two hallucinated_price
 * alerts are worse still — their `catalogPrices` was `[]` with `failureReason:"no_catalog_prices"`,
 * i.e. the filter had ZERO prices to compare against and stripped the reply anyway (fail-closed).
 */
export const RETRIEVAL_WINDOW_NAMES: readonly string[] = [
  'Melatonine 180tab',
  'Pure Creatine 100 capsul',
  'Pure Creatine 250gr pa shije',
  'Amino after-load 400gr Manto',
  'Amino Energy 30 Servime',
  'Arginine 100caps',
  'BCAA+Glutamine 180tab',
  'C4 Original 30 servime shije Bostani',
  'C4 Original 30servime shije Mjedre',
  'C4 Original 60servime Shije Bostani',
];

/**
 * Prices for that unrelated top-10 — the window-scoped reference set the pre-fix price guard
 * actually compared against.
 *
 * ⚠️ PROVENANCE, STATED PLAINLY: unlike everything else in this file these figures are NOT recorded
 * evidence. EV-011 captured the window's NAMES but not its prices. They are constructed to model
 * the mechanism, and the only property that matters — asserted in the suite — is that none of them
 * equals a price the reply correctly stated. They are never used as a claim about the real catalog.
 */
export const RETRIEVAL_WINDOW_ROWS: ReadonlyArray<{ price: string; discounted_price: string | null }> =
  [
    { price: '12.00', discounted_price: null }, // Melatonine 180tab (representative)
    { price: '19.00', discounted_price: null }, // Pure Creatine 100 capsul
    { price: '24.00', discounted_price: null }, // Amino Energy 30 Servime
    { price: '31.00', discounted_price: null }, // C4 Original 60servime
  ];

/**
 * The EMPTY window behind both `hallucinated_price` alerts (`product_ids = []`, and the alert's own
 * `failureReason: "no_catalog_prices"` — the filter held zero prices and stripped the reply anyway).
 *
 * Worth knowing when reading the suite: `filterHallucinatedPrices` now fails OPEN on an empty set
 * ("can't validate nothing"), so this specific fail-CLOSED path no longer exists in the pure gate.
 * That is a genuine P0-2 improvement, and the suite pins it rather than pretending the defect is
 * still reproducible there. The window-scoped defect above is the one that still needs guarding.
 */
export const EMPTY_RETRIEVAL_WINDOW_ROWS: ReadonlyArray<{
  price: string;
  discounted_price: string | null;
}> = [];

export const FULL_CATALOG_PRICE_SET = buildPriceSetFromCatalogRows([...FULL_CATALOG_ROWS]);
export const RETRIEVAL_WINDOW_PRICE_SET = buildPriceSetFromCatalogRows([...RETRIEVAL_WINDOW_ROWS]);
export const EMPTY_WINDOW_PRICE_SET = buildPriceSetFromCatalogRows([...EMPTY_RETRIEVAL_WINDOW_ROWS]);

export interface EvAlertCase {
  /** The `ai_alerts.id` prefix as recorded. */
  readonly alertId: string;
  readonly conversationId: string;
  readonly reason: 'hallucinated_price' | 'hallucinated_product_name';
  /** The reply the guard stripped, as recorded in `details.originalReplyPreview`. */
  readonly originalReply: string;
  /** `details.suspectedNames` — empty for the price alerts. */
  readonly suspectedNames: readonly string[];
  /** What the customer actually received instead. */
  readonly sentInstead: string;
  readonly source: string;
  /** Why this was a FALSE positive. */
  readonly rationale: string;
}

/**
 * The three alerts, from EV-011 / EV-015. Each asserts ZERO flags against the full catalog.
 *
 * PROVENANCE PRECISION: the alert ids, reasons, conversation ids, `suspectedNames` and the sent
 * fallback text are all verbatim. `originalReply` is verbatim for the two price alerts (their
 * previews are short enough to have been stored whole) but RECONSTRUCTED for `ef3393c1`, whose
 * `originalReplyPreview` was truncated mid-word at the 200-char cap ("…Mass gainer 3kg Qokolad ës").
 * The reconstruction completes the final clause and changes nothing that the assertions depend on —
 * both product names and every price are unchanged.
 */
export const EV_ALERT_CASES: readonly EvAlertCase[] = [
  {
    alertId: 'ef3393c1',
    conversationId: 'fcd0af7e',
    reason: 'hallucinated_product_name',
    originalReply:
      'Për shtim peshe, Mega Mass 3kg Qokolad është një zgjedhje e shkëlqyer, pasi ofron kalori të ' +
      'larta dhe është ideal për ata që kanë vështirësi në shtimin e peshës. Gjithashtu, Mass gainer ' +
      '3kg Qokolad është një opsion i mirë.',
    suspectedNames: ['Mega Mass 3kg Qokolad', 'Mass gainer 3kg Qokolad'],
    sentInstead: 'Së shpejti do t’ju kontaktojë një specialist me informacion të saktë për produktin.',
    source: 'EV-011 (alert ef3393c1) + EV-015 (conv fcd0af7e turn 6)',
    rationale:
      'Both names are active in-stock rows — and the AI itself had listed them in turn 2 of the same ' +
      'conversation. Turn 5 carried no product keywords, so retrieval returned an unrelated top-10 ' +
      'and the name guard no longer "saw" them.',
  },
  {
    alertId: 'e37cd2ce',
    conversationId: '3ea2ace9',
    reason: 'hallucinated_price',
    originalReply: 'Shijet: Limon, Portokall Çmimi: €18.00 për secilën.',
    suspectedNames: [],
    sentInstead: 'Së shpejti do t’ju kontaktojë një specialist me informacion të saktë për produktin.',
    source: 'EV-011 (alert e37cd2ce) + EV-013',
    rationale:
      '€18.00 is exactly the price of Carbo one 1kg Limon and Carbo One 1kg Orange. The alert recorded ' +
      'catalogPrices=[] with failureReason "no_catalog_prices" — the filter stripped a correct reply ' +
      'while holding zero prices to compare against.',
  },
  {
    alertId: '6e13dbe6',
    conversationId: 'cf2bf59a',
    reason: 'hallucinated_price',
    originalReply: 'Limon: €18.00 Portokall: €18.00',
    suspectedNames: [],
    sentInstead: 'Së shpejti do t’ju kontaktojë një specialist me informacion të saktë për produktin.',
    source: 'EV-011 (alert 6e13dbe6) + EV-015',
    rationale:
      'The same 4-message script as 3ea2ace9, ~17 minutes later, with the same correct €18.00 and the ' +
      'same empty comparison set. Identical input, identical wrong outcome — reproducibly wrong.',
  },
];

export interface TranscriptTurn {
  readonly turn: number;
  readonly sentBy: 'customer' | 'ai';
  readonly content: string;
}

/**
 * conv fcd0af7e in full (EV-015). The reconstructability target named by both P1-5 and P3-4:
 * "replay `fcd0af7e` and assert that from the ledger alone the assembled prompt, model/temperature,
 * retrieval scores, the classifier chain and the fail-closed flag are all recoverable."
 *
 * Read turn 2 against turn 6: the AI names two products, then three turns later the guard strips a
 * recommendation of THOSE SAME TWO products as fabricated.
 */
export const FCD0AF7E_TRANSCRIPT: readonly TranscriptTurn[] = [
  { turn: 1, sentBy: 'customer', content: 'a keni produkte te mira per shtim peshe' },
  {
    turn: 2,
    sentBy: 'ai',
    content:
      'Po, kemi disa produkte për shtim peshe. Disa nga opsionet përfshijnë: - Mass gainer 3kg ' +
      'Qokolad - Mega mass 3kg Qokolad',
  },
  { turn: 3, sentBy: 'customer', content: 'a keni tjera a veq qito' },
  {
    turn: 4,
    sentBy: 'ai',
    content:
      'Po, kemi edhe disa produkte të tjera për shtim peshe, si: - Critical Mass 6kg Keks - Pro Mass ' +
      '1kg Qokolad',
  },
  { turn: 5, sentBy: 'customer', content: 'Cilen mkishe than ti me marr prej qitynve' },
  {
    turn: 6,
    sentBy: 'ai',
    content: 'Së shpejti do t’ju kontaktojë një specialist me informacion të saktë për produktin.',
  },
];

/** A price that is genuinely absent from the catalog — the negative control for the price gate. */
export const FABRICATED_PRICE = '23.50';
/** A product name that is genuinely absent — the negative control for the name gate. */
export const FABRICATED_NAME = 'Ghost Whey Protein 2kg';
