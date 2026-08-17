import React, { useMemo, useState } from 'react';
import type { ConversationSummary } from '@livechat/shared';
import { EV } from '@livechat/shared';
import { useApp } from '../state';
import { getSocket } from '../socket';
import { initials } from '../util';
import { IconX } from '../icons';

interface Props {
  conversation: ConversationSummary;
  onClose(): void;
}

export default function TransferModal({ conversation, onClose }: Props) {
  const { me, teams, websites, online, conversations, pushToast } = useApp();
  const [busy, setBusy] = useState(false);

  const candidates = useMemo(() => {
    const website = websites.find((w) => w.id === conversation.websiteId);
    const team = website ? teams.find((t) => t.id === website.teamId) : undefined;
    const members = team?.members ?? [];
    const activeCounts: Record<string, number> = {};
    for (const c of Object.values(conversations)) {
      if (c.status === 'ACTIVE' && c.assignedUserId) {
        activeCounts[c.assignedUserId] = (activeCounts[c.assignedUserId] ?? 0) + 1;
      }
    }
    return members
      .filter(
        (m) =>
          m.id !== conversation.assignedUserId &&
          m.id !== me?.id &&
          !!online[m.id],
      )
      .map((m) => ({
        ...m,
        activeCount: activeCounts[m.id] ?? m.activeChats ?? 0,
      }))
      .sort((a, b) => a.activeCount - b.activeCount);
  }, [teams, websites, conversation, online, conversations, me]);

  const transfer = (toUserId: string) => {
    const socket = getSocket();
    if (!socket || busy) return;
    setBusy(true);
    socket.emit(EV.AgentTransfer, { conversationId: conversation.id, toUserId });
    pushToast('Transfer requested', undefined, 'info');
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Transfer conversation</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX size={16} />
          </button>
        </div>
        <p className="modal-sub">Online team members with free capacity can take this chat.</p>
        <div className="modal-list">
          {candidates.length === 0 && (
            <div className="empty-hint">No other online agents are available right now.</div>
          )}
          {candidates.map((m) => {
            const atCapacity = m.activeCount >= m.maxChats;
            return (
              <button
                key={m.id}
                className="modal-row"
                disabled={atCapacity || busy}
                onClick={() => transfer(m.id)}
              >
                <span className="avatar" style={{ background: m.avatarColor }}>
                  {initials(m.name)}
                </span>
                <span className="modal-row-main">
                  <span className="modal-row-name">
                    {m.name}
                    <span className="dot dot-online" />
                  </span>
                  <span className="modal-row-sub">
                    {m.role} · {m.activeCount}/{m.maxChats} active chats
                    {atCapacity && ' · at capacity'}
                  </span>
                </span>
                <span className="btn btn-sm btn-ghost">Transfer</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
