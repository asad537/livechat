import { io, Socket } from 'socket.io-client';
import { AGENT_NAMESPACE } from '@livechat/shared';

/**
 * Singleton Socket.IO connection to the `/agent` namespace.
 * The Vite dev server proxies `/socket.io` to the backend on :4000.
 */
let socket: Socket | null = null;

export function connectSocket(token: string): Socket {
  if (socket) {
    // The singleton may have been created with a token that has since been
    // replaced (e.g. a stale token bounced us to /login and the user signed in
    // again). Socket.IO snapshots `auth` per handshake, so refresh it and kick
    // a reconnect — otherwise every retry re-sends the dead token and the app
    // sits on "Reconnecting…" until a full page refresh.
    (socket.auth as { token?: string }).token = token;
    if (!socket.connected) socket.connect();
    return socket;
  }
  socket = io(AGENT_NAMESPACE, {
    auth: { token },
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
    // Prefer WebSocket — polling adds up to 25 s of delay to every event.
    // We still list polling as a fallback so hostile networks (proxies /
    // corporate firewalls that block WS upgrade) can degrade gracefully.
    transports: ['websocket', 'polling'],
    upgrade: true,
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
