/**
 * P2-7 — the config manifest, detector, mode matrix, fingerprint and `.env.example` drift check.
 *
 * Every assertion here is a PURE function over a synthetic env bag passed as a parameter — no
 * `process.env` mutation, no save/restore dance, no mocking framework (the repo has none). That is
 * the whole reason `detect`/`applyMode`/`fingerprint` take `env` as an argument: the pre-P2-7
 * `validateRequiredEnv()` read `process.env` internally and called `process.exit(1)`, which is
 * untestable in-process — and so it had zero tests, which is how 47 undocumented knobs and a
 * NaN-able SIMILARITY_THRESHOLD survived.
 *
 * NOTE this file lives in `src/config/__tests__/` and only runs because P2-7 widened the `npm test`
 * glob, which was previously locked to the `src/services/__tests__` directory alone. Before that, a
 * test placed here would have silently never run — the guard's own tests would have been fake.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type KnobSpec,
  KNOBS,
  applyMode,
  detect,
  detectExampleDrift,
  fingerprint,
  knobNumber,
  parseEnvExample,
  readKnob,
  resolveMode,
} from '../knobs';

/** A minimal env that satisfies every REQUIRED knob, so tests can isolate one variable at a time. */
function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://localhost:5432/test',
    JWT_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    OPENAI_API_KEY: 'sk-test',
    OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small',
    ...overrides,
  };
}

/**
 * The most interesting finding for a key. A key can produce several (e.g. OPENAI_EMBEDDING_MODEL
 * yields both an `ok` value report and a `dimension_mismatch`), and a plain `.find()` would return
 * the benign one and quietly pass — so prefer the non-`ok` finding.
 */
function find(env: NodeJS.ProcessEnv, key: string) {
  const all = detect(env).filter((f) => f.key === key);
  return all.find((f) => f.code !== 'ok' && f.code !== 'optional_defaulted') ?? all[0];
}

/** The highest severity reported for a key, for the same reason. */
function severityOf(env: NodeJS.ProcessEnv, key: string, mode: 'off' | 'warn' | 'strict', isProd = false) {
  const all = applyMode(detect(env), mode, isProd).filter((f) => f.key === key);
  const rank = { info: 0, warn: 1, fatal: 2 } as const;
  return all.sort((a, b) => rank[b.severity!] - rank[a.severity!])[0]?.severity;
}

// ---------------------------------------------------------------------------
// readKnob — parsing, bands, and the values that actually take effect.
// ---------------------------------------------------------------------------

