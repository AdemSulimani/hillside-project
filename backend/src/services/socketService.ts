/**
 * P3-2 Step 1 — the single socket emit seam.
 *
 * Before this, all eight emit methods opened with a bare `if (!io) return;`. That guard is correct
 * in-process (the API attaches `io` at boot) but it is also the exact failure mode of the worker
 * split: `attach()` is reachable only from `initSocketServer` → `server.ts`, so ANY process that
 * does not create the HTTP server leaves `io` null and every emit becomes a no-op with no throw,
 * no log and no Sentry event. There are 87 worker-reachable call sites (73 in `processAIReply`
 * alone, plus `channelIsolationService` which `processInboundMessage` imports), and the four inbox
 * events have NO polling backstop on the client (`query-client.ts` sets `refetchOnWindowFocus:
 * false`; `InboxPage` sets no `refetchInterval`) — so a silent drop means merchants watch a frozen
 * inbox while the AI replies normally.
 *
 * So every emit now funnels through one `emitTo`, which:
 *   1. normalizes the payload to JSON-safe values (see `jsonSafe` — this is wire-identical today
 *      and is what makes the cross-process transport in Step 8 safe), and
 *   2. on a null `io`, reports the drop LOUDLY — `logger.error` (Sentry-wired) throttled to once
 *      per event name per process, plus a monotonic counter readable from diagnostics.
 *
 * Throttling is not optional: one reply turn fires ~73 emits, so an unthrottled report is a log
 * flood and a Sentry quota incident.
 */
import type { Server } from 'socket.io';
import type { Message } from '../db/models/message';
import type { MessageReplyToPayload } from './conversationService';
import type { Order } from '../db/models/order';
import type { AIAlert } from '../db/models/aiAlert';
import type { ChannelType } from '../db/models/channel';
import { logger } from '../utils/logger';

/** Payload for real-time owner notifications when an AI reply fails quality checks. */
export type AIAlertSocketPayload = AIAlert & {
  message_content: string | null;
  contact_name: string;
  channel_type: ChannelType;
  channel_name: string;
};

let io: Server | null = null;

/**
 * P3-2 Step 8: the cross-process transport, installed by `socketPublisher.ts` in a process that has
 * no local `io`. Registered rather than imported so this module stays free of `ioredis` and
 * `socket.io` runtime imports — it is pulled in by ~10 modules including the hot reply path, and a
 * Redis client constructed at import time there would be a handle every process pays for.
 */
export type FallbackPublisher = (room: string, event: string, payload: unknown) => void;

let fallbackPublisher: FallbackPublisher | null = null;

export function setFallbackPublisher(publisher: FallbackPublisher | null): void {
  fallbackPublisher = publisher;
}

export function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

// ---------------------------------------------------------------------------
// Drop diagnostics
// ---------------------------------------------------------------------------

/** Event names already reported this process — the throttle key. */
const reportedDropEvents = new Set<string>();
/** Monotonic per-event drop counts. Never reset outside tests. */
const dropCounts = new Map<string, number>();

export interface SocketEmitDiagnostics {
  /** Total emits dropped because no transport was available. Steady state must be 0. */
  droppedTotal: number;
  /** Per-event-name drop counts. */
  droppedByEvent: Record<string, number>;
  /** Whether an `io` instance is attached in THIS process. */
  attached: boolean;
  /** Whether a cross-process publisher is installed as the fallback transport. */
  publisherInstalled: boolean;
}

export function getSocketEmitDiagnostics(): SocketEmitDiagnostics {
  let droppedTotal = 0;
  const droppedByEvent: Record<string, number> = {};
  for (const [event, count] of dropCounts) {
    droppedTotal += count;
    droppedByEvent[event] = count;
  }
  return {
    droppedTotal,
    droppedByEvent,
    attached: io !== null,
    publisherInstalled: fallbackPublisher !== null,
  };
}

/**
 * Test-only: detach any attached server and clear the throttle + counters, so a case that
 * exercises the attached path cannot leak into one that exercises the dropped path. There is no
 * production detach — `attach` is called once per process at boot and the process owns `io` for
 * its lifetime.
 */
export function resetSocketServiceForTests(): void {
  io = null;
  fallbackPublisher = null;
  reportedDropEvents.clear();
  dropCounts.clear();
}

// ---------------------------------------------------------------------------
// Payload normalization
// ---------------------------------------------------------------------------

