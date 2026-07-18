/**
 * P3-2 Step 3 (RC-04 / C-125) — is pgvector's iterative index scan available on THIS database?
 *
 * pgvector 0.8 added `hnsw.iterative_scan`, which continues the ANN scan past `ef_search` until the
 * LIMIT is satisfied or the index is exhausted. That is the purpose-built fix for the global-index
 * + tenant-post-filter under-fill this codebase works around with a second, wider query: it
 * self-terminates for a small tenant AND recovers recall for a large one, which the two-shot retry
 * only half did.
 *
 * Why this must be PROBED and can never be inferred:
 *
 *   1. On pgvector >= 0.8 the `hnsw` GUC prefix is RESERVED, so `SET LOCAL hnsw.anything = …` is
 *      accepted; on older versions an unknown `hnsw.*` parameter is an ERROR. The similarity query
 *      runs inside an explicit transaction, so that error would abort the query itself — taking
 *      retrieval to zero rather than degrading it. A wrong guess is an outage, not a slowdown.
 *   2. The `hnsw.*` GUCs only register once the vector library is LOADED into the session. A bare
 *      `SELECT … FROM pg_settings WHERE name LIKE 'hnsw%'` on a fresh connection returns ZERO rows
 *      even on 0.8.2 (verified). The probe must therefore touch a vector operator first.
 *   3. Production pins the ROLLING `pgvector/pgvector:pg16` tag, so the deployed version is whatever
 *      that tag resolved to at the last image pull — not something this repo can pin or assume.
 *
 * The probe is `SELECT ('[1,2]'::vector <=> '[2,1]'::vector), current_setting('hnsw.iterative_scan', true)`:
 * the operator forces the library to load, and `missing_ok = true` makes the setting read return
 * NULL instead of erroring when the GUC does not exist. So all three failure modes — extension
 * absent, version too old, database unreachable — collapse to "unsupported", never to a throw.
 */
import { knobBool } from '../config/knobs';

/**
 * Runs one probe statement. Injected so the decision logic is testable without a live database —
 * the house idiom (see `failedJobOrchestration.ts`), since there is no mocking framework.
 */
export type VectorProbeFn = () => Promise<{ iterativeScan: string | null }>;

/**
 * pgvector supports `off | strict_order | relaxed_order`. We only ever use `strict_order`:
 * `partitionBySimilarityBand` splits the result on a similarity threshold and `retrievalTop`
 * takes the first 8 rows as "the closest matches", both of which assume strictly descending
 * similarity. `relaxed_order` explicitly does not guarantee that.
 */
export const ITERATIVE_SCAN_MODE = 'strict_order';

let supported: boolean | null = null;

/**
 * Interprets a probe result. `null` means the GUC does not exist (older pgvector, or the extension
 * is not installed) — the only supported case is a real setting value coming back.
 */
export function interpretProbe(result: { iterativeScan: string | null } | null): boolean {
  if (!result) return false;
  return typeof result.iterativeScan === 'string' && result.iterativeScan.length > 0;
}

/**
 * Probe once and cache. Safe to call from any process; never throws — an unreachable database at
 * boot leaves the capability `false`, which simply keeps the existing adaptive-retry behaviour.
 */
export async function initVectorCapability(probe: VectorProbeFn): Promise<boolean> {
  if (supported !== null) return supported;
  try {
    supported = interpretProbe(await probe());
  } catch {
    supported = false;
  }
  console.info('[vector] iterative index scan capability probed', {
    supported,
    mode: ITERATIVE_SCAN_MODE,
  });
  return supported;
}

/** Whether the probe ran AND found support. `false` until `initVectorCapability` resolves. */
export function isIterativeScanSupported(): boolean {
  return supported === true;
}

/**
 * The `hnsw.iterative_scan` value to apply for this query, or `null` to emit no `SET` at all.
 *
 * Both conditions are required and neither is sufficient: the flag expresses operator intent, the
 * probe expresses database capability. Flag on + unprobed/unsupported deliberately yields `null`
 * rather than an optimistic attempt, because the failure mode of guessing wrong is a hard error
 * inside the similarity transaction.
 */
export function iterativeScanSetting(): string | null {
  if (!isIterativeScanSupported()) return null;
  if (!knobBool('VECTOR_ITERATIVE_SCAN')) return null;
  return ITERATIVE_SCAN_MODE;
}

/** Test-only: clear the memoized probe result. */
export function resetVectorCapabilityForTests(): void {
  supported = null;
}
