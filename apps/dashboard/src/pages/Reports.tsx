import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { UserPublic } from '@livechat/shared';
import { api, type ReportRange, type ReportRecord, type ReportsOverview } from '../api';
import { useApp } from '../state';
import Avatar from '../components/Avatar';
import {
  IconAlert,
  IconChart,
  IconCheckCircle,
  IconClock,
  IconMessage,
  IconPhoneOff,
  IconStar,
  IconUsers,
} from '../icons';
import { OutcomeDonut, TrendLines, dayFull, dayLabel, hourLabel } from '../components/charts';
import { classNames, flagEmoji, formatSeconds, siteLabel } from '../util';

const RANGES: { key: ReportRange; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All time' },
];

const RANGE_HINT: Record<ReportRange, string> = {
  today: 'since midnight',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  all: 'all time',
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="rp-section-label">{children}</div>;
}

function Delta({ now, before, invert }: { now: number; before: number; invert?: boolean }) {
  if (before <= 0 && now <= 0) return null;
  if (before <= 0) return <span className="rp-delta rp-delta-up">new</span>;
  const diff = Math.round(((now - before) / before) * 100);
  if (diff === 0) return <span className="rp-delta rp-delta-flat">no change</span>;
  const good = invert ? diff < 0 : diff > 0;
  return (
    <span className={classNames('rp-delta', good ? 'rp-delta-up' : 'rp-delta-down')}>
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
  foot,
}: {
  label: string;
  value: React.ReactNode;
  icon: React.ReactNode;
  tint: string;
  color: string;
  foot?: React.ReactNode;
}) {
  const long = typeof value === 'string' && value.length > 8;
  return (
    <div className="rp-kpi">
      <div className="rp-kpi-top">
        <span className="rp-kpi-label">{label}</span>
        <span className="rp-kpi-icon" style={{ background: tint, color }}>
          {icon}
        </span>
      </div>
      <span className={classNames('rp-kpi-value', long && 'rp-kpi-value-sm')}>{value}</span>
      {foot ? <div className="rp-kpi-foot">{foot}</div> : <div className="rp-kpi-foot rp-kpi-foot-empty" />}
    </div>
  );
}

function CardHead({ title, hint, right }: { title: string; hint?: string; right?: React.ReactNode }) {
  return (
    <div className="rp-card-head">
      <h3>
        {title}
        {hint && <span className="report-hint"> — {hint}</span>}
      </h3>
      {right}
    </div>
  );
}

