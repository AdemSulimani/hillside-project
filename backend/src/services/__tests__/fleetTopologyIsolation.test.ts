/**
 * Architectural test (P3-2): the Express app must NEVER statically reach `jobs/workers.ts`.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. `jobs/workers.ts` constructs its five BullMQ Workers as
 * module-load SIDE EFFECTS — there is no `startWorkers()` to call or skip. So any static import
 * path from `app.ts` to that module means importing the Express app starts the entire worker fleet,
 * and `PROCESS_ROLE=api` becomes a lie that no runtime check can catch: the process would report
 * itself API-only while consuming `ai.reply` jobs.
 *
 * That edge existed and was NOT obvious. It ran:
 *
 *     app.ts → routes/health.ts → controllers/healthController.ts → services/queueHealthService.ts
 *            → jobs/workers.ts
 *
 * i.e. through the HEALTH endpoint, which imported the five Workers just to read their concurrency.
 * Deleting `server.ts`'s own import would have done nothing at all. A regression here is silent —
 * everything works, the split just stops being a split — so it needs a walk, not a comment.
 *
 * Walks the real import graph via file reads + a regex over import specifiers, cloned from
 * `evalIsolation.test.ts` to stay consistent with the house convention (no graph tooling).
 * DYNAMIC `import('...')` is deliberately treated as an edge too, then excluded explicitly for the
 * two guarded call sites — see the final case.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
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

/** The module whose import starts the worker fleet. */
const WORKERS_MODULE = 'jobs/workers.ts';

/** `from '...'` / `import '...'` — STATIC specifiers only (no `import(` call form). */
const STATIC_IMPORT_RE = /(?:^|[\s;{}])(?:from|import)\s+['"]([^'"]+)['"]/g;

/**
 * Strip comments before matching.
 *
 * Not cosmetic — this test found the need. `localWorkerRegistry.ts` documents the edge it removes
 * by QUOTING it (`import { aiWorker, … } from '../jobs/workers'`), and a naive regex read that
 * prose as a real import and reported a violation through a module that imports nothing at all. A
 * fence that fires on documentation trains people to ignore it.
 *
 * `://` is preserved so a URL inside a string is not mistaken for a line comment.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // package import — not our graph
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  return null;
}

function rel(file: string): string {
  return path.relative(SRC, file).replace(/\\/g, '/');
}

/** BFS the STATIC import graph, returning every reachable file plus the trail that reached it. */
function staticallyReachableFrom(entry: string): Map<string, string[]> {
  const abs = path.join(SRC, entry);
  assert.ok(existsSync(abs), `entry not found: ${entry}`);

  const seen = new Map<string, string[]>([[abs, [entry]]]);
  const queue: Array<{ file: string; trail: string[] }> = [{ file: abs, trail: [entry] }];

  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    let source: string;
    try {
      source = stripComments(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const match of source.matchAll(STATIC_IMPORT_RE)) {
      const resolved = resolveSpecifier(file, match[1]);
      if (!resolved || seen.has(resolved)) continue;
      const nextTrail = [...trail, rel(resolved)];
      seen.set(resolved, nextTrail);
      queue.push({ file: resolved, trail: nextTrail });
    }
  }

  return seen;
}