/**
 * Payloads are raw `pg` rows and `db/pool.ts` registers no `setTypeParser`, so `timestamptz`
 * columns arrive as real JS `Date` objects. In-process delivery serializes them through Socket.IO's
 * JSON parser (Date → ISO string), but the cross-process transport (Step 8) encodes with msgpack,
 * which has no native Date type — an encode path that has effectively never run in production
 * because prod has always been a single replica.
 *
 * Normalizing here makes both transports produce the same wire value, and does it BEFORE the
 * transport choice so the two can never diverge. Today this is a no-op on the wire: JSON.stringify
 * of a Date already yields the same ISO string.
 */
function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  // Plain objects only — leave class instances (Buffer etc.) alone rather than mangling them.
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = jsonSafe(v);
      }
      return out;
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

function recordDrop(event: string, tenantId: string): void {
  dropCounts.set(event, (dropCounts.get(event) ?? 0) + 1);
  if (reportedDropEvents.has(event)) return;
  reportedDropEvents.add(event);
  logger.error(
    '[socket] emit dropped — no socket transport in this process',
    new Error(`socket emit dropped: ${event}`),
    {
      event,
      tenantId,
      // Reported once per event name per process; the running total is in the counter.
      throttled: 'once-per-event-per-process',
      hint: 'a worker process needs SOCKET_CROSS_PROCESS_EMIT=true (P3-2 Step 8)',
    },
  );
}

function emitTo(tenantId: string, event: string, payload: unknown): void {
  const safePayload = jsonSafe(payload);
  const room = tenantRoom(tenantId);
  // Local delivery wins whenever it is available. In an `all`-role process this is the only branch
  // ever taken, so the pre-split behaviour is untouched even with the publisher installed.
  if (io) {
    io.to(room).emit(event, safePayload);
    return;
  }
  if (fallbackPublisher) {
    try {
      fallbackPublisher(room, event, safePayload);
      return;
    } catch (err) {
      // A publish failure must be as loud as no transport at all — it is the same outcome for the
      // merchant (a frozen inbox), and silently falling through would hide a broken Redis link.
      logger.error('[socket] cross-process publish failed', err, { event, tenantId });
    }
  }
  recordDrop(event, tenantId);
}

export const socketService = {
  attach(serverIo: Server): void {
    io = serverIo;
  },

  /**
   * Emits the new message to the tenant room. Pass `replyTo` when the message references
   * another row (thread reply) so clients can render the quote without refetching.
   */
  emitNewMessage(tenantId: string, message: Message, replyTo?: MessageReplyToPayload): void {
    const messagePayload = replyTo !== undefined ? { ...message, replyTo } : message;
    emitTo(tenantId, 'new_message', {
      message: messagePayload,
      conversationId: message.conversation_id,
    });
  },

  emitConversationUpdated(tenantId: string, conversationId: string): void {
    emitTo(tenantId, 'conversation_updated', { conversationId });
  },

  /**
   * Broadcasts an in-place edit on an existing message (Meta `message_edits` etc.). Clients
   * should patch the matching row in the open thread without inserting a new bubble. Pass the
   * fully-mapped `Message` row so the client receives the updated edit metadata.
   */
  emitMessageEdited(tenantId: string, message: Message): void {
    emitTo(tenantId, 'message_edited', {
      message,
      conversationId: message.conversation_id,
    });
  },

  emitOrderCreated(tenantId: string, order: Order): void {
    emitTo(tenantId, 'order_created', { order });
  },

  /**
   * Emitted when the AI updates an existing order's customer information
   * (address, phone, name, or notes) in response to a customer correction request.
   *
   * NOTE (P3-2): `order_updated` currently has NO frontend listener — grep the frontend and you
   * will find `order_created` and `order_action_required` handled, and this one not. It is kept
   * (the emit is cheap and the signal is correct) so wiring the client is a frontend-only change,
   * but do not treat its delivery as proof the transport works — assert on a listened event.
   */
  emitOrderUpdated(tenantId: string, order: Order): void {
    emitTo(tenantId, 'order_updated', { order });
  },

  emitOrderActionRequired(
    tenantId: string,
    payload: { order: Order; reason: string | null },
  ): void {
    emitTo(tenantId, 'order_action_required', payload);
  },

  emitAIAlert(tenantId: string, alert: AIAlertSocketPayload): void {
    emitTo(tenantId, 'ai_alert', alert);
  },

  emitMessageSendFailed(
    tenantId: string,
    payload: { messageId: string; conversationId: string; error: string },
  ): void {
    emitTo(tenantId, 'message_send_failed', payload);
  },
};
