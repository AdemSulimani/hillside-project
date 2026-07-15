/**
 * P2-7 (RC-06) — publish this instance's config fingerprint at boot, and warn when the fleet
 * disagrees with itself.
 *
 * Layer 2 of guard 7. Layer 1 is the always-on `[config] fingerprint=...` line in validateEnv
 * (no flag, no DB); this layer makes drift QUERYABLE, which is what turns "two log lines somewhere
 * in an aggregator" into `SELECT count(DISTINCT hash) ...`.
 *
 * Runs AFTER the HTTP listener is up and is best-effort by construction: a telemetry write must
 * never delay or fail a boot. Mirrors `ledgerRetention`'s start/stop lifecycle.
 */
import { fingerprint } from '../config/knobs';
import { knobBool } from '../config/knobs';
import {
  countDistinctLiveFingerprints,
  divergentKnobs,
  listLiveFingerprints,
  recordConfigFingerprint,
} from '../db/models/configFingerprint';

function enabled(): boolean {
  return knobBool('CONFIG_FINGERPRINT_REGISTRY');
}

/**
 * Record this process's config and report fleet drift.
 *
 * Never throws. Returns the number of distinct live configs (1 = healthy, >1 = drifted, 0 = the
 * write did not happen).
 */
export async function recordConfigFingerprintBestEffort(): Promise<number> {
  if (!enabled()) return 0;

  try {
    const fp = fingerprint(process.env);
    await recordConfigFingerprint(fp.hash, fp.instance, fp.knobs);

    const distinct = await countDistinctLiveFingerprints();
    if (distinct > 1) {
      // This is the RC-06 assertion firing: two instances are serving the same tenants under
      // different frozen knobs, so the same customer message can get a different outcome depending
      // on which worker picks it up. Name the offending knobs — "there is drift" is not actionable,
      // "AI_MAX_REPLIES_PER_HOUR differs" is.
      const rows = await listLiveFingerprints();
      const diverged = divergentKnobs(rows);
      console.warn(
        `[config] FLEET DRIFT: ${distinct} distinct configs live across ${rows.length} instance(s). ` +
          `Diverging knobs: ${diverged.length > 0 ? diverged.join(', ') : '(none — same knobs, differing secrets)'}. ` +
          'Identical inputs can produce different outcomes depending on which instance serves them ' +
          '(RC-06). Reconcile the env across instances, or finish the rolling deploy.',
      );
      for (const r of rows) {
        console.warn(`[config]   ${r.hash} ${r.instance} (last seen ${r.last_seen.toISOString()})`);
      }
    }
    return distinct;
  } catch (err) {
    // A telemetry table being unavailable is not a reason to refuse traffic.
    console.warn('[config] fingerprint registry write failed (non-fatal):', (err as Error).message);
    return 0;
  }
}
