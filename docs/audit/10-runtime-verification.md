# Phase 10 — Runtime Verification

> **Evidence base:** All findings below are grounded in source code (file:line cited) and, where noted, the dev/staging database (6 tenants / 46 conversations / 374 messages / 617 products / 20 ai_alerts). Dev data demonstrates mechanisms, not production incidence rates. Live-replay experiments in this phase were run against the local dev stack with the project OpenAI key (user-approved); any test rows written are inventoried in the "Test-data inventory" section. See appendix-A-evidence-log.md for verbatim query evidence.

This phase does the one thing prior phases could not: it holds the static findings against the **running system** — the live Postgres schema/data, the live Redis keyspace, the resolved runtime config, the real ANN query plan, and 81 live OpenAI calls. Prior phases are cited by their register IDs (DP-xx from Phase 3, C-xx from Phase 9, EV-xxx from the evidence log, S-xx from the step ledger). Runtime evidence is EV-033 – EV-044. Observations only — no fixes.

---

## Static claims confirmed against runtime

| # | Prior claim (id) | Runtime evidence | Verdict |
|---|------------------|------------------|---------|
| 1 | `products.embedding` is `vector(1536)`; cosine retrieval (Phase 1 vector-storage audit) | EV-033: `atttypmod=1536`, `format_type=vector(1536)`; all **614 non-null vectors across 617 rows = 1536-dim**, no variant survivors. `pgvector 0.8.2` (EV-039). | **CONFIRMED** |
| 2 | Global HNSW index; tenant scoping is a co-filter, not an index dimension (retrieval seed; C-02) | EV-034: `idx_products_embedding` + `idx_pif_embedding_hnsw` are both HNSW / `vector_cosine_ops` / partial (`WHERE embedding IS NOT NULL`, products also `AND deleted_at IS NULL`). **Neither index carries `tenant_id`.** | **CONFIRMED** |
| 3 | `OPENAI_EMBEDDING_MODEL` default is `text-embedding-3-large` (CLAUDE.md §10) | EV-035: **100% of live product vectors (258/258, 0 null) were written by `text-embedding-3-small`**; the single fingerprint row too. Zero rows carry a 3-large tag. `-small` is natively 1536-dim — exactly why it fits the column. | **REFUTED** |
| 4 | `OPENAI_FINETUNING_BASE_MODEL` = `gpt-4o-mini-2024-07-18` (code default + `.env.example`) | config.md: live `.env` = **`gpt-4o-2024-11-20`** (full gpt-4o snapshot). Documented/coded default contradicts the live value. | **REFUTED** |
| 5 | Chat model is full `gpt-4o` (CLAUDE.md §10 example) | config.md: live `.env` = `gpt-4o` (confirms CLAUDE.md), but **`.env.example` template says `gpt-4o-mini`** — anyone bootstrapping from the example silently runs the weaker/cheaper chat model. | **REFINED** (doc correct; example template drifts) |
| 6 | `QUALITY_THRESHOLD` default `0.1` (CLAUDE.md §10) | config.md: live+code = **`0.1`** (confirmed); `.env.example` = `0.6` (6× stricter). Live floor is very lenient — only replies scoring `< 0.10` trip the quality alert. | **CONFIRMED** (with example drift) |
| 7 | Embedding **dimension landmine is ACTIVE** (3-large → 3072 dims vs `vector(1536)` column; retrieval seed, embeddingService.ts:12-15) | config.md + EV-035: live `.env` explicitly pins `-small` (1536), so the mismatch **cannot fire today**. The **code default** (`openaiClient.ts:35-36`) is `-large` (3072) — unset the env var in any environment and inserts/queries silently corrupt. | **REFINED → DORMANT but armed** |
| 8 | SEC-2 dual-connect is the genuine isolation defect (C-115, `channel.ts:119-128`) | EV-038: channels unique key `= (tenant_id, type, external_id)` — **includes `tenant_id`; no global `(type, external_id)` guard**, so the DB permits two tenants to bind the same account. `HAVING count(DISTINCT tenant_id)>1` returned **zero rows only because the `channels` table is empty (0 rows).** | **REFINED → schema-permits CONFIRMED, unrealized in data** |
| 9 | Duplicate `062` migrations both apply via lexicographic `.sort()` (C-48/C-150/C-151) | EV-037: `_migrations` keys on **filename**, not numeric prefix; both `062_*` applied (id 65 → 66). **062, 063, 064, 065 each exist twice** (offers branch + guidelines branch); `065_offers` (id 69) ran a **day before** `063_catalog_grounding` (id 70). Numeric prefix is no longer an ordering contract. | **CONFIRMED (broader than claimed)** |
| 10 | `pg_trgm` installed but `similarity()` never called; typo tolerance dormant (EV-032) | EV-036: `pg_trgm 1.6` installed, **five `gin_trgm_ops` indexes** on products, **zero `similarity()` calls** in `backend/src`. Trigram indexes only accelerate `ILIKE`; fuzzy recall for "optium"/"standart" never fires. | **CONFIRMED** |
| 11 | Application-level tenant isolation (no RLS) is clean on the join graph | EV-038: 0 messages under a null-tenant conversation, 0 conversation↔contact mismatches, 0 order↔conversation mismatches. | **CONFIRMED (in dev data)** |
| 12 | `SIMILARITY_THRESHOLD=0.65` admits "same category" product matches for injection | EV-043: on the 257-row tenant pool, **only the identical self-vector (sim 1.0) clears 0.65 — and 0.60**. Closest *distinct* catalog item = **0.594**, below both cutoffs. Same-category neighbours (gloves/belts) sit 0.54–0.59 and are filtered out. | **REFINED → floor admits only exact/near-dup with `-small`** |
| 13 | Global HNSW → recall-starvation at scale (retrieval seed) | EV-043: at dev scale the planner **does not use HNSW** (exact Seq Scan), AND only **1** product in the entire DB belongs to another tenant — the crowding mechanism is **doubly unrealized**. Valid *design* concern at scale; not observable now. | **REFINED → unrealized in dev** |
| 14 | Issue-1: identical input → divergent OUTCOMES (EV-025 dev-data Q9 = 60 divergent pairs; Phase 3 divergence trees) | EV-044: **measured live** — identical input → up to **8/8 distinct replies**; reply arm answers while escalate arm flags 8/8 on the same correct catalog question. | **CONFIRMED (now empirically measured)** |
| 15 | C-145: CI omits `npm test`; the suite exists and is non-trivial | EV-043 (test run): `npm test` = **548 pass / 0 fail / 75 suites**, fully offline. Confirms a green, non-trivial suite that CI never executes. | **CONFIRMED** |

