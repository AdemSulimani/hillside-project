# Product image requests — root causes, fix, and live validation (2026-07-20)

Branch `fix/alert-noise-pause-policy`. Fixes the two reported photo-request bugs, both reproduced
in the dev DB the same day (real Instagram channel `codevex.dev`, tenant `02beb134…`).

## Root causes

| Report | Finding |
|---|---|
| "AI lists many products I never asked about, then sends one image" | Live capture 16:03 (conv `9e84a4ee…`): "A muni me mi dergu foto produktet" resolved a broad ref against the **entire 10-row retrieval-fusion pool** (`resolveProductsForImageRequest` `all` case + `messages.product_ids` persisting the whole pool), and the canned missing-photo notice enumerated **9 unrequested names**. No scope guard, no cap. |
| "AI says it can't send the image even though the catalog has one" | Live capture 16:20 (conv `21288070…`): "foto nitro techin edhe carbo limonin" — Gheg definite-accusative inflection defeats exact/substring name matching AND the `%ILIKE%` catalog recovery → **zero targets → silent fall-through ships the raw model reply**, and the model (told nothing about photo capability) improvises "Na vjen keq, por aktualisht nuk mund të dërgojmë foto…". A second instance of the same class: the `mightBeImageRequest` pre-screen required bare `\bfoto\b`, so the inflected "foto**n**" skipped the whole deterministic flow (found live during validation, scenario 1). |
| (found during validation) | A named ref absent from the retrieval pool whose catalog row is **imageless** vanished silently: `augmentImageTargetsFromCatalog` only recovered imaged rows, so no notice and no alert fired for it (scenario 2, first run). |

## Fix (deterministic-first: LLM only for intent + ref extraction)

1. **`productImageRequestService.ts` overhaul** — pure and fully unit-tested:
   - `albanianTokenStems` / `productNameTokenMatch`: inflection-tolerant token matching
     ("nitro techin" ↔ "Nitro Tech Ripped", "carbo limonin" ↔ "Carbo one 1kg Limon").
   - `filterProductsMentionedInTexts`: broad refs (`all`/`current`/positions) now resolve against
     products **actually named in recent AI replies** (Tier A full-name, Tier B lead-tokens only
     for families Tier A didn't resolve) — never the raw retrieval pool; empty evidence degrades
     to top-1.
   - Hard cap `IMAGE_REQUEST_MAX_TARGETS` (3) + per-ref match-method trace.
   - `augmentImageTargetsFromCatalog` ladder: raw ILIKE → stemmed-token ILIKE (token-filtered) →
     pg_trgm `word_similarity` at `IMAGE_REQUEST_NAME_SIMILARITY_THRESHOLD` (0.48, own knob);
     when no imaged row exists anywhere, the best **imageless** catalog match becomes a target so
     the notice + alert name it. Lookups injectable for tests.
   - `decideImageRequestOutcome` + `buildImageReplyText`: pure decision core; a detected photo
     request **never ships the raw model reply** (zero targets → holding line). Missing-name
     enumeration capped at `IMAGE_REQUEST_MAX_MISSING_NAMES` (2), beyond which one generic line.
2. **`processAIReply.ts`**: wiring only; zero-target and error paths send holding copy + set
   `unresolved_reference` details; both alert sites (staged outbox + legacy) fire
   `product_image_unavailable` with `details.kind: 'missing_image' | 'unresolved_reference'`;
   `recordDecision({classifier:'product_image_request', branch: outcome})` lands in the ledger;
   structured `[image_request] resolution` / `unresolved` logs. No guard reordering, a message
   ships on every branch (billing/analytics untouched).
3. **`mightBeImageRequest`**: Albanian photo nouns accept inflection suffixes (`foto\w*` etc.).
4. **Prompt**: always-on `photo_capability` section (sq/en) + platform rule **R18** — the system
   sends photos automatically; never claim otherwise. Per-product image availability deliberately
   NOT injected into the catalog context (the deterministic path is the authority).
5. **Templates registered in `cannedReplyText.ts`** (`IMAGE_REPLY_TEMPLATES` + sentinel-derived
   patterns) so `isCannedHoldingCopy` relabels delivered photo copy in the P2-3 transcript.

Knobs (manifest + `.env.example`): `IMAGE_REQUEST_MAX_TARGETS=3`, `IMAGE_REQUEST_MAX_MISSING_NAMES=2`,
`IMAGE_REQUEST_NAME_SIMILARITY_THRESHOLD=0.48`. New model fn `findActiveProductsByNameSimilarity`
(pg_trgm rows sibling). **No migration.**

## Offline validation

- `npm test`: **2201/2201** (469 suites) — includes 35 new tests in
  `productImageRequest.test.ts` (stems, token match, mention scan, resolver replays of both live
  bugs, augment ladder incl. imageless fallback, outcome/template caps, canned-copy recognition)
  and the R18 parity pins in `platformPolicy.test.ts`.
- `npm run typecheck` clean; `npm run config:check` OK (124 frozen knobs).

## Live validation (dev backend, recreated LIVETEST Facebook channel `aec28f9d…`,
external_id `100000000000001` — fake page, so every send fails with the expected notify-only
`message_send_failed`; signed webhook turns, senders `…071-079`)

