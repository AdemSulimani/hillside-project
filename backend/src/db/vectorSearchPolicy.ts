/**
 * P3-2 Step 2 (C-125 / RC-04) — when is a second, wider HNSW pass worth a pool slot?
 *
 * `searchProductsBySimilarity` runs the ANN scan against a GLOBAL HNSW index and applies
 * `tenant_id` as a POST-filter, so a small tenant's true matches can be crowded out of the
 * candidate pool by other tenants' rows. The mitigation was a retry at a much larger `ef_search`,
 * triggered purely on `firstPass.length < limit`.
 *
 * That trigger has no idea how many rows the tenant even has. Measured on the dev database: one
 * tenant has 257 eligible products and the other has exactly ONE. With a limit of 10, the
 * second tenant trips the retry on 100% of its semantic queries and can never gain a row — the
 * retry re-enters `runWithEfSearch`, which takes a *second* `pool.connect()` + BEGIN + SET LOCAL +
 * SELECT + COMMIT. The scarce resource burned is a connection out of a 10-slot pool shared with 22
 * worker job slots, not milliseconds.
 *
 * The fix is a SOUND predicate, not a heuristic. `eligibleCount` is an UPPER bound on the rows the
 * query can return (it counts active non-deleted products; the query additionally requires
 * `embedding IS NOT NULL` and may apply the embedding-model guard). Let U be that bound and E the
 * true eligible count, so U >= E. If `firstPassCount >= U` then `firstPassCount >= E`, i.e. we are
 * already holding every row that could ever be returned, and a wider pool provably cannot add one.
 *
 * Because the bound only ever runs HIGH, a wrong `eligibleCount` costs a missed optimisation — it
 * can never suppress an escalation that would have found a product. That asymmetry is the whole
 * reason this is safe to ship without a flag.
 *
 * Pure module: no `pg` import, no clock, no environment reads.
 */

export interface EfSearchEscalationInput {
  /** Rows returned by the first pass. */
  firstPassCount: number;
  /**
   * The limit actually passed to the SQL query — NOT the caller's nominal limit. When the
   * similarity hysteresis band is active the caller inflates it by `SEMANTIC_BAND_EXTRA_DEPTH`,
   * and comparing against the un-inflated value would reintroduce the bug on the band path only.
   */
  effectiveLimit: number;
  /**
   * Upper bound on rows the query could return for this tenant, or `null` when unknown. `null`
   * reproduces the legacy predicate exactly, which is what keeps the three call sites that have no
   * count in scope byte-for-byte unchanged.
   */
  eligibleCount: number | null;
  /** The floor `ef_search` used by the first pass. */
  efSearch: number;
  /** The ceiling `ef_search` the escalation would use. */
  efSearchMax: number;
}

/**
 * `true` when a second pass at a wider `ef_search` could plausibly return more rows.
 *
 * Three independent reasons to decline, in cost order:
 *   1. the first pass already filled the limit — nothing to recover;
 *   2. the wider pool is not actually wider — the retry would repeat the identical query;
 *   3. the tenant provably has no more eligible rows than we already hold (the C-125 case).
 */
export function shouldEscalateEfSearch(input: EfSearchEscalationInput): boolean {
  const { firstPassCount, effectiveLimit, eligibleCount, efSearch, efSearchMax } = input;

  // (1) Result set is full — the legacy trigger's own precondition.
  if (firstPassCount >= effectiveLimit) return false;

  // (2) `runWithEfSearch` is always called with at least the limit, so an escalation only means
  // something when the ceiling clears that floor. Preserved from the legacy predicate.
  const floor = Math.max(efSearch, effectiveLimit);
  const wider = Math.max(efSearchMax, effectiveLimit);
  if (wider <= floor) return false;

  // (3) C-125: `eligibleCount` bounds the result set from above. Holding that many rows already
  // means the second pass cannot add one. Unknown (`null`) declines to conclude.
  if (eligibleCount !== null && firstPassCount >= eligibleCount) return false;

  return true;
}

/**
 * A safe, positive integer `ef_search`, never below `floor`.
 *
 * `SET LOCAL hnsw.ef_search = ${value}` is string-interpolated (it is a GUC, not a bindable
 * parameter), so a `NaN` or `Infinity` reaching it renders literally and throws INSIDE the same
 * transaction as the similarity query — taking retrieval to zero rather than degrading it. That is
 * the `SIMILARITY_THRESHOLD`-accepts-NaN incident class, so the guard lives here rather than at the
 * call site.
 */
export function clampEfSearch(raw: number, floor: number): number {
  const safeFloor = Number.isFinite(floor) && floor > 0 ? Math.floor(floor) : 1;
  if (!Number.isFinite(raw) || raw <= 0) return safeFloor;
  return Math.max(safeFloor, Math.floor(raw));
}
