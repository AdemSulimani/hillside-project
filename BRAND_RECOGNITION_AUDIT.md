# Brand Recognition & Brand Retrieval — Production-Readiness Audit

**Date:** 2026-08-01 · **Scope:** the full pipeline from a customer image/text brand question to the final reply · **Method:** static analysis of `backend/src` (every citation below was read in-tree), plus runtime evidence from the dev database (258-product catalog, 484 `ai_decision_ledger` rows, live alert/message distributions). This is an audit, not a bug investigation; findings are graded against enterprise production standards.

---

## 1. Executive Summary

**Verdict: NOT production-ready for the stated feature intent.**

The intended behavior — *detect the brand in the image → understand the intent → search the catalog → return exact-brand products, or same-brand alternatives, or an honest "no"* — is implemented **only on the image lane, only partially, and only when catalog data exists**. Three convergent root causes:

1. **Data starvation (dominates everything else).** On the real dev catalog, `products.brand` is populated on **1 of 258** active rows; **1 of 258** products has any image; `product_image_fingerprints` contains **exactly 1 row**. Brand *detection* from a customer image can work (the vision extraction is well-built), but brand *retrieval* has almost nothing to match against. Every algorithmic finding below is secondary to this.

2. **The text lane has no brand retrieval at all.** There is no brand intent category, no brand-scoped query (`WHERE brand ILIKE …` scoped to a brand question exists nowhere), no `SELECT DISTINCT brand`, and no deterministic brand-membership check. A typed "a keni produkte nga Nike?" is answered by the LLM reading catalog lines that all say `Brand: Unknown`.