| # | Scenario (sender) | Result |
|---|---|---|
| 1 | Inflected single name "…foton e nitro techit?" (…071/072) | First run EXPOSED the pre-screen gap (raw model reply). After fix: `"Ja foto e Nitro Tech Ripped:"`, ledger `send_images`, no other names. |
| 2 | **Bug #2 verbatim replay** "foto nitro techin edhe carbo limonin…" (…073/074) | First run exposed the imageless-vanish gap (only 1 target). After fix: `"Ja foto e Nitro Tech Ripped:\nFoto e Carbo one 1kg Limon do të ju dërgohet së shpejti."` + alert `kind=missing_image` naming exactly Carbo one 1kg Limon; ledger `send_images` raw_score 2; **no apology, no pause**. |
| 3 | **Bug #1 replay** — discuss both, then "A muni me mi dergu foto produktet…" (…075) | Targets = exactly the 3 discussed products (Ripped + both Carbo flavors the AI offered); notice names 2 (= cap); **no 9-name enumeration**; alert lists both Carbo variants. |
| 4 | Imageless product by name "foto e beast pre workout mango" + follow-up (…076) | Holding line, alert `kind=missing_image` (`Beast pre-workout 30servime Mango`), ledger `holding_missing_images`, `ai_paused=false`, follow-up question still answered. |
| 5 | Nonexistent product + foto (…077) | The grounding gate escalated first (`hallucinated_product_name`, pause) and the image block correctly stood down — escalations own the turn by design. `unresolved_reference` path pinned by unit tests. |
| 6 | Keyword-dodging "A muj me pa qysh duket nitro tech ripped…" (…078) | Classifier can't fire (no photo keyword) → raw model reply, and with R18/photo_capability it says the photo comes automatically — **no capability denial** (pre-fix: the 16:20 apology). |
| 7 | Every requested product imaged (Carbo temp image, …079) | `"Ja fotot e produkteve të kërkuara:"`, ledger `send_images` raw_score 2, **zero** `product_image_unavailable`. Carbo image restored to `[]` after. |

## Dev-data notes / cleanup

- LIVETEST channel `aec28f9d-6e57-44dd-a68f-c43da2e765e6` recreated (the earlier `b671a365…` had
  been deleted) — keep for future live validation or delete via the Channels UI.
- Test traffic: senders `9000000000000071-079`; conv `6681093a…` (scenario 5) left paused as
  grounding-escalation evidence. "Carbo one 1kg Limon" `image_urls` restored to `[]`.
- Known pre-existing quirk observed (out of scope): a cold-context "sa kushton X" turn can claim a
  catalog product is unavailable when retrieval misses it (scenario 4 follow-up).

## Rollback

Revert the commits; no schema change, no eval-harness impact. Knobs are additive with safe
defaults; the pre-fix behavior had no flag (the old resolver is replaced, pinned by tests).
