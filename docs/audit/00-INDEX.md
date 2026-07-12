# Hillside AI System Investigation — Index

> **Status: COMPLETE** — finalized at Phase 16 closure.

## Evidence limitations (applies to every file in this audit)

> **Evidence base:** All database and Redis evidence comes from a **dev/staging copy** (6 tenants, 46 conversations, 374 messages, 617 products, 20 ai_alerts at audit start — 2026-07-10). It demonstrates *mechanisms*, not production incidence rates. Sentry (`hillside-6c`) contains no meaningful production error history. No production logs were available. Live-replay experiments were run against the local dev stack with the project's own OpenAI key (user-approved); test data written during the audit is inventoried in `10-runtime-verification.md`.

## Phase → file map

| File | Phase | Deliverable |
|------|-------|-------------|
| [01-system-map.md](01-system-map.md) | 1 | Architecture overview, dependency graph, request/data flow, vector storage policy audit |
| [02-execution-trace.md](02-execution-trace.md) | 2 | Step Ledger (S-xx): complete request lifecycle |
| [03-divergence-analysis.md](03-divergence-analysis.md) | 3 | Decision Point Register + divergence trees (Issue 1) |
| [04-multiturn-quality-audit.md](04-multiturn-quality-audit.md) | 4 | Multi-turn forensics (Issue 2) |
| [05-agent-architecture-audit.md](05-agent-architecture-audit.md) | 5 | Agent state machine, decision boundaries |
| [06-tooling-review.md](06-tooling-review.md) | 6 | Tool catalog with dispositions |
| [07-business-rules-prompt-audit.md](07-business-rules-prompt-audit.md) | 7 | business.md ↔ prompt blocks ↔ code tri-diff |
| [08-albanian-language-audit.md](08-albanian-language-audit.md) | 8 | Albanian capability score + weaknesses |
| [09-component-deep-audit.md](09-component-deep-audit.md) | 9 | 20-domain component audit |
| [10-runtime-verification.md](10-runtime-verification.md) | 10 | Runtime evidence vs static claims; live replay results |
| [11-root-causes.md](11-root-causes.md) | 11 | Root-cause ledger with refutation verdicts |
| [12-enterprise-architecture-review.md](12-enterprise-architecture-review.md) | 12 | Candidate architectures + recommendation |
| [13-determinism-audit.md](13-determinism-audit.md) | 13 | Nondeterminism inventory |
| [14-production-readiness.md](14-production-readiness.md) | 14 | Readiness audit + 12-dimension scored matrix |
| [15-observability-audit.md](15-observability-audit.md) | 15 | Observability gap analysis |
| [16-remediation-plan.md](16-remediation-plan.md) | 16 | P0–P3 remediation roadmap |
| [appendix-A-evidence-log.md](appendix-A-evidence-log.md) | — | Verbatim SQL/Redis queries + results |
| [appendix-B-unconfirmed-hypotheses.md](appendix-B-unconfirmed-hypotheses.md) | — | Refuted/weakened candidates |

## Reading order

**First-time readers:** start with the executive causal summary in **[11-root-causes.md](11-root-causes.md)** (the two Issues and their top-down drivers), then read **[03-divergence-analysis.md](03-divergence-analysis.md)** (Issue 1 — identical input, divergent outcome) and **[04-multiturn-quality-audit.md](04-multiturn-quality-audit.md)** (Issue 2 — correct-early, degrades-later) for the two core failure modes, then **[12-enterprise-architecture-review.md](12-enterprise-architecture-review.md)** (target architecture + the determinism verdict) and **[16-remediation-plan.md](16-remediation-plan.md)** (the P0–P3 roadmap). Everything else is supporting depth.

## Master finding table

