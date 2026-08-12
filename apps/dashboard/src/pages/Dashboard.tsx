import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type ReportRange, type ReportsOverview } from '../api';
import { useApp } from '../state';
import Avatar from '../components/Avatar';
import { AreaChart, Donut, OutcomeDonut, TrendLines, hourLabel } from '../components/charts';
import {
  IconAlert,
  IconCalendar,
  IconChart,
  IconCheckCircle,
  IconClock,
  IconGlobe,
  IconMessage,
  IconPhoneOff,
  IconUser,
  IconUsers,
} from '../icons';
import { classNames, formatSeconds } from '../util';

const RANGE_HINT: Record<ReportRange, string> = {
  today: 'today',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  all: 'all time',
};

function Delta({ now, before, invert }: { now: number; before: number; invert?: boolean }) {
  if (before <= 0 && now <= 0) return <span className="db-delta db-delta-flat">— vs yesterday</span>;
  if (before <= 0) return <span className="db-delta db-delta-up">new today</span>;
  const diff = Math.round(((now - before) / before) * 100);
  if (diff === 0) return <span className="db-delta db-delta-flat">same as yesterday</span>;
  const good = invert ? diff < 0 : diff > 0;
  return (
    <span className={classNames('db-delta', good ? 'db-delta-up' : 'db-delta-down')}>
      {diff > 0 ? '↑' : '↓'} {Math.abs(diff)}% vs yesterday
    </span>
  );
}

function Tile({
  label,
  value,
  icon,
  tint,
  color,
  delta,
}: {
  label: string;
  value: React.ReactNode;
  icon: React.ReactNode;
  tint: string;
  color: string;
  delta?: React.ReactNode;
}) {
  return (
    <div className="card db-tile">
      <div className="db-tile-row">
        <div className="db-tile-meta">
          <span className="db-tile-label">{label}</span>
          <span className="db-tile-value">{value}</span>
        </div>
        <span className="db-tile-icon" style={{ background: tint, color }}>
          {icon}
        </span>
      </div>
      {delta}
    </div>
  );
}

