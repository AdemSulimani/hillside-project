import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import IORedis from 'ioredis';
import { verifyAccessToken } from '../services/tokenService';
import { socketService } from '../services/socketService';

const frontendOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';

let io: Server | null = null;

export function getSocketServer(): Server {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
}

function extractHandshakeToken(auth: unknown): string | null {
  if (!auth || typeof auth !== 'object') return null;
  const token = (auth as { token?: unknown }).token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export function initSocketServer(httpServer: HttpServer): void {
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const pubClient = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const subClient = pubClient.duplicate();

  io = new Server(httpServer, {
    cors: {
      origin: frontendOrigin,
      credentials: true,
      methods: ['GET', 'POST'],
    },
  });

  io.adapter(createAdapter(pubClient, subClient));
  socketService.attach(io);

  io.use((socket, next) => {
    const token = extractHandshakeToken(socket.handshake.auth);
    if (!token) {
      next(new Error('Authentication required'));
      return;
    }

    try {
      const payload = verifyAccessToken(token);
      if (!payload.tenantId) {
        next(new Error('Tenant context required'));
        return;
      }
      socket.data.tenantId = payload.tenantId;
      socket.data.userId = payload.userId;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const tenantId = socket.data.tenantId as string | undefined;
    if (!tenantId) {
      socket.disconnect(true);
      return;
    }
    void socket.join(`tenant:${tenantId}`);
  });
}
