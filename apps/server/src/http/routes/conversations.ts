import { Router } from 'express';
import {
  API,
  type AssignmentRecord,
  type ConversationStatus,
  type ConversationSummary,
} from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { requireAgent, toUserPublic, type UserRow } from '../../core/auth.js';
import { loadSummaries, loadSummary, userCanAccessWebsite } from '../../domain/conversations.js';
import { hydrateMessages, type MessageRow } from '../../domain/messages.js';
import {
  HttpError,
  accessibleWebsiteRows,
  agent,
  asString,
  canViewConversation,
  getConversationRow,
  h,
  myCsrIds,
  placeholders,
  visitorNumberSql,
} from '../helpers.js';

const STATUSES: ConversationStatus[] = ['WAITING', 'OFFERED', 'ACTIVE', 'CLOSED', 'MISSED'];

type Scope = 'mine' | 'team' | 'all';

/** Clamp the requested scope to what the role allows (CSR→mine, LEAD≤team, ADMIN/MANAGER any). */
function effectiveScope(role: UserRow['role'], requested: string | undefined): Scope {
  if (role === 'CSR') return 'mine';
  if (role === 'LEAD') return requested === 'mine' ? 'mine' : 'team';
  if (role === 'MANAGER') return 'all'; // global view-only
  if (requested === 'mine' || requested === 'team') return requested;
  return 'all';
}

interface AssignmentHistoryRow {
  id: string;
  conversation_id: string;
  from_user_id: string | null;
  to_user_id: string;
  reason: string;
  created_at: string;
}

