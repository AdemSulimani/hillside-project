import { io, type Socket } from 'socket.io-client';

/**
 * Socket.io expects an HTTP(S) origin (it negotiates the WebSocket upgrade).
 * `.env` may use `ws://` — normalize so the client connects reliably.
 */
function resolveSocketUrl(): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicit) {
    if (explicit.startsWith('ws://')) return `http://${explicit.slice('ws://'.length)}`;
    if (explicit.startsWith('wss://')) return `https://${explicit.slice('wss://'.length)}`;
    return explicit;
  }

  const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';
  return apiBase.replace(/\/api\/?$/, '') || 'http://localhost:8000';
}

/**
 * Creates a Socket.io client for inbox realtime events (not connected until `.connect()`).
 */
export function createInboxSocket(accessToken: string): Socket {
  return io(resolveSocketUrl(), {
    auth: { token: accessToken },
    withCredentials: true,
    autoConnect: false,
  });
}