**Tally:** 8 CONFIRMED · 2 REFUTED · 5 REFINED.

The two REFUTED items are both **documentation-vs-reality model drifts** (embedding default, finetuning base) — CLAUDE.md §10 and the code defaults describe a system that is not the one running. The five REFINED items are all "the mechanism is real but the dev snapshot disarms or hides it" (dimension landmine dormant, SEC-2 unrealized because 0 channels, HNSW dormant at scale, threshold behavior sharper than assumed). None of the refinements *weaken* the underlying finding — they pin down its live activation state.

---

## Live configuration (the real models)

The values actually in effect at runtime (`live` = `.env` when present, else code default). Source: config.md, cross-checked against EV-035.

| Knob | LIVE value | Documented / example | Note |
|------|-----------|----------------------|------|
| `OPENAI_CHAT_MODEL` | **`gpt-4o`** (full) | example: `gpt-4o-mini` | Main reply + ~28 classifiers all run on this. |
| `OPENAI_VISION_MODEL` | `gpt-4o` | `gpt-4o` | No drift. |
| `OPENAI_INTENT_MODEL` | `gpt-4o` | `gpt-4o` | Dedicated env, honored. |
| `OPENAI_EVAL_MODEL` | `gpt-4o` | `gpt-4o` | Dedicated env, honored. |
| `OPENAI_EMBEDDING_MODEL` | **`text-embedding-3-small`** (1536-dim) | CLAUDE.md/code: `text-embedding-3-large` (3072) | Live pins `-small`; this is what disarms the landmine. |
| `OPENAI_FINETUNING_BASE_MODEL` | **`gpt-4o-2024-11-20`** | code/example: `gpt-4o-mini-2024-07-18` | Full snapshot in live. |
| `SIMILARITY_THRESHOLD` | `0.65` | `0.65` | No drift; see EV-043 for its effect on `-small`. |
| `QUALITY_THRESHOLD` | **`0.1`** | example: `0.6` | Very lenient live floor. |
| `INTENT_THRESHOLD` | `0.85` | `0.85` | Draft-order gate. |
| `AI_REPLY_TEMPERATURE` | **`0.3`** (unset → code default) | not in CLAUDE.md env table | The direct driver of reply-wording divergence (EV-044). |
| `AI_MAX_REPLIES_PER_HOUR` | `25` | `25` | Per-conversation. |
| `COMMISSION_SESSION_GAP_HOURS` | `3` | `3` | — |
| `HUMAN_HOLD_MINUTES` | `10` | ~10 | — |
| `AI_HISTORY_FETCH_LIMIT` | `40` (unset → code) | `40` | — |
| `ADMIN_KEY` | **unset** in `.env` | required for Bull Board | Bull Board / admin-key path has no key configured in this env. |

