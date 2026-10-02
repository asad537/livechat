import React, { useEffect, useMemo, useState } from 'react';
import type { ConversationStatus } from '@livechat/shared';
import { EV } from '@livechat/shared';
import { useApp } from '../state';
import { getSocket } from '../socket';
import ChatPane from '../components/ChatPane';
import { StatusPill } from '../components/ConversationList';
import { classNames, formatWhen, initials, siteLabel, visitorNumber } from '../util';
import { IconEye } from '../icons';

// Live Monitor shows only conversations happening right now.
const LIVE_STATUSES: ConversationStatus[] = ['WAITING', 'OFFERED', 'ACTIVE'];

// A chat stays in the monitor only while the visitor is actually present — or
// for a short grace period after they leave the site, so a chat the customer
// just stepped away from doesn't vanish instantly. Past that, it drops off.
const LEFT_GRACE_MS = 3 * 60 * 1000; // 3 minutes

export default function Monitoring() {
  const { conversations, websites, teams, refreshConversations, visitorsByWebsite, connected } =
    useApp();

  // Watch every website's live visitor stream so we know who is currently on
  // the site (presence), independent of the conversation list.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    for (const w of websites) socket.emit(EV.AgentWatchWebsite, { websiteId: w.id });
  }, [websites, connected]);

  // visitorId -> { online, lastSeenAt } from the live stream. The stream only
  // carries ONLINE visitors, so presence = "appears in the stream".
  const onlineVisitorIds = useMemo(() => {
    const ids = new Set<string>();
    for (const w of websites) for (const v of visitorsByWebsite[w.id] ?? []) ids.add(v.id);
    return ids;
  }, [visitorsByWebsite, websites]);
  const [websiteFilter, setWebsiteFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  // Re-evaluate the grace window periodically so a chat drops off soon after the
  // visitor's 3-minute grace expires, even with no new socket traffic.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
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
    // Keep a chat only while the visitor is present, or within the grace window
    // after they left the site. Once they've been gone longer than the grace,
    // the chat drops off the monitor even though it's still technically ACTIVE.
    const visitorStillHere = (c: (typeof conversations)[string]) => {
      if (onlineVisitorIds.has(c.visitorId)) return true;
      const seen = c.visitor?.lastSeenAt ? new Date(c.visitor.lastSeenAt).getTime() : NaN;
      return !Number.isNaN(seen) && now - seen <= LEFT_GRACE_MS;
    };
    return Object.values(conversations)
      .filter((c) => LIVE_STATUSES.includes(c.status)) // live statuses only
      .filter((c) => visitorStillHere(c)) // visitor present, or left < 3 min ago
      // Only real two-way chats: the client must have replied at least once.
      // Agent-only outreach the visitor hasn't answered stays out of the monitor.
      .filter((c) => c.hasVisitorMessage !== false)
      .filter((c) => (websiteFilter ? c.websiteId === websiteFilter : true))
      .filter((c) => (agentFilter ? c.assignedUserId === agentFilter : true))
      .filter((c) => (statusFilter ? c.status === statusFilter : true))
      .sort((a, b) => lastActivity(b) - lastActivity(a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, websiteFilter, agentFilter, statusFilter, onlineVisitorIds, tick]);

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
                {siteLabel(w)}
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
            const name = c.visitor?.name || `Visitor ${visitorNumber(c.visitorId)}`;
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
                    {c.website?.name && <span className="chip">{siteLabel(c.website)}</span>}
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
