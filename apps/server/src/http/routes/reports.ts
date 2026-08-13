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
  type WebsiteRow,
} from '../helpers.js';

interface ConvRow {
  id: string;
  website_id: string;
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
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  }
  if (range === '7d') return new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  if (range === '30d') return new Date(now.getTime() - 30 * 24 * 3600_000).toISOString();
  return null; // all time
}

const avg = (xs: number[]): number | null =>
  xs.length > 0 ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

const pct = (part: number, total: number): number | null =>
  total > 0 ? Math.round((part / total) * 1000) / 10 : null;

/** Positive seconds between two ISO timestamps, else null. */
function secondsBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const s = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(s) && s >= 0 ? s : null;
}

const dayKey = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Words too generic to be a "topic" (English + Roman Urdu chat filler).
const STOPWORDS = new Set(
  `the and you your for with this that have has had from what when where which will would could should there their about just like want need know been being some very much more can does did not are was were they them then than into out our own also because please thanks thank hello sorry okay yeah yes no bhai yaar acha achha kya kia hai hain ho ha hoon hun main mein mera meri apna apki apka aap tum kar karo karna kiya kre kry raha rahi rhe wala wali koi kuch kaise kese kab kahan kyun kyu magar lekin agar phir abhi sirf bhi nahi nhi han haan chahiye chaiye hui hua gaya gayi krna karain
message chat online agent support help team website site page info question query`.split(/\s+/),
);

