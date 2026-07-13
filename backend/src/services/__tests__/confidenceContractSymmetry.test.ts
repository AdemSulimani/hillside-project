/**
 * Tests for the confidence contract + boost symmetry + threshold hysteresis (P1-3,
 * RC-07/RC-08).
 *
 * RC-07: when a classifier asserts an intent boolean `true` but omits/zeroes `confidence`,
 * four escalation detectors overwrite it to 0.9/0.85 — clearing their `>0.8`/`>0.82` gate on
 * the boolean alone — while `detectOrderAffirmationIntent` has NO boost and so *fails* its
 * `>0.7` gate on the identical malformed output. Identical parseable-but-malformed output
 * therefore over-escalates on four paths and under-creates orders on one (DP-GPR-16). The
 * fix removes the boosts so every detector shares one fail-direction: the boolean alone never
 * fires the action.
 *
 * RC-08: the gates are hard `>` thresholds over non-deterministic scores, so boundary
 * phrasing flips outcome-class run-to-run. The fix adds a symmetric abstain band so a score
 * near the threshold resolves deterministically to "do not fire".
 *
 * All tests are pure/in-process (no network/DB/OpenAI): they exercise the same contract
 * helpers `aiService.ts` and `processAIReply.ts` compose, threading `applySymmetry`
 * explicitly (as P0-3's `decideGapEscalation` threads its flag) so both the legacy and the
 * symmetric branch are covered in one process regardless of the env flag.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIDENCE_HYSTERESIS_BAND,
  classifyConfidenceGate,
  confidenceContractSchema,
  hasUsableConfidence,
  isLikelyE164Phone,
  normalizeClassifierConfidence,
  passesConfidenceGate,
  resolveEscalationConfidence,
} from '../classifierConfidenceContract';

// ---------------------------------------------------------------------------
// The five detectors, modelled exactly as aiService.ts / processAIReply.ts wire
// them: the four escalation detectors carry a legacy boost + hard gate; the
// order-affirmation path has no boost and a 0.7 gate.
// ---------------------------------------------------------------------------

type DetectorSpec = {
  name: string;
  threshold: number;
  legacyBoost: number | null; // null = no boost (order-affirmation path)
};

const DETECTORS: DetectorSpec[] = [
  { name: 'cancellation_refund', threshold: 0.8, legacyBoost: 0.9 },
  { name: 'wrong_product', threshold: 0.8, legacyBoost: 0.9 },
  { name: 'post_purchase', threshold: 0.8, legacyBoost: 0.9 },
  { name: 'order_info_update', threshold: 0.82, legacyBoost: 0.85 },
  { name: 'order_affirmation', threshold: 0.7, legacyBoost: null },
];

/**
 * Reproduces a detector's end-to-end firing decision the way the pipeline composes it:
 * resolve the confidence (boosted escalation path, or bare normalize for the affirmation
 * path) then apply the gate. Returns whether the detector's action FIRES.
 */
function detectorFires(
  spec: DetectorSpec,
  rawConfidence: unknown,
  intentAsserted: boolean,
  applySymmetry: boolean,
): boolean {
  const confidence =
    spec.legacyBoost === null
      ? normalizeClassifierConfidence(rawConfidence)
      : resolveEscalationConfidence({
          raw: rawConfidence,
          intentAsserted,
          legacyBoost: spec.legacyBoost,
          applySymmetry,
        });
  return intentAsserted && passesConfidenceGate(confidence, spec.threshold, applySymmetry);
}

// ---------------------------------------------------------------------------
// (1) Required-`confidence` output contract
// ---------------------------------------------------------------------------

describe('confidenceContractSchema — confidence is a REQUIRED field', () => {
  it('rejects an intent output that omits confidence', () => {
    const result = confidenceContractSchema.safeParse({ is_refund: true });
    assert.equal(result.success, false);
  });

  it('rejects a non-numeric confidence', () => {
    assert.equal(confidenceContractSchema.safeParse({ confidence: 'high' }).success, false);
    assert.equal(confidenceContractSchema.safeParse({ confidence: null }).success, false);
  });

  it('accepts a numeric confidence and preserves sibling intent fields', () => {
    const result = confidenceContractSchema.safeParse({ is_refund: true, confidence: 0.9 });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.confidence, 0.9);
      assert.equal((result.data as Record<string, unknown>).is_refund, true);
    }
  });
});

// ---------------------------------------------------------------------------
// (2) In-contract normalization — the >1 ⇒ /100 scale-guess (C-63) unified
// ---------------------------------------------------------------------------

