/**
 * P3-5 (RC-26/RC-17): the prompt-registry reconcile sweep.
 *
 * Four jobs, in order, each independently useful:
 *
 *  1. REGISTER live content that no admin path recorded. The reply path deliberately never
 *     registers (a lazy upsert would put a Postgres write on the hottest path and, worse, would
 *     self-register every hash on first sight — destroying the "content reached production through
 *     an unregistered path" alarm entirely). Prompt-content migrations and manual SQL also bypass
 *     the admin routes. This sweep is what makes their end-state recorded rather than lost.
 *     Runs regardless of PROMPT_BLOCK_REGISTRY (P3 audit fix) — history capture must not depend
 *     on the flag that merely surfaces it in the ledger.
 *
 *  2. VERIFY every stored hash against a Node recomputation of its own content. Migration 084's
 *     backfill computes hashes in SQL; the runtime computes them in Node. `convert_to(content,
 *     'UTF8')` should make those agree on any `server_encoding`, but "should" is not a property
 *     you want load-bearing under an alarm — verifying converts an encoding surprise into a
 *     visible, self-healing condition instead of silent 100% noise.
 *
 *  3. REFRESH the locked-catalog marker that lets the reply path skip the per-reply force-sync
 *     (step 3). The marker is a content hash rather than `max(updated_at)`: immune to clock skew
 *     across instances and to an UPDATE that does not bump the timestamp.
 *
 *  4. FORCE-SYNC locked blocks fleet-wide. This is the load-bearing half of taking the self-heal
 *     off the hot path. Today's every-reply force-sync is what actually repairs the "exact-string
 *     migration sync missed a tenant" class (migration 052 exists because of it), so removing it
 *     without a replacement would leave that class unrepaired indefinitely. It runs HERE now.
 *
 * Fleet-singleton by construction: it is a BullMQ scheduler job, not a `setInterval`.
 */
import { knobBool } from '../config/knobs';
import pool from '../db/pool';
import { redisConnection } from '../jobs/redisConnection';
import {
  listLivePromptBlockContent,
  listLockedCatalogBlocks,
  listStoredVersionsForVerification,
  listUnregisteredPairs,
  lockedCatalogMarker,
  promptBlockContentHash,
  registerPromptBlockVersions,
  repairPromptBlockVersionHash,
} from '../db/models/promptBlockVersion';
import { forceSyncLockedBlocksForTenants } from '../db/models/promptBlock';
import { invalidateTenantAiCaches } from './invalidateTenantAiCaches';

/** The global marker key. Read by the reply path, written only here and by admin catalog writes. */
export const LOCKED_CATALOG_MARKER_KEY = 'prompt_catalog_version';

/** Per-tenant "the marker I last synced to". */
export function tenantSyncMarkerKey(tenantId: string): string {
  return `prompt_blocks_synced:${tenantId}`;
}

export interface ReconcileSummary {
  liveContentCount: number;
  registered: number;
  hashMismatches: number;
  markerChanged: boolean;
  marker: string | null;
  /** Tenants whose locked blocks had actually drifted and were repaired. */
  tenantsForceSynced: number;
  /** Tenants stamped with the current marker — i.e. allowed to skip the per-reply force-sync. */
  tenantsMarkedCurrent: number;
}

/**
 * Compute the marker and publish it. Split out so an admin catalog mutation can bump it
 * immediately rather than waiting a tick — a locked-block edit should reach replies now.
 */
export async function refreshLockedCatalogMarker(): Promise<string> {
  const locked = await listLockedCatalogBlocks();
  const marker = lockedCatalogMarker(locked);
  await redisConnection.set(LOCKED_CATALOG_MARKER_KEY, marker);
  return marker;
}

