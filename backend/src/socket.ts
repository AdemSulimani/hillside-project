import type { Server } from 'http';

let io: any = null;

/** Initializes Socket.io — full implementation in Step 11 */
export function initIO(_server: Server): void {
  // Will be implemented in Step 11
}

export function getIO(): any {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
}
