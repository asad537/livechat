import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../state';
import { classNames, initials, visitorNumber } from '../util';
import { IconX } from '../icons';

/** Zendesk-style bottom dock: every opened chat gets a tab you can switch to from any page. */
export default function ChatDock() {
  const { openChats, closeChatTab, conversations, dockedChatId, openDockedChat } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const onInbox = location.pathname === '/';
  const activeId = onInbox
    ? ((location.state as { conversationId?: string } | null)?.conversationId ?? null)
    : dockedChatId;

  const tabs = openChats
    .map((id) => conversations[id])
    .filter((c): c is NonNullable<typeof c> => Boolean(c));
  if (tabs.length === 0) return null;

  return (
    <div className="chat-dock">
      {tabs.map((c) => {
        const name = c.visitor?.name || `Visitor ${visitorNumber(c.visitorId)}`;
        const unread = c.unreadCount ?? 0;
        const closed = c.status === 'CLOSED' || c.status === 'MISSED';
        return (
          <button
            key={c.id}
            className={classNames('chat-dock-tab', c.id === activeId && 'active', closed && 'closed')}
            title={name}
            onClick={() => {
              // Inbox: select there. Any other page: open the floating chat window in place.
              if (onInbox) navigate('/', { state: { conversationId: c.id } });
              else openDockedChat(c.id);
            }}
          >
            <span
              className="avatar avatar-xs"
              style={{ background: c.website?.primaryColor || 'var(--accent)' }}
            >
              {initials(name)}
            </span>
            <span className="chat-dock-name">{name}</span>
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