describe('readKnob', () => {
  const floatSpec: KnobSpec = {
    key: 'T',
    kind: 'float',
    requiredness: { kind: 'optional', default: 0.65 },
    binding: 'frozen',
    band: { min: 0, max: 1 },
    description: 'test float',
  };

  it('parses a valid in-band value', () => {
    const r = readKnob(floatSpec, { T: '0.8' });
    assert.deepEqual(
      { value: r.value, usedDefault: r.usedDefault, parseOk: r.parseOk, inBand: r.inBand },
      { value: 0.8, usedDefault: false, parseOk: true, inBand: true },
    );
  });

  it('falls back to the default when absent', () => {
    const r = readKnob(floatSpec, {});
    assert.equal(r.value, 0.65);
    assert.equal(r.usedDefault, true);
    assert.equal(r.raw, undefined);
  });

  it('treats an empty string as absent (not as 0)', () => {
    const r = readKnob(floatSpec, { T: '   ' });
    assert.equal(r.value, 0.65);
    assert.equal(r.usedDefault, true);
  });

  it('reports unparseable input instead of yielding NaN — the SIMILARITY_THRESHOLD bug', () => {
    const r = readKnob(floatSpec, { T: 'o.65' }); // a real typo: letter o for zero
    assert.equal(r.parseOk, false);
    assert.equal(r.value, 0.65, 'must fall back, never NaN');
    assert.ok(!Number.isNaN(r.value as number));
  });

  it('reports an out-of-band value and falls back', () => {
    const r = readKnob(floatSpec, { T: '2' });
    assert.equal(r.parseOk, true, 'it parses fine — it is just not allowed');
    assert.equal(r.inBand, false);
    assert.equal(r.value, 0.65);
  });

  it('honours an exclusive band (the INTENT_THRESHOLD contract)', () => {
    const exclusive: KnobSpec = { ...floatSpec, band: { min: 0, max: 1, exclusive: true } };
    assert.equal(readKnob(exclusive, { T: '0.5' }).inBand, true);
    assert.equal(readKnob(exclusive, { T: '1' }).inBand, false, '1 is excluded');
    assert.equal(readKnob(exclusive, { T: '0' }).inBand, false, '0 is excluded');
  });

  it('parses bools strictly, and rejects anything else', () => {
    const spec: KnobSpec = {
      key: 'F',
      kind: 'bool',
      requiredness: { kind: 'optional', default: false },
      binding: 'frozen',
      description: 'test flag',
    };
    assert.equal(readKnob(spec, { F: 'true' }).value, true);
    assert.equal(readKnob(spec, { F: 'TRUE' }).value, true, 'case-insensitive');
    assert.equal(readKnob(spec, { F: 'false' }).value, false);
    // "1"/"yes" are NOT true here — the codebase's flag idiom has always been an exact 'true'
    // match, and silently accepting other spellings would change ~30 flags' behaviour.
    const r = readKnob(spec, { F: '1' });
    assert.equal(r.parseOk, false);
    assert.equal(r.value, false);
  });

  it('parses enums case-insensitively and rejects unknown values', () => {
    const spec: KnobSpec = {
      key: 'E',
      kind: 'enum',
      values: ['off', 'shadow', 'on'],
      requiredness: { kind: 'optional', default: 'off' },
      binding: 'per-call',
      description: 'test enum',
    };
    assert.equal(readKnob(spec, { E: 'ON' }).value, 'on');
    assert.equal(readKnob(spec, { E: 'maybe' }).parseOk, false);
    assert.equal(readKnob(spec, { E: 'maybe' }).value, 'off');
  });
});

// ---------------------------------------------------------------------------
// The real knobs, behaving the way the audit says they must.
// ---------------------------------------------------------------------------

describe('the manifest preserves each knob\'s historical contract', () => {
  it('INTENT_THRESHOLD still rejects 1 back to 0.85 — but now says so (I6)', () => {
    // The consumer's gate has always been `>0 && <1`. P2-7 does not change WHAT happens to
    // INTENT_THRESHOLD=1 (a plausible way to say "never auto-create orders"); it changes the fact
    // that the revert was silent, which made it read as the exact opposite of the operator's intent.
    assert.equal(knobNumber('INTENT_THRESHOLD', { INTENT_THRESHOLD: '1' }), 0.85);
    assert.equal(knobNumber('INTENT_THRESHOLD', { INTENT_THRESHOLD: '0' }), 0.85);
    assert.equal(knobNumber('INTENT_THRESHOLD', { INTENT_THRESHOLD: '0.9' }), 0.9);
    assert.equal(knobNumber('INTENT_THRESHOLD', {}), 0.85);

    const f = find(baseEnv({ INTENT_THRESHOLD: '1' }), 'INTENT_THRESHOLD');
    assert.equal(f?.code, 'out_of_band', 'the rejection is now reported, not silent');
  });

  it('SIMILARITY_THRESHOLD cannot be NaN — the fleet-wide silent-retrieval-death bug', () => {
    // Pre-P2-7: parseFloat('o.65') === NaN, every `similarity >= NaN` is false, so semantic
    // retrieval returned nothing on every query, forever, with no error anywhere.
    const value = knobNumber('SIMILARITY_THRESHOLD', { SIMILARITY_THRESHOLD: 'o.65' });
    assert.ok(!Number.isNaN(value));
    assert.equal(value, 0.65);
    assert.equal(find(baseEnv({ SIMILARITY_THRESHOLD: 'o.65' }), 'SIMILARITY_THRESHOLD')?.code, 'unparseable');
  });

  it('QUALITY_THRESHOLD carries the rationale that keeps it at 0.1', () => {
    const spec = KNOBS.find((k) => k.key === 'QUALITY_THRESHOLD');
    // The 0.6-vs-0.1 drift is closed; this guards the REASON, which is the part that would be lost
    // in a future "let's tighten quality" change. 0.6 would pause the AI on every order
    // confirmation (the eval's systematic 0.200 false-low) with no auto-resume.
    assert.match(spec?.rationale ?? '', /0\.200|0\.6/);
    assert.equal(knobNumber('QUALITY_THRESHOLD', { QUALITY_THRESHOLD: '0.6' }), 0.6, '0.6 is in-band, just unwise');
  });

  it('AI_REPLY_TEMPERATURE is banded to [0,1], tighter than the API maximum of 2', () => {
    assert.equal(knobNumber('AI_REPLY_TEMPERATURE', { AI_REPLY_TEMPERATURE: '0.3' }), 0.3);
    assert.equal(knobNumber('AI_REPLY_TEMPERATURE', { AI_REPLY_TEMPERATURE: '1.5' }), 0.3, 'out of band → default');
    assert.equal(find(baseEnv({ AI_REPLY_TEMPERATURE: '1.5' }), 'AI_REPLY_TEMPERATURE')?.code, 'out_of_band');
  });
});