export default function Reports() {
  const { websites, online, me } = useApp();
  const isCsr = me?.role === 'CSR';
  const [view, setView] = useState<'overview' | 'records'>('overview');
  const [websiteId, setWebsiteId] = useState('');
  const [range, setRange] = useState<ReportRange>('today');
  const [data, setData] = useState<ReportsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.reports(websiteId || undefined, range));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, [websiteId, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const perAgent = [...(data?.perAgent ?? [])].sort((a, b) => b.handled - a.handled);
  const maxHandled = Math.max(1, ...perAgent.map((a) => a.handled));
  const trend = data?.trend ?? [];
  const maxTrend = Math.max(1, ...trend.map((t) => t.count));
  const todayKey = trend[trend.length - 1]?.day;
  const tiles = data?.tiles;
  const byHour = data?.byHour ?? [];
  const maxHour = Math.max(1, ...byHour);
  const peak = tiles?.peakHour ?? null;
  const funnel = data?.funnel;
  const topics = data?.topics ?? [];
  const countries = data?.countries ?? [];
  const csatDist = data?.csatDist ?? [0, 0, 0, 0, 0];
  const csatTotal = csatDist.reduce((a, b) => a + b, 0);
  const y = data?.yesterday;

  // ── Insights strip (computed from real data) ──
  const insights: { icon: React.ReactNode; title: string; sub: string }[] = [];
  if (data) {
    if (peak && data.totals.closed + data.totals.active + data.totals.waiting > 0) {
      insights.push({
        icon: <IconChart size={18} />,
        title: `${hourLabel(peak.start)} – ${hourLabel(peak.start + 2)}`,
        sub: `Peak traffic · ${peak.share}% of chats`,
      });
    }
    const best = perAgent.find((a) => a.handled > 0);
    if (best) {
      insights.push({
        icon: <IconStar size={18} />,
        title: best.user.name,
        sub: `Best performer · ${best.handled} chats${best.resolutionRate != null ? ` · ${best.resolutionRate}% resolved` : ''}`,
      });
    }
    if (data.avgFirstResponseSeconds != null && y?.frtSeconds != null && y.frtSeconds > 0) {
      const diff = Math.round(((y.frtSeconds - data.avgFirstResponseSeconds) / y.frtSeconds) * 100);
      insights.push({
        icon: <IconClock size={18} />,
        title: `${Math.abs(diff)}% ${diff >= 0 ? 'faster' : 'slower'}`,
        sub: 'First response vs yesterday',
      });
    }
    const worstSite = [...(data.websitePerf ?? [])]
      .filter((w) => w.chats + w.missed > 0 && w.missed > 0)
      .sort((a, b) => b.missed / (b.chats + b.missed) - a.missed / (a.chats + a.missed))[0];
    if (worstSite) {
      insights.push({
        icon: <IconAlert size={18} />,
        title: worstSite.name,
        sub: `Attention needed · ${worstSite.missed} missed chat${worstSite.missed === 1 ? '' : 's'}`,
      });
    }
    if (topics[0]) {
      insights.push({
        icon: <IconMessage size={18} />,
        title: topics[0].word,
        sub: `Most common topic · ${topics[0].pct}% of words`,
      });
    }
  }

  return (
    <div className="page rp-page">
      <div className="page-head">
        <div>
          <h2>Reports</h2>
          <p className="page-sub">
            {view === 'overview' ? `Team performance — ${RANGE_HINT[range]}.` : 'Filter and export raw chat records.'}
          </p>
        </div>
        <div className="filters">
          <div className="range-pills">
            <button
              className={classNames('range-pill', view === 'overview' && 'active')}
              onClick={() => setView('overview')}
            >
              Overview
            </button>
            <button
              className={classNames('range-pill', view === 'records' && 'active')}
              onClick={() => setView('records')}
            >
              Records
            </button>
          </div>
          {view === 'overview' && (
            <>
              <div className="range-pills">
                {RANGES.map((r) => (
                  <button
                    key={r.key}
                    className={classNames('range-pill', range === r.key && 'active')}
                    onClick={() => setRange(r.key)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <select value={websiteId} onChange={(e) => setWebsiteId(e.target.value)}>
                <option value="">All websites</option>
                {websites.map((w) => (
                  <option key={w.id} value={w.id}>
                    {siteLabel(w)}
                  </option>
                ))}
              </select>
              <button className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
                {loading ? '…' : 'Refresh'}
              </button>
            </>
          )}
        </div>
      </div>

      {view === 'records' && <RecordsView websites={websites} hideAgentFilter={isCsr} />}
      {view === 'overview' && (
        <>
      {error && <div className="form-error">{error}</div>}
      {loading && !data && <div className="empty-hint">Loading reports…</div>}

      {data && (
        <>
          {/* ── Overview ── */}
          <SectionLabel>Overview</SectionLabel>
          <div className="rp-kpis">
            <Tile
              label="Active now"
              value={data.totals.active}
              icon={<IconMessage size={18} />}
              tint="#dcfce7"
              color="#16a34a"
            />
            <Tile
              label="In queue"
              value={data.totals.waiting}
              icon={<IconUsers size={18} />}
              tint="#ffedd5"
              color="#ea580c"
            />
            <Tile
              label="Closed"
              value={data.totals.closed}
              icon={<IconCheckCircle size={18} />}
              tint="#dbeafe"
              color="#2563eb"
              foot={y ? <Delta now={data.totals.closed} before={y.closed} /> : undefined}
            />
            <Tile
              label="Missed"
              value={data.totals.missed}
              icon={<IconPhoneOff size={18} />}
              tint="#fee2e2"
              color="#dc2626"
              foot={y ? <Delta now={data.totals.missed} before={y.missed} invert /> : undefined}
            />
            <Tile
              label="Avg first response"
              value={formatSeconds(data.avgFirstResponseSeconds)}
              icon={<IconClock size={18} />}
              tint="#ede9fe"
              color="#5865f2"
              foot={
                data.avgFirstResponseSeconds != null && y?.frtSeconds != null ? (
                  <Delta now={data.avgFirstResponseSeconds} before={y.frtSeconds} invert />
                ) : undefined
              }
            />
            <Tile
              label="CSAT"
              value={
                data.csat?.average != null ? (
                  <>
                    {data.csat.average.toFixed(1)}
                    <span className="rp-kpi-suffix">/5</span>
                  </>
                ) : (
                  '—'
                )
              }
              icon={<IconStar size={18} />}
              tint="#fef3c7"
              color="#d97706"
              foot={
                <span className="rp-kpi-muted">
                  {data.csat?.count ?? 0} rating{(data.csat?.count ?? 0) === 1 ? '' : 's'}
                </span>
              }
            />
          </div>

          {/* ── Performance ── */}
          <SectionLabel>Performance &amp; audience</SectionLabel>
          <div className="rp-kpis">
            <Tile
              label="Resolution rate"
              value={tiles?.resolutionRate != null ? `${tiles.resolutionRate}%` : '—'}
              icon={<IconChart size={18} />}
              tint="#f3e8ff"
              color="#9333ea"
            />
            <Tile
              label="Avg chat duration"
              value={formatSeconds(tiles?.avgChatDurationSeconds)}
              icon={<IconClock size={18} />}
              tint="#ede9fe"
              color="#5865f2"
            />
            <Tile
              label="Avg response time"
              value={formatSeconds(tiles?.avgReplySeconds)}
              icon={<IconClock size={18} />}
              tint="#dbeafe"
              color="#2563eb"
            />
            <Tile
              label="Peak hours"
              value={peak ? `${hourLabel(peak.start)} – ${hourLabel(peak.start + 2)}` : '—'}
              icon={<IconClock size={18} />}
              tint="#f3e8ff"
              color="#9333ea"
            />
            <Tile
              label="Returning visitors"
              value={tiles?.returningRate != null ? `${tiles.returningRate}%` : '—'}
              icon={<IconUsers size={18} />}
              tint="#dcfce7"
              color="#16a34a"
            />
            <Tile
              label="Visitor → chat rate"
              value={tiles?.conversionRate != null ? `${tiles.conversionRate}%` : '—'}
              icon={<IconAlert size={18} />}
              tint="#ffedd5"
              color="#ea580c"
            />
          </div>

          {/* ── Trends ── */}
          <SectionLabel>Trends</SectionLabel>
          <div className="card report-card">
            <CardHead title="Chats over time" hint={`last ${data.trendWindow ?? 14} days`} />
            <div className="trend-wrap">
              <div className="trend-y">
                <span>{maxTrend}</span>
                <span>{Math.round(maxTrend / 2)}</span>
                <span>0</span>
              </div>
              <div className="trend-chart trend-grid">
                {trend.map((t) => (
                  <div
                    key={t.day}
                    className={classNames('trend-col', t.day === todayKey && 'today')}
                    title={`${dayFull(t.day)} — ${t.count} chat${t.count === 1 ? '' : 's'}`}
                  >
                    {(t.count === maxTrend || t.day === todayKey) && t.count > 0 && (
                      <span className="trend-count">{t.count}</span>
                    )}
                    <div className="trend-bar" style={{ height: `${Math.max(3, (t.count / maxTrend) * 100)}%` }} />
                    <span className="trend-day">{dayLabel(t.day)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rp-cards3 db-stretch">
            <div className="card report-card">
              <CardHead
                title="Response time trend"
                hint={range === 'today' ? 'today, hourly' : `last ${data.trendWindow ?? 14} days`}
              />
              <TrendLines detail={data.trendDetail ?? []} mode={data.trendMode ?? 'day'} />
            </div>
            <div className="card report-card">
              <CardHead title="Chat outcomes" hint={RANGE_HINT[range]} />
              <OutcomeDonut outcomes={data.outcomes ?? { resolved: 0, transferred: 0, missed: 0, open: 0 }} />
            </div>
            <div className="card report-card">
              <CardHead title="Chats by hour" hint={RANGE_HINT[range]} />
              {byHour.some((n) => n > 0) ? (
                <>
                  {peak && (
                    <div className="rp-peak-chip">
                      {hourLabel(peak.start)} – {hourLabel(peak.start + 2)} · peak time
                    </div>
                  )}
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
                    <span>6 AM</span>
                    <span>12 PM</span>
                    <span>6 PM</span>
                    <span>12 AM</span>
                  </div>
                </>
              ) : (
                <p className="rp-empty">No chats in this period yet.</p>
              )}
            </div>
          </div>

          {/* ── Team & websites ── */}
          <SectionLabel>Team &amp; websites</SectionLabel>
          <div className="rp-cards2 db-stretch">
            <div className="card report-card">
              <CardHead title={isCsr ? 'Your performance' : 'Agent leaderboard'} hint={RANGE_HINT[range]} />
              <div className="rp-scroll-x">
                <table className="table lb-table">
                  <thead>
                    <tr>
                      <th className="lb-rank">#</th>
                      <th>Agent</th>
                      <th className="num">Chats</th>
                      <th className="num">Resolution</th>
                      <th className="num">Avg reply</th>
                      <th className="num">Avg duration</th>
                      <th className="num">Rating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perAgent.map((row, i) => (
                      <tr key={row.user.id} className={classNames(i === 0 && row.handled > 0 && 'lb-top')}>
                        <td className="lb-rank">{i === 0 && row.handled > 0 ? '🏆' : i + 1}</td>
                        <td>
                          <span className="cell-user">
                            <Avatar name={row.user.name} color={row.user.avatarColor} url={row.user.avatarUrl} size="sm" />
                            <span className="lb-user-meta">
                              <span className="lb-user-name">
                                {row.user.name}
                                <span className={classNames('dot', online[row.user.id] ? 'dot-online' : 'dot-offline')} />
                              </span>
                              {row.handled > 0 && (
                                <span className="lb-bar-track">
                                  <span
                                    className="lb-bar-fill"
                                    style={{ width: `${Math.max(2, (row.handled / maxHandled) * 100)}%` }}
                                  />
                                </span>
                              )}
                            </span>
                          </span>
                        </td>
                        <td className="num lb-strong">{row.handled}</td>
                        <td className="num">{row.resolutionRate != null ? `${row.resolutionRate}%` : '—'}</td>
                        <td className="num">{formatSeconds(row.avgFirstResponseSeconds)}</td>
                        <td className="num">{formatSeconds(row.avgDurationSeconds)}</td>
                        <td className="num">
                          {row.rating.average != null ? (
                            <span className="lb-rating">★ {row.rating.average.toFixed(1)}</span>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card report-card">
              <CardHead title="Website performance" hint={RANGE_HINT[range]} />
              <div className="rp-scroll-x">
                <table className="table lb-table">
                  <thead>
                    <tr>
                      <th>Website</th>
                      <th className="num">Chats</th>
                      <th className="num">Missed</th>
                      <th className="num">Avg reply</th>
                      <th className="num">Resolution</th>
                      <th className="num">CSAT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.websitePerf ?? []).map((w) => (
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
                        <td className="num">{w.resolutionRate != null ? `${w.resolutionRate}%` : '—'}</td>
                        <td className="num">
                          {w.csat != null ? <span className="lb-rating">★ {w.csat.toFixed(1)}</span> : '—'}
                        </td>
                      </tr>
                    ))}
                    {(data.websitePerf ?? []).length === 0 && (
                      <tr>
                        <td colSpan={6} className="empty-hint">
                          No data yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ── Audience ── */}
          <SectionLabel>Conversations &amp; audience</SectionLabel>
          <div className="rp-cards4 db-stretch">
            <div className="card report-card">
              <CardHead title="Top chat topics" hint="visitor keywords" />
              {topics.length === 0 && <p className="rp-empty">No messages yet.</p>}
              {topics.map((t) => (
                <div className="rp-topic" key={t.word}>
                  <span className="rp-topic-name">{t.word}</span>
                  <span className="rp-topic-track">
                    <span
                      className="rp-topic-fill"
                      style={{ width: `${Math.max(6, (t.pct / Math.max(1, topics[0]?.pct ?? 1)) * 88)}%` }}
                    />
                  </span>
                  <span className="rp-topic-val">{t.pct}%</span>
                </div>
              ))}
            </div>

            <div className="card report-card">
              <CardHead title="Customer satisfaction" />
              {csatTotal === 0 ? (
                <p className="rp-empty">No ratings yet.</p>
              ) : (
                <>
                  <div className="rp-csat-head">
                    <span className="rp-csat-big">{data.csat.average?.toFixed(1)}</span>
                    <span className="rp-csat-of">/5</span>
                    <span className="rp-csat-stars">
                      {'★'.repeat(Math.round(data.csat.average ?? 0))}
                      {'☆'.repeat(5 - Math.round(data.csat.average ?? 0))}
                    </span>
                  </div>
                  <p className="rp-csat-count">{csatTotal} ratings</p>
                  {[4, 3, 2, 1, 0].map((i) => (
                    <div className="rp-topic" key={i}>
                      <span className="rp-topic-name">{i + 1} ★</span>
                      <span className="rp-topic-track">
                        <span
                          className="rp-topic-fill rp-csat-fill"
                          style={{ width: `${Math.max(2, (csatDist[i] / csatTotal) * 100)}%` }}
                        />
                      </span>
                      <span className="rp-topic-val">
                        {Math.round((csatDist[i] / csatTotal) * 100)}% ({csatDist[i]})
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>

            <div className="card report-card">
              <CardHead title="Visitor → chat funnel" hint={RANGE_HINT[range]} />
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
                        <div className="db-funnel-bar" style={{ width: `${TAPER[i]}%`, background: color }}>
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
                <p className="rp-empty">No visitors in this period.</p>
              )}
            </div>

            <div className="card report-card">
              <CardHead title="Visitors by country" hint={RANGE_HINT[range]} />
              {countries.length === 0 && <p className="rp-empty">No location data yet.</p>}
              {countries.map((c) => (
                <div className="rp-topic" key={c.country}>
                  <span className="rp-topic-name rp-country">
                    {flagEmoji(c.cc)} {c.country}
                  </span>
                  <span className="rp-topic-track">
                    <span
                      className="rp-topic-fill"
                      style={{ width: `${Math.max(6, (c.pct / Math.max(1, countries[0]?.pct ?? 1)) * 88)}%` }}
                    />
                  </span>
                  <span className="rp-topic-val">{c.pct}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* ── Insights strip ── */}
          {insights.length > 0 && (
            <div className="rp-insights card">
              <h3>✨ {range === 'today' ? "Today's" : 'Period'} insights</h3>
              <div className="rp-insights-row">
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
        </>
      )}
        </>
      )}
    </div>
  );
}

// ─── Records view: filter + table + CSV export ───────────────
function fmtSecs(s: number | null): string {
  if (s == null) return '';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function RecordsView({
  websites,
  hideAgentFilter,
}: {
  websites: { id: string; name: string }[];
  hideAgentFilter?: boolean;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 24 * 3600_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);
  const [agentId, setAgentId] = useState('');
  const [websiteId, setWebsiteId] = useState('');
  const [status, setStatus] = useState('');
  const [agents, setAgents] = useState<UserPublic[]>([]);
  const [rows, setRows] = useState<ReportRecord[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (hideAgentFilter) return;
    void api.users().then(setAgents).catch(() => setAgents([]));
  }, [hideAgentFilter]);

  const run = useCallback(() => {
    setLoading(true);
    void api
      .reportRecords({
        from,
        to,
        agentId: agentId || undefined,
        websiteId: websiteId || undefined,
        status: status || undefined,
      })
      .then((r) => setRows(r.records))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [from, to, agentId, websiteId, status]);

  useEffect(() => {
    run();
  }, [run]);

  const agentName = useMemo(
    () => agents.find((a) => a.id === agentId)?.name ?? 'all-agents',
    [agents, agentId],
  );

  const exportCsv = () => {
    if (!rows || rows.length === 0) return;
    const head = [
      'Date',
      'Time',
      'Website',
      'Agent',
      'Visitor',
      'Email',
      'Status',
      'First response',
      'Duration',
      'Messages',
      'Rating',
      'Comment',
    ];
    const esc = (v: string | number | null) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map((r) => {
      const d = new Date(r.createdAt);
      return [
        d.toLocaleDateString(),
        d.toLocaleTimeString(),
        r.website,
        r.agent ?? '',
        r.visitor ?? '',
        r.visitorEmail ?? '',
        r.status,
        fmtSecs(r.firstResponseSeconds),
        fmtSecs(r.durationSeconds),
        r.messages,
        r.rating ?? '',
        r.ratingComment ?? '',
      ]
        .map(esc)
        .join(',');
    });
    const csv = [head.join(','), ...lines].join('\n');
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-records_${agentName.replace(/\s+/g, '-')}_${from}_to_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rp-records">
      <div className="card report-card rec-filters">
        <label className="rec-field">
          <span>From</span>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="rec-field">
          <span>To</span>
          <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
        </label>
        {!hideAgentFilter && (
          <label className="rec-field">
            <span>Agent</span>
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="rec-field">
          <span>Website</span>
          <select value={websiteId} onChange={(e) => setWebsiteId(e.target.value)}>
            <option value="">All websites</option>
            {websites.map((w) => (
              <option key={w.id} value={w.id}>
                {siteLabel(w)}
              </option>
            ))}
          </select>
        </label>
        <label className="rec-field">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            <option value="CLOSED">Closed</option>
            <option value="ACTIVE">Active</option>
            <option value="WAITING">Waiting</option>
            <option value="MISSED">Missed</option>
          </select>
        </label>
        <div className="rec-actions">
          <button className="btn btn-ghost btn-sm" onClick={run} disabled={loading}>
            {loading ? '…' : 'Apply'}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={exportCsv}
            disabled={!rows || rows.length === 0}
          >
            ⭳ Export CSV
          </button>
        </div>
      </div>

      <div className="card report-card">
        <CardHead
          title="Chat records"
          right={<span className="report-hint">{rows ? `${rows.length} record${rows.length === 1 ? '' : 's'}` : ''}</span>}
        />
        <div className="rp-scroll-x">
          <table className="table lb-table rec-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Website</th>
                <th>Agent</th>
                <th>Visitor</th>
                <th>Status</th>
                <th className="num">First reply</th>
                <th className="num">Duration</th>
                <th className="num">Msgs</th>
                <th className="num">Rating</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((r) => {
                const d = new Date(r.createdAt);
                return (
                  <tr key={r.id}>
                    <td className="rec-date">
                      {d.toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      <span className="rec-time">{d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </td>
                    <td>{r.website}</td>
                    <td>{r.agent ?? <span className="vt-muted">—</span>}</td>
                    <td>{r.visitor ?? <span className="vt-muted">Anonymous</span>}</td>
                    <td>
                      <span className={classNames('status-badge', `status-${r.status.toLowerCase()}`)}>
                        {r.status}
                      </span>
                    </td>
                    <td className="num">{fmtSecs(r.firstResponseSeconds) || '—'}</td>
                    <td className="num">{fmtSecs(r.durationSeconds) || '—'}</td>
                    <td className="num">{r.messages}</td>
                    <td className="num">
                      {r.rating != null ? <span className="lb-rating">★ {r.rating}</span> : '—'}
                    </td>
                  </tr>
                );
              })}
              {rows && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="empty-hint">
                    No records for these filters.
                  </td>
                </tr>
              )}
              {!rows && (
                <tr>
                  <td colSpan={9} className="empty-hint">
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
