import { Router } from 'express';
import type { AgentDirectMessage, AgentDirectThread } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { requireAgent } from '../../core/auth.js';
import { HttpError, agent, asString, h, placeholders } from '../helpers.js';

interface DMRow {
  id: string;
  from_user_id: string;
  to_user_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

function rowToDM(r: DMRow): AgentDirectMessage {
  return {
    id: r.id,
    fromUserId: r.from_user_id,
    toUserId: r.to_user_id,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

/** Internal team chat — agent-to-agent DMs (never leaves the /agent namespace). */
export function buildAgentDMRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  // GET /api/agent-dm/threads — one row per peer with last message + unread count.
  router.get(
    '/api/agent-dm/threads',
    auth,
    h(async (req, res) => {
      const me = agent(req);
      // All DMs I've participated in, most-recent first — grouped by peer.
      const rows = await deps.db.all<DMRow>(
        `SELECT * FROM agent_messages
          WHERE from_user_id = ? OR to_user_id = ?
          ORDER BY created_at DESC
          LIMIT 500`,
        [me.id, me.id],
      );
      const byPeer = new Map<string, { last: DMRow; unread: number }>();
      for (const r of rows) {
        const peer = r.from_user_id === me.id ? r.to_user_id : r.from_user_id;
        const entry = byPeer.get(peer);
        if (!entry) byPeer.set(peer, { last: r, unread: 0 });
        // Count unread: messages TO me that I haven't marked read.
        if (r.to_user_id === me.id && r.read_at == null) {
          const cur = byPeer.get(peer)!;
          cur.unread += 1;
        }
      }
      const peerIds = [...byPeer.keys()];
      if (peerIds.length === 0) {
        res.json({ threads: [] as AgentDirectThread[] });
        return;
      }
      const users = await deps.db.all<{ id: string; name: string; avatar_color: string | null }>(
        `SELECT id, name, avatar_color FROM users WHERE id IN (${placeholders(peerIds.length)})`,
        peerIds,
      );
      const nameById = new Map(users.map((u) => [u.id, u]));
      const threads: AgentDirectThread[] = [...byPeer.entries()]
        .map(([peerId, { last, unread }]) => {
          const u = nameById.get(peerId);
          return {
            peerUserId: peerId,
            peerName: u?.name ?? 'Unknown',
            peerAvatarColor: u?.avatar_color ?? null,
            lastMessage: rowToDM(last),
            unread,
          };
        })
        .sort((a, b) => {
          const ta = a.lastMessage?.createdAt ?? '';
          const tb = b.lastMessage?.createdAt ?? '';
          return ta < tb ? 1 : -1;
        });
      res.json({ threads });
    }),
  );

  // GET /api/agent-dm/messages?peerId=…&limit=… — chat history with one peer.
  router.get(
    '/api/agent-dm/messages',
    auth,
    h(async (req, res) => {
      const me = agent(req);
      const peerId = asString(req.query.peerId);
      if (!peerId) throw new HttpError(400, 'peerId is required');
      const limit = Math.min(500, Math.max(1, Number(asString(req.query.limit)) || 200));
      const rows = await deps.db.all<DMRow>(
        `SELECT * FROM (
           SELECT * FROM agent_messages
            WHERE (from_user_id = ? AND to_user_id = ?)
               OR (from_user_id = ? AND to_user_id = ?)
            ORDER BY created_at DESC
            LIMIT ?
         ) t
         ORDER BY created_at ASC`,
        [me.id, peerId, peerId, me.id, limit],
      );
      res.json({ messages: rows.map(rowToDM) });
    }),
  );

  return router;
}
