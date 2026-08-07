import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Visitor } from '@livechat/shared';
import { EV } from '@livechat/shared';
import { useApp } from '../state';
import { getSocket } from '../socket';
import { classNames, initials } from '../util';
import VisitorCard from '../components/VisitorCard';
import { IconUsers, IconX } from '../icons';

export default function Visitors() {
  const { websites, visitorsByWebsite, pushToast } = useApp();
  const navigate = useNavigate();
  const [websiteId, setWebsiteId] = useState<string | null>(null);
  const [startTarget, setStartTarget] = useState<Visitor | null>(null);
  const [firstMessage, setFirstMessage] = useState('');

  const activeWebsiteId = websiteId ?? websites[0]?.id ?? null;
  const activeWebsite = websites.find((w) => w.id === activeWebsiteId) ?? null;

  // (Re)subscribe to the visitor stream of the selected website.
  useEffect(() => {
    if (!activeWebsiteId) return;
    getSocket()?.emit(EV.AgentWatchWebsite, { websiteId: activeWebsiteId });
  }, [activeWebsiteId]);

  const visitors = useMemo(() => {
    const list = activeWebsiteId ? visitorsByWebsite[activeWebsiteId] ?? [] : [];
    return [...list].sort((a, b) => Number(!!b.online) - Number(!!a.online));
  }, [visitorsByWebsite, activeWebsiteId]);

  const onlineCount = visitors.filter((v) => v.online).length;

  const startChat = () => {
    const body = firstMessage.trim();
    if (!body || !startTarget || !activeWebsiteId) return;
    getSocket()?.emit(EV.AgentStartChat, {
      websiteId: activeWebsiteId,
      visitorId: startTarget.id,
      body,
    });
    pushToast('Chat started', `Your message was sent to ${startTarget.name || 'the visitor'}.`, 'success');
    setStartTarget(null);
    setFirstMessage('');
    navigate('/');
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Visitors</h2>
          <p className="page-sub">
            {onlineCount} online now{activeWebsite ? ` on ${activeWebsite.name}` : ''}
          </p>
        </div>
        <div className="site-switcher">
          {websites.map((w) => (
            <button
              key={w.id}
              className={classNames('site-pill', w.id === activeWebsiteId && 'active')}
              onClick={() => setWebsiteId(w.id)}
            >
              <span className="chip-dot" style={{ background: w.primaryColor }} />
              {w.name}
            </button>
          ))}
        </div>
      </div>

      {websites.length === 0 && <div className="empty-hint">No websites are assigned to you yet.</div>}

      <div className="visitor-grid">
        {visitors.map((v) => (
          <VisitorCard
            key={v.id}
            visitor={v}
            accentColor={activeWebsite?.primaryColor || 'var(--accent)'}
            onStartChat={setStartTarget}
          />
        ))}
        {activeWebsiteId && visitors.length === 0 && (
          <div className="empty-state card">
            <IconUsers size={32} className="empty-state-icon" />
            <p>No visitors right now</p>
            <p className="chat-empty-sub">Visitors appear here live as they browse {activeWebsite?.name}.</p>
          </div>
        )}
      </div>

      {startTarget && (
        <div className="modal-backdrop" onClick={() => setStartTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Start a chat</h3>
              <button className="icon-btn" onClick={() => setStartTarget(null)} aria-label="Close">
                <IconX size={16} />
              </button>
            </div>
            <div className="modal-visitor">
              <span
                className="avatar"
                style={{ background: activeWebsite?.primaryColor || 'var(--accent)' }}
              >
                {initials(startTarget.name || 'V')}
              </span>
              <div>
                <div className="modal-row-name">{startTarget.name || `Visitor ${startTarget.id.slice(0, 6)}`}</div>
                <div className="modal-row-sub">{startTarget.email || 'No email'}</div>
              </div>
            </div>
            <label className="field">
              <span>First message</span>
              <textarea
                rows={3}
                value={firstMessage}
                autoFocus
                placeholder="Hi there — anything I can help you with?"
                onChange={(e) => setFirstMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    startChat();
                  }
                }}
              />
            </label>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setStartTarget(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={startChat} disabled={!firstMessage.trim()}>
                Send and open chat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
