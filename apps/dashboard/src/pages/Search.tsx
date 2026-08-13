import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EV, type ConversationSummary, type Visitor } from '@livechat/shared';
import { api } from '../api';
import { useApp } from '../state';
import { getSocket } from '../socket';
import { StatusPill } from '../components/ConversationList';
import VisitorDrawer from '../components/VisitorDrawer';
import { IconMessage, IconSearch, IconUser, IconUsers, IconX } from '../icons';
import {
  avatarGradient,
  classNames,
  flagEmoji,
  formatWhen,
  initials,
  siteLabel,
  visitorNumber,
} from '../util';

/** Master search — one box that finds chats, visitors and agents. */
export default function Search() {
  const { me, websites, teams, openDockedChat, pushToast } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [chats, setChats] = useState<ConversationSummary[]>([]);
  const [visitors, setVisitors] = useState<Visitor[]>([]);
  const [searching, setSearching] = useState(false);
  const [ran, setRan] = useState(false);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [startTarget, setStartTarget] = useState<Visitor | null>(null);
  const [firstMessage, setFirstMessage] = useState('');
  const debounceRef = useRef<number | null>(null);

  const siteById = useMemo(() => new Map(websites.map((w) => [w.id, w])), [websites]);

  // Agents matched client-side from the team directory (hidden for CSRs).
  const agentResults = useMemo(() => {
    if (!me || me.role === 'CSR') return [];
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    const seen = new Map<string, { id: string; name: string; email: string; role: string }>();
    for (const t of teams) {
      for (const m of t.members ?? []) {
        if (m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle)) {
          seen.set(m.id, { id: m.id, name: m.name, email: m.email, role: m.role });
        }
      }
    }
    return [...seen.values()].slice(0, 10);
  }, [teams, q, me]);

  // Debounced server search over chats + visitors.
  useEffect(() => {
    const needle = q.trim();
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (needle.length < 2) {
      setChats([]);
      setVisitors([]);
      setRan(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = window.setTimeout(() => {
      void Promise.all([
        api.searchConversations(needle).catch(() => [] as ConversationSummary[]),
        api.searchVisitors(needle).catch(() => [] as Visitor[]),
      ]).then(([c, v]) => {
        setChats(c);
        setVisitors(v);
        setRan(true);
        setSearching(false);
      });
    }, 300);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [q]);

  const startChat = () => {
    const body = firstMessage.trim();
    if (!body || !startTarget) return;
    const target = startTarget;
    getSocket()?.emit(
      EV.AgentStartChat,
      { websiteId: target.websiteId, visitorId: target.id, body },
      (ack: { conversationId?: string } | undefined) => {
        if (ack?.conversationId) openDockedChat(ack.conversationId);
      },
    );
    pushToast('Chat started', `Your message was sent to ${target.name || 'the visitor'}.`, 'success');
    setStartTarget(null);
    setFirstMessage('');
  };

  const total = chats.length + visitors.length + agentResults.length;
  const drawerLive = drawerId ? visitors.find((v) => v.id === drawerId) ?? null : null;

  return (
    <div className="page visitors-page">
      <div className="page-head">
        <div>
          <h2>Search</h2>
          <p className="page-sub">Find anything — chats, messages, visitors or agents.</p>
        </div>
      </div>

      <div className="ms-box card">
        <IconSearch size={18} />
        <input
          autoFocus
          type="search"
          placeholder="Search name, email, phone, IP or message text…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button className="icon-btn" onClick={() => setQ('')} aria-label="Clear">
            <IconX size={15} />
          </button>
        )}
      </div>

      {searching && <div className="empty-hint">Searching…</div>}
      {!searching && ran && total === 0 && (
        <div className="empty-state card">
          <IconSearch size={32} className="empty-state-icon" />
          <p>Nothing matched “{q.trim()}”.</p>
        </div>
      )}

      {/* ── Chats ── */}
      {chats.length > 0 && (
        <>
          <h3 className="vt-group-title vt-group-offline">
            <IconMessage size={13} /> Chats ({chats.length})
          </h3>
          <div className="card vt-card">
            <table className="table vt-table">
              <tbody>
                {chats.map((c) => {
                  const name = c.visitor?.name || `Visitor ${visitorNumber(c.visitorId)}`;
                  return (
                    <tr key={c.id} className="ch-row" title="Open chat" onClick={() => openDockedChat(c.id)}>
                      <td>
                        <div className="vt-who-cell">
                          <span
                            className="avatar avatar-sm"
                            style={{ background: c.website?.primaryColor || 'var(--accent)' }}
                          >
                            {initials(name)}
                          </span>
                          <div className="vt-who-meta">
                            <span className="vt-name">{name}</span>
                            <span className="vt-sub">{c.lastMessage?.body?.slice(0, 80) || 'No messages'}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        {c.website && (
                          <span className="chip chip-site">
                            <span
                              className="chip-dot"
                              style={{ background: c.website.primaryColor || 'var(--accent)' }}
                            />
                            {siteLabel(c.website)}
                          </span>
                        )}
                      </td>
                      <td>
                        <StatusPill status={c.status} />
                      </td>
                      <td className="vt-sub">{formatWhen(c.lastMessage?.createdAt ?? c.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Visitors ── */}
      {visitors.length > 0 && (
        <>
          <h3 className="vt-group-title vt-group-offline">
            <IconUsers size={13} /> Visitors ({visitors.length})
          </h3>
          <div className="card vt-card">
            <table className="table vt-table">
              <tbody>
                {visitors.map((v) => {
                  const site = siteById.get(v.websiteId);
                  return (
                    <tr key={v.id} className="ch-row" title="Open visitor" onClick={() => setDrawerId(v.id)}>
                      <td>
                        <div className="vt-who-cell">
                          <span className="avatar avatar-sm" style={{ background: avatarGradient(v.id) }}>
                            {initials(v.name || 'V')}
                          </span>
                          <div className="vt-who-meta">
                            <span className="vt-name">
                              {flagEmoji(v.countryCode)} {v.name || `Visitor ${visitorNumber(v.id)}`}
                              <span className={classNames('dot', v.online ? 'dot-online' : 'dot-offline')} />
                            </span>
                            <span className="vt-sub">{v.email || v.phone || v.ip || '—'}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        {site && (
                          <span className="chip chip-site">
                            <span className="chip-dot" style={{ background: site.primaryColor }} />
                            {siteLabel(site)}
                          </span>
                        )}
                      </td>
                      <td className="vt-sub">{(v.chats ?? 0) + ' chat' + ((v.chats ?? 0) === 1 ? '' : 's')}</td>
                      <td className="vt-sub">{formatWhen(v.lastSeenAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Agents ── */}
      {agentResults.length > 0 && (
        <>
          <h3 className="vt-group-title vt-group-offline">
            <IconUser size={13} /> Agents ({agentResults.length})
          </h3>
          <div className="card vt-card">
            <table className="table vt-table">
              <tbody>
                {agentResults.map((a) => (
                  <tr
                    key={a.id}
                    className="ch-row"
                    title={`Open ${a.name}'s chats`}
                    onClick={() => navigate('/chat-history', { state: { agentId: a.id } })}
                  >
                    <td>
                      <div className="vt-who-cell">
                        <span className="avatar avatar-sm" style={{ background: avatarGradient(a.id) }}>
                          {initials(a.name)}
                        </span>
                        <div className="vt-who-meta">
                          <span className="vt-name">{a.name}</span>
                          <span className="vt-sub">{a.email}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="chip">{a.role}</span>
                    </td>
                    <td className="vt-sub">View chats →</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {drawerId && (
        <VisitorDrawer
          visitorId={drawerId}
          accentColor={siteById.get(drawerLive?.websiteId ?? '')?.primaryColor || 'var(--accent)'}
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
                  {startTarget.name || `Visitor ${visitorNumber(startTarget.id)}`}
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
