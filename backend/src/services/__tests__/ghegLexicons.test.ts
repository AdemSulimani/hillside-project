/**
 * Tests for the curated Kosovo/Gheg routing lexicons (P2-5, RC-25/RC-10).
 *
 * The headline regression is EV-010 (alert d3db5dac, 2026-06-23): the Gheg message
 * "A keni ma shum a veq aito / Qito" ("do you have more, or only these?") slipped every
 * deterministic net — 'ma shum' missed `me shum[eë]`, 'aito'/'Qito' missed the deictic list —
 * so an inventory-browsing question entered the fail-closed product-information-gap path and
 * the English-prompted assessor returned `missing_info: ["ma shum"]`: the word "more" filed to
 * a specialist as an unavailable catalog attribute. It is pinned here permanently.
 *
 * All pure/in-process — no network/DB/OpenAI. The module-scope flag cannot be toggled from a
 * test, so the flag-on composition is exercised by passing `enabled`/`patterns` explicitly;
 * that is the same composition the call sites use.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGLISH_CONTROL_MESSAGES,
  GHEG_ALBANIAN_MARKERS,
  GHEG_ATTRIBUTE_FOLLOW_UP_EXTRA_PATTERNS,
  GHEG_ORDER_CONSENT_EXTRA_PATTERNS,
  GHEG_OTHER_OPTIONS_EXTRA_PATTERNS,
  GHEG_POST_PURCHASE_EXTRA_PATTERNS,
  GHEG_RECOMMENDATION_EXTRA_PATTERNS,
  withGhegMarkers,
  withGhegPatterns,
} from '../ghegLexicons';
import {
  OTHER_OPTIONS_FOLLOW_UP_PATTERNS,
  isOtherOptionsFollowUp,
} from '../productRetrievalService';
import { detectOrderConsentLexical } from '../orderStageMachine';

/** The flag-on list, composed exactly as productRetrievalService composes it. */
const GHEG_ON_OTHER_OPTIONS = withGhegPatterns(
  OTHER_OPTIONS_FOLLOW_UP_PATTERNS,
  GHEG_OTHER_OPTIONS_EXTRA_PATTERNS,
  true,
);

/** EV-010's message, verbatim from the alert payload — two lines, as the customer sent it. */
const EV_010_MESSAGE = 'A keni ma shum a veq aito\nQito';

describe('withGhegPatterns / withGhegMarkers — additive composition', () => {
  it('flag-off returns the SAME base array reference (byte-identical by construction)', () => {
    const base = [/a/];
    const extra = [/b/];
    assert.equal(withGhegPatterns(base, extra, false), base);
  });

  it('flag-on appends the extras after the base, preserving base order', () => {
    const base = [/a/];
    const extra = [/b/];
    assert.deepEqual(withGhegPatterns(base, extra, true), [/a/, /b/]);
  });

  it('flag-off markers equal the base list', () => {
    assert.deepEqual(withGhegMarkers(['x'], ['y'], false), ['x']);
  });

  it('flag-on markers append the extras', () => {
    assert.deepEqual(withGhegMarkers(['x'], ['y'], true), ['x', 'y']);
  });
});

describe('EV-010 regression — "A keni ma shum a veq aito / Qito"', () => {
  it('is NOT matched by the legacy lexicon (this is the bug being fixed)', () => {
    assert.equal(isOtherOptionsFollowUp(EV_010_MESSAGE, OTHER_OPTIONS_FOLLOW_UP_PATTERNS), false);
  });

  it('IS routed as an other-options browsing question with the Gheg lexicon', () => {
    assert.equal(isOtherOptionsFollowUp(EV_010_MESSAGE, GHEG_ON_OTHER_OPTIONS), true);
  });

  it('matches on the "ma shum" arm alone', () => {
    assert.equal(isOtherOptionsFollowUp('A keni ma shum', GHEG_ON_OTHER_OPTIONS), true);
  });

  it('matches on the "veq aito" deictic arm alone', () => {
    assert.equal(isOtherOptionsFollowUp('veq aito', GHEG_ON_OTHER_OPTIONS), true);
  });

  it('matches the bare deictic second line "Qito" alone', () => {
    assert.equal(isOtherOptionsFollowUp('Qito', GHEG_ON_OTHER_OPTIONS), true);
  });
});

