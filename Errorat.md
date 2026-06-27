Root causes, ranked by impact
1. Retrieval silently degrades under load (the #1 driver of intermittency)
This is the single most important finding. Your retrieval has a 5-second fail-open timeout on the query embedding:


aiService.ts
Lines 648-662
async function generateQueryEmbeddingWithTimeout(text: string): Promise<number[] | null> {
  const cached = getCachedQueryEmbedding(text);
  if (cached) return cached;
  try {
    const result = await Promise.race([
      generateEmbedding(text),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), EMBEDDING_QUERY_TIMEOUT_MS)),
    ]);
    if (result) setCachedQueryEmbedding(text, result);
    return result;
  } catch {
    return null;
  }
}
When that returns null (OpenAI slow, rate-limited, or your box is CPU-starved), the entire semantic search path is dropped and retrieval silently falls back to keyword/ILIKE only:


aiService.ts
Lines 699-734
  if (embeddingVector) {
    ...
      semanticCandidates = similar.filter((p) => p.similarity >= SIMILARITY_THRESHOLD);
    ...
  } else {
    semanticSkipped = true;
  }
  ...
  const sources: WeightedSource[] = categoryIntent && categoryTagMatches.length > 0
    ? [ /* no semantic source */ ]
    : [
        { name: 'semantic', products: semanticCandidates, weight: 2.0 }, // highest weight
        ...
      ];
The semantic source carries the highest fusion weight (2.0). So the same question can resolve to a completely different product set depending on whether one network call returned in time. The model isn't hallucinating from nowhere — it's being handed different (or empty/wrong) context. Garbage-in → confident-garbage-out.

This is load-correlated: when traffic is high, embedding latency and rate-limit 429s rise, the timeout fires more often, and your "good days vs bad days" pattern emerges.

2. The vector index itself is approximate and not tenant-isolated

product.ts
Lines 721-734
 * Candidate pool size for the HNSW graph traversal. The `embedding` index is GLOBAL
 * (not partitioned per tenant), and the tenant filter is applied AFTER the ANN scan.
 * With the pgvector default (40) a tenant whose products are a small fraction of all
 * rows can have its correct matches fall outside the global top-40 and silently return
 * fewer than `limit` rows — the "the right product exists but wasn't retrieved" bug.
Two problems here:

HNSW is approximate by definition. It does not guarantee the true nearest neighbors, and results shift with ef_search, concurrent writes, and index state.
The index is global across all tenants, with the tenant_id filter applied after the ANN scan. For an enterprise tenant with thousands of products sharing the index with everyone else, the correct rows can fall outside the candidate pool intermittently. Your own code already has an "adaptive escalation" band-aid (ef_search 100 → 500) for exactly this. That mitigates but does not fix it, and it gets worse as the catalog grows — i.e., precisely your stated target scale.
3. The generation step is genuinely non-deterministic

aiService.ts
Lines 120-124
const AI_REPLY_TEMPERATURE = (() => {
  const raw = process.env.AI_REPLY_TEMPERATURE;
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : 0.3;
})();
The final customer reply runs at temperature 0.3 with no seed (backend/src/services/aiService.ts:4117-4123). Even at temperature 0, OpenAI chat models aren't deterministic without a seed, and 0.3 guarantees run-to-run wording/decision drift. The model also varies by path:


aiService.ts
Lines 4105-4107
  const model = hasImages
    ? OPENAI_VISION_MODEL
    : (config.custom_model_id || process.env.OPENAI_CHAT_MODEL?.trim() || 'gpt-4o');
Note openaiClient.ts:31 defaults OPENAI_CHAT_MODEL to gpt-4o-mini, but this line falls back to gpt-4o, and a per-tenant custom_model_id (possibly a fine-tune) can override both. So different tenants/conditions literally run different models — different quality, different failure modes.

4. A 15-call LLM "decision tree" where every node can flip the answer
aiService.ts is ~4,140 lines with 25+ separate openai.chat.completions.create calls, and processAIReply.ts is ~151 KB / ~2,900 lines. A single inbound message fans out into many sequential LLM classifiers — just in the entry of generateReply:


aiService.ts
Lines 3484-3496
  const [customerAskedPrice, customerAskedDiscount, detectedLanguage, attributeIntent, otherOptionsIntent] =
    await Promise.all([
      customerAskedAboutPrice(inboundMessage),
      customerAskedAboutDiscount(inboundMessage),
      detectReplyLanguage(...),
      classifyProductAttributeIntent(inboundMessage),
      classifyOtherProductOptionsIntent(inboundMessage),
    ]);
…plus isConversationEnding, classifyUsageQuestionIntent, classifySpeculativeHealthAdvice, filterHallucinatedProductNames, the price-consistency guard, the uncertain-answer guard, and more. Each classifier output branches the system-prompt assembly (you can see the prompt being mutated with conditional appends from line ~3918 to ~4091).

The math is brutal: if you chain ~10 probabilistic classifiers each ~95% accurate, end-to-end correctness is 0.95^10 ≈ 60%. This is the structural reason it works "sometimes." Every classifier is another dice roll, and they multiply.

5. The "guards" are reactive patches that fail open
processAIReply.ts ends with a stack of post-hoc guards — filterHallucinatedPrices, detectCrossMessagePriceInconsistency, filterHallucinatedProductNames, uncertainAnswerFallbackGuard — and each one is explicitly designed to fail open ("the guard must never silently suppress a valid reply"). So under the exact conditions that cause errors (load, timeouts, transient OpenAI failures), the guards that are supposed to catch hallucinations are the most likely to be bypassed.

6. Nothing measures correctness → guaranteed regressions
Your CI (.github/workflows/ci.yml) runs typecheck, build, migration, and a health-endpoint ping. There is no behavioral eval — no fixed dataset of product questions with expected answers that gates a merge. The unit tests that exist check individual heuristics, not end-to-end answer quality.

This is why fixed issues come back. A "fix" is verified by hand once, against a system whose output is random, with no regression net. The next deploy (or the next high-traffic hour) reintroduces it and no one notices until a customer does.

7. The server is genuinely undersized for the goal

docker-compose.prod.yml
Lines 1-1
# Production overlay for the DigitalOcean droplet (1 vCPU / 2 GB RAM).
Postgres + Redis + Node backend + frontend are co-located on one 1-vCPU / 2 GB box, with AI_WORKER_CONCURRENCY=2, Postgres shared_buffers=192MB, Redis capped at 192 MB. The HNSW vector scans (ef_search up to 500) are CPU- and memory-heavy and compete with everything else for that single core. Under load, CPU contention → slower embedding/DB calls → the 5 s timeout in cause #1 fires more often → retrieval degrades → hallucinations spike. This is the physical mechanism that ties "heavy traffic" to "bad answers." This box cannot support "enterprises with thousands of products and heavy traffic."