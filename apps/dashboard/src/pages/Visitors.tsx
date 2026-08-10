import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Visitor } from '@livechat/shared';
import { EV } from '@livechat/shared';
import { useApp } from '../state';
import { getSocket } from '../socket';
import { api } from '../api';
import {
  avatarGradient,
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
import {
  IconAndroid,
  IconApple,
  IconChrome,
  IconClock,
  IconGlobe,
  IconSearch,
  IconUsers,
  IconWindows,
  IconX,
} from '../icons';

const browserIcon = (browser: string) =>
  browser === 'Chrome' ? <IconChrome size={12} /> : <IconGlobe size={11} />;

const osIcon = (os: string) => {
  if (os === 'macOS' || os === 'iOS') return <IconApple size={12} />;
  if (os === 'Windows') return <IconWindows size={11} />;
  if (os === 'Android') return <IconAndroid size={12} />;
  return null;
};

export default function Visitors() {
  const { websites, visitorsByWebsite, pushToast, openDockedChat, connected } = useApp();
  const [restVisitors, setRestVisitors] = useState<Visitor[]>([]);
  const [query, setQuery] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [startTarget, setStartTarget] = useState<Visitor | null>(null);
  const [firstMessage, setFirstMessage] = useState('');
  const [, forceTick] = useState(0);

  // Live shows online + the 10 freshest; the full archive lives in History (paginated).
  const [view, setView] = useState<'live' | 'history'>('live');
  const [history, setHistory] = useState<Visitor[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const HISTORY_PAGE = 25;

  const siteById = useMemo(() => new Map(websites.map((w) => [w.id, w])), [websites]);
  const siteColor = (v: Visitor | null | undefined) =>
    (v && siteById.get(v.websiteId)?.primaryColor) || 'var(--accent)';

  // Live visitor streams of ALL websites — the table shows every site at once
  // and tags each row with its website (Zendesk-style).
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    for (const w of websites) socket.emit(EV.AgentWatchWebsite, { websiteId: w.id });
  }, [websites, connected]);

  // REST list brings the recently-offline visitors (last 24h) of every site.
  const refresh = useCallback(() => {
    if (websites.length === 0) return;
    void Promise.all(
      websites.map((w) => api.websiteVisitors(w.id).catch(() => [] as Visitor[])),
    ).then((lists) => setRestVisitors(lists.flat()));
  }, [websites]);
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

  // History tab: server-side search + pagination (debounced).
  const loadHistory = useCallback(
    (offset: number, append: boolean) => {
      setHistoryLoading(true);
      void api
        .visitorHistory({ limit: HISTORY_PAGE, offset, q: query.trim() || undefined })
        .then((r) => {
          setHistoryTotal(r.total);
          setHistory((prev) => (append ? [...prev, ...r.visitors] : r.visitors));
        })
        .catch(() => undefined)
        .finally(() => setHistoryLoading(false));
    },
    [query],
  );
  useEffect(() => {
    if (view !== 'history') return;
    const t = setTimeout(() => loadHistory(0, false), 300);
    return () => clearTimeout(t);
  }, [view, loadHistory]);

  // Merge: socket stream wins for online rows, REST fills in offline history.
  const visitors = useMemo(() => {
    const liveList = websites.flatMap((w) => visitorsByWebsite[w.id] ?? []);
    const byId = new Map<string, Visitor>();
    for (const v of restVisitors) byId.set(v.id, v);
    for (const v of liveList) byId.set(v.id, { ...byId.get(v.id), ...v });
    let list = [...byId.values()];
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((v) =>
        [
          v.name,
          v.email,
          v.phone,
          v.ip,
          v.country,
          v.city,
          v.currentPage,
          v.referrer,
          siteById.get(v.websiteId)?.name,
        ]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q)),
      );
    }
    list.sort((a, b) => {
      if (!!a.online !== !!b.online) return a.online ? -1 : 1;
      return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
    });
    return list;
  }, [visitorsByWebsite, restVisitors, websites, query, siteById]);

  const onlineList = visitors.filter((v) => v.online);
  const offlineList = visitors.filter((v) => !v.online);
  const drawerLive = drawerId ? visitors.find((v) => v.id === drawerId) ?? null : null;

  const startChat = () => {
    const body = firstMessage.trim();
    if (!body || !startTarget) return;
    const target = startTarget;
    getSocket()?.emit(
      EV.AgentStartChat,
      { websiteId: target.websiteId, visitorId: target.id, body },
      (ack: { conversationId?: string } | undefined) => {
        // Chat opens right here in the docked window — no jump to the Inbox.
        if (ack?.conversationId) openDockedChat(ack.conversationId);
      },
    );
    pushToast('Chat started', `Your message was sent to ${target.name || 'the visitor'}.`, 'success');
    setStartTarget(null);
    setFirstMessage('');
  };

  const row = (v: Visitor) => {
    const name = v.name || `Visitor ${v.id.slice(0, 6)}`;
    const ua = uaParse(v.userAgent);
    const site = siteById.get(v.websiteId);
    return (
      <tr
        key={v.id}
        className={classNames('vt-row', v.online && 'online')}
        onClick={() => setDrawerId(v.id)}
      >
        <td className="vt-who">
          <div className="vt-who-cell">
            <span className="avatar" style={{ background: avatarGradient(v.id) }}>
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
          </div>
        </td>
        <td className="vt-site">
          {site ? (
            <span className="vt-site-chip">
              <span className="chip-dot" style={{ background: site.primaryColor }} />
              {site.name}
            </span>
          ) : (
            <span className="vt-muted">—</span>
          )}
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
        <td className="vt-num">
          {v.online ? <span className="vt-onsite">{durationSince(v.sessionStartedAt)}</span> : '—'}
        </td>
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
            <th>Website</th>
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
    <div className="page visitors-page">
      <div className="page-head">
        <div>
          <h2>Visitors</h2>
          <p className="page-sub">
            <span className="vt-live-dot" /> {onlineList.length} online now across{' '}
            {websites.length} website{websites.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="vt-head-tools">
          <div className="range-pills">
            <button
              className={classNames('range-pill', view === 'live' && 'active')}
              onClick={() => setView('live')}
            >
              Live
            </button>
            <button
              className={classNames('range-pill', view === 'history' && 'active')}
              onClick={() => setView('history')}
            >
              History
            </button>
          </div>
          <div className="vt-search-wrap">
            <IconSearch size={15} className="vt-search-icon" />
            <input
              className="vt-search"
              type="search"
              placeholder="Search name, email, IP, page, website…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {websites.length === 0 && <div className="empty-hint">No websites are assigned to you yet.</div>}

      {view === 'live' && (
        <>
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
                <IconClock size={13} /> Recently active ({Math.min(offlineList.length, 10)})
              </h3>
              {table(offlineList.slice(0, 10))}
              {offlineList.length > 10 && (
                <button className="vt-more-link" onClick={() => setView('history')}>
                  View all older visitors in History →
                </button>
              )}
            </>
          )}

          {websites.length > 0 && visitors.length === 0 && (
            <div className="empty-state card">
              <IconUsers size={32} className="empty-state-icon" />
              <p>{query ? 'No visitors match your search' : 'No visitors right now'}</p>
              <p className="chat-empty-sub">
                {query
                  ? 'Try a different name, email, IP or website.'
                  : 'Visitors appear here live as they browse your websites.'}
              </p>
            </div>
          )}
        </>
      )}

      {view === 'history' && (
        <>
          <h3 className="vt-group-title vt-group-offline">
            <IconClock size={13} /> All visitors ({historyTotal})
          </h3>
          {history.length > 0 && table(history)}
          {historyLoading && history.length === 0 && <div className="empty-hint">Loading history…</div>}
          {!historyLoading && history.length === 0 && (
            <div className="empty-state card">
              <IconUsers size={32} className="empty-state-icon" />
              <p>{query ? 'No visitors match your search' : 'No visitors yet'}</p>
            </div>
          )}
          {history.length < historyTotal && (
            <button
              className="btn btn-ghost vt-load-more"
              disabled={historyLoading}
              onClick={() => loadHistory(history.length, true)}
            >
              {historyLoading ? 'Loading…' : `Load more (${historyTotal - history.length} left)`}
            </button>
          )}
        </>
      )}

      {drawerId && (
        <VisitorDrawer
          visitorId={drawerId}
          accentColor={siteColor(drawerLive)}
          live={drawerLive}
          onClose={() => setDrawerId(null)}
          onStartChat={(v) => {
            setDrawerId(null);
            setStartTarget(v);
          }}
          onOpenConversation={(conversationId) => {
            setDrawerId(null);
            openDockedChat(conversationId);
          }}
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
              <span className="avatar" style={{ background: avatarGradient(startTarget.id) }}>
                {initials(startTarget.name || 'V')}
              </span>
              <div>
                <div className="modal-row-name">
                  {flagEmoji(startTarget.countryCode)}{' '}
                  {startTarget.name || `Visitor ${startTarget.id.slice(0, 6)}`}
                </div>
                <div className="modal-row-sub">
                  {startTarget.email || 'No email'}
                  {siteById.get(startTarget.websiteId) && (
                    <> · {siteById.get(startTarget.websiteId)?.name}</>
                  )}
                </div>
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