describe('isOtherOptionsFollowUp — Gheg coverage', () => {
  for (const deictic of ['qito', 'qeto', 'qeta', 'aito', 'kto']) {
    it(`matches "veq ${deictic}"`, () => {
      assert.equal(isOtherOptionsFollowUp(`a keni veq ${deictic}`, GHEG_ON_OTHER_OPTIONS), true);
    });
  }

  it('matches Gheg "ma shum" and Tosk "me shume" alike', () => {
    assert.equal(isOtherOptionsFollowUp('a keni ma shum', GHEG_ON_OTHER_OPTIONS), true);
    assert.equal(isOtherOptionsFollowUp('a keni me shume', GHEG_ON_OTHER_OPTIONS), true);
  });

  it('matches the clitic form "a e keni edhe qito"', () => {
    assert.equal(isOtherOptionsFollowUp('a e keni edhe qito', GHEG_ON_OTHER_OPTIONS), true);
  });

  it('matches Gheg "naj tjeter"', () => {
    assert.equal(isOtherOptionsFollowUp('a keni naj tjeter', GHEG_ON_OTHER_OPTIONS), true);
  });

  it('does not fire on a bare "ma" inside a product name (the substring trap)', () => {
    assert.equal(isOtherOptionsFollowUp('a keni serious mass', GHEG_ON_OTHER_OPTIONS), false);
    assert.equal(isOtherOptionsFollowUp('sa kushton mass gainer', GHEG_ON_OTHER_OPTIONS), false);
  });

  it('does not fire on an ordinary product question', () => {
    assert.equal(isOtherOptionsFollowUp('pershendetje a keni carbo one', GHEG_ON_OTHER_OPTIONS), false);
  });

  it('keeps every phrase the legacy lexicon already matched (additive, never subtractive)', () => {
    // The existing productRetrieval.test.ts pins these; assert the Gheg list cannot regress them.
    for (const phrase of [
      'a keni tjera a veq qita',
      'a keni tjera',
      'keni tjera',
      'a keni tjetra',
      'ndonje tjeter',
      'ndonjë tjetër',
      'what else',
    ]) {
      assert.equal(isOtherOptionsFollowUp(phrase, OTHER_OPTIONS_FOLLOW_UP_PATTERNS), true, `legacy: ${phrase}`);
      assert.equal(isOtherOptionsFollowUp(phrase, GHEG_ON_OTHER_OPTIONS), true, `gheg: ${phrase}`);
    }
  });
});

describe('dead-alternate guard', () => {
  // Every consumer NFD-strips before testing, so a ë/ç in a pattern is unreachable. The legacy
  // lists are full of such dead alternates (`çfarë`, `ket[eë]`, `vet[eë]m`); this pins the
  // property for everything P2-5 adds, so the class cannot be reintroduced.
  const LISTS: Record<string, RegExp[]> = {
    GHEG_OTHER_OPTIONS_EXTRA_PATTERNS,
    GHEG_ATTRIBUTE_FOLLOW_UP_EXTRA_PATTERNS,
    GHEG_RECOMMENDATION_EXTRA_PATTERNS,
    GHEG_POST_PURCHASE_EXTRA_PATTERNS,
    GHEG_ORDER_CONSENT_EXTRA_PATTERNS,
  };

  for (const [name, patterns] of Object.entries(LISTS)) {
    it(`${name} contains no diacritic alternates (they are unreachable after NFD folding)`, () => {
      for (const re of patterns) {
        assert.equal(/[ëçËÇ]/.test(re.source), false, `${name}: ${re.source}`);
      }
    });
  }

  it('GHEG_ALBANIAN_MARKERS contains no diacritics', () => {
    for (const marker of GHEG_ALBANIAN_MARKERS) {
      assert.equal(/[ëçËÇ]/.test(marker), false, marker);
    }
  });

  it('GHEG_ALBANIAN_MARKERS are lowercase (the haystack is lowercased before matching)', () => {
    for (const marker of GHEG_ALBANIAN_MARKERS) {
      assert.equal(marker, marker.toLowerCase(), marker);
    }
  });
});

describe('GHEG_ALBANIAN_MARKERS — English safety (the RC-10 reintroduction guard)', () => {
  // Matching is a bare .includes() with a `hits >= 1 && hits > otherHits` tiebreak, so ONE marker
  // embedded in an ordinary English word flips an English conversation to Albanian. The first
  // draft of the list carried ' be ', 'sun', 'spo' and 'bone' and measurably broke real English
  // messages — reintroducing the very root cause (RC-10) this workstream exists to fix. These
  // tests are what caught it and what keep it out.

  /** Mirrors heuristicallyDetectLanguage's matching exactly (padded haystack, lowercased). */
  const ghegHits = (message: string): string[] => {
    const haystack = ` ${message.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')} `;
    return GHEG_ALBANIAN_MARKERS.filter((m) => haystack.includes(m));
  };

  for (const message of ENGLISH_CONTROL_MESSAGES) {
    it(`no Gheg marker fires on plain English: "${message}"`, () => {
      assert.deepEqual(ghegHits(message), [], `English message matched Gheg markers`);
    });
  }

  it('the specific markers that broke English are gone', () => {
    for (const banned of [' be ', 'sun', 'spo', 'bone', 'ska', 'kem']) {
      assert.equal(
        GHEG_ALBANIAN_MARKERS.includes(banned),
        false,
        `"${banned}" is an English substring — it flips English conversations to Albanian`,
      );
    }
  });

  it('still fires on the pure-Gheg turns that resolve to null today (the actual RC-10 fix)', () => {
    // Verified against the live code: these three hit ZERO legacy markers.
    for (const message of ['Qysh o moti sot', 'O shef qa bone', 'Cila o ma e lira be se le qe jom cpirr']) {
      assert.ok(ghegHits(message).length > 0, `no Gheg marker fired on: ${message}`);
    }
  });

  it('every marker is orthographically implausible in English (no bare English word)', () => {
    const COMMON_ENGLISH = [
      'be', 'sun', 'bone', 'order', 'product', 'price', 'have', 'this', 'that', 'can',
      'ship', 'send', 'want', 'need', 'cost', 'stock', 'photo', 'cancel', 'refund',
    ];
    for (const marker of GHEG_ALBANIAN_MARKERS) {
      const bare = marker.trim();
      assert.equal(COMMON_ENGLISH.includes(bare), false, `"${marker}" is a common English word`);
    }
  });
});

