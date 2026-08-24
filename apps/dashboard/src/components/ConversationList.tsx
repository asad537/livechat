import React, { useEffect, useMemo, useState } from 'react';
import type { ConversationStatus, ConversationSummary } from '@livechat/shared';
import { useApp } from '../state';
import { api } from '../api';
import { classNames, formatWhen, initials, siteLabel, visitorNumber } from '../util';

interface Props {
  selectedId: string | null;
  onSelect(id: string): void;
  /** Offline Chats view: show only the unassigned queue, no tab switcher. */
  queueOnly?: boolean;
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

export default function ConversationList({ selectedId, onSelect, queueOnly }: Props) {
  const { me, conversations } = useApp();
  const [tab, setTab] = useState<Tab>(queueOnly ? 'queue' : 'mine');
  const effectiveTab: Tab = queueOnly ? 'queue' : tab;
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ConversationSummary[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Debounced server search: visitor name/email + message content.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = window.setTimeout(() => {
      api
        .searchConversations(q)
        .then((res) => setSearchResults(res))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(t);
  }, [query]);

  const all = useMemo(
    () => Object.values(conversations).sort((a, b) => lastActivity(b) - lastActivity(a)),
    [conversations],
  );

  const items = useMemo(() => {
    if (!me) return [];
    switch (effectiveTab) {
      case 'mine':
        return all.filter((c) => c.assignedUserId === me.id && c.status !== 'CLOSED' && c.status !== 'MISSED');
      case 'queue':
        // Queue = chats truly waiting, nobody handling them yet. OFFERED chats
        // are already ringing a specific agent (being picked up), so they don't
        // belong here — only WAITING.
        return all.filter((c) => c.status === 'WAITING');
      case 'all':
      default:
        return all;
    }
  }, [all, effectiveTab, me]);

  const mineCount = useMemo(
    () =>
      me
        ? all.filter((c) => c.assignedUserId === me.id && c.status !== 'CLOSED' && c.status !== 'MISSED').length
        : 0,
    [all, me],
  );
  const queueCount = useMemo(() => all.filter((c) => c.status === 'WAITING').length, [all]);

  const showAllTab = me != null && me.role !== 'CSR';

  const displayItems = searchResults ?? items;

  return (
    <div className="conv-list">
      <div className="conv-search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          type="search"
          placeholder="Search name, email or message…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="conv-search-clear" onClick={() => setQuery('')} title="Clear">
            ✕
          </button>
        )}
      </div>
      {searchResults === null && !queueOnly && (
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
            {me?.role === 'LEAD' ? 'My Team' : 'All'}
          </button>
        )}
      </div>
      )}
      <div className="conv-scroll">
        {searchResults !== null && (
          <div className="conv-search-status">
            {searching ? 'Searching…' : `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}`}
          </div>
        )}
        {displayItems.length === 0 && (
          <div className="empty-hint">
            {searchResults !== null
              ? searching
                ? ''
                : 'No matches found.'
              : effectiveTab === 'queue'
                ? queueOnly
                  ? 'No offline chats waiting.'
                  : 'Queue is empty.'
                : 'No conversations here yet.'}
          </div>
        )}
        {displayItems.map((c) => {
          const name = c.visitor?.name || `Visitor ${visitorNumber(c.visitorId)}`;
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
                      {siteLabel(c.website)}
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
