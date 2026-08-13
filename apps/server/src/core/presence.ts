/**
 * Presence store — who is online right now.
 * In-memory implementation (single node). With REDIS_URL set, Socket.IO uses the
 * Redis adapter for cross-node event fan-out (wired in index.ts); a Redis-backed
 * PresenceStore can be swapped in here for multi-node presence.
 */
export interface VisitorPresence {
  visitorId: string;
  page: string | null;
}

export interface PresenceStore {
  addAgent(userId: string, socketId: string): boolean;            // true = came online
  removeAgent(userId: string, socketId: string): boolean;         // true = went offline
  isAgentOnline(userId: string): boolean;
  onlineAgentIds(): string[];
  setAgentAway(userId: string, away: boolean): void;              // manual availability
  isAgentAway(userId: string): boolean;
  isAgentAvailable(userId: string): boolean;                      // online AND not away

  addVisitor(websiteId: string, visitorId: string, socketId: string, page?: string | null): boolean;
  removeVisitor(websiteId: string, visitorId: string, socketId: string): boolean;
  isVisitorOnline(visitorId: string): boolean;
  onlineVisitors(websiteId: string): VisitorPresence[];
  /** Fired when a visitor REALLY goes offline (after the reconnect grace). */
  setVisitorOfflineListener(cb: (websiteId: string, visitorId: string) => void): void;

  /**
   * Idle tracking: a tab reports itself idle (backgrounded / no activity) or
   * active again. A visitor is idle when EVERY connected tab is idle — they
   * stay connected (messages still arrive) but drop out of "Online now".
   * Returns { changed, idleMs }: changed = the visitor's overall idle state
   * flipped; idleMs = how long they had been idle (on the idle→active flip).
   */
  setVisitorSocketIdle(
    websiteId: string,
    visitorId: string,
    socketId: string,
    idle: boolean,
  ): { changed: boolean; idleMs: number };
  isVisitorIdle(visitorId: string): boolean;
}

// Page reloads / navigation close the widget socket for a moment — keep the
// visitor "online" just long enough to cover that reconnect (1-2s typical)
// so they don't flicker into Recently Active. Kept tiny on purpose: closing
// the site should read offline near-instantly.
const VISITOR_OFFLINE_GRACE_MS = 5_000;

export function createPresence(): PresenceStore {
  const agents = new Map<string, Set<string>>();
  const away = new Set<string>(); // userIds who set themselves Away
  const visitors = new Map<
    string,
    Map<
      string,
      {
        sockets: Set<string>;
        idleSockets: Set<string>;
        idleSince: number | null;
        page: string | null;
        linger: NodeJS.Timeout | null;
      }
    >
  >();
  const visitorIndex = new Map<string, string>(); // visitorId → websiteId
  let offlineListener: ((websiteId: string, visitorId: string) => void) | null = null;

  return {
    addAgent(userId, socketId) {
      const set = agents.get(userId) ?? new Set<string>();
      const cameOnline = set.size === 0;
      set.add(socketId);
      agents.set(userId, set);
      return cameOnline;
    },
    removeAgent(userId, socketId) {
      const set = agents.get(userId);
      if (!set) return false;
      set.delete(socketId);
      if (set.size === 0) {
        agents.delete(userId);
        return true;
      }
      return false;
    },
    isAgentOnline(userId) {
      return (agents.get(userId)?.size ?? 0) > 0;
    },
    onlineAgentIds() {
      return [...agents.keys()];
    },
    setAgentAway(userId, isAway) {
      if (isAway) away.add(userId);
      else away.delete(userId);
    },
    isAgentAway(userId) {
      return away.has(userId);
    },
    isAgentAvailable(userId) {
      return (agents.get(userId)?.size ?? 0) > 0 && !away.has(userId);
    },

    addVisitor(websiteId, visitorId, socketId, page = null) {
      const site = visitors.get(websiteId) ?? new Map();
      const entry =
        site.get(visitorId) ??
        {
          sockets: new Set<string>(),
          idleSockets: new Set<string>(),
          idleSince: null,
          page: null,
          linger: null,
        };
      // A fresh tab is active by definition → the visitor is no longer idle.
      entry.idleSockets.delete(socketId);
      entry.idleSince = null;
      // Reconnected within the grace window → still the same online session,
      // so this does NOT count as "came online" (no duplicate knock sounds).
      const wasLingering = entry.linger !== null;
      if (entry.linger) {
        clearTimeout(entry.linger);
        entry.linger = null;
      }
      const cameOnline = entry.sockets.size === 0 && !wasLingering;
      entry.sockets.add(socketId);
      if (page) entry.page = page;
      site.set(visitorId, entry);
      visitors.set(websiteId, site);
      visitorIndex.set(visitorId, websiteId);
      return cameOnline;
    },
    removeVisitor(websiteId, visitorId, socketId) {
      const site = visitors.get(websiteId);
      const entry = site?.get(visitorId);
      if (!site || !entry) return false;
      entry.sockets.delete(socketId);
      entry.idleSockets.delete(socketId);
      if (entry.sockets.size === 0 && !entry.linger) {
        // Last socket gone — keep them online for the grace period; a page
        // reload/navigation reconnects long before it expires.
        entry.linger = setTimeout(() => {
          const s = visitors.get(websiteId);
          const e = s?.get(visitorId);
          // The timer has fired — it must never block a future linger.
          if (e) e.linger = null;
          if (!s || !e || e.sockets.size > 0) return;
          s.delete(visitorId);
          visitorIndex.delete(visitorId);
          offlineListener?.(websiteId, visitorId);
        }, VISITOR_OFFLINE_GRACE_MS);
        entry.linger.unref?.();
      }
      return false; // never "instantly offline" — the linger timer decides
    },
    isVisitorOnline(visitorId) {
      const websiteId = visitorIndex.get(visitorId);
      if (!websiteId) return false;
      const entry = visitors.get(websiteId)?.get(visitorId);
      if (!entry) return false;
      return entry.sockets.size > 0 || entry.linger !== null; // lingering = still online
    },
    onlineVisitors(websiteId) {
      const site = visitors.get(websiteId);
      if (!site) return [];
      // Idle visitors (every tab idle) are hidden from the live list — they're
      // still connected (chat keeps working) but not "online now".
      return [...site.entries()]
        .filter(([, e]) => e.idleSince === null)
        .map(([visitorId, e]) => ({ visitorId, page: e.page }));
    },
    setVisitorOfflineListener(cb) {
      offlineListener = cb;
    },

    setVisitorSocketIdle(websiteId, visitorId, socketId, idle) {
      const entry = visitors.get(websiteId)?.get(visitorId);
      if (!entry || !entry.sockets.has(socketId)) return { changed: false, idleMs: 0 };
      const wasIdle = entry.idleSince !== null;
      if (idle) entry.idleSockets.add(socketId);
      else entry.idleSockets.delete(socketId);
      const nowIdle = entry.sockets.size > 0 && entry.idleSockets.size >= entry.sockets.size;
      if (nowIdle && !wasIdle) {
        entry.idleSince = Date.now();
        return { changed: true, idleMs: 0 };
      }
      if (!nowIdle && wasIdle) {
        const idleMs = Date.now() - (entry.idleSince ?? Date.now());
        entry.idleSince = null;
        return { changed: true, idleMs };
      }
      return { changed: false, idleMs: 0 };
    },
    isVisitorIdle(visitorId) {
      const websiteId = visitorIndex.get(visitorId);
      if (!websiteId) return false;
      return (visitors.get(websiteId)?.get(visitorId)?.idleSince ?? null) !== null;
    },
  };
}
