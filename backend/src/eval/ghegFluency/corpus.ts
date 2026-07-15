/**
 * P2-5 (RC-15 fluency portion, RC-25): the Kosovo/Gheg evaluation corpus.
 *
 * WHY THIS EXISTS. Before P2-5 the repo had no eval corpus of any kind — no golden file, no
 * fixture, no checked-in message list. The audit's own Albanian score (54/100) and its EV-030
 * traffic profile lived only as markdown tables in docs/audit, so every Albanian regression was
 * anecdotal rather than measurable. This file makes dialect capability a test.
 *
 * THE SPLIT — deliberately along the line RC-25 itself draws:
 *
 *     "Dialect classification is a discrete label — checkable without a judge;
 *      reserve LLM-as-judge for fluency of the generated Albanian reply."
 *
 *   - THIS FILE holds discrete, deterministic expectations (locale, routing labels). No LLM, no
 *     network, no DB — so `ghegCorpus.test.ts` runs in `npm test` on every CI push and every
 *     added Gheg form is regression-locked from that moment.
 *   - `judge.ts` holds the LLM-judge fluency scorer, which is a manual script and NOT CI: it
 *     costs money per run and its verdicts are stochastic. There is no nightly workflow in this
 *     repo (only ci.yml and deploy.yml), so wiring it to a schedule would be inventing scaffold
 *     the remediation plan assumed already existed.
 *
 * ARCHITECTURAL RULE. Nothing under `src/eval/**` may ever be imported by the send path.
 * `evalIsolation.test.ts` enforces it by walking the import graph — an offline evaluator that
 * leaks into `processAIReply` becomes an unbudgeted per-message LLM call on the customer's turn.
 *
 * SOURCE. The 17 utterances are EV-030 verbatim (appendix-A-evidence-log.md, 2026-07-12): the 40
 * most recent real customer messages in the dev DB, of which 39/40 were Albanian, 0 English, and
 * — the fact that shapes every design decision here — 0 of 40 carried Albanian diacritics.
 * Expectations are derived from what each message MEANS, not from what the code currently does;
 * a case marked `expectOtherOptions: true` that fails is a coverage gap to curate, which is
 * exactly what this corpus is for.
 */

/** A single labelled utterance. Labels are discrete and checkable without a judge. */
export interface GhegCorpusCase {
  /** The message as the customer actually typed it. */
  readonly text: string;
  /** English gloss, for the reader. */
  readonly gloss: string;
  /** The reply language a correct system resolves. */
  readonly expectLocale: 'sq' | 'en';
  /** Asking for MORE/OTHER products than already shown (inventory browsing, not a fact request). */
  readonly expectOtherOptions?: boolean;
  /** Asking which attribute values exist across a product group. */
  readonly expectAttributeFollowUp?: boolean;
  /** Asking for a recommendation or a comparison between products. */
  readonly expectRecommendation?: boolean;
  /** Reporting a post-purchase problem (delivery/wrong item/defect). */
  readonly expectPostPurchase?: boolean;
  /** Provenance. */
  readonly source: string;
}

