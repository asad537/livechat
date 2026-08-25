import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../state';
import { initials, visitorNumber } from '../util';
import { IconExpand, IconUser, IconX } from '../icons';
import ChatPane from './ChatPane';
import VisitorDrawer from './VisitorDrawer';

/**
 * Zendesk-style floating chat window: full ChatPane (composer, typing, calls,
 * type-to-join) docked above the bottom tab bar — chat from any page.
 */
export default function DockedChatWindow() {
  const { dockedChatId, closeDockedChat, closeChatTab, conversations, openDockedChat, visitorsByWebsite } =
    useApp();
  const navigate = useNavigate();
  const [showProfile, setShowProfile] = useState(false);
  if (!dockedChatId) return null;

  const conv = conversations[dockedChatId];
  const name = conv?.visitor?.name || `Visitor ${visitorNumber(conv?.visitorId)}`;
  // Live online: the visitors stream only carries currently-online visitors, so
  // presence there is authoritative; fall back to the summary's snapshot.
  const liveVisitor = conv
    ? visitorsByWebsite[conv.websiteId]?.find((v) => v.id === conv.visitorId)
    : undefined;
  const isOnline = liveVisitor ? !!liveVisitor.online : !!conv?.visitor?.online;

  return (
    <div className="docked-chat">
      <div className="docked-chat-bar">
        <span
          className={`avatar avatar-xs${isOnline ? '' : ' is-offline'}`}
          style={{ background: isOnline ? conv?.website?.primaryColor || 'var(--accent)' : undefined }}
        >
          {initials(name)}
        </span>
        <span className={`docked-chat-title${isOnline ? '' : ' is-offline'}`}>{name}</span>
        <span className="docked-chat-actions">
          {conv?.visitorId && (
            <button
              className="icon-btn icon-btn-dark"
              title="Client details — view or edit contact info"
              onClick={() => setShowProfile(true)}
            >
              <IconUser size={14} />
            </button>
          )}
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

      {showProfile && conv?.visitorId && (
        <VisitorDrawer
          visitorId={conv.visitorId}
          accentColor={conv.website?.primaryColor || 'var(--accent)'}
          onClose={() => setShowProfile(false)}
          onStartChat={() => setShowProfile(false)}
          onOpenConversation={(conversationId) => {
            setShowProfile(false);
            openDockedChat(conversationId);
          }}
        />
      )}
    </div>
  );
}
