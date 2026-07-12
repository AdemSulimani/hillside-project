# Phase 3 — Differential Investigation (Issue 1: identical requests, different outcomes)

> **Evidence base:** All findings below are grounded in source code (file:line cited) and, where noted, the dev/staging database (6 tenants / 46 conversations / 374 messages / 617 products / 20 ai_alerts). Dev data demonstrates mechanisms, not production incidence rates. See appendix-A-evidence-log.md for verbatim query evidence.

This report answers one question: **by what mechanisms can two identical inbound messages, sent to the same tenant with the same catalog, produce different outcomes?** Outcomes are classified into four classes used throughout: **correct answer**, **wrong answer** (including denial of knowledge of a catalog product, wrong language, mutilated/duplicated replies), **escalation** (holding message + alert and/or pause), and **silence** (no customer-visible reply). Step ids (S-01 … S-74) refer to the execution trace in `02-execution-trace.md`; EV-nnn ids refer to `appendix-A-evidence-log.md`.

## Decision Point Register

Six register segments (ingest/queue, gating/pre-reply, retrieval, prompt/context, generation/guards, persist/order) produced **170 candidate decision points**. After deduplication across segments, **160 rows** remain; 10 overlapping rows were absorbed into the better-evidenced survivor and are noted inline in the id column:

- DP-iq-19 absorbed DP-GPR-01, DP-GPR-02 (S-14 fairness slot: re-add loop + counter TTL drift — same lines, single combined row)
- DP-iq-20 absorbed DP-GPR-03 (S-15 lock: Redis-error-as-busy reschedule loop)
- DP-iq-21 absorbed DP-GPR-05 (S-16 rate counter INCR per attempt)
- DP-iq-22 absorbed DP-GPR-06 (S-16 pause+alert transaction failure)
- DP-iq-23 absorbed DP-GPR-07 (S-17 enablement gates read at job-run time)
- DP-iq-24 absorbed DP-GPR-08 (S-19 human-hold reschedule window)
- DP-iq-26 absorbed DP-gg-04 (S-42 BullMQ retry re-runs the whole pipeline; the empty-completion throw at aiService.ts:4127 is one trigger of the same mechanism)
- DP-retrieval-20 absorbed DP-pc-05 (120s alphabetical-fallback catalog cache — same Redis key, two vantage points)
- DP-retrieval-12 absorbed DP-po-29 (same line, processAIReply.ts:3211 — empty product_ids on holding/escalation turns)

Rows are ordered by execution step. `likelihood` uses the three tiers defined for this phase: **per-request** (stochastic, can fire on any request), **timing-window** (requires specific timing/concurrency), **environmental** (standing state: config drift, embedding state, infrastructure health); `rare` marks points that additionally require an uncommon precondition; rows whose dominant gate is the uncommon precondition itself carry `rare` alone, with the underlying tier readable from the mechanism text. Note on cache staleness: TTL-bounded cache windows opened by a mutation (e.g. an admin edit racing a 900s TTL) are classified **timing-window** — the divergence requires an edit to coincide with the window — whereas persistent unbounded states (threshold drift, embedding-model drift, orphaned config rows) are **environmental**. Full mechanism text, conditions, observable signals, and evidence quotes for every row are preserved in `scratchpad/audit/register/merged.json`.

