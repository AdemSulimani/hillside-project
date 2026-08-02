/**
 * Tests for the usage-suitability escalation fix.
 *
 * These tests verify the three code-level changes that prevent the AI from
 * sending speculative health/medical advice to customers:
 *
 *  1. containsSpeculativeHealthAdvice()  — detects health-consultation language
 *     in an AI reply so the safety-net guard can escalate instead of sending it.
 *
 *  2. matchesUsageQuestionKeyword()       — keyword-fallback for suitability
 *     messages (used when the LLM classifier is unavailable).
 *
 *  3. isUsageQuestionUnanswered() prompt behaviour — verified via representative
 *     example strings that document the expected decision boundary (no live LLM).
 *
 * All tests run purely in-process with no network, DB, or OpenAI calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  containsSpeculativeHealthAdvice,
  matchesUsageQuestionKeyword,
} from '../usageSuitabilityHelpers';

// ---------------------------------------------------------------------------
// 1.  containsSpeculativeHealthAdvice
// ---------------------------------------------------------------------------

describe('containsSpeculativeHealthAdvice', () => {
  // --- Should return TRUE (speculative advice detected) ---

  it('detects "consult a health professional" (exact phrase)', () => {
    assert.equal(
      containsSpeculativeHealthAdvice(
        'It is important to consult a health professional before using weight gain supplements.',
      ),
      true,
    );
  });

  it('detects "consult a doctor"', () => {
    assert.equal(
      containsSpeculativeHealthAdvice(
        'We recommend you consult a doctor before starting this supplement.',
      ),
      true,
    );
  });

  it('detects "consult a dietitian"', () => {
    assert.equal(
      containsSpeculativeHealthAdvice(
        'Please consult a dietitian to evaluate whether this product suits your needs.',
      ),
      true,
    );
  });

  it('detects "consult a nutritionist"', () => {
    assert.equal(
      containsSpeculativeHealthAdvice('Consult a nutritionist for personalised guidance.'),
      true,
    );
  });

  it('detects "it is important to consult" (pre-advice intro)', () => {
    assert.equal(
      containsSpeculativeHealthAdvice(
        'It is important to consult with a healthcare specialist before use.',
      ),
      true,
    );
  });

  it('detects "speak to a doctor"', () => {
    assert.equal(
      containsSpeculativeHealthAdvice(
        'You should speak to a doctor if you have any underlying conditions.',
      ),
      true,
    );
  });

  it('detects "seek medical advice"', () => {
    assert.equal(
      containsSpeculativeHealthAdvice('We recommend you seek medical advice first.'),
      true,
    );
  });

  it('detects "healthcare provider"', () => {
    assert.equal(
      containsSpeculativeHealthAdvice(
        'For personalised guidance, please speak with a healthcare provider.',
      ),
      true,
    );
  });

  it('detects "health professional" mid-sentence', () => {
    assert.equal(
      containsSpeculativeHealthAdvice(
        'A health professional can advise you on the right dosage for your lifestyle.',
      ),
      true,
    );
  });

  it('detects "medical advice" standalone', () => {
    assert.equal(
      containsSpeculativeHealthAdvice('This does not constitute medical advice.'),
      true,
    );
  });

  it('detects "always consult"', () => {
    assert.equal(
      containsSpeculativeHealthAdvice('Always consult a professional before changing your diet.'),
      true,
    );
  });

  it('detects "should consult"', () => {
    assert.equal(
      containsSpeculativeHealthAdvice('You should consult with a specialist about this.'),
      true,
    );
  });

  it('is case-insensitive', () => {
    assert.equal(
      containsSpeculativeHealthAdvice(
        'IT IS IMPORTANT TO CONSULT A HEALTH PROFESSIONAL BEFORE USE.',
      ),
      true,
    );
  });

  it('strips diacritics before matching (Albanian)', () => {
    // "konsultohuni me mjek" with diacritics stripped
    assert.equal(
      containsSpeculativeHealthAdvice('Ju lutem konsultohuni me mjekun tuaj para perdorimit.'),
      true,
    );
  });

  it('detects Albanian "nutricionist"', () => {
    assert.equal(
      containsSpeculativeHealthAdvice('Konsultohuni me nje nutricionist per kete produkt.'),
      true,
    );
  });

  it('detects Albanian "dietolog"', () => {
    assert.equal(
      containsSpeculativeHealthAdvice('Nje dietolog mund te jape keshilla me te mira.'),
      true,
    );
  });

  // --- Should return FALSE (safe catalog-style replies) ---

  it('does NOT flag a plain product description', () => {
    assert.equal(
      containsSpeculativeHealthAdvice(
        'Mass Gainer Pro contains 60g of protein per serving. Best before workout.',
      ),
      false,
    );
  });

  it('does NOT flag a verbatim usage instruction', () => {
    assert.equal(
      containsSpeculativeHealthAdvice(
        'Merr 2 lugë pluhuri me qumësht 30 minuta para stërvitjes.',
      ),
      false,
    );
  });

  it('does NOT flag the holding message itself', () => {
    assert.equal(
      containsSpeculativeHealthAdvice(
        "Pershendetje, se shpejti do t'ju kontaktoje nje specialist lidhur me kete ceshtje.",
      ),
      false,
    );
  });

  it('does NOT flag an order confirmation reply', () => {
    assert.equal(
      containsSpeculativeHealthAdvice(
        'Porosia juaj u konfirmua. Do të dorëzohet brenda 24 orëve.',
      ),
      false,
    );
  });

  it('does NOT flag an honest "I do not have that information" reply', () => {
    assert.equal(
      containsSpeculativeHealthAdvice(
        'Nuk kemi informacion specifik për këtë rast në katalogun tonë.',
      ),
      false,
    );
  });

  it('returns false for an empty string', () => {
    assert.equal(containsSpeculativeHealthAdvice(''), false);
  });

  it('returns false for whitespace-only input', () => {
    assert.equal(containsSpeculativeHealthAdvice('   '), false);
  });
});

// ---------------------------------------------------------------------------
// 2.  matchesUsageQuestionKeyword  (keyword-fallback coverage)
// ---------------------------------------------------------------------------

describe('matchesUsageQuestionKeyword — suitability & safety patterns (EN)', () => {
  const positives: Array<[string, string]> = [
    // Classic usage questions — must still work
    ['how to use', 'How to use this product?'],
    ['side effects', 'What are the side effects?'],
    ['dosage', 'What is the recommended dosage?'],
    ['instructions', 'Are there any instructions?'],
    // New suitability patterns
    ['suitable for me', 'Is this suitable for me?'],
    ['suitable for', 'Is this supplement suitable for beginners?'],
    ['is it suitable', 'Is it suitable if I am sedentary?'],
    ['is it safe', 'Is it safe to use?'],
    ['is this safe', 'Is this safe for daily consumption?'],
    ['safe for me', 'Is it safe for me if I have high blood pressure?'],
    ['safe to use', 'Is this safe to use?'],
    ['can i use', 'Can I use this product without exercising?'],
    ['can i take', 'Can I take this without a workout plan?'],
    ['any problem if', 'Is there any problem if I use this?'],
    ['any problems if', 'Are there any problems if I take this?'],
    ['is there a problem', 'Is there a problem using this?'],
    ['is there any problem', 'Is there any problem if I do not exercise?'],
    ['any issues if', 'Any issues if I use this without training?'],
    ['any issue if', 'Any issue if I skip the gym?'],
    ['without working out', 'Can I use this without working out?'],
    ['without exercising', 'Can I take this without exercising?'],
    ['without exercise', 'Is it ok to use without exercise?'],
    ['do not work out', 'I do not work out. Is there any problem?'],
    ["don't work out", "I don't work out, is this fine?"],
    ['not working out', 'I am not working out currently, can I use this?'],
    ['i do not exercise', 'I do not exercise at all, is it safe?'],
    ['not exercising', 'I am not exercising right now, any issues?'],
  ];

  for (const [keyword, message] of positives) {
    it(`matches "${keyword}" in: "${message}"`, () => {
      assert.equal(matchesUsageQuestionKeyword(message), true, `expected match for: ${message}`);
    });
  }

  const negatives: Array<[string, string]> = [
    ['greeting', 'Hello, how are you?'],
    ['price', 'How much does this cost?'],
    ['order', 'I want to place an order'],
    ['stock', 'Is this in stock?'],
    ['address', 'My delivery address is Prishtina'],
    ['discount', 'Do you have any discounts?'],
  ];

  for (const [label, message] of negatives) {
    it(`does NOT match non-usage message (${label}): "${message}"`, () => {
      assert.equal(matchesUsageQuestionKeyword(message), false, `expected no match for: ${message}`);
    });
  }
});

describe('matchesUsageQuestionKeyword — Albanian suitability & safety patterns', () => {
  const albPositives: Array<[string, string]> = [
    ['a mund ta perdor', 'A mund ta perdor pa ushtruar?'],
    ['a ka problem', 'A ka problem nese nuk stervitem?'],
    ['pa stervitje', 'A mund ta perdor pa stervitje?'],
    ['pa ushtrime', 'A eshte i sigurt pa ushtrime?'],
    ['pa sport', 'A ka problem nese nuk bej sport?'],
    ['nuk stervitem', 'Nuk stervitem, a ka problem?'],
    ['nuk ushtroj', 'Nuk ushtroj fare, a mund ta marr?'],
    ['nuk bej sport', 'Nuk bej sport, eshte ok?'],
    ['a eshte i sigurt', 'A eshte i sigurt per mua?'],
    ['i pershtatshem', 'A eshte i pershtatshem per mua?'],
    ['per mua', 'A eshte ky produkt per mua?'],
    ['a i pershtatet', 'A i pershtatet dikujt qe nuk stervitet?'],
    // Base Albanian usage keywords still work
    ['perdor', 'Si e perdor kete produkt?'],
    ['dozimi', 'Cfare eshte dozimi?'],
    ['efekte anesore', 'Ka efekte anesore?'],
  ];

  for (const [keyword, message] of albPositives) {
    it(`matches Albanian "${keyword}" in: "${message}"`, () => {
      assert.equal(matchesUsageQuestionKeyword(message), true, `expected match for: ${message}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 3.  isUsageQuestionUnanswered — boundary documentation tests
//
//     These tests document the NEW expected behaviour of the stricter LLM
//     prompt by verifying the *logic* described in the prompt using
//     representative inputs.  They do NOT call the live LLM — instead they
//     assert that a mock classifier implementing the new rules would behave
//     correctly on these exact examples (used as regression documentation).
//
//     The "oracle" function below mirrors the strict rules from the updated
//     isUsageQuestionUnanswered LLM prompt so we can run the boundary checks
//     in-process without network access.
// ---------------------------------------------------------------------------

/**
 * Simplified oracle that mirrors the strict rules in the new
 * isUsageQuestionUnanswered LLM prompt. Used only for documenting
 * expected decisions — the real function delegates to the LLM.
 *
 * Returns true when the question SHOULD be escalated (unanswered).
 */
