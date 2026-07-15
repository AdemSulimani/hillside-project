# Live-test harness

Drives **one real message** through the whole AI pipeline on your local backend, then reports what
actually happened. Nothing is mocked: the webhook is a byte-identical Facebook Messenger POST,
HMAC-signed over the raw body exactly as Meta signs it. The app cannot tell the difference.

## Why bother — typecheck and unit tests both pass on broken code

They only check units. This checks the flags **together** — the gate ladder, P2-4's receipt
snapshot, P2-1's grounding gate, P2-2's order FSM, P2-3's history/cache, P1-1's outbox and staging —
in one flow, which is the only place their interactions show up.

Concretely: the code review of P2-4 Part 2 found three real bugs (a pool deadlock, a silent infinite
retry loop, fabricated telemetry) in code where typecheck and 1035 unit tests were green.

## Run it

```bash
# 0. Is the RUNNING server using the config you think it is?
#    Flags are read at module load. `tsx watch` does NOT watch .env — a server started before an
#    .env edit keeps the old posture and your test silently proves nothing. Always run this first.
npx tsx scripts/livetest/probe-config.ts

# 1. Seed a webhook-addressable channel (idempotent; only needed once)
npx tsx scripts/livetest/seed-test-channel.ts

# 2. Send a message (default: an Albanian catalog question)
npx tsx scripts/livetest/send-test-message.ts
npx tsx scripts/livetest/send-test-message.ts "Sa kushton Serious Mass?"

# 3. Wait ~30s (AI_REPLY_DELAY_MS + generation), then read the durable artifacts
npx tsx scripts/livetest/inspect-result.ts

# The RC-06 acceptance test: toggle AI off mid-window, assert the drop leaves an artifact.
# Self-contained; restores is_active=true on exit, including on failure.
npx tsx scripts/livetest/rc06-toggle-test.ts

# Remove the seeded channel + synthetic contacts/conversations/messages/ledger rows
npx tsx scripts/livetest/cleanup.ts
```

If `.env` changed, restart the backend before testing — or touch a `.ts` file to make `tsx watch`
reload it.

## What it exercises, and where it stops

Everything up to and including the decision ledger. The seeded channel's access token is a real
encryption over a dummy value, so the final outbound Graph API call fails with a
`message_send_failed` alert. **That is the intended boundary** — it is ~95% of the pipeline and 100%
of the part the audit found bugs in. A green run looks like:

| Artifact | Expected |
|---|---|
| outbound message | a real Albanian catalog answer with real prices, `quality_score` ~0.9+ |
| ledger row | `temp=0`, `seed=7` (P2-1 determinism), ~18 OpenAI calls, per-reply USD cost |
| `facts_used` | non-empty — the declared facts the grounding gate judges against |
| alert | `message_send_failed` — the fake-token boundary, not a bug |
| order | none for a question |
| `ai_paused` | `false` — the conversation is not stranded |

`receipt_snapshot` is **null on a delivered reply** and populated only on gate-DROP rows. That is by
design: the snapshot is record-only and exists to explain messages that got discarded. Use
`rc06-toggle-test.ts` to see it populated.

## Cost

A few cents of real OpenAI credit per message (~$0.07 for a 257-product catalog turn, across ~18
calls). Writes to your dev DB only. Uses `LIVETEST_*` ids that `cleanup.ts` removes.

## Overrides

`LIVETEST_TENANT`, `LIVETEST_PAGE_ID`, `LIVETEST_CONTACT_ID`, `LIVETEST_BACKEND`.