describe('normalizeClassifierConfidence', () => {
  it('passes through a 0–1 value', () => {
    assert.equal(normalizeClassifierConfidence(0), 0);
    assert.equal(normalizeClassifierConfidence(0.8), 0.8);
    assert.equal(normalizeClassifierConfidence(1), 1);
  });

  it('rescales a >1 value as a percentage (C-63)', () => {
    assert.equal(normalizeClassifierConfidence(90), 0.9);
    assert.equal(normalizeClassifierConfidence(85), 0.85);
    assert.equal(normalizeClassifierConfidence(100), 1);
  });

  it('parses numeric strings the same way', () => {
    assert.equal(normalizeClassifierConfidence('0.75'), 0.75);
    assert.equal(normalizeClassifierConfidence('85'), 0.85);
    assert.equal(normalizeClassifierConfidence(' 0.5 '), 0.5);
  });

  it('clamps and defaults non-finite / unparseable input to 0', () => {
    assert.equal(normalizeClassifierConfidence(undefined), 0);
    assert.equal(normalizeClassifierConfidence(null), 0);
    assert.equal(normalizeClassifierConfidence('nope'), 0);
    assert.equal(normalizeClassifierConfidence(NaN), 0);
    assert.equal(normalizeClassifierConfidence(-1), 0);
    assert.equal(normalizeClassifierConfidence(200), 1);
  });

  it('hasUsableConfidence distinguishes omitted from a real (incl. zero) value', () => {
    assert.equal(hasUsableConfidence(0), true);
    assert.equal(hasUsableConfidence(0.9), true);
    assert.equal(hasUsableConfidence('0.9'), true);
    assert.equal(hasUsableConfidence(undefined), false);
    assert.equal(hasUsableConfidence(null), false);
    assert.equal(hasUsableConfidence('high'), false);
  });
});

// ---------------------------------------------------------------------------
// (3) DP-GPR-16 acceptance — a single consistent fail-direction across all five
// detectors for {intent:true, confidence:0} and {intent:true} (missing).
// ---------------------------------------------------------------------------

