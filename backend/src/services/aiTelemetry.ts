/**
 * P1-5: the telemetry `generateReply` returns so the orchestrator can build a ledger row.
 *
 * The reply is generated in `aiService.generateReply` but persisted much later in
 * `processAIReply` (via stageAndSend). So all the per-reply telemetry the §15.2 reconstruction
 * needs — prompt provenance, model/params, token usage + cost, retrieval scores/threshold
 * outcomes/semanticSkipped — is captured at generation time and returned in this blob, then
 * carried in-scope down to the persist site and folded into the `LedgerRecord`.
 *
 * Pure types + a mutable sink for the retrieval path (whose scores are otherwise dropped by RRF
 * before they reach the caller).
 */

export interface RetrievalTelemetry {
  /** The semantic (vector) arm was skipped this turn (timeout / error / no embedding). */
  semanticSkipped: boolean;
  /** Coarse reason when skipped ('embedding_unavailable' | 'similarity_query_error'); the precise
   * P1-4 reason (timeout/dim_mismatch) is in the [SEMANTIC_SKIPPED] counter. */
  skipReason: string | null;
  threshold: number;
  /** Candidates that cleared the threshold (>= SIMILARITY_THRESHOLD). */
  coreCount: number;
  /** Candidates in the hysteresis band ([threshold - band, threshold)). */
  bandCount: number;
  sources: Array<{ name: string; count: number }>;
  /** Top candidates with similarity scores — the §15.2 "how far did the correct products fall
   * below 0.65?" gap. Product ids only (no names) so no PII. */
  top: Array<{ id: string; similarity: number }>;
  /** The fused product ids actually injected into the prompt. */
  productIds: string[];
}

/**
 * A mutable out-param. `matchProductsForCustomerMessage` writes `value` when it runs. When a reply
 * reuses persisted/contextual products (no fresh retrieval), `value` stays undefined and the
 * ledger records `retrieval: null` — accurately indicating nothing was retrieved this turn.
 */
export interface RetrievalTelemetrySink {
  value?: RetrievalTelemetry;
}

export interface ReplyTelemetry {
  prompt: {
    /** sha256 of the full assembled messages array. */
    hash: string;
    /**
     * P2-4 (F2): sha256 of the SYSTEM prompt alone — the join key into `ai_prompt_blobs`, where
     * the full redacted text lives when LEDGER_PROMPT_BLOBS is on (the preview is capped at 12K
     * of a 26-33K prompt; this closes the §15.2 "from the ledger alone" residue).
     */
    systemHash: string;
    charCount: number;
    tokenEstimate: number;
    /** Size-capped, PII-masked copy of the SYSTEM prompt (the reconstruction target). */
    preview: string;
  };
  model: {
    requested: string;
    served: string | null;
    customModelUsed: boolean;
    /** The dynamic per-reply temperature actually sent (not the AI_REPLY_TEMPERATURE constant). */
    temperature: number;
    maxTokens: number;
    seed: number | null;
    finishReason: string | null;
    /** finishReason === 'length' — silently truncated at maxTokens (C-97). */
    truncated: boolean;
    systemFingerprint: string | null;
  };
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    usdCost: number | null;
  };
  retrieval: RetrievalTelemetry | null;
}
