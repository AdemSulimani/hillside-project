/**
 * P3-4 — the REVERSE fence: the CI-blocking harness must be reachable without an OpenAI key.
 *
 * `services/__tests__/evalIsolation.test.ts` (P2-5) fences one direction — the send path may never
 * reach `src/eval/**`. This file fences the other, and it guards a failure mode that is both more
 * likely and much louder.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. `services/openaiClient.ts:9` THROWS AT MODULE LOAD when
 * `OPENAI_API_KEY` is unset, and constructing the SDK singleton is a load-time side effect. So a
 * corpus author who reaches for `aiService.ts` to borrow one type does not break one test — the
 * import fails during module evaluation and takes the WHOLE eval suite down, in CI, where no key
 * exists. The remediation plan's constraint ("the CI-blocking subset must run offline — no DB,
 * Redis or network") is therefore not advice; it is a property that has to be mechanically held.
 *
 * The paid runners are exempt by name. They are `require.main === module` scripts that only ever
 * run with a real key, and their whole job is to call the provider.
 *
 * Reuses the import-graph walk from `evalIsolation.test.ts` — same technique, opposite direction,
 * no dependency on graph tooling the repo does not have.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Locate `backend/src` by walking up from the cwd (tsx transpiles to CJS — no import.meta). */
function findSrcDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'src');
    if (existsSync(path.join(candidate, 'services', 'aiService.ts'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate backend/src from cwd ${process.cwd()}`);
}

const SRC = findSrcDir();
const EVAL_DIR = path.join(SRC, 'eval');
const OPENAI_CLIENT = path.join(SRC, 'services', 'openaiClient.ts');

/**
 * Modules allowed to reach the OpenAI client: the LLM-as-judge and live-replay runners. Each is a
 * manual script guarded by `require.main === module`, never imported by a test, and never in CI.
 */
const PAID_RUNNERS = [
  'ghegFluency/judge.ts',
  'quality/offlineScorer.ts',
  'quality/parityReport.ts',
  'runners/replayRepeat.ts',
  // P3-6: the model-tier downgrade gate. Calls OpenAI twice per corpus case (baseline arm +
  // candidate arm) and again per `--runs` for the determinism check, so it is squarely paid.
  'runners/tierDowngrade.ts',
];

/**
 * Every module that is a RUNNER rather than part of the CI-blocking harness: the paid ones above
 * plus the DB-backed report. Runners are invoked by hand or by the nightly workflow, so the
 * offline-purity rules below do not apply to them — a report over "the last N days" must read the
 * clock, and forbidding that would just push the same call somewhere less obvious.
 */
const RUNNERS = [...PAID_RUNNERS, 'runners/shadowReport.ts'];

const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');

/**
 * Memoized reads and edge resolution. The fence runs one BFS PER eval module, and those walks
 * overlap almost completely — without caching it re-reads and re-scans the same few hundred service
 * files a few dozen times, which measurably slows `npm test` for no added assurance. The cache is
 * process-local and the file tree does not change mid-run.
 */
const sourceCache = new Map<string, string>();
function readCached(file: string): string {
  let s = sourceCache.get(file);
  if (s === undefined) {
    try {
      s = readFileSync(file, 'utf8');
    } catch {
      s = '';
    }
    sourceCache.set(file, s);
  }
  return s;
}

const edgeCache = new Map<string, string[]>();
function edgesOf(file: string): string[] {
  let edges = edgeCache.get(file);
  if (edges === undefined) {
    edges = [];
    for (const match of readCached(file).matchAll(IMPORT_RE)) {
      const resolved = resolveSpecifier(file, match[1]);
      if (resolved) edges.push(resolved);
    }
    edgeCache.set(file, edges);
  }
  return edges;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  return null;
}

/** BFS the import graph from one entry, returning every reachable file and the trail that reached it. */
function reachableFrom(entryAbs: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entryAbs, [rel(entryAbs)]]]);
  const queue = [{ file: entryAbs, trail: [rel(entryAbs)] }];
  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    for (const resolved of edgesOf(file)) {
      if (seen.has(resolved)) continue;
      const next = [...trail, rel(resolved)];
      seen.set(resolved, next);
      queue.push({ file: resolved, trail: next });
    }
  }
  return seen;
}

/** Every .ts file under src/eval, relative to src. */
function evalFiles(dir = EVAL_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...evalFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const ALL_EVAL_FILES = evalFiles();
const evalRel = (f: string): string => path.relative(EVAL_DIR, f).split(path.sep).join('/');
/** Everything the CI gate can touch — i.e. everything that is not a hand-invoked runner. */
const CI_MODULES = ALL_EVAL_FILES.filter((f) => !RUNNERS.includes(evalRel(f)));

describe('the harness fence is actually walking something', () => {
  it('finds a substantial set of eval modules', () => {
    // Guard on the guard: if discovery broke, every assertion below would pass vacuously forever.
    assert.ok(ALL_EVAL_FILES.length >= 10, `only ${ALL_EVAL_FILES.length} eval files found`);
    assert.ok(CI_MODULES.length >= 8, `only ${CI_MODULES.length} CI-side modules found`);
  });

  it('the OpenAI client exists where the fence expects it', () => {
    assert.ok(existsSync(OPENAI_CLIENT), 'openaiClient.ts moved — the fence is now checking nothing');
    // And it really is load-time fatal, which is the whole premise.
    assert.match(readFileSync(OPENAI_CLIENT, 'utf8'), /throw new Error\('OPENAI_API_KEY is not configured'\)/);
  });

  it('resolves a known-good edge (the walker works)', () => {
    const gate = path.join(SRC, 'eval/harness/tokenMembership.ts');
    const reached = reachableFrom(gate);
    assert.ok(
      reached.has(path.join(SRC, 'services/priceConsistencyGuard.ts')),
      'the walker did not follow a real import — resolution is broken',
    );
  });
});

describe('no CI-side eval module reaches the OpenAI client', () => {
  for (const file of CI_MODULES) {
    it(`${rel(file)}`, () => {
      const reached = reachableFrom(file);
      const trail = reached.get(OPENAI_CLIENT);
      assert.equal(
        trail === undefined,
        true,
        `${rel(file)} transitively imports openaiClient.ts, which throws at module load without ` +
          `OPENAI_API_KEY — this takes the ENTIRE eval suite down in CI.\n  via: ${trail?.join(' -> ')}`,
      );
    });
  }
});

describe('no eval module uses non-reproducible primitives', () => {
  /**
   * A release gate must produce identical results on every machine and every run.
   *
   * `everywhere: true` bans a primitive across all of src/eval; the rest are banned only in
   * CI-blocking modules. The distinction is real, not a loophole: `Math.random` and locale-sensitive
   * string ops have no legitimate use anywhere here (a seeded LCG and NFD folding cover every case),
   * while a report over "the last N days" must read the clock — and a runner is invoked by hand or
   * by the nightly workflow, where time-dependence is the intended behaviour.
   */
  const BANNED: Array<{ pattern: RegExp; why: string; everywhere: boolean }> = [
    {
      pattern: /\bMath\.random\s*\(/,
      why: 'use makeSeededRng — a gate must be reproducible on every machine',
      everywhere: true,
    },
    {
      pattern: /\.localeCompare\s*\(/,
      why: 'locale-sensitive ordering varies by environment',
      everywhere: true,
    },
    {
      pattern: /toLocale(Lower|Upper)Case\s*\(/,
      why: 'locale-sensitive casing (the Turkish dotless-I class)',
      everywhere: true,
    },
    {
      pattern: /\bDate\.now\s*\(/,
      why: 'clock reads make a CI gate time-dependent (runners are exempt)',
      everywhere: false,
    },
    {
      pattern: /\bnew Date\s*\(\s*\)/,
      why: 'clock reads make a CI gate time-dependent (runners are exempt)',
      everywhere: false,
    },
  ];

  for (const file of ALL_EVAL_FILES) {
    const isRunner = RUNNERS.includes(evalRel(file));
    it(`${rel(file)}${isRunner ? ' (runner — clock allowed)' : ''}`, () => {
      const source = readFileSync(file, 'utf8');
      for (const { pattern, why, everywhere } of BANNED) {
        if (isRunner && !everywhere) continue;
        // Skip the line that declares the ban itself.
        const offending = source
          .split(/\r?\n/)
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => pattern.test(line) && !line.includes('pattern:'));
        assert.deepEqual(
          offending.map((o) => `${rel(file)}:${o.n}`),
          [],
          `${pattern} is banned here — ${why}`,
        );
      }
    });
  }
});

describe('the paid runners are quarantined by construction, not by convention', () => {
  for (const runner of PAID_RUNNERS) {
    const full = path.join(EVAL_DIR, runner);
    it(`${runner} — exists and is guarded by require.main === module`, { skip: !existsSync(full) }, () => {
      const source = readFileSync(full, 'utf8');
      assert.match(
        source,
        /require\.main === module/,
        `${runner} can fire a paid run on import — it must only execute when invoked directly`,
      );
    });
  }

  it('no CI-side module imports a paid runner', () => {
    const paidAbs = new Set(PAID_RUNNERS.map((r) => path.join(EVAL_DIR, r)));
    for (const file of CI_MODULES) {
      const reached = reachableFrom(file);
      for (const p of paidAbs) {
        assert.equal(
          reached.has(p),
          false,
          `${rel(file)} reaches the paid runner ${rel(p)} — importing it into CI risks a billed run`,
        );
      }
    }
  });
});