// ---------------------------------------------------------------------------
// detect + applyMode — the fatal/warn matrix.
// ---------------------------------------------------------------------------

describe('detect + applyMode', () => {
  it('a missing REQUIRED var is fatal in EVERY mode, including off', () => {
    const env = baseEnv();
    delete env.DATABASE_URL;
    for (const mode of ['off', 'warn', 'strict'] as const) {
      assert.equal(severityOf(env, 'DATABASE_URL', mode), 'fatal', `mode=${mode}`);
    }
  });

  it('an optional knob using its default is INFO in every mode, never fatal', () => {
    // P2-7's stated edge case: "warn-only must distinguish required-and-missing (fail) from
    // optional-using-default (info-log)". It is structural — `Requiredness` decides, not wording —
    // so strict mode cannot accidentally start failing on unset optional knobs.
    for (const mode of ['off', 'warn', 'strict'] as const) {
      assert.equal(severityOf(baseEnv(), 'SIMILARITY_THRESHOLD', mode), 'info', `mode=${mode}`);
      assert.equal(severityOf(baseEnv(), 'GHEG_LEXICONS', mode), 'info', `mode=${mode}`);
    }
  });

  it('an out-of-band value warns at boot but is fatal under strict — the CI gate', () => {
    const env = baseEnv({ AI_REPLY_TEMPERATURE: '9' });
    assert.equal(severityOf(env, 'AI_REPLY_TEMPERATURE', 'off'), 'info');
    assert.equal(severityOf(env, 'AI_REPLY_TEMPERATURE', 'warn'), 'warn');
    assert.equal(severityOf(env, 'AI_REPLY_TEMPERATURE', 'strict'), 'fatal');
  });

  it('an unparseable value follows the same escalation', () => {
    const env = baseEnv({ SIMILARITY_THRESHOLD: 'abc' });
    assert.equal(severityOf(env, 'SIMILARITY_THRESHOLD', 'warn'), 'warn');
    assert.equal(severityOf(env, 'SIMILARITY_THRESHOLD', 'strict'), 'fatal');
  });

  it('a missing RECOMMENDED secret only ever warns', () => {
    for (const mode of ['off', 'warn', 'strict'] as const) {
      assert.equal(severityOf(baseEnv(), 'ENCRYPTION_KEY', mode), 'warn', `mode=${mode}`);
    }
  });

  it('weak/duplicate signing secrets are fatal in production, advisory in dev', () => {
    const weak = baseEnv({ JWT_SECRET: 'short' });
    assert.equal(severityOf(weak, 'JWT_SECRET', 'warn', false), 'warn', 'dev must not be blocked');
    assert.equal(severityOf(weak, 'JWT_SECRET', 'warn', true), 'fatal', 'production must be');

    const dup = baseEnv({ JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'x'.repeat(32) });
    const dupFinding = applyMode(detect(dup), 'warn', true).find((f) => f.code === 'secret_duplicate');
    assert.equal(dupFinding?.severity, 'fatal');
  });

  it('reports the EFFECTIVE value of every knob (guard 6)', () => {
    const findings = detect(baseEnv({ AI_MAX_REPLIES_PER_HOUR: '50' }));
    assert.equal(findings.find((f) => f.key === 'AI_MAX_REPLIES_PER_HOUR')?.effective, '50');
    assert.equal(findings.find((f) => f.key === 'AI_HISTORY_FETCH_LIMIT')?.effective, '40', 'default still reported');
  });

  it('never reports a secret\'s value', () => {
    const findings = detect(baseEnv({ JWT_SECRET: 'super-secret-value-abcdefghijklmno' }));
    for (const f of findings) {
      assert.ok(
        !JSON.stringify(f).includes('super-secret-value'),
        `secret leaked in finding for ${f.key}`,
      );
    }
  });
});