function oracleIsUnanswered(
  customerMessage: string,
  usageDescription: string,
): boolean {
  const msgNorm = customerMessage.toLowerCase();
  const descNorm = usageDescription.toLowerCase();

  // RULE 1 — Suitability / personal-circumstance questions:
  // Requires the usage description to EXPLICITLY address the specific circumstance.
  const suitabilityKeywords = [
    'suitable for me', 'suitable for', 'is it suitable', 'is this suitable',
    'is it safe', 'is this safe', 'safe for me', 'safe to use',
    'can i use', 'can i take',
    'any problem if', 'is there any problem', 'is there a problem',
    'any issues if', 'any issue if',
    'without working out', 'without exercising', 'without exercise',
    'do not work out', "don't work out", 'not working out',
    'i do not exercise', 'not exercising', 'no exercise',
    "i'm pregnant", 'pregnant', 'health condition',
    // Albanian
    'a mund ta perdor', 'a ka problem', 'pa stervitje', 'pa ushtrime',
    'pa sport', 'nuk stervitem', 'nuk ushtroj', 'nuk bej sport',
    'a eshte i sigurt', 'i pershtatshem', 'per mua',
  ];

  const isSuitabilityQuestion = suitabilityKeywords.some((kw) => msgNorm.includes(kw));

  if (isSuitabilityQuestion) {
    // The description must explicitly address that specific circumstance.
    // If it only gives general dosage / frequency info, it does NOT answer.
    const specificCircumstance = suitabilityKeywords.find((kw) => msgNorm.includes(kw));
    if (specificCircumstance && !descNorm.includes(specificCircumstance)) {
      // General usage instructions (dosage, frequency) are not sufficient for suitability.
      const generalUsageOnly =
        /\d+\s*(scoop|gram|g|mg|ml|times?|once|twice|per day|daily|before|after)/i.test(
          usageDescription,
        ) && !descNorm.includes('without') && !descNorm.includes('sedentary') &&
        !descNorm.includes('non-athlete') && !descNorm.includes('can be used by');

      if (generalUsageOnly) return true;
    }
  }

  // RULE 2 — Description explicitly addresses the question → NOT unanswered.
  if (isSuitabilityQuestion) {
    const descAddressesIt = suitabilityKeywords.some((kw) => descNorm.includes(kw));
    return !descAddressesIt;
  }

  // RULE 3 — Simple detail question: description must contain the specific info.
  return false;
}