export function buildReportsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  // GET /api/reports/overview?websiteId=&range=today|7d|30d|all — ADMIN/MANAGER/LEAD
  router.get(
    API.reports,
    auth,
    requireRole('ADMIN', 'MANAGER', 'LEAD', 'CSR'),
    h(async (req, res) => {
      const user = agent(req);
      const siteRows = await accessibleWebsiteRows(deps, user);
      const scopedSites = siteRows.map((w) => w.id);

      const websiteId = asString(req.query.websiteId);
      let siteIds = scopedSites;
      if (websiteId) {
        if (!scopedSites.includes(websiteId)) throw new HttpError(403, 'Forbidden');
        siteIds = [websiteId];
      }
      const range = asString(req.query.range) ?? 'today';
      const since = rangeStart(range);

      // Agents in scope: ADMIN/MANAGER → everyone; Team Lead → self + own CSRs;
      // CSR → only themselves.
      let agents: UserRow[];
      if (user.role === 'CSR') {
        agents = await deps.db.all<UserRow>('SELECT * FROM users WHERE id = ?', [user.id]);
      } else if (user.role === 'LEAD') {
        agents = await deps.db.all<UserRow>(
          'SELECT * FROM users WHERE id = ? OR team_lead_id = ? ORDER BY name',
          [user.id, user.id],
        );
      } else {
        agents = await deps.db.all<UserRow>('SELECT * FROM users ORDER BY name');
      }

      // Scope conversation metrics to the agents in view. A Team Lead's numbers
      // also cover unassigned queue/missed chats (they belong to the website, not
      // an agent); a CSR sees strictly their own assigned chats. ADMIN/MANAGER
      // see everything (no filter).
      const scopeIds =
        user.role === 'CSR' || user.role === 'LEAD' ? agents.map((a) => a.id) : null;
      const includeUnassigned = user.role === 'LEAD';
      const unassignedClause = includeUnassigned ? ' OR assigned_user_id IS NULL' : '';
      const cUnassignedClause = includeUnassigned ? ' OR c.assigned_user_id IS NULL' : '';
      const agentFilter = scopeIds
        ? ` AND (assigned_user_id IN (${placeholders(scopeIds.length)})${unassignedClause})`
        : '';
      const cAgentFilter = scopeIds
        ? ` AND (c.assigned_user_id IN (${placeholders(scopeIds.length)})${cUnassignedClause})`
        : '';
      const agentParams: string[] = scopeIds ?? [];

      const empty = {
        range,
        totals: { active: 0, waiting: 0, closed: 0, missed: 0, clientChats: 0, csrChats: 0 },
        avgFirstResponseSeconds: null,
        csat: { average: null, count: 0 },
        perAgent: agents.map((a) => ({
          user: toUserWithPresence(deps, a),
          closed: 0,
          active: 0,
          handled: 0,
          avgFirstResponseSeconds: null,
          avgDurationSeconds: null,
          rating: { average: null, count: 0 },
        })),
        trend: [],
        tiles: {
          resolutionRate: null,
          avgChatDurationSeconds: null,
          avgReplySeconds: null,
          peakHour: null,
          returningRate: null,
          conversionRate: null,
        },
        outcomes: { resolved: 0, transferred: 0, missed: 0, open: 0 },
        byHour: Array.from({ length: 24 }, () => 0),
        trendDetail: [],
        csatDist: [0, 0, 0, 0, 0],
        funnel: { visitors: 0, chats: 0, answered: 0, resolved: 0 },
        countries: [],
        topics: [],
        websitePerf: [],
        yesterdayFrtSeconds: null,
      };
      if (siteIds.length === 0) {
        res.json(empty);
        return;
      }

      const siteFilter = `website_id IN (${placeholders(siteIds.length)})`;
      const cSiteFilter = `c.website_id IN (${placeholders(siteIds.length)})`;
      const rangeFilter = since ? ' AND (created_at >= ? OR closed_at >= ?)' : '';
      const cRangeFilter = since ? ' AND (c.created_at >= ? OR c.closed_at >= ?)' : '';
      const rangeParams = since ? [since, since] : [];

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const yesterdayStart = new Date(Date.parse(todayStart) - 24 * 3600_000).toISOString();
      const trendWindow = range === '7d' ? 7 : range === '30d' || range === 'all' ? 30 : 14;
      const trendSince = new Date(Date.now() - trendWindow * 24 * 3600_000).toISOString();
      const visitorSince = since ?? '1970';

      const [
        rows,
        liveCounts,
        trendRows,
        visitorAgg,
        countryRows,
        transferRows,
        msgRows,
        yesterdayRows,
      ] = await Promise.all([
        deps.db.all<ConvRow>(
          `SELECT id, website_id, status, assigned_user_id, created_at, activated_at, closed_at, rating
             FROM (SELECT * FROM conversations WHERE ${siteFilter}${rangeFilter}${agentFilter}
                   ORDER BY created_at DESC LIMIT 10000) t`,
          [...siteIds, ...rangeParams, ...agentParams],
        ),
        deps.db.all<{ status: string; assigned_user_id: string | null; n: number }>(
          `SELECT status, assigned_user_id, COUNT(*) AS n FROM conversations
            WHERE ${siteFilter} AND status IN ('ACTIVE','WAITING','OFFERED')${agentFilter}
            GROUP BY status, assigned_user_id`,
          [...siteIds, ...agentParams],
        ),
        deps.db.all<{ created_at: string; activated_at: string | null; closed_at: string | null; status: string }>(
          `SELECT created_at, activated_at, closed_at, status FROM conversations
            WHERE ${siteFilter} AND created_at >= ?${agentFilter}`,
          [...siteIds, trendSince, ...agentParams],
        ),
        deps.db.get<{ n: number; ret: number }>(
          `SELECT COUNT(*) AS n, SUM(CASE WHEN total_visits > 1 THEN 1 ELSE 0 END) AS ret
             FROM visitors WHERE ${siteFilter} AND last_seen_at >= ?`,
          [...siteIds, visitorSince],
        ),
        deps.db.all<{ country: string; cc: string | null; n: number }>(
          `SELECT geo_country AS country, geo_cc AS cc, COUNT(*) AS n FROM visitors
            WHERE ${siteFilter} AND last_seen_at >= ? AND geo_country IS NOT NULL
            GROUP BY geo_country, geo_cc ORDER BY n DESC LIMIT 6`,
          [...siteIds, visitorSince],
        ),
        deps.db.all<{ cid: string }>(
          `SELECT DISTINCT h.conversation_id AS cid FROM assignment_history h
             JOIN conversations c ON c.id = h.conversation_id
            WHERE h.reason = 'TRANSFER' AND ${cSiteFilter}${cRangeFilter}${cAgentFilter}`,
          [...siteIds, ...rangeParams, ...agentParams],
        ),
        deps.db.all<{ cid: string; st: string; at: string; kind: string; body: string | null }>(
          `SELECT m.conversation_id AS cid, m.sender_type AS st, m.created_at AS at, m.kind, m.body
             FROM messages m JOIN conversations c ON c.id = m.conversation_id
            WHERE ${cSiteFilter}${cRangeFilter}${cAgentFilter}
            ORDER BY m.conversation_id, m.created_at LIMIT 20000`,
          [...siteIds, ...rangeParams, ...agentParams],
        ),
        deps.db.all<{ status: string; created_at: string; activated_at: string | null; closed_at: string | null }>(
          `SELECT status, created_at, activated_at, closed_at FROM conversations
            WHERE ${siteFilter} AND ((created_at >= ? AND created_at < ?) OR (closed_at >= ? AND closed_at < ?))${agentFilter}`,
          [...siteIds, yesterdayStart, todayStart, yesterdayStart, todayStart, ...agentParams],
        ),
      ]);

      // 14-day message stream for the per-day response-time line (bounded).
      const msgs14 = await deps.db.all<{ cid: string; st: string; at: string }>(
        `SELECT m.conversation_id AS cid, m.sender_type AS st, m.created_at AS at
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE ${cSiteFilter} AND c.created_at >= ?${cAgentFilter}
          ORDER BY m.conversation_id, m.created_at LIMIT 30000`,
        [...siteIds, trendSince, ...agentParams],
      );
      const replyByDay = new Map<string, number[]>();
      {
        let lastV: string | null = null;
        let lastC = '';
        for (const m of msgs14) {
          if (m.cid !== lastC) {
            lastC = m.cid;
            lastV = null;
          }
          if (m.st === 'VISITOR') {
            if (lastV == null) lastV = m.at;
          } else if (m.st === 'AGENT' && lastV != null) {
            const s = secondsBetween(lastV, m.at);
            if (s != null && s < 4 * 3600) {
              const k = dayKey(m.at);
              const arr = replyByDay.get(k) ?? [];
              arr.push(s);
              replyByDay.set(k, arr);
            }
            lastV = null;
          }
        }
      }

      const inRange = (iso: string | null) => iso != null && (!since || iso >= since);

      // Live engagement split: open chats where the CLIENT has messaged vs
      // ones where a CSR/agent has messaged (dashboard tiles).
      const [clientLiveRow, csrLiveRow] = await Promise.all([
        deps.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM conversations c
            WHERE ${cSiteFilter} AND c.status IN ('WAITING','OFFERED','ACTIVE')${cAgentFilter}
              AND EXISTS (SELECT 1 FROM messages m
                           WHERE m.conversation_id = c.id AND m.sender_type = 'VISITOR')`,
          [...siteIds, ...agentParams],
        ),
        deps.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM conversations c
            WHERE ${cSiteFilter} AND c.status IN ('WAITING','OFFERED','ACTIVE')${cAgentFilter}
              AND EXISTS (SELECT 1 FROM messages m
                           WHERE m.conversation_id = c.id AND m.sender_type = 'AGENT')`,
          [...siteIds, ...agentParams],
        ),
      ]);

      // ── Totals + open pipeline ──
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
        } else waitingNow += n;
      }
      const closedRows = rows.filter((r) => r.status === 'CLOSED' && inRange(r.closed_at));
      const missedCount = rows.filter((r) => r.status === 'MISSED' && inRange(r.created_at)).length;
      const startedRows = rows.filter((r) => inRange(r.created_at));
      const totals = {
        active: activeNow,
        waiting: waitingNow,
        closed: closedRows.length,
        missed: missedCount,
        clientChats: Number(clientLiveRow?.n ?? 0),
        csrChats: Number(csrLiveRow?.n ?? 0),
      };

      // ── First response + CSAT ──
      const frtAll: number[] = [];
      for (const r of startedRows) {
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
      const csatDist = [0, 0, 0, 0, 0];
      for (const r of ratingsAll) if (r >= 1 && r <= 5) csatDist[r - 1] += 1;

      // ── Chat durations ──
      const durations: number[] = [];
      for (const r of closedRows) {
        const s = secondsBetween(r.activated_at, r.closed_at);
        if (s != null) durations.push(s);
      }

      // ── Reply gaps (visitor msg → next agent msg) + topic words ──
      const replyGaps: number[] = [];
      const wordCounts = new Map<string, number>();
      let lastVisitorAt: string | null = null;
      let lastCid = '';
      for (const m of msgRows) {
        if (m.cid !== lastCid) {
          lastCid = m.cid;
          lastVisitorAt = null;
        }
        if (m.st === 'VISITOR') {
          if (lastVisitorAt == null) lastVisitorAt = m.at;
          if (m.kind === 'TEXT' && m.body) {
            for (const raw of m.body.toLowerCase().split(/[^a-z؀-ۿ]+/)) {
              if (raw.length < 4 || STOPWORDS.has(raw)) continue;
              wordCounts.set(raw, (wordCounts.get(raw) ?? 0) + 1);
            }
          }
        } else if (m.st === 'AGENT' && lastVisitorAt != null) {
          const s = secondsBetween(lastVisitorAt, m.at);
          if (s != null && s < 4 * 3600) replyGaps.push(s);
          lastVisitorAt = null;
        }
      }
      // ── Hourly response trend for the Today view ──
      const trendMode: 'day' | 'hour' = range === 'today' ? 'hour' : 'day';
      let hourTrend: {
        day: string;
        count: number;
        frtSeconds: number | null;
        durationSeconds: number | null;
        replySeconds: number | null;
      }[] = [];
      if (trendMode === 'hour') {
        const frtByHour: number[][] = Array.from({ length: 24 }, () => []);
        for (const r of startedRows) {
          const sec = secondsBetween(r.created_at, r.activated_at);
          if (sec != null) frtByHour[new Date(r.created_at).getHours()].push(sec);
        }
        const repByHour: number[][] = Array.from({ length: 24 }, () => []);
        {
          let lv: string | null = null;
          let lc = '';
          for (const m of msgRows) {
            if (m.cid !== lc) {
              lc = m.cid;
              lv = null;
            }
            if (m.st === 'VISITOR') {
              if (lv == null) lv = m.at;
            } else if (m.st === 'AGENT' && lv != null) {
              const sec = secondsBetween(lv, m.at);
              if (sec != null && sec < 4 * 3600) repByHour[new Date(m.at).getHours()].push(sec);
              lv = null;
            }
          }
        }
        hourTrend = Array.from({ length: 24 }, (_, hh) => ({
          day: String(hh),
          count: 0,
          frtSeconds: avg(frtByHour[hh]),
          durationSeconds: null,
          replySeconds: avg(repByHour[hh]),
        }));
      }

      const topicTotal = [...wordCounts.values()].reduce((a, b) => a + b, 0);
      const topics = [...wordCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([word, n]) => ({ word, n, pct: pct(n, topicTotal) ?? 0 }));

      // ── Outcomes donut ──
      const transferred = new Set(transferRows.map((t) => t.cid));
      const outcomes = { resolved: 0, transferred: 0, missed: missedCount, open: 0 };
      for (const r of rows) {
        if (r.status === 'CLOSED' && inRange(r.closed_at)) {
          if (transferred.has(r.id)) outcomes.transferred += 1;
          else outcomes.resolved += 1;
        } else if (r.status === 'ACTIVE' || r.status === 'WAITING' || r.status === 'OFFERED') {
          outcomes.open += 1;
        }
      }

      // ── Peak 2-hour window (chat starts in range) ──
      const hourCounts = Array.from({ length: 24 }, () => 0);
      for (const r of startedRows) hourCounts[new Date(r.created_at).getHours()] += 1;
      let peakHour: { start: number; share: number } | null = null;
      const totalStarts = startedRows.length;
      if (totalStarts > 0) {
        let best = -1;
        let bestStart = 0;
        for (let hh = 0; hh < 23; hh++) {
          const w = hourCounts[hh] + hourCounts[hh + 1];
          if (w > best) {
            best = w;
            bestStart = hh;
          }
        }
        peakHour = { start: bestStart, share: pct(best, totalStarts) ?? 0 };
      }

      // ── Chats by hour (selected range) ──
      const byHour = [...hourCounts];

      // ── Visitors / funnel / conversion ──
      const visitorsSeen = Number(visitorAgg?.n ?? 0);
      const returning = Number(visitorAgg?.ret ?? 0);
      const funnel = {
        visitors: visitorsSeen,
        chats: startedRows.length,
        answered: startedRows.filter((r) => r.activated_at != null).length,
        resolved: closedRows.length,
      };

      const tiles = {
        resolutionRate: pct(closedRows.length, closedRows.length + missedCount),
        avgChatDurationSeconds: avg(durations),
        avgReplySeconds: avg(replyGaps),
        peakHour,
        returningRate: pct(returning, visitorsSeen),
        conversionRate: pct(funnel.chats, visitorsSeen),
      };

      // ── Per-agent breakdown ──
      const perAgent = agents.map((a) => {
        const mine = rows.filter((r) => r.assigned_user_id === a.id);
        const handledRows = mine.filter(
          (r) =>
            (r.activated_at != null && inRange(r.activated_at)) ||
            (r.status === 'CLOSED' && inRange(r.closed_at)) ||
            r.status === 'ACTIVE',
        );
        const myClosed = mine.filter((r) => r.status === 'CLOSED' && inRange(r.closed_at));
        const myMissed = mine.filter((r) => r.status === 'MISSED' && inRange(r.created_at)).length;
        const frt: number[] = [];
        const dur: number[] = [];
        for (const r of handledRows) {
          const s = secondsBetween(r.created_at, r.activated_at);
          if (s != null) frt.push(s);
        }
        for (const r of myClosed) {
          const s = secondsBetween(r.activated_at, r.closed_at);
          if (s != null) dur.push(s);
        }
        const myRatings = myClosed.filter((r) => r.rating != null).map((r) => Number(r.rating));
        return {
          user: toUserWithPresence(deps, a),
          closed: myClosed.length,
          active: activeByAgent.get(a.id) ?? 0,
          handled: handledRows.length,
          resolutionRate: pct(myClosed.length, myClosed.length + myMissed),
          avgFirstResponseSeconds: avg(frt),
          avgDurationSeconds: avg(dur),
          rating: {
            average:
              myRatings.length > 0
                ? Math.round((myRatings.reduce((x, y) => x + y, 0) / myRatings.length) * 10) / 10
                : null,
            count: myRatings.length,
          },
        };
      });

      // ── Per-website performance ──
      const websitePerf = siteRows
        .filter((w) => siteIds.includes(w.id))
        .map((w: WebsiteRow) => {
          const mine = rows.filter((r) => r.website_id === w.id);
          const wClosed = mine.filter((r) => r.status === 'CLOSED' && inRange(r.closed_at));
          const wMissed = mine.filter((r) => r.status === 'MISSED' && inRange(r.created_at)).length;
          const wStarted = mine.filter((r) => inRange(r.created_at));
          const frt: number[] = [];
          for (const r of wStarted) {
            const s = secondsBetween(r.created_at, r.activated_at);
            if (s != null) frt.push(s);
          }
          const ratings = wClosed.filter((r) => r.rating != null).map((r) => Number(r.rating));
          return {
            id: w.id,
            name: w.label?.trim() || w.name, // show the agent-facing chip label
            color: w.primary_color,
            chats: wStarted.length,
            missed: wMissed,
            avgReplySeconds: avg(frt),
            resolutionRate: pct(wClosed.length, wClosed.length + wMissed),
            csat:
              ratings.length > 0
                ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
                : null,
          };
        })
        .sort((a, b) => b.chats - a.chats);

      // ── 14-day trend (count + avg FRT + avg duration per day) ──
      const byDay = new Map<string, { count: number; frt: number[]; dur: number[] }>();
      for (const r of trendRows) {
        const key = dayKey(r.created_at);
        const e = byDay.get(key) ?? { count: 0, frt: [], dur: [] };
        e.count += 1;
        const f = secondsBetween(r.created_at, r.activated_at);
        if (f != null) e.frt.push(f);
        if (r.status === 'CLOSED') {
          const d = secondsBetween(r.activated_at, r.closed_at);
          if (d != null) e.dur.push(d);
        }
        byDay.set(key, e);
      }
      const trend: { day: string; count: number }[] = [];
      const trendDetail: {
        day: string;
        count: number;
        frtSeconds: number | null;
        durationSeconds: number | null;
        replySeconds: number | null;
      }[] = [];
      for (let i = trendWindow - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const e = byDay.get(key);
        trend.push({ day: key, count: e?.count ?? 0 });
        trendDetail.push({
          day: key,
          count: e?.count ?? 0,
          frtSeconds: e ? avg(e.frt) : null,
          durationSeconds: e ? avg(e.dur) : null,
          replySeconds: avg(replyByDay.get(key) ?? []),
        });
      }

      // ── Yesterday (for vs-yesterday deltas + insights) ──
      const yFrt: number[] = [];
      let yChats = 0;
      let yClosed = 0;
      let yMissed = 0;
      for (const r of yesterdayRows) {
        const startedY = r.created_at >= yesterdayStart && r.created_at < todayStart;
        if (startedY) {
          yChats += 1;
          if (r.status === 'MISSED') yMissed += 1;
          const s = secondsBetween(r.created_at, r.activated_at);
          if (s != null) yFrt.push(s);
        }
        if (r.status === 'CLOSED' && r.closed_at && r.closed_at >= yesterdayStart && r.closed_at < todayStart) {
          yClosed += 1;
        }
      }

      const countryTotal = countryRows.reduce((a, b) => a + Number(b.n), 0);
      res.json({
        range,
        totals,
        avgFirstResponseSeconds: avg(frtAll),
        csat,
        perAgent,
        trend,
        tiles,
        outcomes,
        byHour,
        trendDetail: trendMode === 'hour' ? hourTrend : trendDetail,
        csatDist,
        funnel,
        countries: countryRows.map((c) => ({
          country: c.country,
          cc: c.cc,
          n: Number(c.n),
          pct: pct(Number(c.n), countryTotal) ?? 0,
        })),
        topics,
        websitePerf,
        yesterdayFrtSeconds: avg(yFrt),
        yesterday: { chats: yChats, closed: yClosed, missed: yMissed, frtSeconds: avg(yFrt) },
        trendWindow,
        trendMode,
      });
    }),
  );

  // GET /api/reports/records?from=&to=&agentId=&websiteId=&status= — LEAD/ADMIN
  // Flat conversation rows for the table view + CSV export.
  router.get(
    '/api/reports/records',
    auth,
    requireRole('ADMIN', 'MANAGER', 'LEAD', 'CSR'),
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
        res.json({ records: [], total: 0 });
        return;
      }

      let where = `c.website_id IN (${placeholders(siteIds.length)})`;
      const params: unknown[] = [...siteIds];

      const from = asString(req.query.from); // ISO date (yyyy-mm-dd) inclusive
      const to = asString(req.query.to); // inclusive (end of day)
      if (from) {
        where += ' AND c.created_at >= ?';
        params.push(`${from}T00:00:00.000Z`);
      }
      if (to) {
        where += ' AND c.created_at <= ?';
        params.push(`${to}T23:59:59.999Z`);
      }
      // A CSR may only pull their own records. A Team Lead may pull records for
      // self + own CSRs (plus unassigned queue).
      if (user.role === 'CSR') {
        where += ' AND c.assigned_user_id = ?';
        params.push(user.id);
      } else {
        const leadScope =
          user.role === 'LEAD'
            ? (
                await deps.db.all<{ id: string }>(
                  'SELECT id FROM users WHERE id = ? OR team_lead_id = ?',
                  [user.id, user.id],
                )
              ).map((r) => r.id)
            : null;

        const agentId = asString(req.query.agentId);
        if (agentId) {
          if (leadScope && !leadScope.includes(agentId)) throw new HttpError(403, 'Forbidden');
          where += ' AND c.assigned_user_id = ?';
          params.push(agentId);
        } else if (leadScope) {
          where += ` AND (c.assigned_user_id IN (${placeholders(leadScope.length)}) OR c.assigned_user_id IS NULL)`;
          params.push(...leadScope);
        }
      }
      const status = asString(req.query.status);
      if (status) {
        where += ' AND c.status = ?';
        params.push(status);
      }

      const rows = await deps.db.all<{
        id: string;
        created_at: string;
        activated_at: string | null;
        closed_at: string | null;
        status: string;
        rating: number | null;
        rating_comment: string | null;
        website_name: string;
        agent_name: string | null;
        visitor_name: string | null;
        visitor_email: string | null;
        msgs: number;
      }>(
        `SELECT c.id, c.created_at, c.activated_at, c.closed_at, c.status, c.rating, c.rating_comment,
                COALESCE(NULLIF(w.label, ''), w.name) AS website_name,
                u.name AS agent_name,
                v.name AS visitor_name, v.email AS visitor_email,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msgs
           FROM conversations c
           JOIN websites w ON w.id = c.website_id
           LEFT JOIN users u ON u.id = c.assigned_user_id
           LEFT JOIN visitors v ON v.id = c.visitor_id
          WHERE ${where}
          ORDER BY c.created_at DESC
          LIMIT 2000`,
        params,
      );

      const records = rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        status: r.status,
        website: r.website_name,
        agent: r.agent_name,
        visitor: r.visitor_name || (r.visitor_email ?? null),
        visitorEmail: r.visitor_email,
        firstResponseSeconds: secondsBetween(r.created_at, r.activated_at),
        durationSeconds: secondsBetween(r.activated_at, r.closed_at),
        messages: Number(r.msgs),
        rating: r.rating != null ? Number(r.rating) : null,
        ratingComment: r.rating_comment,
      }));
      res.json({ records, total: records.length });
    }),
  );

  return router;
}