export const GHEG_CORPUS: readonly GhegCorpusCase[] = [
  {
    text: 'A munesh me ma qu foto be',
    gloss: 'Can you send me a photo, mate?',
    expectLocale: 'sq',
    source: 'EV-030 (conv d1d12b10)',
  },
  {
    text: 'pershendetje a keni nitro tech ripped',
    gloss: 'Hello, do you have Nitro Tech Ripped?',
    expectLocale: 'sq',
    source: 'EV-030 (conv d1d12b10)',
  },
  {
    text: 'Sa kushton kjo shef',
    gloss: 'How much does this cost, boss?',
    expectLocale: 'sq',
    source: 'EV-030 (conv 1e71b190)',
  },
  {
    text: 'Aha okej a muni me ma qu foto be se ju ka tek djalit tem me porosit ni qisi e spe di a osht e qasi qe pe don',
    gloss: "Ok, can you send a photo — my son ordered one like this and I don't know if it's the one you want",
    expectLocale: 'sq',
    source: 'EV-030 (conv 1e71b190)',
  },
  {
    text: 'O shef qa bone',
    gloss: 'Hey boss, how are you doing?',
    expectLocale: 'sq',
    source: 'EV-030 (conv 1e71b190)',
  },
  {
    text: 'Qysh o moti sot',
    gloss: "How's the weather today?",
    expectLocale: 'sq',
    source: 'EV-030 (conv 1d001d46)',
  },
  {
    text: 'Okej qita pe porositi pra shef',
    gloss: "Ok, I'm ordering this one then, boss",
    expectLocale: 'sq',
    source: 'EV-030 (conv 1d001d46)',
  },
  {
    text: 'Cila o ma e lira be se le qe jom cpirr po edhe fikan hahahahahah',
    gloss: "Which is the cheapest? I'm broke",
    expectLocale: 'sq',
    expectRecommendation: true,
    source: 'EV-030 (conv 1d001d46)',
  },
  {
    text: 'Hej a keni naj produkt tmir per shtim peshe se hiq sun po shtoj killa o shef qr',
    gloss: "Do you have a good weight-gain product? I can't put on any kilos",
    expectLocale: 'sq',
    source: 'EV-030 (conv 1d001d46)',
  },
  {
    text: 'Aha okej a muna shef me porosit qita me shije mjedre',
    gloss: 'Ok, can I order this one in raspberry flavour?',
    expectLocale: 'sq',
    source: 'EV-030 (conv 1d001d46)',
  },
  {
    text: 'A keni naj kreatin',
    gloss: 'Do you have any creatine?',
    expectLocale: 'sq',
    source: 'EV-030 (conv 1d001d46)',
  },
  {
    text: 'Me qfar shije i keni edhe sa kushtojn',
    gloss: 'What flavours do you have them in, and how much do they cost?',
    expectLocale: 'sq',
    expectAttributeFollowUp: true,
    source: 'EV-030 (convs 28bec994, cf2bf59a, 92cd366e, 3ea2ace9)',
  },
  {
    text: 'Pershendetje a keni carbo one',
    gloss: 'Hello, do you have Carbo One?',
    expectLocale: 'sq',
    source: 'EV-030 (convs 5086ed7d, cebf6a66)',
  },
  {
    text: 'Pershendefje a keni carbo one',
    gloss: 'Hello [typo], do you have Carbo One?',
    expectLocale: 'sq',
    source: 'EV-030 (typo variant — real, sent twice)',
  },
  {
    text: 'Pershendetje a keni whey protein edhe me qfar shije',
    gloss: 'Hello, do you have whey protein and in what flavours?',
    expectLocale: 'sq',
    expectAttributeFollowUp: true,
    source: 'EV-030 (conv 98571d00)',
  },
  {
    text: 'Qfar shije i kan edhe sa kushtojn',
    gloss: 'What flavours do they have and how much do they cost?',
    expectLocale: 'sq',
    expectAttributeFollowUp: true,
    source: 'EV-030 (conv 6a120665)',
  },
  {
    text: 'Cilen mkishe than ti me marr prej qitynve',
    gloss: 'Which of these would you tell me to take?',
    expectLocale: 'sq',
    expectRecommendation: true,
    source: 'EV-011/EV-015 (conv fcd0af7e — the name-guard false positive)',
  },
];

/**
 * EV-010 (alert d3db5dac, 2026-06-23) — P2-5's headline regression, kept separate because it is
 * the single case the whole Gheg-lexicon workstream exists to fix.
 *
 * The customer asked an inventory-browsing question ("do you have more, or only these?"). It
 * slipped every deterministic net — 'ma shum' missed the `me shum[eë]` pattern, 'aito'/'Qito'
 * missed the deictic list — so it entered the fail-closed product-information-gap path and the
 * English-prompted assessor returned `missing_info: ["ma shum"]`: the word "more", filed to a
 * human specialist as an unavailable catalog attribute.
 */
export const EV_010_CASE: GhegCorpusCase = {
  text: 'A keni ma shum a veq aito\nQito',
  gloss: 'Do you have more, or only these? / These',
  expectLocale: 'sq',
  expectOtherOptions: true,
  source: 'EV-010 (alert d3db5dac) — missing_info:["ma shum"]',
};

/** The full corpus including the EV-010 regression. */
export const GHEG_CORPUS_WITH_EV_010: readonly GhegCorpusCase[] = [...GHEG_CORPUS, EV_010_CASE];
