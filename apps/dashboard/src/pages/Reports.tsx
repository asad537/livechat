import React, { useCallback, useEffect, useState } from 'react';
import { api, type ReportsOverview } from '../api';
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

export default function Reports() {
  const { websites, online } = useApp();
  const [websiteId, setWebsiteId] = useState('');
  const [data, setData] = useState<ReportsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.reports(websiteId || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, [websiteId]);

  useEffect(() => {
    void load();
  }, [load]);

  const perAgent = data?.perAgent ?? [];
  const maxClosed = Math.max(1, ...perAgent.map((a) => a.closed));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Reports</h2>
          <p className="page-sub">Team performance at a glance.</p>
        </div>
        <div className="filters">
          <select value={websiteId} onChange={(e) => setWebsiteId(e.target.value)}>
            <option value="">All websites</option>
            {websites.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <button className="btn btn-ghost btn-sm" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}
      {loading && !data && <div className="empty-hint">Loading reports…</div>}

      {data && (
        <>
          <div className="stat-grid">
            <StatCard label="Active" value={data.totals.active} tone="active" />
            <StatCard label="Waiting" value={data.totals.waiting} tone="waiting" />
            <StatCard label="Closed" value={data.totals.closed} tone="closed" />
            <StatCard label="Missed" value={data.totals.missed} tone="missed" />
            <StatCard label="Avg first response" value={formatSeconds(data.avgFirstResponseSeconds)} />
            <StatCard
              label={`CSAT (${data.csat?.count ?? 0} rating${(data.csat?.count ?? 0) === 1 ? '' : 's'})`}
              value={data.csat?.average != null ? `★ ${data.csat.average.toFixed(1)}` : '—'}
              tone="csat"
            />
          </div>

          <div className="card report-card">
            <h3>Closed conversations by agent</h3>
            {perAgent.length === 0 && <div className="empty-hint">No agent activity yet.</div>}
            <div className="bar-chart">
              {perAgent.map((row) => (
                <div key={row.user.id} className="bar-row">
                  <span className="bar-label">
                    <span className="avatar avatar-sm" style={{ background: row.user.avatarColor }}>
                      {initials(row.user.name)}
                    </span>
                    {row.user.name}
                  </span>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{ width: `${Math.max(2, (row.closed / maxClosed) * 100)}%` }}
                    />
                  </div>
                  <span className="bar-value">{row.closed}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card report-card">
            <h3>Per-agent breakdown</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Role</th>
                  <th className="num">Active chats</th>
                  <th className="num">Closed</th>
                </tr>
              </thead>
              <tbody>
                {perAgent.map((row) => (
                  <tr key={row.user.id}>
                    <td>
                      <span className="cell-user">
                        <span className="avatar avatar-sm" style={{ background: row.user.avatarColor }}>
                          {initials(row.user.name)}
                        </span>
                        {row.user.name}
                      </span>
                    </td>
                    <td>
                      <span className={classNames('dot', online[row.user.id] ? 'dot-online' : 'dot-offline')} />
                      {online[row.user.id] ? ' Online' : ' Offline'}
                    </td>
                    <td>{row.user.role}</td>
                    <td className="num">{row.active}</td>
                    <td className="num">{row.closed}</td>
                  </tr>
                ))}
                {perAgent.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty-hint">
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
