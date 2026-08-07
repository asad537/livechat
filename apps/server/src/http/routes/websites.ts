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
        `INSERT INTO websites (id, name, widget_key, domains, team_id, logo_url, primary_color, greeting, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          name,
          newWidgetKey(),
          normalizeDomains(req.body?.domains),
          teamId,
          asString(req.body?.logoUrl) || null,
          asString(req.body?.primaryColor)?.trim() || '#6366f1',
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
      if (online.length === 0) {
        res.json([]);
        return;
      }
      const ids = online.map((v) => v.visitorId);
      const rows = await deps.db.all<VisitorRow>(
        `SELECT * FROM visitors WHERE website_id = ? AND id IN (${placeholders(ids.length)})`,
        [websiteId, ...ids],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const visitors: Visitor[] = online.map((p) => {
        const row = byId.get(p.visitorId);
        const base: Visitor = row
          ? toVisitor(row)
          : {
              id: p.visitorId,
              websiteId,
              name: null,
              email: null,
              lastSeenAt: nowIso(),
            };
        return { ...base, online: true, currentPage: p.page ?? null };
      });
      visitors.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
      res.json(visitors);
    }),
  );

  return router;
}
