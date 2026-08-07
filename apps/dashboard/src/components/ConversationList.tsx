import React, { useMemo, useState } from 'react';
import type { ConversationStatus, ConversationSummary } from '@livechat/shared';
import { useApp } from '../state';
import { classNames, formatWhen, initials } from '../util';

interface Props {
  selectedId: string | null;
  onSelect(id: string): void;
}

type Tab = 'mine' | 'queue' | 'all';

export function StatusPill({ status }: { status: ConversationStatus }) {
  return <span className={`pill pill-${status.toLowerCase()}`}>{status.toLowerCase()}</span>;
}

function lastActivity(c: ConversationSummary): number {
  const iso = c.lastMessage?.createdAt ?? c.createdAt;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function preview(c: ConversationSummary): string {
  const m = c.lastMessage;
  if (!m) return 'No messages yet';
  if (m.kind === 'FILE') return `Attachment: ${m.file?.originalName ?? 'file'}`;
  if (m.kind === 'CALL') return m.body || 'Call';
  return m.body;
}

export default function ConversationList({ selectedId, onSelect }: Props) {
  const { me, conversations } = useApp();
  const [tab, setTab] = useState<Tab>('mine');

  const all = useMemo(
    () => Object.values(conversations).sort((a, b) => lastActivity(b) - lastActivity(a)),
    [conversations],
  );

  const items = useMemo(() => {
    if (!me) return [];
    switch (tab) {
      case 'mine':
        return all.filter((c) => c.assignedUserId === me.id && c.status !== 'CLOSED' && c.status !== 'MISSED');
      case 'queue':
        return all.filter((c) => !c.assignedUserId && (c.status === 'WAITING' || c.status === 'OFFERED'));
      case 'all':
      default:
        return all;
    }
  }, [all, tab, me]);

  const mineCount = useMemo(
    () =>
      me
        ? all.filter((c) => c.assignedUserId === me.id && c.status !== 'CLOSED' && c.status !== 'MISSED').length
        : 0,
    [all, me],
  );
  const queueCount = useMemo(
    () => all.filter((c) => !c.assignedUserId && (c.status === 'WAITING' || c.status === 'OFFERED')).length,
    [all],
  );

  const showAllTab = me?.role === 'LEAD' || me?.role === 'ADMIN';

  return (
    <div className="conv-list">
      <div className="conv-tabs">
        <button
          className={classNames('conv-tab', tab === 'mine' && 'active')}
          onClick={() => setTab('mine')}
        >
          Mine{mineCount > 0 && <span className="conv-tab-count">{mineCount}</span>}
        </button>
        <button
          className={classNames('conv-tab', tab === 'queue' && 'active')}
          onClick={() => setTab('queue')}
        >
          Queue{queueCount > 0 && <span className="conv-tab-count">{queueCount}</span>}
        </button>
        {showAllTab && (
          <button
            className={classNames('conv-tab', tab === 'all' && 'active')}
            onClick={() => setTab('all')}
          >
            {me?.role === 'LEAD' ? 'Team' : 'All'}
          </button>
        )}
      </div>
      <div className="conv-scroll">
        {items.length === 0 && (
          <div className="empty-hint">
            {tab === 'queue' ? 'Queue is empty.' : 'No conversations here yet.'}
          </div>
        )}
        {items.map((c) => {
          const name = c.visitor?.name || `Visitor ${c.visitorId.slice(0, 6)}`;
          const unread = c.unreadCount ?? 0;
          return (
            <button
              key={c.id}
              className={classNames('conv-item', selectedId === c.id && 'selected')}
              onClick={() => onSelect(c.id)}
            >
              <span
                className="avatar"
                style={{ background: c.website?.primaryColor || 'var(--accent)' }}
              >
                {initials(name)}
              </span>
              <span className="conv-item-main">
                <span className="conv-item-top">
                  <span className="conv-item-name">{name}</span>
                  <span className="conv-item-when">{formatWhen(c.lastMessage?.createdAt ?? c.createdAt)}</span>
                </span>
                <span className="conv-item-bottom">
                  <span className="conv-item-preview">{preview(c)}</span>
                  {unread > 0 && <span className="badge">{unread}</span>}
                </span>
                <span className="conv-item-tags">
                  <StatusPill status={c.status} />
                  {c.website?.name && (
                    <span className="chip chip-site">
                      <span
                        className="chip-dot"
                        style={{ background: c.website.primaryColor || 'var(--accent)' }}
                      />
                      {c.website.name}
                    </span>
                  )}
                  {c.assignedUser && <span className="chip">{c.assignedUser.name}</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
