/**
 * P3-2 Step 6 — process role resolution.
 *
 * The single most important case is the DEFAULT. Every existing deployment sets nothing, so the
 * default is what they get on the first deploy of this change: it must be `'all'` (today's
 * topology, byte-for-byte). A default of `'api'` would silently stop every worker fleet-wide.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProcessRole,
  resolveProcessRoleDetailed,
  roleRunsWorkers,
  roleRunsHttpApi,
  roleHasLocalSocketServer,
  DEFAULT_PROCESS_ROLE,
} from '../processRole';

describe('resolveProcessRole', () => {
  it("defaults to 'all' when unset — the pre-split topology", () => {
    assert.equal(DEFAULT_PROCESS_ROLE, 'all');
    assert.equal(resolveProcessRole({}), 'all');
  });

  it("defaults to 'all' on an empty or whitespace value", () => {
    assert.equal(resolveProcessRole({ PROCESS_ROLE: '' }), 'all');
    assert.equal(resolveProcessRole({ PROCESS_ROLE: '   ' }), 'all');
  });

  it('accepts each known role', () => {
    assert.equal(resolveProcessRole({ PROCESS_ROLE: 'all' }), 'all');
    assert.equal(resolveProcessRole({ PROCESS_ROLE: 'api' }), 'api');
    assert.equal(resolveProcessRole({ PROCESS_ROLE: 'worker' }), 'worker');
  });

  it('is case- and whitespace-insensitive', () => {
    assert.equal(resolveProcessRole({ PROCESS_ROLE: '  WORKER  ' }), 'worker');
    assert.equal(resolveProcessRole({ PROCESS_ROLE: 'Api' }), 'api');
  });

  it("reverts an unrecognised value to 'all' AND reports it", () => {
    // The INTENT_THRESHOLD precedent: reverting silently is how an operator ends up believing they
    // split the fleet while both processes run everything. Reverting to `all` is the safe
    // direction — the worst case is the pre-split topology, never a queue with no consumer.
    const result = resolveProcessRoleDetailed({ PROCESS_ROLE: 'wroker' });
    assert.equal(result.role, 'all');
    assert.equal(result.rejected, 'wroker');
  });

  it('reports no rejection for valid or absent values', () => {
    assert.equal(resolveProcessRoleDetailed({}).rejected, null);
    assert.equal(resolveProcessRoleDetailed({ PROCESS_ROLE: 'worker' }).rejected, null);
  });
});

describe('role capabilities', () => {
  it('all runs both halves', () => {
    assert.equal(roleRunsWorkers('all'), true);
    assert.equal(roleRunsHttpApi('all'), true);
  });

  it('api runs HTTP but no workers', () => {
    assert.equal(roleRunsWorkers('api'), false);
    assert.equal(roleRunsHttpApi('api'), true);
  });

  it('worker runs workers but no HTTP', () => {
    assert.equal(roleRunsWorkers('worker'), true);
    assert.equal(roleRunsHttpApi('worker'), false);
  });

  it('only an HTTP-serving role has a local socket server', () => {
    // This is exactly why PROCESS_ROLE=worker requires SOCKET_CROSS_PROCESS_EMIT.
    assert.equal(roleHasLocalSocketServer('all'), true);
    assert.equal(roleHasLocalSocketServer('api'), true);
    assert.equal(roleHasLocalSocketServer('worker'), false);
  });

  it('every role runs at least one half — no role is a no-op process', () => {
    for (const role of ['all', 'api', 'worker'] as const) {
      assert.ok(
        roleRunsWorkers(role) || roleRunsHttpApi(role),
        `role '${role}' would start a process that does nothing`,
      );
    }
  });
});