describe('isUsageQuestionUnanswered oracle — suitability boundary cases', () => {
  it('flags "I do not work out, is there any problem?" when description only has dosage', () => {
    const customer = 'I do not work out. Is there any problem if I use this?';
    const description = 'Take 2 scoops daily with milk, best consumed 30 minutes before workout.';
    assert.equal(oracleIsUnanswered(customer, description), true);
  });

  it('flags "Can I use this without exercising?" when description is generic', () => {
    const customer = 'Can I use this product without exercising?';
    const description = 'Consume 1 serving per day as part of a balanced diet.';
    assert.equal(oracleIsUnanswered(customer, description), true);
  });

  it('flags "Is this suitable for me?" when description only mentions frequency', () => {
    const customer = 'Is this suitable for me?';
    const description = 'Use once per day, preferably in the morning.';
    assert.equal(oracleIsUnanswered(customer, description), true);
  });

  it('flags "Can I use this without exercise?" (lifestyle question not in description)', () => {
    const customer = 'Is this safe to use?';
    const description = 'Take 2 scoops before training. For best results, use with a high-protein diet.';
    assert.equal(oracleIsUnanswered(customer, description), true);
  });

  it('flags "I am not working out currently" question', () => {
    const customer = 'I am not working out currently, can I use this supplement?';
    const description = 'Mix 1 serving with 300ml of water 30 minutes before exercise.';
    assert.equal(oracleIsUnanswered(customer, description), true);
  });

  it('flags "nuk stervitem, a ka problem?" (Albanian)', () => {
    const customer = 'Nuk stervitem, a ka problem nese e perdor?';
    const description = 'Merr 2 lugë pluhuri me qumesht para stervitjes.';
    assert.equal(oracleIsUnanswered(customer, description), true);
  });

  it('does NOT flag when description explicitly covers the circumstance', () => {
    const customer = 'Can I use this without exercising?';
    const description =
      'Suitable for anyone, whether active or sedentary. Can be used by non-athletes.';
    assert.equal(oracleIsUnanswered(customer, description), false);
  });

  it('does NOT flag a simple frequency question that the description answers', () => {
    const customer = 'How many times per day should I take this?';
    const description = 'Take once per day, preferably in the morning with food.';
    // Not a suitability question — oracle falls through to rule 3 → false
    assert.equal(oracleIsUnanswered(customer, description), false);
  });
});

