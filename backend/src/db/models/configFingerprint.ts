/**
 * P2-7 (RC-06) — data access for `config_fingerprints` (migration 081).
 *
 * One row per (config hash, instance). "More than one distinct hash live at once" is the definition
 * of a drifted fleet — see `countDistinctLiveFingerprints`.
 */
import pool from '../pool';

export interface ConfigFingerprintRow {
  hash: string;
  instance: string;
  knobs: Record<string, unknown>;
  first_seen: Date;
  last_seen: Date;
}

/**
 * Record this instance's config. Idempotent per (hash, instance): a restart on the same config
 * refreshes `last_seen` rather than adding a row, so the table stays proportional to the number of
 * distinct configs in the fleet, not to the number of restarts.
 *
 * `knobs` is re-written on conflict so a knob whose value changed *within* the same hash could not
 * silently persist — that cannot happen (the hash is a function of the knobs), but writing it keeps
 * the row self-consistent rather than relying on that invariant holding forever.
 */
export async function recordConfigFingerprint(
  hash: string,
  instance: string,
  knobs: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `INSERT INTO config_fingerprints (hash, instance, knobs)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (hash, instance)
     DO UPDATE SET last_seen = now(), knobs = EXCLUDED.knobs`,
    [hash, instance, JSON.stringify(knobs)],
  );
}

/**
 * How many distinct configs are live in `windowMinutes`. `> 1` means the fleet disagrees with
 * itself: two instances are serving the same tenants under different knobs, which is exactly
 * RC-06's "worker identity is a hidden variable".
 */
export async function countDistinctLiveFingerprints(windowMinutes = 10): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(DISTINCT hash) AS count
       FROM config_fingerprints
      WHERE last_seen > now() - ($1 || ' minutes')::interval`,
    [String(windowMinutes)],
  );
  return Number(rows[0]?.count ?? 0);
}

/** The live fingerprints, newest first — the diagnosis view once drift is detected. */
export async function listLiveFingerprints(windowMinutes = 10): Promise<ConfigFingerprintRow[]> {
  const { rows } = await pool.query<ConfigFingerprintRow>(
    `SELECT hash, instance, knobs, first_seen, last_seen
       FROM config_fingerprints
      WHERE last_seen > now() - ($1 || ' minutes')::interval
      ORDER BY last_seen DESC`,
    [String(windowMinutes)],
  );
  return rows;
}

/**
 * Names of the knobs whose values differ across the given fingerprints — the answer to "WHICH knob
 * drifted", which is the question an operator actually has once the count is > 1.
 */
export function divergentKnobs(rows: ConfigFingerprintRow[]): string[] {
  if (rows.length < 2) return [];
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.knobs ?? {})) keys.add(k);

  const diverged: string[] = [];
  for (const key of keys) {
    const values = new Set(rows.map((r) => JSON.stringify(r.knobs?.[key] ?? null)));
    if (values.size > 1) diverged.push(key);
  }
  return diverged.sort();
}
