/**
 * P1-7 (RC-09 / SEC-2): unit tests for the pure channel-isolation logic.
 *
 * These cover the multi-match detector and the onboarding-guard predicate — the discrete decisions
 * behind the deterministic resolver and the dual-connect guard. Resolver `ORDER BY` determinism and
 * the migration's global-unique constraint are DB behaviours, covered in the integration test.
 *
 * All tests run purely in-process with no network, DB, or OpenAI calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  channelBindingConflict,
  isCrossTenantConflict,
  buildChannelCollisionAlertDetails,
  MULTIPLE_CHANNELS_MATCHED_REASON,
  type ChannelCollision,
} from '../channelIsolation';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

describe('channelBindingConflict — multi-match detection', () => {
  it('is false for no matches', () => {
    assert.equal(channelBindingConflict([]), false);
  });

  it('is false for a single binding', () => {
    assert.equal(channelBindingConflict([TENANT_A]), false);
  });

  it('is false when duplicate rows all belong to the same tenant', () => {
    // (tenant_id, type, external_id) is already unique, so same-tenant dup rows should not exist —
    // but the detector must be robust to it and not flag a cross-tenant conflict.
    assert.equal(channelBindingConflict([TENANT_A, TENANT_A]), false);
  });

  it('is true when two distinct tenants match the same account', () => {
    assert.equal(channelBindingConflict([TENANT_A, TENANT_B]), true);
  });
});

describe('isCrossTenantConflict — onboarding guard predicate', () => {
  it('is false when there is no existing binding (null / undefined)', () => {
    assert.equal(isCrossTenantConflict(null, TENANT_A), false);
    assert.equal(isCrossTenantConflict(undefined, TENANT_A), false);
  });

  it('is false for a same-tenant reconnect', () => {
    assert.equal(isCrossTenantConflict(TENANT_A, TENANT_A), false);
  });

  it('is true when the account is already bound to a different tenant', () => {
    assert.equal(isCrossTenantConflict(TENANT_B, TENANT_A), true);
  });
});

describe('buildChannelCollisionAlertDetails — tenant-facing alert payload', () => {
  const collision: ChannelCollision = {
    type: 'facebook',
    externalId: 'page-123',
    matchCount: 2,
    tenantIds: [TENANT_A, TENANT_B],
    resolvedTenantId: TENANT_A,
  };

  it('includes the account identity and match count', () => {
    const details = buildChannelCollisionAlertDetails(collision);
    assert.equal(details.type, 'facebook');
    assert.equal(details.external_id, 'page-123');
    assert.equal(details.match_count, 2);
  });

  it('does NOT disclose the other tenants ids to a tenant-facing alert', () => {
    const details = buildChannelCollisionAlertDetails(collision);
    assert.equal('tenant_ids' in details, false);
    assert.equal('resolved_tenant_id' in details, false);
  });
});

describe('MULTIPLE_CHANNELS_MATCHED_REASON', () => {
  it('is the stable system-alert reason string', () => {
    assert.equal(MULTIPLE_CHANNELS_MATCHED_REASON, 'multiple_channels_matched');
  });
});
