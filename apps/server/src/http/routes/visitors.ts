// ─── Visitor module (Zendesk-style profile / CRM) ────────────
// GET    /api/visitors/:id                → full profile + session path + stats
// PATCH  /api/visitors/:id                → edit name/email/phone/notes (CRM)
// GET    /api/visitors/:id/conversations  → past chats (agent, rating, preview)
// GET    /api/conversations/:id/transcript is not needed — dashboard reuses
// the normal messages endpoint for the inline transcript viewer.
import { Router } from 'express';
import type { Role, Visitor, VisitorPage } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { requireAgent } from '../../core/auth.js';
import { userCanAccessWebsite } from '../../domain/conversations.js';
import {
  HttpError,
  accessibleWebsiteRows,
  agent,
  asString,
  h,
  placeholders,
  toVisitor,
  type VisitorRow,
} from '../helpers.js';

const MAX_PATH_ENTRIES = 50;

async function loadScopedVisitor(
  deps: AppDeps,
  req: { params: Record<string, string | undefined> },
  userId: string,
  role: Role,
): Promise<VisitorRow> {
  const id = req.params.id as string;
  const row = await deps.db.get<VisitorRow>('SELECT * FROM visitors WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, 'Visitor not found');
  if (!(await userCanAccessWebsite(deps, userId, role, row.website_id))) {
    throw new HttpError(403, 'Forbidden');
  }
  return row;
}

export function buildVisitorsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  // GET /api/visitors/history?limit=&offset=&q=&websiteId= — paginated archive.
  // Must be registered before /api/visitors/:id so "history" isn't taken as an id.
  router.get(
    '/api/visitors/history',
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const scoped = (await accessibleWebsiteRows(deps, user)).map((w) => w.id);
      const websiteId = asString(req.query.websiteId);
      let siteIds = scoped;
      if (websiteId) {
        if (!scoped.includes(websiteId)) throw new HttpError(403, 'Forbidden');
        siteIds = [websiteId];
      }
      if (siteIds.length === 0) {
        res.json({ visitors: [], total: 0, limit: 0, offset: 0 });
        return;
      }

      const limit = Math.min(50, Math.max(1, Number(asString(req.query.limit)) || 25));
      const offset = Math.max(0, Number(asString(req.query.offset)) || 0);
      const q = asString(req.query.q)?.trim().slice(0, 100).replace(/[%_\\]/g, ' ') ?? '';

      let where = `website_id IN (${placeholders(siteIds.length)})`;
      const params: unknown[] = [...siteIds];
      if (q) {
        where +=
          ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR ip LIKE ? OR geo_city LIKE ? OR geo_country LIKE ?)';
        const like = `%${q}%`;
        params.push(like, like, like, like, like, like);
      }

      const totalRow = await deps.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM visitors WHERE ${where}`,
        params,
      );
      const rows = await deps.db.all<VisitorRow>(
        `SELECT * FROM visitors WHERE ${where} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      );

      // Chats count only for the returned page — cheap.
      const chatsBy = new Map<string, number>();
      if (rows.length > 0) {
        const counts = await deps.db.all<{ visitor_id: string; n: number }>(
          `SELECT visitor_id, COUNT(*) AS n FROM conversations
            WHERE visitor_id IN (${placeholders(rows.length)}) GROUP BY visitor_id`,
          rows.map((r) => r.id),
        );
        for (const c of counts) chatsBy.set(c.visitor_id, Number(c.n));
      }

      res.json({
        visitors: rows.map((r) => ({
          ...toVisitor(r),
          online: deps.presence.isVisitorOnline(r.id),
          chats: chatsBy.get(r.id) ?? 0,
        })),
        total: Number(totalRow?.n ?? 0),
        limit,
        offset,
      });
    }),
  );

  // GET /api/visitors/:id — profile, session path, stats
  router.get(
    '/api/visitors/:id',
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const row = await loadScopedVisitor(deps, req, user.id, user.role);

      const pathRows = await deps.db.all<{ url: string | null; title: string | null; created_at: string }>(
        `SELECT url, title, created_at FROM (
           SELECT url, title, created_at FROM visitor_pages
            WHERE visitor_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
         ) t ORDER BY created_at ASC`,
        [row.id, MAX_PATH_ENTRIES],
      );
      const sessionPath: VisitorPage[] = pathRows.map((p) => ({
        url: p.url,
        title: p.title,
        at: p.created_at,
      }));

      const stats = await deps.db.get<{ chats: number; pages: number; rated: number; avg: number | null }>(
        `SELECT
           (SELECT COUNT(*) FROM conversations WHERE visitor_id = ?) AS chats,
           (SELECT COUNT(*) FROM visitor_pages WHERE visitor_id = ?) AS pages,
           (SELECT COUNT(*) FROM conversations WHERE visitor_id = ? AND rating IS NOT NULL) AS rated,
           (SELECT AVG(rating) FROM conversations WHERE visitor_id = ? AND rating IS NOT NULL) AS avg`,
        [row.id, row.id, row.id, row.id],
      );

      const online = deps.presence.isVisitorOnline(row.id);
      const page = online
        ? (deps.presence.onlineVisitors(row.website_id).find((p) => p.visitorId === row.id)?.page ?? null)
        : null;
      const visitor: Visitor = {
        ...toVisitor(row),
        online,
        currentPage: page,
        chats: Number(stats?.chats ?? 0),
      };
      res.json({
        visitor,
        sessionPath,
        stats: {
          chats: Number(stats?.chats ?? 0),
          pagesAllTime: Number(stats?.pages ?? 0),
          ratedChats: Number(stats?.rated ?? 0),
          avgRating: stats?.avg != null ? Math.round(Number(stats.avg) * 10) / 10 : null,
          firstSeenAt: row.created_at,
        },
      });
    }),
  );

  // PATCH /api/visitors/:id — CRM fields
  router.patch(
    '/api/visitors/:id',
    auth,
    h(async (req, res) => {
      const user = agent(req);
      if (user.role === 'MANAGER') throw new HttpError(403, 'Managers have view-only access');
      const row = await loadScopedVisitor(deps, req, user.id, user.role);
      const body = (req.body ?? {}) as Record<string, unknown>;

      const sets: string[] = [];
      const params: unknown[] = [];
      const field = (key: string, column: string, max: number) => {
        if (!(key in body)) return;
        const value = asString(body[key])?.trim().slice(0, max) ?? '';
        sets.push(`${column} = ?`);
        params.push(value || null);
      };
      field('name', 'name', 255);
      field('email', 'email', 255);
      field('phone', 'phone', 64);
      field('notes', 'notes', 4000);
      if (sets.length > 0) {
        params.push(row.id);
        await deps.db.run(`UPDATE visitors SET ${sets.join(', ')} WHERE id = ?`, params);
      }
      const updated = await deps.db.get<VisitorRow>('SELECT * FROM visitors WHERE id = ?', [row.id]);
      if (!updated) throw new HttpError(404, 'Visitor not found');
      res.json({ ...toVisitor(updated), online: deps.presence.isVisitorOnline(row.id) });
    }),
  );

  // GET /api/visitors/:id/conversations — past chats list
  router.get(
    '/api/visitors/:id/conversations',
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const row = await loadScopedVisitor(deps, req, user.id, user.role);

      const convs = await deps.db.all<{
        id: string;
        status: string;
        created_at: string;
        closed_at: string | null;
        rating: number | null;
        assigned_user_id: string | null;
        agent_name: string | null;
        message_count: number;
        preview: string | null;
      }>(
        `SELECT c.id, c.status, c.created_at, c.closed_at, c.rating, c.assigned_user_id,
                u.name AS agent_name,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                (SELECT m.body FROM messages m
                  WHERE m.conversation_id = c.id AND m.kind = 'TEXT'
                  ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS preview
           FROM conversations c
           LEFT JOIN users u ON u.id = c.assigned_user_id
          WHERE c.visitor_id = ?
          ORDER BY c.created_at DESC
          LIMIT 100`,
        [row.id],
      );
      res.json(
        convs.map((c) => ({
          id: c.id,
          status: c.status,
          createdAt: c.created_at,
          closedAt: c.closed_at,
          rating: c.rating,
          assignedUserId: c.assigned_user_id,
          agentName: c.agent_name,
          messageCount: Number(c.message_count),
          preview: c.preview,
        })),
      );
    }),
  );

  return router;
}
