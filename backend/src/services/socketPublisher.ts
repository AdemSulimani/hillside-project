/**
 * P3-2 Step 8 — cross-process socket delivery.
 *
 * A worker process has no `io`, so every one of the ~87 worker-reachable emits would be dropped.
 * `@socket.io/redis-emitter` publishes onto the exact Redis channels the API's
 * `@socket.io/redis-adapter` already subscribes to, so the worker can broadcast into a tenant room
 * without owning a Socket.IO server.
 *
 * Why the emitter and not a hand-rolled pub/sub channel:
 *   - The room naming already matches: `socketService.tenantRoom()` produces `tenant:{id}` and
 *     `sockets/index.ts` joins exactly that, so `emitter.to(room).emit(event, payload)` reproduces
 *     today's wire format byte-for-byte. All 87 call sites and every payload shape stay untouched.
 *   - A hand-rolled channel needs the API to re-emit with `io.local.to(room)`. A plain `io.to()`
 *     re-enters the adapter, so every client would receive one copy PER API replica — invisible at
 *     one replica, a guaranteed incident at two.
 *   - Both packages default their channel prefix to `socket.io` (verified against the installed
 *     dist of each). A mismatch there would make broadcasts vanish with no error anywhere.
 *
 * Why the API installs it too: it costs one idle Redis connection and makes the two roles run the
 * same code path, so a future API-side emit from a context without `io` cannot silently regress.
 * The local `io` branch always wins in `emitTo`, so nothing about single-process delivery changes.
 */
import IORedis from 'ioredis';
import { Emitter } from '@socket.io/redis-emitter';
import { redisClientDefaults } from '../redisClientDefaults';
import { knobBool } from '../config/knobs';
import { setFallbackPublisher } from './socketService';

let client: IORedis | null = null;

export interface SocketPublisherInstallResult {
  installed: boolean;
  reason: 'installed' | 'disabled' | 'already-installed' | 'error';
}

/**
 * Install the publisher as `socketService`'s fallback transport. Idempotent.
 *
 * Never throws: a process that cannot reach Redis here still starts, and its emits fall through to
 * the Step 1 loud-drop path (counted + reported to Sentry) rather than crashing the worker. The
 * boot-time refusal for a worker with the flag OFF is a separate, deliberate check in `worker.ts` —
 * that one is a misconfiguration, not a runtime failure, and it is worth refusing to start for.
 */
export function installCrossProcessSocketPublisher(): SocketPublisherInstallResult {
  if (client) return { installed: true, reason: 'already-installed' };
  if (!knobBool('SOCKET_CROSS_PROCESS_EMIT')) {
    return { installed: false, reason: 'disabled' };
  }

  try {
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    client = new IORedis(redisUrl, redisClientDefaults);
    const emitter = new Emitter(client);
    setFallbackPublisher((room, event, payload) => {
      emitter.to(room).emit(event, payload);
    });
    console.info('[socket] cross-process publisher installed');
    return { installed: true, reason: 'installed' };
  } catch (err) {
    console.error('[socket] failed to install cross-process publisher', err);
    client = null;
    return { installed: false, reason: 'error' };
  }
}

/** Release the publish connection on shutdown. Safe to call when nothing was installed. */
export async function closeCrossProcessSocketPublisher(): Promise<void> {
  setFallbackPublisher(null);
  if (!client) return;
  const current = client;
  client = null;
  await current.quit().catch(() => undefined);
}