describe('DP-GPR-16 — symmetric fail-direction on malformed classifier output', () => {
  const MALFORMED = [
    { label: '{intent:true, confidence:0}', raw: 0 },
    { label: '{intent:true} (confidence missing)', raw: undefined },
  ];

  for (const { label, raw } of MALFORMED) {
    it(`symmetry ON: NO detector fires on ${label} (uniform abstain)`, () => {
      const fired = DETECTORS.map((spec) => detectorFires(spec, raw, true, true));
      // Single consistent fail-direction: every one of the five abstains.
      assert.deepEqual(
        fired,
        DETECTORS.map(() => false),
        `expected all five detectors to abstain; got ${JSON.stringify(
          Object.fromEntries(DETECTORS.map((d, i) => [d.name, fired[i]])),
        )}`,
      );
    });
  }

  it('legacy (symmetry OFF): the SAME malformed output is asymmetric (documents the bug)', () => {
    const fired = DETECTORS.map((spec) => detectorFires(spec, 0, true, false));
    const byName = Object.fromEntries(DETECTORS.map((d, i) => [d.name, fired[i]]));
    // Four escalation paths over-fire on the boost; the order-affirmation path does not.
    assert.equal(byName['cancellation_refund'], true);
    assert.equal(byName['wrong_product'], true);
    assert.equal(byName['post_purchase'], true);
    assert.equal(byName['order_info_update'], true);
    assert.equal(byName['order_affirmation'], false);
    // The set is NOT uniform — that asymmetry is exactly what symmetry ON eliminates.
    assert.equal(new Set(fired).size, 2);
  });

  it('a genuine high confidence still fires every detector under both policies', () => {
    for (const applySymmetry of [true, false]) {
      for (const spec of DETECTORS) {
        assert.equal(
          detectorFires(spec, 0.99, true, applySymmetry),
          true,
          `${spec.name} should fire at confidence 0.99 (symmetry=${applySymmetry})`,
        );
      }
    }
  });

  it('resolveEscalationConfidence: boost applies ONLY legacy + intent + zero', () => {
    // Legacy path boosts a zero-with-intent to the per-site value...
    assert.equal(
      resolveEscalationConfidence({ raw: 0, intentAsserted: true, legacyBoost: 0.9, applySymmetry: false }),
      0.9,
    );
    // ...but never boosts when the intent boolean is false...
    assert.equal(
      resolveEscalationConfidence({ raw: 0, intentAsserted: false, legacyBoost: 0.9, applySymmetry: false }),
      0,
    );
    // ...never boosts a real non-zero value...
    assert.equal(
      resolveEscalationConfidence({ raw: 0.3, intentAsserted: true, legacyBoost: 0.9, applySymmetry: false }),
      0.3,
    );
    // ...and under symmetry never boosts at all.
    assert.equal(
      resolveEscalationConfidence({ raw: 0, intentAsserted: true, legacyBoost: 0.9, applySymmetry: true }),
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// (4) RC-08 — threshold hysteresis: boundary scores resolve deterministically.
// ---------------------------------------------------------------------------

describe('classifyConfidenceGate — symmetric abstain band (RC-08)', () => {
  const band = CONFIDENCE_HYSTERESIS_BAND;

  it('legacy (symmetry OFF) is a hard > gate with no abstain zone', () => {
    assert.equal(classifyConfidenceGate({ confidence: 0.81, threshold: 0.8, band, applySymmetry: false }), 'pass');
    assert.equal(classifyConfidenceGate({ confidence: 0.8, threshold: 0.8, band, applySymmetry: false }), 'fail');
    assert.equal(classifyConfidenceGate({ confidence: 0.79, threshold: 0.8, band, applySymmetry: false }), 'fail');
  });

  it('symmetry ON: pass above the band, fail below it, abstain inside it', () => {
    const t = 0.8;
    assert.equal(classifyConfidenceGate({ confidence: t + band + 0.02, threshold: t, band, applySymmetry: true }), 'pass');
    assert.equal(classifyConfidenceGate({ confidence: t, threshold: t, band, applySymmetry: true }), 'abstain');
    assert.equal(classifyConfidenceGate({ confidence: t + band - 0.02, threshold: t, band, applySymmetry: true }), 'abstain');
    assert.equal(classifyConfidenceGate({ confidence: t - band + 0.02, threshold: t, band, applySymmetry: true }), 'abstain');
    assert.equal(classifyConfidenceGate({ confidence: t - band - 0.02, threshold: t, band, applySymmetry: true }), 'fail');
  });

  it('resolves the RC-08 flip: noisy scores straddling the threshold no longer flip class', () => {
    // Legacy: 0.79 → normal, 0.81 → escalate+pause (same words, opposite class).
    assert.notEqual(
      passesConfidenceGate(0.79, 0.8, false),
      passesConfidenceGate(0.81, 0.8, false),
    );
    // Symmetric: both sit inside the abstain band → both resolve to "do not fire".
    assert.equal(passesConfidenceGate(0.79, 0.8, true), false);
    assert.equal(passesConfidenceGate(0.81, 0.8, true), false);
  });

  it('boundary corpus replayed N≥20× yields an identical, deterministic label per score', () => {
    const REPLAYS = 25;
    for (const spec of DETECTORS) {
      const t = spec.threshold;
      const corpus = [t - band - 0.03, t - 0.01, t, t + 0.01, t + band + 0.03];
      for (const score of corpus) {
        const labels = new Set(
          Array.from({ length: REPLAYS }, () =>
            classifyConfidenceGate({ confidence: score, threshold: t, band, applySymmetry: true }),
          ),
        );
        assert.equal(
          labels.size,
          1,
          `${spec.name} score ${score} produced non-deterministic labels ${JSON.stringify([...labels])}`,
        );
      }
    }
  });

  it('passesConfidenceGate OFF is byte-for-byte the legacy hard > gate', () => {
    for (const t of [0.7, 0.8, 0.82]) {
      for (const c of [0, 0.5, t - 0.001, t, t + 0.001, 0.9, 1]) {
        assert.equal(passesConfidenceGate(c, t, false), c > t, `c=${c} t=${t}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (5) Order-stage deterministic slot check — the E.164 phone shape signal.
// ---------------------------------------------------------------------------

describe('isLikelyE164Phone', () => {
  it('accepts E.164 and common local Kosovo/Albanian formats with separators', () => {
    assert.equal(isLikelyE164Phone('+38344123456'), true);
    assert.equal(isLikelyE164Phone('+383 44 123 456'), true);
    assert.equal(isLikelyE164Phone('044123456'), true);
    assert.equal(isLikelyE164Phone('044-123-456'), true);
    assert.equal(isLikelyE164Phone('(044) 123 456'), true);
  });

  it('rejects too-short, too-long, empty, and letter-bearing candidates', () => {
    assert.equal(isLikelyE164Phone('12345'), false); // 5 digits < 7
    assert.equal(isLikelyE164Phone('+12345678901234567'), false); // 17 digits > 15
    assert.equal(isLikelyE164Phone('call me maybe'), false);
    assert.equal(isLikelyE164Phone('044-123-ABC'), false);
    assert.equal(isLikelyE164Phone(''), false);
    assert.equal(isLikelyE164Phone('   '), false);
    assert.equal(isLikelyE164Phone(undefined), false);
    assert.equal(isLikelyE164Phone(null), false);
    assert.equal(isLikelyE164Phone(38344123456), false); // must be a string
  });
});
