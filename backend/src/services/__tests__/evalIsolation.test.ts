/**
 * Architectural test (P2-5, RC-15): the send path must NEVER import the offline eval.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. The offline fluency judge is an LLM-as-judge call. If it
 * ever becomes reachable from `processAIReply`, it turns into an unbudgeted per-message model
 * call on the customer's turn — and the audit already documented exactly that failure: a
 * per-turn quality eval that systematically scored order confirmations 0.200 and paused the AI
 * at checkout. RC-15's conclusion is that fluency belongs offline; the remediation plan makes
 * this explicit ("an architectural test forbids importing it there"). A comment cannot enforce
 * it; an import-graph walk can.
 *
 * Walks the real import graph from the send-path entry points via file reads + a regex over
 * import specifiers. No dependencies — consistent with the house convention (no mocking library,
 * no graph tooling).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Locate `backend/src` by walking up from the cwd. `import.meta.dirname` is unavailable here —
 * tsx transpiles these tests to CJS — and hardcoding a cwd-relative path would silently break
 * the walk if the runner's working directory ever changed. Anchored on a file that must exist.
 */
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

/** The entry points that run on a customer's message. */
const SEND_PATH_ENTRIES = [
  'jobs/processAIReply.ts',
  'services/aiService.ts',
];

/** Nothing reachable from the send path may live under here. */
const FORBIDDEN_DIR = 'eval';

/** Matches `from '...'` / `import '...'` / `import('...')` specifiers. */
const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // package import — not our graph
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  return null;
}

/** BFS the import graph, returning every reachable file plus the path that reached each. */
function reachableFrom(entries: string[]): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: Array<{ file: string; trail: string[] }> = [];

  for (const entry of entries) {
    const abs = path.join(SRC, entry);
    assert.ok(existsSync(abs), `send-path entry not found: ${entry}`);
    queue.push({ file: abs, trail: [entry] });
    seen.set(abs, [entry]);
  }

  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(IMPORT_RE)) {
      const resolved = resolveSpecifier(file, match[1]);
      if (!resolved || seen.has(resolved)) continue;
      const nextTrail = [...trail, path.relative(SRC, resolved).replace(/\\/g, '/')];
      seen.set(resolved, nextTrail);
      queue.push({ file: resolved, trail: nextTrail });
    }
  }

  return seen;
}

describe('the send path never imports the offline eval', () => {
  const reachable = reachableFrom(SEND_PATH_ENTRIES);

  it('reaches a substantial graph (the walk is actually working, not silently empty)', () => {
    // A guard on the guard: if resolution broke, `reachable` would be ~2 files and the real
    // assertion below would pass vacuously forever.
    assert.ok(reachable.size > 20, `only ${reachable.size} files reachable — the walk is broken`);
  });

  it('reaches the modules it obviously should (sanity)', () => {
    const rels = [...reachable.keys()].map((f) => path.relative(SRC, f).replace(/\\/g, '/'));
    assert.ok(rels.includes('services/groundingGate.ts'), 'expected to reach groundingGate');
    assert.ok(rels.includes('services/ghegLexicons.ts'), 'expected to reach ghegLexicons');
    assert.ok(rels.includes('services/platformPolicy.ts'), 'expected to reach platformPolicy');
  });

  it('NEVER reaches src/eval/**', () => {
    const violations: string[] = [];
    for (const [file, trail] of reachable) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      if (rel.split('/')[0] === FORBIDDEN_DIR) {
        violations.push(`${rel}\n      reached via: ${trail.join(' -> ')}`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      `The offline eval is reachable from the send path:\n  ${violations.join('\n  ')}`,
    );
  });

  it('the judge exists and is genuinely outside the reachable set', () => {
    const judge = path.join(SRC, 'eval/ghegFluency/judge.ts');
    assert.ok(existsSync(judge), 'judge.ts is missing — the test would pass vacuously');
    assert.equal(reachable.has(judge), false);
  });

  it('the corpus is importable by tests but not by the send path', () => {
    const corpus = path.join(SRC, 'eval/ghegFluency/corpus.ts');
    assert.ok(existsSync(corpus));
    assert.equal(reachable.has(corpus), false);
  });
});