| id | step | type | failure mode | likelihood | can produce | mechanism (1-line) |
|---|---|---|---|---|---|---|
| DP-iq-01 | S-03 | error-fallback | fail-open | environmental | correct, wrong | The freshness check reads a body-embedded timestamp; when the payload carries none, eventEpochMs falls back to Date.now(), so \|now - now\| is always 0 and the skew gate always passes. Two identical events differ in outcome purel... |
| DP-iq-02 | S-03 | timing | fail-closed | environmental | correct, silence | A delivery arriving > 300s after its body timestamp (e.g. Meta retry burst after an outage, queue backlog on Meta's side) is rejected 403 and never enqueued. The identical message delivered promptly gets a reply; delivered late... |
| DP-iq-03 | S-04 | data-order | silent-drop | timing-window | correct, silence | The edge dedupe key concatenates ALL message mids in the payload ('parts.join(\|)') while normalization (S-06) reads only entry[0]/messaging[0]/messages[0]. |
| DP-iq-28 | S-04 | error-fallback | throw-retry | environmental | correct, silence | The edge dedupe SET has no try/catch; a Redis outage makes the handler throw → 500 to Meta → Meta retries with backoff. |
| DP-iq-04 | S-05 | error-fallback | silent-drop | environmental | correct, silence | res.sendStatus(200) executes before the fire-and-forget enqueue ('void enqueueInboundPayload()'). |
| DP-iq-05 | S-06 | error-fallback | silent-drop | rare | silence, escalate | Normalization errors matching 'required message identifiers are missing' are swallowed for whatsapp/instagram/facebook (shouldIgnoreNormalizationError) as presumed non-message events; |
| DP-iq-06 | S-07 | data-order | silent-drop | rare | correct, silence | The worker dedupe queries messages by external_message_id with no tenant or channel scope. |
| DP-iq-14 | S-07 | concurrency | throw-retry | rare | correct, wrong | The DB dedupe is check-then-insert (TOCTOU): with webhook worker concurrency 10, two jobs carrying the same message (distinct payloads that passed edge dedupe separately, e.g. |
| DP-iq-07 | S-08 | data-order | fail-open | rare | correct, wrong | Channel/tenant resolution is by (type, external_id) with LIMIT 1 and no ORDER BY. |
| DP-iq-08 | S-08 | timing | throw-retry | timing-window | correct, silence | Channel not found throws, giving 3 attempts at fixed 5s. A webhook racing channel creation/reconnection (row committed within ~10s) succeeds on a later attempt; outside that window the job permanently fails and the message is s... |
| DP-iq-10 | S-09 | error-fallback | fail-open | environmental | correct, wrong | Graph profile lookups (throttled 24h/10min) succeed or degrade to fallback labels ('IG user 123...'). |
| DP-iq-09 | S-10 | error-fallback | fail-open | environmental | correct, wrong | Per-attachment download/upload failures are logged and the attachment dropped; |
| DP-iq-29 | S-10 | error-fallback | fail-open | rare | correct, wrong | Webhook-job retries (channel-not-found, message-INSERT failure, debounce throw) re-execute everything before the S-07 anchor exists: Graph profile fetches and attachment downloads/uploads run again, storing NEW Cloudinary/Backb... |
| DP-iq-11 | S-11 | cache-staleness | fail-open | timing-window (TTL/registry race); environmental (Redis read-error variant) | correct, silence, wrong | Self-echo recognition depends on a Redis key with TTL 600s, and read errors return false ('catch { return false; |
| DP-iq-12 | S-11 | data-order | fail-open | timing-window | correct, wrong, silence | Echo classification is a single heuristic: no app_id => human agent; |
| DP-iq-13 | S-11 | timing | fail-open | timing-window | correct, wrong | API-origin echoes whose mid differs from the recorded send id are deduped by content within ECHO_DEDUP_WINDOW_MS = 5 min. |
| DP-iq-18 | S-12 | concurrency | none | timing-window | correct, wrong, silence | Webhook worker concurrency (default 10, prod 3) processes jobs for the SAME conversation in parallel with no ordering guarantee. |
| DP-iq-15 | S-13 | error-fallback | silent-drop | timing-window (job-remove race); environmental (Redis-failure variant) | correct, silence | Any throw AFTER the message row persists (S-12) but BEFORE aiQueue.add succeeds — existingJob.remove() racing a job that just became active, aiQueue.getJobs/add Redis failure — fails the webhook job. |
| DP-iq-16 | S-13 | timing | none | timing-window | correct, wrong, silence | The 8s delay + debounce means two rapid messages produce ONE merged reply if the second arrives while the first job is still delayed/waiting, but TWO separate replies if it arrives after the first job went active (getJobs(['del... |
| DP-iq-17 | S-13 | concurrency | none | timing-window | correct, silence | The debounce uses .find() — it removes AT MOST ONE pending ai.reply for the conversation. |
| DP-iq-19 (merged: DP-GPR-01, DP-GPR-02) | S-14 | concurrency | fail-open | timing-window | correct, silence | Over the per-tenant cap (8), the job DECRs and re-adds ITSELF as a brand-new job (+3s) with a fresh attempts counter and no jobId (despite the 'Inherit the original jobId' comment) — retry budget is unbounded across reschedules... |
| DP-iq-20 (merged: DP-GPR-03) | S-15 | concurrency | fail-open | timing-window | correct, silence | Lock contention re-adds a fresh job every 3s until the lock frees. |
| DP-GPR-04 | S-15 | concurrency | fail-open | rare | correct, wrong | Lock TTL is 300s (AI_CONVERSATION_LOCK_TTL_MS) but a single ai.reply pass can make 18-25+ serialized LLM calls, each with SDK 60s timeout x 3 retries — a slow pass can exceed the TTL. |
| DP-iq-21 (merged: DP-GPR-05) | S-16 | concurrency | fail-closed | timing-window | correct, escalate, silence | The 25/h counter INCRs once per job ATTEMPT, before the enablement gates and the staleness guard: BullMQ retries after mid-pipeline throws, jobs later skipped as stale, and jobs for conversations whose AI is disabled all consum... |
| DP-iq-22 (merged: DP-GPR-06) | S-16 | error-fallback | fail-open | rare | escalate, silence | On a rate-limit breach the pause+alert runs in one transaction with catch → ROLLBACK → log; |
| DP-GPR-31 | S-16 | config-drift | none | environmental | correct, wrong, escalate, silence | Gating knobs have mixed read lifetimes: AI_MAX_REPLIES_PER_HOUR is re-read from env PER JOB (1227) and HUMAN_HOLD_MINUTES per call (conversationService.ts:350), while AI_MAX_CONCURRENT_PER_TENANT (1093), AI_CONVERSATION_LOCK_TT... |
| DP-iq-23 (merged: DP-GPR-07) | S-17 | timing | silent-drop | timing-window | correct, silence | All three enablement gates (ai_configs.is_active, channel.ai_enabled, conversation.ai_paused/human_override_until) are evaluated at JOB-RUN time, which is >= 8s (delay) and possibly minutes (fairness/lock/hold reschedules, retr... |
| DP-iq-24 (merged: DP-GPR-08) | S-19 | timing | silent-drop | timing-window | correct, silence | rescheduleReplyAfterHumanHold defers the reply only when three clock/state conditions hold: remaining hold <= HUMAN_HOLD_MINUTES*60_000 + 60_000 (an 'anomalously long' hold silently skips — including holds that merely LOOK long... |
| DP-iq-25 | S-19 | concurrency | fail-open | timing-window | correct, wrong, silence | The hold reschedule adds a FRESH job (no jobId, fresh attempts) at remaining+5s. |
| DP-GPR-09 | S-19 | timing | silent-drop | timing-window | correct, silence | rescheduleReplyAfterHumanHold silently declines when the latest inbound's external_message_id differs from the job's, or when a human outbound exists after it. |
| DP-GPR-10 | S-20 | timing | none | timing-window | correct, wrong, escalate, silence | Burst composition is 'inbound messages after the most recent OUTBOUND within the 40-message window, last 5'. |
| DP-GPR-11 | S-20 | data-order | none | timing-window | correct, wrong | Near-duplicate burst messages are deduplicated by token Jaccard >= 0.82 (plus a substring shortcut for length >= 12). |
| DP-pc-09 | S-20 | data-order | silent-drop | per-request (long conversations) | correct, wrong, escalate | History is the most recent HISTORY_FETCH_LIMIT=40 rows with only WHERE conversation_id — message 41 counting backwards vanishes from BOTH the raw window and the older-summary input. |
| DP-pc-11 | S-20 | data-order | none | rare | correct, wrong | Ordering is created_at then id; ids are random UUIDs, so two messages persisted in the same timestamp tick (burst inbound processed by parallel webhook workers) sort by UUID, not arrival. |
| DP-GPR-12 | S-21 | timing | silent-drop | timing-window | correct, silence | Stale-job guard: if a newer inbound was persisted between enqueue and execution, this job exits silently, delegating to the newer message's job. |
| DP-GPR-13 | S-21 | data-order | silent-drop | timing-window | correct, silence | The reaction guard tests the MERGED burst text with startsWith. |
| DP-GPR-33 | S-21 | data-order | silent-drop | timing-window | correct, silence | Emoji-only guard evaluates the MERGED burst text: an emoji-only message merged with a text question is answered, but the identical emoji message processed alone (different timing → different burst composition) exits silently wi... |
| DP-GPR-14 | S-22 | llm-stochastic | fail-open | per-request | correct, wrong | For messages the marker heuristic cannot resolve, reply language is decided by a temp-0 LLM call (still low-variance stochastic and model-version dependent). |
| DP-GPR-15 | S-23 | llm-stochastic | none | per-request | correct, wrong, escalate | Cancellation/refund routing is decided by a temp-0 JSON classifier acting at 'confidence > 0.8'. |
| DP-GPR-16 | S-23 | llm-stochastic | fail-open | per-request | correct, escalate | Confidence-boost quirk: if the model asserts is_cancellation/is_refund but omits or zeroes 'confidence', the code overwrites confidence to 0.9, guaranteeing the >0.8 gate passes. |
| DP-GPR-17 | S-23 | error-fallback | fail-open | environmental | wrong, correct | detectCancellationOrRefundIntent has NO internal transport catch; |
| DP-GPR-18 | S-23 | error-fallback | fail-open | rare | wrong | The canned cancellation ack send has no idempotency marker, and everything after it (createMessage, markOrderCancellationRequested/markOrderRefundRequested, createAIAlert, setConversationAiPaused) runs un-transactionally inside... |
| DP-GPR-19 | S-23 | timing | silent-drop | timing-window | correct, silence | When cancellation/refund intent IS confidently detected but shouldStillSendAutomatedReply fails (newer inbound, human outbound, toggle flipped in the window), the path returns with NO alert, NO pause, and NO order flag — the de... |
| DP-GPR-28 | S-23 | error-fallback | silent-drop | environmental | correct, wrong, escalate, silence | A single umbrella try/catch (opened at line 1379, closed 1942-1948) wraps the ENTIRE pre-reply special-path block. |
| DP-GPR-29 | S-23 | concurrency | none | timing-window | correct, wrong, escalate | findLatestOpenOrderForContactForEscalation is CONTACT-scoped (not conversation-scoped), so which order gets marked cancellation/refund-requested depends on order rows racing this job — a draft order created by a concurrent pipe... |
| DP-GPR-30 | S-23 | timing | fail-open | timing-window | correct, wrong | shouldStillSendAutomatedReply is check-then-act with no lock spanning check→send: a human reply or pause landing in the gap between the precheck SELECTs and sendMessage still lets the canned/ETA/holding message go out, producin... |
| DP-GPR-32 | S-23 | error-fallback | fail-open | rare | wrong, correct | All five pre-reply canned sends persist their outbound with external_message_id = graphMessageId ?? 'ai_'+randomUUID(). |
| DP-GPR-20 | S-24 | llm-stochastic | none | per-request | correct, wrong, escalate | Wrong-product routing: temp-0 classifier at 'confidence > 0.8' (with the 0→0.9 boost at aiService.ts:2584-2586). |
| DP-GPR-21 | S-24 | error-fallback | fail-open | rare | wrong, silence | In the wrong-product escalation (and identically the post-purchase escalation at line 1753), failure of the pause + human_replied-reset + alert transaction is caught and only logged — but the code STILL sends the holding messag... |
| DP-GPR-22 | S-25 | llm-stochastic | fail-open | per-request | correct, wrong, escalate | Two temp-0 LLM verdicts act as vetoes deciding whether the post-purchase, delivery-ETA, and order-info-update branches run at all: classifyNewOrderSignal (boolean, keyword fallback on error) and detectOrderAffirmationIntent at ... |
| DP-GPR-23 | S-25 | error-fallback | fail-open | environmental | wrong, correct | detectOrderAffirmationIntent has no internal transport catch (only parse-level defaults at 2751/2770); |
| DP-GPR-24 | S-26 | llm-stochastic | fail-open | per-request | correct, wrong, escalate | detectPostPurchaseSupportIntent runs only behind the deterministic regex cue hasPostPurchaseIssueCue (line 1598), then acts at 'confidence > 0.8' with the 0→0.9 boost. |
| DP-GPR-25 | S-27 | llm-stochastic | none | per-request | correct, escalate, silence | isDeliveryEtaOnlyQuery = (LLM eta-flag AND none of the 3 complaint flags AND conf>0.8) OR the deterministic regex hasDeliveryEtaOnlyCue. |
| DP-GPR-26 | S-29 | llm-stochastic | fail-open | per-request | correct, wrong | Order-info-update fires at 'confidence > 0.82' with the 0→0.85 boost (aiService.ts:2888) and directly UPDATEs the latest active conversation-scoped order's customer fields with LLM-EXTRACTED values (address/phone/name/notes). |
| DP-GPR-27 | S-29 | timing | silent-drop | timing-window | wrong, silence | updateOrderCustomerInfoForAI executes BEFORE the send precheck (line 1857). |
| DP-pc-01 | S-31 | cache-staleness | none | timing-window | correct, wrong | ai_config:{tenantId} is cached 900s with delete-only invalidation. |
| DP-pc-02 | S-31 | concurrency | fail-open | rare | correct, wrong | All four loaders are read-aside with no versioning or check-and-set. |
| DP-pc-03 | S-31 | cache-staleness | none | timing-window | correct, wrong | tenant:{tenantId} caches name/niche/description/delivery_methods for 1800s — double the config TTL. |
| DP-pc-04 | S-31 | cache-staleness | none | timing-window | correct, wrong, escalate | tenant_prompt_blocks:{tenantId} is cached 900s. An admin prompt-block patch (enable/disable/content) mid-window produces two workers assembling different Guidelines sections (~4.5K tokens of behavioral rules) for the identical ... |
| DP-pc-06 | S-31 | config-drift | fail-open | rare | correct, wrong | When no ai_configs row exists, loadAIConfig caches DEFAULT_AI_CONFIG (which carries is_active: true, no restrictions, default tone) for 900s. |
| DP-pc-07 | S-31 | error-fallback | throw-retry | environmental | correct, silence | The cache loaders await redisConnection.get/set with no try/catch around the Redis calls themselves — a Redis outage makes loadAIConfig/loadTenant/loadTenantPromptBlocksCached throw, failing generateReply and the whole ai.reply... |
| DP-pc-08 | S-31 | config-drift | throw-retry | per-request (write attempted every reply); divergence timing-window | correct, wrong, silence | ensureTenantPromptBlocksSeeded runs forceSyncLockedBlocksForTenant on EVERY generateReply: any tenant-row content of a locked block that differs from catalog default_content is silently overwritten at reply time (promptBlock.ts... |
| DP-retrieval-01 | S-33 | timing | fail-open | timing-window | correct, wrong, escalate | Query embedding races a 5s timer (EMBEDDING_QUERY_TIMEOUT_MS default 5000). |
| DP-retrieval-02 | S-33 | error-fallback | fail-open | environmental | correct, wrong | Any embedding API error (429, 5xx, network reset — after the SDK's own 60s/3-retry budget) is swallowed by a bare catch returning null; |
| DP-retrieval-03 | S-33 | cache-staleness | none | per-request | correct, wrong | Query embeddings are cached in a per-process Map (max 256, FIFO eviction despite the 'LRU-style' comment — reads never refresh insertion order). |
| DP-retrieval-22 | S-33 | config-drift | fail-open | environmental | correct, wrong | generateEmbedding uses OPENAI_EMBEDDING_MODEL with code fallback text-embedding-3-large (3072-dim) and NO dimensions param, while the schema is vector(1536). |
| DP-retrieval-23 | S-33 | timing | fail-open | timing-window | correct, wrong | The 5s race does NOT abort the losing OpenAI call — it keeps running (up to the SDK's 60s/3 retries) consuming rate-limit budget, and because the race already returned null its eventual vector is never cached (setCachedQueryEmb... |
| DP-retrieval-07 | S-34 | data-order | none | per-request | correct, wrong | The adaptive ef_search retry (100 -> 500) fires only when the first pass returns fewer rows than `limit`. |
| DP-retrieval-08 | S-34 | data-order | silent-drop | environmental | correct, wrong, escalate | The HNSW index is global with tenant_id applied as a post-filter. |
| DP-retrieval-10 | S-34 | config-drift | fail-open | environmental | correct, wrong | The read-time model guard excludes rows embedded by a different model but ADMITS embedding_model IS NULL legacy rows on the assumption they share the current model/dimensions. |
| DP-retrieval-17 | S-34 | cache-staleness | silent-drop | timing-window | correct, wrong, escalate | updateProduct atomically nulls embedding + embedding_input_hash whenever any embedding-input field changes; |
| DP-retrieval-18 | S-34 | cache-staleness | silent-drop | environmental | correct, wrong | Hash-drift detection (rows whose text changed without passing through updateProduct's invalidation, or whose model differs) runs only every 6h, scans only the RECONCILE_BATCH_LIMIT*3 most recently updated rows, and requeues at ... |
| DP-retrieval-25 | S-34 | config-drift | none | environmental | correct, wrong | HNSW_EF_SEARCH (default 100) and HNSW_EF_SEARCH_MAX (default 500) are per-process env values; |
| DP-retrieval-04 | S-35 | llm-stochastic | none | rare | correct, wrong | The OpenAI embeddings API is not bit-exact across calls; the same text can return marginally different vectors. SIMILARITY_THRESHOLD is applied as a strict JS post-filter (>= 0.65) with no hysteresis, so a product scoring ~0.64... |
| DP-retrieval-05 | S-35 | config-drift | none | environmental | correct, wrong | SIMILARITY_THRESHOLD is env-resolved per process. The code comments document real historical drift: '.env.example default of 0.65 and an overriding SIMILARITY_THRESHOLD=0.75 both used to be in circulation, causing silent config... |
| DP-retrieval-06 | S-35 | data-order | none | per-request | correct, wrong | When hasCategoryShoppingIntent(regex) is true AND categoryTagMatches.length > 0, the semantic source is omitted entirely (not down-weighted) from fusion. |
| DP-retrieval-09 | S-35 | error-fallback | fail-open | rare | correct, wrong | Any error from searchProductsBySimilarity (pool exhaustion, statement timeout, dimension mismatch, index error) is caught with a bare catch that sets semanticSkipped=true and continues lexical-only. |
| DP-retrieval-11 | S-35 | data-order | none | rare | correct, wrong | fuseByRRF sorts by score descending with no explicit tie-breaker; |
| DP-retrieval-12 (merged: DP-po-29) | S-36 | data-order | silent-drop | timing-window | correct, wrong, escalate | Every outbound AI message persists product_ids, but holding/escalation replies persist [] by design. |
| DP-retrieval-13 | S-36 | concurrency | silent-drop | timing-window | correct, wrong, escalate | Persisted product_ids are rehydrated via findActiveProductsByIds, which filters deleted_at IS NULL AND is_active = true and silently drops missing rows. |
| DP-retrieval-14 | S-36 | timing | fail-open | timing-window | correct, wrong, escalate | When persisted IDs are empty, anchor extraction scans the last 10 messages for a substantive customer message (four regex follow-up families excluded), falling back to the last 3 AI texts joined. |
| DP-retrieval-15 | S-36 | llm-stochastic | fail-closed | per-request | correct, wrong, escalate | On the final empty-retrieval safety net, if the cheap heuristic gate does not match, an LLM classifier (classifyContextualProductFollowUp) decides whether to reuse persisted products. |
| DP-retrieval-16 | S-36 | llm-stochastic | fail-open | per-request | correct, wrong | Retrieval MODE is selected by upstream LLM classifier outputs (attributeIntent.is_attribute_question, otherOptionsIntent.is_other_options_request — stochastic, enumerated in the classifiers segment) combined with local regexes:... |
| DP-retrieval-19 | S-36 | timing | fail-open | timing-window | correct, wrong, escalate | The zero-hit self-heal is fire-and-forget: on an empty result for a non-empty query it counts NULL-embedding rows and enqueues priority-1 embed jobs, but the CURRENT reply proceeds with products=[] (guardrail clarify reply or p... |
| DP-retrieval-20 (merged: DP-pc-05) | S-36 | cache-staleness | fail-open | timing-window | correct, wrong | The alphabetical fallback catalog (used ONLY when retrieval is empty AND the message has no meaningful keywords — greetings, emojis) is served from Redis key products:{tenantId} with a 120s TTL. |
| DP-retrieval-21 | S-36 | data-order | none | per-request | correct, wrong, escalate | The final outcome-class boundary: with products=[] the branch checks extractKeywords(searchText).length. |
| DP-retrieval-24 | S-36 | error-fallback | throw-retry | rare | correct, wrong, silence | Failure classes are asymmetric across retrieval routes: the fresh-search call (line 3661) and other-options search (3645) are wrapped in try/catch and fail open to products=[] (guardrail reply), but the contextual-resolver call... |
| DP-pc-21 | S-38 | error-fallback | fail-open | environmental | correct, wrong, escalate | getProductImageDerivedContext is wrapped in a catch that only console.warns: on any DB error the 'Verified packaging details' catalog extension is silently omitted AND the dependent 'Using packaging-derived details' system appe... |
| DP-pc-16 | S-39 | llm-stochastic | fail-open | per-request | correct, wrong, silence | Four LLM classifier outputs (S-32) toggle prompt CONTENT deterministically downstream: customerAskedPrice gates per-product 'Price: €N.NN' lines in the catalog (3830) and PRICE_LIST_COMPACT_APPEND when >5 products (3977-3979); |
| DP-pc-18 | S-39 | llm-stochastic | fail-open | per-request | correct, wrong | The detected reply locale (LLM at S-22, fail-open heuristic → 'sq') drives the {{TOKEN}} placeholder map inside every guideline block (order-closing example, data-confirmation sentence, discount rules) and the closing-sentence ... |
| DP-pc-19 | S-39 | config-drift | none | environmental (standing orphaned-block state; expressed on every request for affected tenants) | correct, wrong | assembleGuidelinesFromBlocks filters only row.enabled — the catalog is_active flag is never consulted at runtime (listTenantPromptBlocksRuntime does not join prompt_blocks) and catalog deactivation has no tenant-row-disable path. |
| DP-pc-10 | S-40 | data-order | none | per-request (any conversation >10 messages) | correct, wrong | Only the last RECENT_RAW_HISTORY_MESSAGES=10 rows stay verbatim; |
| DP-pc-12 | S-40 | data-order | silent-drop | per-request (long/verbose windows) | correct, wrong | The truncation loop drops oldest raw messages while estimated history tokens (chars/4, incl. |
| DP-pc-13 | S-40 | data-order | none | rare | correct, wrong | Three different measures of the same message: the add-estimate uses formatCustomerMessageContentForPrompt(msg) WITHOUT the editedAfterOutbound context (so no edit hint counted), the removal subtracts raw (removed.content ?? '')... |
| DP-pc-14 | S-40 | data-order | fail-open | per-request (whenever such rows exist) | correct, wrong | buildMessagesArray consumes the unfiltered history: replies previously flagged by guards/quality eval (flagged=true, e.g. |
| DP-pc-15 | S-40 | timing | none | timing-window (multi-message customers) | correct, wrong | The inbound-dedup check compares the last history user turn's text against the trimmed inboundMessage. |
| DP-pc-20 | S-40 | config-drift | none | environmental | correct, wrong | CONTEXT_MAX_HISTORY_TOKENS (92-97), HISTORY_FETCH_LIMIT (108-112) and AI_REPLY_TEMPERATURE (122-126) are IIFE-frozen at module load. |
| DP-pc-17 | S-41 | llm-stochastic | fail-open | per-request | correct, wrong, silence | The isConversationEnding LLM verdict picks one of three prompt outcomes for the identical inbound: (a) closing append with a fixed locale sentence, (b) no append (classifier false or catch{} → false), or (c) [NO_REPLY] silence ... |
| DP-gg-05 | S-41 | llm-stochastic | silent-drop | per-request | correct, silence | [NO_REPLY] site 1: when the `customerAskedDiscount` routing classifier (LLM, keyword fallback) fires AND a prior assistant message finalized the discount, generateReply returns '[NO_REPLY]' without calling the model — total sil... |
| DP-gg-06 | S-41 | llm-stochastic | fail-open | per-request | correct, wrong, silence | [NO_REPLY] site 2: `isConversationEnding` (LLM, fail-open to false on error at 4046-4048) decides among three outcomes for the same closing message: (a) ending + prior closing verbatim-matched → '[NO_REPLY]' silence; |
| DP-iq-26 (merged: DP-gg-04) | S-42 | error-fallback | throw-retry | environmental | correct, wrong, escalate | A BullMQ retry (3 attempts, exponential from 10s; also stall re-execution at maxStalledCount 2) re-runs the ENTIRE pipeline from S-14. Unguarded side effects repeat: every LLM classifier is re-rolled (stochastic — attempt 2 can... |
| DP-iq-27 | S-42 | error-fallback | silent-drop | environmental | correct, silence | When all 3 ai.reply attempts exhaust (sustained OpenAI/DB outage), the job lands in the failed set: no tenant-facing ai_alert, no customer message, no automatic requeue, no DLQ — only a prod ops webhook POST, and only if ALERT_... |
| DP-gg-01 | S-42 | llm-stochastic | none | per-request | correct, wrong, escalate, silence | The single customer-facing completion runs at temperature 0.3 (env AI_REPLY_TEMPERATURE, default 0.3) with NO seed, no top_p, no response_format. |
| DP-gg-02 | S-42 | cache-staleness | fail-open | timing-window | correct, wrong | Model choice is `config.custom_model_id \|\| process.env.OPENAI_CHAT_MODEL?.trim() \|\| 'gpt-4o'` where config comes from the Redis cache `ai_config:${tenantId}`. |
| DP-gg-03 | S-42 | llm-stochastic | none | per-request | correct, wrong | For image turns the model switches to OPENAI_VISION_MODEL (custom_model_id ignored), and the temperature clamps to min(cfg, 0.3) only when `productNotInCatalog \|\| shouldAskImageClarification \|\| imageMatchConfidence < 0.65` — al... |
| DP-gg-31 | S-42 | data-order | fail-open | per-request | correct, wrong | generateReply empties matchedProducts when the full-catalog fallback context was used (`usedFullCatalogFallback ? [] : products`). |
| DP-gg-07 | S-43 | llm-stochastic | silent-drop | per-request | silence | The [NO_REPLY] sink: the job returns before ANY guard, send, persist, quality eval, `ai_reply_sent` analytics event, or the 4h `evaluateConversationUseCase` enqueue. |
| DP-gg-08 | S-44 | llm-stochastic | none | per-request | correct, escalate | OOS exemption is an EXACT string match of the stochastic reply against OUT_OF_STOCK_PRODUCT_REPLY.sq/.en. |
| DP-gg-09 | S-45 | llm-stochastic | fail-open | per-request | correct, escalate | `classifyUsageQuestionIntent` (LLM temp 0, keyword fallback on error) is the master gate for usage guard variants A/B/C AND the speculative-health guard. |
| DP-gg-10 | S-45 | llm-stochastic | none | per-request | correct, escalate | Variant A only evaluates when the reply is NOT a normalized-verbatim copy of the product's usage_description. |
| DP-gg-11 | S-45 | llm-stochastic | fail-open | per-request | correct, wrong, escalate | `isUsageQuestionUnanswered` has three inconsistent failure surfaces: the PROMPT says fail-closed ('WHEN IN DOUBT → return {"is_unanswered": true}'), the function CODE returns false on empty/unparseable output, and the CALLER's ... |
| DP-gg-12 | S-45 | error-fallback | fail-open | rare | wrong, escalate | Usage escalation variants A (2039-2041) and B (2093-2099) do pause + human_replied=false + alert + reply replacement in ONE transaction; |
| DP-gg-13 | S-47 | llm-stochastic | fail-open | per-request | escalate, wrong | Variant C fires when the MODEL ITSELF stochastically authors specialist-escalation wording (fuzzy `isUsageEscalationHoldingMessage` match): the self-authored holding text is sent and alert+pause are added. |
| DP-gg-14 | S-48 | error-fallback | fail-closed | environmental | escalate | The gap assessor is the ONLY fail-closed guard: on empty context, empty model response, JSON parse error, or transport error it returns { answer:'', missing:[], ok:false }, and the caller escalates because `const shouldEscalate... |
| DP-gg-15 | S-48 | llm-stochastic | none | per-request | correct, escalate | Even on success, the assessor's temp-0 JSON (answer text + missing[] labels) drives a trilemma via deriveAnswerabilityStatus: 'complete' → original AI reply untouched; |
| DP-gg-16 | S-48 | error-fallback | fail-open | environmental | correct, escalate | `detectSpecifiedAttributes` (the only classifier with a 6s per-call abort) fails open to an EMPTY availableKeys set. |
| DP-gg-17 | S-48 | error-fallback | fail-open | rare | correct, escalate | getProductImageDerivedContext failure is caught and the 'Verified packaging details read from product images' block is simply omitted from knowledgeContext. |
| DP-gg-18 | S-48 | error-fallback | fail-open | rare | wrong, escalate | The gap escalation's pause+alert+replace transaction ROLLBACKs on failure and the reply stays unchanged — the original AI answer (already assessed as incomplete/ungrounded) is sent with no pause and no alert. |
| DP-gg-19 | S-49 | llm-stochastic | fail-open | per-request | correct, wrong, escalate | The health-advice guard classifies the STOCHASTIC reply, not the inbound: for the same suitability question, sample A that volunteers 'consult a doctor' is replaced with the usageEscalation holding message + pause + human_repli... |
| DP-gg-20 | S-50 | llm-stochastic | fail-open | per-request | correct, wrong, escalate | `classifyOrderConfirmationReplyIntent(inboundText, finalReplyText)` (LLM on the stochastic reply, keyword fallback) decides isOrderConfirmationReply, which (a) triggers ETA-strip + canonical delivery line + follow-up append, an... |
| DP-gg-21 | S-52 | llm-stochastic | fail-open | per-request | correct, wrong | The data-confirmation gate produces a three-way outcome from the same turn: AI reply as-is, DATA_CONFIRMATION_MESSAGES override, or MISSING_CUSTOMER_NAME_MESSAGES override. |
| DP-gg-22 | S-53 | llm-stochastic | fail-open | per-request | correct, wrong | `stripRepeatedOrderClosingQuestion`'s second parameter (`_orderClosingAlreadyAskedInConversation`) is UNUSED — the function strips an order-closing question whenever its hybrid regex+LLM detector finds one in the reply, regardl... |
| DP-gg-23 | S-54 | llm-stochastic | fail-open | per-request | correct, wrong | `stripGenericFollowUpInvitation` uses an LLM whole-reply gate first; |
| DP-gg-24 | S-55 | llm-stochastic | fail-open | per-request (eval-score jitter); environmental (QUALITY_THRESHOLD-drift variant) | correct, wrong, escalate | Quality eval on OPENAI_EVAL_MODEL scores the stochastic reply; |
| DP-gg-25 | S-55 | llm-stochastic | fail-open | per-request | correct, escalate | False-flag suppression clears qualityFailing/flagReason when flagReason ∈ {irrelevant, off_topic, low_confidence} AND either isOrderConfirmationReply (LLM) or `classifyOrderDetailsCollectionReplyIntent` (a further LLM call made... |
| DP-gg-26 | S-56 | llm-stochastic | fail-open | per-request | correct, escalate | The price guard itself is a pure deterministic regex ('Intentionally performs NO I/O'), but its INPUT is the stochastic reply: sample A rounds 9.99 to 'vetëm 10 euro' → whole reply replaced with productKnowledgeEscalation holdi... |
| DP-gg-28 | S-57 | llm-stochastic | fail-open | per-request | correct, wrong, escalate | `filterHallucinatedProductNames` is an LLM validator (temp 0, fuzzy-match instructions, reply truncated to 1,200 chars) judging the stochastic reply against matched catalog names: it can flag a legitimate shorthand ('MyBrand Pr... |
| DP-gg-29 | S-58 | llm-stochastic | none | per-request | correct, escalate | The uncertain-answer guard is a pure deterministic predicate, but three of its inputs are stochastic: the reply wording (isUncertainDeflection regexes — one sample says 'I'm not sure', another answers), `negativeAvailabilityDet... |
| DP-gg-30 | S-61 | llm-stochastic | fail-open | per-request | correct, wrong, escalate | `classifyProductImageRequest` is launched pre-generation with `.catch(() => null)` — a transport error silently disables the entire override (customer asked for a photo, gets only AI text, no images, no signal). |
| DP-po-01 | S-62 | error-fallback | fail-open | rare | correct, wrong | The ai_send_done idempotency read swallows Redis errors and reports 'not sent'. |
| DP-po-02 | S-62 | timing | fail-open | rare | correct, wrong | The send marker has a fixed 1-hour TTL. A retry or re-enqueued job for the same inbound (stalled worker, manual retry, self-rescheduled fresh job) that executes more than 1h after the original send finds the marker expired and ... |
| DP-po-03 | S-62 | concurrency | fail-open | timing-window | correct, wrong | shouldStillSendAutomatedReply is bypassed entirely when knowledgeGapEscalated or alreadySent. |
| DP-po-04 | S-62 | concurrency | silent-drop | timing-window | correct, silence | The precheck re-reads ai_configs, channel, conversation, last-8 messages, and a human-outbound EXISTS at send time. |
| DP-po-05 | S-63 | error-fallback | fail-open | environmental | correct, silence, escalate | sendMessage catches everything (Graph API errors, token decrypt failures, unsupported connection method, rate-limit timeout) and returns {success:false} instead of throwing. |
| DP-po-06 | S-63 | concurrency | fail-open | environmental | correct, silence, escalate | Per-channel token bucket (default 200/h) polls up to 60s then throws OutboundChannelRateLimitedError, which sendMessage converts to {success:false}. |
| DP-po-07 | S-63 | error-fallback | fail-open | rare | correct, wrong | The marker write after a successful send swallows Redis errors. |
| DP-po-08 | S-64 | error-fallback | fail-open | rare | correct, wrong | The ai_img_sent marker is written only when ALL images for the turn succeeded. |
| DP-po-09 | S-65 | concurrency | throw-retry | rare | correct, silence | Crash after the outbound row is persisted: the retry skips the send, then re-runs createMessage reusing priorGraphMessageId. |
| DP-po-10 | S-65 | data-order | fail-open | rare | correct, wrong | Same crash-after-persist scenario but on WhatsApp: the marker value is the literal '1' (WhatsApp sender returns null id), so priorGraphMessageId is null and the retry inserts a SECOND outbound row with a fresh ai_{uuid} externa... |
| DP-po-11 | S-65 | llm-stochastic | fail-open | rare | correct, wrong, escalate | On an alreadySent retry the whole job re-runs from the top, including generateReply and every guard, before the send is skipped. |
| DP-gg-27 | S-66 | error-fallback | fail-open | rare | escalate, wrong | Price, name, and uncertain-answer escalations send the holding message FIRST and do pause+alert AFTER persist in a separate transaction (3255+, 3298+, 3342+). |
| DP-po-13 | S-66 | error-fallback | fail-open | rare | correct, wrong | Each hallucination/uncertain/quality alert+pause pair runs in its own BEGIN/COMMIT transaction inside try/catch. |
| DP-po-14 | S-66 | timing | silent-drop | rare | correct, silence | Crash between the independently-committed alert transactions and the later bookkeeping: a committed pair that set ai_paused=true blocks the retry at the top-of-job gate (line 1322), so touchConversationLastMessageAt, ai_reply_s... |
| DP-po-15 | S-67 | error-fallback | silent-drop | rare | correct, silence | The 4-hour use-case evaluation enqueue is void-fire-and-forget and unawaited; |
| DP-po-16 | S-67 | data-order | fail-open | environmental (divergence gated on a failed channel send) | correct, wrong | The ai_reply_sent analytics event and the use-case eval enqueue execute BEFORE the !sendResult?.success branch at 3472 — both fire even when the channel send failed. |
| DP-po-12 | S-68 | error-fallback | fail-open | rare | correct, escalate | On an alreadySent retry sendResult stays null (send skipped), so the failure branch condition !sendResult?.success is TRUE: the self-healed row is marked send_status='failed' with the fallback reason 'Contact not found for conv... |
| DP-po-17 | S-69 | llm-stochastic | silent-drop | per-request | correct, wrong, silence | Purchase-intent detection runs at temperature 0 but with no seed and a floating threshold: intent_score near the 0.85 boundary can flip between runs (the code even normalizes scores >1 by dividing by 100, so a model emitting '8... |
| DP-po-18 | S-69 | error-fallback | fail-closed | environmental | correct, silence | detect() throws on an empty OpenAI completion ('OpenAI returned an empty intent detection response', intentDetectionService.ts:154) and on API failure after SDK retries — but the throw is caught by the draft-order block's swall... |
| DP-po-19 | S-69 | error-fallback | fail-closed | rare | correct, silence | parseIntentJson returns EMPTY_INTENT_RESULT (score 0, is_ready false) on unparseable JSON, so a malformed model response silently converts an order-ready turn into a validation-gate skip — indistinguishable in outcome from genu... |
| DP-po-20 | S-69 | cache-staleness | silent-drop | timing-window | correct, silence | hasCustomerPhone resolves via contact.metadata (populated by the fail-open profile fetch at ingestion, S-09) → message extraction → WhatsApp-only external_id fallback. |
| DP-po-21 | S-70 | llm-stochastic | silent-drop | per-request | correct, wrong, silence | shouldAffirmOrder is a disjunction of LLM outputs: explicitNewOrder (classifyNewOrderSignal, keyword fallback on error) and latestMessageAffirmsOrder (detectOrderAffirmationIntent confidence > 0.7 knife-edge), plus heuristic sc... |
| DP-po-22 | S-70 | config-drift | none | environmental | correct, wrong, silence | INTENT_THRESHOLD is parsed per-job with a silent fallback to 0.85 for missing/invalid/out-of-range values (must be strictly between 0 and 1 — a legitimate '1' or '0.85abc'... |
| DP-po-30 | S-70 | llm-stochastic | silent-drop | per-request | correct, wrong, silence | The draft-order gate is a 7-way conjunction (is_ready_to_order, score>threshold, product_name non-null, address, phone, name, shouldAffirmOrder) where five conjuncts derive from LLM output on this run. |
| DP-po-23 | S-71 | llm-stochastic | silent-drop | per-request | correct, wrong, escalate, silence | The candidate set is seeded from the intent LLM's free-text product_name (fuzzy lookup + substring + variant siblings), then narrowed by a deterministic tier ladder (size→flavor→color→bare-number→intent-exact). |
| DP-po-24 | S-71 | llm-stochastic | fail-open | timing-window | correct, wrong | Duplicate suppression for the variant-clarification question is only a scan of the last 8 messages for the locale-specific lead-in string VARIANT_CLARIFICATION_LEAD_IN[replyLocale]. |
| DP-po-25 | S-71 | concurrency | fail-open | rare | correct, wrong | The clarification send has NO Redis idempotency marker and NO shouldStillSendAutomatedReply precheck. |
| DP-po-26 | S-72 | concurrency | fail-open | rare | correct, wrong | Duplicate-order suppression is purely application-level: findLatestActiveOrderForConversation read followed by createOrder insert, with no DB uniqueness constraint. |
| DP-po-27 | S-72 | timing | fail-open | rare | correct, wrong | createOrder has no idempotency marker; a crash after the INSERT but before BullMQ ack retries the whole job. |
| DP-po-28 | S-73 | timing | none | timing-window | correct, wrong | hasHumanParticipationInCurrentOrderWindow computes the session boundary NOW()-relative (gap > COMMISSION_SESSION_GAP_HOURS over the last 30 days) and runs AFTER the reply send, at draft-creation time. |
| DP-GPR-34 | S-74 | error-fallback | fail-open | environmental | correct, silence | Both releases in the finally block swallow Redis errors (.catch(() => undefined)): a failed lock release leaves the conversation serialized behind a dead lock until the 300s TTL, and a failed slot DECR shrinks the tenant's effe... |

## Divergence trees

Canonical scenario: a customer sends **"Do you have Product X?"** where X is an active, in-stock, embedded catalog product. The three trees below trace the same inbound message to each of the four outcome classes, branching at register points in execution order. Tier 1 branches can fire on **every** request; Tier 2 branches need a timing/concurrency coincidence (including mutation-triggered, TTL-bounded cache windows); Tier 3 branches need a standing environment state (config drift, embedding state, infra health).

### Tier 1 — per-request stochastic (fires on every request)

```
Inbound "Do you have Product X?"  (solo message, X active in catalog)
│
├─ S-22 reply-language detection (DP-GPR-14, aiService.ts:1837)
│    ├─ resolves customer's language ──────────────────────────────► continue
│    └─ ambiguous text sampled the other way / transport error → 'sq' default
│         └─ reply + all canned text in wrong language ───────────► WRONG
│
├─ S-23..S-29 pre-reply intent classifiers on an availability question
│    ├─ all below their >0.8/>0.82 gates (expected) ──────────────► continue
│    └─ one classifier blips over its gate (DP-GPR-15/20/24/26; 0→0.9
│       confidence boost DP-GPR-16, aiService.ts:2509 collapses the gate
│       onto the boolean alone)
│         └─ canned ack / holding message + alert + ai_paused ────► ESCALATION
│
├─ S-32 routing classifiers (DP-pc-16 price/discount/attribute/other-options;
│    DP-retrieval-16 retrieval-mode select)
│    ├─ price-ask detected → catalog prompt carries "Price: €N" lines
│    └─ flip → prompt without prices / different retrieval mode & limit
│         └─ model improvises or under-answers ───────────────────► WRONG (or feeds S-56)
│
├─ S-33..S-36 retrieval of X
│    ├─ X in fused top set ───────────────────────────────────────► continue
│    ├─ category-intent knife-edge drops semantic source entirely
│    │    (DP-retrieval-06, aiService.ts:725) and X only ranks semantically
│    │    └─ X missing from prompt ───────────────────────────────► WRONG
│    ├─ first-pass underfill retry variance
│    │    (DP-retrieval-07, product.ts:811) → X drops at slice cutoff
│    │    (DP-retrieval-11 tie-break, aiService.ts:443) ──────────► WRONG
│    └─ products=[] and message has keywords (DP-retrieval-21,
│       aiService.ts:3777) → "catalog has N products, please clarify"
│         └─ AI denies knowledge of X ────────────────────────────► WRONG
│            (and matchedProducts=[] disables the entire guard suite
│             downstream — DP-gg-31, aiService.ts:4139)
│
├─ S-41 [NO_REPLY] short-circuits (DP-gg-05/06/07)
│    └─ ending/discount misclassification (question mark usually protects
│       this scenario, but merged bursts can lose it) ────────────► SILENCE
│
├─ S-42 main completion — THE stochastic root (DP-gg-01, aiService.ts:4118:
│    temperature 0.3, no seed; every guard below judges the SAMPLED text)
│    ├─ sample quotes exact price/name/usage text ────────────────► continue
│    └─ sample paraphrases, rounds a price, shortens a product name,
│       or volunteers "consult a doctor" / "I'm not sure"
│         ├─ S-45 usage guard: paraphrase ≠ verbatim usage_description
│         │    (DP-gg-10/11) → holding message + pause ───────────► ESCALATION
│         ├─ S-48 gap assessor trilemma complete/partial/none
│         │    (DP-gg-15, processAIReply.ts:2416) → replaced reply ► ESCALATION
│         ├─ S-49 health-advice guard on the sampled wording
│         │    (DP-gg-19) → holding + pause ──────────────────────► ESCALATION
│         ├─ S-55 quality eval score jitter at threshold
│         │    (DP-gg-24) → flagged + paused post-send ───────────► ESCALATION
│         ├─ S-56 price guard: "€10" for a €9.99 item (DP-gg-26,
│         │    processAIReply.ts:2792) → holding + alert ─────────► ESCALATION
│         ├─ S-57 name guard flags legitimate shorthand (DP-gg-28) ► ESCALATION
│         ├─ S-58 uncertain-deflection wording w/ empty matched set
│         │    (DP-gg-29) → GET_BACK_TO_YOU + pause ──────────────► ESCALATION
│         └─ S-53/S-54 strip guards amputate a legitimate closing or
│              final sentence (DP-gg-22/23) ──────────────────────► WRONG
│
├─ S-61 photo-request classifier false positive (DP-gg-30) → reply
│    wholesale replaced by canned photo text ─────────────────────► WRONG
│
└─ all knives land on the safe side ──────────────────────────────► CORRECT
```

### Tier 2 — timing-window (fires under specific timing/concurrency)

```
Inbound "Do you have Product X?"
│
├─ S-04 message batched behind another in one webhook POST → dedupe key
│    covers all mids, only first is processed (DP-iq-03) ─────────► SILENCE
├─ S-11 echo misclassification window: Redis self-echo miss on IG
│    (DP-iq-11) or human-vs-API surface heuristic (DP-iq-12) →
│    phantom "human" reply → sticky human_replied + 10-min hold ──► SILENCE
├─ S-12/S-13 second message near the 8s debounce boundary (DP-iq-16),
│    out-of-order persist (DP-iq-18), debounce removes only one pending
│    job (DP-iq-17), mutually-stale interleaving (DP-GPR-12) ─────► SILENCE
│    (or merged-burst text changes every downstream classifier
│     input — DP-GPR-10/11, DP-pc-15 ────────────────────────────► WRONG)
├─ S-14/S-15 fairness/lock reschedule loops (DP-iq-19/20) → minutes of
│    delay → newer inbound arrives → stale-skip ──────────────────► SILENCE
├─ S-16 25/h counter near boundary (retries/stale jobs inflated it,
│    DP-iq-21) → ai_paused + rate_limit_exceeded alert ───────────► ESCALATION
├─ S-17..S-19 tenant/channel/conversation toggle or human hold flipped
│    inside the ≥8s receipt-to-run window (DP-iq-23/24/25, DP-GPR-09)
│    └─ received message silently discarded ──────────────────────► SILENCE
├─ S-21 reaction/emoji merged at the head of the burst
│    (DP-GPR-13/33) ──────────────────────────────────────────────► SILENCE
├─ S-33 embedding 5s Promise.race lost during a latency spike
│    (DP-retrieval-01; non-aborting, self-amplifying DP-retrieval-23)
│    └─ lexical-only fusion misses X ─────────────────────────────► WRONG / ESCALATION
├─ S-34 X was edited seconds ago → embedding nulled until re-embed
│    (DP-retrieval-17); first-query-after-import zero-hit self-heal
│    answers THIS request with products=[] (DP-retrieval-19) ─────► WRONG
├─ S-36 anchor loss: prior guard turn persisted product_ids=[]
│    (DP-retrieval-12) or product deactivated between turns
│    (DP-retrieval-13) → follow-up resolves against nothing ──────► WRONG / ESCALATION
├─ S-31 config/tenant/blocks cache phase after an admin edit
│    (DP-pc-01/03/04) or custom_model_id cache lag (DP-gg-02)
│    └─ different prompt or different model for the same message ─► WRONG (vs CORRECT)
├─ S-62 send precheck race: human replies during the multi-second
│    generation window (DP-po-04) → silent return ────────────────► SILENCE
│    └─ inverse: precheck bypassed on escalation/retry paths
│       (DP-po-03) → bot answers on top of the human ─────────────► WRONG
└─ S-63.. duplicate-delivery windows: 1h marker TTL (DP-po-02), lock-TTL
     overlap double-pipeline (DP-GPR-04, DP-po-26), retry duplicates
     (DP-po-27) ──────────────────────────────────────────────────► WRONG
```

### Tier 3 — environmental (config drift, embedding state, infra health)

```
Inbound "Do you have Product X?"
│
├─ S-03 payload without timestamp always passes skew gate (DP-iq-01);
│    late redelivery with timestamp is 403'd forever (DP-iq-02) ──► SILENCE
├─ S-04/S-05 Redis blip at receipt: enqueue fails after ACK 200
│    (DP-iq-04) or dedupe SET throws → 500/Meta-retry (DP-iq-28) ─► SILENCE
├─ S-13 throw after message persisted but before ai.reply enqueue →
│    retry short-circuits on global dedupe, job never created
│    (DP-iq-15) ──────────────────────────────────────────────────► SILENCE
├─ S-31 Redis outage during prompt-cache loads → generateReply throws,
│    3 attempts, no DLQ (DP-pc-07, DP-iq-27) ─────────────────────► SILENCE
├─ S-33/S-34 embedding state: model/dimension drift (DP-retrieval-22,
│    embeddingService.ts:12 — default 3-large/3072 vs vector(1536)),
│    SIMILARITY_THRESHOLD 0.65-vs-0.75 drift (DP-retrieval-05),
│    ef_search drift (DP-retrieval-25), global-HNSW cross-tenant
│    crowding as the corpus grows (DP-retrieval-08, product.ts:722),
│    stale/unstamped vectors
│    (DP-retrieval-10/18) → semantic source degraded or empty
│    └─ X missed → clarify guardrail ─────────────────────────────► WRONG
├─ S-23..S-29 OpenAI degradation inside the umbrella try/catch
│    (DP-GPR-17/23/28, processAIReply.ts:1942) → all escalation
│    detection silently skipped, "continues normal flow" ─────────► WRONG
│    ├─ SAME outage at S-48: gap assessor is the one FAIL-CLOSED guard
│    │    (DP-gg-14, productInformationGapService.ts:105) → EVERY
│    │    product question replaced with a holding message ───────► ESCALATION
│    └─ SAME outage at S-45/S-49/S-57: those guards fail OPEN
│         (DP-gg-11/19/28) → unguarded reply sails through ───────► WRONG
│    (one infrastructure event, opposite outcome classes by guard)
├─ S-55 QUALITY_THRESHOLD drift: code default 0.1 vs .env.example 0.6
│    (DP-gg-24) → same reply paused in one env, clean in another ─► ESCALATION
├─ S-42 sustained outage exhausts 3 attempts → failed set, no DLQ,
│    no tenant alert (DP-iq-27); retries meanwhile re-execute canned
│    sends/alerts without idempotency (DP-iq-26) ─────────────────► SILENCE / WRONG
├─ S-39 orphan prompt block guidelines.offers_promotions injected only
│    for tenants seeded before its deactivation (DP-pc-19) ───────► WRONG (offer questions)
├─ S-63 channel send failure is terminal {success:false} — no retry,
│    message_send_failed alert only (DP-po-05/06) ────────────────► SILENCE (+ ESCALATION artifact)
└─ frozen-at-load vs per-job env constants across heterogeneous workers
     (DP-GPR-31, DP-pc-20, DP-po-22) → same message, different caps,
     history depth, temperature by worker affinity ───────────────► any class
```

## Primary divergence mechanisms (ranked)

Ranked by expected contribution to "identical request, different outcome," combining breadth (how many requests are exposed), branch distance (how far apart the resulting outcome classes are), and dev-DB corroboration.

**1. Guards validate the stochastic reply against the per-turn retrieval set, not the catalog.**
- Mechanism: the price guard's ground truth is `matchedProducts`' prices (empty set → `catalogPriceSet.prices.length === 0` fail path, processAIReply.ts:2792, DP-gg-26); the name guard compares against matched catalog names only, reply truncated to 1,200 chars (processAIReply.ts:2857, DP-gg-28); and the whole suite is silently disabled when the fallback-catalog path emptied `matchedProducts` (aiService.ts:4139, DP-gg-31). A retrieval miss on a keyword-less follow-up therefore converts a **factually correct** reply into a holding message + hallucination alert.
- Conditions: any turn where retrieval returns a set that does not cover the products the reply legitimately references — especially follow-ups with no product keywords (DP-retrieval-21, DP-retrieval-12).
- Probability class: per-request (guard inputs are sampled text + per-turn retrieval).
- Observable signal: `ai_alerts` reason `hallucinated_price`/`hallucinated_product_name` with empty `catalogPrices`/retrieval-window `catalogNames`; outbound rows with `product_ids = []`.
- Dev-DB corroboration: **3/3 hallucination alerts in the dev DB carry this exact signature** — `failureReason: "no_catalog_prices"`, `catalogPrices: []`, and a name flag against an unrelated retrieved top-10, each flagging replies verifiably correct against active catalog rows (EV-011, EV-013, EV-015; alert-forensics.md §2).

**2. Unseeded sampling at S-42 is the root every guard amplifies.**
- Mechanism: the single customer-facing completion runs at temperature 0.3 with no seed (aiService.ts:4118, DP-gg-01). Verbatim-vs-paraphrase wording then decides guard exemption (OOS exact-string match DP-gg-08; usage verbatim check DP-gg-10), deflection regexes (DP-gg-29), price rounding (DP-gg-26), and eval score jitter (DP-gg-24). No configuration removes this root.
- Conditions: every request.
- Probability class: per-request.
- Observable signal: `messages.content` differs across replays; `quality_score` 0.95 (skip path) vs real eval scores.
- Dev-DB corroboration: indirect — all guard-fired alerts in the DB are downstream of sampled text (EV-008…EV-015).

**3. ~28 knife-edge LLM classifiers select the code path itself.**
- Mechanism: pre-reply routing (cancel/refund >0.8, wrong-product >0.8, post-purchase >0.8, order-info >0.82 — DP-GPR-15/20/24/26), prompt-content toggles (DP-pc-16), retrieval-mode selection (DP-retrieval-16), gap trilemma (DP-gg-15), and the 7-conjunct draft-order gate (DP-po-30, five conjuncts LLM-derived) all branch on temp-0-but-unseeded verdicts at fixed thresholds; four detectors boost missing confidence 0→0.85/0.9, collapsing the gate onto a sampled boolean (aiService.ts:2509/2584/2686/2888, DP-GPR-16).
- Conditions: phrasing near any decision boundary — plausibly frequent for short Albanian/mixed-language messages, though actual flip frequency is unmeasured (deferred to Phase 10).
- Probability class: per-request.
- Observable signal: classifier confidence log lines; divergent alert reasons for identical scripts.
- Dev-DB corroboration: gap-alert payload extracting the quantifier "ma shum" ("more") as a missing product attribute shows classifier extraction misfiring on real traffic (EV-012-class payload, alert-forensics.md §3).

**4. Retrieval composition is non-deterministic for the same tenant and text.**
- Mechanism: 5s non-aborting embedding race (aiService.ts:655/657, DP-retrieval-01/23), per-process embedding cache by worker affinity (DP-retrieval-03), category-intent structural mode flip (DP-retrieval-06), global-HNSW cross-tenant crowding and underfill retry (product.ts:722/811, DP-retrieval-07/08), untied RRF sort at the slice boundary (DP-retrieval-11), and the keyword gate that turns any empty set into a "please clarify" denial (DP-retrieval-21).
- Conditions: cache-miss embedding calls, OpenAI latency variance, other tenants' writes, catalog edits.
- Probability class: per-request to timing-window.
- Observable signal: `semanticSkipped:true` warns; differing `topIds` in `[retrieval]` logs for the same query.
- Dev-DB corroboration: the 06-27 cluster — two `hallucinated_price`, one `product_question_unanswered` (`missing_info: ["carbo one"]`) — is **one retrieval defect expressing itself through three different alert reasons** while Carbo One sat active and embedded in the catalog (EV-013; alert-forensics.md §3).

**5. Asymmetric failure polarity across guards during OpenAI degradation.**
- Mechanism: the gap assessor fails closed (`!assessment.ok` → escalate, productInformationGapService.ts:105 + processAIReply.ts:2416, DP-gg-14) while usage/health/name guards and all pre-reply detectors fail open (DP-gg-11/19/28, DP-GPR-17/23/28). The same infrastructure event pushes product questions to escalation and complaint/hallucination protection to pass-through — opposite outcome classes from one cause.
- Conditions: OpenAI transport errors/timeouts during a guard call.
- Probability class: environmental.
- Observable signal: `[productInformationGap] assessment failed — failing closed` vs `escalation detection path failed, continuing normal flow` warn lines.
- Dev-DB corroboration: none observable (no outage window in the dev capture); polarity is code-attested.

**6. The receipt-to-run window re-evaluates the world (gates, holds, staleness, precheck).**
- Mechanism: enablement gates read at job-run time ≥8s after receipt (DP-iq-23), human-hold reschedule arithmetic (DP-iq-24/25, DP-GPR-09), stale-job guard interleavings (DP-GPR-12), and the send precheck racing the multi-second generation window (DP-po-04) — plus its bypass on escalation/retry (DP-po-03). All convert a received message into silence (or a double answer) based purely on what happened during processing.
- Conditions: toggles, human replies, or new inbounds inside the window.
- Probability class: timing-window.
- Observable signal: `Skipping AI send` / `Skipping stale AI job` / gate-skip info logs — log-only, no DB artifact.
- Dev-DB corroboration: not visible in DB by design (these paths write nothing); noted as an observability gap.

**7. Echo/identity misclassification silently flips the AI's participation state.**
- Mechanism: Instagram echoes carry no app_id; a Redis registry miss classifies the platform's own reply as a human agent (outboundEchoRegistry.ts:53, DP-iq-11), setting sticky `human_replied` and a 10-min hold; the app_id heuristic likewise splits identical human actions into opposite conversation futures (webhookNormalizer.ts:92, DP-iq-12).
- Conditions: Redis hiccup/TTL at echo time; third-party senders on the same page.
- Probability class: timing-window.
- Observable signal: `sent_by='human'` rows with no matching inbox action.
- Dev-DB corroboration: none in the 20-alert set (echo paths don't create alerts).

**8. Cache phase and config drift make the "same tenant" two different tenants.**
- Mechanism: 900/1800/120s prompt-input caches with delete-only invalidation (DP-pc-01/03/04, DP-retrieval-20), custom-model cache lag (DP-gg-02), the SIMILARITY_THRESHOLD 0.65/0.75 and QUALITY_THRESHOLD 0.1/0.6 documented drift pairs (DP-retrieval-05, DP-gg-24), embedding model/dimension drift (DP-retrieval-22), and frozen-at-load constants across workers (DP-GPR-31, DP-pc-20).
- Conditions: admin edits within TTL windows; heterogeneous instances or stale env files.
- Probability class: mixed — timing-window for the TTL cache phases (an edit must land inside the window: DP-pc-01/03/04, DP-retrieval-20, DP-gg-02); environmental for the threshold/model/frozen-constant drift components.
- Observable signal: mostly none per-request (prompts and thresholds are not logged/persisted).
- Dev-DB corroboration: the orphan `guidelines.offers_promotions` block (13 live tenant blocks vs 12 in migrations) is a standing config-drift instance affecting tenants by seed date (DP-pc-19; findings-seed.md).

**9. Terminal send failures and lost enqueues produce silences with no reply-side record.**
- Mechanism: channel send catches everything into `{success:false}` — no retry ever (channelSenderService.ts:326, DP-po-05); the outbound rate limiter converts bucket exhaustion into the same terminal state (DP-po-06); enqueue-after-ACK losses (DP-iq-04) and the persisted-message-without-ai-job anchor race (DP-iq-15) drop the message before any pipeline runs.
- Conditions: transient network/Redis/Graph failures at the wrong instant.
- Probability class: environmental.
- Observable signal: `send_status='failed'` + `message_send_failed` alert (send path); log-only for the enqueue losses.
- Dev-DB corroboration: no `message_send_failed` alerts in the 20-alert dev set; mechanism is code-attested.

## Dev-DB corroboration

Summary of `alert-forensics.md` (full queries in appendix-A, EV-008…EV-015):

- **Composition (EV-008/EV-014):** 20 alerts across 19 conversations — 13 "question unanswered" (7 product, 6 usage), 3 hallucination-filter trips (2 price, 1 product name), 2 `product_image_unavailable`, 1 `uncertain_answer_escalated`, 1 `unclear`. No meaningful clustering; 16/20 alerts sit at or adjacent to the conversation's final message — **escalation is conversation-terminal** in this dataset.
- **All 3 hallucination alerts are mechanical false positives (EV-011, EV-013, EV-015):** both `hallucinated_price` alerts carry `failureReason: "no_catalog_prices"` with `catalogPrices: []` and `product_ids = []` on the flagged messages — the guard fired with an **empty comparison set** against a reply whose €18.00 Limon/Portokall quotes exactly match active catalog rows (`Carbo one 1kg Limon` / `Carbo One 1kg Orange`). The `hallucinated_product_name` alert flagged product names the AI itself introduced two turns earlier, compared against an unrelated retrieved top-10 (Melatonine, Creatine, C4…). Zero of the three shows model fabrication; all three record **retrieval failures surfacing as filter false positives** — direct corroboration of mechanisms #1 and #4 (DP-gg-26/28/31, DP-retrieval-21).
- **The 06-27 cluster (EV-013):** two `hallucinated_price` and one `product_question_unanswered` (`missing_info: ["carbo one"]`) the same evening, same product family — one retrieval defect expressed through three different alert reasons.
- **Gap-alert payload quality (EV-012-class rows):** of 3 detailed `product_question_unanswered` alerts, one is plausibly genuine, one extracted the Albanian quantifier "ma shum" ("more") as a missing product attribute (classifier extraction misfire), one masks the Carbo One retrieval failure. The `uncertain_answer_escalated` alert fired purely on `negative_availability_detected: true` — fail-closed by design.
- **Forensic blind spot (EV-008/EV-015):** `details` JSONB is populated only from ~2026-06-23 and only on some paths; **10/20 alerts (all usage + pre-06-23 product ones) have `details = null`** and cannot be classified as mechanical vs genuine from the DB at all.
- **Incidentals (EV-014/EV-015):** the two 06-27 fallback messages are stored with mojibake (`S� shpejti…`) vs clean UTF-8 on 06-23 — an encoding fault active in the canned-response path on that date; three alert reasons in the data are absent from CLAUDE.md's documented list (EV-002); products in payloads frequently exist as active + soft-deleted duplicates (58% soft-delete rate, EV-004).

## What cannot be determined statically

Honest limits of this phase — all items below require the Phase 10 live replay (or production telemetry) to resolve:

1. **The actual divergence rate.** The register enumerates *mechanisms*; it cannot say what fraction of identical production requests diverge in outcome class, nor the per-tier mix. Deferred to Phase 10 (N× replay of the canonical scenario against a controlled tenant).
2. **Per-classifier flip probabilities.** How often temp-0 classifiers actually flip near their 0.7/0.8/0.82/0.85 gates for real Albanian/mixed-language traffic is empirical (model- and phrasing-dependent), not derivable from code.
3. **OpenAI-side nondeterminism magnitude** — embedding vector jitter at the 0.65 boundary (DP-retrieval-04) and completion variance at temperature 0.3 (DP-gg-01) have no static bound.
4. **Which silences occurred in production.** Most silence paths (gate skips, stale skips, precheck returns, enqueue losses) are log-only with no DB artifact (DP-iq-23, DP-po-04, DP-iq-04/15); container logs were not in scope for this phase, and the dev DB cannot show what was never written.
5. **Classification of the 10 null-details alerts.** Half the dev alert set predates the `details` payload and records no evidence (alert-forensics.md §1).
6. **Production incidence of environmental and cache states** — actual env values per deployed instance (SIMILARITY_THRESHOLD, QUALITY_THRESHOLD, INTENT_THRESHOLD, AI_REPLY_DELAY_MS drift — DP-retrieval-05, DP-gg-24, DP-po-22, DP-iq-16), Redis health history, HNSW corpus growth effects (DP-retrieval-08), and the cache-mutation frequency — how often admin edits to ai_config, prompt blocks, tenant profile, or catalog actually land inside a live cache TTL window (DP-pc-01/03/04, DP-retrieval-20, DP-gg-02) — are runtime facts; the static analysis can only show the windows exist, not how often they are hit.
7. **Whether the guidelines.offers_promotions orphan block ever caused a customer-visible wrong denial** (DP-pc-19) — requires replaying offer questions against affected vs unaffected tenants.
8. **Meta/Viber platform behavior** — batching frequency (DP-iq-03), redelivery horizons after 403/500 (DP-iq-02/28), and echo timing distributions (DP-iq-11/13) are external-platform properties observable only live.
9. **Real lock/counter drift under load** — negative tenant-slot counters and lock-TTL overruns (DP-iq-19, DP-GPR-04) depend on production job wall-times.
