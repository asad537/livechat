import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useApp } from '../state';
import ConversationList from '../components/ConversationList';
import ChatPane from '../components/ChatPane';
import { IconInbox } from '../icons';

export default function Inbox() {
  const { refreshConversations, conversations } = useApp();
  const location = useLocation();
  const preselect = (location.state as { conversationId?: string } | null)?.conversationId ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(preselect);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  // Navigations from other pages (e.g. the visitor drawer) can preselect a chat.
  useEffect(() => {
    if (preselect) setSelectedId(preselect);
  }, [preselect]);

  // Drop the selection if the conversation disappears from scope.
  // (Preselected chats arrive via the AgentOpen ack, so don't race them.)
  useEffect(() => {
    if (selectedId && selectedId !== preselect && !conversations[selectedId]) setSelectedId(null);
  }, [selectedId, conversations, preselect]);

  return (
    <div className="inbox-layout">
      <ConversationList selectedId={selectedId} onSelect={setSelectedId} />
      {selectedId ? (
        <ChatPane conversationId={selectedId} showSidebar />
      ) : (
        <div className="chat-empty chat-empty-page">
          <IconInbox size={40} className="chat-empty-icon" />
          <p>Select a conversation</p>
          <p className="chat-empty-sub">Pick a chat from the list to read and reply.</p>
        </div>
      )}
    </div>
  );
}
