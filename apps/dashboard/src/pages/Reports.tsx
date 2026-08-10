import React, { useCallback, useEffect, useState } from 'react';
import { api, type ReportRange, type ReportsOverview } from '../api';
import { useApp } from '../state';
import Avatar from '../components/Avatar';
import { classNames, flagEmoji, formatSeconds } from '../util';

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

// Outcome donut — fixed categorical order and colors.
const OUTCOME_META = [
  { key: 'resolved', label: 'Resolved', color: '#7c3aed' },
  { key: 'transferred', label: 'Transferred', color: '#0ea5e9' },
  { key: 'open', label: 'Still open', color: '#f59e0b' },
  { key: 'missed', label: 'Missed', color: '#ef4444' },
] as const;

const hourLabel = (h: number): string => {
  const ampm = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh} ${ampm}`;
};

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString([], { weekday: 'short' }).slice(0, 2);
}

function dayFull(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function StatTile({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
  icon?: string;
}) {
  const long = typeof value === 'string' && value.length > 8;
  return (
    <div className={classNames('card stat-card rp-tile', tone && `stat-${tone}`)}>
      <div className="rp-tile-top">
        <span className={classNames('stat-value', long && 'stat-value-sm')}>{value}</span>
        {icon && <span className="rp-tile-icon">{icon}</span>}
      </div>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/** Two-series line chart (SVG) for the 14-day response trend. */
function TrendLines({ detail }: { detail: NonNullable<ReportsOverview['trendDetail']> }) {
  const W = 320;
  const H = 130;
  const PAD = 8;
  const frt = detail.map((d) => d.frtSeconds ?? null);
  const dur = detail.map((d) => d.durationSeconds ?? null);
  const max = Math.max(60, ...frt.filter((v): v is number => v != null), ...dur.filter((v): v is number => v != null));
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / Math.max(1, detail.length - 1);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const path = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
      .filter(Boolean)
      .join(' ');
  const hasAny = frt.some((v) => v != null) || dur.some((v) => v != null);
  if (!hasAny) return <p className="rp-empty">No response data yet.</p>;
  return (
    <>
      <div className="rp-legend">
        <span>
          <i className="rp-swatch" style={{ background: '#7c3aed' }} /> Avg first response
        </span>
        <span>
          <i className="rp-swatch" style={{ background: '#0ea5e9' }} /> Avg chat duration
        </span>
        <span className="rp-legend-max">peak {formatSeconds(max)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="rp-lines" preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={PAD}
            x2={W - PAD}
            y1={PAD + f * (H - PAD * 2)}
            y2={PAD + f * (H - PAD * 2)}
            stroke="#e2e8f0"
            strokeWidth="1"
            strokeDasharray="3 4"
          />
        ))}
        <polyline points={path(frt)} fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinejoin="round" />
        <polyline points={path(dur)} fill="none" stroke="#0ea5e9" strokeWidth="2" strokeLinejoin="round" />
        {detail.map((d, i) =>
          d.frtSeconds != null ? (
            <circle key={`f${i}`} cx={x(i)} cy={y(d.frtSeconds)} r="2.6" fill="#7c3aed">
              <title>{`${dayFull(d.day)} — first response ${formatSeconds(d.frtSeconds)}`}</title>
            </circle>
          ) : null,
        )}
        {detail.map((d, i) =>
          d.durationSeconds != null ? (
            <circle key={`d${i}`} cx={x(i)} cy={y(d.durationSeconds)} r="2.6" fill="#0ea5e9">
              <title>{`${dayFull(d.day)} — duration ${formatSeconds(d.durationSeconds)}`}</title>
            </circle>
          ) : null,
        )}
      </svg>
      <div className="rp-lines-x">
        <span>{dayFull(detail[0].day)}</span>
        <span>{dayFull(detail[Math.floor(detail.length / 2)].day)}</span>
        <span>{dayFull(detail[detail.length - 1].day)}</span>
      </div>
    </>
  );
}

/** Donut chart via SVG stroke arcs. */
function OutcomeDonut({ outcomes }: { outcomes: NonNullable<ReportsOverview['outcomes']> }) {
  const total = OUTCOME_META.reduce((s, m) => s + outcomes[m.key], 0);
  if (total === 0) return <p className="rp-empty">No chats in this period.</p>;
  const R = 44;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="rp-donut-row">
      <svg viewBox="0 0 120 120" className="rp-donut">
        {OUTCOME_META.map((m) => {
          const frac = outcomes[m.key] / total;
          const seg = (
            <circle
              key={m.key}
              cx="60"
              cy="60"
              r={R}
              fill="none"
              stroke={m.color}
              strokeWidth="14"
              strokeDasharray={`${Math.max(0, frac * C - 2)} ${C}`}
              strokeDashoffset={-offset * C}
              transform="rotate(-90 60 60)"
              strokeLinecap="butt"
            >
              <title>{`${m.label}: ${outcomes[m.key]}`}</title>
            </circle>
          );
          offset += frac;
          return seg;
        })}
        <text x="60" y="57" textAnchor="middle" className="rp-donut-total">
          {total}
        </text>
        <text x="60" y="73" textAnchor="middle" className="rp-donut-sub">
          Total chats
        </text>
      </svg>
      <div className="rp-donut-legend">
        {OUTCOME_META.map((m) => (
          <div key={m.key} className="rp-donut-item">
            <i className="rp-swatch" style={{ background: m.color }} />
            <span className="rp-donut-label">{m.label}</span>
            <span className="rp-donut-val">
              {total > 0 ? Math.round((outcomes[m.key] / total) * 100) : 0}% ({outcomes[m.key]})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Reports() {
  const { websites, online } = useApp();
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

  // ── Insights strip (computed from real data) ──
  const insights: { icon: string; title: string; sub: string }[] = [];
  if (data) {
    if (peak && data.totals.closed + data.totals.active + data.totals.waiting > 0) {
      insights.push({
        icon: '📊',
        title: `${hourLabel(peak.start)} – ${hourLabel(peak.start + 2)}`,
        sub: `Peak traffic · ${peak.share}% of chats`,
      });
    }
    const best = perAgent.find((a) => a.handled > 0);
    if (best) {
      insights.push({
        icon: '🏆',
        title: best.user.name,
        sub: `Best performer · ${best.handled} chats${best.resolutionRate != null ? ` · ${best.resolutionRate}% resolved` : ''}`,
      });
    }
    if (data.avgFirstResponseSeconds != null && data.yesterdayFrtSeconds != null && data.yesterdayFrtSeconds > 0) {
      const diff = Math.round(
        ((data.yesterdayFrtSeconds - data.avgFirstResponseSeconds) / data.yesterdayFrtSeconds) * 100,
      );
      insights.push({
        icon: '⚡',
        title: `${Math.abs(diff)}% ${diff >= 0 ? 'faster' : 'slower'}`,
        sub: 'First response vs yesterday',
      });
    }
    const worstSite = [...(data.websitePerf ?? [])]
      .filter((w) => w.chats + w.missed > 0 && w.missed > 0)
      .sort((a, b) => b.missed / (b.chats + b.missed) - a.missed / (a.chats + a.missed))[0];
    if (worstSite) {
      insights.push({
        icon: '⚠️',
        title: worstSite.name,
        sub: `Attention needed · ${worstSite.missed} missed chat${worstSite.missed === 1 ? '' : 's'}`,
      });
    }
    if (topics[0]) {
      insights.push({
        icon: '💬',
        title: topics[0].word,
        sub: `Most common topic · ${topics[0].pct}% of words`,
      });
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Reports</h2>
          <p className="page-sub">Team performance — {RANGE_HINT[range]}.</p>
        </div>
        <div className="filters">
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
                {w.name}
              </option>
            ))}
          </select>
          <button className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? '…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}
      {loading && !data && <div className="empty-hint">Loading reports…</div>}

      {data && (
        <>
          {/* ── Tiles row 1 ── */}
          <div className="stat-grid">
            <StatTile label="Active now" value={data.totals.active} tone="active" icon="📈" />
            <StatTile label="In queue" value={data.totals.waiting} tone="waiting" icon="🕐" />
            <StatTile label="Closed" value={data.totals.closed} tone="closed" icon="✅" />
            <StatTile label="Missed" value={data.totals.missed} tone="missed" icon="📉" />
            <StatTile label="Avg first response" value={formatSeconds(data.avgFirstResponseSeconds)} icon="⏱️" />
            <StatTile
              label={`CSAT (${data.csat?.count ?? 0} rating${(data.csat?.count ?? 0) === 1 ? '' : 's'})`}
              value={
                data.csat?.average != null ? (
                  <>
                    {data.csat.average.toFixed(1)}
                    <span className="rp-tile-suffix">/5</span>
                  </>
                ) : (
                  '—'
                )
              }
              tone="csat"
              icon="⭐"
            />
          </div>

          {/* ── Tiles row 2 ── */}
          <div className="stat-grid">
            <StatTile
              label="Resolution rate"
              value={tiles?.resolutionRate != null ? `${tiles.resolutionRate}%` : '—'}
              icon="🎯"
            />
            <StatTile label="Avg chat duration" value={formatSeconds(tiles?.avgChatDurationSeconds)} icon="⏳" />
            <StatTile label="Avg response time" value={formatSeconds(tiles?.avgReplySeconds)} icon="💨" />
            <StatTile
              label="Peak hours"
              value={peak ? `${hourLabel(peak.start)} – ${hourLabel(peak.start + 2)}` : '—'}
              icon="🕑"
            />
            <StatTile
              label="Returning visitors"
              value={tiles?.returningRate != null ? `${tiles.returningRate}%` : '—'}
              icon="🔁"
            />
            <StatTile
              label="Visitor → chat rate"
              value={tiles?.conversionRate != null ? `${tiles.conversionRate}%` : '—'}
              icon="📬"
            />
          </div>

          {/* ── 14-day volume ── */}
          <div className="card report-card">
            <h3>Chats per day — last 14 days</h3>
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

          {/* ── Trend / outcomes / by-hour ── */}
          <div className="rp-cards3">
            <div className="card report-card">
              <h3>
                Response time trend <span className="report-hint">— last 14 days</span>
              </h3>
              <TrendLines detail={data.trendDetail ?? []} />
            </div>
            <div className="card report-card">
              <h3>
                Chat outcomes <span className="report-hint">— {RANGE_HINT[range]}</span>
              </h3>
              <OutcomeDonut
                outcomes={data.outcomes ?? { resolved: 0, transferred: 0, missed: 0, open: 0 }}
              />
            </div>
            <div className="card report-card">
              <h3>
                Chats by hour <span className="report-hint">— today</span>
              </h3>
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
                        className={classNames(
                          'rp-hour-col',
                          peak && h >= peak.start && h < peak.start + 2 && 'peak',
                        )}
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
                <p className="rp-empty">No chats today yet.</p>
              )}
            </div>
          </div>

          {/* ── Leaderboard + website performance ── */}
          <div className="rp-cards2">
            <div className="card report-card">
              <h3>
                Agent leaderboard <span className="report-hint">— {RANGE_HINT[range]}</span>
              </h3>
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
                            <Avatar
                              name={row.user.name}
                              color={row.user.avatarColor}
                              url={row.user.avatarUrl}
                              size="sm"
                            />
                            <span className="lb-user-meta">
                              <span className="lb-user-name">
                                {row.user.name}
                                <span
                                  className={classNames('dot', online[row.user.id] ? 'dot-online' : 'dot-offline')}
                                />
                              </span>
                              <span className="lb-bar-track">
                                <span
                                  className="lb-bar-fill"
                                  style={{ width: `${Math.max(2, (row.handled / maxHandled) * 100)}%` }}
                                />
                              </span>
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
              <h3>
                Website performance <span className="report-hint">— {RANGE_HINT[range]}</span>
              </h3>
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

          {/* ── Topics / CSAT / funnel / countries ── */}
          <div className="rp-cards4">
            <div className="card report-card">
              <h3>
                Top chat topics <span className="report-hint">— visitor keywords</span>
              </h3>
              {topics.length === 0 && <p className="rp-empty">No messages yet.</p>}
              {topics.map((t) => (
                <div className="rp-topic" key={t.word}>
                  <span className="rp-topic-name">{t.word}</span>
                  <span className="rp-topic-track">
                    <span className="rp-topic-fill" style={{ width: `${Math.max(3, t.pct)}%` }} />
                  </span>
                  <span className="rp-topic-val">{t.pct}%</span>
                </div>
              ))}
            </div>

            <div className="card report-card">
              <h3>Customer satisfaction</h3>
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
              <h3>
                Visitor → chat funnel <span className="report-hint">— {RANGE_HINT[range]}</span>
              </h3>
              {funnel && funnel.visitors + funnel.chats > 0 ? (
                <div className="rp-funnel">
                  {(
                    [
                      ['Visitors', funnel.visitors, '#c4b5fd'],
                      ['Started chat', funnel.chats, '#a78bfa'],
                      ['Answered', funnel.answered, '#8b5cf6'],
                      ['Resolved', funnel.resolved, '#7c3aed'],
                    ] as const
                  ).map(([label, n, color], i, arr) => {
                    const top = arr[0][1] || 1;
                    const prev = i > 0 ? arr[i - 1][1] : null;
                    return (
                      <div className="rp-funnel-row" key={label}>
                        <div
                          className="rp-funnel-bar"
                          style={{ width: `${Math.max(14, (n / top) * 100)}%`, background: color }}
                        >
                          {n.toLocaleString()}
                        </div>
                        <span className="rp-funnel-label">
                          {label}
                          {prev != null && prev > 0 && (
                            <em> {Math.round((n / prev) * 100)}%</em>
                          )}
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
              <h3>
                Visitors by country <span className="report-hint">— {RANGE_HINT[range]}</span>
              </h3>
              {countries.length === 0 && <p className="rp-empty">No location data yet.</p>}
              {countries.map((c) => (
                <div className="rp-topic" key={c.country}>
                  <span className="rp-topic-name rp-country">
                    {flagEmoji(c.cc)} {c.country}
                  </span>
                  <span className="rp-topic-track">
                    <span className="rp-topic-fill" style={{ width: `${Math.max(3, c.pct)}%` }} />
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
    </div>
  );
}