### Which static findings are ACTIVE vs DORMANT given live config

- **Dimension landmine (retrieval seed / EV-035): DORMANT.** Live `.env` explicitly sets `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`, which is natively 1536-dim and matches the column. It is dormant **only because the env var is pinned** — the code default (`-large`, 3072) and CLAUDE.md's documented default are the armed version. Any environment that omits the key gets the landmine.
- **`modelGuard` mismatch (EV-043 risk #1): DORMANT but coupled to the same pin.** `searchProductsBySimilarity` applies `AND (embedding_model IS NULL OR embedding_model=$4)`. Stored vectors are all `-small`; as long as the query path also embeds with `-small`, the guard passes. If the query path ever embeds with `-large` and passes `expectedModel='text-embedding-3-large'`, **all 257 rows are excluded → zero retrieval**. Same single pin protects both.
- **QUALITY_THRESHOLD gate: ACTIVE and very lenient.** Live `0.1` means only near-zero-quality replies alert. In EV-044, IN1's degenerate `"Po."` scored **0.20** — above the live floor, so it would **not** trip the quality alert (it would trip at the example's `0.6`). The lenient live floor is why low-value replies ship.
- **SIMILARITY_THRESHOLD 0.65 on `-small`: ACTIVE and near-binary.** Per EV-043, only exact/near-duplicate vectors clear it; genuine same-category neighbours (0.54–0.59) do not. With `-small` this floor makes the vector arm contribute matches only for near-identical items — most conversations lean entirely on the keyword-fusion arm.
- **AI_REPLY_TEMPERATURE 0.3: ACTIVE — the divergence source.** Confirmed as the reply-completion temperature in EV-044; directly produces the 8/8-distinct-reply spread.
- **Chat-model example drift & finetuning-base drift: latent config-hygiene hazards**, not runtime-active defects in this environment (live runs the correct/stronger models). They bite on bootstrap-from-example.

---

## Retrieval replay results

Zero-cost ANN replay against live Postgres, **no OpenAI calls** — an existing stored product embedding was reused as the query vector to exercise `product.ts › searchProductsBySimilarity()` read-only (EV-043). Tenant `02beb134…` (257 active embedded products); the only other tenant with embeddings has **1**.

- **Rank stability — STABLE.** Top-10 identical across 3 executions. Deterministic ordering (expected, since the plan is an exact seq scan with no ANN randomness; no ties observed). This is the retrieval floor beneath the *reply* nondeterminism measured later — retrieval itself is stable; the divergence enters at generation, not ranking.
- **HNSW usage from EXPLAIN — NOT used.** `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)`, tested both as InitPlan scalar-subquery and as a true `'[…]'::vector` literal Const (what bound `$2` compiles to): both plans are `Limit → Sort (top-N heapsort, 26kB) → Seq Scan on products`. At 617 total / 258 embedded rows the planner cost-prefers brute force. **Retrieval is currently exact, not approximate**; `idx_products_embedding` is valid but dormant.
- **Tenant filter stage — POST-scan.** The tenant predicate is applied as a Seq Scan `Filter` (`deleted_at IS NULL AND is_active AND embedding IS NOT NULL AND tenant_id='02beb134…'`), **not** an index pre-filter; **360 of 617 rows removed by filter**. Correctness holds; the isolation is purely a WHERE-clause co-filter.
- **Cross-tenant top-10 (no tenant filter) — 0.** Running the same ORDER BY without the `tenant_id` predicate returned 10 rows, **all** belonging to the probe's own tenant. Recall-starvation is doubly unrealized: index unused AND only 1 cross-tenant product exists.
- **Threshold sensitivity.** On the 257-row pool: `≥0.65` → **1** row (self only), `≥0.60` → **1**, `≥0.55` → 5. Closest distinct catalog item = **0.594** (below 0.65 and 0.60). At the documented floor with `-small` vectors, only the exact self-match clears; real neighbours are filtered.

Net: the retrieval path is **exact, stable, and correctly tenant-isolated at dev scale**, but the 0.65 floor on `-small` embeddings makes the vector arm contribute almost nothing beyond exact matches — reinforcing the Phase 3 mechanism that guards validate replies against a thin per-turn retrieval set.

---

## Live-replay divergence experiment

**This is the one audit step that spent OpenAI credits (user-approved).** Total OpenAI calls: **81** (hard cap 118, enforced by a wrapped client counter). Clean exit, no loops/errors. Harness: `scratchpad/audit/runtime/replay-harness.ts`; raw: `replay-results.json`; memo: `runtime/live-replay.md`; evidence: EV-044.

