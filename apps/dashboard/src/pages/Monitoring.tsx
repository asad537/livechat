import React, { useEffect, useMemo, useState } from 'react';
import type { ConversationStatus } from '@livechat/shared';
import { useApp } from '../state';
import ChatPane from '../components/ChatPane';
import { StatusPill } from '../components/ConversationList';
import { classNames, formatWhen, initials } from '../util';
import { IconEye } from '../icons';

// Live Monitor shows only conversations happening right now.
const LIVE_STATUSES: ConversationStatus[] = ['WAITING', 'OFFERED', 'ACTIVE'];

// A chat only counts as "live" if it has had activity recently — this keeps
// stale, never-closed conversations (still flagged ACTIVE/WAITING from hours or
// days ago) out of the monitor. A live chat keeps refreshing this timestamp.
const LIVE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export default function Monitoring() {
  const { conversations, websites, teams, refreshConversations } = useApp();
  const [websiteFilter, setWebsiteFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  // Re-evaluate the recency window every minute so chats that go idle drop off
  // even when no new socket traffic arrives.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const agents = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of teams) {
      for (const m of t.members ?? []) seen.set(m.id, m.name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [teams]);

  const items = useMemo(() => {
    const now = Date.now();
    const lastActivity = (c: (typeof conversations)[string]) =>
      new Date(c.lastMessage?.createdAt ?? c.createdAt).getTime();
    return Object.values(conversations)
      .filter((c) => LIVE_STATUSES.includes(c.status)) // live statuses only
      .filter((c) => now - lastActivity(c) <= LIVE_WINDOW_MS) // active recently
      .filter((c) => (websiteFilter ? c.websiteId === websiteFilter : true))
      .filter((c) => (agentFilter ? c.assignedUserId === agentFilter : true))
      .filter((c) => (statusFilter ? c.status === statusFilter : true))
      .sort((a, b) => lastActivity(b) - lastActivity(a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, websiteFilter, agentFilter, statusFilter, tick]);

  return (
    <div className="page monitoring-page">
      <div className="page-head">
        <div>
          <h2>Live Monitor</h2>
          <p className="page-sub">
            Chats happening right now — Team Leads see their own CSRs&apos; chats, admins see everything.
          </p>
        </div>
        <div className="filters">
          <select value={websiteFilter} onChange={(e) => setWebsiteFilter(e.target.value)}>
            <option value="">All websites</option>
            {websites.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All live statuses</option>
            {LIVE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="monitoring-layout">
        <div className="monitoring-list">
          {items.length === 0 && <div className="empty-hint">No live chats right now.</div>}
          {items.map((c) => {
            const name = c.visitor?.name || `Visitor ${c.visitorId.slice(0, 6)}`;
            return (
              <button
                key={c.id}
                className={classNames('conv-item', selectedId === c.id && 'selected')}
                onClick={() => setSelectedId(c.id)}
              >
                <span className="avatar" style={{ background: c.website?.primaryColor || 'var(--accent)' }}>
                  {initials(name)}
                </span>
                <span className="conv-item-main">
                  <span className="conv-item-top">
                    <span className="conv-item-name">{name}</span>
                    <span className="conv-item-when">{formatWhen(c.lastMessage?.createdAt ?? c.createdAt)}</span>
                  </span>
                  <span className="conv-item-bottom">
                    <span className="conv-item-preview">
                      {c.lastMessage?.body ?? 'No messages yet'}
                    </span>
                  </span>
                  <span className="conv-item-tags">
                    <StatusPill status={c.status} />
                    {c.website?.name && <span className="chip">{c.website.name}</span>}
                    <span className="chip">{c.assignedUser?.name ?? 'Unassigned'}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {selectedId && conversations[selectedId] ? (
          <ChatPane conversationId={selectedId} showSidebar />
        ) : (
          <div className="chat-empty chat-empty-page">
            <IconEye size={40} className="chat-empty-icon" />
            <p>Pick a conversation to watch</p>
            <p className="chat-empty-sub">You will see messages arrive in real time.</p>
          </div>
        )}
      </div>
    </div>
  );
}
