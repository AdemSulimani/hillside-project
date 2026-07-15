/**
 * Tests for the code-owned platform rulebook + the restrictions footer (P2-5, RC-25/RC-26).
 *
 * The headline assertion is footer coverage: the audit found the business-rule footer reaching
 * exactly 1 of 6 tenants and the "PLATFORM POLICY" section never rendering at all (EV-029).
 * TENANT_SHAPES below is that live distribution, transcribed from the dev DB — 5 tenants with
 * `restrictions: []`, one with the 17 hand-typed Albanian rules, and `platform_restrictions: []`
 * on ALL six. Flag-off reproduces the 1/6 defect exactly; flag-on renders 6/6.
 *
 * All pure/in-process — no network/DB/OpenAI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_POLICY_PRECEDENCE_NOTE_BY_LOCALE,
  PLATFORM_POLICY_RULES_EN,
  PLATFORM_POLICY_RULES_SQ,
  buildRestrictionsFooter,
  resolvePlatformRestrictions,
  usesPlatformPolicyDefault,
} from '../platformPolicy';

/** A stand-in for the one tenant's 17 hand-typed operator rules (EV-029). */
const OPERATOR_17 = Array.from({ length: 17 }, (_, i) => `operator rule ${i + 1}`);

/**
 * The live tenant distribution, verified against the dev DB (6 tenants):
 * `restrictions` populated on 1, `platform_restrictions` empty on all 6.
 */
const TENANT_SHAPES: ReadonlyArray<{
  name: string;
  restrictions: string[];
  platform_restrictions: string[];
}> = [
  { name: 'Demiboy', restrictions: [], platform_restrictions: [] },
  { name: 'Hillside', restrictions: [], platform_restrictions: [] },
  { name: 'Hillside (2)', restrictions: [], platform_restrictions: [] },
  { name: 'ProteinPlus', restrictions: [], platform_restrictions: [] },
  { name: 'ProteinPluss', restrictions: OPERATOR_17, platform_restrictions: [] },
  { name: 'TravelAI', restrictions: [], platform_restrictions: [] },
];

describe('footer coverage across the 6 live tenants (EV-029)', () => {
  it('flag-off reproduces the audited defect exactly: 1 of 6 tenants gets a footer', () => {
    const withFooter = TENANT_SHAPES.filter(
      (t) => buildRestrictionsFooter(t as never, 'sq') !== '',
    );
    assert.equal(withFooter.length, 1);
    assert.equal(withFooter[0].name, 'ProteinPluss');
  });

  it('flag-off renders PLATFORM POLICY for zero tenants (it has never rendered in production)', () => {
    for (const shape of TENANT_SHAPES) {
      assert.equal(buildRestrictionsFooter(shape as never, 'sq').includes('PLATFORM POLICY'), false, shape.name);
    }
  });

  it('flag-on: every one of the 6 tenants renders a non-empty footer', () => {
    for (const shape of TENANT_SHAPES) {
      const platform = resolvePlatformRestrictions(shape, 'sq', true);
      assert.ok(platform.length > 0, `no platform rules for ${shape.name}`);
    }
  });

  it('flag-on: every one of the 6 tenants receives all 17 platform rules', () => {
    for (const shape of TENANT_SHAPES) {
      const platform = resolvePlatformRestrictions(shape, 'sq', true);
      assert.equal(platform.length, 17, shape.name);
    }
  });
});

describe('resolvePlatformRestrictions', () => {
  it('flag-off returns the raw column verbatim (byte-identical to today)', () => {
    assert.deepEqual(resolvePlatformRestrictions({ platform_restrictions: [] }, 'sq', false), []);
    assert.deepEqual(
      resolvePlatformRestrictions({ platform_restrictions: ['x'] }, 'sq', false),
      ['x'],
    );
  });

  it('an admin override wins over the code-owned default', () => {
    const override = ['only this rule'];
    assert.deepEqual(
      resolvePlatformRestrictions({ platform_restrictions: override }, 'sq', true),
      override,
    );
    assert.equal(usesPlatformPolicyDefault({ platform_restrictions: override }, true), false);
  });

  it('falls back to the code-owned default when the column is empty', () => {
    assert.equal(usesPlatformPolicyDefault({ platform_restrictions: [] }, true), true);
  });

  it('tolerates null/undefined/non-array columns', () => {
    for (const value of [null, undefined, 'nonsense' as never, 42 as never]) {
      const out = resolvePlatformRestrictions({ platform_restrictions: value as never }, 'sq', true);
      assert.equal(out.length, 17);
    }
  });

  it('selects the rulebook by locale — never hardcoded Albanian (DP-pc-18)', () => {
    const sq = resolvePlatformRestrictions({ platform_restrictions: [] }, 'sq', true);
    const en = resolvePlatformRestrictions({ platform_restrictions: [] }, 'en', true);
    assert.notDeepEqual(sq, en);
    assert.equal(sq[0], PLATFORM_POLICY_RULES_SQ[0].text);
    assert.equal(en[0], PLATFORM_POLICY_RULES_EN[0].text);
  });
});

