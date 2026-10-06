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
import {
  addMeasures,
  bucketIso,
  emptyMeasures,
  loadOverviewStats,
  type Measures,
} from '../../features/stats/index.js';

// Business "day" boundary — Pakistan NOON (12:00 PKT = 07:00 UTC), not midnight.
// A support day runs noon→noon so overnight shifts aren't split by a midnight
// reset. Computed explicitly in PKT (UTC+5, no DST) so it's correct no matter
// what timezone the server runs in.
const PKT_OFFSET_MS = 5 * 3600_000;
const DAY_MS = 24 * 3600_000;

/** ISO timestamp of the most-recent 12:00-PKT boundary, shifted back `daysAgo` days. */
function pktDayStart(daysAgo = 0): string {
  const nowPktWall = Date.now() + PKT_OFFSET_MS; // ms in the PKT wall-clock frame
  const d = new Date(nowPktWall);
  // Anchor to 12:00 on the PKT calendar date (UTC getters read the shifted wall clock).
  let boundaryWall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0);
  if (nowPktWall < boundaryWall) boundaryWall -= DAY_MS; // before noon → yesterday's noon
  boundaryWall -= daysAgo * DAY_MS;
  return new Date(boundaryWall - PKT_OFFSET_MS).toISOString(); // convert back to real UTC
}

/** Lower + optional upper bound for a range. `until` is set only for bounded
 *  windows (yesterday = the previous noon-PKT business day); open-ended ranges
 *  leave it null so they keep the simple `>= since` behavior. */
