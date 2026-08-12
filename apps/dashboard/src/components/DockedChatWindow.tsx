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
  const { dockedChatId, closeDockedChat, closeChatTab, conversations } = useApp();
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
            title="Minimize — keeps the tab below"
            onClick={closeDockedChat}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            className="icon-btn icon-btn-dark"
            title="Close chat window"
            onClick={() => {
              closeDockedChat();
              closeChatTab(dockedChatId);
            }}
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