describe('buildRestrictionsFooter — structure and precedence', () => {
  const CONFIG_BOTH = { restrictions: OPERATOR_17, platform_restrictions: ['platform override'] };

  it('renders operator rules BEFORE platform policy (platform wins by position)', () => {
    const footer = buildRestrictionsFooter(CONFIG_BOTH as never, 'sq');
    const operatorAt = footer.indexOf('OPERATOR BUSINESS RULES');
    const platformAt = footer.indexOf('PLATFORM POLICY');
    assert.ok(operatorAt >= 0 && platformAt >= 0);
    assert.ok(operatorAt < platformAt, 'platform policy must render last');
  });

  it('emits nothing when there is nothing to say', () => {
    assert.equal(buildRestrictionsFooter({ restrictions: [], platform_restrictions: [] } as never, 'sq'), '');
  });

  it('renders every rule as its own bullet', () => {
    const footer = buildRestrictionsFooter({ restrictions: ['a', 'b'], platform_restrictions: [] } as never, 'sq');
    assert.ok(footer.includes('- a'));
    assert.ok(footer.includes('- b'));
  });

  it('an admin override does not get the precedence note (it is not the platform rulebook)', () => {
    const footer = buildRestrictionsFooter(CONFIG_BOTH as never, 'sq');
    assert.equal(footer.includes(PLATFORM_POLICY_PRECEDENCE_NOTE_BY_LOCALE.sq), false);
  });

  it('requires an explicit locale — there is no silent Albanian default to drift from', () => {
    // The locale parameter is deliberately required: defaulting here would duplicate aiService's
    // DEFAULT_REPLY_LOCALE, which cannot be imported without reintroducing the runtime cycle and
    // so would silently drift if the market default ever changed.
    const sq = buildRestrictionsFooter({ restrictions: ['x'], platform_restrictions: [] }, 'sq');
    const en = buildRestrictionsFooter({ restrictions: ['x'], platform_restrictions: [] }, 'en');
    assert.ok(sq.includes('- x'));
    assert.equal(sq, en, 'operator rules are tenant-authored text — locale must not alter them');
  });
});

describe('the rulebook itself', () => {
  it('has 17 rules in both locales — rule-for-rule business.md', () => {
    assert.equal(PLATFORM_POLICY_RULES_SQ.length, 17);
    assert.equal(PLATFORM_POLICY_RULES_EN.length, 17);
  });

  it('shares ids R1..R17 across locales, in order', () => {
    const expected = Array.from({ length: 17 }, (_, i) => `R${i + 1}`);
    assert.deepEqual(PLATFORM_POLICY_RULES_SQ.map((r) => r.id), expected);
    assert.deepEqual(PLATFORM_POLICY_RULES_EN.map((r) => r.id), expected);
  });

  it('has no empty rule text', () => {
    for (const rules of [PLATFORM_POLICY_RULES_SQ, PLATFORM_POLICY_RULES_EN]) {
      for (const rule of rules) assert.ok(rule.text.trim().length > 0, rule.id);
    }
  });

  it('has a precedence note for every locale', () => {
    for (const locale of ['sq', 'en'] as const) {
      assert.ok(PLATFORM_POLICY_PRECEDENCE_NOTE_BY_LOCALE[locale].trim().length > 0, locale);
    }
  });

  // C-03: the recommendation/alternative count said four different things across four sites
  // (business.md 1-2, the Albanian restriction "një alternativë" = 1, the guideline blocks 2-3,
  // and the platform-locked category_product_aggregation 1-2). 2-3 is canonical — the only
  // decided-and-shipped value (migration 066, live in 6/6). These pin it.
  it('states 2-3 alternatives in R7 and R13 in BOTH locales (C-03)', () => {
    for (const rules of [PLATFORM_POLICY_RULES_SQ, PLATFORM_POLICY_RULES_EN]) {
      for (const id of ['R7', 'R13']) {
        const rule = rules.find((r) => r.id === id)!;
        assert.ok(rule.text.includes('2-3'), `${id}: ${rule.text}`);
        assert.equal(/\b1-2\b/.test(rule.text), false, `${id} still says 1-2`);
      }
    }
  });

  it('states 2-3 recommendations in R17 in BOTH locales (C-03)', () => {
    for (const rules of [PLATFORM_POLICY_RULES_SQ, PLATFORM_POLICY_RULES_EN]) {
      const r17 = rules.find((r) => r.id === 'R17')!;
      assert.ok(r17.text.includes('2-3'), r17.text);
      assert.equal(/\b1-2\b/.test(r17.text), false, 'R17 still says 1-2');
    }
  });

  it('no rule anywhere still carries the retired 1-2 count', () => {
    for (const rules of [PLATFORM_POLICY_RULES_SQ, PLATFORM_POLICY_RULES_EN]) {
      for (const rule of rules) {
        assert.equal(/\b1-2\b|\b1–2\b/.test(rule.text), false, `${rule.id}: ${rule.text}`);
      }
    }
  });

  it('R16 and R17 carry the no-alert mandate (the rules the guards contradict)', () => {
    const sq16 = PLATFORM_POLICY_RULES_SQ.find((r) => r.id === 'R16')!;
    const sq17 = PLATFORM_POLICY_RULES_SQ.find((r) => r.id === 'R17')!;
    assert.ok(sq16.text.includes('Mos shkakto alarme'));
    assert.ok(sq17.text.includes('Mos shkakto alarme'));
  });
});