function rangeBounds(range: string): { since: string | null; until: string | null } {
  const now = new Date();
  if (range === 'today') return { since: pktDayStart(0), until: null }; // noon-PKT → now
  if (range === 'yesterday') return { since: pktDayStart(1), until: pktDayStart(0) }; // prev noon→noon
  if (range === '7d') return { since: new Date(now.getTime() - 7 * 24 * 3600_000).toISOString(), until: null };
  if (range === '30d') return { since: new Date(now.getTime() - 30 * 24 * 3600_000).toISOString(), until: null };
  return { since: null, until: null }; // all time
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
      const { since, until } = rangeBounds(range);

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
          csrClicks: 0,
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

      // Short cache of the finished payload, purely for speed. The numbers
      // themselves come from the chat_stats_hourly aggregates (features/stats),
      // which are the source of truth — the cache only saves re-reading them when
      // the same view is opened again within minutes. Keyed by the viewer (their
      // scope), the website filter and the range. "today" stays short so live
      // counters keep moving; the Refresh button bypasses it.
      const OVERVIEW_TTL_MS = range === 'today' ? 20_000 : range === 'yesterday' ? 120_000 : 300_000;
      const cacheKey = `overview:${user.id}:${websiteId || 'all'}:${range}`;
      // The Refresh button sends fresh=1 to bypass the cache and recompute now.
      const bypassCache = asString(req.query.fresh) === '1';
      if (!bypassCache) {
        const cachedPayload = await deps.cache.get<Record<string, unknown>>(cacheKey);
        if (cachedPayload) {
          res.json(cachedPayload);
          return;
        }
      }
      const payload = await compute();
      await deps.cache.set(cacheKey, payload, OVERVIEW_TTL_MS);
      res.json(payload);

      async function compute(): Promise<Record<string, unknown>> {
      const siteFilter = `website_id IN (${placeholders(siteIds.length)})`;
      const cSiteFilter = `c.website_id IN (${placeholders(siteIds.length)})`;
      // Bounded window (yesterday) needs an upper bound; open-ended ranges keep
      // the simple lower-bound form. "in range" = started OR closed in range.
      const cRangeFilter = since
        ? until
          ? ' AND ((c.created_at >= ? AND c.created_at < ?) OR (c.closed_at >= ? AND c.closed_at < ?))'
          : ' AND (c.created_at >= ? OR c.closed_at >= ?)'
        : '';
      const rangeParams = since ? (until ? [since, until, since, until] : [since, since]) : [];
      // A "conversation" only counts once the CLIENT has actually spoken. Agent
      // outreach the visitor never answered is not a real chat.
      const cEngaged = `EXISTS (SELECT 1 FROM messages em WHERE em.conversation_id = c.id AND em.sender_type = 'VISITOR')`;

      // "Today" / "yesterday" both use the noon-PKT business-day boundary so the
      // dashboard's Today counters and the vs-yesterday deltas reset at 12:00 PKT.
      const todayStart = pktDayStart(0);
      const yesterdayStart = pktDayStart(1);
      const trendWindow = range === '7d' ? 7 : range === '30d' || range === 'all' ? 30 : 14;
      const trendSince = new Date(Date.now() - trendWindow * 24 * 3600_000).toISOString();
      const visitorSince = since ?? '1970';
      // Visitor counts filter on last_seen_at >= visitorSince; a bounded window
      // (yesterday) also caps it with an upper bound.
      const vRangeSql = until ? ' AND last_seen_at < ?' : '';
      const vRangeParams = until ? [until] : [];

      // Chat numbers come from the aggregates (features/stats): closed history
      // is pre-summed per hour, only open / just-closed chats are read live.
      // Three windows: the selected range, the trend chart, and yesterday.
      // Visitors, countries and topics are unique / top-N counts that cannot be
      // summed from buckets, so they are still counted directly below.
      const [stats, liveCounts, visitorAgg, countryRows, msgRows, visitorByWebsite] = await Promise.all([
        loadOverviewStats(
          deps,
          { siteIds, agentIds: scopeIds, includeUnassigned },
          [
            { since, until },
            { since: trendSince, until: null },
            { since: yesterdayStart, until: todayStart },
          ],
          [true, false, false],
        ),
        deps.db.all<{ status: string; assigned_user_id: string | null; n: number }>(
          `SELECT status, assigned_user_id, COUNT(*) AS n FROM conversations
            WHERE ${siteFilter} AND status IN ('ACTIVE','WAITING','OFFERED')${agentFilter}
            GROUP BY status, assigned_user_id`,
          [...siteIds, ...agentParams],
        ),
        deps.db.get<{ n: number; ret: number }>(
          `SELECT COUNT(*) AS n, SUM(CASE WHEN total_visits > 1 THEN 1 ELSE 0 END) AS ret
             FROM visitors WHERE ${siteFilter} AND last_seen_at >= ?${vRangeSql}`,
          [...siteIds, visitorSince, ...vRangeParams],
        ),
        deps.db.all<{ country: string; cc: string | null; n: number }>(
          `SELECT geo_country AS country, geo_cc AS cc, COUNT(*) AS n FROM visitors
            WHERE ${siteFilter} AND last_seen_at >= ?${vRangeSql} AND geo_country IS NOT NULL
            GROUP BY geo_country, geo_cc ORDER BY n DESC LIMIT 6`,
          [...siteIds, visitorSince, ...vRangeParams],
        ),
        deps.db.all<{ cid: string; st: string; at: string; kind: string; body: string | null }>(
          `SELECT m.conversation_id AS cid, m.sender_type AS st, m.created_at AS at, m.kind, m.body
             FROM messages m JOIN conversations c ON c.id = m.conversation_id
            WHERE ${cSiteFilter}${cRangeFilter}${cAgentFilter} AND ${cEngaged}
            ORDER BY m.created_at DESC LIMIT 5000`,
          [...siteIds, ...rangeParams, ...agentParams],
        ),
        // Visitors seen per website in the range (for the dashboard's Visitors column).
        deps.db.all<{ website_id: string; n: number }>(
          `SELECT website_id, COUNT(*) AS n FROM visitors
            WHERE ${siteFilter} AND last_seen_at >= ?${vRangeSql} GROUP BY website_id`,
          [...siteIds, visitorSince, ...vRangeParams],
        ),
      ]);
      const [mainStats, trendStats, yesterdayStats] = stats.windows;

      const inRange = (iso: string | null) =>
        iso != null && (!since || iso >= since) && (!until || iso < until);
      const total = (map: Map<string, Measures>): Measures => {
        const out = emptyMeasures();
        for (const m of map.values()) addMeasures(out, m);
        return out;
      };
      // Re-key a "website|agent" map by one of its two parts.
      const regroup = (map: Map<string, Measures>, part: 0 | 1): Map<string, Measures> => {
        const out = new Map<string, Measures>();
        for (const [dim, m] of map) {
          const key = dim.split('|')[part];
          const cur = out.get(key) ?? emptyMeasures();
          addMeasures(cur, m);
          out.set(key, cur);
        }
        return out;
      };
      const avgMs = (ms: number, n: number): number | null => (n > 0 ? Math.round(ms / 1000 / n) : null);
      const ratingAvg = (m: Measures): number | null =>
        m.rating_n > 0 ? Math.round((m.rating_sum / m.rating_n) * 10) / 10 : null;
      const localHour = (bucket: string): number => new Date(bucketIso(bucket)).getHours();

      // started = chats STARTED in the range; closed = chats CLOSED in the range.
      const started = total(mainStats.startedByDim);
      const closed = total(mainStats.closedByDim);

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
      const missedCount = started.missed;
      const totals = {
        active: activeNow,
        waiting: waitingNow,
        // Closed = chats STARTED in the range that ended CLOSED — an old chat
        // merely swept closed today must not count as "closed today".
        closed: started.closed,
        missed: missedCount,
        // Engagement split: chats where the CLIENT has messaged vs ones where a
        // CSR/agent has messaged (proactive outreach counts too).
        clientChats: started.n,
        csrChats: started.csr_n,
      };

      // ── CSAT ──
      const csat = { average: ratingAvg(closed), count: closed.rating_n };
      const csatDist = [closed.r1, closed.r2, closed.r3, closed.r4, closed.r5];

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

      // ── Chats by hour of day (chat starts in range) ──
      const hourCounts = Array.from({ length: 24 }, () => 0);
      const frtByHour = Array.from({ length: 24 }, () => ({ ms: 0, n: 0 }));
      for (const [bucket, m] of mainStats.startedByHour) {
        const hh = localHour(bucket);
        hourCounts[hh] += m.n;
        frtByHour[hh].ms += m.frt_ms;
        frtByHour[hh].n += m.frt_n;
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
          frtSeconds: avgMs(frtByHour[hh].ms, frtByHour[hh].n),
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
      // Cohort = chats STARTED in the range, so the donut total matches the
      // "chats today" numbers (old chats merely swept closed today don't leak in).
      const outcomes = {
        resolved: started.closed - started.transferred,
        transferred: started.transferred,
        missed: missedCount,
        open: started.open_n,
      };

      // ── Peak 2-hour window (chat starts in range) ──
      let peakHour: { start: number; share: number } | null = null;
      const totalStarts = started.n;
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
        chats: started.n,
        answered: started.answered,
        // Same cohort as `chats` — otherwise old chats closed today make the
        // resolved step exceed the started step (6000%+ funnels).
        resolved: started.closed,
      };

      const tiles = {
        resolutionRate: pct(closed.n, closed.n + missedCount),
        avgChatDurationSeconds: avgMs(closed.dur_ms, closed.dur_n),
        avgReplySeconds: avg(replyGaps),
        peakHour,
        returningRate: pct(returning, visitorsSeen),
        conversionRate: pct(funnel.chats, visitorsSeen),
      };

      // ── Per-agent breakdown ──
      // "Handled" = the agent's chats that were answered in the range, closed in
      // the range, or are ACTIVE right now. For closed chats that is "closed in
      // range", plus — only for a bounded one-day window (yesterday) — chats
      // answered that day but closed later (`extra_*`). Open chats are checked live.
      const startedByAgent = regroup(mainStats.startedByDim, 1);
      const closedByAgent = regroup(mainStats.closedByDim, 1);
      const perAgent = agents.map((a) => {
        const sa = startedByAgent.get(a.id) ?? emptyMeasures();
        const ca = closedByAgent.get(a.id) ?? emptyMeasures();
        const openHandled = stats.openFacts.filter(
          (f) =>
            f.engaged &&
            f.assigned_user_id === a.id &&
            inRange(f.created_at) &&
            ((f.activated_at != null && inRange(f.activated_at)) || f.status === 'ACTIVE'),
        );
        let frtMs = ca.frt_ms + (until ? sa.extra_frt_ms : 0);
        let frtN = ca.frt_n + (until ? sa.extra_frt_n : 0);
        for (const f of openHandled) {
          const s = secondsBetween(f.created_at, f.activated_at);
          if (s != null) {
            frtMs += s * 1000;
            frtN += 1;
          }
        }
        return {
          user: toUserWithPresence(deps, a),
          closed: ca.n,
          active: activeByAgent.get(a.id) ?? 0,
          handled: ca.n + (until ? sa.extra_n : 0) + openHandled.length,
          // Per-agent "CSR clicks" = range-started chats this agent sent a
          // message in (outreach counts too).
          csrClicks: mainStats.clicksBySender.get(a.id) ?? 0,
          resolutionRate: pct(ca.n, ca.n + sa.missed),
          avgFirstResponseSeconds: avgMs(frtMs, frtN),
          avgDurationSeconds: avgMs(ca.dur_ms, ca.dur_n),
          rating: { average: ratingAvg(ca), count: ca.rating_n },
        };
      });

      // ── Per-website performance ──
      const visitorCount = new Map(visitorByWebsite.map((r) => [r.website_id, Number(r.n)]));
      const startedBySite = regroup(mainStats.startedByDim, 0);
      const closedBySite = regroup(mainStats.closedByDim, 0);
      const websitePerf = siteRows
        .filter((w) => siteIds.includes(w.id))
        .map((w: WebsiteRow) => {
          const sw = startedBySite.get(w.id) ?? emptyMeasures();
          const cw = closedBySite.get(w.id) ?? emptyMeasures();
          return {
            id: w.id,
            name: w.label?.trim() || w.name, // show the agent-facing chip label
            color: w.primary_color,
            chats: sw.n,
            missed: sw.missed,
            visitors: visitorCount.get(w.id) ?? 0,
            avgReplySeconds: avgMs(sw.frt_ms, sw.frt_n),
            resolutionRate: pct(cw.n, cw.n + sw.missed),
            csat: ratingAvg(cw),
          };
        })
        // Most chats first; break ties (e.g. all the 0-chat sites) by visitors,
        // so the busier-by-traffic website still ranks higher.
        .sort((a, b) => b.chats - a.chats || b.visitors - a.visitors);

      // ── 14-day trend (count + avg FRT + avg duration per day) ──
      const byDay = new Map<string, Measures>();
      for (const [bucket, m] of trendStats.startedByHour) {
        const key = dayKey(bucketIso(bucket));
        const cur = byDay.get(key) ?? emptyMeasures();
        addMeasures(cur, m);
        byDay.set(key, cur);
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
        trend.push({ day: key, count: e?.n ?? 0 });
        trendDetail.push({
          day: key,
          count: e?.n ?? 0,
          frtSeconds: e ? avgMs(e.frt_ms, e.frt_n) : null,
          durationSeconds: e ? avgMs(e.dur_ms, e.dur_n) : null,
          replySeconds: e ? avgMs(e.frt_ms, e.frt_n) : null,
        });
      }

      // ── Yesterday (for vs-yesterday deltas + insights) ──
      const y = total(yesterdayStats.startedByHour);
      const yFrtSeconds = avgMs(y.frt_ms, y.frt_n);

      const countryTotal = countryRows.reduce((a, b) => a + Number(b.n), 0);
      const payload = {
        range,
        totals,
        avgFirstResponseSeconds: avgMs(started.frt_ms, started.frt_n),
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
        yesterdayFrtSeconds: yFrtSeconds,
        // Mirror totals.closed: count chats STARTED yesterday that ended CLOSED.
        yesterday: { chats: y.n, closed: y.closed, missed: y.missed, frtSeconds: yFrtSeconds },
        trendWindow,
        trendMode,
      };
      return payload;
      }
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
        params.push(new Date(`${from}T00:00:00`).toISOString()); // server-local midnight, matches the dashboard range
      }
      if (to) {
        where += ' AND c.created_at <= ?';
        params.push(new Date(`${to}T23:59:59.999`).toISOString());
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

      // Step 1: pick ONLY the ids of the newest matching chats. Doing the joins
      // and the per-chat message COUNT in the same query made the database
      // compute them for every matching chat before the LIMIT (tens of
      // thousands), which is why this report took many seconds.
      const ids = (
        await deps.db.all<{ id: string }>(
          `SELECT c.id FROM conversations c WHERE ${where} ORDER BY c.created_at DESC LIMIT 2000`,
          params,
        )
      ).map((r) => r.id);

      // Step 2: details + message counts for just those chats.
      const [rows, counts] =
        ids.length === 0
          ? [[], []]
          : await Promise.all([
              deps.db.all<{
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
              }>(
                `SELECT c.id, c.created_at, c.activated_at, c.closed_at, c.status, c.rating, c.rating_comment,
                        COALESCE(NULLIF(w.label, ''), w.name) AS website_name,
                        u.name AS agent_name,
                        v.name AS visitor_name, v.email AS visitor_email
                   FROM conversations c
                   JOIN websites w ON w.id = c.website_id
                   LEFT JOIN users u ON u.id = c.assigned_user_id
                   LEFT JOIN visitors v ON v.id = c.visitor_id
                  WHERE c.id IN (${placeholders(ids.length)})`,
                ids,
              ),
              deps.db.all<{ cid: string; n: number }>(
                `SELECT conversation_id AS cid, COUNT(*) AS n FROM messages
                  WHERE conversation_id IN (${placeholders(ids.length)}) AND kind <> 'SYSTEM'
                  GROUP BY conversation_id`,
                ids,
              ),
            ]);
      // Keep step 1's order (newest first).
      const position = new Map(ids.map((id, i) => [id, i]));
      rows.sort((x, y) => (position.get(x.id) ?? 0) - (position.get(y.id) ?? 0));
      const msgCount = new Map(counts.map((c) => [c.cid, Number(c.n)]));

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
        messages: msgCount.get(r.id) ?? 0,
        rating: r.rating != null ? Number(r.rating) : null,
        ratingComment: r.rating_comment,
      }));
      res.json({ records, total: records.length });
    }),
  );

  return router;
}
