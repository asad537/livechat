import React, { useEffect, useMemo, useState } from 'react';
import type { Visitor } from '@livechat/shared';
import { useApp } from '../state';
import { api } from '../api';
import { formatWhen, pageLabel, referrerLabel, siteLabel, uaParse } from '../util';
import {
  IconAndroid,
  IconApple,
  IconChrome,
  IconGlobe,
  IconSearch,
  IconUsers,
  IconWindows,
} from '../icons';

const browserIcon = (browser: string) =>
  browser === 'Chrome' ? <IconChrome size={13} /> : <IconGlobe size={12} />;
const osIcon = (os: string) => {
  if (os === 'macOS' || os === 'iOS') return <IconApple size={13} />;
  if (os === 'Windows') return <IconWindows size={12} />;
  if (os === 'Android') return <IconAndroid size={13} />;
  return null;
};

const PAGE = 25;

/**
 * Admin-only "Source" view — where every visitor came from: which website,
 * their landing (entry) page, the referrer, device and when. Paginated archive.
 */
export default function Source() {
  const { websites } = useApp();
  const siteById = useMemo(() => new Map(websites.map((w) => [w.id, w])), [websites]);
  const [rows, setRows] = useState<Visitor[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const [websiteId, setWebsiteId] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(() => {
      void api
        .visitorHistory({
          limit: PAGE,
          offset: page * PAGE,
          q: query.trim() || undefined,
          websiteId: websiteId || undefined,
        })
        .then((r) => {
          if (cancelled) return;
          setRows(r.visitors);
          setTotal(r.total);
        })
        .catch(() => {
          if (!cancelled) setRows([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [page, query, websiteId]);

  // Reset to the first page whenever the filters change.
  useEffect(() => {
    setPage(0);
  }, [query, websiteId]);

  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="page visitors-page">
      <div className="page-head">
        <div>
          <h2>Source</h2>
          <p className="page-sub">
            Where every visitor came from — {total.toLocaleString()} total
          </p>
        </div>
      </div>

      <div className="rec-filters card">
        <label className="rec-field rec-field-grow">
          <span>Search</span>
          <span className="conv-search">
            <IconSearch size={15} />
            <input
              type="search"
              placeholder="Search name, email, IP, city…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </span>
        </label>
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
      </div>

      {rows.length > 0 ? (
        <div className="card vt-card">
          <table className="table vt-table">
            <thead>
              <tr>
                <th>Website</th>
                <th>Landing Page</th>
                <th>Came from</th>
                <th>Device</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const ua = uaParse(v.userAgent);
                const site = siteById.get(v.websiteId);
                return (
                  <tr key={v.id} className="vt-row">
                    <td className="vt-site">
                      {site ? (
                        <span className="vt-site-chip">
                          <span className="chip-dot" style={{ background: site.primaryColor }} />
                          {siteLabel(site)}
                        </span>
                      ) : (
                        <span className="vt-muted">—</span>
                      )}
                    </td>
                    <td className="vt-page">
                      {v.landingPage ? (
                        <span className="vt-page-url" title={v.landingPage}>
                          {pageLabel(v.landingPage)}
                        </span>
                      ) : (
                        <span className="vt-muted">—</span>
                      )}
                    </td>
                    <td className="vt-referrer">{referrerLabel(v.referrer)}</td>
                    <td className="vt-tech">
                      {v.userAgent ? (
                        <>
                          <span className="vt-dev">
                            {browserIcon(ua.browser)} {ua.browser}
                          </span>
                          <span className="vt-dev">
                            {osIcon(ua.os)} {ua.os}
                          </span>
                        </>
                      ) : (
                        <span className="vt-muted">—</span>
                      )}
                    </td>
                    <td className="vt-sub">{formatWhen(v.lastSeenAt) || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state card">
          <IconUsers size={32} className="empty-state-icon" />
          <p>{loading ? 'Loading…' : 'No visitors match these filters'}</p>
        </div>
      )}

      {total > PAGE && (
        <div className="vt-pager">
          <span className="vt-pager-info">
            Showing {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} of {total}
          </span>
          <div className="vt-pager-btns">
            <button
              className="vt-pager-btn"
              disabled={page === 0 || loading}
              onClick={() => setPage((p) => p - 1)}
            >
              ‹
            </button>
            <span className="vt-pager-info">
              {page + 1} / {pages}
            </span>
            <button
              className="vt-pager-btn"
              disabled={page >= pages - 1 || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              ›
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
