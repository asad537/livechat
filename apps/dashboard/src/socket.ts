import { io, Socket } from 'socket.io-client';
import { AGENT_NAMESPACE } from '@livechat/shared';

/**
 * Singleton Socket.IO connection to the `/agent` namespace.
 * The Vite dev server proxies `/socket.io` to the backend on :4000.
 */
let socket: Socket | null = null;

export function connectSocket(token: string): Socket {
  if (socket) return socket;
  socket = io(AGENT_NAMESPACE, {
    auth: { token },
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
  });
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function requireSocket(): Socket {
  if (!socket) throw new Error('Socket not connected');
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}