describe('detectOrderConsentLexical — Gheg consent (stage-gated to awaiting_confirmation)', () => {
  it('flag-off is unchanged for the Gheg forms', () => {
    assert.equal(detectOrderConsentLexical('aha okej', false), false);
    assert.equal(detectOrderConsentLexical('jom dakord', false), false);
  });

  it('flag-on accepts Gheg leading filler before the affirmation', () => {
    assert.equal(detectOrderConsentLexical('aha okej', true), true);
  });

  it('flag-on accepts the Gheg progressive "pe porositi"', () => {
    assert.equal(detectOrderConsentLexical('Okej qita pe porositi pra shef', true), true);
  });

  it('flag-on accepts "jom dakord" and "e du"', () => {
    assert.equal(detectOrderConsentLexical('jom dakord', true), true);
    assert.equal(detectOrderConsentLexical('qito e du', true), true);
  });

  it('keeps every legacy consent form green on both branches', () => {
    for (const phrase of ['po', 'ok', 'okej', 'ne rregull', 'dakord', 'bone', 'veq bone']) {
      assert.equal(detectOrderConsentLexical(phrase, false), true, `off: ${phrase}`);
      assert.equal(detectOrderConsentLexical(phrase, true), true, `on: ${phrase}`);
    }
  });

  it('does not treat a complaint as consent even with the Gheg list on', () => {
    // The FSM additionally honors this lexicon ONLY in `awaiting_confirmation`, so this is
    // defence in depth rather than the primary guard.
    assert.equal(detectOrderConsentLexical('nuk osht produkti qe kam porosit', true), false);
  });
});

describe('GHEG_POST_PURCHASE_EXTRA_PATTERNS — parity with hasDeliveryEtaOnlyCue', () => {
  // hasPostPurchaseIssueCue accepted only 'nuk'; its sibling hasDeliveryEtaOnlyCue already
  // accepted ska|s'ka. Two cues reading the same message disagreed on dialect — that
  // inconsistency IS the bug.
  const matches = (text: string): boolean =>
    GHEG_POST_PURCHASE_EXTRA_PATTERNS.some((re) => re.test(text));

  it('matches Gheg negation for a non-delivery', () => {
    assert.equal(matches('ska ardh porosia'), true);
    assert.equal(matches('sme ka ardh'), true);
  });

  it('matches the Gheg copula in a wrong-product complaint', () => {
    assert.equal(matches('nuk osht produkti qe kam porosit'), true);
  });

  it('matches Gheg "qka bone me porosine"', () => {
    assert.equal(matches('qka bone me porosine time'), true);
  });

  it('does not match a plain product question', () => {
    assert.equal(matches('a keni carbo one'), false);
    assert.equal(matches('sa kushton kjo'), false);
  });
});

describe('GHEG_RECOMMENDATION_EXTRA_PATTERNS — the copula gap', () => {
  const matches = (text: string): boolean =>
    GHEG_RECOMMENDATION_EXTRA_PATTERNS.some((re) => re.test(text));

  it('matches the Gheg copula in the "which is more ..." frame', () => {
    // The legacy list's comment claims this is detected, but its pattern requires the literal
    // Tosk 'eshte', so 'osht' reached it and missed.
    assert.equal(matches('cila osht ma e lira'), true);
    assert.equal(matches('cili asht me i shtrenjte'), true);
  });

  it('matches the Gheg deictic tail "qitynve"', () => {
    assert.equal(matches('cilen mkishe than ti me marr prej qitynve'), true);
  });
});

describe('GHEG_ATTRIBUTE_FOLLOW_UP_EXTRA_PATTERNS — Gheg interrogatives', () => {
  const matches = (text: string): boolean =>
    GHEG_ATTRIBUTE_FOLLOW_UP_EXTRA_PATTERNS.some((re) => re.test(text));

  it('matches "qfar shije" (EV-030\'s single most common question shape)', () => {
    assert.equal(matches('me qfar shije i keni edhe sa kushtojn'), true);
  });

  it('matches the other Gheg interrogatives', () => {
    assert.equal(matches('qka ngjyra i keni'), true);
    assert.equal(matches('qa madhesi keni'), true);
  });
});
