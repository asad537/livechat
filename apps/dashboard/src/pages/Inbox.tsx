import React, { useEffect, useState } from 'react';
import { useApp } from '../state';
import ConversationList from '../components/ConversationList';
import ChatPane from '../components/ChatPane';
import { IconInbox } from '../icons';

export default function Inbox() {
  const { refreshConversations, conversations } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  // Drop the selection if the conversation disappears from scope.
  useEffect(() => {
    if (selectedId && !conversations[selectedId]) setSelectedId(null);
  }, [selectedId, conversations]);

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
