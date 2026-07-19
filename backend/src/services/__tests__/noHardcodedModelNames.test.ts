/**
 * P3-6 — "Never hardcode model names" made enforceable.
 *
 * The rule is stated in CLAUDE.md and was stated again by P2-7, and it had still drifted: three
 * call sites carried `OPENAI_VISION_MODEL || 'gpt-4o'`, a dead `||` (vision's terminal IS
 * 'gpt-4o', so `resolveModel` never returns empty) wrapped around a literal that would silently
 * win if the resolver ever did return empty. A convention nothing checks is a convention that
 * decays, and this is the class of decay that makes a tier downgrade partial: an operator sets
 * OPENAI_VISION_MODEL and one call site keeps using gpt-4o.
 *
 * Source-scan style borrowed from `evalIsolation.test.ts` — plain file reads and a regex, no
 * dependency on graph tooling the repo does not have.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

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

/** Directories whose code must route every model choice through `resolveModel`. */
const SCANNED = ['services', 'jobs', 'controllers', 'db'];

/**
 * The only places a model id may legitimately appear as a literal:
 *   - `config/models.ts`  — the role table itself; these ARE the defaults.
 *   - `services/modelPricing.ts` — the price table is keyed BY model id.
 *   - `config/validateEnv.ts` / `scripts/` — boot diagnostics naming a model in a message.
 *   - tests and the eval corpora — fixtures, by definition.
 */
const ALLOWED = [
  'config/models.ts',
  'services/modelPricing.ts',
  'config/validateEnv.ts',
];

/**
 * Matches a quoted OpenAI model id. Deliberately narrow: it looks for the concrete families this
 * codebase can actually send, not any string containing "gpt", so a comment or a prompt mentioning
 * GPT does not trip it.
 */
const MODEL_LITERAL = /['"`](gpt-[0-9][\w.-]*|ft:gpt-[\w.:-]+|text-embedding-[\w.-]+)['"`]/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      // __tests__ and migrations are fixtures / historical SQL; neither sends a request.
      if (entry === '__tests__' || entry === 'migrations') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');

describe('no hardcoded model names on the request path', () => {
  it('every model choice resolves through config/models.ts', () => {
    const offenders: string[] = [];

    for (const subdir of SCANNED) {
      for (const file of walk(path.join(SRC, subdir))) {
        const relPath = rel(file);
        if (ALLOWED.includes(relPath)) continue;

        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
          const trimmed = line.trim();
          // Skip comments — a comment naming a model is documentation, not a routing decision,
          // and several of them legitimately explain WHY a terminal default is what it is.
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('--')) return;
          if (MODEL_LITERAL.test(line)) offenders.push(`${relPath}:${i + 1}  ${trimmed}`);
        });
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `these lines hardcode a model id instead of calling resolveModel(role):\n  ${offenders.join('\n  ')}\n\n` +
        'Add the model to config/models.ts (a role terminal) or config/knobs.ts, and read it from ' +
        'there. A literal here means an operator who re-points a role env var gets a PARTIAL ' +
        'downgrade — some call sites move and this one does not.',
    );
  });

  it('the guard can actually see a violation (guard-on-the-guard)', () => {
    // Without this, a regex that silently stopped matching would make the test above pass forever
    // while enforcing nothing.
    assert.ok(MODEL_LITERAL.test(`const m = OPENAI_VISION_MODEL || 'gpt-4o';`));
    assert.ok(MODEL_LITERAL.test(`model: "gpt-4o-mini",`));
    assert.ok(MODEL_LITERAL.test(`'text-embedding-3-small'`));
    // ...and does not fire on prose that merely mentions the family.
    assert.ok(!MODEL_LITERAL.test('// the gpt-4o family prices cached input at half rate'));
  });
});
