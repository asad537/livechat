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
}

export function createPresence(): PresenceStore {
  const agents = new Map<string, Set<string>>();
  const away = new Set<string>(); // userIds who set themselves Away
  const visitors = new Map<string, Map<string, { sockets: Set<string>; page: string | null }>>();
  const visitorIndex = new Map<string, string>(); // visitorId → websiteId

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
      const entry = site.get(visitorId) ?? { sockets: new Set<string>(), page: null };
      const cameOnline = entry.sockets.size === 0;
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
      if (entry.sockets.size === 0) {
        site.delete(visitorId);
        visitorIndex.delete(visitorId);
        return true;
      }
      return false;
    },
    isVisitorOnline(visitorId) {
      const websiteId = visitorIndex.get(visitorId);
      if (!websiteId) return false;
      return (visitors.get(websiteId)?.get(visitorId)?.sockets.size ?? 0) > 0;
    },
    onlineVisitors(websiteId) {
      const site = visitors.get(websiteId);
      if (!site) return [];
      return [...site.entries()].map(([visitorId, e]) => ({ visitorId, page: e.page }));
    },
  };
}
