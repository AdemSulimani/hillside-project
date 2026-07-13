/**
 * Tests for the self-echo durable-corroboration predicate (P0-7, RC-24).
 *
 * RC-24: Meta echoes every message a Page/IG account sends. On Instagram those echoes carry no
 * `app_id`, so the `isHumanAgentEcho` heuristic reports the AI's own reply as a human agent
 * reply. The Redis self-send registry normally catches our own echoes, but any registry miss
 * (Redis hiccup / evicted key / TTL expiry / echo-before-persist) falls through to the
 * human-agent branch, which sets the sticky `human_replied` flag (disqualifying the use-case
 * fee), a 10-min human hold (silencing the AI), and a phantom `sent_by:'human'` row.
 *
 * Under ECHO_DURABLE_CORROBORATION a no-`app_id` echo is corroborated against a recent outbound
 * we sent before being classified as human, failing toward "not human". Flag OFF must be
 * byte-for-byte legacy: an app_id-less native echo with no registry hit is always human.
 *
 * These exercise the PURE decision core in isolation (no Redis, no DB), mirroring the P0-4
 * `sensitivePathFailClosed` / P0-6 `rateLimitDeliveredCount` split. The self-send registry read
 * and the `findRecentOutboundMessageByContent` lookup live in `jobs/processInboundMessage.ts`,
 * not in this function; the invariant "an outbound we sent never sets human_replied" is
 * enforced by that caller's early return on a positive registry hit.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldClassifyEchoAsHuman } from '../echoDurableCorroboration';

// ---------------------------------------------------------------------------
// flag OFF — legacy byte-for-byte: an app_id-less native echo is always human
// ---------------------------------------------------------------------------

describe('shouldClassifyEchoAsHuman — flag off (legacy app_id-only classification)', () => {
  it('classifies as human even when content matches a recent outbound (no corroboration when off)', () => {
    assert.equal(
      shouldClassifyEchoAsHuman({
        durableCorroborationEnabled: false,
        contentMatchesRecentOutbound: true,
      }),
      true,
    );
  });

  it('classifies as human when content does not match (unchanged legacy path)', () => {
    assert.equal(
      shouldClassifyEchoAsHuman({
        durableCorroborationEnabled: false,
        contentMatchesRecentOutbound: false,
      }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// flag ON — durable corroboration overrides the app_id heuristic
// ---------------------------------------------------------------------------

describe('shouldClassifyEchoAsHuman — flag on (durable corroboration)', () => {
  it('does NOT classify as human when content matches a recent outbound we sent (the RC-24 fix)', () => {
    // The AI's own Instagram reply echoing back on a registry miss — content matches our
    // recent outbound, so it is our echo, not a human handoff.
    assert.equal(
      shouldClassifyEchoAsHuman({
        durableCorroborationEnabled: true,
        contentMatchesRecentOutbound: true,
      }),
      false,
    );
  });

  it('still classifies as human when nothing recent matches (genuine handoff preserved)', () => {
    // A real human agent typing in Meta's native surfaces — content will not match a recent
    // outbound we sent — must still pause the AI.
    assert.equal(
      shouldClassifyEchoAsHuman({
        durableCorroborationEnabled: true,
        contentMatchesRecentOutbound: false,
      }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// full truth table (total function of two booleans)
// ---------------------------------------------------------------------------

describe('shouldClassifyEchoAsHuman — full truth table', () => {
  const cases: Array<[boolean, boolean, boolean]> = [
    // [durableCorroborationEnabled, contentMatchesRecentOutbound, expectedHuman]
    [false, false, true], // legacy: always human
    [false, true, true], // legacy: content match ignored when off
    [true, false, true], // corroboration on, no match → genuine human handoff
    [true, true, false], // corroboration on, content match → our own echo (not human)
  ];

  for (const [durableCorroborationEnabled, contentMatchesRecentOutbound, expected] of cases) {
    it(`(enabled=${durableCorroborationEnabled}, contentMatch=${contentMatchesRecentOutbound}) → human=${expected}`, () => {
      assert.equal(
        shouldClassifyEchoAsHuman({ durableCorroborationEnabled, contentMatchesRecentOutbound }),
        expected,
      );
    });
  }
});
