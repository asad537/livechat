import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { API, type Visitor } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { requireAgent, requireRole } from '../../core/auth.js';
import { newId, nowIso } from '../../core/db.js';
import { userCanAccessWebsite } from '../../domain/conversations.js';
import {
  HttpError,
  accessibleWebsiteRows,
  agent,
  asString,
  h,
  placeholders,
  requireString,
  toVisitor,
  toWebsite,
  type TeamRow,
  type VisitorRow,
  type WebsiteRow,
} from '../helpers.js';

function normalizeDomains(input: unknown): string {
  if (input === undefined || input === null) return '';
  const list = Array.isArray(input)
    ? input
    : String(input)
        .split(',')
        .map((d) => d.trim());
  return list
    .map((d) => String(d).trim().toLowerCase())
    .filter((d) => d.length > 0)
    .join(',');
}

function newWidgetKey(): string {
  return `wk_${randomBytes(6).toString('hex')}`; // wk_ + 12 hex chars
}

export function buildWebsitesRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  // GET /api/websites — scoped list
  router.get(
    API.websites,
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const rows = await accessibleWebsiteRows(deps, user);
      res.json(rows.map(toWebsite));
    }),
  );

  // GET /api/websites/stats — per-website chat + AI-knowledge stats (scoped)
  router.get(
    `${API.websites}/stats`,
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const siteIds = (await accessibleWebsiteRows(deps, user)).map((w) => w.id);
      if (siteIds.length === 0) {
        res.json({});
        return;
      }
      const ph = placeholders(siteIds.length);
      const [convCounts, activeCounts, knowledge] = await Promise.all([
        deps.db.all<{ website_id: string; n: number }>(
          `SELECT website_id, COUNT(*) AS n FROM conversations WHERE website_id IN (${ph}) GROUP BY website_id`,
          siteIds,
        ),
        deps.db.all<{ website_id: string; n: number }>(
          `SELECT website_id, COUNT(*) AS n FROM conversations
            WHERE website_id IN (${ph}) AND status IN ('WAITING','OFFERED','ACTIVE')
            GROUP BY website_id`,
          siteIds,
        ),
        deps.db.all<{ website_id: string; pages: number; urls: number; last: string }>(
          `SELECT website_id,
                  SUM(CASE WHEN content IS NOT NULL THEN 1 ELSE 0 END) AS pages,
                  SUM(CASE WHEN content IS NULL THEN 1 ELSE 0 END) AS urls,
                  MAX(fetched_at) AS last
             FROM knowledge_pages WHERE website_id IN (${ph}) GROUP BY website_id`,
          siteIds,
        ),
      ]);
      const stats: Record<
        string,
        { chats: number; open: number; aiPages: number; aiUrls: number; aiLastScan: string | null }
      > = {};
      for (const id of siteIds) {
        stats[id] = { chats: 0, open: 0, aiPages: 0, aiUrls: 0, aiLastScan: null };
      }
      for (const r of convCounts) stats[r.website_id].chats = Number(r.n);
      for (const r of activeCounts) stats[r.website_id].open = Number(r.n);
      for (const r of knowledge) {
        stats[r.website_id].aiPages = Number(r.pages);
        stats[r.website_id].aiUrls = Number(r.urls);
        stats[r.website_id].aiLastScan = r.last ?? null;
      }
      res.json(stats);
    }),
  );

  // DELETE /api/websites/:id — ADMIN; removes the website AND all its data
  router.delete(
    `${API.websites}/:id`,
    auth,
    requireRole('ADMIN'),
    h(async (req, res) => {
      const id = String(req.params.id);
      const site = await deps.db.get<WebsiteRow>('SELECT * FROM websites WHERE id = ?', [id]);
      if (!site) throw new HttpError(404, 'Website not found');

      const convIds = (
        await deps.db.all<{ id: string }>('SELECT id FROM conversations WHERE website_id = ?', [id])
      ).map((r) => r.id);

      if (convIds.length > 0) {
        const ph = placeholders(convIds.length);
        await deps.db.run(`DELETE FROM messages WHERE conversation_id IN (${ph})`, convIds);
        await deps.db.run(`DELETE FROM files WHERE conversation_id IN (${ph})`, convIds);
        await deps.db.run(
          `DELETE FROM call_events WHERE call_id IN (SELECT id FROM calls WHERE conversation_id IN (${ph}))`,
          convIds,
        );
        await deps.db.run(`DELETE FROM calls WHERE conversation_id IN (${ph})`, convIds);
        await deps.db.run(`DELETE FROM assignment_history WHERE conversation_id IN (${ph})`, convIds);
        await deps.db.run(`DELETE FROM conversations WHERE id IN (${ph})`, convIds);
      }
      await deps.db.run('DELETE FROM visitors WHERE website_id = ?', [id]);
      await deps.db.run('DELETE FROM knowledge_pages WHERE website_id = ?', [id]);
      await deps.db.run('DELETE FROM websites WHERE id = ?', [id]);

      res.json({ ok: true, deletedConversations: convIds.length });
    }),
  );

  // POST /api/websites — ADMIN
  router.post(
    API.websites,
    auth,
    requireRole('ADMIN'),
    h(async (req, res) => {
      const name = requireString(req.body?.name, 'name', 255);
      const teamId = requireString(req.body?.teamId, 'teamId', 64);
      const team = await deps.db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [teamId]);
      if (!team) throw new HttpError(400, 'Unknown teamId');

      const id = newId();
      await deps.db.run(
        `INSERT INTO websites (id, name, widget_key, domains, team_id, logo_url, primary_color, header_color, greeting, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          name,
          newWidgetKey(),
          normalizeDomains(req.body?.domains),
          teamId,
          asString(req.body?.logoUrl) || null,
          asString(req.body?.primaryColor)?.trim() || '#6366f1',
          asString(req.body?.headerColor)?.trim() || null,
          asString(req.body?.greeting)?.trim() || 'Hi there! How can we help?',
          nowIso(),
        ],
      );
      const created = await deps.db.get<WebsiteRow>('SELECT * FROM websites WHERE id = ?', [id]);
      if (!created) throw new HttpError(500, 'Failed to create website');
      res.status(201).json(toWebsite(created));
    }),
  );

  // PATCH /api/websites/:id — ADMIN
  router.patch(
    `${API.websites}/:id`,
    auth,
    requireRole('ADMIN'),
    h(async (req, res) => {
      const id = req.params.id as string;
      const existing = await deps.db.get<WebsiteRow>('SELECT * FROM websites WHERE id = ?', [id]);
      if (!existing) throw new HttpError(404, 'Website not found');

      const sets: string[] = [];
      const params: unknown[] = [];
      const body = req.body ?? {};

      if (body.name !== undefined) {
        sets.push('name = ?');
        params.push(requireString(body.name, 'name', 255));
      }
      if (body.domains !== undefined) {
        sets.push('domains = ?');
        params.push(normalizeDomains(body.domains));
      }
      if (body.primaryColor !== undefined) {
        sets.push('primary_color = ?');
        params.push(requireString(body.primaryColor, 'primaryColor', 16));
      }
      if (body.headerColor !== undefined) {
        sets.push('header_color = ?');
        params.push(asString(body.headerColor)?.trim() || null);
      }
      if (body.greeting !== undefined) {
        sets.push('greeting = ?');
        params.push(requireString(body.greeting, 'greeting', 512));
      }
      if (body.logoUrl !== undefined) {
        sets.push('logo_url = ?');
        params.push(asString(body.logoUrl)?.trim() || null);
      }
      if (body.teamId !== undefined) {
        const teamId = requireString(body.teamId, 'teamId', 64);
        const team = await deps.db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [teamId]);
        if (!team) throw new HttpError(400, 'Unknown teamId');
        sets.push('team_id = ?');
        params.push(teamId);
      }
      if (body.aiEnabled !== undefined) {
        sets.push('ai_enabled = ?');
        params.push(body.aiEnabled ? 1 : 0);
      }

      if (sets.length > 0) {
        params.push(id);
        await deps.db.run(`UPDATE websites SET ${sets.join(', ')} WHERE id = ?`, params);
      }
      const updated = await deps.db.get<WebsiteRow>('SELECT * FROM websites WHERE id = ?', [id]);
      if (!updated) throw new HttpError(404, 'Website not found');
      res.json(toWebsite(updated));
    }),
  );

  // GET /api/websites/:id/visitors — online visitors (presence) merged with visitor rows
  router.get(
    `${API.websites}/:id/visitors`,
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const websiteId = req.params.id as string;
      const site = await deps.db.get<WebsiteRow>('SELECT * FROM websites WHERE id = ?', [
        websiteId,
      ]);
      if (!site) throw new HttpError(404, 'Website not found');
      if (!(await userCanAccessWebsite(deps, user.id, user.role, websiteId))) {
        throw new HttpError(403, 'Forbidden');
      }

      const online = deps.presence.onlineVisitors(websiteId);
      const onlinePage = new Map(online.map((p) => [p.visitorId, p.page ?? null]));

      // Online rows + recently-seen offline rows (last 24h, capped) in one list.
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const idFilter = online.length
        ? `OR id IN (${placeholders(online.length)})`
        : '';
      const rows = await deps.db.all<VisitorRow>(
        `SELECT * FROM visitors WHERE website_id = ? AND (last_seen_at >= ? ${idFilter})
          ORDER BY last_seen_at DESC LIMIT 30`,
        [websiteId, dayAgo, ...online.map((v) => v.visitorId)],
      );
      const rowIds = rows.map((r) => r.id);
      const pagesBy = new Map<string, number>();
      const chatsBy = new Map<string, number>();
      if (rowIds.length > 0) {
        const pageCounts = await deps.db.all<{ visitor_id: string; n: number }>(
          `SELECT vp.visitor_id, COUNT(*) AS n FROM visitor_pages vp
             JOIN visitors v ON v.id = vp.visitor_id
            WHERE vp.visitor_id IN (${placeholders(rowIds.length)})
              AND vp.created_at >= COALESCE(v.session_started_at, v.created_at)
            GROUP BY vp.visitor_id`,
          rowIds,
        );
        const chatCounts = await deps.db.all<{ visitor_id: string; n: number }>(
          `SELECT visitor_id, COUNT(*) AS n FROM conversations
            WHERE visitor_id IN (${placeholders(rowIds.length)}) GROUP BY visitor_id`,
          rowIds,
        );
        for (const r of pageCounts) pagesBy.set(r.visitor_id, Number(r.n));
        for (const r of chatCounts) chatsBy.set(r.visitor_id, Number(r.n));
      }
      const seen = new Set(rows.map((r) => r.id));
      const visitors: Visitor[] = rows.map((row) => ({
        ...toVisitor(row),
        online: onlinePage.has(row.id),
        currentPage: onlinePage.get(row.id) ?? null,
        sessionPages: pagesBy.get(row.id) ?? 0,
        chats: chatsBy.get(row.id) ?? 0,
      }));
      // Presence entries whose row is missing (brand-new visitor) still show up.
      for (const p of online) {
        if (seen.has(p.visitorId)) continue;
        visitors.push({
          id: p.visitorId,
          websiteId,
          name: null,
          email: null,
          lastSeenAt: nowIso(),
          online: true,
          currentPage: p.page ?? null,
          sessionPages: 0,
          chats: 0,
        });
      }
      visitors.sort((a, b) => {
        if (!!a.online !== !!b.online) return a.online ? -1 : 1;
        return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
      });
      res.json(visitors);
    }),
  );

  return router;
}
