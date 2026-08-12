import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  siteLabel,
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

/** Page indices with ellipses: first, last, and current±1. */
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

const osIcon = (os: string) => {
  if (os === 'macOS' || os === 'iOS') return <IconApple size={12} />;
  if (os === 'Windows') return <IconWindows size={11} />;
  if (os === 'Android') return <IconAndroid size={12} />;
  return null;
};

export default function Visitors({ initialView = 'live' }: { initialView?: 'live' | 'history' }) {
  const { websites, visitorsByWebsite, pushToast, openDockedChat, connected } = useApp();
  const [restVisitors, setRestVisitors] = useState<Visitor[]>([]);
  const [servedVisitors, setServedVisitors] = useState<Visitor[]>([]);
  const [query, setQuery] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [startTarget, setStartTarget] = useState<Visitor | null>(null);
  const [firstMessage, setFirstMessage] = useState('');
  const [, forceTick] = useState(0);

  // Live shows online + the 10 freshest; the full archive lives in History (paginated).
  // The view is route-driven (/visitors ↔ /history) so the sidebar stays in sync.
  const navigate = useNavigate();
  const view = initialView;
  const [history, setHistory] = useState<Visitor[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [page, setPage] = useState(0);
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

  // REST list brings the recently-offline visitors (last 24h) of every site;
  // plus the "recently served" list (visitors an agent actually messaged).
  const refresh = useCallback(() => {
    if (websites.length === 0) return;
    void Promise.all(
      websites.map((w) => api.websiteVisitors(w.id).catch(() => [] as Visitor[])),
    ).then((lists) => setRestVisitors(lists.flat()));
    // Fetch more than we display so the "already served" exclusion below is
    // reasonably complete (served visitors are hidden from Online now).
    void api.servedVisitors(40).then(setServedVisitors).catch(() => setServedVisitors([]));
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

  // History tab: server-side search + numbered pagination (debounced).
  const loadHistory = useCallback(
    (p: number) => {
      setHistoryLoading(true);
      void api
        .visitorHistory({ limit: HISTORY_PAGE, offset: p * HISTORY_PAGE, q: query.trim() || undefined })
        .then((r) => {
          setHistoryTotal(r.total);
          setHistory(r.visitors);
          setPage(p);
        })
        .catch(() => undefined)
        .finally(() => setHistoryLoading(false));
    },
    [query],
  );
  useEffect(() => {
    if (view !== 'history') return;
    const t = setTimeout(() => loadHistory(0), 300);
    return () => clearTimeout(t);
  }, [view, loadHistory]);

  // Merge: socket stream wins for online rows, REST fills in offline history.
  const visitors = useMemo(() => {
    const liveList = websites.flatMap((w) => visitorsByWebsite[w.id] ?? []);
    const byId = new Map<string, Visitor>();
    for (const v of restVisitors) byId.set(v.id, v);
    for (const v of liveList) byId.set(v.id, { ...byId.get(v.id), ...v });
    // The live stream is authoritative: for any site we have a snapshot of,
    // a visitor NOT in that snapshot is offline — even if a stale REST row
    // (fetched while they were still browsing) says online. This makes a
    // leaver disappear from "Online now" ~seconds after closing the site,
    // no reload needed.
    const liveSites = new Set(websites.filter((w) => visitorsByWebsite[w.id]).map((w) => w.id));
    const liveIds = new Set(liveList.map((v) => v.id));
    let list = [...byId.values()].map((v) =>
      v.online && liveSites.has(v.websiteId) && !liveIds.has(v.id)
        ? { ...v, online: false, activeConversation: null }
        : v,
    );
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

  // Ids of visitors we've already served — they belong under "Recently served",
  // not "Online now" (which is for fresh, not-yet-served visitors).
  const servedIds = useMemo(() => new Set(servedVisitors.map((v) => v.id)), [servedVisitors]);
  // A visitor being served RIGHT NOW (assigned to any agent) leaves Online now
  // instantly — this rides the live socket stream, no REST refresh needed.
  const onlineList = visitors.filter(
    (v) => v.online && !servedIds.has(v.id) && !v.activeConversation?.assignedUserId,
  );

  // The moment serving starts OR a chat closes, pull the served list so the
  // visitor moves between "Online now" and "Recently served" immediately
  // instead of on the next 60s poll (the fingerprint changes both ways).
  const assignedFingerprint = visitors
    .filter((v) => v.activeConversation?.assignedUserId)
    .map((v) => v.id)
    .sort()
    .join(',');
  useEffect(() => {
    void api.servedVisitors(40).then(setServedVisitors).catch(() => undefined);
  }, [assignedFingerprint]);

  // "Recently served" — visitors an agent messaged who are STILL ONLINE,
  // enriched with live state and filtered by the same search box. Once they
  // leave the site they drop off (their chats live on in Chat History).
  const servedList = useMemo(() => {
    const liveById = new Map<string, Visitor>();
    for (const w of websites) for (const v of visitorsByWebsite[w.id] ?? []) liveById.set(v.id, v);
    const liveSites = new Set(websites.filter((w) => visitorsByWebsite[w.id]).map((w) => w.id));
    let list = servedVisitors
      .map((v) => {
        const live = liveById.get(v.id);
        if (live) return { ...v, online: live.online, currentPage: live.currentPage };
        // Not in the live snapshot of a watched site → they left (stale REST flag).
        return liveSites.has(v.websiteId) ? { ...v, online: false } : v;
      })
      .filter((v) => v.online);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((v) =>
        [v.name, v.email, v.phone, v.ip, v.country, v.city, siteById.get(v.websiteId)?.name]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q)),
      );
    }
    return list.slice(0, 12);
  }, [servedVisitors, visitorsByWebsite, websites, query, siteById]);

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
              {siteLabel(site)}
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
          {v.activeConversation?.assignedUserId ? (
            // Being served — show WHO has it; click opens that chat in the dock.
            <button
              className="btn btn-ghost btn-sm vt-assigned"
              title="Open this chat"
              onClick={(e) => {
                e.stopPropagation();
                openDockedChat(v.activeConversation!.id);
              }}
            >
              <span className="dot dot-online" />
              {v.activeConversation.agentName ?? 'Assigned'}
            </button>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                // Queued chat → open it in the dock; otherwise compose a new one.
                const openId = v.activeConversation?.id;
                if (openId) openDockedChat(openId);
                else setStartTarget(v);
              }}
            >
              Chat
            </button>
          )}
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
              onClick={() => navigate('/visitors')}
            >
              Live
            </button>
            <button
              className={classNames('range-pill', view === 'history' && 'active')}
              onClick={() => navigate('/history')}
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

          {servedList.length > 0 && (
            <>
              <h3 className="vt-group-title vt-group-offline">
                <IconClock size={13} /> Recently served ({servedList.length})
              </h3>
              {table(servedList)}
              <button className="vt-more-link" onClick={() => navigate('/chat-history')}>
                View all past chats in Chat History →
              </button>
            </>
          )}

          {websites.length > 0 && onlineList.length === 0 && servedList.length === 0 && (
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
          {historyTotal > HISTORY_PAGE && (
            <div className="vt-pager">
              <span className="vt-pager-info">
                Showing {page * HISTORY_PAGE + 1}–{Math.min((page + 1) * HISTORY_PAGE, historyTotal)}{' '}
                of {historyTotal}
              </span>
              <div className="vt-pager-btns">
                <button
                  className="vt-pager-btn"
                  disabled={page === 0 || historyLoading}
                  onClick={() => loadHistory(page - 1)}
                >
                  ‹
                </button>
                {pageNumbers(Math.ceil(historyTotal / HISTORY_PAGE), page).map((p, i) =>
                  p === '…' ? (
                    <span key={`e${i}`} className="vt-pager-ellipsis">
                      …
                    </span>
                  ) : (
                    <button
                      key={p}
                      className={classNames('vt-pager-btn', p === page && 'active')}
                      disabled={historyLoading}
                      onClick={() => loadHistory(p)}
                    >
                      {p + 1}
                    </button>
                  ),
                )}
                <button
                  className="vt-pager-btn"
                  disabled={page >= Math.ceil(historyTotal / HISTORY_PAGE) - 1 || historyLoading}
                  onClick={() => loadHistory(page + 1)}
                >
                  ›
                </button>
              </div>
            </div>
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
