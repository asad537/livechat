import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state';
import { classNames, initials } from '../util';
import { IconX } from '../icons';

/**
 * Right-side drawer for internal team chat — 1-on-1 DMs between agents.
 * Slides in when the user clicks an online agent in the sidebar.
 */
export default function AgentDMDrawer() {
  const {
    me,
    teams,
    online,
    awayMap,
    dmOpenPeerId,
    dmMessages,
    dmThreads,
    closeDMDrawer,
    sendDM,
    markDMRead,
  } = useApp();

  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Look up peer from teams (that's the roster of names we have on the client).
  const peer = useMemo(() => {
    if (!dmOpenPeerId) return null;
    for (const t of teams) {
      const found = t.members?.find((m) => m.id === dmOpenPeerId);
      if (found) return found;
    }
    // Fall back to the thread's cached name if the peer isn't in any team.
    const th = dmThreads.find((t) => t.peerUserId === dmOpenPeerId);
    if (th) return { id: th.peerUserId, name: th.peerName, avatarColor: th.peerAvatarColor };
    return null;
  }, [dmOpenPeerId, teams, dmThreads]);

  const messages = dmOpenPeerId ? dmMessages[dmOpenPeerId] ?? [] : [];

  // Auto-scroll to bottom on new messages / opening a thread.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, dmOpenPeerId]);

  // Mark read whenever the drawer is open (or messages arrive while open).
  useEffect(() => {
    if (!dmOpenPeerId) return;
    markDMRead(dmOpenPeerId);
  }, [dmOpenPeerId, messages.length, markDMRead]);

  // Close on Escape.
  useEffect(() => {
    if (!dmOpenPeerId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDMDrawer();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dmOpenPeerId, closeDMDrawer]);

  if (!dmOpenPeerId || !me) return null;

  const isOnline = !!online[dmOpenPeerId];
  const isAway = !!awayMap[dmOpenPeerId];
  const statusText = !isOnline ? 'Offline' : isAway ? 'Away' : 'Online';
  const statusClass = !isOnline ? 'dot-offline' : isAway ? 'dot-away' : 'dot-online';
  const peerName = peer?.name ?? 'Agent';
  const peerColor = peer?.avatarColor ?? 'var(--accent)';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await sendDM(dmOpenPeerId, text);
  };

  return (
    <div className="dm-drawer" role="dialog" aria-label={`Chat with ${peerName}`}>
      <header className="dm-drawer-head">
        <span className="avatar" style={{ background: peerColor }}>
          {initials(peerName)}
        </span>
        <div className="dm-drawer-title">
          <div className="dm-drawer-name">{peerName}</div>
          <div className="dm-drawer-status">
            <span className={classNames('dot', statusClass)} /> {statusText}
          </div>
        </div>
        <button className="dm-drawer-close" onClick={closeDMDrawer} title="Close (Esc)">
          <IconX size={16} />
        </button>
      </header>

      <div className="dm-drawer-body" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="dm-empty">
            <div className="dm-empty-title">Say hi to {peerName}</div>
            <div className="dm-empty-sub">
              Internal team chat — only agents can see this conversation.
            </div>
          </div>
        ) : (
          messages.map((m) => {
            const mine = m.fromUserId === me.id;
            return (
              <div key={m.id} className={classNames('dm-msg', mine && 'dm-msg-mine')}>
                <div className="dm-msg-bubble">{m.body}</div>
                <div className="dm-msg-time">
                  {new Date(m.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {mine && m.readAt && <span className="dm-msg-read"> · Seen</span>}
                </div>
              </div>
            );
          })
        )}
      </div>

      <form className="dm-drawer-composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit(e as unknown as React.FormEvent);
            }
          }}
          placeholder={`Message ${peerName}…`}
          rows={2}
          maxLength={4000}
          autoFocus
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