describe('resolveMode', () => {
  it('defaults to warn, and ignores garbage rather than failing', () => {
    assert.equal(resolveMode({}), 'warn');
    assert.equal(resolveMode({ STRICT_CONFIG_VALIDATION: 'STRICT' }), 'strict');
    assert.equal(resolveMode({ STRICT_CONFIG_VALIDATION: 'off' }), 'off');
    assert.equal(resolveMode({ STRICT_CONFIG_VALIDATION: 'banana' }), 'warn');
  });
});

// ---------------------------------------------------------------------------
// Guard 1 (offline half) — the embedding dimension.
// ---------------------------------------------------------------------------

describe('embedding dimension guard (RC-04)', () => {
  it('fatals on a 3072-dim model, naming both numbers', () => {
    const env = baseEnv({ OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large' });
    const f = find(env, 'OPENAI_EMBEDDING_MODEL');
    assert.equal(f?.code, 'dimension_mismatch');
    assert.match(f?.message ?? '', /3072/);
    assert.match(f?.message ?? '', /1536/);
    for (const mode of ['off', 'warn', 'strict'] as const) {
      assert.equal(severityOf(env, 'OPENAI_EMBEDDING_MODEL', mode), 'fatal', `mode=${mode}`);
    }
  });

  it('accepts a 1536-dim model', () => {
    const f = find(baseEnv(), 'OPENAI_EMBEDDING_MODEL');
    assert.equal(f?.code, 'ok', 'no dimension complaint');
  });

  it('fatals when unset — there is deliberately no fallback to guess with', () => {
    const env = baseEnv();
    delete env.OPENAI_EMBEDDING_MODEL;
    assert.equal(find(env, 'OPENAI_EMBEDDING_MODEL')?.code, 'required_missing');
    assert.equal(severityOf(env, 'OPENAI_EMBEDDING_MODEL', 'warn'), 'fatal');
  });

  it('warns (does not fatal) on a model whose dimension we do not know', () => {
    const env = baseEnv({ OPENAI_EMBEDDING_MODEL: 'text-embedding-4-future' });
    const f = find(env, 'OPENAI_EMBEDDING_MODEL');
    assert.equal(f?.code, 'unknown_model');
    // Fatal would block adopting any newer model on a table this file cannot keep current.
    assert.equal(severityOf(env, 'OPENAI_EMBEDDING_MODEL', 'strict'), 'warn');
  });
});

// ---------------------------------------------------------------------------
// Guard 7 — the fingerprint.
// ---------------------------------------------------------------------------

describe('fingerprint (RC-06)', () => {
  it('is stable for the same env and independent of key order', () => {
    const a = fingerprint({ ...baseEnv(), AI_HISTORY_FETCH_LIMIT: '40', GHEG_LEXICONS: 'true' }, 'host:1');
    const b = fingerprint({ GHEG_LEXICONS: 'true', AI_HISTORY_FETCH_LIMIT: '40', ...baseEnv() }, 'host:1');
    assert.equal(a.hash, b.hash);
  });

  it('changes when a frozen knob changes — this IS the drift signal', () => {
    // AI_HISTORY_FETCH_LIMIT is `frozen`: two instances disagreeing on it means the same
    // conversation is summarised from a different slice depending on which worker runs it.
    const a = fingerprint(baseEnv({ AI_HISTORY_FETCH_LIMIT: '40' }), 'host:1');
    const b = fingerprint(baseEnv({ AI_HISTORY_FETCH_LIMIT: '80' }), 'host:2');
    assert.notEqual(a.hash, b.hash);
  });

  it('is identical across instances on the same config — otherwise every fleet looks drifted', () => {
    const a = fingerprint(baseEnv(), 'host-a:1');
    const b = fingerprint(baseEnv(), 'host-b:2');
    assert.equal(a.hash, b.hash);
    assert.notEqual(a.instance, b.instance);
  });

  it('includes per-call knobs (P2-7-F3/F4: env is boot-static, so their drift is real drift)', () => {
    // The original design hashed frozen knobs only, on the false premise that a per-call knob can
    // differ between two reads of one process — process.env cannot. Two instances disagreeing on
    // a per-call knob (the spec's own AI_MAX_REPLIES_PER_HOUR / QUALITY_THRESHOLD acceptance
    // scenario) MUST surface as different fingerprints.
    const a = fingerprint(baseEnv({ QUALITY_THRESHOLD: '0.1' }), 'host:1');
    const b = fingerprint(baseEnv({ QUALITY_THRESHOLD: '0.9' }), 'host:1');
    assert.notEqual(a.hash, b.hash);
    assert.ok('QUALITY_THRESHOLD' in a.knobs, 'per-call knobs are part of the fingerprinted set');
  });

  it('hashes secrets rather than storing them — the fingerprint reaches a table and the logs', () => {
    const fp = fingerprint(baseEnv({ JWT_SECRET: 'c'.repeat(32) }), 'host:1');
    const serialized = JSON.stringify(fp);
    assert.ok(!serialized.includes('c'.repeat(32)), 'raw secret must never appear');

    // ...but a rotated secret must still register as drift.
    const rotated = fingerprint(baseEnv({ JWT_SECRET: 'd'.repeat(32) }), 'host:1');
    assert.notEqual(fp.hash, rotated.hash);
  });
});

// ---------------------------------------------------------------------------
// `.env.example` drift (the CI gate's offline half).
// ---------------------------------------------------------------------------

describe('detectExampleDrift', () => {
  const spec: KnobSpec[] = [
    {
      key: 'FOO',
      kind: 'float',
      requiredness: { kind: 'optional', default: 0.1 },
      binding: 'frozen',
      description: 'foo',
    },
  ];

  it('flags a knob the code reads but the example never mentions', () => {
    const findings = detectExampleDrift('# --- Core ---\nBAR=1\n', spec);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, 'undocumented');
  });

  it('flags an example value that disagrees with the code default — the QUALITY_THRESHOLD trap', () => {
    const findings = detectExampleDrift('FOO=0.6\n', spec);
    assert.equal(findings[0]?.code, 'default_mismatch');
    assert.match(findings[0].message, /0\.6.*0\.1|0\.1.*0\.6/);
  });

  it('accepts a matching value', () => {
    assert.deepEqual(detectExampleDrift('FOO=0.1\n', spec), []);
  });

  it('counts a commented-out assignment as documented (the file\'s style for optional flags)', () => {
    assert.deepEqual(detectExampleDrift('# FOO=0.1\n', spec), []);
  });

  it('does not compare a commented-out value against the default', () => {
    // `# FLAG=true` documents how to turn a flag ON; it is not a claim about the default.
    assert.deepEqual(detectExampleDrift('# FOO=0.9\n', spec), []);
  });

  it('ignores an empty placeholder assignment', () => {
    const secrets: KnobSpec[] = [
      { key: 'SECRET', kind: 'string', requiredness: { kind: 'required' }, binding: 'boot', description: 's' },
    ];
    assert.deepEqual(detectExampleDrift('SECRET=\n', secrets), []);
  });

  it('is one-directional: extra keys in the example are not errors', () => {
    // The example legitimately carries infra keys (Backblaze, cron) the manifest does not enumerate.
    assert.deepEqual(detectExampleDrift('FOO=0.1\nCLOUDINARY_API_KEY=x\n', spec), []);
  });
});

describe('parseEnvExample', () => {
  it('separates documented-ness from active assignment', () => {
    const { documented, active } = parseEnvExample('A=1\n# B=2\n#C=3\n  # D=4\nnot a var\n# a comment\n');
    assert.deepEqual([...documented].sort(), ['A', 'B', 'C', 'D']);
    assert.deepEqual([...active.keys()], ['A']);
    assert.equal(active.get('A'), '1');
  });
});

// ---------------------------------------------------------------------------
// Manifest hygiene.
// ---------------------------------------------------------------------------

describe('manifest hygiene', () => {
  it('declares no duplicate keys', () => {
    const keys = KNOBS.map((k) => k.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('gives every numeric knob a band', () => {
    // A numeric knob without a band is one that can silently take a nonsense value — the exact
    // defect class this manifest exists to remove.
    for (const spec of KNOBS) {
      if (spec.kind === 'int' || spec.kind === 'float') {
        assert.ok(spec.band, `${spec.key} is numeric but has no band`);
      }
    }
  });

  it('gives every enum knob its allowed values, and a default among them', () => {
    for (const spec of KNOBS) {
      if (spec.kind !== 'enum') continue;
      assert.ok(spec.values?.length, `${spec.key} is an enum with no values`);
      if (spec.requiredness.kind === 'optional') {
        assert.ok(
          spec.values?.includes(String(spec.requiredness.default)),
          `${spec.key}'s default is not one of its own allowed values`,
        );
      }
    }
  });

  it('keeps every optional numeric default inside its own band', () => {
    for (const spec of KNOBS) {
      if (!spec.band || spec.requiredness.kind !== 'optional') continue;
      const d = Number(spec.requiredness.default);
      if (!Number.isFinite(d)) continue;
      const ok = spec.band.exclusive
        ? d > spec.band.min && d < spec.band.max
        : d >= spec.band.min && d <= spec.band.max;
      assert.ok(ok, `${spec.key}'s default ${d} is outside its own band — it would report itself`);
    }
  });

  it('no NUMERIC manifest knob is ALSO parsed inline elsewhere', () => {
    // The invariant that makes the manifest worth having. A numeric knob declared here but still
    // parsed inline somewhere has TWO sources of truth, and they can disagree about the parse, the
    // band, or the default — which is not a hypothetical: SIMILARITY_THRESHOLD's inline parse
    // yielded NaN where the band says [0,1], and .env.example's QUALITY_THRESHOLD said 0.6 where
    // the code said 0.1. Post-P2-7 the manifest would report the declared value while the consumer
    // quietly used another, which is worse than the ad-hoc parsing it replaced.
    //
    // Scoped to numeric knobs deliberately, because the other kinds cannot drift this way:
    //   - secrets (JWT_SECRET, DATABASE_URL) are declared for validation + fingerprinting only.
    //     The manifest NEVER returns a secret's value, so their consumers must read process.env
    //     directly — that is the design, not a leak.
    //   - flags use the codebase's canonical `(env ?? 'false').trim().toLowerCase() === 'true'`
    //     idiom, which agrees with `knobBool` by construction — no parser, no band, nothing to
    //     disagree about.
    const numeric = KNOBS.filter((k) => k.kind === 'int' || k.kind === 'float');
    const root = join(__dirname, '..', '..');
    const skip = new Set(['config', '__tests__', 'node_modules', 'dist']);
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;

        const source = readFileSync(full, 'utf8');
        for (const spec of numeric) {
          // `process.env.KEY` or `process.env['KEY']`, ignoring comment lines.
          const re = new RegExp(`process\\.env(\\.${spec.key}\\b|\\['${spec.key}'\\])`);
          const hit = source
            .split('\n')
            .some((line) => re.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*'));
          if (hit) offenders.push(`${spec.key} in ${relative(root, full)}`);
        }
      }
    };
    walk(root);

    assert.deepEqual(
      offenders,
      [],
      `these numeric knobs are declared in the manifest but still parsed inline:\n  ${offenders.join('\n  ')}\n` +
        'Use knobNumber() instead — two parsers for one knob is the defect P2-7 removed.',
    );
  });

  it('no numeric manifest knob is read through a DYNAMIC process.env[...] index', () => {
    // P3-5 (step 0): the check above greps for the LITERAL `process.env.KEY` / `process.env['KEY']`,
    // so an indirection through a variable slips past it entirely. That is not hypothetical —
    // promptAssemblyService had
    //
    //     function readCharBudget(name: string, fallback: number) { const raw = process.env[name]; ... }
    //     export const PROMPT_GUIDELINES_MAX_CHARS = readCharBudget('PROMPT_GUIDELINES_MAX_CHARS', 20000);
    //
    // which honoured any positive integer while `config:check` reported the same value out-of-band.
    // A knob whose runtime value and whose validator disagree is worse than an undeclared one,
    // because the manifest makes it LOOK governed.
    //
    // Scoped deliberately: a dynamic read is only an offence when the SAME FILE also names a
    // declared numeric knob as a string literal. Generic `envInt(name, fallback)` helpers over
    // UNDECLARED keys (app.ts's RATE_LIMIT_*, migrate.ts's MIGRATE_*) are legitimate and stay green
    // — the manifest makes no claim about a knob it does not declare.
    const numeric = KNOBS.filter((k) => k.kind === 'int' || k.kind === 'float');
    const root = join(__dirname, '..', '..');
    const skip = new Set(['config', '__tests__', 'node_modules', 'dist']);
    const offenders: string[] = [];
    // `process.env[` NOT followed by a quote ⇒ a computed index.
    const dynamicRead = /process\.env\[\s*[^'"\s\]]/;

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;

        const source = readFileSync(full, 'utf8');
        const code = source
          .split('\n')
          .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
        if (!code.some((line) => dynamicRead.test(line))) continue;

        for (const spec of numeric) {
          if (code.some((line) => line.includes(`'${spec.key}'`) || line.includes(`"${spec.key}"`))) {
            offenders.push(`${spec.key} in ${relative(root, full)}`);
          }
        }
      }
    };
    walk(root);

    assert.deepEqual(
      offenders,
      [],
      `these files read process.env through a computed index while naming a declared numeric knob:` +
        `\n  ${offenders.join('\n  ')}\n` +
        'Use knobNumber() — a variable index evades the literal-grep check above.',
    );
  });

  it('a clean env produces no fatal and no warn beyond the recommended secrets', () => {
    const findings = applyMode(detect(baseEnv()), 'strict', false);
    assert.deepEqual(findings.filter((f) => f.severity === 'fatal'), []);
    const warned = findings.filter((f) => f.severity === 'warn').map((f) => f.key).sort();
    assert.deepEqual(warned, ['ADMIN_JWT_SECRET', 'ENCRYPTION_KEY', 'META_APP_SECRET', 'WEBHOOK_VERIFY_TOKEN']);
  });
});

// ---------------------------------------------------------------------------
// The WF-G config-drift table, as a fixture.
// ---------------------------------------------------------------------------

describe('WF-G config-drift table (docs/audit/10-runtime-verification.md:39-55)', () => {
  /**
   * The audit's live-config table, encoding TODAY's expected values — NOT the audit's snapshot.
   * Two of its rows (QUALITY_THRESHOLD's example 0.6, OPENAI_CHAT_MODEL's example gpt-4o-mini)
   * were already reconciled by P0-2, so asserting the audit's originals would pin drift that no
   * longer exists. This is the regression fixture P2-7 asks for: it fails if any of these defaults
   * silently move again.
   */
  const EXPECTED: Array<[string, number | string]> = [
    ['SIMILARITY_THRESHOLD', 0.65],
    ['QUALITY_THRESHOLD', 0.1],
    ['INTENT_THRESHOLD', 0.85],
    ['AI_REPLY_TEMPERATURE', 0.3],
    ['AI_MAX_REPLIES_PER_HOUR', 25],
    ['COMMISSION_SESSION_GAP_HOURS', 3],
    ['HUMAN_HOLD_MINUTES', 10],
    ['AI_HISTORY_FETCH_LIMIT', 40],
  ];

  for (const [key, expected] of EXPECTED) {
    it(`${key} still defaults to ${expected}`, () => {
      const spec = KNOBS.find((k) => k.key === key);
      assert.ok(spec, `${key} is not in the manifest`);
      assert.equal(spec.requiredness.kind, 'optional');
      if (spec.requiredness.kind === 'optional') {
        assert.equal(spec.requiredness.default, expected);
      }
    });
  }
});