### Method (capture-and-replay — lowest side-effect that exercises the real pipeline)

Tenant `02beb134…`. The shared OpenAI singleton was monkey-patched to (a) count+cap every call and (b) intercept the customer-facing reply completion — uniquely identified as the only `chat.completions.create` with `temperature !== 0` and **no** `response_format` (all classifiers use temp 0 + `json_object`) — capturing its fully-assembled `messages` array = the exact production prompt.

- **Phase A:** real `aiService.generateReply(randomUUID(), tenant, input)` ×1/input → captures the real prompt + `matchedProducts` + catalog context. Random nonexistent `conversationId` ⇒ history loads empty ⇒ **no rows persisted**.
- **Phase B:** replay the captured prompt **8×** @ temp 0.3 (gpt-4o) → wording divergence.
- **Phase C:** real `assessProductInformationRequest(input, catalogCtx)` **8×** → the product-info-gap **escalate gate** (`escalate = !ok || missing.length>0`).
- **Phase D:** `filterHallucinatedProductNames` + `evaluateReply` on 2 sampled replies/input.

Three fixed Albanian inputs, each mapped to REAL in-stock catalog items: **IN1** availability (`A keni proteine Compact whey gold?`), **IN2** price+flavor (`Sa kushton whey Applied Nutrition…`), **IN3** comparison (`Cila kreatine eshte me e mire, Creatine Monohydrate apo BSN Creatine?`).

### Results

**Reply-replay (8 identical-prompt runs @ temp 0.3):**

| input | matched | distinct texts / 8 | reply class | quality (sampled) | note |
|---|---|---|---|---|---|
| IN1 | 10 | **1** | answered | **0.20** | degenerate collapse — every run = `"Po."` ("Yes"). One-word answer, low quality. |
| IN2 | 25 | **3** | answered | 0.95 | semantically stable (€68 + 3 flavors) but wording varies; **2/8 runs drop the product name**. |
| IN3 | 25 | **8** (maximal) | answered | 0.95 | every run a different paragraph; several **fabricate** "BSN = Bio-Engineered Supplements and Nutrition" + strength claims **not in catalog** — passed name-guard AND quality-eval. |

**Escalate-gate (8 runs, `assessProductInformationRequest`, temp 0):**

| input | escalate / 8 | distinct missing-sets | missing labels |
|---|---|---|---|
| IN1 | **8/8 escalate** | 1 | `["marka"]` — flags "brand" missing, though brand is null for all matches and the customer only asked availability. |
| IN2 | 0/8 (answer) | 1 | `[]` |
| IN3 | **8/8 escalate** | **2** | 4×`["cila eshte me e mire"]`, 4×`["më e mirë"]` — the escalation **reason itself is non-deterministic at temp 0**. |

### The headline — Issue-1 divergence is MEASURED, not predicted

