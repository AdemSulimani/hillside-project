/**
 * P3-2 Step 10 — role-aware pool settings.
 *
 * The case that matters most is the one that asserts NOTHING CHANGES: with `PROCESS_ROLE` unset the
 * role is `all`, and every value must equal the pre-split defaults. 65 files import this pool; a
 * silent change to its sizing or session settings would land everywhere at once.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRolePoolSettings,
  buildSessionOptions,
  expectedFleetConnections,
  poolRoleFromProcessRole,
  ROLE_POOL_DEFAULTS,
} from '../poolConfig';

describe('buildRolePoolSettings — the unchanged default', () => {
  it("reproduces the pre-split configuration for role 'all'", () => {
    const settings = buildRolePoolSettings({ role: 'all', env: {} });
    assert.equal(settings.max, 10, 'the historical PG_POOL_MAX default');
    assert.equal(settings.idleTimeoutMillis, 30_000);
    assert.equal(settings.connectionTimeoutMillis, 10_000);
    assert.equal(settings.statementTimeoutMs, 0, "a single-process deploy must not gain a timeout it never had");
    assert.equal(settings.idleInTransactionTimeoutMs, 0);
  });

  it("emits NO session options for role 'all', so connection parameters are unchanged", () => {
    // The strongest form of "nothing changed": libpq receives no `options` string at all, exactly
    // as before. Anything else would be a fleet-wide change shipped without a flag.
    assert.equal(buildSessionOptions(buildRolePoolSettings({ role: 'all', env: {} })), undefined);
  });

  it("emits no session options for 'cli' either — the migration runner uses this pool", () => {
    // db/migrate.ts takes its client from the same pool. A batch that idles between statements past
    // an idle-in-transaction timeout would be killed mid-run, turning a safety net into a failed
    // deploy.
    assert.equal(buildSessionOptions(buildRolePoolSettings({ role: 'cli', env: {} })), undefined);
  });
});

describe('buildRolePoolSettings — per-role divergence', () => {
  it('gives the API a statement timeout and the worker none', () => {
    // This divergence is the actual reason the pool is role-aware: reconcileProductEmbeddings,
    // prepareFinetuning and monthlyUseCaseSnapshot legitimately run for minutes, so a global
    // statement_timeout tight enough to protect an HTTP request would kill them.
    assert.ok(buildRolePoolSettings({ role: 'api', env: {} }).statementTimeoutMs > 0);
    assert.equal(buildRolePoolSettings({ role: 'worker', env: {} }).statementTimeoutMs, 0);
  });

  it('sizes the worker above the API', () => {
    // 22 concurrent job slots vs HTTP concurrency, and processInboundMessage documents a job
    // holding one client while awaiting another — so the budget must cover nested acquisitions.
    const api = buildRolePoolSettings({ role: 'api', env: {} });
    const worker = buildRolePoolSettings({ role: 'worker', env: {} });
    assert.ok(worker.max > api.max);
  });

  it('gives every role a distinct application_name', () => {
    const names = (['api', 'worker', 'all', 'cli'] as const).map(
      (role) => buildRolePoolSettings({ role, env: {} }).applicationName,
    );
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.every((n) => n.startsWith('hillside-')));
  });

  it('sets an idle-in-transaction timeout for the long-lived server roles only', () => {
    // searchProductsBySimilarity and the outbox relay both hold explicit BEGIN/COMMIT blocks. A
    // hung client there blocks autovacuum on `products`, which on a pgvector table is how bloat
    // turns into an outage. Scoped to api/worker: `all` must stay byte-identical to the pre-split
    // config, and `cli` covers the migration runner.
    for (const role of ['api', 'worker'] as const) {
      assert.ok(buildRolePoolSettings({ role, env: {} }).idleInTransactionTimeoutMs > 0);
    }
    for (const role of ['all', 'cli'] as const) {
      assert.equal(buildRolePoolSettings({ role, env: {} }).idleInTransactionTimeoutMs, 0);
    }
  });
});

describe('buildRolePoolSettings — override precedence', () => {
  it('prefers the role-specific override', () => {
    const settings = buildRolePoolSettings({
      role: 'worker',
      env: { PG_POOL_MAX_WORKER: '20', PG_POOL_MAX: '5' },
    });
    assert.equal(settings.max, 20);
  });

  it('falls back to the existing global PG_POOL_MAX', () => {
    // A host that already sets PG_POOL_MAX must keep working exactly as before, in both roles.
    assert.equal(buildRolePoolSettings({ role: 'api', env: { PG_POOL_MAX: '25' } }).max, 25);
    assert.equal(buildRolePoolSettings({ role: 'worker', env: { PG_POOL_MAX: '25' } }).max, 25);
  });

  it('falls back to the role default when neither is set', () => {
    assert.equal(
      buildRolePoolSettings({ role: 'worker', env: {} }).max,
      ROLE_POOL_DEFAULTS.worker.max,
    );
  });

  it('never resolves to a pool of zero, which would deadlock every query', () => {
    for (const raw of ['0', '-4', 'abc', '']) {
      assert.ok(buildRolePoolSettings({ role: 'api', env: { PG_POOL_MAX: raw } }).max >= 1, `input '${raw}'`);
    }
  });

  it('allows an explicit zero to disable a timeout', () => {
    const settings = buildRolePoolSettings({
      role: 'api',
      env: { PG_STATEMENT_TIMEOUT_MS: '0', PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0' },
    });
    assert.equal(settings.statementTimeoutMs, 0);
    assert.equal(settings.idleInTransactionTimeoutMs, 0);
  });
});

describe('buildSessionOptions', () => {
  it('emits both GUCs when both are enabled', () => {
    const options = buildSessionOptions(buildRolePoolSettings({ role: 'api', env: {} }));
    assert.ok(options);
    assert.ok(options.includes('statement_timeout='));
    assert.ok(options.includes('idle_in_transaction_session_timeout='));
  });

  it('omits a disabled GUC entirely', () => {
    const options = buildSessionOptions(buildRolePoolSettings({ role: 'worker', env: {} }));
    assert.ok(options);
    assert.equal(options.includes('statement_timeout='), false);
  });

  it('returns undefined when every GUC is disabled', () => {
    const settings = buildRolePoolSettings({
      role: 'worker',
      env: { PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0' },
    });
    assert.equal(buildSessionOptions(settings), undefined);
  });

  it('emits integers only — never a fractional or exponential value', () => {
    const options = buildSessionOptions(
      buildRolePoolSettings({ role: 'api', env: { PG_STATEMENT_TIMEOUT_MS: '15000' } }),
    );
    assert.match(options ?? '', /-c statement_timeout=\d+/);
  });
});

describe('poolRoleFromProcessRole', () => {
  it('maps each process role onto a pool role', () => {
    assert.equal(poolRoleFromProcessRole('all'), 'all');
    assert.equal(poolRoleFromProcessRole('api'), 'api');
    assert.equal(poolRoleFromProcessRole('worker'), 'worker');
  });
});

describe('expectedFleetConnections', () => {
  it('accounts for replicas plus reserved headroom', () => {
    // 1 api + 1 worker at the defaults, with headroom for migrations and psql.
    assert.equal(
      expectedFleetConnections({ apiReplicas: 1, workerReplicas: 1, apiMax: 10, workerMax: 12 }),
      32,
    );
  });

  it('stays well inside max_connections=80 at the intended fleet size', () => {
    const total = expectedFleetConnections({
      apiReplicas: 1,
      workerReplicas: 1,
      apiMax: ROLE_POOL_DEFAULTS.api.max,
      workerMax: ROLE_POOL_DEFAULTS.worker.max,
    });
    // Deliberate headroom: max_connections=80 already exceeds what a 640M Postgres container can
    // service (~7MB/backend against ~448M after shared_buffers), so the budget should not approach it.
    assert.ok(total < 40, `expected generous headroom, got ${total}`);
  });

  it('scales with replica count', () => {
    const one = expectedFleetConnections({ apiReplicas: 1, workerReplicas: 1, apiMax: 10, workerMax: 12 });
    const two = expectedFleetConnections({ apiReplicas: 2, workerReplicas: 2, apiMax: 10, workerMax: 12 });
    assert.equal(two - one, 22);
  });
});
