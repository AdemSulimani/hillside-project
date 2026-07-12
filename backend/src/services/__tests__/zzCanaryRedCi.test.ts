import { it } from 'node:test';
import assert from 'node:assert/strict';

// CANARY — deliberately failing test to prove the CI test gate bites.
// This branch/PR is throwaway and must never merge (audit P0-1 validation).
it('canary: CI must fail on a red test', () => {
  assert.equal(1, 2);
});