export function buildConversationsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  // GET /api/conversations/search?q= — visitor name/email + message content
  router.get(
    `${API.conversations}/search`,
    auth,
    h(async (req, res) => {
      const user = agent(req);
      // %/_ are LIKE wildcards — neutralize instead of dialect-specific ESCAPE.
      const q = (asString(req.query.q) ?? '').trim().replace(/[%_\\]/g, ' ').trim();
      if (q.length < 2) {
        res.json([]);
        return;
      }
      const like = `%${q}%`;

      const where: string[] = [];
      const params: unknown[] = [];
      if (user.role !== 'ADMIN' && user.role !== 'MANAGER') {
        const siteIds = (await accessibleWebsiteRows(deps, user)).map((w) => w.id);
        if (siteIds.length === 0) {
          res.json([]);
          return;
        }
        if (user.role === 'CSR') {
          // Own chats + the unassigned queue of accessible sites.
          where.push(
            `(c.assigned_user_id = ? OR (c.assigned_user_id IS NULL
               AND c.website_id IN (${placeholders(siteIds.length)})))`,
          );
          params.push(user.id, ...siteIds);
        } else if (user.role === 'LEAD') {
          // Own + own CSRs' chats + unassigned queue of accessible sites.
          const csrIds = await myCsrIds(deps, user.id);
          const mine = [user.id, ...csrIds];
          where.push(
            `(c.assigned_user_id IN (${placeholders(mine.length)})
               OR (c.assigned_user_id IS NULL
                   AND c.website_id IN (${placeholders(siteIds.length)})))`,
          );
          params.push(...mine, ...siteIds);
        } else {
          where.push(`c.website_id IN (${placeholders(siteIds.length)})`);
          params.push(...siteIds);
        }
      }
      where.push(
        `(v.name LIKE ? OR v.email LIKE ? OR ${visitorNumberSql('v.id')} LIKE ? OR EXISTS (
            SELECT 1 FROM messages m
             WHERE m.conversation_id = c.id AND m.body LIKE ?))`,
      );
      params.push(like, like, like, like);

      const rows = await deps.db.all<{ id: string }>(
        `SELECT c.id FROM conversations c
           JOIN visitors v ON v.id = c.visitor_id
          WHERE ${where.join(' AND ')}
          ORDER BY c.created_at DESC
          LIMIT 20`,
        params,
      );
      res.json(await loadSummaries(deps, rows.map((r) => r.id)));
    }),
  );

  // GET /api/conversations?websiteId=&status=&scope=mine|team|all
  router.get(
    API.conversations,
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const scope = effectiveScope(user.role, asString(req.query.scope));

      const websiteId = asString(req.query.websiteId);
      if (websiteId && !(await userCanAccessWebsite(deps, user.id, user.role, websiteId))) {
        throw new HttpError(403, 'Forbidden');
      }
      const status = asString(req.query.status);
      if (status && !STATUSES.includes(status as ConversationStatus)) {
        throw new HttpError(400, 'Invalid status');
      }

      const where: string[] = [];
      const params: unknown[] = [];

      if (scope !== 'all') {
        const siteIds = (await accessibleWebsiteRows(deps, user)).map((w) => w.id);
        if (scope === 'mine') {
          if (user.role === 'CSR') {
            // Mine + the unassigned queue of my sites.
            if (siteIds.length > 0) {
              where.push(
                `(c.assigned_user_id = ? OR (c.assigned_user_id IS NULL
                   AND c.status IN ('WAITING', 'OFFERED')
                   AND c.website_id IN (${placeholders(siteIds.length)})))`,
              );
              params.push(user.id, ...siteIds);
            } else {
              where.push('c.assigned_user_id = ?');
              params.push(user.id);
            }
          } else {
            where.push('c.assigned_user_id = ?');
            params.push(user.id);
          }
        } else {
          // team scope (LEAD, or ADMIN narrowing to team-style view)
          if (user.role === 'ADMIN') {
            // ADMIN has no team; team scope degrades to all.
          } else if (user.role === 'LEAD') {
            // Team Lead: own chats + own CSRs' chats + the unassigned
            // queue of accessible sites (to claim by typing).
            const csrIds = await myCsrIds(deps, user.id);
            const mine = [user.id, ...csrIds];
            if (siteIds.length > 0) {
              where.push(
                `(c.assigned_user_id IN (${placeholders(mine.length)})
                   OR (c.assigned_user_id IS NULL
                       AND c.website_id IN (${placeholders(siteIds.length)})))`,
              );
              params.push(...mine, ...siteIds);
            } else {
              where.push(`c.assigned_user_id IN (${placeholders(mine.length)})`);
              params.push(...mine);
            }
          } else if (siteIds.length === 0) {
            res.json([]);
            return;
          } else {
            where.push(`c.website_id IN (${placeholders(siteIds.length)})`);
            params.push(...siteIds);
          }
        }
      }

      if (websiteId) {
        where.push('c.website_id = ?');
        params.push(websiteId);
      }
      if (status) {
        where.push('c.status = ?');
        params.push(status);
      }

      const sql = `SELECT c.id FROM conversations c
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.created_at DESC
        LIMIT 200`;
      const rows = await deps.db.all<{ id: string }>(sql, params);
      res.json(await loadSummaries(deps, rows.map((r) => r.id)));
    }),
  );

  // GET /api/chats/history — paginated finished-chat archive with filters.
  // Role-scoped: ADMIN/MANAGER all · LEAD self+own CSRs · CSR own only.
  router.get(
    '/api/chats/history',
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const page = Math.max(1, Number(asString(req.query.page)) || 1);
      const PER_PAGE = 20;

      const where: string[] = [];
      const params: unknown[] = [];

      // Website scope
      const siteIds = (await accessibleWebsiteRows(deps, user)).map((w) => w.id);
      const websiteId = asString(req.query.websiteId);
      if (websiteId) {
        if (user.role !== 'ADMIN' && user.role !== 'MANAGER' && !siteIds.includes(websiteId)) {
          throw new HttpError(403, 'Forbidden');
        }
        where.push('c.website_id = ?');
        params.push(websiteId);
      } else if (user.role !== 'ADMIN' && user.role !== 'MANAGER') {
        if (siteIds.length === 0) {
          res.json({ chats: [], total: 0, page: 1, pages: 1 });
          return;
        }
        where.push(`c.website_id IN (${placeholders(siteIds.length)})`);
        params.push(...siteIds);
      }

      // People scope
      if (user.role === 'CSR') {
        where.push('c.assigned_user_id = ?');
        params.push(user.id);
      } else if (user.role === 'LEAD') {
        const mine = [user.id, ...(await myCsrIds(deps, user.id))];
        where.push(
          `(c.assigned_user_id IN (${placeholders(mine.length)}) OR c.assigned_user_id IS NULL)`,
        );
        params.push(...mine);
      }

      // Queries view: only chats whose visitor shared a name or email —
      // restricted to ADMIN/MANAGER.
      const contactOnly = asString(req.query.contact) === '1';
      if (contactOnly) {
        if (user.role !== 'ADMIN' && user.role !== 'MANAGER') throw new HttpError(403, 'Forbidden');
        where.push("(NULLIF(v.name, '') IS NOT NULL OR NULLIF(v.email, '') IS NOT NULL)");
      }

      // Filters
      const status = asString(req.query.status);
      if (status && STATUSES.includes(status as ConversationStatus)) {
        where.push('c.status = ?');
        params.push(status);
      } else if (status !== 'ALL') {
        // History defaults to finished chats.
        where.push("c.status IN ('CLOSED', 'MISSED')");
      }
      const agentId = asString(req.query.agentId);
      if (agentId) {
        if (user.role === 'CSR' && agentId !== user.id) throw new HttpError(403, 'Forbidden');
        if (user.role === 'LEAD') {
          const mine = [user.id, ...(await myCsrIds(deps, user.id))];
          if (!mine.includes(agentId)) throw new HttpError(403, 'Forbidden');
        }
        where.push('c.assigned_user_id = ?');
        params.push(agentId);
      }
      // "CSR didn't reply" — chats where the CSR sent no agent message (whether
      // or not the client wrote). Tied to the agent when one is filtered, else
      // any chat with no agent reply at all.
      const noReply = asString(req.query.noReply) === '1' || asString(req.query.noReply) === 'true';
      if (noReply) {
        if (agentId) {
          where.push(
            "NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.sender_type = 'AGENT' AND m.sender_user_id = ?)",
          );
          params.push(agentId);
        } else {
          where.push(
            "NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.sender_type = 'AGENT')",
          );
        }
      }
      const from = asString(req.query.from);
      if (from) {
        where.push('c.created_at >= ?');
        params.push(new Date(`${from}T00:00:00`).toISOString()); // server-local midnight, matches the dashboard range
      }
      const to = asString(req.query.to);
      if (to) {
        where.push('c.created_at <= ?');
        params.push(new Date(`${to}T23:59:59.999`).toISOString());
      }
      const q = (asString(req.query.q) ?? '').trim().replace(/[%_\\]/g, ' ').trim();
      if (q.length >= 2) {
        where.push(`(v.name LIKE ? OR v.email LIKE ? OR ${visitorNumberSql('v.id')} LIKE ?)`);
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const totalRow = await deps.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM conversations c JOIN visitors v ON v.id = c.visitor_id ${whereSql}`,
        params,
      );
      const total = Number(totalRow?.n ?? 0);
      const pages = Math.max(1, Math.ceil(total / PER_PAGE));

      const rows = await deps.db.all<{
        id: string;
        status: string;
        created_at: string;
        activated_at: string | null;
        closed_at: string | null;
        rating: number | null;
        website_id: string;
        website_name: string;
        website_color: string;
        agent_name: string | null;
        visitor_id: string;
        visitor_name: string | null;
        visitor_email: string | null;
        msgs: number;
      }>(
        `SELECT c.id, c.status, c.created_at, c.activated_at, c.closed_at, c.rating,
                c.website_id, COALESCE(NULLIF(w.label, ''), w.name) AS website_name, w.primary_color AS website_color,
                u.name AS agent_name,
                v.id AS visitor_id, v.name AS visitor_name, v.email AS visitor_email,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msgs
           FROM conversations c
           JOIN visitors v ON v.id = c.visitor_id
           JOIN websites w ON w.id = c.website_id
           LEFT JOIN users u ON u.id = c.assigned_user_id
          ${whereSql}
          ORDER BY c.created_at DESC
          LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`,
        params,
      );

      res.json({
        chats: rows.map((r) => ({
          id: r.id,
          status: r.status,
          createdAt: r.created_at,
          closedAt: r.closed_at,
          durationSeconds:
            r.activated_at && r.closed_at
              ? Math.max(0, Math.round((Date.parse(r.closed_at) - Date.parse(r.activated_at)) / 1000))
              : null,
          rating: r.rating === null || r.rating === undefined ? null : Number(r.rating),
          websiteId: r.website_id,
          website: r.website_name,
          websiteColor: r.website_color,
          agent: r.agent_name,
          visitorId: r.visitor_id,
          visitor: r.visitor_name || r.visitor_email || null,
          visitorEmail: r.visitor_email,
          messages: Number(r.msgs),
        })),
        total,
        page,
        pages,
      });
    }),
  );

  // GET /api/chats/transfers — paginated list of transfer events (chats that
  // were handed from one agent to another). Role-scoped:
  //   ADMIN/MANAGER → all · LEAD → transfers involving self/own CSRs · CSR → own.
  router.get(
    '/api/chats/transfers',
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const page = Math.max(1, Number(asString(req.query.page)) || 1);
      const PER_PAGE = 20;

      const where: string[] = ["h.reason = 'TRANSFER'"];
      const params: unknown[] = [];

      // Website scope
      const siteIds = (await accessibleWebsiteRows(deps, user)).map((w) => w.id);
      const websiteId = asString(req.query.websiteId);
      if (websiteId) {
        if (user.role !== 'ADMIN' && user.role !== 'MANAGER' && !siteIds.includes(websiteId)) {
          throw new HttpError(403, 'Forbidden');
        }
        where.push('c.website_id = ?');
        params.push(websiteId);
      } else if (user.role !== 'ADMIN' && user.role !== 'MANAGER') {
        if (siteIds.length === 0) {
          res.json({ transfers: [], total: 0, page: 1, pages: 1 });
          return;
        }
        where.push(`c.website_id IN (${placeholders(siteIds.length)})`);
        params.push(...siteIds);
      }

      // People scope — a transfer counts if the user (or their CSR) was either
      // the giver or the receiver.
      if (user.role === 'CSR') {
        where.push('(h.from_user_id = ? OR h.to_user_id = ?)');
        params.push(user.id, user.id);
      } else if (user.role === 'LEAD') {
        const mine = [user.id, ...(await myCsrIds(deps, user.id))];
        where.push(
          `(h.from_user_id IN (${placeholders(mine.length)}) OR h.to_user_id IN (${placeholders(mine.length)}))`,
        );
        params.push(...mine, ...mine);
      }

      // Filters
      const from = asString(req.query.from);
      if (from) {
        where.push('h.created_at >= ?');
        params.push(new Date(`${from}T00:00:00`).toISOString()); // server-local midnight, matches the dashboard range
      }
      const to = asString(req.query.to);
      if (to) {
        where.push('h.created_at <= ?');
        params.push(new Date(`${to}T23:59:59.999`).toISOString());
      }
      const q = (asString(req.query.q) ?? '').trim().replace(/[%_\\]/g, ' ').trim();
      if (q.length >= 2) {
        where.push(`(v.name LIKE ? OR v.email LIKE ? OR ${visitorNumberSql('v.id')} LIKE ?)`);
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }

      const whereSql = `WHERE ${where.join(' AND ')}`;
      const totalRow = await deps.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n
           FROM assignment_history h
           JOIN conversations c ON c.id = h.conversation_id
           JOIN visitors v ON v.id = c.visitor_id
          ${whereSql}`,
        params,
      );
      const total = Number(totalRow?.n ?? 0);
      const pages = Math.max(1, Math.ceil(total / PER_PAGE));

      const rows = await deps.db.all<{
        transfer_id: string;
        transferred_at: string;
        from_name: string | null;
        to_name: string | null;
        id: string;
        status: string;
        website_id: string;
        website_name: string;
        website_color: string;
        visitor_id: string;
        visitor_name: string | null;
        visitor_email: string | null;
      }>(
        `SELECT h.id AS transfer_id, h.created_at AS transferred_at,
                fu.name AS from_name, tu.name AS to_name,
                c.id, c.status, c.website_id,
                COALESCE(NULLIF(w.label, ''), w.name) AS website_name, w.primary_color AS website_color,
                v.id AS visitor_id, v.name AS visitor_name, v.email AS visitor_email
           FROM assignment_history h
           JOIN conversations c ON c.id = h.conversation_id
           JOIN visitors v ON v.id = c.visitor_id
           JOIN websites w ON w.id = c.website_id
           LEFT JOIN users fu ON fu.id = h.from_user_id
           LEFT JOIN users tu ON tu.id = h.to_user_id
          ${whereSql}
          ORDER BY h.created_at DESC
          LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`,
        params,
      );

      res.json({
        transfers: rows.map((r) => ({
          transferId: r.transfer_id,
          conversationId: r.id,
          status: r.status,
          transferredAt: r.transferred_at,
          from: r.from_name,
          to: r.to_name,
          websiteId: r.website_id,
          website: r.website_name,
          websiteColor: r.website_color,
          visitorId: r.visitor_id,
          visitor: r.visitor_name || r.visitor_email || null,
          visitorEmail: r.visitor_email,
        })),
        total,
        page,
        pages,
      });
    }),
  );

  // GET /api/conversations/:id/messages — hydrated ChatMessage[]
  router.get(
    `${API.conversations}/:id/messages`,
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const conv = await getConversationRow(deps, req.params.id as string);
      if (!(await canViewConversation(deps, user, conv))) throw new HttpError(403, 'Forbidden');
      const rows = await deps.db.all<MessageRow>(
        'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 500) t ORDER BY created_at ASC, id ASC',
        [conv.id],
      );
      res.json(await hydrateMessages(deps, rows));
    }),
  );

  // GET /api/conversations/:id/history — AssignmentRecord[] with user names
  router.get(
    `${API.conversations}/:id/history`,
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const conv = await getConversationRow(deps, req.params.id as string);
      if (!(await canViewConversation(deps, user, conv))) throw new HttpError(403, 'Forbidden');

      const rows = await deps.db.all<AssignmentHistoryRow>(
        'SELECT * FROM assignment_history WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
        [conv.id],
      );

      const userIds = [
        ...new Set(
          rows.flatMap((r) => [r.from_user_id, r.to_user_id]).filter((v): v is string => !!v),
        ),
      ];
      const users =
        userIds.length > 0
          ? await deps.db.all<UserRow>(
              `SELECT * FROM users WHERE id IN (${placeholders(userIds.length)})`,
              userIds,
            )
          : [];
      const byId = new Map(users.map((u) => [u.id, toUserPublic(u)]));

      const records: AssignmentRecord[] = rows.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        fromUserId: r.from_user_id ?? null,
        toUserId: r.to_user_id,
        reason: r.reason as AssignmentRecord['reason'],
        createdAt: r.created_at,
        fromUser: r.from_user_id ? (byId.get(r.from_user_id) ?? null) : null,
        toUser: byId.get(r.to_user_id) ?? null,
      }));
      res.json(records);
    }),
  );

  return router;
}