The 22 **CONFIRMED** root causes (Phase 11). `Issue` = which investigated problem the RC drives (1 = nondeterministic divergence, 2 = depth degradation, cross = both/infrastructure). `Primary file` is the load-bearing site (`backend/src/…` unless noted); full file:line evidence is in each RC's Phase 11 entry. `Remediation` lists every P-item that addresses the RC (primary owner **bold**), per the § Root-cause coverage matrix in [16-remediation-plan.md](16-remediation-plan.md).

| RC | Title (short) | Issue | Severity | Primary file | Remediation (P-id) |
|----|---------------|-------|----------|--------------|--------------------|
| RC-01 | Fail-closed, non-deterministic product-info-gap escalation gate | 1 | **Critical** | `services/productInformationGapService.ts` | **P0-3**, P1-5, P1-6, P2-1, P3-1, P3-4 |
| RC-02 | Hallucination/gap guards validate reply vs per-turn retrieval set, not catalog | cross | **Critical** | `services/aiService.ts` (name/gap guard) + `services/priceConsistencyGuard.ts` | **P0-2**, P0-3, P1-5, P1-6, **P2-1**, P3-1, P3-4 |
| RC-03 | Reply generation at temp 0.3, no seed → divergent, sometimes fabricating replies | 1 | High | `services/aiService.ts` (`generateReply`) | P1-5, P1-6, P2-1, P2-7, **P3-1**, P3-4, P3-6 |
| RC-05 | Timing-dependent burst composition / 8s-debounce (merge vs separate vs stale-skip) | 1 | High | `jobs/processInboundMessage.ts` | **P3-1**, P3-2 |
| RC-06 | Enablement gates + knobs read at job-run time (≥8s post-receipt) | 1 | Medium | `jobs/processAIReply.ts` | P0-5, **P2-4**, P2-7, P3-1 |
| RC-07 | Confidence-boost asymmetry (4 escalation detectors boost; order-affirmation doesn't) | 1 | Medium | `services/aiService.ts` (detectors) | **P1-3**, P2-2, P3-1, P3-6 |
| RC-08 | LLM decisions on fixed confidence boundaries → borderline phrasing flips class | 1 | Medium | `jobs/processAIReply.ts` (threshold gates) | **P1-3**, P2-2, P3-1, P3-6 |
| RC-10 | Reply language from low-variance LLM/heuristic with a hard `'sq'` default | 1 | Medium | `services/aiService.ts` (language resolve) | **P2-2**, P2-5, P3-1 |
| RC-11 | Webhook freshness check falls back to `Date.now()`; 403s late-but-valid deliveries | 1 | Medium | `controllers/webhookController.ts` | **P2-4** |
| RC-13 | 40-message history window + lost `product_ids` anchor drop load-bearing facts | 2 | High | `services/aiService.ts` (history assembly) | **P2-3**, P3-1 |
| RC-14 | Escalations fire final-turn + NO AI auto-resume → permanent silent dead-end | 2 | High | `controllers/aiAlertController.ts` (resume) | **P0-5**, P3-1 |
| RC-16 | Unfiltered history re-feeds flagged/undelivered replies as assistant turns | 2 | Medium | `services/aiService.ts:3117` | **P2-3**, P3-1 |
| RC-17 | Delete-only 900s `ai_config` cache (carries `custom_model_id`) → divergent persona/model | 2 | Medium | `services/aiService.ts` (config cache) | P1-5, **P2-3**, P2-4, P2-7, P3-5, P3-6 |
| RC-18 | Rate counter INCRs per job attempt before gates → retries exhaust 25/h budget | 2 | Medium | `jobs/processAIReply.ts:~1231` | **P0-6**, P1-2, P3-2 |
| RC-19 | Single umbrella try/catch makes the pre-reply escalation subsystem fail-open | cross | High | `jobs/processAIReply.ts:1383-1948` | **P0-4**, P2-6 |
| RC-20 | Non-idempotent on retry — crash-after-send dead-letters (global UNIQUE) or duplicates | cross | High | `jobs/processAIReply.ts` + `db/migrations/012_create_messages.sql` | **P1-1**, P1-2, P2-4, P3-2 |
| RC-21 | Message persisted but `ai.reply` job never created → artifact-free silence | 2 | High | `jobs/processInboundMessage.ts:~886-907` | **P1-1**, P1-2, P2-4 |
| RC-22 | Intent/draft-order throw swallowed; commission evaluated `NOW()`-relative post-send | cross | Medium | `jobs/processAIReply.ts:~3831` | P0-4, P1-5, **P2-2**, P3-1, P3-6 |
| RC-23 | CI/CD & migration gaps — deploy races CI, `npm test` never runs, duplicate migrations | cross | Medium | `.github/workflows/deploy.yml` (+ `ci.yml`, `db/migrate.ts`) | **P0-1**, P3-3, P3-4 |
| RC-24 | IG/FB self-echo misclassified as human reply — kills use-case billing + 10-min silence | cross | Medium | `services/webhookNormalizer.ts:92` (+ `outboundEchoRegistry.ts`) | **P0-7** |
| RC-25 | Albanian/Gheg capability gap; restrictions footer reaches only 1 of 6 tenants | cross | Medium | `services/aiService.ts` (dialect regex / `buildRestrictionsFooter`) | **P2-5**, P3-4, P3-5 |
| RC-26 | Prompt-assembly defects — orphan `offers_promotions` block; unbudgeted system prompt | cross | Medium | `services/promptAssemblyService.ts` | P2-5, **P3-5** |

**Also carried (WEAKENED — latent/narrowed, full detail in [11-root-causes.md](11-root-causes.md) + the 16 coverage matrix):** RC-04 (High — non-aborting 5s embedding race / per-process FIFO cache; `services/aiService.ts`; → **P1-4**), RC-09 (High — unscoped `findChannelByTypeAndExternalId` LIMIT-1, the genuine latent multi-tenant isolation defect; `db/models/channel.ts:119-128`; → **P1-7**), RC-15 (Medium — `QUALITY_THRESHOLD=0.1` live + systematic 0.200 eval on order confirmations; `services/aiQualityService.ts`; → **P2-1**/P2-7).

**Count summary.** **26** candidates adjudicated at Phase 11 → **22 CONFIRMED** (table above) · **3 WEAKENED** (RC-04, RC-09, RC-15) · **1 REFUTED** (RC-12 — see [appendix-B-unconfirmed-hypotheses.md](appendix-B-unconfirmed-hypotheses.md)). Note: `confirmed.json` carries all **25** confirmed+weakened rows; the ledger has no RC-12. These root causes are corroborated by **151 component findings** (Phase 9: 0 S0 / 30 S1 / 90 S2 / 31 S3) and **160 divergence points** (Phase 3, from 170 candidates after cross-segment dedup). Every confirmed RC maps to ≥1 remediation item (16: 25/25 covered, 0 gaps); the roadmap spans **27** P-items across P0–P3.

## Documentation-vs-implementation discrepancy register

Confirmed drifts between the repo's own docs (`CLAUDE.md`, `backend/.env.example`, `business.md`) and the verified live/code behavior (Phase 10 runtime ground truth unless noted). Each is a place where a reader trusting the docs would be wrong.

| # | Documented claim (source) | Verified actual | Evidence |
|---|---------------------------|-----------------|----------|
| D1 | `CLAUDE.md` §6 `ai_alerts` reason list is presented as the alert taxonomy | Incomplete — live reasons include `product_image_unavailable` (the one alert that fires early and lets conversations continue, Q7) and others not in the doc list | [09-component-deep-audit.md](09-component-deep-audit.md), [04-multiturn-quality-audit.md](04-multiturn-quality-audit.md) (Q7) |
| D2 | `CLAUDE.md` §10: `OPENAI_EMBEDDING_MODEL` default `text-embedding-3-large` (3072-dim) | Live runs `text-embedding-3-small` (1536-dim); the `-large` default is a real footgun vs `vector(1536)` (dimension landmine — **dormant**, all 258 live vectors are `-small`) | [10-runtime-verification.md](10-runtime-verification.md) (WF-G live config) |
| D3 | `backend/.env.example`: `QUALITY_THRESHOLD=0.6` | Live/code default `0.1` — a 6× lower floor that ships low-value replies and coexists with a systematic `0.200` false-low on order confirmations (RC-15) | [10-runtime-verification.md](10-runtime-verification.md) (WF-G); RC-15 in [11-root-causes.md](11-root-causes.md) |
| D4 | `.env.example`/code: fine-tuning/chat base model `gpt-4o-mini` | Live chat/vision/intent/eval all `gpt-4o`; `OPENAI_FINETUNING_BASE_MODEL` live `gpt-4o-2024-11-20` (not `-mini`) | [10-runtime-verification.md](10-runtime-verification.md) (WF-G live config) |
| D5 | `business.md` framed as **19 rules** (earlier count) | Actual **17 rules** (Phase 7 tri-diff correction) | [07-business-rules-prompt-audit.md](07-business-rules-prompt-audit.md) |
| D6 | `business.md` restrictions are the intended business-rule guardrails for every tenant | The restrictions footer (business.md's Albanian translation) is delivered to **only 1 of 6 tenants**; `platform_restrictions` is **never rendered** (`buildRestrictionsFooter` path) — most tenants run without the business rules in-prompt (RC-25) | [07-business-rules-prompt-audit.md](07-business-rules-prompt-audit.md); RC-25 |
| D7 | `CLAUDE.md` §5 queue set: `webhook` · `ai` · `notifications` · `finetuning` · `default` (`ai.reply` documented as a job-type) | Live queues **exceed** the documented set: `ai.reply` is a **separate queue**, plus `message.inbound`, `finetuning.prepare`, `product.embedding` (all undocumented); `notifications` has zero producers (dead) | [10-runtime-verification.md](10-runtime-verification.md) (WF-G) |
| D8 | Numbered `.sql` migrations imply a unique, monotonic apply order | Ordinals `062`/`063`/`064`/`065` each exist **twice**; `migrate.ts` `.sort()`s lexicographically with per-file `BEGIN/COMMIT`, so `065_offers` applied **before** `063_catalog_grounding` — tracking is by filename, not number (duplicate-062) | [09-component-deep-audit.md](09-component-deep-audit.md) (C-48/C-150/C-151, EV-037); [10-runtime-verification.md](10-runtime-verification.md) |

## Production readiness score summary

**Overall production readiness: 29 / 100.** Twelve dimensions, each scored 0–100 by a **3-scorer panel**; the value below is the **median** of the three, the range is [min, max]. The panel was **tightly clustered** — max dissent spread **5 points**, no dimension approached the 20-point disagreement threshold (widest: Retrieval Quality, Cost Efficiency, and Overall, all 5-point ties). Full matrix and rationale in [14-production-readiness.md](14-production-readiness.md); raw per-scorer values in `scores.json`.

| Dimension | Median | Range |
|-----------|:------:|:-----:|
| Architecture | 35 | 35–36 |
| Reliability | 26 | 24–28 |
| Determinism | 18 | 18–20 |
| Scalability | 32 | 32–35 |
| Maintainability | 32 | 30–33 |
| Security | 44 | 44–48 |
| Observability | 22 | 22–25 |
| AI Robustness | 23 | 23–25 |
| Retrieval Quality | 33 | 33–38 |
| Conversation Quality | 30 | 30–33 |
| Cost Efficiency | 30 | 25–30 |
| **Overall Production Readiness** | **29** | **24–29** |

The two lowest dimensions — **Determinism (18)** and **Observability (22)** — are the audit's through-line: identical inputs diverge (Issue 1) and the system persists no decision provenance to explain why (five observability categories absent, Phase 15). Security (44) is the ceiling and still failing.
