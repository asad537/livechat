import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Visitor } from '@livechat/shared';
import { EV } from '@livechat/shared';
import { useApp } from '../state';
import { getSocket } from '../socket';
import { api } from '../api';
import {
  classNames,
  durationSince,
  flagEmoji,
  formatWhen,
  initials,
  pageLabel,
  referrerLabel,
  uaParse,
} from '../util';
import VisitorDrawer from '../components/VisitorDrawer';
import { IconUsers, IconX } from '../icons';

export default function Visitors() {
  const { websites, visitorsByWebsite, pushToast } = useApp();
  const navigate = useNavigate();
  const [websiteId, setWebsiteId] = useState<string | null>(null);
  const [restVisitors, setRestVisitors] = useState<Visitor[]>([]);
  const [query, setQuery] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [startTarget, setStartTarget] = useState<Visitor | null>(null);
  const [firstMessage, setFirstMessage] = useState('');
  const [, forceTick] = useState(0);

  const activeWebsiteId = websiteId ?? websites[0]?.id ?? null;
  const activeWebsite = websites.find((w) => w.id === activeWebsiteId) ?? null;
  const accent = activeWebsite?.primaryColor || 'var(--accent)';

  // (Re)subscribe to the live visitor stream of the selected website.
  useEffect(() => {
    if (!activeWebsiteId) return;
    getSocket()?.emit(EV.AgentWatchWebsite, { websiteId: activeWebsiteId });
  }, [activeWebsiteId]);

  // REST list brings the recently-offline visitors (last 24h) too.
  const refresh = useCallback(() => {
    if (!activeWebsiteId) return;
    void api
      .websiteVisitors(activeWebsiteId)
      .then(setRestVisitors)
      .catch(() => setRestVisitors([]));
  }, [activeWebsiteId]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Tick once a second so "time on site" counts up live.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Merge: socket stream wins for online rows, REST fills in offline history.
  const visitors = useMemo(() => {
    const liveList = activeWebsiteId ? visitorsByWebsite[activeWebsiteId] ?? [] : [];
    const byId = new Map<string, Visitor>();
    for (const v of restVisitors) byId.set(v.id, v);
    for (const v of liveList) byId.set(v.id, { ...byId.get(v.id), ...v });
    let list = [...byId.values()];
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((v) =>
        [v.name, v.email, v.phone, v.ip, v.country, v.city, v.currentPage, v.referrer]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q)),
      );
    }
    list.sort((a, b) => {
      if (!!a.online !== !!b.online) return a.online ? -1 : 1;
      return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
    });
    return list;
  }, [visitorsByWebsite, restVisitors, activeWebsiteId, query]);

  const onlineList = visitors.filter((v) => v.online);
  const offlineList = visitors.filter((v) => !v.online);
  const drawerLive = drawerId ? visitors.find((v) => v.id === drawerId) ?? null : null;

  const startChat = () => {
    const body = firstMessage.trim();
    if (!body || !startTarget || !activeWebsiteId) return;
    getSocket()?.emit(EV.AgentStartChat, {
      websiteId: activeWebsiteId,
      visitorId: startTarget.id,
      body,
    });
    pushToast('Chat started', `Your message was sent to ${startTarget.name || 'the visitor'}.`, 'success');
    setStartTarget(null);
    setFirstMessage('');
    navigate('/');
  };

  const row = (v: Visitor) => {
    const name = v.name || `Visitor ${v.id.slice(0, 6)}`;
    const ua = uaParse(v.userAgent);
    return (
      <tr
        key={v.id}
        className={classNames('vt-row', v.online && 'online')}
        onClick={() => setDrawerId(v.id)}
      >
        <td className="vt-who">
          <span className="avatar" style={{ background: accent }}>
            {initials(name)}
          </span>
          <div className="vt-who-meta">
            <span className="vt-name">
              <span className="vt-flag" title={v.country ?? undefined}>
                {flagEmoji(v.countryCode)}
              </span>
              {name}
              <span className={classNames('dot', v.online ? 'dot-online' : 'dot-offline')} />
            </span>
            <span className="vt-sub">
              {v.email || (v.city || v.country ? [v.city, v.country].filter(Boolean).join(', ') : 'No email')}
            </span>
          </div>
        </td>
        <td className="vt-page">
          {v.online && v.currentPage ? (
            <span className="vt-page-url" title={v.currentPage}>
              {pageLabel(v.currentPage)}
            </span>
          ) : (
            <span className="vt-muted">Last seen {formatWhen(v.lastSeenAt) || '—'}</span>
          )}
        </td>
        <td className="vt-referrer">{referrerLabel(v.referrer)}</td>
        <td className="vt-tech">
          {v.userAgent ? (
            <>
              <span className="vd-chip">{ua.browser}</span>
              <span className="vd-chip">{ua.os}</span>
            </>
          ) : (
            <span className="vt-muted">—</span>
          )}
        </td>
        <td className="vt-num">{v.online ? durationSince(v.sessionStartedAt) : '—'}</td>
        <td className="vt-num">{v.sessionPages ?? 0}</td>
        <td className="vt-num">{v.totalVisits ?? 0}</td>
        <td className="vt-num">{v.chats ?? 0}</td>
        <td className="vt-actions">
          <button
            className="btn btn-primary btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              setStartTarget(v);
            }}
          >
            Chat
          </button>
        </td>
      </tr>
    );
  };

  const table = (list: Visitor[]) => (
    <div className="vt-table-wrap card">
      <table className="vt-table">
        <thead>
          <tr>
            <th>Visitor</th>
            <th>Viewing</th>
            <th>Came from</th>
            <th>Device</th>
            <th className="vt-num">On site</th>
            <th className="vt-num">Pages</th>
            <th className="vt-num">Visits</th>
            <th className="vt-num">Chats</th>
            <th />
          </tr>
        </thead>
        <tbody>{list.map(row)}</tbody>
      </table>
    </div>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Visitors</h2>
          <p className="page-sub">
            <span className="vt-live-dot" /> {onlineList.length} online now
            {activeWebsite ? ` on ${activeWebsite.name}` : ''}
          </p>
        </div>
        <div className="vt-head-tools">
          <input
            className="vt-search"
            type="search"
            placeholder="Search name, email, IP, page…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="site-switcher">
            {websites.map((w) => (
              <button
                key={w.id}
                className={classNames('site-pill', w.id === activeWebsiteId && 'active')}
                onClick={() => {
                  setWebsiteId(w.id);
                  setDrawerId(null);
                }}
              >
                <span className="chip-dot" style={{ background: w.primaryColor }} />
                {w.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {websites.length === 0 && <div className="empty-hint">No websites are assigned to you yet.</div>}

      {onlineList.length > 0 && (
        <>
          <h3 className="vt-group-title">
            <span className="dot dot-online" /> Online now ({onlineList.length})
          </h3>
          {table(onlineList)}
        </>
      )}

      {offlineList.length > 0 && (
        <>
          <h3 className="vt-group-title vt-group-offline">
            Recently active — last 24h ({offlineList.length})
          </h3>
          {table(offlineList)}
        </>
      )}

      {activeWebsiteId && visitors.length === 0 && (
        <div className="empty-state card">
          <IconUsers size={32} className="empty-state-icon" />
          <p>{query ? 'No visitors match your search' : 'No visitors right now'}</p>
          <p className="chat-empty-sub">
            {query
              ? 'Try a different name, email or IP.'
              : `Visitors appear here live as they browse ${activeWebsite?.name}.`}
          </p>
        </div>
      )}

      {drawerId && (
        <VisitorDrawer
          visitorId={drawerId}
          accentColor={accent}
          live={drawerLive}
          onClose={() => setDrawerId(null)}
          onStartChat={(v) => {
            setDrawerId(null);
            setStartTarget(v);
          }}
          onOpenConversation={(conversationId) => navigate('/', { state: { conversationId } })}
        />
      )}

      {startTarget && (
        <div className="modal-backdrop" onClick={() => setStartTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Start a chat</h3>
              <button className="icon-btn" onClick={() => setStartTarget(null)} aria-label="Close">
                <IconX size={16} />
              </button>
            </div>
            <div className="modal-visitor">
              <span className="avatar" style={{ background: accent }}>
                {initials(startTarget.name || 'V')}
              </span>
              <div>
                <div className="modal-row-name">
                  {flagEmoji(startTarget.countryCode)}{' '}
                  {startTarget.name || `Visitor ${startTarget.id.slice(0, 6)}`}
                </div>
                <div className="modal-row-sub">{startTarget.email || 'No email'}</div>
              </div>
            </div>
            <label className="field">
              <span>First message</span>
              <textarea
                rows={3}
                value={firstMessage}
                autoFocus
                placeholder="Hi there — anything I can help you with?"
                onChange={(e) => setFirstMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    startChat();
                  }
                }}
              />
            </label>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setStartTarget(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={startChat} disabled={!firstMessage.trim()}>
                Send and open chat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
