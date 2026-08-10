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

interface ConvRow {
  status: string;
  assigned_user_id: string | null;
  created_at: string;
  activated_at: string | null;
  closed_at: string | null;
  rating: number | null;
}

function rangeStart(range: string): string | null {
  const now = new Date();
  if (range === 'today') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return d.toISOString();
  }
  if (range === '7d') return new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  if (range === '30d') return new Date(now.getTime() - 30 * 24 * 3600_000).toISOString();
  return null; // all time
}

const avg = (xs: number[]): number | null =>
  xs.length > 0 ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

/** Positive seconds between two ISO timestamps, else null. */
function secondsBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const s = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(s) && s >= 0 ? s : null;
}

export function buildReportsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  // GET /api/reports/overview?websiteId=&range=today|7d|30d|all — LEAD/ADMIN
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
      const range = asString(req.query.range) ?? 'all';
      const since = rangeStart(range);

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

      const emptyAgent = (a: UserRow) => ({
        user: toUserWithPresence(deps, a),
        closed: 0,
        active: 0,
        handled: 0,
        avgFirstResponseSeconds: null as number | null,
        avgDurationSeconds: null as number | null,
        rating: { average: null as number | null, count: 0 },
      });

      if (siteIds.length === 0) {
        res.json({
          range,
          totals: { active: 0, waiting: 0, closed: 0, missed: 0 },
          avgFirstResponseSeconds: null,
          csat: { average: null, count: 0 },
          perAgent: agents.map(emptyAgent),
          trend: [],
        });
        return;
      }

      const siteFilter = `website_id IN (${placeholders(siteIds.length)})`;
      const rangeFilter = since ? ' AND (created_at >= ? OR closed_at >= ?)' : '';
      const rangeParams = since ? [since, since] : [];

      const trendSince = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
      const [rows, liveCounts, trendRows] = await Promise.all([
        // Conversations with activity in the selected range (capped for safety).
        deps.db.all<ConvRow>(
          `SELECT status, assigned_user_id, created_at, activated_at, closed_at, rating
             FROM (SELECT * FROM conversations WHERE ${siteFilter}${rangeFilter}
                   ORDER BY created_at DESC LIMIT 10000) t`,
          [...siteIds, ...rangeParams],
        ),
        // Point-in-time open pipeline (independent of the range).
        deps.db.all<{ status: string; assigned_user_id: string | null; n: number }>(
          `SELECT status, assigned_user_id, COUNT(*) AS n FROM conversations
            WHERE ${siteFilter} AND status IN ('ACTIVE','WAITING','OFFERED')
            GROUP BY status, assigned_user_id`,
          siteIds,
        ),
        // 14-day chat volume for the trend chart.
        deps.db.all<{ created_at: string }>(
          `SELECT created_at FROM conversations WHERE ${siteFilter} AND created_at >= ?`,
          [...siteIds, trendSince],
        ),
      ]);

      // ── Totals ──
      let activeNow = 0;
      let waitingNow = 0;
      const activeByAgent = new Map<string, number>();
      for (const r of liveCounts) {
        const n = Number(r.n);
        if (r.status === 'ACTIVE') {
          activeNow += n;
          if (r.assigned_user_id) {
            activeByAgent.set(r.assigned_user_id, (activeByAgent.get(r.assigned_user_id) ?? 0) + n);
          }
        } else {
          waitingNow += n;
        }
      }
      const inRange = (iso: string | null) => iso != null && (!since || iso >= since);
      const closedRows = rows.filter((r) => r.status === 'CLOSED' && inRange(r.closed_at));
      const totals = {
        active: activeNow,
        waiting: waitingNow,
        closed: closedRows.length,
        missed: rows.filter((r) => r.status === 'MISSED' && inRange(r.created_at)).length,
      };

      // ── Global response time + CSAT (range-scoped) ──
      const frtAll: number[] = [];
      for (const r of rows) {
        if (!inRange(r.created_at)) continue;
        const s = secondsBetween(r.created_at, r.activated_at);
        if (s != null) frtAll.push(s);
      }
      const ratingsAll = closedRows.filter((r) => r.rating != null).map((r) => Number(r.rating));
      const csat = {
        average:
          ratingsAll.length > 0
            ? Math.round((ratingsAll.reduce((a, b) => a + b, 0) / ratingsAll.length) * 10) / 10
            : null,
        count: ratingsAll.length,
      };

      // ── Per-agent breakdown ──
      const perAgent = agents.map((a) => {
        const mine = rows.filter((r) => r.assigned_user_id === a.id);
        // "Handled" = conversations they actually worked in the range
        // (activated or closed in range, or currently active).
        const handledRows = mine.filter(
          (r) =>
            (r.activated_at != null && inRange(r.activated_at)) ||
            (r.status === 'CLOSED' && inRange(r.closed_at)) ||
            r.status === 'ACTIVE',
        );
        const myClosed = mine.filter((r) => r.status === 'CLOSED' && inRange(r.closed_at));
        const frt: number[] = [];
        const durations: number[] = [];
        for (const r of handledRows) {
          const s = secondsBetween(r.created_at, r.activated_at);
          if (s != null) frt.push(s);
        }
        for (const r of myClosed) {
          const s = secondsBetween(r.activated_at, r.closed_at);
          if (s != null) durations.push(s);
        }
        const myRatings = myClosed.filter((r) => r.rating != null).map((r) => Number(r.rating));
        return {
          user: toUserWithPresence(deps, a),
          closed: myClosed.length,
          active: activeByAgent.get(a.id) ?? 0,
          handled: handledRows.length,
          avgFirstResponseSeconds: avg(frt),
          avgDurationSeconds: avg(durations),
          rating: {
            average:
              myRatings.length > 0
                ? Math.round((myRatings.reduce((x, y) => x + y, 0) / myRatings.length) * 10) / 10
                : null,
            count: myRatings.length,
          },
        };
      });

      // ── 14-day trend (per local day) ──
      const dayKey = (iso: string) => {
        const d = new Date(iso);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const byDay = new Map<string, number>();
      for (const r of trendRows) byDay.set(dayKey(r.created_at), (byDay.get(dayKey(r.created_at)) ?? 0) + 1);
      const trend: { day: string; count: number }[] = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        trend.push({ day: key, count: byDay.get(key) ?? 0 });
      }

      res.json({ range, totals, avgFirstResponseSeconds: avg(frtAll), csat, perAgent, trend });
    }),
  );

  return router;
}
