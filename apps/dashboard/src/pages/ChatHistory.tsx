import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { ConversationStatus, UserPublic } from '@livechat/shared';
import { api, type ChatHistoryRow } from '../api';
import { useApp } from '../state';
import { StatusPill } from '../components/ConversationList';
import { IconClock, IconSearch, IconStar, IconUsers } from '../icons';
import { classNames, formatSeconds, formatWhen, initials, siteLabel, visitorNumber } from '../util';

function pageNumbers(total: number, current: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const wanted = [...new Set([0, total - 1, current - 1, current, current + 1])]
    .filter((p) => p >= 0 && p < total)
    .sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  for (let i = 0; i < wanted.length; i++) {
    if (i > 0 && wanted[i] - wanted[i - 1] > 1) out.push('…');
    out.push(wanted[i]);
  }
  return out;
}

export default function ChatHistory() {
  const { me, websites, openDockedChat } = useApp();
  // Arriving from the Dashboard's agent-performance table pre-filters that
  // agent's chats (any status).
  const location = useLocation();
  const presetState = location.state as { agentId?: string; noReply?: boolean } | null;
  const presetAgentId = presetState?.agentId ?? '';
  const presetNoReply = presetState?.noReply ?? false;
  const [rows, setRows] = useState<ChatHistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState('');
  const [websiteId, setWebsiteId] = useState('');
  const [agentId, setAgentId] = useState(presetAgentId);
  const [noReply, setNoReply] = useState(presetNoReply);
  const [status, setStatus] = useState(presetAgentId ? 'ALL' : '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [agents, setAgents] = useState<UserPublic[]>([]);
  const debounceRef = useRef<number | null>(null);

  // CSRs cannot list users — hide the agent filter for them.
  const showAgentFilter = me != null && me.role !== 'CSR';
  useEffect(() => {
    if (showAgentFilter) void api.users().then(setAgents).catch(() => setAgents([]));
  }, [showAgentFilter]);

  const load = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        const res = await api.chatHistory({
          page: p + 1,
          q: q.trim() || undefined,
          websiteId: websiteId || undefined,
          agentId: agentId || undefined,
          status: status || undefined,
          from: from || undefined,
          to: to || undefined,
          noReply: noReply || undefined,
        });
        setRows(res.chats);
        setTotal(res.total);
        setPages(res.pages);
        setPage(res.page - 1);
      } catch {
        /* transient */
      } finally {
        setLoading(false);
      }
    },
    [q, websiteId, agentId, status, from, to, noReply],
  );

  // Reload on filter change (debounced for typing in search).
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => void load(0), q ? 300 : 0);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [load, q]);

  const PER_PAGE = 20;

  return (
    <div className="page visitors-page">
      <div className="page-head">
        <div>
          <h2>Chat History</h2>
          <p className="page-sub">
            Every finished conversation — search, filter and reopen the transcript.
          </p>
        </div>
      </div>

      <div className="rec-filters ch-filters card">
        <label className="rec-field rec-field-grow">
          <span>Search</span>
          <div className="rec-search">
            <IconSearch size={14} />
            <input
              type="search"
              placeholder="Visitor name or email…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
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
        {showAgentFilter && (
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
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Closed + Missed</option>
            <option value="CLOSED">Closed</option>
            <option value="MISSED">Missed</option>
            <option value="ALL">Any status</option>
          </select>
        </label>
        <label className="rec-field">
          <span>Reply</span>
          <select value={noReply ? '1' : ''} onChange={(e) => setNoReply(e.target.value === '1')}>
            <option value="">All chats</option>
            <option value="1">No CSR reply</option>
          </select>
        </label>
        <label className="rec-field">
          <span>From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="rec-field">
          <span>To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      <h3 className="vt-group-title vt-group-offline">
        <IconClock size={13} /> Conversations ({total})
      </h3>

      {rows.length > 0 && (
        <div className="card vt-card">
          <table className="table vt-table">
            <thead>
              <tr>
                <th>Visitor</th>
                <th>Website</th>
                <th>Agent</th>
                <th>Status</th>
                <th className="num">Messages</th>
                <th className="num">Duration</th>
                <th className="num">Rating</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  className="ch-row"
                  title="Open transcript"
                  onClick={() => openDockedChat(c.id)}
                >
                  <td>
                    <div className="vt-who-cell">
                      <span className="avatar avatar-sm" style={{ background: c.websiteColor }}>
                        {initials(c.visitor || 'V')}
                      </span>
                      <div className="vt-who-meta">
                        <span className="vt-name">{c.visitor || `Visitor ${visitorNumber(c.visitorId)}`}</span>
                        {c.visitorEmail && <span className="vt-sub">{c.visitorEmail}</span>}
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="chip chip-site">
                      <span className="chip-dot" style={{ background: c.websiteColor }} />
                      {c.website}
                    </span>
                  </td>
                  <td>{c.agent ?? <span className="vt-sub">—</span>}</td>
                  <td>
                    <StatusPill status={c.status as ConversationStatus} />
                  </td>
                  <td className="num">{c.messages}</td>
                  <td className="num">{c.durationSeconds != null ? formatSeconds(c.durationSeconds) : '—'}</td>
                  <td className="num">
                    {c.rating != null ? (
                      <span className="ch-rating">
                        <IconStar size={13} /> {c.rating}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="vt-sub">{formatWhen(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading && rows.length === 0 && <div className="empty-hint">Loading history…</div>}
      {!loading && rows.length === 0 && (
        <div className="empty-state card">
          <IconUsers size={32} className="empty-state-icon" />
          <p>{q || websiteId || agentId || from || to || noReply ? 'No chats match these filters' : 'No finished chats yet'}</p>
        </div>
      )}

      {total > PER_PAGE && (
        <div className="vt-pager">
          <span className="vt-pager-info">
            Showing {page * PER_PAGE + 1}–{Math.min((page + 1) * PER_PAGE, total)} of {total}
          </span>
          <div className="vt-pager-btns">
            <button className="vt-pager-btn" disabled={page === 0 || loading} onClick={() => void load(page - 1)}>
              ‹
            </button>
            {pageNumbers(pages, page).map((p, i) =>
              p === '…' ? (
                <span key={`e${i}`} className="vt-pager-ellipsis">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  className={classNames('vt-pager-btn', p === page && 'active')}
                  disabled={loading}
                  onClick={() => void load(p)}
                >
                  {p + 1}
                </button>
              ),
            )}
            <button
              className="vt-pager-btn"
              disabled={page >= pages - 1 || loading}
              onClick={() => void load(page + 1)}
            >
              ›
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