export default function Dashboard() {
  const { websites, me, connected } = useApp();
  const navigate = useNavigate();
  const [websiteId, setWebsiteId] = useState('');
  const [range, setRange] = useState<ReportRange>('today');
  const [data, setData] = useState<ReportsOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.reports(websiteId || undefined, range));
    } catch {
      /* toast-free dashboard; Reports page surfaces errors */
    } finally {
      setLoading(false);
    }
  }, [websiteId, range]);

  useEffect(() => {
    void load();
  }, [load]);

  // After a sleep/reconnect the initial fetch may have failed while offline —
  // reload once the socket is back and whenever the tab regains focus so the
  // dashboard can't get stuck on "Loading…".
  useEffect(() => {
    if (!connected) return;
    void load();
    const onFocus = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [connected, load]);

  const today = new Date().toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const y = data?.yesterday;
  const tiles = data?.tiles;
  const peak = tiles?.peakHour ?? null;
  const byHour = data?.byHour ?? [];
  const maxHour = Math.max(1, ...byHour);
  const topics = (data?.topics ?? []).slice(0, 6);
  const funnel = data?.funnel;
  const perAgent = [...(data?.perAgent ?? [])].sort((a, b) => b.handled - a.handled).slice(0, 5);
  const sites = data?.websitePerf ?? [];
  const todayChats = data ? data.totals.closed + data.totals.active + data.totals.waiting : 0;
  const tw = data?.trendWindow ?? 14;

  const SITE_COLORS = ['#5865f2', '#0ea5e9', '#f59e0b', '#db2777', '#10b981', '#6366f1'];

  const insights: { icon: React.ReactNode; title: string; sub: string }[] = [];
  if (data) {
    if (peak && todayChats > 0) {
      insights.push({
        icon: <IconChart size={18} />,
        title: `${hourLabel(peak.start)} – ${hourLabel(peak.start + 2)}`,
        sub: `Peak traffic · ${peak.share}% of chats`,
      });
    }
    const best = perAgent.find((a) => a.handled > 0);
    if (best) {
      insights.push({ icon: <IconUser size={18} />, title: best.user.name, sub: `Best performer · ${best.handled} chats` });
    }
    if (data.avgFirstResponseSeconds != null && y?.frtSeconds != null && y.frtSeconds > 0) {
      const diff = Math.round(((y.frtSeconds - data.avgFirstResponseSeconds) / y.frtSeconds) * 100);
      insights.push({
        icon: <IconClock size={18} />,
        title: `${Math.abs(diff)}% ${diff >= 0 ? 'faster' : 'slower'}`,
        sub: 'First response vs yesterday',
      });
    }
    const worst = [...sites].filter((w) => w.missed > 0).sort((a, b) => b.missed - a.missed)[0];
    if (worst) {
      insights.push({ icon: <IconAlert size={18} />, title: worst.name, sub: `Attention needed · ${worst.missed} missed` });
    }
    if (topics[0]) {
      insights.push({ icon: <IconMessage size={18} />, title: topics[0].word, sub: `Most common topic · ${topics[0].pct}%` });
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Dashboard</h2>
          <p className="page-sub">
            Salaam {me?.name?.split(' ')[0]} — overview of your live chat performance.
          </p>
        </div>
        <div className="filters">
          <span className="db-date">
            <IconCalendar size={15} />
            <select
              className="db-date-select"
              value={range}
              onChange={(e) => setRange(e.target.value as ReportRange)}
            >
              <option value="today">Today ({today})</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="all">All time</option>
            </select>
          </span>
          <select value={websiteId} onChange={(e) => setWebsiteId(e.target.value)}>
            <option value="">All websites</option>
            {websites.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <button className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? '…' : 'Refresh'}
          </button>
        </div>
      </div>

      {!data && loading && <div className="empty-hint">Loading dashboard…</div>}

      {data && (
        <>
          {/* ── Tiles ── */}
          <div className="db-tiles">
            <Tile label="Active chats" value={data.totals.active} icon={<IconMessage size={17} />} tint="#dcfce7" color="#16a34a" />
            <Tile label="In queue" value={data.totals.waiting} icon={<IconUsers size={17} />} tint="#ffedd5" color="#ea580c" />
            <Tile
              label="Closed chats"
              value={data.totals.closed}
              icon={<IconCheckCircle size={17} />}
              tint="#dbeafe"
              color="#2563eb"
              delta={y ? <Delta now={data.totals.closed} before={y.closed} /> : undefined}
            />
            <Tile
              label="Missed chats"
              value={data.totals.missed}
              icon={<IconPhoneOff size={17} />}
              tint="#fee2e2"
              color="#dc2626"
              delta={y ? <Delta now={data.totals.missed} before={y.missed} invert /> : undefined}
            />
            <Tile
              label="Avg first response"
              value={formatSeconds(data.avgFirstResponseSeconds)}
              icon={<IconClock size={17} />}
              tint="#ede9fe"
              color="#5865f2"
              delta={
                data.avgFirstResponseSeconds != null && y?.frtSeconds != null ? (
                  <Delta now={data.avgFirstResponseSeconds} before={y.frtSeconds} invert />
                ) : undefined
              }
            />
            <Tile
              label="Total visitors"
              value={(data.funnel?.visitors ?? 0).toLocaleString()}
              icon={<IconGlobe size={17} />}
              tint="#dbeafe"
              color="#2563eb"
              delta={
                <span className="db-delta db-delta-flat">
                  {RANGE_HINT[range]}
                </span>
              }
            />
          </div>

          {/* ── Chats over time + donuts ── */}
          <div className="db-row-main db-stretch">
            <div className="card report-card db-span2">
              <h3>
                Chats over time <span className="report-hint">— last {tw} days</span>
              </h3>
              <AreaChart trend={data.trend ?? []} />
            </div>
            <div className="card report-card">
              <h3>
                Chats by website <span className="report-hint">— {RANGE_HINT[range]}</span>
              </h3>
              <Donut
                segments={sites
                  .filter((s) => s.chats > 0)
                  .map((s, i) => ({ label: s.name, value: s.chats, color: SITE_COLORS[i % SITE_COLORS.length] }))}
                centerLabel={String(sites.reduce((a, s) => a + s.chats, 0))}
                centerSub="Total"
              />
            </div>
            <div className="card report-card">
              <h3>
                Chats by status <span className="report-hint">— {RANGE_HINT[range]}</span>
              </h3>
              <OutcomeDonut outcomes={data.outcomes ?? { resolved: 0, transferred: 0, missed: 0, open: 0 }} />
            </div>
          </div>

          {/* ── Trend / hours / topics / funnel ── */}
          <div className="rp-cards4 db-stretch db-row3">
            <div className="card report-card">
              <div className="db-card-head">
                <h3>Response Time Trend</h3>
                <span className="db-chip-select">{range === 'today' ? 'Today · hourly' : `Last ${tw} days`}</span>
              </div>
              <TrendLines detail={data.trendDetail ?? []} mode={data.trendMode ?? 'day'} />
            </div>
            <div className="card report-card">
              <h3>
                Chats by Hour <span className="report-hint">({RANGE_HINT[range]})</span>
              </h3>
              {byHour.some((n) => n > 0) ? (
                <>
                  {peak && (
                    <div className="rp-peak-chip db-peak-float">
                      {hourLabel(peak.start)} – {hourLabel(peak.start + 2)}
                      <b>{byHour[peak.start] + (byHour[peak.start + 1] ?? 0)} Chats (Peak)</b>
                    </div>
                  )}
                  <div className="chart-with-y">
                    <div className="chart-y db-hours-y">
                      <span>{maxHour}</span>
                      <span>{Math.round(maxHour / 2)}</span>
                      <span>0</span>
                    </div>
                    <div className="chart-body">
                      <div className="rp-hours">
                        {byHour.map((n, h) => (
                          <div
                            key={h}
                            className={classNames('rp-hour-col', peak && h >= peak.start && h < peak.start + 2 && 'peak')}
                            title={`${hourLabel(h)} — ${n} chat${n === 1 ? '' : 's'}`}
                          >
                            <div className="rp-hour-bar" style={{ height: `${Math.max(4, (n / maxHour) * 100)}%` }} />
                          </div>
                        ))}
                      </div>
                      <div className="rp-hours-x">
                        <span>12 AM</span>
                        <span>4 AM</span>
                        <span>8 AM</span>
                        <span>12 PM</span>
                        <span>4 PM</span>
                        <span>8 PM</span>
                        <span>12 AM</span>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <p className="rp-empty">No chats in this period yet.</p>
              )}
            </div>
            <div className="card report-card">
              <h3>Visitor to Chat Funnel</h3>
              <p className="db-card-sub">
                {range === 'today' ? 'Since midnight' : RANGE_HINT[range]}
              </p>
              {funnel && funnel.visitors + funnel.chats > 0 ? (
                <div className="db-funnel">
                  {(
                    [
                      ['Visitors', funnel.visitors, '#a78bfa'],
                      ['Started chat', funnel.chats, '#7dd3fc'],
                      ['Answered', funnel.answered, '#5eead4'],
                      ['Resolved', funnel.resolved, '#6ee7b7'],
                    ] as const
                  ).map(([label, n, color], i, arr) => {
                    const TAPER = [100, 82, 66, 52];
                    const prev = i > 0 ? arr[i - 1][1] : null;
                    return (
                      <div className="db-funnel-row" key={label}>
                        <div
                          className="db-funnel-bar"
                          style={{ width: `${TAPER[i]}%`, background: color }}
                        >
                          {n.toLocaleString()}
                        </div>
                        <span className="db-funnel-side">
                          <b>{label}</b>
                          {prev != null && prev > 0 && <em>{Math.round((n / prev) * 100)}%</em>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="rp-empty">No visitors yet today.</p>
              )}
            </div>
          </div>

          {/* ── Performance + insights ── */}
          <div className="db-row-bottom db-stretch">
            <div className="card report-card">
              <div className="db-card-head">
                <h3>
                  Agent performance <span className="report-hint">— {RANGE_HINT[range]}</span>
                </h3>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/reports')}>
                  View all
                </button>
              </div>
              <div className="rp-scroll-x">
                <table className="table lb-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th className="num">Chats</th>
                      <th className="num">Res. rate</th>
                      <th className="num">Avg reply</th>
                      <th className="num">Rating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perAgent.map((row) => (
                      <tr key={row.user.id}>
                        <td>
                          <span className="cell-user">
                            <Avatar name={row.user.name} color={row.user.avatarColor} url={row.user.avatarUrl} size="sm" />
                            {row.user.name}
                          </span>
                        </td>
                        <td className="num lb-strong">{row.handled}</td>
                        <td className="num">{row.resolutionRate != null ? `${row.resolutionRate}%` : '—'}</td>
                        <td className="num">{formatSeconds(row.avgFirstResponseSeconds)}</td>
                        <td className="num">
                          {row.rating.average != null ? <span className="lb-rating">★ {row.rating.average.toFixed(1)}</span> : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card report-card">
              <div className="db-card-head">
                <h3>
                  Website performance <span className="report-hint">— {RANGE_HINT[range]}</span>
                </h3>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/reports')}>
                  View all
                </button>
              </div>
              <div className="rp-scroll-x">
                <table className="table lb-table">
                  <thead>
                    <tr>
                      <th>Website</th>
                      <th className="num">Chats</th>
                      <th className="num">Missed</th>
                      <th className="num">Avg reply</th>
                      <th className="num">CSAT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sites.map((w) => (
                      <tr key={w.id}>
                        <td>
                          <span className="vt-site-chip">
                            <span className="chip-dot" style={{ background: w.color }} />
                            {w.name}
                          </span>
                        </td>
                        <td className="num lb-strong">{w.chats}</td>
                        <td className="num">{w.missed}</td>
                        <td className="num">{formatSeconds(w.avgReplySeconds)}</td>
                        <td className="num">{w.csat != null ? <span className="lb-rating">★ {w.csat.toFixed(1)}</span> : '—'}</td>
                      </tr>
                    ))}
                    {sites.length === 0 && (
                      <tr>
                        <td colSpan={5} className="empty-hint">
                          No data yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {insights.length > 0 && (
              <div className="rp-insights card db-insights">
                <h3>✨ {range === 'today' ? "Today's" : 'Period'} insights</h3>
                <div className="db-insights-col">
                  {insights.map((ins) => (
                    <div className="rp-insight" key={ins.sub}>
                      <span className="rp-insight-icon">{ins.icon}</span>
                      <div>
                        <div className="rp-insight-title">{ins.title}</div>
                        <div className="rp-insight-sub">{ins.sub}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
