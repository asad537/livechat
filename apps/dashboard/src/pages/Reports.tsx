import React, { useCallback, useEffect, useState } from 'react';
import { api, type ReportRange, type ReportsOverview } from '../api';
import { useApp } from '../state';
import { classNames, formatSeconds, initials } from '../util';

function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className={classNames('card stat-card', tone && `stat-${tone}`)}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

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

function trendLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString([], { weekday: 'short' }).slice(0, 2);
}

function trendTitle(day: string, count: number): string {
  const d = new Date(`${day}T00:00:00`);
  const label = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${label} — ${count} chat${count === 1 ? '' : 's'}`;
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
          <div className="stat-grid">
            <StatCard label="Active now" value={data.totals.active} tone="active" />
            <StatCard label="In queue" value={data.totals.waiting} tone="waiting" />
            <StatCard label="Closed" value={data.totals.closed} tone="closed" />
            <StatCard label="Missed" value={data.totals.missed} tone="missed" />
            <StatCard label="Avg first response" value={formatSeconds(data.avgFirstResponseSeconds)} />
            <StatCard
              label={`CSAT (${data.csat?.count ?? 0} rating${(data.csat?.count ?? 0) === 1 ? '' : 's'})`}
              value={data.csat?.average != null ? `★ ${data.csat.average.toFixed(1)}` : '—'}
              tone="csat"
            />
          </div>

          {/* 14-day chat volume */}
          <div className="card report-card">
            <h3>Chats per day — last 14 days</h3>
            <div className="trend-chart">
              {trend.map((t) => (
                <div
                  key={t.day}
                  className={classNames('trend-col', t.day === todayKey && 'today')}
                  title={trendTitle(t.day, t.count)}
                >
                  {(t.count === maxTrend || t.day === todayKey) && t.count > 0 && (
                    <span className="trend-count">{t.count}</span>
                  )}
                  <div
                    className="trend-bar"
                    style={{ height: `${Math.max(3, (t.count / maxTrend) * 100)}%` }}
                  />
                  <span className="trend-day">{trendLabel(t.day)}</span>
                </div>
              ))}
              {trend.length === 0 && <div className="empty-hint">No data yet.</div>}
            </div>
          </div>

          {/* Agent leaderboard */}
          <div className="card report-card">
            <h3>
              Agent leaderboard <span className="report-hint">— chats handled {RANGE_HINT[range]}</span>
            </h3>
            <table className="table lb-table">
              <thead>
                <tr>
                  <th className="lb-rank">#</th>
                  <th>Agent</th>
                  <th>Status</th>
                  <th className="num">Chats</th>
                  <th className="num">Closed</th>
                  <th className="num">Active now</th>
                  <th className="num">Avg first reply</th>
                  <th className="num">Avg duration</th>
                  <th className="num">Rating</th>
                </tr>
              </thead>
              <tbody>
                {perAgent.map((row, i) => (
                  <tr key={row.user.id} className={classNames(i === 0 && row.handled > 0 && 'lb-top')}>
                    <td className="lb-rank">
                      {i === 0 && row.handled > 0 ? '🏆' : i + 1}
                    </td>
                    <td>
                      <span className="cell-user">
                        <span className="avatar avatar-sm" style={{ background: row.user.avatarColor }}>
                          {initials(row.user.name)}
                        </span>
                        <span className="lb-user-meta">
                          <span className="lb-user-name">{row.user.name}</span>
                          <span className="lb-bar-track">
                            <span
                              className="lb-bar-fill"
                              style={{ width: `${Math.max(2, (row.handled / maxHandled) * 100)}%` }}
                            />
                          </span>
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className={classNames('dot', online[row.user.id] ? 'dot-online' : 'dot-offline')} />
                      {online[row.user.id] ? ' Online' : ' Offline'}
                    </td>
                    <td className="num lb-strong">{row.handled}</td>
                    <td className="num">{row.closed}</td>
                    <td className="num">{row.active}</td>
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
                {perAgent.length === 0 && (
                  <tr>
                    <td colSpan={9} className="empty-hint">
                      No data yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