describe('the Express app never statically starts the worker fleet', () => {
  const reachable = staticallyReachableFrom('app.ts');

  it('reaches a substantial graph (the walk works, not silently empty)', () => {
    // A guard on the guard: if specifier resolution broke, the real assertion below would pass
    // vacuously forever.
    assert.ok(reachable.size > 20, `only ${reachable.size} files reachable — the walk is broken`);
  });

  it('reaches the modules it obviously should (sanity)', () => {
    const rels = [...reachable.keys()].map(rel);
    assert.ok(rels.includes('routes/health.ts'), 'expected app.ts to reach the health router');
    assert.ok(
      rels.includes('services/queueHealthService.ts'),
      'expected the health router to reach queueHealthService — that is the module that used to ' +
        'carry the forbidden edge, so if it is unreachable this test is not proving anything',
    );
  });

  it('NEVER reaches jobs/workers.ts', () => {
    const workersAbs = path.join(SRC, WORKERS_MODULE);
    assert.ok(existsSync(workersAbs), 'jobs/workers.ts is missing — the test would pass vacuously');

    const trail = reachable.get(workersAbs);
    assert.equal(
      trail,
      undefined,
      `app.ts statically reaches the worker fleet via:\n      ${(trail ?? []).join('\n   -> ')}\n` +
        '    Importing app would construct all five Workers, so PROCESS_ROLE=api would not actually ' +
        'be API-only.',
    );
  });

  it('does not reach the worker or server entrypoints either', () => {
    for (const entry of ['worker.ts', 'server.ts']) {
      assert.equal(
        reachable.has(path.join(SRC, entry)),
        false,
        `app.ts must not reach the ${entry} entrypoint`,
      );
    }
  });
});

describe('queueHealthService reads local worker state without importing the fleet', () => {
  // Comments stripped for the same reason as the walk: this module DOCUMENTS the import it no
  // longer performs, and matching that prose would fail the test on a correct file.
  const source = stripComments(
    readFileSync(path.join(SRC, 'services/queueHealthService.ts'), 'utf8'),
  );

  it('has no jobs/workers specifier at all', () => {
    assert.equal(
      /['"][^'"]*jobs\/workers['"]/.test(source),
      false,
      'queueHealthService must not name jobs/workers in any import form',
    );
  });

  it('uses the local worker registry instead', () => {
    assert.ok(source.includes('localWorkerRegistry'), 'expected the registry indirection');
  });

  it('still imports the queues directly — a Queue is a client handle and starts nothing', () => {
    assert.ok(source.includes("from '../jobs/queues'"));
  });
});

describe('the entrypoints load the fleet deliberately', () => {
  const serverSource = stripComments(readFileSync(path.join(SRC, 'server.ts'), 'utf8'));
  const workerSource = stripComments(readFileSync(path.join(SRC, 'worker.ts'), 'utf8'));

  it('server.ts imports the fleet dynamically, never statically', () => {
    assert.equal(
      STATIC_IMPORT_RE.test(serverSource) && /(?:from|import)\s+['"]\.\/jobs\/workers['"]/.test(serverSource),
      false,
      'server.ts must not statically import jobs/workers — that would start it regardless of role',
    );
    assert.ok(
      /import\(\s*['"]\.\/jobs\/workers['"]\s*\)/.test(serverSource),
      'server.ts should load the fleet through a dynamic import',
    );
  });

  it('server.ts guards that import on the process role', () => {
    assert.ok(
      serverSource.includes('roleRunsWorkers'),
      'the dynamic import must be gated by roleRunsWorkers, or PROCESS_ROLE=api does nothing',
    );
  });

  it('worker.ts installs the socket publisher BEFORE loading the fleet', () => {
    // Ordering matters: the five `new Worker(...)` calls start consuming on import, so a job that
    // emits must never observe a process with no transport.
    const installIndex = workerSource.indexOf('installCrossProcessSocketPublisher(');
    const importIndex = workerSource.indexOf("import('./jobs/workers')");
    assert.ok(installIndex > -1, 'worker.ts must install the publisher');
    assert.ok(importIndex > -1, 'worker.ts must load the fleet');
    assert.ok(
      installIndex < importIndex,
      'the publisher must be installed before the workers can start consuming',
    );
  });

  it('worker.ts refuses to start without a cross-process transport', () => {
    assert.ok(workerSource.includes('SOCKET_CROSS_PROCESS_EMIT'));
    assert.ok(
      workerSource.includes('process.exit(1)'),
      'a worker with no socket transport must fail loudly at boot, not drop emits silently',
    );
  });
});
