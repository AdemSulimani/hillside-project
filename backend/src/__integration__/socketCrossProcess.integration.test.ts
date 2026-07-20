/**
 * P3-2 audit fix — the cross-process Socket.IO seam, proven on real Redis.
 *
 * In split topology a WORKER process emits through `@socket.io/redis-emitter` and the API's
 * `@socket.io/redis-adapter` fans the packet out to connected browsers. That contract is pure
 * wire-format compatibility (channel prefix + msgpack payload) between two packages that only
 * meet inside Redis — `socketEmitSeam.test.ts` exercises the seam with local fakes, and the CI
 * split-topology job never connects a socket client, so before this test nothing would catch a
 * dependency bump changing the channel prefix. That failure is silent: every worker emit is
 * published to a channel nobody subscribes to, and inboxes simply stop updating in split mode.
 *
 * Run with `npm run test:integration` (needs REDIS_URL, default the dev Redis).
 */
import 'dotenv/config';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Emitter } from '@socket.io/redis-emitter';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const ROOM = `tenant:socket-seam-test-${process.pid}`;

describe('cross-process Socket.IO emit (real Redis)', () => {
  let pub: Redis;
  let sub: Redis;
  let emitterClient: Redis;
  let httpServer: HttpServer;
  let io: Server;
  let client: ClientSocket;

  before(async () => {
    pub = new Redis(REDIS_URL);
    sub = new Redis(REDIS_URL);
    emitterClient = new Redis(REDIS_URL);

    // The "API process": a Socket.IO server whose adapter subscribes on Redis, exactly as
    // sockets/index.ts installs it.
    httpServer = createServer();
    io = new Server(httpServer, { adapter: createAdapter(pub, sub) });
    io.on('connection', (socket) => void socket.join(ROOM));
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

    const port = (httpServer.address() as AddressInfo).port;
    client = ioc(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('connect_error', reject);
    });
    // `join` above races the emit below: wait until the server socket is actually in the room.
    await io.in(ROOM).fetchSockets().then(async (sockets) => {
      for (let i = 0; sockets.length === 0 && i < 50; i++) {
        await new Promise((r) => setTimeout(r, 20));
        sockets = await io.in(ROOM).fetchSockets();
      }
      assert.ok(sockets.length > 0, 'client socket never joined the room');
    });
  });

  after(async () => {
    client?.disconnect();
    await io?.close();
    pub?.disconnect();
    sub?.disconnect();
    emitterClient?.disconnect();
  });

  it("a worker-side Emitter publish reaches a client connected to the adapter-backed server", async () => {
    // The "worker process": no Socket.IO server, just the emitter over its own Redis connection —
    // the exact shape socketPublisher.ts uses.
    //
    // The emit is RETRIED on an interval rather than fired once: Redis pub/sub has no replay, so
    // a single publish that lands before the adapter's broadcast PSUBSCRIBE is confirmed is lost
    // forever — a pure startup race that only bites on cold CI runners (the first CI run of this
    // suite timed out here while the same suite passed locally all day). Retrying removes the
    // timing sensitivity WITHOUT weakening the seam assertion: if the two packages genuinely
    // disagree on channel prefix or payload encoding, no retry ever arrives and the test still
    // fails with the same diagnosis.
    const emitter = new Emitter(emitterClient);
    const payload = await new Promise<unknown>((resolve, reject) => {
      const send = () =>
        emitter.to(ROOM).emit('new_message', { conversation_id: 'conv-seam-1', body: 'ping' });
      const retry = setInterval(send, 300);
      const timer = setTimeout(() => {
        clearInterval(retry);
        reject(
          new Error(
            'emitter packet never arrived — the redis-emitter and redis-adapter no longer agree ' +
              'on the channel prefix or payload encoding (check both package versions)',
          ),
        );
      }, 10_000);
      client.once('new_message', (p: unknown) => {
        clearInterval(retry); // stop first so no straggler emits leak into the next test
        clearTimeout(timer);
        resolve(p);
      });
      send();
    });

    const typed = payload as { conversation_id: string; body: string };
    assert.equal(typed.conversation_id, 'conv-seam-1');
    assert.equal(typed.body, 'ping');
  });

  it('an emit to a DIFFERENT room does not leak into this tenant room', async () => {
    // Guarded against vacuity: a dead fan-out would deliver nothing and make a bare "no leak"
    // assertion pass for the wrong reason (exactly what the first CI failure produced). So this
    // test emits BOTH an other-room payload and a same-room canary, and passes only when the
    // canary arrives while the other-room payload does not — isolation proven on a live seam.
    // Payload-filtered, so a late retry straggler from the previous test cannot count as a leak.
    let leaked = false;
    const canaryArrived = new Promise<void>((resolve) => {
      const listener = (p: { body?: string }) => {
        if (p?.body === 'other') leaked = true;
        if (p?.body === 'canary') resolve();
      };
      client.on('new_message', listener);
    });

    const emitter = new Emitter(emitterClient);
    const send = () => {
      emitter.to('tenant:some-other-tenant').emit('new_message', { body: 'other' });
      emitter.to(ROOM).emit('new_message', { body: 'canary' });
    };
    const retry = setInterval(send, 300);
    send();
    try {
      await Promise.race([
        canaryArrived,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('same-room canary never arrived — fan-out is dead')), 10_000),
        ),
      ]);
    } finally {
      clearInterval(retry);
    }
    // The other-room emit was published before each canary on the same connection; Redis pub/sub
    // preserves per-connection ordering, so once a canary arrived, any leak would already be here.
    client.removeAllListeners('new_message');
    assert.equal(leaked, false, 'tenant room isolation must hold across the Redis fan-out');
  });
});
