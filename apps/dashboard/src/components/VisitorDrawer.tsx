import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, Visitor } from '@livechat/shared';
import { api, type VisitorChat, type VisitorProfile } from '../api';
import {
  classNames,
  durationSince,
  flagEmoji,
  formatDay,
  formatTime,
  formatWhen,
  initials,
  pageLabel,
  referrerLabel,
  uaParse,
} from '../util';
import { IconClock, IconDownload, IconEye, IconGlobe, IconMessage, IconX } from '../icons';

interface Props {
  visitorId: string;
  accentColor: string;
  /** Live row from the visitors stream (fresher online/currentPage than the API). */
  live?: Visitor | null;
  onClose(): void;
  onStartChat(visitor: Visitor): void;
  onOpenConversation(conversationId: string): void;
}

type Tab = 'profile' | 'chats';

export default function VisitorDrawer({
  visitorId,
  accentColor,
  live,
  onClose,
  onStartChat,
  onOpenConversation,
}: Props) {
  const [profile, setProfile] = useState<VisitorProfile | null>(null);
  const [chats, setChats] = useState<VisitorChat[] | null>(null);
  const [tab, setTab] = useState<Tab>('profile');
  const [error, setError] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  // CRM edit state
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Inline transcript viewer
  const [openChatId, setOpenChatId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Record<string, ChatMessage[]>>({});

  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setChats(null);
    setError(null);
    setOpenChatId(null);
    void api
      .visitorProfile(visitorId)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setForm({
          name: p.visitor.name ?? '',
          email: p.visitor.email ?? '',
          phone: p.visitor.phone ?? '',
          notes: p.visitor.notes ?? '',
        });
        setDirty(false);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    void api
      .visitorConversations(visitorId)
      .then((list) => !cancelled && setChats(list))
      .catch(() => !cancelled && setChats([]));
    return () => {
      cancelled = true;
    };
  }, [visitorId]);

  // Tick the "time on site" counter while the visitor is online.
  const online = live?.online ?? profile?.visitor.online ?? false;
  useEffect(() => {
    if (!online) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [online]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const v: Visitor | null = useMemo(() => {
    if (!profile) return live ?? null;
    return { ...profile.visitor, ...(live ?? {}), notes: profile.visitor.notes };
  }, [profile, live]);

  const name = v?.name || (v ? `Visitor ${v.id.slice(0, 6)}` : 'Visitor');
  const ua = uaParse(v?.userAgent);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const updated = await api.updateVisitor(visitorId, {
        name: form.name,
        email: form.email,
        phone: form.phone,
        notes: form.notes,
      });
      setProfile((p) => (p ? { ...p, visitor: { ...p.visitor, ...updated } } : p));
      setDirty(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1600);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleTranscript = async (chatId: string) => {
    if (openChatId === chatId) {
      setOpenChatId(null);
      return;
    }
    setOpenChatId(chatId);
    if (!transcript[chatId]) {
      try {
        const messages = await api.messages(chatId);
        setTranscript((t) => ({ ...t, [chatId]: messages }));
      } catch {
        setTranscript((t) => ({ ...t, [chatId]: [] }));
      }
    }
  };

  const downloadTranscript = (chat: VisitorChat) => {
    const messages = transcript[chat.id] ?? [];
    const lines = messages
      .filter((m) => m.kind === 'TEXT' || m.kind === 'SYSTEM')
      .map((m) => {
        const who =
          m.senderType === 'VISITOR'
            ? name
            : m.senderType === 'BOT'
              ? 'AI Assistant'
              : m.senderType === 'SYSTEM'
                ? '—'
                : m.sender?.name || 'Agent';
        return `[${new Date(m.createdAt).toLocaleString()}] ${who}: ${m.body}`;
      });
    const blob = new Blob(
      [`Chat transcript — ${formatDay(chat.createdAt)}\n\n${lines.join('\n')}\n`],
      { type: 'text/plain;charset=utf-8' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-${chat.id.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const stat = (label: string, value: React.ReactNode) => (
    <div className="vd-stat">
      <span className="vd-stat-value">{value}</span>
      <span className="vd-stat-label">{label}</span>
    </div>
  );

  const infoRow = (label: string, value: React.ReactNode) =>
    value ? (
      <div className="vd-info-row">
        <span className="vd-info-label">{label}</span>
        <span className="vd-info-value">{value}</span>
      </div>
    ) : null;

  return (
    <div className="vd-backdrop" onClick={onClose}>
      <div className="vd-panel" ref={panelRef} onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className="vd-head" style={{ background: `linear-gradient(135deg, ${accentColor}22, transparent)` }}>
          <div className="vd-head-main">
            <span className="avatar avatar-lg" style={{ background: accentColor }}>
              {initials(name)}
            </span>
            <div className="vd-head-meta">
              <div className="vd-head-name">
                <span className="vd-flag" title={v?.country ?? undefined}>
                  {flagEmoji(v?.countryCode)}
                </span>
                {name}
                <span className={classNames('dot', online ? 'dot-online' : 'dot-offline')} />
              </div>
              <div className="vd-head-sub">
                {online
                  ? `Online · on site ${durationSince(v?.sessionStartedAt)}`
                  : `Last seen ${formatWhen(v?.lastSeenAt) || 'a while ago'}`}
                {(v?.city || v?.country) && (
                  <> · 📍 {[v?.city, v?.country].filter(Boolean).join(', ')}</>
                )}
              </div>
            </div>
          </div>
          <div className="vd-head-actions">
            {v && (
              <button className="btn btn-primary btn-sm" onClick={() => onStartChat(v)}>
                <IconMessage size={14} /> Start chat
              </button>
            )}
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <IconX size={16} />
            </button>
          </div>
        </div>

        {/* ── Stats ── */}
        <div className="vd-stats">
          {stat('Visits', v?.totalVisits ?? 0)}
          {stat('Chats', profile?.stats.chats ?? v?.chats ?? 0)}
          {stat('Pages today', v?.sessionPages ?? 0)}
          {stat(
            'Avg rating',
            profile?.stats.avgRating != null ? `${profile.stats.avgRating} ★` : '—',
          )}
          {stat('First seen', profile ? formatDay(profile.stats.firstSeenAt) : '—')}
        </div>

        {/* ── Tabs ── */}
        <div className="vd-tabs">
          <button
            className={classNames('vd-tab', tab === 'profile' && 'active')}
            onClick={() => setTab('profile')}
          >
            Profile
          </button>
          <button
            className={classNames('vd-tab', tab === 'chats' && 'active')}
            onClick={() => setTab('chats')}
          >
            Past chats{chats ? ` (${chats.length})` : ''}
          </button>
        </div>

        {error && <div className="vd-error">{error}</div>}

        {tab === 'profile' && (
          <div className="vd-body">
            {/* CRM fields */}
            <section className="vd-section">
              <h4 className="vd-section-title">Contact details</h4>
              <div className="vd-form-grid">
                {(
                  [
                    ['name', 'Name', 'text'],
                    ['email', 'Email', 'email'],
                    ['phone', 'Phone', 'tel'],
                  ] as const
                ).map(([key, label, type]) => (
                  <label className="field" key={key}>
                    <span>{label}</span>
                    <input
                      type={type}
                      value={form[key]}
                      placeholder={`Add ${label.toLowerCase()}…`}
                      onChange={(e) => {
                        setForm((f) => ({ ...f, [key]: e.target.value }));
                        setDirty(true);
                      }}
                    />
                  </label>
                ))}
              </div>
              <label className="field">
                <span>Notes (internal)</span>
                <textarea
                  rows={3}
                  value={form.notes}
                  placeholder="Add notes about this visitor — only agents can see these."
                  onChange={(e) => {
                    setForm((f) => ({ ...f, notes: e.target.value }));
                    setDirty(true);
                  }}
                />
              </label>
              <div className="vd-form-actions">
                {savedFlash && <span className="vd-saved">✓ Saved</span>}
                <button className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || saving}>
                  {saving ? 'Saving…' : 'Save details'}
                </button>
              </div>
            </section>

            {/* Session path */}
            <section className="vd-section">
              <h4 className="vd-section-title">
                <IconEye size={14} /> Visitor path
              </h4>
              {profile && profile.sessionPath.length > 0 ? (
                <ol className="vd-path">
                  {[...profile.sessionPath].reverse().map((p, i) => (
                    <li
                      key={`${p.at}_${i}`}
                      className={classNames('vd-path-item', i === 0 && online && 'current')}
                    >
                      <span className="vd-path-time">{formatWhen(p.at)}</span>
                      <div className="vd-path-page">
                        <span className="vd-path-title">{p.title || pageLabel(p.url)}</span>
                        {p.url && (
                          <a
                            className="vd-path-url"
                            href={p.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={p.url}
                          >
                            {pageLabel(p.url)}
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="vd-muted">{profile ? 'No page views recorded yet.' : 'Loading…'}</p>
              )}
            </section>

            {/* Technology / source */}
            <section className="vd-section">
              <h4 className="vd-section-title">
                <IconGlobe size={14} /> Technology &amp; source
              </h4>
              <div className="vd-chips">
                {v?.userAgent && <span className="vd-chip">{ua.browser}</span>}
                {v?.userAgent && <span className="vd-chip">{ua.os}</span>}
                {v?.userAgent && <span className="vd-chip">{ua.device}</span>}
              </div>
              {infoRow('IP address', v?.ip)}
              {infoRow(
                'Location',
                v?.city || v?.country
                  ? `${flagEmoji(v?.countryCode)} ${[v?.city, v?.country].filter(Boolean).join(', ')}`
                  : null,
              )}
              {infoRow('Came from', v?.referrer ? referrerLabel(v.referrer) : 'Direct')}
              {infoRow('User agent', v?.userAgent && <code className="vd-ua">{v.userAgent}</code>)}
            </section>
          </div>
        )}

        {tab === 'chats' && (
          <div className="vd-body">
            {!chats && <p className="vd-muted">Loading…</p>}
            {chats && chats.length === 0 && <p className="vd-muted">No conversations yet.</p>}
            {chats?.map((c) => (
              <div key={c.id} className={classNames('vd-chat card', openChatId === c.id && 'open')}>
                <button className="vd-chat-head" onClick={() => void toggleTranscript(c.id)}>
                  <div className="vd-chat-main">
                    <span className={classNames('status-badge', `status-${c.status.toLowerCase()}`)}>
                      {c.status}
                    </span>
                    <span className="vd-chat-when">
                      <IconClock size={12} /> {formatDay(c.createdAt)} {formatTime(c.createdAt)}
                    </span>
                    {c.agentName && <span className="vd-chat-agent">with {c.agentName}</span>}
                    {c.rating != null && <span className="vd-chat-rating">{'★'.repeat(c.rating)}</span>}
                  </div>
                  {c.preview && <div className="vd-chat-preview">{c.preview}</div>}
                  <div className="vd-chat-count">{c.messageCount} messages</div>
                </button>
                {openChatId === c.id && (
                  <div className="vd-transcript">
                    {!transcript[c.id] && <p className="vd-muted">Loading transcript…</p>}
                    {transcript[c.id]?.filter((m) => m.kind === 'TEXT' || m.kind === 'SYSTEM')
                      .map((m) => (
                        <div
                          key={m.id}
                          className={classNames(
                            'vd-msg',
                            m.senderType === 'VISITOR' && 'from-visitor',
                            m.senderType === 'SYSTEM' && 'from-system',
                          )}
                        >
                          <span className="vd-msg-who">
                            {m.senderType === 'VISITOR'
                              ? name
                              : m.senderType === 'BOT'
                                ? 'AI Assistant'
                                : m.senderType === 'SYSTEM'
                                  ? ''
                                  : m.sender?.name || 'Agent'}
                          </span>
                          <span className="vd-msg-body">{m.body}</span>
                          <span className="vd-msg-time">{formatTime(m.createdAt)}</span>
                        </div>
                      ))}
                    <div className="vd-transcript-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => downloadTranscript(c)}>
                        <IconDownload size={14} /> Download .txt
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => onOpenConversation(c.id)}>
                        <IconMessage size={14} /> Open in Inbox
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
