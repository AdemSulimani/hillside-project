# P0–P3 DEV Validation Report

> Campaign status: **COMPLETE** (2026-07-20). Every flag validated from a flags-off baseline in dependency order with live runtime evidence. Headline: 4 findings (2 HIGH — see §8), 0 escalations in 100 full-stack replay runs vs the audit's 8/8, §15.2 reconstruction PASS, and a per-flag prod GO/NO-GO in §11.

## 1. Metadata

| | |
|---|---|
| Date started | 2026-07-20 (00:29 local) |
| Branch / commit | `P3-audit-fixes` @ `09969d2` (includes `83284e0` — both P3-6 audit blockers fixed) |
| Machine | Windows 10 Pro 10.0.19045, PowerShell 5.1, Node 22.19.0 |
| Postgres | **18.3** (x86_64-windows) — ⚠ prod/compose pins `pgvector/pgvector:pg16`; version divergence noted |
| Redis | 7.0.15 (WSL2) — compose pins `redis:7-alpine`; matched major |
| Dev DB baseline | ledger 8 rows (2026-07-15), blobs 0, dead_letter 0, ai_alerts 29, config_fingerprints 4, messages 390, conversations 49 |
| Gate tenant | `02beb134-a979-46bc-82b8-9d8f586190db` (ProteinPluss): 257 active products, 257 embedded, 1 channel (`302deade…` "LIVETEST Facebook Page", facebook, external_id `100000000000001`, ai_enabled) |
| `.env` backup | scratchpad `env-backup-20260720-002939.env` (in-repo copy deliberately not kept — not gitignored) |

### Preflight results (Step 0)

- `git status` clean; branch up to date with origin.
- `npm ci` clean (397 packages) — **after** killing an orphaned `tsx --test src/__integration__/fairnessAndDrain.integration.test.ts` process tree running since 2026-07-19 16:11 that held a native-module lock (worth knowing: that integration test can outlive its terminal on Windows; it also holds Redis connections while alive).
- `npm run migrate`: no pending. `npm run migrate:verify -- --strict`: OK — 94 ledger rows, 88 on-disk, monotonic, no checksum drift.
- `npm test`: **2122/2122 pass** (452 suites, ~47 s) with the current flags-on `.env`.
- `npm run eval:golden`: digest `ac176742b38065e60ba346e1a99240f3ca6e834cb502d95613d18c4fd8aeea98` — identical to the pre-campaign baseline recorded 2026-07-19.

## 2. Flag / env inventory (Step 1)

Classification: **ADD** = additive-safe (observability/logging/redaction/telemetry — can stay on during validation), **BEH** = behavioral (changes reply/escalation/routing/retry/model/billing/pipeline topology). Binding: ❄ = frozen at process load (restart required; cannot be probed by mutating env in-process), pc = per-call read, boot = read at boot only. Every `.env` edit requires a dev-server restart regardless (tsx watch does not reload `.env`).

### Campaign-scope flags

| Flag | P-item | Code default | .env at campaign start | Class | Shadow mode | Binding |
|---|---|---|---|---|---|---|
| GUARD_VALIDATE_AGAINST_FULL_CATALOG | P0-2 | false | true | BEH | no | pc |
| GAP_GATE_DETERMINISTIC_FIRST | P0-3 | false | true | BEH | no | pc |
| SENSITIVE_PATH_FAIL_CLOSED | P0-4 | false | true | BEH | no | pc |
| AI_AUTO_RESUME | P0-5 | false | true | BEH | no | pc |
| RATE_LIMIT_COUNT_DELIVERED_ONLY | P0-6 | false | true | BEH | shadow-by-construction (delivered ≤ attempts) | pc |
| ECHO_DURABLE_CORROBORATION | P0-7 | false | true | BEH | no | pc |
| MESSAGES_SCOPED_UNIQUE_READ | P1-1 | false | true | BEH (cluster) | no | pc |
| AI_REPLY_STAGE_BEFORE_SEND (+_CHANNELS, _MAX_SEND_ATTEMPTS) | P1-1 | false | true | BEH (cluster) | no | ❄ |
| OUTBOX_RELAY_ENABLED | P1-1 | false | true | BEH (cluster) | no | ❄ |
| OUTBOX_DISPATCH_ENABLED | P1-1 | false | true | BEH (cluster) | no | ❄ |
| INBOUND_OUTBOX_ENQUEUE | P1-1 | false | true | BEH (cluster; active only with DISPATCH) | no | pc |
| WEBHOOK_ACK_AFTER_ENQUEUE | P1-1 | false | true | BEH (cluster) | no | pc |
| DLQ_ENABLED | P1-2 | false | true | BEH | no | pc |
| DLQ_REPLAY_ENABLED | P1-2 | false | true | BEH | no | pc |
| DLQ_EXHAUSTION_ALERTS_ENABLED | P1-2 | false | true | ADD | — | pc |
| DLQ_METRICS_ENABLED (+interval/burst/retention) | P1-2 | false | true | ADD | — | pc |
| CONFIDENCE_CONTRACT_SYMMETRY | P1-3 | false | true | BEH | no | pc |
| CONFIDENCE_HYSTERESIS_BAND | P1-3 | 0.05 (clamp [0,0.25]) | 0.05 | BEH (knob) | — | pc |
| CLASSIFIER_VERDICT_PERSISTENCE | P1-3/RC-08 | false | true | BEH (retry determinism) | no | pc |
| AI_DECISION_LEDGER_ENABLED | P1-5 | false | true | ADD | — | ❄ |
| REDACT_PII | P1-6 | **true** | true | ADD (compliance; never off) | — | ❄ |
| FACTS_USED_CONTRACT | P2-1 | false | true | BEH (temp 0 + seed 7 + json_schema generation) | had shadow window; now binary | ❄ |
| GROUNDING_GATE_CONSOLIDATED | P2-1 | false | true | BEH (supersedes P0-2/P0-3 guards) | no (rollback = legacy guards) | ❄ |
| ORDER_STAGE_MACHINE | P2-2 | off | **on** | BEH enum | **off\|shadow\|on** | pc |
| COMMISSION_STORED_TIMESTAMP | P2-2/RC-22 | false | true | BEH (billing anchor) | no | pc |
| STICKY_LOCALE_SLOT | P2-2/RC-10 | false | true | BEH (reply locale) | no | ❄ |
| INTENT_STRUCTURED_CONTRACT | P2-2 | false | true | BEH (fail-closed intent parse) | no | ❄ |
| HISTORY_DELIVERY_FILTERED | P2-3 | false | true | BEH (prompt history) | no | ❄ |
| SUMMARY_SLOT_BACKED (+MAX_TAIL_CHARS) | P2-3 | false | true | BEH (summary content) | no | ❄ |
| AI_CONFIG_VERSIONED_CACHE | P2-3 | false | true | BEH-infra (cache correctness; enables RC-17 floor) | no | ❄ |
| STRUCTURED_LOGGING | P2-4 | false | true | ADD | — | pc |
| RECEIPT_TIME_SNAPSHOT | P2-4 | false | true | ADD (record-only; one governing use = RC-17 staleness floor, live only with AI_CONFIG_VERSIONED_CACHE) | — | ❄ |
| LEDGER_PROMPT_BLOBS | P2-4 | false | **false** (flipped ON in U9) | ADD | — | ❄ |
| WEBHOOK_DEDUPE_REPLAY | P2-4 | false | true | BEH (accepts late deliveries; drops 300 s skew 403) | no | pc |
| DIALECT_NORMALIZATION | P2-5 | false | true | BEH (lexical retrieval arm) | no | ❄ |
| GHEG_LEXICONS | P2-5 | false | true | BEH (routing lexicons) | no | ❄ |
| RESTRICTIONS_FOOTER_ALL_TENANTS | P2-5 | false | true | BEH (prompt content) | no | ❄ |
| PROMPT_ALLOWLIST_BUDGET | P2-5 | false | true | BEH (prompt assembly) | no | ❄ |
| GRACEFUL_DEGRADE_MODE | P2-6 | false | true | BEH (provider-failure floor; prerequisite for caps/breaker) | no | pc |
| OPENAI_CALL_TIMEOUT_MS | P2-6 | 0 = off | 45000 | BEH (0 = kill switch) | no | ❄ |
| OPENAI_TURN_DEADLINE_MS | P2-6 | 0 = off | 120000 | BEH (×2 must stay < lock TTL 300 s) | no | ❄ |
| OPENAI_CIRCUIT_BREAKER (+threshold/cooldown/probes) | P2-6 | off | **monitor** | BEH enum | **off\|monitor\|on** (monitor = shadow) | pc |
| STRICT_CONFIG_VALIDATION | P2-7 | warn | unset (⇒ warn) | ADD (validation posture; CI escalates, boot never exits on band drift) | off\|warn\|strict | boot |
| CONFIG_FINGERPRINT_REGISTRY | P2-7 | false | true | ADD | — | boot |
| GROUNDING_GATE_ATTRIBUTE_FACTS (+ATTR_* knobs) | P3-1 | off | **shadow** | BEH enum (needs CONSOLIDATED + FACTS_USED_CONTRACT) | **off\|shadow\|enforce** | ❄ |
| QUALITY_EVAL_MODE | P3-4 | **enforce** | unset (⇒ enforce) | BEH enum (enforce pauses AI on low score) | **enforce\|shadow\|off** | pc |
| PROMPT_BLOCK_REGISTRY | P3-5 | false | false | ADD (ledger stamping only; registration unconditional since 83284e0) | — | pc |
| PROMPT_ASSEMBLY_ALERTS | P3-5 | false | false | ADD | — | pc |
| PROMPT_SELF_HEAL_OFF_HOT_PATH | P3-5 | false | false | BEH (skips per-reply force-sync) | no | pc |
| PROMPT_SECTION_BUDGET | P3-5 | off | off | BEH enum | **off\|shadow\|enforce** | pc |
| AI_COST_ROLLUP_ENABLED (+interval/window/seal/retention) | P3-6 | false | false | ADD (read-side COGS rollup) | — | pc |
| AI_COST_JOB_CAPTURE | P3-6 | false | false | ADD | — | pc |
| AI_COST_ANOMALY_ALERTS / AI_COST_MODEL_DRIFT_ALERT (+ratios) | P3-6 | false | false | ADD (ops alerts, not ai_alerts) | — | pc |