export async function runPromptRegistryReconcile(): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    liveContentCount: 0,
    registered: 0,
    hashMismatches: 0,
    markerChanged: false,
    marker: null,
    tenantsForceSynced: 0,
    tenantsMarkedCurrent: 0,
  };

  // Steps 1–2 are UNCONDITIONAL (P3 audit fix). They are pure history capture — additive registry
  // writes off the reply path — and gating them on PROMPT_BLOCK_REGISTRY meant an admin edit or
  // prompt migration under default config overwrote content with no record: the exact RC-17/RC-26
  // defect the registry exists to close. The flag now gates only what it names — per-reply ledger
  // stamping — plus the marker/force-sync mechanics below, which also run for
  // PROMPT_SELF_HEAL_OFF_HOT_PATH (the sweep is that flag's load-bearing replacement, so it must
  // not depend on the registry flag).

  // ---- (1) register anything live but unregistered -----------------------------------------
  const live = await listLivePromptBlockContent();
  summary.liveContentCount = live.length;
  const pairs = live.map((b) => ({
    block_key: b.block_key,
    content_hash: promptBlockContentHash(b.content),
  }));
  const unregistered = await listUnregisteredPairs(pairs);
  if (unregistered.length > 0) {
    const byPair = new Map(pairs.map((p, i) => [`${p.block_key} ${p.content_hash}`, live[i]]));
    const toRegister = unregistered
      .map((u) => byPair.get(`${u.block_key} ${u.content_hash}`))
      .filter((b): b is { block_key: string; content: string } => Boolean(b));
    const created = await registerPromptBlockVersions(toRegister, 'reconcile');
    summary.registered = created.length;
    // Not an error condition on the first tick after a deploy that added a prompt migration —
    // but a recurring non-zero count means something is writing prompt content past every
    // registration path, which is worth a human look.
    console.info('[promptRegistry] Registered previously-unseen prompt content', {
      count: created.length,
      keys: [...new Set(created.map((c) => c.block_key))].slice(0, 20),
    });
  }

  // ---- (2) verify stored hashes against a Node recomputation --------------------------------
  const stored = await listStoredVersionsForVerification();
  for (const row of stored) {
    const recomputed = promptBlockContentHash(row.content);
    if (recomputed === row.content_hash) continue;
    summary.hashMismatches++;
    await repairPromptBlockVersionHash(row.block_key, row.content_hash, recomputed);
  }
  if (summary.hashMismatches > 0) {
    // Almost certainly a non-UTF8 `server_encoding` making the migration's SQL digest disagree
    // with Node's. Loud, because until it is repaired every reply reports unknown versions.
    console.warn('[promptRegistry] Stored content hashes disagreed with a Node recomputation', {
      count: summary.hashMismatches,
      hint: 'check server_encoding; migration 084 hashes via convert_to(content, \'UTF8\')',
    });
  }

  // Steps 3–4 serve the hot-path mechanics: the marker lets replies skip the per-reply force-sync
  // and the fleet-wide sync is that skip's replacement. With both flags off, today's per-reply
  // force-sync still runs and nothing reads the marker — skip the redundant fleet work.
  if (!knobBool('PROMPT_BLOCK_REGISTRY') && !knobBool('PROMPT_SELF_HEAL_OFF_HOT_PATH')) {
    return summary;
  }

  // ---- (3) refresh the locked-catalog marker ------------------------------------------------
  const previous = await redisConnection.get(LOCKED_CATALOG_MARKER_KEY);
  const marker = await refreshLockedCatalogMarker();
  summary.marker = marker;
  summary.markerChanged = previous !== marker;

  // ---- (4) force-sync locked blocks fleet-wide ----------------------------------------------
  // Unconditional, not gated on `markerChanged`: a tenant can be stale because ITS row drifted
  // (the exact-string migration class), not because the catalog moved — in which case the marker
  // never changes and a marker-gated sync would never repair it. The UPDATE is a no-op equality
  // check when content already matches, which is what makes an unconditional sweep affordable.
  const synced = await forceSyncLockedBlocksForTenants();
  const repaired = [...new Set(synced.map((s) => s.tenant_id))];
  summary.tenantsForceSynced = repaired.length;
  for (const tenantId of repaired) {
    await invalidateTenantAiCaches(tenantId).catch(() => undefined);
  }
  if (repaired.length > 0) {
    console.info('[promptRegistry] Force-synced locked prompt blocks', {
      tenants: repaired.length,
      keys: [...new Set(synced.flatMap((s) => s.updated_block_keys))],
    });
  }

  // Mark EVERY tenant current, not just the repaired ones. The force-sync above ran fleet-wide, so
  // a tenant it did not touch is one that needed nothing — equally current. Marking only the
  // repaired set would leave every other tenant taking the database path on its next reply, which
  // is the per-reply cost this whole mechanism removes. Best-effort per tenant.
  const { rows: allTenants } = await pool.query<{ id: string }>('SELECT id FROM tenants');
  for (const t of allTenants) {
    await redisConnection.set(tenantSyncMarkerKey(t.id), marker).catch(() => undefined);
  }
  summary.tenantsMarkedCurrent = allTenants.length;

  return summary;
}