- **divergenceObserved = TRUE, empirically.** Identical input → up to **8/8 distinct replies** (IN3), 3/8 (IN2), 1/8 degenerate (IN1). `distinctRepliesPerInput = [1, 3, 8]`.
- **escalatedCorrectAnswer = TRUE (IN1, IN3).** For two correct, answerable catalog questions (availability, comparison) the customer-facing reply arm **confidently answers** (IN3 quality 0.95) while the parallel product-info-gap gate says **escalate 8/8**. The two arms of the same pipeline disagree on the same input — so a correct catalog question would ship a partial-answer + human escalation. `outcomeClassesPerInput`: IN1 {reply:answered / gate:escalate} · IN2 {reply:answered / gate:answer} · IN3 {reply:answered / gate:escalate}.
- **Grounding drift rides on wording drift.** IN3's high-variance replays introduce **ungrounded facts** (the BSN backronym, strength claims not in catalog). The name-guard (checks names only) and quality-eval (0.95) both passed them — temp-0.3 variance is not merely cosmetic; it changes factual content.
- **Escalation metadata is itself non-deterministic** (IN3's `missing` label varies at temp 0).

**Cross-reference.** This is the live confirmation of what Phase 4 found in dev data — **EV-025 / Q9: 165 near-identical customer messages → 60 divergent-outcome pairs**, including an identical usage question answered factually at 21:05 & 22:03 and escalated with alerts at 21:46 & 21:54 the same evening, and identical price questions returning correct prices vs "no access to prices" vs "not in our catalog". It also confirms the Phase 3 divergence trees (DP-GPR-28 fail-open escalation subsystem; DP-po-30/28 post-send NOW()-relative gates) at the *outcome* level: the reply/escalate contradiction that Phase 3 derived from code structure is now reproduced live. IN1's `0.20` degenerate reply also matches Phase 4's Q4 finding that the eval model systematically under-scores (order confirmations scored 0.200) — here a one-word `"Po."` clears the live `0.1` floor.

---

## Test-data inventory

**NONE.** No `conversations`, `messages`, `orders`, `ai_alerts`, `contacts`, or `products` rows were inserted or updated with test data by any Phase 10 step (EV-044 test-data inventory).

- The live-replay `generateReply` calls used random nonexistent `conversationId`s — the history SELECT returned empty, so nothing persisted. `assessProductInformationRequest`, `filterHallucinatedProductNames`, and `evaluateReply` are read-only / LLM-only.
- All Postgres verification (EV-033–EV-039, EV-043) was SELECT-only via `mcp__postgres__query`.
- All Redis verification (EV-040–EV-042) was read-only (`scan_keys`, `info`, `type`, `get`, `zrange`, `dbsize`, `llen`, `hgetall`); no `set`/`delete`/`expire` issued.

**Incidental non-test-data writes** (normal runtime side-effects of invoking the real code path, not audit rows):

- Ephemeral Redis cache keys for the tenant — `ai_config:*`, `tenant:*`, `products:*`, `tenant_prompt_blocks:*` (TTL ~2–30 min; expired by scan time — none were present at rest, EV-041).
- `generateReply` → `ensureTenantPromptBlocksSeeded` → `forceSyncLockedBlocksForTenant`: a **no-op equality check** for this pre-existing tenant with current locked content — it would only UPDATE `tenant_prompt_blocks` if platform-locked content had drifted. No business rows written either way.

---

## npm test result

**PASS — 548 tests / 75 suites / 0 fail / 0 skipped / 0 todo**, ~5.9s (EV-043 test run; detail in `runtime/npmtest.md`).

- Command `npm test` → `tsx --test src/services/__tests__/**/*.test.ts` (Node built-in runner, no build step). Runs fully offline — no tsconfig/DB/Redis/`.env`/OpenAI needed; pure-logic unit tests (speculative-health-advice keyword parity, follow-up-invitation pattern parity, Albanian classifiers, etc.).
- **Confirms C-145's real impact.** CLAUDE.md §4 and Phase 9 (C-145/146) state CI runs only typecheck + build + migration smoke-test + health check — **never `npm test`**. This run proves the 548-assertion suite **exists and is green locally**, so C-145 is a genuine **CI-coverage gap, not broken tests**: regressions in exactly the guard/classifier logic these tests cover (health-advice guard, follow-up-invitation guard, Albanian phrase detection) would ship uncaught by the pipeline. The suite's existence also means the gap is cheap to close (add one CI step).

---

## Evidence limitations

- **Dev, not prod.** Every DB/Redis observation comes from a dev/staging copy (6 tenants, 46 conversations, 374 messages, 617 products). It demonstrates *mechanisms and live configuration*, not production incidence rates. Sentry (`hillside-6c`) carries no meaningful production error history; no production logs were available.
- **Zero channels in the dev snapshot.** The `channels` table is empty yet 46 conversations / 374 messages exist — every conversation is orphaned (`channel_id IS NULL`, 100%, EV-038). This means SEC-2 (dual-connect) **cannot manifest in data** here, and any claim requiring live channel rows (webhook tenant routing, `channels.ai_enabled` gating, encrypted-token handling) rests on **code-reading only** — not runtime-verified.
- **Redis has no TTL-read via MCP, and all app keys were absent at rest.** The keyspace at scan time was **100% BullMQ**; all twelve AI-path application prefixes (locks, rate windows, dedup markers, hot caches) returned 0 keys (EV-041). Their existence and TTLs are **code-asserted, not runtime-confirmed** — the instance was idle, and the MCP lacks a dedicated per-key TTL command. (Aside: EV-042 found **~79 retained failed jobs** — webhook 30, `offerEmbeddingReconcileFast` cron 20, message.inbound 16 — worth code-side triage but not a correctness verdict here.)
- **Live replay is small-N.** 3 inputs × 8 replays = a deliberate, credit-capped probe (81 calls). It **proves the divergence and reply-vs-escalate contradiction exist live** on real catalog questions; it does **not** quantify their frequency across the input distribution. Read it together with the dev-data population evidence (EV-025 / Q9's 60 divergent pairs) for scale.
- **HNSW is dormant at dev scale.** EXPLAIN shows exact seq scans (EV-043); any claim about ANN recall/latency behavior is code-asserted, not runtime-observed — it would only engage at much larger row counts.
