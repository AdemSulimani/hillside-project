/**
 * P3-2 Step 1 — the socket emit seam.
 *
 * Two properties matter and neither was observable before:
 *  1. An emit with no transport in this process is COUNTED and REPORTED (once per event name), not
 *     silently swallowed. This is the failure mode of the worker split — 87 worker-reachable call
 *     sites, and the four inbox events have no client-side polling backstop.
 *  2. Payloads are normalized to JSON-safe values BEFORE the transport choice, so the in-process
 *     (JSON) and cross-process (msgpack, Step 8) paths cannot diverge on `Date`.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'socket.io';
import type { Message } from '../../db/models/message';
import type { Order } from '../../db/models/order';
import {
  socketService,
  getSocketEmitDiagnostics,
  resetSocketServiceForTests,
} from '../socketService';

interface Captured {
  room: string;
  event: string;
  payload: unknown;
}

/** Minimal stand-in for the `.to(room).emit(event, payload)` subset the seam uses. */
function fakeIo(sink: Captured[]): Server {
  return {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          sink.push({ room, event, payload });
        },
      };
    },
  } as unknown as Server;
}

function messageRow(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    conversation_id: 'conv-1',
    direction: 'outbound',
    type: 'text',
    sent_by: 'ai',
    content: 'hello',
    created_at: new Date('2026-07-18T10:20:30.000Z'),
    ...overrides,
  } as unknown as Message;
}

beforeEach(() => {
  resetSocketServiceForTests();
});

after(() => {
  resetSocketServiceForTests();
});

describe('socket emit seam — dropped emits are loud', () => {
  it('counts every dropped emit when no transport is attached', () => {
    for (let i = 0; i < 5; i += 1) {
      socketService.emitConversationUpdated('tenant-1', `conv-${i}`);
    }

    const diag = getSocketEmitDiagnostics();
    assert.equal(diag.attached, false);
    assert.equal(diag.droppedTotal, 5, 'every dropped emit must be counted, not just the first');
    assert.equal(diag.droppedByEvent.conversation_updated, 5);
  });

  it('counts each event name separately', () => {
    socketService.emitConversationUpdated('tenant-1', 'conv-1');
    socketService.emitConversationUpdated('tenant-1', 'conv-2');
    socketService.emitNewMessage('tenant-1', messageRow());
    socketService.emitMessageSendFailed('tenant-1', {
      messageId: 'm1',
      conversationId: 'conv-1',
      error: 'boom',
    });

    const diag = getSocketEmitDiagnostics();
    assert.equal(diag.droppedTotal, 4);
    assert.deepEqual(diag.droppedByEvent, {
      conversation_updated: 2,
      new_message: 1,
      message_send_failed: 1,
    });
  });

  it('reports at most once per event name per process (the log-flood guard)', () => {
    // One reply turn fires ~73 emits; an unthrottled report is a log flood and a Sentry quota
    // incident. The throttle is on the REPORT, never on the counter.
    const reports: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      reports.push(String(args[0]));
    };
    try {
      for (let i = 0; i < 50; i += 1) {
        socketService.emitConversationUpdated('tenant-1', `conv-${i}`);
        socketService.emitNewMessage('tenant-1', messageRow());
      }
    } finally {
      console.error = originalError;
    }

    assert.equal(
      reports.length,
      2,
      'exactly one report per distinct event name, regardless of emit volume',
    );
    assert.equal(getSocketEmitDiagnostics().droppedTotal, 100, 'the counter is NOT throttled');
  });
});

describe('socket emit seam — attached transport', () => {
  it('routes to the tenant room with the documented event name and payload shape', () => {
    const sink: Captured[] = [];
    socketService.attach(fakeIo(sink));

    socketService.emitConversationUpdated('tenant-9', 'conv-7');

    assert.equal(sink.length, 1);
    assert.equal(sink[0].room, 'tenant:tenant-9', 'room naming is the adapter/emitter contract');
    assert.equal(sink[0].event, 'conversation_updated');
    assert.deepEqual(sink[0].payload, { conversationId: 'conv-7' });
    assert.equal(getSocketEmitDiagnostics().droppedTotal, 0, 'attached emits are never counted');
  });

  it('normalizes Date values to ISO strings so JSON and msgpack transports agree', () => {
    const sink: Captured[] = [];
    socketService.attach(fakeIo(sink));

    socketService.emitNewMessage('tenant-1', messageRow());

    const payload = sink[0].payload as { message: Record<string, unknown> };
    assert.equal(
      payload.message.created_at,
      '2026-07-18T10:20:30.000Z',
      'pg returns timestamptz as a Date; msgpack has no Date type, so normalize before transport',
    );
    assert.equal(typeof payload.message.created_at, 'string');
  });

  it('normalizes nested and array-held Dates', () => {
    const sink: Captured[] = [];
    socketService.attach(fakeIo(sink));

    const order = {
      id: 'order-1',
      created_at: new Date('2026-01-02T03:04:05.000Z'),
      items: [{ shipped_at: new Date('2026-01-03T00:00:00.000Z') }],
    } as unknown as Order;
    socketService.emitOrderCreated('tenant-1', order);

    const payload = sink[0].payload as {
      order: { created_at: unknown; items: Array<{ shipped_at: unknown }> };
    };
    assert.equal(payload.order.created_at, '2026-01-02T03:04:05.000Z');
    assert.equal(payload.order.items[0].shipped_at, '2026-01-03T00:00:00.000Z');
  });

  it('leaves non-Date values structurally untouched', () => {
    const sink: Captured[] = [];
    socketService.attach(fakeIo(sink));

    socketService.emitMessageSendFailed('tenant-1', {
      messageId: 'm1',
      conversationId: 'c1',
      error: 'rate limited',
    });

    assert.deepEqual(sink[0].payload, {
      messageId: 'm1',
      conversationId: 'c1',
      error: 'rate limited',
    });
  });

  it('carries replyTo through emitNewMessage when provided', () => {
    const sink: Captured[] = [];
    socketService.attach(fakeIo(sink));

    socketService.emitNewMessage('tenant-1', messageRow(), {
      id: 'msg-0',
      content: 'quoted',
    } as never);

    const payload = sink[0].payload as { message: Record<string, unknown>; conversationId: string };
    assert.equal(payload.conversationId, 'conv-1');
    assert.deepEqual(payload.message.replyTo, { id: 'msg-0', content: 'quoted' });
  });
});