### Out-of-scope flags (validated-OFF this campaign — default posture, code/test-verified only)

| Flag | P-item | Default | Reason out of scope |
|---|---|---|---|
| AI_FAIRNESS_MODE | P3-2 | legacy | bounded-mode load behavior not observable in dev; boot check only (U18) |
| SOCKET_CROSS_PROCESS_EMIT | P3-2 | false | single-process dev (PROCESS_ROLE=all); covered by socketCrossProcess integration test |
| VECTOR_ITERATIVE_SCAN / VECTOR_TENANT_PARTIAL_INDEX (+MIN_ROWS/MAX_TENANTS/INTERVAL) | P3-2 | false | dev tenant below partition thresholds; covered by vectorPartialIndex integration test |
| RETRIEVAL_SHARED_CACHE (+TTLs) / SIMILARITY_HYSTERESIS_BAND / SEMANTIC_BAND_* | P1-4 | off/0 | staged separately; retrieval determinism claims are bounded, not eliminated |
| ETA_STRIP_ALL_REPLIES / PRICE_INTENT_LEXICAL_UNION / UNCERTAIN_GUARD_CATALOG_ALTERNATIVES | P3-5/P2 | false | post-campaign candidates; not in prod-intent set |
| DATABASE_REPLICA_URL / PG_POOL_MAX_REPLICA | P3-2 | unset (replica = primary) | no replica in dev |
| MIGRATE_STRICT / MIGRATE_PER_FILE / MIGRATE_ALLOW_DOWN (+timeouts) | P3-3 | unset | exercised via `migrate` + `migrate:verify --strict` (green in preflight); no boot flag semantics |
| TEST_FORCE_PROVIDER_ERROR / TEST_FORCE_DETECTOR_ERROR | P2-6/P0-4 | '' | test-only fault injection; used as instruments in U4/U7/U14, never enabled otherwise |

## 3. Config parity (Step 2)

