import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../state';
import { classNames, initials, visitorNumber } from '../util';
import { IconX } from '../icons';

/** Zendesk-style bottom dock: every opened chat gets a tab you can switch to from any page. */
export default function ChatDock() {
  const {
    me,
    openChats,
    closeChatTab,
    conversations,
    dockedChatId,
    openDockedChat,
    visitorsByWebsite,
    blinkChatIds,
    stopBlink,
  } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const onInbox = location.pathname === '/';
  const activeId = onInbox
    ? ((location.state as { conversationId?: string } | null)?.conversationId ?? null)
    : dockedChatId;

  // Admins oversee rather than handle chats — no bottom chat dock for them.
  if (me?.role === 'ADMIN') return null;

  // Strictly OWN chats — every role (CSR / LEAD / MANAGER) only sees tiles
  // for conversations assigned to them personally. Team leads and managers
  // can still open a supervised chat from the Inbox / Live Monitor to
  // review, but it won't leave a dock tile for someone else's work.
  const canDock = (assignedUserId: string | null): boolean =>
    !!assignedUserId && assignedUserId === me?.id;

  const tabs = openChats
    .map((id) => conversations[id])
    .filter((c): c is NonNullable<typeof c> => Boolean(c) && canDock(c.assignedUserId));
  if (tabs.length === 0) return null;

  return (
    <div className="chat-dock">
      {tabs.map((c) => {
        const name = c.visitor?.name || `Visitor ${visitorNumber(c.visitorId)}`;
        const unread = c.unreadCount ?? 0;
        const closed = c.status === 'CLOSED' || c.status === 'MISSED';
        // Gray the tab name when the visitor has left the site (offline) — the
        // live stream is authoritative, else use the summary snapshot.
        const liveVisitor = visitorsByWebsite[c.websiteId]?.find((v) => v.id === c.visitorId);
        const offline = liveVisitor ? !liveVisitor.online : !c.visitor?.online;
        return (
          <button
            key={c.id}
            className={classNames(
              'chat-dock-tab',
              c.id === activeId && 'active',
              closed && 'closed',
              blinkChatIds.includes(c.id) && 'blink',
            )}
            title={name}
            onClick={() => {
              stopBlink(c.id); // looking at it clears the attention pulse
              // Inbox: select there. Any other page: open the floating chat window in place.
              if (onInbox) navigate('/', { state: { conversationId: c.id } });
              else openDockedChat(c.id);
            }}
          >
            <span
              className={classNames('avatar', 'avatar-xs', offline && 'is-offline')}
              style={{ background: offline ? undefined : c.website?.primaryColor || 'var(--accent)' }}
            >
              {initials(name)}
            </span>
            <span className={classNames('chat-dock-name', offline && 'is-offline')}>{name}</span>
            {unread > 0 && <span className="badge">{unread}</span>}
            <span
              className="chat-dock-close"
              role="button"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                closeChatTab(c.id);
              }}
            >
              <IconX size={12} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
