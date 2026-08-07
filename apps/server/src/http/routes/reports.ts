import { Router } from 'express';
import { API } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { requireAgent, requireRole, type UserRow } from '../../core/auth.js';
import {
  HttpError,
  accessibleWebsiteRows,
  agent,
  asString,
  h,
  placeholders,
  toUserWithPresence,
} from '../helpers.js';

export function buildReportsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  // GET /api/reports/overview?websiteId= — LEAD/ADMIN
  router.get(
    API.reports,
    auth,
    requireRole('ADMIN', 'LEAD'),
    h(async (req, res) => {
      const user = agent(req);
      const scopedSites = (await accessibleWebsiteRows(deps, user)).map((w) => w.id);

      const websiteId = asString(req.query.websiteId);
      let siteIds = scopedSites;
      if (websiteId) {
        if (!scopedSites.includes(websiteId)) throw new HttpError(403, 'Forbidden');
        siteIds = [websiteId];
      }

      // Agents in scope: ADMIN → everyone; LEAD → members of their teams.
      let agents: UserRow[];
      if (user.role === 'ADMIN') {
        agents = await deps.db.all<UserRow>('SELECT * FROM users ORDER BY name');
      } else {
        agents = await deps.db.all<UserRow>(
          `SELECT DISTINCT u.* FROM users u
             JOIN team_members tm ON tm.user_id = u.id
            WHERE tm.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
            ORDER BY u.name`,
          [user.id],
        );
      }

      if (siteIds.length === 0) {
        res.json({
          totals: { active: 0, waiting: 0, closed: 0, missed: 0 },
          avgFirstResponseSeconds: null,
          perAgent: agents.map((a) => ({
            user: toUserWithPresence(deps, a),
            closed: 0,
            active: 0,
          })),
        });
        return;
      }

      const siteFilter = `website_id IN (${placeholders(siteIds.length)})`;

      const [statusCounts, responseRows, perAgentCounts] = await Promise.all([
        deps.db.all<{ status: string; n: number }>(
          `SELECT status, COUNT(*) AS n FROM conversations WHERE ${siteFilter} GROUP BY status`,
          siteIds,
        ),
        deps.db.all<{ created_at: string; activated_at: string }>(
          `SELECT created_at, activated_at FROM conversations
            WHERE ${siteFilter} AND activated_at IS NOT NULL`,
          siteIds,
        ),
        deps.db.all<{ uid: string; status: string; n: number }>(
          `SELECT assigned_user_id AS uid, status, COUNT(*) AS n
             FROM conversations
            WHERE ${siteFilter} AND assigned_user_id IS NOT NULL
            GROUP BY assigned_user_id, status`,
          siteIds,
        ),
      ]);

      const byStatus = new Map(statusCounts.map((r) => [r.status, Number(r.n)]));
      const totals = {
        active: byStatus.get('ACTIVE') ?? 0,
        waiting: (byStatus.get('WAITING') ?? 0) + (byStatus.get('OFFERED') ?? 0),
        closed: byStatus.get('CLOSED') ?? 0,
        missed: byStatus.get('MISSED') ?? 0,
      };

      let avgFirstResponseSeconds: number | null = null;
      if (responseRows.length > 0) {
        const totalSeconds = responseRows.reduce((sum, r) => {
          const delta = (Date.parse(r.activated_at) - Date.parse(r.created_at)) / 1000;
          return sum + (Number.isFinite(delta) && delta > 0 ? delta : 0);
        }, 0);
        avgFirstResponseSeconds = Math.round(totalSeconds / responseRows.length);
      }

      const perAgentMap = new Map<string, { closed: number; active: number }>();
      for (const row of perAgentCounts) {
        const entry = perAgentMap.get(row.uid) ?? { closed: 0, active: 0 };
        if (row.status === 'CLOSED') entry.closed += Number(row.n);
        if (row.status === 'ACTIVE') entry.active += Number(row.n);
        perAgentMap.set(row.uid, entry);
      }

      const perAgent = agents.map((a) => {
        const counts = perAgentMap.get(a.id) ?? { closed: 0, active: 0 };
        return { user: toUserWithPresence(deps, a), closed: counts.closed, active: counts.active };
      });

      res.json({ totals, avgFirstResponseSeconds, perAgent });
    }),
  );

  return router;
}
