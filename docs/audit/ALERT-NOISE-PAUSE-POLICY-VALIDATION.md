# Alert-noise fix + pause-policy — live validation evidence (2026-07-20)

Branch `fix/alert-noise-pause-policy`. Root-cause analysis, fixes, and live evidence for the two
reported alert-system issues. **No AI reply-generation, classifier, gate-outcome, or pause-wiring
behavior was changed** — alert emission, dedup, policy documentation, and UI only.

## Root causes

| Report | Finding |
|---|---|
| "Unnecessary alert on order intent with missing customer info" | `confidence_band_abstain` (P1-3) alerted on EVERY in-band gate score. The observed case: `order_intent_score` 0.80 vs threshold 0.85 (band 0.05) while name/phone/address were missing — the score was not the binding constraint (no order possible at any score), the AI was correctly mid-collection. Also fired on in-band NEGATIVE verdicts of boolean-intent gates. |
| (found during investigation) | `prompt_assembly_violation` alerted on EVERY reply: the dedupe key embedded the varying prompt length (`"39458 > 34000"`), so the one-alert-per-catalog-epoch design never deduped. Six distinct Redis keys for the same condition were live in dev. |
| "AI does not pause after genuine escalations" | **Not reproduced.** 14-day DB audit: every pausing-reason alert had `ai_paused=true` and zero AI messages after it. The perception came from notification-type alerts (`product_image_unavailable`, `message_send_failed`, `confidence_band_abstain`, `provider_unavailable`, `prompt_assembly_violation`) rendering identically to escalations in the AI Alerts UI. |

## Fixes

1. `logConfidenceGateBoundary` takes a required `alertEligible` arg — the alert (not the
   `[CONFIDENCE_GATE]` log) fires only when the in-band score was the binding constraint:
   order gate → all non-score draft-order conjuncts hold (`orderSlotsBindOnScore`); boolean
   gates → positive intent verdict. Pinned by new invariants in
   `replyPathSourceInvariants.test.ts`.
2. `promptAssemblyAlerts.dedupeDetailFor` — over_budget dedup keys on the budget cap, not the
   varying size.
3. `services/alertPausePolicy.ts` — the descriptive reason → `pauses | notify_only` map for all
   26 alert reasons, pinned against the pipeline source by `__tests__/alertPausePolicy.test.ts`
   (21 pause stamps, 28 alert sites, dynamic reason unions, sensitive ⊆ pauses).
4. AI Alerts page: severity badge per alert — "AI paused — needs human" (destructive) vs
   "Info — AI still replying" (secondary), via the mirrored `frontend/src/lib/alertPausePolicy.ts`;
   labels added for `order_info_updated`, `product_image_unavailable`, `prompt_assembly_violation`.

## Offline validation

- `npm test`: **2165/2165** (461 suites) — includes the 3 new/extended test files.
- `npm run typecheck`: clean. `frontend npm run build` (tsc -b + vite): clean.

## Live validation (dev: tenant `02beb134…`, recreated LIVETEST Facebook channel
`external_id 100000000000001` — fake page, so every send fails with the expected notify-only
`message_send_failed`; signed webhook turns via scratchpad harness, fresh senders `…061-065`)

| # | Scenario | Result |
|---|---|---|
| 1 | **User's exact case** — "A muna me porosit qita mega mass 3kg qokollad", no customer info (sender …061, conv `9eb90083…`) | Log shows `[CONFIDENCE_GATE] order_intent_score abstain confidence 0.8` with `hasPhone:false hasAddress:false` → **zero `confidence_band_abstain` rows** (pre-fix this exact turn alerted). AI asked for details; details turn scored 0.9 → **draft order created** (Mega mass 3kg Qokolad €55, commissionable). |
| 2 | **Binding case** — restart with `INTENT_THRESHOLD=0.92`; one-message order with full name/phone/address (sender …062) | `ORDER_COLLECTION_STATE` all slots true, score 0.9 in band → **exactly one** `confidence_band_abstain` (details `{threshold:0.92, confidence:0.9}`), **no draft order**. The genuine warm-lead signal survives. Threshold restored after. |
| 3 | **Prompt-assembly spam** — dev prompt is over budget (37–45k > 34000) on every turn | Across ~10 AI turns: **exactly 1** `prompt_assembly_violation` row (first claim of the new `cap:34000` key). Pre-fix: 1 per reply. |
| 4 | **Escalation still pauses** — unanswerable nutrition question (sender …063) | `product_question_unanswered` alert + `ai_paused=true` (reason stamped) + holding reply; follow-up inbound hit `AI paused for conversation, skipping`, **0 outbound after pause**. |
| 5 | **Notify-only stays live** — photo request over image-less products (sender …065) | `product_image_unavailable` alert, `ai_paused=false`; follow-up price question answered normally ("€50.00"). |
| bonus | Real OpenAI 429 mid-turn during a …064 turn | P2-6 floor: `provider_unavailable` alert, **no pause** from it — observed live. |

Alert totals in the window (15:49–16:04 UTC): `message_send_failed` 9 (fake page, expected),
`product_question_unanswered` 2 (both paused), `confidence_band_abstain` 1 (engineered binding
case only), `prompt_assembly_violation` 1, `provider_unavailable` 1, `product_image_unavailable` 1.

## Dev-data notes / cleanup

- Recreated channel `b671a365-7526-4e92-b868-c62ab5486716` (LIVETEST Facebook, fake token) —
  keep for future live validation or delete via the Channels UI.
- Test traffic: `contacts.external_id LIKE '9000000000000%'` (senders 061–065), incl. one draft
  order on conv `9eb90083…` and two paused conversations (063/064) left paused as evidence.
- Old-format `prompt_assembly_alert:*` Redis keys age out via their 7-day TTL.

## Rollback

Revert the three commits; no schema, no knobs, no eval-harness impact.
