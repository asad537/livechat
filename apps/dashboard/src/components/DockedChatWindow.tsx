import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../state';
import { initials } from '../util';
import { IconExpand, IconX } from '../icons';
import ChatPane from './ChatPane';

/**
 * Zendesk-style floating chat window: full ChatPane (composer, typing, calls,
 * type-to-join) docked above the bottom tab bar — chat from any page.
 */
export default function DockedChatWindow() {
  const { dockedChatId, closeDockedChat, conversations } = useApp();
  const navigate = useNavigate();
  if (!dockedChatId) return null;

  const conv = conversations[dockedChatId];
  const name = conv?.visitor?.name || `Visitor ${conv?.visitorId.slice(0, 6) ?? ''}`;

  return (
    <div className="docked-chat">
      <div className="docked-chat-bar">
        <span
          className="avatar avatar-xs"
          style={{ background: conv?.website?.primaryColor || 'var(--accent)' }}
        >
          {initials(name)}
        </span>
        <span className="docked-chat-title">{name}</span>
        <span className="docked-chat-actions">
          <button
            className="icon-btn icon-btn-dark"
            title="Open in Inbox"
            onClick={() => {
              closeDockedChat();
              navigate('/', { state: { conversationId: dockedChatId } });
            }}
          >
            <IconExpand size={14} />
          </button>
          <button
            className="icon-btn icon-btn-dark"
            title="Minimize"
            onClick={closeDockedChat}
          >
            <IconX size={14} />
          </button>
        </span>
      </div>
      <div className="docked-chat-body">
        <ChatPane conversationId={dockedChatId} showSidebar={false} />
      </div>
    </div>
  );
}
