import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useApp } from '../state';
import ConversationList from '../components/ConversationList';
import ChatPane from '../components/ChatPane';
import { IconInbox } from '../icons';

/**
 * "Incoming" — live chats that arrived while a human agent (CSR/Team Lead) was
 * online. They wait here for a person to pick up (the AI only posts a single
 * hold greeting). Chats that arrived with nobody online instead land in
 * "Offline Chats", where the AI handles them fully.
 */
export default function Incoming() {
  const { refreshConversations, conversations, openChatTab } = useApp();
  const location = useLocation();
  const preselect = (location.state as { conversationId?: string } | null)?.conversationId ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(preselect);

  // Every opened chat gets a tab in the bottom dock.
  useEffect(() => {
    if (selectedId) openChatTab(selectedId);
  }, [selectedId, openChatTab]);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  useEffect(() => {
    if (preselect) setSelectedId(preselect);
  }, [preselect]);

  // Drop the selection if the conversation disappears from scope.
  useEffect(() => {
    if (selectedId && selectedId !== preselect && !conversations[selectedId]) setSelectedId(null);
  }, [selectedId, conversations, preselect]);

  return (
    <div className="inbox-layout">
      <ConversationList selectedId={selectedId} onSelect={setSelectedId} queueOnly queueArrival="incoming" />
      {selectedId ? (
        <ChatPane conversationId={selectedId} showSidebar />
      ) : (
        <div className="chat-empty chat-empty-page">
          <IconInbox size={40} className="chat-empty-icon" />
          <p>Incoming chats</p>
          <p className="chat-empty-sub">
            New chats waiting for a live agent appear here — pick one to reply.
          </p>
        </div>
      )}
    </div>
  );
}
