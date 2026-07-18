/**
 * P3-2 Step 6 — what does THIS process do?
 *
 * Until now the answer was always "everything": one entrypoint started Express, Socket.IO and all
 * five BullMQ workers, so a single container was simultaneously the API and the entire worker
 * fleet. `PROCESS_ROLE` names the three possibilities and lets the deploy unit be split without
 * changing any behaviour by default.
 *
 * The default is deliberately `'all'`, not `'api'`: every existing deployment sets nothing, and
 * `'all'` is byte-for-byte what they run today. A default of `'api'` would silently stop every
 * worker on the first deploy of this change — the exact class of silent-topology-change this item
 * exists to make impossible.
 *
 * NOT declared in `config/knobs.ts`, on purpose. `shouldFingerprint` defaults to true for every
 * declared knob, and this value is SUPPOSED to differ between the API and the worker. Declaring it
 * would make `count(DISTINCT hash) > 1` permanently true and destroy the fleet-drift signal that
 * catches genuine decision-knob skew. It is documented in `.env.example` only, which is safe
 * because the example-drift check is one-directional (example ⊇ manifest).
 *
 * Pure module: no imports, no side effects, no environment captured at load.
 */

export type ProcessRole = 'all' | 'api' | 'worker';

const ROLES: readonly ProcessRole[] = ['all', 'api', 'worker'];

export const DEFAULT_PROCESS_ROLE: ProcessRole = 'all';

export interface ProcessRoleResolution {
  role: ProcessRole;
  /** The raw value, when it was present but unrecognised — for the boot report. */
  rejected: string | null;
}

/**
 * Resolve with an explicit report of a rejected value.
 *
 * An unrecognised role reverts to `'all'` and SAYS SO, following `INTENT_THRESHOLD`'s precedent:
 * a typo'd `PROCESS_ROLE=wroker` silently running the full stack is survivable, but silently
 * running it while an operator believes they split the fleet is how a "why is this job running
 * twice" incident starts. Reverting to `'all'` rather than failing is the safe direction — the
 * worst case is the pre-split topology, never a queue with no consumer.
 */
export function resolveProcessRoleDetailed(
  env: NodeJS.ProcessEnv = process.env,
): ProcessRoleResolution {
  const raw = (env.PROCESS_ROLE ?? '').trim().toLowerCase();
  if (raw === '') return { role: DEFAULT_PROCESS_ROLE, rejected: null };
  if ((ROLES as readonly string[]).includes(raw)) {
    return { role: raw as ProcessRole, rejected: null };
  }
  return { role: DEFAULT_PROCESS_ROLE, rejected: (env.PROCESS_ROLE ?? '').trim() };
}

export function resolveProcessRole(env: NodeJS.ProcessEnv = process.env): ProcessRole {
  return resolveProcessRoleDetailed(env).role;
}

/** Whether this process should construct the BullMQ workers and register the schedulers. */
export function roleRunsWorkers(role: ProcessRole): boolean {
  return role === 'all' || role === 'worker';
}

/** Whether this process should listen for HTTP and serve Socket.IO. */
export function roleRunsHttpApi(role: ProcessRole): boolean {
  return role === 'all' || role === 'api';
}

/**
 * Whether this process can deliver socket events through a locally-attached `io`. A worker-only
 * process cannot, which is why it needs the cross-process emitter (Step 8) — and why booting one
 * without it is a fatal rather than a silently frozen inbox.
 */
export function roleHasLocalSocketServer(role: ProcessRole): boolean {
  return roleRunsHttpApi(role);
}