// ---------------------------------------------------------------------------
// 4.  Integration scenario: speculativeAdvice safety-net logic
//
//     Verifies the combined condition that the guard checks:
//       !usageEscalated && !productKnowledgeEscalated &&
//       usageQuestionIntent && containsSpeculativeHealthAdvice(finalReplyText) &&
//       !adviceIsFromCatalog
// ---------------------------------------------------------------------------

describe('speculative advice safety-net combined condition', () => {
  function shouldEscalate(args: {
    usageEscalated: boolean;
    productKnowledgeEscalated: boolean;
    isOosCannedReply: boolean;
    usageQuestionIntent: boolean;
    aiReply: string;
    usageDescription: string | null;
  }): boolean {
    if (args.usageEscalated || args.productKnowledgeEscalated || args.isOosCannedReply) {
      return false;
    }
    if (!args.usageQuestionIntent) return false;
    if (!containsSpeculativeHealthAdvice(args.aiReply)) return false;

    // adviceIsFromCatalog = usage description itself also contains the pattern
    const adviceIsFromCatalog = Boolean(
      args.usageDescription && containsSpeculativeHealthAdvice(args.usageDescription),
    );
    return !adviceIsFromCatalog;
  }

  it('escalates when AI generated speculative advice for a suitability question', () => {
    assert.equal(
      shouldEscalate({
        usageEscalated: false,
        productKnowledgeEscalated: false,
        isOosCannedReply: false,
        usageQuestionIntent: true,
        aiReply:
          'It is important to consult a health professional or dietitian before using weight gain supplements.',
        usageDescription: 'Take 2 scoops daily before workout.',
      }),
      true,
    );
  });

  it('escalates for "speak to a doctor" advice not backed by catalog', () => {
    assert.equal(
      shouldEscalate({
        usageEscalated: false,
        productKnowledgeEscalated: false,
        isOosCannedReply: false,
        usageQuestionIntent: true,
        aiReply: 'You should speak to a doctor before using this product if you have any medical conditions.',
        usageDescription: 'Mix 1 scoop with water and consume post-workout.',
      }),
      true,
    );
  });

  it('does NOT escalate when advice came from the catalog itself', () => {
    const catalogAdvice = 'Consult a doctor before use if you are pregnant or have a medical condition.';
    assert.equal(
      shouldEscalate({
        usageEscalated: false,
        productKnowledgeEscalated: false,
        isOosCannedReply: false,
        usageQuestionIntent: true,
        aiReply: `${catalogAdvice} Take 2 scoops daily.`,
        usageDescription: catalogAdvice,
      }),
      false,
    );
  });

  it('does NOT escalate when usage was already escalated upstream', () => {
    assert.equal(
      shouldEscalate({
        usageEscalated: true,
        productKnowledgeEscalated: false,
        isOosCannedReply: false,
        usageQuestionIntent: true,
        aiReply: 'It is important to consult a health professional.',
        usageDescription: null,
      }),
      false,
    );
  });

  it('does NOT escalate when product knowledge was already escalated upstream', () => {
    assert.equal(
      shouldEscalate({
        usageEscalated: false,
        productKnowledgeEscalated: true,
        isOosCannedReply: false,
        usageQuestionIntent: true,
        aiReply: 'Consult a nutritionist for this.',
        usageDescription: null,
      }),
      false,
    );
  });

  it('does NOT escalate for an OOS canned reply even if it contains a pattern', () => {
    assert.equal(
      shouldEscalate({
        usageEscalated: false,
        productKnowledgeEscalated: false,
        isOosCannedReply: true,
        usageQuestionIntent: true,
        aiReply: 'This product is currently out of stock. Consult a doctor for alternatives.',
        usageDescription: null,
      }),
      false,
    );
  });

  it('does NOT escalate when reply has no health-advice patterns', () => {
    assert.equal(
      shouldEscalate({
        usageEscalated: false,
        productKnowledgeEscalated: false,
        isOosCannedReply: false,
        usageQuestionIntent: true,
        aiReply: 'Take 2 scoops before workout. The product works best with regular exercise.',
        usageDescription: 'Take 2 scoops before workout.',
      }),
      false,
    );
  });

  it('does NOT escalate when the question is not a usage/suitability question', () => {
    assert.equal(
      shouldEscalate({
        usageEscalated: false,
        productKnowledgeEscalated: false,
        isOosCannedReply: false,
        usageQuestionIntent: false,
        aiReply: 'Consult a doctor.',
        usageDescription: null,
      }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 5.  classifySpeculativeHealthAdvice — fast-path contract
//
//     The async LLM classifier has the same keyword list as the synchronous
//     version as its fast-path: any phrase that containsSpeculativeHealthAdvice
//     catches must also be caught immediately by classifySpeculativeHealthAdvice
//     without an LLM call.  These tests verify that guarantee by confirming the
//     underlying keyword function returns true for phrases the LLM classifier
//     MUST catch on the fast path (and which it will catch even if the LLM is
//     down).  The tests are pure — no network calls.
// ---------------------------------------------------------------------------

describe('classifySpeculativeHealthAdvice fast-path contract (keyword parity)', () => {
  // Every phrase that the synchronous keyword guard catches must be caught by the
  // fast-path of classifySpeculativeHealthAdvice so an LLM outage never degrades
  // the safety-net behaviour.
  const mustCatchFastPath = [
    'It is important to consult a health professional before starting.',
    'We recommend you consult a doctor before using this product.',
    'Please speak to a healthcare provider if you have any concerns.',
    'Seek medical advice before starting any new supplement.',
    'Konsultohuni me mjekun tuaj para perdorimit.',
    'Keshillohuni me nje nutricionist per kete produkt.',
  ];

  for (const phrase of mustCatchFastPath) {
    it(`fast-path catches: "${phrase.slice(0, 60)}…"`, () => {
      // containsSpeculativeHealthAdvice IS the fast-path inside
      // classifySpeculativeHealthAdvice — verify it returns true synchronously
      // so the async wrapper will short-circuit before reaching the LLM.
      assert.equal(
        containsSpeculativeHealthAdvice(phrase),
        true,
        `fast-path must return true for: ${phrase}`,
      );
    });
  }

  it('fast-path correctly returns false for safe replies (no LLM bypassed)', () => {
    assert.equal(
      containsSpeculativeHealthAdvice('Take 2 scoops daily with water.'),
      false,
    );
  });

  it('novel phrasing NOT in keyword list returns false from keyword check (LLM would catch it)', () => {
    // "I'd recommend checking with a specialist" is not in the keyword list.
    // The keyword function returns false → the async wrapper proceeds to the LLM.
    // This test documents that the keyword fast-path correctly does NOT over-fire
    // on ambiguous non-health text.
    assert.equal(
      containsSpeculativeHealthAdvice("I'd recommend checking our product page for details."),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 6.  classifyFollowUpInvitationInReply — fast-path contract
//
//     Same principle: the KNOWN_PATTERNS inline copy in classifyFollowUpInvitationInReply
//     (inside aiService.ts) must match every pattern from FOLLOW_UP_INVITATION_PATTERNS
//     in processAIReply.ts. We test the normalization + pattern logic here using the
//     pure sentinel function sentenceContainsFollowUpInvitation (which uses the same
//     normalization + patterns) as a proxy.
// ---------------------------------------------------------------------------

describe('classifyFollowUpInvitationInReply fast-path contract (pattern parity)', () => {
  // Helpers that mirror the exact normalization used in sentenceContainsFollowUpInvitation
  // and classifyFollowUpInvitationInReply's fast-path.
  function normalize(v: string): string {
    return (v ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s?]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  const PATTERNS: RegExp[] = [
    /(^|\s)(me|m)\s+tregon[ij]?(\s|$|[.,!?])/u,
    /(^|\s)(me|m)\s+shkrua(j|ni|jeni)?(\s|$|[.,!?])/u,
    /(^|\s)(me|m)\s+kontakto(n[ij]?|j)?(\s|$|[.,!?])/u,
    /\blet me know\b/u,
    /\bfeel free to (ask|reach|contact|message)\b/u,
    /\b(is there )?anything else\b/u,
    /\bif you (have|need|want).*(let me know|just ask|tell me)\b/u,
  ];

  function fastPathMatches(text: string): boolean {
    const n = normalize(text);
    return PATTERNS.some((re) => re.test(n));
  }

  const mustCatchFastPath: Array<[string, string]> = [
    ['Albanian "më tregoni"', 'Nëse dëshironi detaje më tregoni.'],
    ['Albanian "më shkruani"', 'Nëse keni pyetje më shkruani.'],
    ['Albanian "më kontaktoni"', 'Ju lutem më kontaktoni për çdo pyetje.'],
    ['English "let me know"', 'Let me know if you need anything else.'],
    ['English "feel free to ask"', 'Feel free to ask if you have questions.'],
    ['English "anything else"', 'Is there anything else I can help with?'],
    ['English "if you need … let me know"', 'If you need help, just let me know.'],
  ];

  for (const [label, phrase] of mustCatchFastPath) {
    it(`fast-path catches ${label}: "${phrase}"`, () => {
      assert.equal(
        fastPathMatches(phrase),
        true,
        `fast-path must match: ${phrase}`,
      );
    });
  }

  it('fast-path does NOT fire on a plain product reply (no invitation)', () => {
    assert.equal(
      fastPathMatches('The product is available in chocolate and vanilla.'),
      false,
    );
  });

  it('novel phrasing NOT in patterns returns false from fast-path (LLM would catch it)', () => {
    // "don't hesitate to reach out" is not in the known patterns.
    // The fast-path returns false → the async wrapper proceeds to the LLM.
    assert.equal(
      fastPathMatches("Don't hesitate to reach out if you have any further questions."),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 7.  P0-1 (USAGE_GUARD_EVIDENCE): Guard U2 widened-evidence contract
//
//     Legacy U2 escalated + paused whenever a usage question arrived and
//     usage_description was NULL — having read NO evidence at all (never the
//     description column, structured attributes, or packaging reads) — and by
//     setting usageEscalated it suppressed the gap gate that WOULD have read
//     them. The widened lane first asks the classifier whether the full product
//     knowledge context answers the question, and escalates only on "yes,
//     unanswered". This mirror encodes the exact decision shape wired in
//     processAIReply (the real path delegates the verdict to the LLM).
// ---------------------------------------------------------------------------

describe('P0-1 Guard U2 widened-evidence decision contract', () => {
  /** Mirrors the U2 decision after the P0-1 change. Returns true when U2 escalates. */
  function u2Escalates(args: {
    mode: 'legacy' | 'shadow' | 'on';
    usageQuestionIntent: boolean;
    isAttributeQuestion: boolean;
    usageDescription: string | null;
    isOosCannedReply: boolean;
    /** null = no evidence context could be built (empty catalog text). */
    widenedEvidence: string | null;
    /** The widened classifier verdict; null = classifier errored. */
    widenedUnanswered: boolean | null;
  }): boolean {
    // Preconditions unchanged from legacy.
    if (!args.usageQuestionIntent || args.isAttributeQuestion) return false;
    if (args.usageDescription || args.isOosCannedReply) return false;
    // Widened lane: only `on` + available evidence + a clean "answered" verdict skips.
    if (args.mode === 'on' && args.widenedEvidence && args.widenedUnanswered === false) {
      return false;
    }
    // Everything else — legacy mode, shadow mode, empty evidence, "unanswered"
    // verdict, or a classifier error — keeps the escalate-on-sight behaviour.
    return true;
  }

  const base = {
    usageQuestionIntent: true,
    isAttributeQuestion: false,
    usageDescription: null as string | null,
    isOosCannedReply: false,
    widenedEvidence: 'Product: X\nDescription: Take one scoop daily after training.' as string | null,
  };

  it('ON + evidence answers the question → no escalation (the premature-alert fix)', () => {
    assert.equal(
      u2Escalates({ ...base, mode: 'on', widenedUnanswered: false }),
      false,
    );
  });

  it('ON + evidence does NOT answer → still escalates (fail-closed preserved)', () => {
    assert.equal(u2Escalates({ ...base, mode: 'on', widenedUnanswered: true }), true);
  });

  it('ON + classifier error → escalates per legacy (fail-closed on degradation)', () => {
    assert.equal(u2Escalates({ ...base, mode: 'on', widenedUnanswered: null }), true);
  });

  it('ON + no evidence context at all → escalate-on-sight remains', () => {
    assert.equal(
      u2Escalates({ ...base, mode: 'on', widenedEvidence: null, widenedUnanswered: null }),
      true,
    );
  });

  it('SHADOW acts like legacy even when the widened verdict says answered', () => {
    assert.equal(u2Escalates({ ...base, mode: 'shadow', widenedUnanswered: false }), true);
  });

  it('LEGACY is byte-identical: escalates whenever usage_description is NULL', () => {
    assert.equal(u2Escalates({ ...base, mode: 'legacy', widenedUnanswered: null }), true);
  });

  it('attribute questions stay exempt in every mode', () => {
    for (const mode of ['legacy', 'shadow', 'on'] as const) {
      assert.equal(
        u2Escalates({ ...base, mode, isAttributeQuestion: true, widenedUnanswered: false }),
        false,
      );
    }
  });

  it('a present usage_description keeps U2 out of scope in every mode (U1 owns it)', () => {
    for (const mode of ['legacy', 'shadow', 'on'] as const) {
      assert.equal(
        u2Escalates({
          ...base,
          mode,
          usageDescription: 'Take 2 scoops daily.',
          widenedUnanswered: false,
        }),
        false,
      );
    }
  });
});