3. **Several always-on mechanisms actively work against brand accuracy.** The platform prompt trains the model to answer "Do you have this brand?" with a bare **"Yes."** ([061_concise_messaging_style.sql:39](backend/src/db/migrations/061_concise_messaging_style.sql#L39), mirrored always-on in [productDescriptionPromptService.ts:478](backend/src/services/productDescriptionPromptService.ts#L478)); brand names are regex-**stripped** from outgoing replies ([aiService.ts:2607-2633](backend/src/services/aiService.ts#L2607-L2633)); every brand-accuracy rule is gated to image turns only ([promptAssemblyService.ts:277-280](backend/src/services/promptAssemblyService.ts#L277-L280)); no grounding, hallucination, or quality gate verifies a brand claim or a brand denial; and the quality evaluator scores an (unverified) "we don't have this brand" **0.9+** by rubric ([aiQualityContract.ts:152](backend/src/services/aiQualityContract.ts#L152)).

**What is genuinely good:** the vision extraction prompt and fingerprint schema are disciplined ("Do NOT invent brand names", per-field confidence, null-on-unreadable); the `decideVisionMatch` policy ladder is pure, sensible, and unit-tested; the image lane has a real brand-absence verdict (`brandLikelyAbsent → not_in_catalog`); the `guidelines.vision_product_images` block encodes exactly the right business policy ("A match is only valid if the brand name AND product type match… Brand accuracy matters"); embedding text deliberately includes brand; a brand backfill service already exists.

**The shortest path to production-ready:** populate brand data (import fix + backfill + product images), port the image lane's brand trio (normalize → catalog-wide brand probe → explicit absent verdict) to the text lane, and remove the three anti-brand prompt behaviors. Sections 2–13 give the evidence; section 14 is the prioritized roadmap.

---

## 2. Brand Recognition Architecture Review

### Request flow (image turn)

```
Meta/Viber webhook
  → webhookNormalizer (per-channel attachmentUrls; image w/o URL downgraded to text)
  → processInboundMessage.ts:875-975 — download media, MIME check, re-host to Cloudinary
      (RAW upload: no resize, no EXIF rotation, no size cap, no quality pre-check)
  → BullMQ ai.reply → processAIReply.ts (burst-merge attachments :427-464)
  → aiService.generateReply(:4434)
      1. TEXT retrieval first (fusion: vector 2.0 / category-tag 1.5 / phrase 1.2 / keyword 1.0)
      2. matchProductsFromCustomerImages (productImageMatchingService.ts:563-809):
         a. Vision JSON extraction (brand_name, product_name, confidence, multi-product fields)
         b. fingerprint-text embedding → cosine search over product_image_fingerprints
            (text-embedding similarity, NOT pixel/CLIP; threshold 0.62 in SQL)
         c. ambiguity re-rank (2nd vision call when top-2 gap ≤ 0.04)
         d. tiered text resolver: T1 brand+name → T2 name → T3 type → T4 legacy
         e. SKU/barcode deterministic fast path
         f. RRF fusion → composite confidence → decideVisionMatch policy ladder
      3. Outcome partially consumed: products pinned/emptied; visionContext prose
         injected into the USER turn; raw image also attached to the reply call
  → reply model = OPENAI_VISION_MODEL (tenant fine-tune deliberately dropped — pinned defect M1)
  → post-reply guards (BUT: gap assessor skipped when hadImages; facts_used contract
    disabled when hasImages) → send
```

### Request flow (text brand question)

```
inbound text → classifier fan-out in generateReply (Promise.all):
  classifyProductAttributeIntent — the ONLY classifier that knows "brand"
  (one of 7 attribute keys; no brand_availability intent exists)
  → routed to the ATTRIBUTE lane → discussed-products resolver (persisted product_ids)
  → fusion retrieval happens on the raw message; brand participates only as one
    OR-term in searchProducts' 10-way ILIKE (lowest-weighted source)
  → reply generated from whatever the window contains; no brand-specific guard runs
```

**Observation:** responsibilities are cleanly separated on the image lane (extraction / policy / retrieval are distinct modules — [productImageMatchingService.ts](backend/src/services/productImageMatchingService.ts), [productImageMatchPolicy.ts](backend/src/services/productImageMatchPolicy.ts)); the text lane simply has no brand-aware component to separate.

---

## 3. Image Understanding Audit

| Capability | Status | Evidence |
|---|---|---|
| Brand names on packaging | ✅ Extracted (`brand_name`, confidence-scored) | CUSTOMER_VISION_SYSTEM, [productImageMatchingService.ts:211-244](backend/src/services/productImageMatchingService.ts#L211-L244) |
| Logos | ⚠️ Only via `distinguishing_features` free text; no logo-specific detection | fingerprint prompt [productImageFingerprintService.ts:85-103](backend/src/services/productImageFingerprintService.ts#L85-L103) |
| Multiple visible brands | ❌ Extraction is single-product by construction (one `brand_name`); multi-distinct photos can only trigger a clarify question | policy fields + `clarify_multiple_distinct` ladder |
| Low-quality/blurry | ⚠️ Judged only by the model's self-reported `image_quality` enum; quality clarify suppressed above confidence 0.65 | policy:27 |
| Rotated/cropped images | ❌ No EXIF rotation, no preprocessing at all — raw bytes to Cloudinary, URL to OpenAI | [processInboundMessage.ts:920-961](backend/src/jobs/processInboundMessage.ts#L920-L961) |
| Small logos / partial visibility | ⚠️ Entirely dependent on the vision model; no crop/zoom retry |  |
| Packaging redesigns | ✅ Schema anticipates it (`packaging_version_note`) | fingerprint schema |

**Preprocessing verdict:** none exists. `sharp` is in the tree but used only for import OCR ([ImageProcessingService.ts:17-23](backend/src/services/ImageProcessingService.ts#L17-L23)). Recommended minimum before the paid vision call: EXIF-orient, downscale to a bounded long edge, and reject/clamp oversized uploads. Also note [attachmentStorageService.ts](backend/src/services/attachmentStorageService.ts) is a stub returning `null` — base64 inlining is dead code, so OpenAI must fetch Cloudinary URLs itself; an unreachable asset degrades silently into a bad extraction with no distinct error path.

**Reliability finding (highest-severity code defect in the audit):** the customer-photo extraction call and its `JSON.parse` are **not wrapped** ([productImageMatchingService.ts:279-306](backend/src/services/productImageMatchingService.ts#L279-L306)). A provider blip or malformed JSON propagates up and fails the whole reply job (BullMQ retries, double vision spend). The policy ladder's `!extraction` graceful branch is unreachable in practice. Every sibling step (cache read, embedding search, SKU lookup, re-rank) *is* guarded.

---

## 4. Brand Extraction Audit

**Prompts are disciplined.** Both vision prompts forbid invention ("Do NOT invent brand names. Use null when unreadable" / "Do not invent brand, numbers, or claims if unreadable"), run at temperature 0 with `json_object` response format, and carry per-field confidence. The customer's message text is given priority for choosing the primary subject. This is the strongest part of the feature.

**Determinism:** extraction is cached in Redis (`cust_vision:` 1h; catalog fingerprints 7d, versioned v2, invalidated on image replace). Temperature 0 is necessary-but-not-sufficient for determinism, and the cache key includes the per-upload-unique Cloudinary URL, so across turns the cache mostly helps retries only.

**Normalization/alias handling: effectively none.**
- The only real brand folding in the codebase is `normalizeForMatch` (lowercase, strip non-alphanumerics) — image lane only, and ASCII-only (`Müller` → `mller`) ([productImageMatchingService.ts:116-135](backend/src/services/productImageMatchingService.ts#L116-L135)).
- No brand alias/synonym table exists anywhere. `ALBANIAN_CONTENT_VARIANTS` is flavor-only and default-off.
- `isBrandLikelyInCatalog` is a naive substring test — short brands ("ON" = Optimum Nutrition) false-positive against unrelated names/descriptions/tags.
- Write-time canonicalization is `trim()` only; `findVariantSiblingProducts` then compares `brand = $4` byte-exact ([product.ts:630](backend/src/db/models/product.ts#L630)) — `"Nike"` ≠ `"nike"` silently breaks sibling expansion.

**Import-side extraction gap (G16):** the product-import prompt asks for brand but, unlike flavor/size/color, carries **no "ONLY if explicitly stated / never guess" clause** ([AIProductProcessingService.ts:12](backend/src/services/AIProductProcessingService.ts#L12) vs :20-22) — the one field where a hallucinated value would poison brand matching forever is the one field without the anti-guess rule. A brand backfill path exists and is correctly designed (LLM-pass, verbatim-copy rule, [attributeBackfillService.ts:40,137-144](backend/src/services/attributeBackfillService.ts#L40)) — it has simply not been run for brand.

---

## 5. Product Catalog Brand Retrieval Audit

**Where brand data can live:** `products.brand` (migration 028, indexed btree + trigram), product `name` (often carries brand-line hints — "Opti woman", "X-Mass" — but not manufacturer brands), `description`, `tags`, embeddings (brand is deliberately the *first* token of `buildProductText`, [embeddingService.ts:36-74](backend/src/services/embeddingService.ts#L36-L74)), and image fingerprints (`brand_name`, leads the embedded fingerprint text).

**What actually participates in text retrieval:** brand is one OR-term in `searchProducts`' 10-way ILIKE ([product.ts:520-537](backend/src/db/models/product.ts#L520-L537)), reached via the **lowest-weighted** RRF source (keyword 1.0 vs semantic 2.0). Three compounding defects for a query like "a keni produkte nga Nike?":

1. **Term starvation** — `searchProductsByDisjunctiveTerms` is a serial loop with an early return at `limit` ([product.ts:704-718](backend/src/db/models/product.ts#L704-L718)); `produkte` is *not* a stopword in `aiService.extractKeywords` (it is in the divergent copy in `productRetrievalService.ts`), so `%produkte%` can consume the whole limit before `nike` is ever queried.
2. **Short brands vanish** — tokenization keeps only words `> 2` chars ([aiService.ts:706](backend/src/services/aiService.ts#L706)): "ON", "GU", "3M" are dropped.
3. **Semantic lane can't help** — brand is embedded only when the column is populated; at ~0.4% population `buildProductText` emits no brand token catalog-wide.

**What does not exist at all:** a brand-scoped enumeration query ("give me every product of brand X"), a `SELECT DISTINCT brand` ("what brands do you carry?" is structurally unanswerable), and any use of the trigram index `idx_products_brand_trgm` (migration 044 — **dead weight**, no query does fuzzy matching on brand).

**Deterministic membership check:** none in the text lane. The attribute-availability service tests **key presence** ("is the brand field filled on any of the ≤25 retrieved products?"), never **value membership** ("is the value Nike?") — [productAttributeAvailabilityService.ts:46-59](backend/src/services/productAttributeAvailabilityService.ts#L46-L59), [productInformationGapHelpers.ts:453-471](backend/src/services/productInformationGapHelpers.ts#L453-L471). The only value-level brand check in the codebase is the image lane's `isBrandLikelyInCatalog` — and it is scoped to the retrieval candidate pool, not the catalog (§9).

---

## 6. Intent Understanding Assessment

There is **no brand intent category**. `intentDetectionService` is purchase-intent only. The single classifier that knows the word "brand" is `classifyProductAttributeIntent`, which folds it into a 7-way attribute enum. Traces for the canonical utterances:

| Utterance | Actual routing | Correct? |
|---|---|---|
| "Do you have this brand?" | Attribute lane, `attributes:['brand']`, discussed-products resolver; gap gate armed only because the literal token `brand`/`marka` appears ([productRetrievalService.ts:622](backend/src/services/productRetrievalService.ts#L622)) | ⚠️ Reaches a lane, but the lane can only check key-presence, not the brand's existence |
| "Do you have products from this company?" | `detectRequestedAttributes` → `[]` (no `kompani`/`prodhues`/`firma` pattern); LLM brand labels then dropped by the deterministic-first filter (`SYNONYM_GROUP_BY_LABEL`) → raw LLM text ships with no gate | ❌ |
| "Do you have similar products from this brand?" | `isOtherOptionsRequest` is **suppressed** whenever `is_attribute_question` is true — self-documented at [aiService.ts:4082-4090](backend/src/services/aiService.ts#L4082-L4090): "novel phrasings like *can you show me different brands?* land in the contextual-resolver path, not the fresh-search path" → customer is shown **the same products again** | ❌ |
| "Do you have another flavor from this brand?" | `ATTRIBUTE_FOLLOW_UP_PATTERNS` matches → attribute lane + sibling expansion — but `findVariantSiblingProducts` filters `brand = $4` byte-exact on a ~empty column | ⚠️ |
| "What products from this brand do you have?" | Same suppression as "similar products" — no fresh brand-scoped search exists to route to | ❌ |
| Image + "do you have this?" | Vision lane — the one correctly-designed path (Response A/B/C ladder) | ✅ design, ❌ data |

**Assessment:** intent understanding is the second-largest gap after data. Four of the seven canonical intents route to a lane that structurally cannot satisfy them. The recent follow-up routing work (commits `91ed747`→`8c072b4`) built exactly the right scaffolding (discussed-products resolver, evidence-gated attribute detection) for *narrowing* context — what's missing is the opposite motion: a brand question needs a fresh, brand-scoped *widening* search.

---

## 7. Retrieval Precision Assessment

Intended priority order: exact product > exact brand > same-brand alternatives > similar other-brand > nothing.

- **Image lane:** the priority order is genuinely implemented — SKU fast-path floors confidence; `exactBrandMatches` (brand-column equality) is preferred as the fusion text source when non-empty ([productImageMatchingService.ts:664-672](backend/src/services/productImageMatchingService.ts#L664-L672)); tiered resolver degrades brand+name → name → type. **But** T1 requires brand *and* name — there is no brand-only tier, so "anything from this brand" cannot enumerate; and with the brand column empty, `exactBrandMatches` is empty in practice, so precision rides on name-substring luck.
- **Text lane:** no brand prioritization exists at any level; a brand-exact ILIKE hit is outranked by two semantic near-misses (source weights), and the model receives `- Brand: Unknown` on every catalog line ([aiService.ts:2493-2498](backend/src/services/aiService.ts#L2493-L2498)) — it has *no grounds* to answer a brand question either way.
- **Bias pressure:** two always-on rules push the model toward claiming availability when retrieval missed (empty-match instruction + hidden-catalog note, [aiService.ts:2483-2489, 2557-2568](backend/src/services/aiService.ts#L2483-L2489)) — the exact wrong bias for an unstocked brand.

**Verdict:** precision is adequate in design on the image lane, unimplemented on the text lane, and *inverted* by prompt bias in the failure case.

---

## 8. Similar Product Recommendation Audit

The business policy is well-specified in `guidelines.vision_product_images` (Response A exact/same-brand → Response B "we do not carry [Brand X], but we have [Your Brand], a similar mass gainer" → Response C honest no, end reply; competitor brands nameable only to deny carrying them). Three deviations:

1. The policy is **image-gated** — text brand questions get none of it (§10).
2. Response B's mechanics have no retrieval support: "similar products from the same brand" needs a brand-scoped query (absent), and "similar category, different brand" alternatives are offered only when `brandLikelyAbsent && textSearchMatches.length > 0` — alternatives found by name/type luck, not category-scoped search.
3. `UNCERTAIN_GUARD_CATALOG_ALTERNATIVES` defaults `false` — the escalation path doesn't offer alternatives.

**Ordering verdict:** intended ordering is encoded in prose (prompt), not in code. The only code-level ordering is RRF fusion, which has no brand-priority term on the text lane.

---

## 9. Edge Case Assessment

| Edge case | Handling | Grade |
|---|---|---|
| Unknown/absent brand | Image lane: `brandLikelyAbsent → not_in_catalog` → honest denial. **Defect:** computed against the candidate pool, not the catalog ([productImageMatchingService.ts:659](backend/src/services/productImageMatchingService.ts#L659)) — if retrieval misses, a *stocked* brand is declared absent. Same defect class P0-2 fixed for price/name guards (`GUARD_VALIDATE_AGAINST_FULL_CATALOG`), unfixed here. Text lane: no handling. | ❌ |
| Newly added brand | Depends entirely on the brand column being populated at import + fingerprint job completion (2-min fast cron is good). With the import gap (G16), new products arrive brandless. | ⚠️ |
| Similar-looking logos / counterfeit | Vision self-confidence only; re-rank compares against catalog images, which is the right idea — but the accepted re-rank confidence **overwrites** vector similarity upward ([productImageMatchingService.ts:373](backend/src/services/productImageMatchingService.ts#L373)), letting model self-confidence inflate a hard signal. | ⚠️ |
| Foreign-language packaging | Vision model handles multilingual text natively; Tesseract (eng-only) not in this path — acceptable. | ✅ |
| Low confidence | Clarify ladder is well-designed (`clarify_low_confidence` below 0.35; temperature clamp; "ask a brief clarifying question" section). | ✅ |
| Multiple matching brands in one photo | Single-`brand_name` extraction → clarify only; can never return per-brand results. | ⚠️ |
| Missing catalog data | The dominant real-world case, and the least handled: empty brand column + empty fingerprint set silently degrade every path to name-substring luck. **No signal ever tells the merchant** "your catalog has no brand data / no images" beyond a `console.warn`. | ❌ |
| Vision/provider failure | Unwrapped call fails the reply job (§3); if `GRACEFUL_DEGRADE_MODE` is on the turn ends in a holding reply — but a degraded *extraction-only* failure could have fallen back to text matching and answered. | ❌ |
| Brand question the gap gate does catch, on an empty column | Deterministic escalation `product_question_unanswered` **pauses the conversation with no auto-resume** — an empty data column becomes a paused thread (EV-044/IN1 class; currently rare only because detection requires the literal `brand|marka` token). | ⚠️ |

---

## 10. Prompt & AI Behavior Review

**The good:** `guidelines.vision_product_images` is exactly the right policy text — stepwise, brand-strict, honest-denial, competitor-safe, with "use the steps for reasoning only, answer short". The grounding directive, catalog-integrity block (platform-locked), and extraction prompts are all disciplined.

**Four structural problems:**

1. **All brand-accuracy rules are image-gated.** [promptAssemblyService.ts:277-280](backend/src/services/promptAssemblyService.ts#L277-L280) drops the vision block whenever `hasImages` is false — and this gating is *pinned as intended* by `promptAssemblyAllowlist.test.ts`. A typed brand question is answered by a model that has never seen "A different brand of the same product type is NOT a match."
2. **The always-on prompt trains the failure.** `SHORTEST_ANSWER_APPEND` ([productDescriptionPromptService.ts:477-481](backend/src/services/productDescriptionPromptService.ts#L477-L481), verified verbatim): `"Do you have this brand?" -> "Yes."` plus "Do NOT restate the product or brand name". Nothing downstream verifies that "Yes." — and this example is itself pinned by `conciseResponseRules.test.ts:47`.
3. **Brand names are stripped from replies.** `normalizeProductMentionsForReply` regex-rewrites "Brand Product" → "Product" ([aiService.ts:2607-2633](backend/src/services/aiService.ts#L2607-L2633)) per the "product name only" guideline — defensible for recommendations, wrong for brand-question answers, where naming the matched brand is the answer.
4. **The brand policy block is tenant-editable and budget-droppable.** Unlike `guidelines.catalog_integrity` (`is_platform_locked = true`, force-synced), the vision block is not locked (065:105-110) and not in `BUDGET_PROTECTED_BLOCK_KEYS` — a tenant edit or a tight `PROMPT_GUIDELINES_MAX_CHARS` silently deletes brand policy.

**Guard coverage for brand claims: zero on the send path.**
- Grounding/facts_used: name-lane index is `SELECT name` only; exclusion lane is allergen-only by design; membership lane could technically catch a *declared positive* brand fact but nothing instructs the model to declare brand as an attribute — and the whole contract is **disabled on image turns** ([aiService.ts:4886-4891](backend/src/services/aiService.ts#L4886-L4891), verified) — the turns most prone to brand hallucination have the least guarding. A **denial** declares no facts, so every lane is inert on the dominant failure mode.
- Name-hallucination guard: catches a fabricated brand only when glued to a fabricated product name; its fuzzy-match instruction explicitly forgives brand-only divergence. The offline eval harness *does* verify fabricated brands (RC-03 "BSN", `Zzqfakebrandix` probes) — eval-only, never on the send path.
- Quality eval: rubric omits brand from the factual-error list; scores honest-negatives 0.9+ **against the filtered retrieval window**; and `skipEvaluationForHonestNegative` assigns a synthetic 0.95 without evaluating when the window is empty ([processAIReply.ts:4572-4602](backend/src/jobs/processAIReply.ts#L4572-L4602)). A false brand denial is *rewarded*.
- False-denial backstop: keys on `inboundNamedProducts` from name-only pinning SQL; additionally, pinning grams require ≥5 chars ([inboundNamePinning.ts:108,125](backend/src/services/inboundNamePinning.ts#L108), verified) — "Nike", "Puma", "GNC", "BSN" are structurally unpinnable. "A keni Optimum Nutrition?" answered "Nuk e kemi" ships unguarded even when the catalog is full of ON products. This is the identical bug class commit `91ed747`/the false-availability-denial fix closed for product *names*, one dimension over.

---

## 11. Performance & Scalability Assessment

- **Vision cost:** 2 vision calls per ambiguous image turn (extraction + re-rank), max_tokens 750/120, temp 0. Extraction cache is keyed on the per-upload-unique Cloudinary URL → effectively retry-only. Runtime evidence: `ai_cost_daily` contains **no `vision` role rows at all** — the lane has essentially never run in cost-telemetry history (dev has 8 inbound image messages ever). Cost attribution is wired (`withModelRole('vision')`) and will work when traffic arrives; there is simply no baseline. Unbounded input images (no resize) inflate image-token cost arbitrarily.
- **Retrieval latency:** fingerprint search is HNSW with `ef_search` clamping — fine at 5k+. The keyword lane is the concern: `searchProductsByDisjunctiveTerms` issues **serial** round trips per term over a 10-way ILIKE; measured plan on dev is a tenant-index scan + row filter (fine at 258 rows, acceptable at 5k, but per-term × per-turn). The known `extracted_text` shared-blob landmine compounds any description-scan at scale.
- **Fingerprint pipeline scale:** for the upcoming 5k-product tenant, backfilling fingerprints = 5k vision calls (rate/cost-bounded by the 100-per-batch crons — good), and the versioned re-embed path exists. The `'unknown product image'` rows (empty extraction → stored with **no embedding**) stay invisible to search forever until a version bump — silent coverage loss with no metric.
- **Concurrency:** per-tenant slots + per-conversation locks already bound the pipeline; the unwrapped vision call is the one path that converts a provider blip into job churn (retry × full fan-out).

**Verdict:** acceptable at current scale; three items to fix before the 5k tenant: image downscaling (cost), fingerprint-coverage metric (silent loss), and batched/parallel keyword search (latency).

---

## 12. Observability Review

**Can an engineer diagnose a wrong brand answer today? No — not without the raw prompt blob.**

- The vision verdict (`decision`, `matchConfidence`, `topSimilarity`, `brandLikelyAbsent`, `clarificationReason`) is emitted only via `console.info` (plain console — **no correlationId/traceId**, no Sentry) and a free-string `vision_product_match` analytics event that is not in `ANALYTICS_EVENT_TYPES`.
- `ai_decision_ledger` records 15 classifier event types — **none** vision- or brand-related. `recordDecision` is called for the *outbound* image-request classifier but never for `decideVisionMatch`. The verdict survives only inside the 12K `prompt.preview` blob. Runtime check: of 484 ledger rows, the "image"/"brand" mentions are incidental (classifier verdict arrays), not vision decisions.
- **No alert fires when inbound brand recognition fails.** `product_image_unavailable` covers only the outbound "send me a photo" flow. A week of misidentified customer photos would be invisible.
- No operator read path: no admin route exposes `decision_events`; debugging requires SQL against the ledger.
- No queryable answer to the KPI questions: "how many brand questions this week?", "how often did we deny a brand we carry?", "what % of catalog rows have brand/fingerprints?" (that last one — the dominant failure — has no metric at all).

---

## 13. Enterprise Architecture Assessment

**Division of responsibilities — image lane: correct.** Vision extraction (LLM) / decision policy (pure function, tested) / retrieval (SQL+vector) / prompt rendering are properly layered. Three architectural judgments:

1. **Text-embedding similarity over vision-described fingerprints (instead of CLIP-style image embeddings) is a reasonable, pragmatic choice** — it reuses the existing 1536-dim infrastructure, is debuggable (the fingerprint text is human-readable), and puts brand first in the embedded text. Its weakness (vulnerable to description-wording drift) is mitigated by versioned fingerprints. No change recommended.
2. **The brand feature is prompt-ware where it should be code.** Brand matching policy, brand-availability decisions, and similar-product ordering live in prose blocks interpreted by the reply model, while the deterministic layer (SQL, policy functions, guards) has no brand concept. The platform's own history (price guard, name guard, attribute lane, catalog-integrity) shows the pattern: every accuracy property that matters was eventually moved from prompt to deterministic gate. Brand is the one property still waiting.
3. **Simplification opportunity:** the image lane already contains the correct deterministic trio — `normalizeForMatch` → brand probe → `brandLikelyAbsent` verdict. Porting it to the text lane (with the probe widened from candidate-pool to catalog, per the `GUARD_VALIDATE_AGAINST_FULL_CATALOG` precedent) closes the brand-membership, brand-intent, and false-denial gaps with one small, testable component — no new architecture needed.

**Feature-behavior changes requiring explicit approval** (per the audit's terms of reference, flagged rather than assumed):
- Removing/overriding the trained `"Do you have this brand?" -> "Yes."` example (contradicts test-pinned current behavior in `conciseResponseRules.test.ts`).
- Making brand-accuracy rules apply on text turns (extends the vision block's scope beyond its current image gating, which is also test-pinned).
- Platform-locking `guidelines.vision_product_images` (removes tenant editability).

---

## 14. Prioritized Improvement Roadmap

### CRITICAL

**C1 — Populate brand data (import + backfill + images)**
- **Why:** every brand mechanism in the system is a no-op against a 0.4%-populated column and a 1-row fingerprint table. Nothing else on this list matters until this lands.
- **Current:** import extraction asks for brand without the anti-guess clause (G16); `attributeBackfillService` supports brand but hasn't run; 1/258 products have images.
- **Recommended:** add the "ONLY if explicitly stated / never guess" clause for brand to the import prompt; run the brand backfill (`scripts/backfillProductAttributes.ts`) on real catalogs; drive product-image upload for the 5k tenant onboarding so fingerprints exist; add a catalog brand/fingerprint coverage metric.
- **Impact:** unlocks every other item. **Complexity:** low (code) + operational (backfill runs). **Dependencies:** none. **Risk if skipped:** the feature remains a demo.

**C2 — Deterministic brand membership + brand-scoped retrieval in the text lane**
- **Why:** "do you have brand X" is currently answered by an LLM reading `Brand: Unknown` lines; four of seven canonical intents are structurally unservable.
- **Current:** no brand-scoped query, no `DISTINCT brand`, key-presence-only availability check.
- **Recommended:** port the image trio (fold → probe → verdict) into a small `brandMembershipService`: `findProductsByBrand(tenantId, brand)` (ILIKE + trigram fallback, using the existing dead index) + `listDistinctBrands(tenantId)`; feed the verdict into the reply prompt the way `visionContext` does, and offer same-brand results as the pinned product set.
- **Impact:** makes the stated feature exist for text. **Complexity:** medium. **Dependencies:** C1 (data). **Risk:** false denials and unverifiable yeses continue.

**C3 — Remove the anti-brand prompt behaviors** *(requires product approval — flagged in §13)*
- **Why:** the platform currently *trains* the primary failure ("Yes." with no verification, brand name stripped, brand rules image-gated, policy block tenant-editable).
- **Recommended:** delete/replace the `"Do you have this brand?" -> "Yes."` example (new migration, per the never-edit rule); render the brand-accuracy rules (or a text-adapted copy) on non-image turns when a brand question is detected; exempt brand-question answers from brand stripping; platform-lock + budget-protect the vision block.
- **Impact:** stops actively rewarding wrong answers. **Complexity:** low-medium (prompt migrations + 2 test updates). **Dependencies:** C2 for the verified answer to replace "Yes." with. **Risk:** bare unverified "Yes." ships to brand questions at scale.

**C4 — Wrap the vision extraction call**
- **Why:** the only unguarded step in the matching pipeline fails the entire reply job on a provider blip; the graceful `!extraction` branch already exists and is unreachable.
- **Recommended:** try/catch around the OpenAI call + `JSON.parse` ([productImageMatchingService.ts:279-306](backend/src/services/productImageMatchingService.ts#L279-L306)), degrade to text matching, count the failure in the per-turn degradation store so the P2-6 floor sees it.
- **Impact:** reliability + cost. **Complexity:** low. **Dependencies:** none. **Risk:** image turns are the least reliable turn type in production.

### HIGH

**H1 — Brand-aware inbound pinning & false-denial backstop.** Add a brand rung to the pinning ladder (query the brand column; allow short-brand grams via exact brand-column match, bypassing the ≥5-char floor); `productsDeniedInReply` then covers "Nuk e kemi [Brand]" for free. *Same bug class as the shipped name fix; medium complexity; depends on C1.*

**H2 — `brandLikelyAbsent` against the full catalog.** Replace the candidate-pool probe with a tenant-wide brand membership check (C2's service). *Prevents "we don't carry Muscletech" while Muscletech is in stock; low complexity given C2.*

**H3 — Ledger + alerting for vision/brand decisions.** `recordDecision` for `decideVisionMatch` (classifier `vision_match`, branch = decision, score = matchConfidence); switch `[imageMatch]` logs to the correlation-carrying logger; alert (notify-only) on repeated inbound recognition failure. *Makes incidents diagnosable; low complexity.*

**H4 — Brand-only retrieval tier + fix other-options suppression.** Add T1.5 (brand-only token search) to the image lane's resolver; when `is_attribute_question` names brand AND other-options intent fires, route to fresh brand-scoped search instead of the persisted set. *Serves "similar/other products from this brand"; medium complexity; depends on C2.*

**H5 — Brand in the quality-eval rubric.** Add wrong-brand to the factual-error list; validate honest-negatives against the full catalog (the `GUARD_VALIDATE_AGAINST_FULL_CATALOG` pattern) before scoring them 0.9+; stop skipping evaluation for negative-availability replies when a brand/product was named inbound. *Depends on C2; respect the P3-4 rule — fix the eval, don't move `QUALITY_THRESHOLD`.*

### MEDIUM

- **M1 — Brand normalization & aliases:** canonicalize on write (trim/collapse whitespace, preserve case for display + folded compare column or expression index); Unicode-aware folding in `normalizeForMatch`; small per-tenant alias map (e.g. "ON" → "Optimum Nutrition"); make `findVariantSiblingProducts` case-insensitive.
- **M2 — Image preprocessing:** EXIF-orient + bounded downscale (sharp, already a dependency) before Cloudinary/vision; byte-size cap.
- **M3 — Re-rank must not inflate similarity:** keep vector similarity and re-rank confidence as separate signals into `computeMatchConfidence` instead of `max()`-merging.
- **M4 — Widen brand-question detection:** add `kompani|prodhues|firm[ëa]|brendi|mark[ëe]s?` stems (Gheg-inclusive) to `detectRequestedAttributes` and the follow-up lexicons — with the EV-044 lesson applied: widen only the *customer's-own-words* net.
- **M5 — Fingerprint hygiene:** annotate `in_stock` in visual-match context; re-queue `'unknown product image'` rows on a cadence; coverage metric from H3's data.
- **M6 — Tests:** unit-test `productImageMatchingService` (fusion, confidence, brand heuristic, re-rank acceptance); text-lane brand E2E fixtures (deny-when-absent, confirm-when-present, short brands, diacritics); keep the eval offline-fence rules.

### LOW

- **L1 —** `DISTINCT brand` surface for "what brands do you carry?" (tenant-facing reply + admin API).
- **L2 —** Operator read path for `decision_events` (admin route; the deliberate no-GIN-index decision can stand — filter in app code at admin volumes).
- **L3 —** Deterministic barcode/OCR cross-check on customer photos (barcode → SKU fast path is already the strongest signal when visible; a zxing-style decode would make it vision-independent).
- **L4 —** Multi-brand extraction (array-of-products schema) — only if shelf/poster photos become a real traffic pattern; the clarify ladder is an acceptable interim.

---

## Appendix — runtime evidence snapshot (dev, 2026-08-01)

- `products`: 258 active; brand non-NULL on 1 ("Muscletech"); 1 with `image_urls`; all `source_type='spreadsheet'`.
- `product_image_fingerprints`: 1 row (brand_name="Muscletech"; fingerprint_text leads "Brand: Muscletech. Product: Nitro Tech Ripped…").
- `messages`: 8 inbound images ever vs 474 inbound texts.
- `ai_alerts`: no inbound-vision alert reason exists; `product_image_unavailable` (13) is outbound-only.
- `ai_cost_daily`: roles seen = chat/eval/embedding/classifier/unattributed — **no `vision` rows**.
- `ai_decision_ledger`: 484 rows; 15 classifier types; zero vision/brand decision events.
- `EXPLAIN` on the 10-way ILIKE: tenant-index scan + row filter (fine ≤5k rows; serial per-term loop is the scaling concern).