- `npm run config:check` (warn mode): **OK, no violations** — embedding columns verified live as `vector(1536)` on `products` + `product_image_fingerprints` against `text-embedding-3-small`; fingerprint `8c09ae6c6574e4b9` (121 frozen knobs).
- Strict mode (`STRICT_CONFIG_VALIDATION=strict`): **OK, no violations** (fingerprint differs — `5d4ff64275c60fc1` — because the posture knob is itself fingerprinted; expected).
- `resolveModel(role)` for all 8 roles: chat/classifier/vision/eval/intent/product_processing → **gpt-4o** (role vars deliberately unset so the fallback chain governs — matches prod intent; note product_processing therefore runs the expensive path, the documented P3-6 cost lever); embedding → **text-embedding-3-small**; finetune_base → `gpt-4o-2024-11-20` (mismatch #1 below).
- Thresholds at prod-intended values: SIMILARITY_THRESHOLD=0.65, QUALITY_THRESHOLD=0.1, INTENT_THRESHOLD=0.85, AI_REPLY_TEMPERATURE=0.3 (default), AI_REPLY_SEED=7 (default, sent only under FACTS_USED_CONTRACT).

### Mismatches found (dev vs prod-intended)

| # | Var | Dev value | Prod-intended | Action taken |
|---|---|---|---|---|
| 1 | OPENAI_FINETUNING_BASE_MODEL | `gpt-4o-2024-11-20` (valid inference snapshot, **not fine-tunable** — nightly prepareFinetuning would fail at job creation) | code default `gpt-4o-mini-2024-07-18` (or `gpt-4o-2024-08-06` for 4o-class) | Commented out in dev `.env` → code default. Decide the prod value deliberately before any fine-tuning run. |
| 2 | INSTAGRAM_SHARE_CAPTION_MAX_CHARS | `100` | code default `400` | Left at 100 for the campaign (not a fingerprinted decision knob); align or document post-campaign. |
| 3 | AI_MAX_REPLIES_PER_HOUR | `100` | code default / prod `25` | **Set to 25** for the campaign so rate-limit validation predicts prod. (Not caught by config:check — 100 is in-band.) |
| 4 | PostgreSQL major | dev **18.3** (Windows native) | compose/prod pins `pgvector/pgvector:pg16` | Environment divergence, not fixable here; noted for interpretation of planner/vector behavior. |

## 4. Per-unit validation results (Step 3)

### U0 — Baseline (all behavioral flags OFF)

`.env` rewritten to baseline: every behavioral flag off/`off`/0; additive-safe kept on (REDACT_PII, STRUCTURED_LOGGING, AI_DECISION_LEDGER_ENABLED, RECEIPT_TIME_SNAPSHOT, CONFIG_FINGERPRINT_REGISTRY, DLQ metrics/alerting); `QUALITY_EVAL_MODE=shadow` for the replay portion (restored in Step 5); parity fixes from §3 applied (rate limit 25, finetuning model commented out).

| Check | Result |
|---|---|
| Boot (30 s capture, `tsx src/server.ts`) | **CLEAN** — posture block confirms all behavioral flags off/legacy; `[receipt] … RC-17 staleness floor INERT` (expected until U12); boot warns identical input may yield different replies with FACTS_USED_CONTRACT off (expected); listening on :8000, all schedulers registered; fingerprint `54673e45cd427024` (121 knobs, 47 overridden) |
| `npm test` | **2122/2122 pass** (452 suites, ~45 s) — flags-off equals flags-on totals; suite is env-posture-independent |
| `eval:golden --digest` | `ac176742…` — **identical to the flags-on digest**, confirming the golden gate is env-independent |
| Baseline live replay | IN1, IN3, GH-04 × 8 runs (24 turns, legacy path, temp 0.3 no seed) — results in §5 |

### U1 (P0-6) — RATE_LIMIT_COUNT_DELIVERED_ONLY=true

| Check | Result |
|---|---|
| `rateLimitDeliveredCount.test.ts` | **15/15 pass** |
| Boot posture | CLEAN — flag on in posture line; fingerprint `c158f360ee319175` |
| Runtime (Redis counter ≤ attempts) | deferred to the webhook-turn window (U9+) — see §4 addendum |

**U1: GO** (runtime cross-check pending webhook turns).

### U2 (P0-2) — GUARD_VALIDATE_AGAINST_FULL_CATALOG=true

| Check | Result |
|---|---|
| `catalogGuardReference` + `priceConsistencyGuard` + `evReplayGolden` (EV-011/013/015 corpus incl. negative fixtures) | **73/73 pass** — zero flags on real-catalog facts, genuine fabrications still flag |
| Boot posture | CLEAN (joint boot with U3; fingerprint `d959515f3d34c174`) |
| Live counterpart | zero hallucination flags in Step-4 replay prose |

**U2: GO.**

### U3 (P0-3) — GAP_GATE_DETERMINISTIC_FIRST=true

| Check | Result |
|---|---|
| `gapGateDeterministicFirst` + `gapGateGolden` (IN1/IN3 seeds, 20 adversarial draws/case) | **55/55 pass** |
| `eval:golden --digest` after flip | `ac176742…` — unchanged |
| Live counterpart | IN1/IN3 non-escalation measured in Step-4 replay |

**U3: GO.**

### U4 (P0-4 + P0-7) — SENSITIVE_PATH_FAIL_CLOSED=true, ECHO_DURABLE_CORROBORATION=true

| Check | Result |
|---|---|
| `sensitivePathFailClosed` + `messengerEchoClassification` + `echoDurableCorroboration` + `outboundEchoRegistry` | **44/44 pass** (incl. `human_replied` stays false on echo; Redis-error → durable content check holds) |
| Fault injection (`TEST_FORCE_DETECTOR_ERROR=cancellation_refund`, live webhook turn) | **PASS** — server relaunched with the fault armed (boot warns "ARMED", Sentry blanked); refund-demand text (Gheg) from fresh sender → detector threw on the production error path → outcome was the neutral holding message ("Na vjen keq për problemin. Një anëtar i ekipit tonë do t'ju përgjigjet së shpejti."), **never a sales reply**; conversation paused with stamped reason `uncertain_answer_escalated` (correct: the detector's verdict was unknowable, so it escalates as uncertain, and auto-resume will not touch it); unread `ai_alerts` row created |

**U4: GO.**

### U5 (P0-5) — AI_AUTO_RESUME=true

| Check | Result |
|---|---|
| `aiResumePolicy.test.ts` (sensitive-never-resume, rate-limit resume, resolve paths) | **24/24 pass** |
| Live pause-invariant scan on dev DB | **8 violations found — see Finding 1** (legacy rows, not a flag defect) |

**U5: GO for the flag itself** — it behaves correctly for every reason-stamped pause; Finding 1 is a rollout-data issue, not a code defect.

> **Finding 1 (P0-5 rollout gap, severity: prod-enablement note).** 8 dev conversations (all tenant `02beb134…`, last updated 2026-05-29→2026-06-27) have `ai_paused=true` with `ai_paused_reason IS NULL` **and** `ai_paused_at IS NULL` — pauses that predate migration 069's reason stamping. AI_AUTO_RESUME deliberately never touches a NULL-reason pause (correct, conservative), so these are permanent-silence dead-ends (RC-14) that the flag cannot heal. **Prod will have the same population when P0-5 ships.** Recommended: a one-time operator review of `ai_paused AND ai_paused_reason IS NULL` rows at enablement (they cannot be auto-backfilled — the original reason is unrecoverable); left as-is in dev as evidence.

### U6 (P1-1) — outbox/staging sextet, single cluster flip

MESSAGES_SCOPED_UNIQUE_READ + AI_REPLY_STAGE_BEFORE_SEND + OUTBOX_RELAY_ENABLED + OUTBOX_DISPATCH_ENABLED + INBOUND_OUTBOX_ENQUEUE + WEBHOOK_ACK_AFTER_ENQUEUE → true.

| Check | Result |
|---|---|
| `inboundEnqueuePolicy` + `outboxDispatch` + `replyIdempotency` + `webhookDelivery` | **56/56 pass** (half-on-state semantics covered by inboundEnqueuePolicy) |
| `npm run test:integration` (live PG 18.3 + Redis 7) | **57/57 pass**, 28 suites (incl. idempotentPostSend, fairnessAndDrain, tenantSlotLease, socketCrossProcess) |
| Boot | CLEAN — `Outbox relay scheduler registered { everyMs: 1000, dispatch: true }`; fingerprint `0323811bf86c42cc` |
| Outbox steady state | `transactional_outbox`: 24 rows, **all `done`** — drains fully, no stuck rows |
| Live E2E | webhook turn (U9 below) processed through inbound-outbox enqueue → stage → relay dispatch |

**U6: GO.**

### U7 (P1-2) — DLQ_ENABLED + DLQ_REPLAY_ENABLED=true

| Check | Result |
|---|---|
| `failureClassifier` + `failedJobOrchestration` (with U8 suites) | **64/64 pass** (joint run) |
| Live send-failure path | webhook turn's Meta send failed (fake page, HTTP 400) → `messages.send_status='failed'` + `send_error` persisted + `message_send_failed` alert. `dead_letter` correctly stayed 0 — the *job* succeeded; DLQ catches job exhaustion, not message-send failure |
| Job-exhaustion → DLQ evidence | provider-error injection deferred to U14 (same instrument); integration suite covers classification offline |

**U7: GO** (runtime DLQ row evidenced in U14).

### U8 (P1-3) — CONFIDENCE_CONTRACT_SYMMETRY=true (+band 0.05), CLASSIFIER_VERDICT_PERSISTENCE=true

| Check | Result |
|---|---|
| `confidenceContractSymmetry` + `classifierVerdictStore` | pass (part of the 64/64 joint run) — five-detector single-fail-direction asserted |
| Live verdict persistence | after webhook turn 1, Redis holds `ai_clf:<conv>:m_campaign_u9_recon_1:{purchase_intent, wrong_product, cancellation_refund, order_affirmation, order_info_update}` — five detector verdicts persisted for retry reuse |

**U8: GO.**

### U9 (P1-5/P2-4) — LEDGER_PROMPT_BLOBS=true (new), WEBHOOK_DEDUPE_REPLAY=true

| Check | Result |
|---|---|
| `aiDecisionLedger` (fcd0af7e pinned fixture) + `receiptSnapshot` + `redact` | **84/84 pass** |
| Live webhook turn 1 (GH-04 text, fake sender `…042`) | full pipeline ran: real AI reply (quality 0.920, recorded in shadow — no pause), ledger 8→9, prompt blob 0→1 |
| Dedupe replay | identical payload re-POSTed (same `mid`) → HTTP 200 but **no** second inbound/reply (2 message rows total); `webhook_seen:m_campaign_u9_recon_1` claim key in Redis |
| §15.2 reconstruction (turn 1 key `0ef39132…`) | `reconstructReply()` recovered: **systemPrompt 42,450 chars** (blob join), model `{requested: gpt-4o, served: gpt-4o-2024-08-06, temperature: 0.3, seed: null (correct — FACTS off), max_tokens: 768, finish_reason: stop}`, 7 decision events, guard_verdicts (incl. degraded=false + breaker states), per-call usage with USD costs, receipt_snapshot (live vs captured), config_fingerprint `{167a7f406d914eac, all@DESKTOP-9EUV2P4:20876}` — the exact serving boot |
| Retrieval scores — diagnosed | Turn 1's `retrieval` was NULL: **correct, not a gap** — the sink deliberately stays undefined when no fresh retrieval runs ([aiService.ts:3869](../../backend/src/services/aiService.ts#L3869)); GH-04's text has no product noun. Turn 2 (IN1 text, sender `…043`) positively proves capture: `retrieval.top` = 8 per-product similarities (0.6727…0.6417), `threshold: 0.65`, `semantic_skipped: false` |
| U1 runtime cross-check | failed send burned **no** per-conversation budget key in Redis (delivered-only semantics confirmed live); only the outbound-channel attempt counter exists |

**U9: GO — the §15.2 acceptance (all six artifact classes from the ledger alone) is met.**

### U10 (P2-1) — FACTS_USED_CONTRACT=true, then GROUNDING_GATE_CONSOLIDATED=true

| Check | Result |
|---|---|
| `groundingGate` + `fabricationGolden` (after FACTS flip) | **43/43 pass** |
| `eval:golden --digest` after each flip | `ac176742…` — unchanged both times |
| Boot posture (both on) | `[grounding] FACTS_USED_CONTRACT=on (temp0+seed+json_schema); GROUNDING_GATE_CONSOLIDATED=on (consolidated gate)`; fingerprint `40f3106ebbf11568` |
| Live probe IN3 ×4, FACTS only | distinct 4/4, "fabrications" 4 — see analysis below |
| Live probe IN3 ×4, full stack | distinct 4/4 **by exact string**, but the four replies are one template sentence with 1–2-word variance (decision-class distinct count = 1: recommend-both, same two products, no escalation) — vs the baseline's 8/8 structurally different paragraphs. "Fabrications" 4 — all false positives (Finding 2) |

**Analysis of the IN3 "fabrication" counts (diagnosed, not averaged away):**
1. Every flagged span in every live run (baseline ×8, U10a ×4, U10b ×4) is the single word **"Zgjedhja"** — see Finding 2. Zero real fabrications in any campaign run.
2. The audit-era IN3 fabrication ("BSN = Bio-Engineered Supplements and Nutrition") **is grounded in today's catalog**: the tenant's `BSN Creatine 216gr` description contains that exact sentence. A synthetic re-check confirmed the checker *does* flag the expansion when the catalog lacks it (spans `Bio-Engineered`, `Supplements`, `Nutrition`), so the check is not inert — the premise just no longer holds against the current catalog. The recorded fabricating text stays pinned offline in `fabricationGolden`, which is the right place for it.
3. Exact-string distinctness of 4 under temp 0 + seed 7 reflects OpenAI's documented best-effort seed determinism (system_fingerprint drift), not decision instability. The metric that RC-03's Issue 1 is about — identical input → identical outcome — is met: 1 decision class across all runs.

**U10: GO.**

> **Finding 2 (eval-harness allowlist gap, severity: low — harness-side only, not send-path).** `LANGUAGE_ALLOWLIST` in [tokenMembership.ts:126](../../backend/src/eval/harness/tokenMembership.ts#L126) contains the indefinite `zgjedhje` but not the definite `zgjedhja`, so every reply opening a sentence with "Zgjedhja më e mirë varet…" ("The best choice depends…") counts one fabrication violation. This is the checker's documented feedback loop working as designed (sentence-initial capitals are only exempt when allowlisted — the alternative hid real brand fabrications 5/7 at sentence start). **Proposed fix:** add `zgjedhja` via the negative-corpus process; consider auditing other listed lemmas for missing definite/inflected forms. Until then, live `fabricationViolations` carries +1/run noise on comparison-style replies.

### U11 (P2-2) — ORDER_STAGE_MACHINE (shadow) + COMMISSION_STORED_TIMESTAMP + STICKY_LOCALE_SLOT + INTENT_STRUCTURED_CONTRACT

| Check | Result |
|---|---|
| `orderStageMachine` + `commissionWindow` + `stickyLocale` + `structuredClassifier` + `shadowComparison` | **87/87 pass** |
| Boot in shadow | `ORDER_STAGE_MACHINE=shadow (FSM computed + divergence logged; legacy decides)` |
| Live 3-turn order conversation (price → intent → details, sender `…045`) | pipeline processed all 3; ledger 9→13; legacy gate **created a draft order** (BSN Creatine 216gr, €25, commissionable) |
| Shadow divergence | `[ORDER_STAGE_DIVERGENCE]` logged on the details turn: stage `awaiting_confirmation`, **legacy: true / fsm: false** — legacy created the order, the FSM wanted the recap confirmed first (exactly the RC-22 class) |
| `eval:shadow --classifier=order_stage --days=1` | **"100% agreement over 0 observations"** — the gate is blind; see Finding 3 |

**Verdict: ORDER_STAGE_MACHINE=`on` is NO-GO** (instrument disconnected + one real unresolved divergence; dev keeps `shadow`, which is behavior-neutral). **COMMISSION_STORED_TIMESTAMP, STICKY_LOCALE_SLOT, INTENT_STRUCTURED_CONTRACT: GO** (independent of the FSM; suites green; boot clean).

> **Finding 3 (P2-2 defect, severity: HIGH for the P2-2 cutover — blocks `on` everywhere).**
> **Symptom:** after 3 shadow-mode turns including one logged divergence, `ai_decision_ledger` contains **zero** `order_stage` decision events (`decision_events::text LIKE '%order_stage%'` → 0 rows); `eval:shadow --classifier=order_stage` reports "0 observations" and always will.
> **Root cause:** the order_stage shadow branch is recorded at [processAIReply.ts:6133](../../backend/src/jobs/processAIReply.ts#L6133) inside the draft-order block, which runs **after the outbound send** — but the turn's ledger record is built and enqueued to the outbox at reply-persist time (before the send flips). `recordDecision` therefore appends to a decision-events array that has already been serialized into the outbox payload; the event is silently dropped. (Pre-send guards — quality_eval `shadow:ok`, grounding_gate — do appear in the rows, confirming the seal point.) The P3 audit's observation "eval:shadow has zero shadow branches (never fed)" was attributed to flags being off in deployment; this proves it persists with the flags on.
> **Consequence:** the P2-2 shadow window — "remove dead code only after a full billing period of production shadow parity" — cannot produce evidence anywhere, dev or prod. Console logs catch divergences but are lossy and un-queryable per the cutover bar (`meetsCutoverBar`: ≥99 % over ≥500 rows).
> **Proposed fix (not applied — validation campaign, not feature work):** either (a) compute the FSM shadow verdict pre-send, before the ledger record is sealed (the FSM needs only the inbound + accumulated slot state, both available pre-send), or (b) write the order_stage shadow event as its own best-effort ledger row (e.g. `decision_kind: 'order_shadow'`) from the draft-order block via `writeLedgerBestEffort`. Option (b) is smaller and keeps the divergence joined to the turn via `idempotency_key`.
> **Also record:** the one live divergence (legacy creates / FSM holds at `awaiting_confirmation`) is a real product-behavior difference that the parity window must quantify before `on` — a single observation cannot be averaged.

### U12 (P2-3) + U13 (P2-5) — memory/history + Albanian/Gheg clusters

HISTORY_DELIVERY_FILTERED, SUMMARY_SLOT_BACKED, AI_CONFIG_VERSIONED_CACHE; GHEG_LEXICONS, DIALECT_NORMALIZATION, RESTRICTIONS_FOOTER_ALL_TENANTS, PROMPT_ALLOWLIST_BUDGET → all true (single restart — all six frozen-binding).

| Check | Result |
|---|---|
| 8 targeted suites (history transcript, summary, versioned cache, lexicons, normalization, allowlist, budget, ghegCorpus incl. EV-010 fixture) | **192/192 pass** |
| `npm run test:integration` re-run (Lua CAS now on the active path) | **57/57 pass** |
| Boot | `[memory] …AI_CONFIG_VERSIONED_CACHE=on (CAS/versioned + write-through; C-55 healed)`; **RC-17 staleness floor INERT marker gone** (the `[receipt]` line no longer reports INERT — RECEIPT_TIME_SNAPSHOT's governing use is LIVE); boot itself calls out the footer×budget interaction as P2-5's flagged top risk |
| Live EV-010 turn (`A keni ma shum a veq aito?`, sender `…046`) | **routed as other-options and answered with a product list** — not escalated as `missing_info:["ma shum"]`; only alert is the expected fake-page send failure |
| Ledger prompt provenance (full 42,367-char blob via hash join) | **footer marker present; orphan `offers_promotions` content absent** |

**U12: GO. U13: GO.**

### U14 (P2-6) — GRACEFUL_DEGRADE_MODE + caps (45000/120000) + OPENAI_CIRCUIT_BREAKER=monitor

| Check | Result |
|---|---|
| `providerDegradation` + `providerResilience` + `providerResilienceInstall` | **78/78 pass** |
| Negative check (caps armed via env, floor OFF) | **boot warns loudly**: "⚠ P2-6 enforcement is ON but GRACEFUL_DEGRADE_MODE is OFF. A provider blip can now abort the cancellation/refund detector FAST…" |
| "Before" fault run (floor OFF, `TEST_FORCE_PROVIDER_ERROR=unavailable`, innocuous product question, sender `…047`) | fail-closed umbrella absorbed it: holding message + `uncertain_answer_escalated` alert + **conversation PAUSED** (sticky). No DLQ row — the job *succeeded* via the escalation path (see note below) |
| "After" fault run (full P2-6 stack ON, `timeout`, sender `…048`) | **FAILED the no-pause criterion** — outcome identical to floor-off: holding + `uncertain_answer_escalated` + **PAUSED**; no `provider_unavailable` alert. See **Finding 4**. `human_replied` untouched (billing-safe) ✓; no 240 s hang ✓ |
| Breaker monitor logging | no would-open transitions — correct: the sensitive escalation ends the turn after 1–2 failed calls, below the failure threshold of 5. Monitor-mode statechart pinned by unit tests |
| DLQ runtime note | a provider outage cannot dead-letter jobs while SENSITIVE_PATH_FAIL_CLOSED is on (the umbrella converts it to a successful escalation turn) — DLQ job-exhaustion mechanics remain covered by `failedJobOrchestration` + integration suites; the P2-6 F1 final-attempt floor (processAIReply.ts:6450-6493) covers the pre-send hard-throw class |
| Bonus | **P2-7 fleet-drift detector fired live**: consecutive campaign boots inside the 10-min window produced "FLEET DRIFT: 2 distinct configs… Diverging knobs: GRACEFUL_DEGRADE_MODE, OPENAI_CIRCUIT_BREAKER, …" — CONFIG_FINGERPRINT_REGISTRY works as designed |

**Verdict: flags stay ON in dev (strictly safer than off — the floor additionally protects the main-generation hard-throw class from DLQ silence, and U14a proves the pause happens with the floor off too), but the headline "global blip does not pause conversations" guarantee is NOT delivered — Finding 4. Prod: enable trio (breaker monitor only), do NOT rely on outage-no-pause until Finding 4 is fixed.**

> **Finding 4 (P0-4 × P2-6 interaction defect, severity: HIGH for outage resilience).**
> **Symptom:** with the full P2-6 stack on, a forced provider outage on an innocuous product question still yields the fail-closed outcome — sticky pause + `uncertain_answer_escalated` — instead of the documented no-pause floor + retryable `provider_unavailable` alert.
> **Root cause:** the sensitive detectors run first and call the provider on every turn, so a global outage always strikes them before anything else; their failure raises `SensitivePathEscalatedError` (escalate + pause, committed), and the P2-6 floor **deliberately excludes** that error class at [processAIReply.ts:6473](../../backend/src/jobs/processAIReply.ts#L6473) ("already a safe terminal outcome"). The exclusion is right for *conversation-specific* detector failures, but it makes the floor unreachable in precisely the global-outage scenario it was built for: one 5-minute blip = every mid-turn conversation paused, each needing operator resolution (`uncertain_answer_escalated` is not in the auto-resume set).
> **Proposed fix:** in the sensitive-umbrella failure handler, consult the per-turn provider-failure counter (the ALS store the degrade gate already reads): if the detector failure is provider-caused AND `GRACEFUL_DEGRADE_MODE=on`, route to the degrade floor (holding + retryable `provider_unavailable`, no pause) instead of the fail-closed pause; keep the pause for non-provider detector failures. A provider-caused failure carries no evidence the conversation is sensitive, and the retryable alert preserves the human follow-up without the sticky fan-out.
> **Customer-safety note:** the observed behavior is *safe* (holding message, never a wrong reply) — the defect is operational fan-out, not customer harm.

### U15 (P3-1) — GROUNDING_GATE_ATTRIBUTE_FACTS=shadow

| Check | Result |
|---|---|
| `tokenMembership` + `groundingGateAttributeLane` + `attributeGrounding` | pass (part of 177/177 joint run with U16/U17) |
| Live attribute-claim turn (`A eshte pa sheqer Mega mass 3kg Vanil?`, sender `…049`) | The model answered truthfully from the catalog ("ka sheqer të reduktuar" — reduced sugar), declared 1 fact in `facts_used` (`{type: name, Mega mass 3kg Vanil}`), made **no** refutable exclusion claim → the contradiction-only lane correctly had nothing to judge; partial-answer escalation (`knowledgeGapEscalated: true`) fired for the follow-up. Zero enforce-path activity ✓ |
| Lane-not-dead evidence | facts_used populated per turn; attribute-exclusion claims are rare on truthful replies (consistent with the lane's contradiction-only design and the catalog's sparse structured attributes) — the live FP-rate window before `enforce` remains prod/staging work, as the flag's own documentation states |

**U15: GO for `shadow` (the intended state). `enforce` = NO-GO by design this campaign.**

### U16 (P3-5) — PROMPT_BLOCK_REGISTRY + PROMPT_ASSEMBLY_ALERTS + PROMPT_SELF_HEAL_OFF_HOT_PATH + PROMPT_SECTION_BUDGET=shadow

| Check | Result |
|---|---|
| Targeted suites | pass (in the 177/177 joint run) |
| Live turn ledger | `prompt->'blocks'` **non-null** (per-reply block-version stamps present; was null before the flip — prompt-hash comparisons across this boundary are invalid, as flagged in the plan) |
| Assembly alerts | none fired (no orphan/violation present — the U13 blob check already proved the orphan is dropped) |

**U16: GO.**

### U17 (P3-6) — AI_COST_ROLLUP_ENABLED + AI_COST_JOB_CAPTURE + AI_COST_ANOMALY_ALERTS + AI_COST_MODEL_DRIFT_ALERT (+TURN_CALL=40)

| Check | Result |
|---|---|
| `costRollup` + `costAnomaly` + `costAggregation` + `platformCostService` (incl. the two 83284e0 regression pins: UTC-midnight floor, numeric sort) | pass (177/177 joint run) |
| Rollup ↔ ledger reconciliation | **exact to the microdollar**: `ai_cost_daily` total $0.742224 = ledger reply-sum $0.742216 (COALESCE(calls_usd_cost, usd_cost) — never summed) + job-capture $0.000008. Partition = (tenant, day, role, model, kind, source); turns counted once per group |
| Anomaly scan | fired 2 on the dev tenant (consistent with model-drift across served snapshots `gpt-4o-2024-11-20` (07-15 rows) vs `gpt-4o-2024-08-06` (campaign rows), plus threshold alerts on a zero-revenue dev tenant); routed to platform-ops sink — **zero rows in the merchant `ai_alerts` inbox** ✓ |

**U17: GO** (rollup interval restored to the 1 h default after the check).

### U18 (P3-2) — AI_FAIRNESS_MODE boot check; VECTOR_*/SOCKET_* stay OFF

| Check | Result |
|---|---|
| `admissionControl` + `workerConcurrency` | **25/25 pass** |
| Boot with `AI_FAIRNESS_MODE=bounded` | clean (58 knobs overridden — the mode took); reverted to `legacy` default afterward |

**U18: code-verified only — bounded-mode load behavior is not observable in dev** (`loadtest:fairness` + `fairnessAndDrain.integration.test.ts` are the standing evidence). VECTOR_ITERATIVE_SCAN / VECTOR_TENANT_PARTIAL_INDEX / SOCKET_CROSS_PROCESS_EMIT / DATABASE_REPLICA_URL remain validated-OFF (integration-test coverage only).

## 5. Determinism before/after (Step 4) _(populating)_

### Baseline (all behavioral flags OFF, legacy generation temp 0.3 no seed) — measured live 2026-07-20

| Case | Input | distinct/runs | Fabrication | Notes |
|---|---|---|---|---|
| IN1 | A keni proteine Compact whey gold? | **1/8** | 0 | but the one reply is the degenerate "Po." — the audit's exact quality-0.20 answer |
| IN3 | Cila kreatine…Monohydrate apo BSN Creatine? | **8/8** | 8 (all "Zgjedhja" FPs — Finding 2; the BSN expansion is grounded, see U10 analysis) | structurally different paragraphs each run |
| GH-04 | Cilen mkishe than ti me marr prej qitynve | **3/8** | 0 | distinct-count multiset {1,3,8} matches the Phase-10 baseline [1,3,8] exactly |

151 real OpenAI calls / 24 turns ≈ 6.3 calls/turn on the `generateReply` path.

### After (all validated flags ON: full grounding stack, temp 0 + seed 7 + json_schema) — N=20 per case, 621 calls, cap not reached

| Case | distinct/20 (exact string) | Decision classes | Fabrication (real) | vs baseline |
|---|---|---|---|---|
| IN1 | 5 | **1** — every run answers with the Compact whey gold variant list (formatting/inclusion variance only) | 0 | baseline's "1/8" was the degenerate "Po." every time and the audit's live incident was 8/8 escalation — now **0/20 escalations + informative answers** |
| IN3 | 7 | **1** — identical template sentence, tail-word variance | 0 (the 20 counted violations are all the `Zgjedhja` FP — Finding 2) | 8/8 structurally different paragraphs → one template |
| GH-04 | 3 | **1** — same 3-product set every run, list formatting varies | 0 | 3/8 with differing product sets → stable set |
| SQ-01 | **1** | 1 — byte-identical 20/20 | 0 | — |
| EN-01 | 4 | **2** — informative product list vs bare "Yes." / "Yes, we have creatine in stock." | 0 | see residual note |

**Issue-1 verdict (identical input → identical outcome): MET on 4/5 cases** — decision class is singular and stable; residual exact-string variance is OpenAI's documented best-effort seed determinism (system_fingerprint drift), not decision instability. **A correct-catalog question is no longer escalated: 0 escalations in 100 runs** (vs the audit's 8/8 on IN1/IN3).

**Residual (EN-01):** the degenerate-brevity failure shape ("Yes.") survives in English in a minority of runs — same shape as IN1's pre-fix "Po." but without the escalation. Not a flag regression (no flag targets reply completeness in English); candidates: the P2-5 program's English arm / a golden-corpus EN case addition. Recorded, not blocking.

## Step 5 — Full-config integration run

Final `.env`: every GO flag on; `ORDER_STAGE_MACHINE=shadow` (Finding 3); `GROUNDING_GATE_ATTRIBUTE_FACTS=shadow` (by design); `QUALITY_EVAL_MODE` restored to unset (⇒ enforce, prod parity); `AI_COST_ROLLUP_INTERVAL_MS` restored to default; `AI_FAIRNESS_MODE` at default `legacy`.

| Check | Result |
|---|---|
| `npm test` | **2122/2122** |
| `npm run test:integration` | **57/57** |
| `eval:golden --digest` | `ac176742…` — the same digest at every config state the campaign passed through (flags-on, flags-off, each unit, final) |
| Final E2E webhook turn (price question, sender `…050`, quality enforce live) | grounded reply **"€65.00"** (the catalog price for Compact whey gold 2.3kg Qokolad); 1 ledger row; no pause; no spurious alerts |
| Config fingerprint singleton | `SELECT count(DISTINCT hash) FROM config_fingerprints WHERE last_seen > <final boot>` → **1** (`7e3d3c9143c9f5ba`) |
| Interaction checks | P3-5 registry stamps present without breaking reconstruction (prompt-hash comparisons invalid across the U16 boundary — documented); P3-6 rollup ↔ ledger exact (no JOB_CAPTURE double-count); versioned-cache × receipt-snapshot staleness floor LIVE; quality enforce boot clean; **P0-4×P2-6 interaction = Finding 4** (the one behavior that only fully surfaced with multiple flags on together) |

## Final GO/NO-GO per flag (production enablement)

**GO — additive/observability first (canary wave 0):** REDACT_PII (already prod-default true), STRUCTURED_LOGGING, AI_DECISION_LEDGER_ENABLED, LEDGER_PROMPT_BLOBS, RECEIPT_TIME_SNAPSHOT, CONFIG_FINGERPRINT_REGISTRY, DLQ_METRICS_ENABLED, DLQ_EXHAUSTION_ALERTS_ENABLED, PROMPT_BLOCK_REGISTRY, PROMPT_ASSEMBLY_ALERTS, AI_COST_ROLLUP_ENABLED, AI_COST_JOB_CAPTURE, AI_COST_ANOMALY_ALERTS, AI_COST_MODEL_DRIFT_ALERT.

**GO — behavioral, in this order (each with a soak window):**
1. P0 six: RATE_LIMIT_COUNT_DELIVERED_ONLY → GUARD_VALIDATE_AGAINST_FULL_CATALOG → GAP_GATE_DETERMINISTIC_FIRST → SENSITIVE_PATH_FAIL_CLOSED + ECHO_DURABLE_CORROBORATION → AI_AUTO_RESUME (**with the Finding-1 operator review of pre-069 NULL-reason pauses at enablement**).
2. P1-1 sextet as one cluster (documented internal order), then DLQ_ENABLED + DLQ_REPLAY_ENABLED, then CONFIDENCE_CONTRACT_SYMMETRY (+band) + CLASSIFIER_VERDICT_PERSISTENCE, then WEBHOOK_DEDUPE_REPLAY.
3. Grounding stack: FACTS_USED_CONTRACT → GROUNDING_GATE_CONSOLIDATED (goldens + EV corpus green; live divergence collapse measured).
4. P2-2 companions: COMMISSION_STORED_TIMESTAMP, STICKY_LOCALE_SLOT, INTENT_STRUCTURED_CONTRACT.
5. P2-3 trio (HISTORY_DELIVERY_FILTERED, SUMMARY_SLOT_BACKED, AI_CONFIG_VERSIONED_CACHE) and P2-5 quartet (DIALECT_NORMALIZATION, GHEG_LEXICONS, RESTRICTIONS_FOOTER_ALL_TENANTS, PROMPT_ALLOWLIST_BUDGET).
6. P2-6 trio in mandated order: GRACEFUL_DEGRADE_MODE → OPENAI_CALL_TIMEOUT_MS/OPENAI_TURN_DEADLINE_MS → OPENAI_CIRCUIT_BREAKER=**monitor** (**never `on` until a monitor baseline on prod traffic**). _Finding-4 caveat resolved (`a93a8bc`, retested F4a/F4b 2026-07-20): outage-no-pause now holds with SENSITIVE_PATH_FAIL_CLOSED on._
7. PROMPT_SELF_HEAL_OFF_HOT_PATH + PROMPT_SECTION_BUDGET=**shadow**.

**GO in shadow only (the canaries to watch):** ORDER_STAGE_MACHINE=`shadow` (safe, behavior-neutral) and GROUNDING_GATE_ATTRIBUTE_FACTS=`shadow`.

**NO-GO:**
| Flag/state | Why | Unblock |
|---|---|---|
| ORDER_STAGE_MACHINE=`on` | Finding 3 (cutover gate blind) + 1 unresolved real divergence | fix the ledger recording, run the prod shadow window to the real bar (≥99 % / ≥500 rows) |
| GROUNDING_GATE_ATTRIBUTE_FACTS=`enforce` | by design — live FP-rate window not yet run | read declared-fact counts + verdicts from the prod shadow window |
| QUALITY_EVAL_MODE=`off` (offline relocation) | parity not achieved (max Δ 0.82 > ε 0.1; catalog block unrecoverable offline) | flag agreement is already 0 — needs the catalog-context gap closed first |
| OPENAI_CIRCUIT_BREAKER=`on` | monitor baseline not yet collected on real traffic | clean monitor window |
| AI_FAIRNESS_MODE=`bounded`, VECTOR_*, SOCKET_CROSS_PROCESS_EMIT, DATABASE_REPLICA_URL | load/topology behavior not observable in dev — code/test-verified only | staging/load validation (P3-2's own plan) |

**Canary first:** wave 0 (observability) + the two shadow enums — they generate the evidence every later cutover needs.

## 5. Determinism before/after (Step 4) _(pending)_

## 6. fcd0af7e reconstruction (§15.2)

Two-part acceptance, both met:
1. **Pinned fixture** — `services/__tests__/aiDecisionLedger.test.ts` (`fcd0af7eTelemetry()`) green in U9's 84/84 run: prompt provenance, model+temperature, the 0.58/0.54 retrieval scores below the 0.65 threshold, the classifier chain, and the fail-closed name-guard verdict all assert recoverable from the record alone. (The actual 2026-06-23 incident predates the ledger — the fixture is the faithful replay of its telemetry.)
2. **Fresh live turn** — a real webhook-driven turn (GH-04 input, the incident's turn-5 text) with `AI_DECISION_LEDGER_ENABLED` + `LEDGER_PROMPT_BLOBS` on: `reconstructReply('0ef39132…')` recovered the **42,450-char system prompt**, model `{requested gpt-4o, served gpt-4o-2024-08-06, temp 0.3, seed null, max_tokens 768}`, 7 decision events, guard verdicts incl. fail-closed markers + breaker states, per-call usage with USD costs, receipt snapshot (live vs captured), and the serving boot's config fingerprint. Retrieval scores proven on a second turn (IN1 input): 8 per-product similarities + threshold + `semantic_skipped:false`. `retrieval: null` on no-fresh-retrieval turns is correct semantics, not a gap ([aiService.ts:3869](../../backend/src/services/aiService.ts#L3869)).

**§15.2 acceptance: PASS.**

## 7. Shadow evidence

| Channel | Result |
|---|---|
| order_stage (P2-2) | ~~BLOCKED by Finding 3~~ **UNBLOCKED** (`d125e99`, retested 2026-07-20): shadow verdicts now land as `shadow:order_stage` best-effort rows and `eval:shadow` reports observations with per-stage breakdown ("100% agreement over 2 observations" in the retest window). The prod cutover bar (≥99 % over ≥500 rows) is now *reachable* — it still has to actually run, and the U11 divergence class (legacy creates / FSM holds at `awaiting_confirmation`) still needs quantifying before `on`. |
| attribute lane (P3-1) | shadow mode live; `facts_used` populated per turn; contradiction-only lane correctly idle on truthful replies; zero enforce activity. FP-rate window = prod/staging work as designed. |
| QUALITY_EVAL_MODE | ran in `shadow` for the campaign (scores recorded — 0.920, 0.9 observed — no pauses); **live parity run over 14 ledger turns**: mean |inline−offline| 0.1779, max 0.82 (> ε 0.1), **flag disagreements 0**. Offline relocation (`off`) NOT achievable yet (unrecoverable catalog block caveat); inline eval stays. |
| Circuit breaker `monitor` | statechart unit-pinned; no would-open in live fault runs (turns end at 1–2 failures, below threshold 5) — bake-in window continues in prod `monitor`. |
| RATE_LIMIT_COUNT_DELIVERED_ONLY | shadow-by-construction verified live: failed sends burn no budget key. |

## 8. Diagnosed failures

Findings 1–4 (full diagnoses inline in §4): **F1** P0-5 legacy NULL-reason pauses need operator review at prod enablement; **F2** `zgjedhja` missing from the token-membership allowlist (+1/run FP noise); **F3** order_stage shadow events sealed out of the ledger — P2-2 cutover gate blind ([processAIReply.ts:6133](../../backend/src/jobs/processAIReply.ts#L6133), fix: pre-send verdict or best-effort second row); **F4** fail-closed sensitive path preempts the P2-6 no-pause floor in global outages ([processAIReply.ts:6473](../../backend/src/jobs/processAIReply.ts#L6473), fix: provider-caused detector failures route to the floor).

### Fix status (2026-07-20, branch `fix/P0-P3-findings`)

| Finding | Fixed in | Retest evidence (same live instrument that exposed it) |
|---|---|---|
| **F1** | `bc50e6c` — `npm run audit-paused-conversations` operator CLI (read-only, exit 0, `--tenant-id`/`--json`, two labeled buckets) | Dev run reports exactly the 8 known legacy rows in bucket (a) (pre-069, `ai_paused_at IS NULL`), bucket (b) empty, row counts unchanged after. The operator review itself remains a P0-5 prod-enablement step — reasons are unrecoverable, the CLI feeds the review. |
| **F2** | `9eff6c4` — `'zgjedhja'` allowlisted via the negative-corpus process (verbatim campaign reply as `OK-08-comparison-connective`, reusing the IN3 catalog/customerText exports) | Live IN3 ×3 probe: **`fabricationViolations: 0`** (was +1/run in every campaign run). Golden digest `ac176742…` unchanged. |
| **F3** | `d125e99` — the shadow verdict written as its own best-effort row (`reply_slot='shadow:order_stage'`, `decision_kind='order_shadow'`, `usage: null` — the cost-double-count trap; dead push deleted; source invariants pin all three) | 3-turn order flow: 2 rows with the exact designed shape; **`eval:shadow --classifier=order_stage` reports "100% agreement over 2 observations" with per-stage breakdown** (read "0 observations" forever before). Turn 3 wrote no row because turn 2's reply was deflection-escalated and the pause gate correctly dropped turn 3 — pipeline behavior, not an F3 defect. **`ORDER_STAGE_MACHINE=on` remains NO-GO**: the fix connects evidence *collection*; the ≥99 %/≥500-row prod shadow window still has to run, and the U11 divergence class still needs quantifying. |
| **F4** | `a93a8bc` — `decideSensitiveDetectorFailureRoute` (pure, 8-row truth table) routes provider-caused detector failures (ALS store ∨ `ProviderUnavailableError`) to the existing no-pause floor; non-provider bugs keep the pause; flag-off keeps legacy rethrow | **F4a (the failed U14c instrument): PASS** — provider fault + innocuous question ⇒ `ai_paused: false`, `provider_unavailable` alert, providerUnavailable holding copy, `human_replied` false, ledger row `holding:degraded` with `degradedFrom: sensitive_detector:cancellation_refund`. **F4b (the U4 instrument): PASS** — detector fault without provider fault ⇒ paused + `uncertain_answer_escalated` + postPurchaseSupport copy, byte-for-byte the validated U4 behavior. |

Observation recorded during the F3 retest (pre-existing, not introduced by the fixes): a 3-turn conversation with failed sends accumulated a 47,403-char assembled prompt, tripping the `PROMPT_ASSEMBLY_MAX_CHARS` (34,000) *reporting* threshold — P3-5's `PROMPT_SECTION_BUDGET=enforce` is the eventual answer; noted for the prod P3-5 rollout.

## 9. Spend log (final)

| Run | Turns | Real OpenAI calls | Cost |
|---|---|---|---|
| Baseline replay (IN1/IN3/GH-04 ×8) | 24 | 151 (measured) | ~$1.00 est |
| U10a + U10b probes (IN3 ×4 each) | 8 | 50 (measured) | ~$0.34 est |
| Webhook turns (recon ×2, U11 ×3, EV-010, U15 attr, Step-5 final) | 8 | ledger-measured | **$0.48 measured** (ledger delta over pre-campaign $0.3217) |
| Fault-injection turns (×3) | 3 | ~0 (calls forced to fail) | ~$0 |
| Killed first Step-4 replay (PC restart) | ~4 | partial | ~$0.20 est |
| Quality parity live (14 turns re-scored) | — | 14 | ~$0.05 est |
| Step-4 replay (5 cases ×20, full flags) | 100 | 621 (measured) | ~$4.00 est |
| **Total** | ~147 turns | ~840+ calls | **≈ $6 — within the approved $10–15 budget** |

Fix-branch retests (2026-07-20, `fix/P0-P3-findings`): F3 order flow 3 turns + F4a/F4b fault turns (~$0.2), F2 IN3 ×3 probe (19 calls), acceptance mini replay 24 turns (154 calls), final E2E turn — **≈ $1.6 additional**, within the approved ~$2 retest budget.

## 10. Cleanup inventory _(campaign-written dev data)_

| Artifact | Rows / IDs | Action |
|---|---|---|
| Contacts + conversations + messages | senders `900000000000042…049` (8 conversations, ~16 messages) on tenant `02beb134…` | keep as evidence or delete by `contacts.external_id LIKE '9000000000000%'` |
| Draft order | `265c4d0b-8d29-42b1-ac32-65487540d5a0` (BSN Creatine, €25, commissionable, detected_by ai) | **delete or void before any billing-period close** — it is synthetic and commissionable |
| `ai_decision_ledger` + `ai_prompt_blobs` | rows since 2026-07-19 23:00 UTC (~7 rows + blobs) | keep (evidence; 90-day sweeper prunes) |
| `ai_alerts` | campaign window: `message_send_failed` ×~6, `uncertain_answer_escalated` ×3 | resolve/delete by window |
| Paused conversations | senders `…044`, `…047`, `…048` (reason `uncertain_answer_escalated`) | resolve alerts or leave (synthetic) |
| `ai_cost_daily` | days 2026-07-19/20 tenant `02beb134…` | recompute on next sweep or leave |
| `config_fingerprints` | ~15 campaign boot rows | harmless; optional prune |
| dead_letter | 0 rows written | — |
| Redis | verdict keys (6 h TTL), webhook_seen, outbound-channel counter | TTL-expire |
| Scratchpad | env backup + logs + replay JSONs | keep until report accepted |

## 11. Production GO/NO-GO recommendation _(final table at campaign close)_
