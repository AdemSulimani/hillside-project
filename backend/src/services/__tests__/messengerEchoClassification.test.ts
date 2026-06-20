/**
 * Tests for the Meta message-echo classification fix.
 *
 * Background: Meta (Facebook / Instagram) fires a `message.is_echo` webhook for EVERY message a
 * Page sends, including the AI's own Send-API replies. The system previously treated every echo
 * as a human-agent reply, which marked `human_replied` and called `setHumanOverrideHold` —
 * forcing conversations into "Human On Hold" immediately after a normal AI reply.
 *
 * The fix uses Meta's `message.app_id`: it is present only on echoes sent through the Send API
 * (our AI / our inbox UI), and absent on echoes of messages a human agent typed in Meta's native
 * tools. These tests verify:
 *
 *   1. isHumanAgentEcho()                  — the pure classifier (app_id present ⇒ NOT human).
 *   2. webhook normalizer echoAppId        — app_id is extracted from FB & IG echo payloads.
 *
 * All tests run purely in-process with no network, DB, or OpenAI calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHumanAgentEcho,
  webhookNormalizerService,
} from '../webhookNormalizer';

const PAGE_ID = '100000000000001';
const USER_ID = '200000000000002';
const OUR_APP_ID = 1517776481860111;

function facebookEchoPayload(message: Record<string, unknown>): Record<string, unknown> {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: 1700000000000,
        messaging: [
          {
            sender: { id: PAGE_ID },
            recipient: { id: USER_ID },
            timestamp: 1700000000000,
            message,
          },
        ],
      },
    ],
  };
}

function instagramEchoPayload(message: Record<string, unknown>): Record<string, unknown> {
  return {
    object: 'instagram',
    entry: [
      {
        id: PAGE_ID,
        time: 1700000000000,
        messaging: [
          {
            sender: { id: PAGE_ID },
            recipient: { id: USER_ID },
            timestamp: 1700000000000,
            message,
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1.  isHumanAgentEcho — the decision boundary that gates human handoff.
// ---------------------------------------------------------------------------

describe('isHumanAgentEcho', () => {
  it('treats a missing app_id (null) as a human-agent reply', () => {
    assert.equal(isHumanAgentEcho(null), true);
  });

  it('treats an undefined app_id as a human-agent reply', () => {
    assert.equal(isHumanAgentEcho(undefined), true);
  });

  it('treats an empty/whitespace app_id as a human-agent reply', () => {
    assert.equal(isHumanAgentEcho(''), true);
    assert.equal(isHumanAgentEcho('   '), true);
  });

  it('treats a present app_id (Send-API origin) as NOT a human-agent reply', () => {
    assert.equal(isHumanAgentEcho(String(OUR_APP_ID)), false);
  });
});

// ---------------------------------------------------------------------------
// 2.  Webhook normalizer — app_id extraction on echoes.
// ---------------------------------------------------------------------------

describe('webhook normalizer — Facebook echo app_id extraction', () => {
  it('captures app_id from an API-origin echo (the AI reply case)', () => {
    const dto = webhookNormalizerService.normalizeFromFacebook(
      facebookEchoPayload({
        is_echo: true,
        app_id: OUR_APP_ID,
        mid: 'm_ai_reply_1',
        text: 'Hello from the AI',
      }),
    );

    assert.equal(dto.isEcho, true);
    assert.equal(dto.echoAppId, String(OUR_APP_ID));
    assert.equal(isHumanAgentEcho(dto.echoAppId), false);
  });

  it('leaves app_id null for a native human-agent echo (no app_id)', () => {
    const dto = webhookNormalizerService.normalizeFromFacebook(
      facebookEchoPayload({
        is_echo: true,
        mid: 'm_human_reply_1',
        text: 'Hello from a human agent',
      }),
    );

    assert.equal(dto.isEcho, true);
    assert.equal(dto.echoAppId ?? null, null);
    assert.equal(isHumanAgentEcho(dto.echoAppId), true);
  });

  it('does not set echoAppId for normal inbound (non-echo) messages', () => {
    const dto = webhookNormalizerService.normalizeFromFacebook({
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          messaging: [
            {
              sender: { id: USER_ID },
              recipient: { id: PAGE_ID },
              message: { mid: 'm_inbound_1', text: 'a customer question' },
            },
          ],
        },
      ],
    });

    assert.equal(dto.isEcho, false);
    assert.equal(dto.echoAppId ?? null, null);
  });
});

describe('webhook normalizer — Instagram echo app_id extraction', () => {
  it('captures app_id from an API-origin echo (the AI reply case)', () => {
    const dto = webhookNormalizerService.normalizeFromInstagram(
      instagramEchoPayload({
        is_echo: true,
        app_id: OUR_APP_ID,
        mid: 'ig_ai_reply_1',
        text: 'Hello from the AI',
      }),
    );

    assert.equal(dto.isEcho, true);
    assert.equal(dto.echoAppId, String(OUR_APP_ID));
    assert.equal(isHumanAgentEcho(dto.echoAppId), false);
  });

  it('leaves app_id null for a native human-agent echo (no app_id)', () => {
    const dto = webhookNormalizerService.normalizeFromInstagram(
      instagramEchoPayload({
        is_echo: true,
        mid: 'ig_human_reply_1',
        text: 'Hello from a human agent',
      }),
    );

    assert.equal(dto.isEcho, true);
    assert.equal(dto.echoAppId ?? null, null);
    assert.equal(isHumanAgentEcho(dto.echoAppId), true);
  });
});
