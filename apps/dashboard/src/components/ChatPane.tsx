import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssignmentRecord,
  CallMeta,
  ChatMessage,
  ConversationSummary,
  VisitorPage,
} from '@livechat/shared';
import { EV } from '@livechat/shared';
import { useApp } from '../state';
import { getSocket } from '../socket';
import { api, uploadFile, type Shortcut } from '../api';
import { classNames, formatDay, formatTime, formatWhen, initials, newTempId, pageLabel, siteLabel, visitorNumber } from '../util';
import MessageBubble from './MessageBubble';
import HistoryTimeline from './HistoryTimeline';
import TransferModal from './TransferModal';
import { StatusPill } from './ConversationList';
import {
  IconCheck,
  IconEye,
  IconGlobe,
  IconPaperclip,
  IconPhone,
  IconSend,
  IconStar,
  IconTransfer,
  IconVideo,
  IconX,
} from '../icons';

interface Props {
  conversationId: string;
  showSidebar?: boolean;
}

// Shared canned-response cache — fetched once per session, refreshed on edit.
let shortcutsCache: Shortcut[] | null = null;
async function loadShortcuts(force = false): Promise<Shortcut[]> {
  if (!shortcutsCache || force) {
    shortcutsCache = await api.shortcuts().catch(() => [] as Shortcut[]);
  }
  return shortcutsCache;
}

interface OpenAck {
  conversation?: ConversationSummary;
  messages?: ChatMessage[];
  history?: AssignmentRecord[];
  error?: string;
}

export default function ChatPane({ conversationId, showSidebar = true }: Props) {
  const {
    me,
    csrIds,
    conversations,
    updateConversation,
    markConversationRead,
    startCall,
    pushToast,
    online,
    visitorsByWebsite,
    closeChatTab,
    closeDockedChat,
  } = useApp();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<AssignmentRecord[]>([]);
  const [sessionPath, setSessionPath] = useState<VisitorPage[]>([]);
  const [openError, setOpenError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [visitorTyping, setVisitorTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);

  // ── Canned response shortcuts ──
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [scOpen, setScOpen] = useState(false); // popover (⚡ or "/" trigger)
  const [scIndex, setScIndex] = useState(0);
  const [scManage, setScManage] = useState(false);
  const [scTitle, setScTitle] = useState('');
  const [scBody, setScBody] = useState('');
  useEffect(() => {
    void loadShortcuts().then(setShortcuts);
  }, []);

  // "/" at the start of the draft filters shortcuts inline.
  const slashMode = draft.startsWith('/');
  const scFilter = slashMode ? draft.slice(1).toLowerCase() : '';
  const scList = useMemo(() => {
    if (!slashMode && !scOpen) return [];
    if (!scFilter) return shortcuts;
    return shortcuts.filter(
      (s) => s.title.toLowerCase().includes(scFilter) || s.body.toLowerCase().includes(scFilter),
    );
  }, [shortcuts, slashMode, scOpen, scFilter]);
  const scVisible = (slashMode || scOpen) && scList.length > 0;
  useEffect(() => setScIndex(0), [scFilter, scOpen]);

  const applyShortcut = (s: Shortcut) => {
    setDraft(s.body);
    setScOpen(false);
    const el = composerRef.current;
    if (el) {
      el.focus();
      // Let React paint the new value before resizing the box to fit it.
      requestAnimationFrame(() => autoGrow());
    }
  };

  // Composer grows with the text (up to ~6 lines) so nothing is hidden.
  const autoGrow = () => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  };
  useEffect(() => {
    autoGrow();
  }, [draft]);
  const [showTransfer, setShowTransfer] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const typingRef = useRef<{ active: boolean; timer: number | null }>({ active: false, timer: null });
  const readSentRef = useRef<Set<string>>(new Set());

  const conversation = conversations[conversationId];

  // Freshest webpage the visitor is on: the live visitors stream updates on
  // every navigation, so it can carry a current page even when the conversation
  // summary's copy is stale or missing (e.g. a TL watching a team chat — #22).
  const liveVisitor = conversation
    ? visitorsByWebsite[conversation.websiteId]?.find((vv) => vv.id === conversation.visitorId)
    : undefined;
  const currentPage = conversation?.visitor?.currentPage ?? liveVisitor?.currentPage ?? null;

  // Full page-view history for the side panel's "Visitor path" timeline.
  const visitorId = conversation?.visitorId;
  useEffect(() => {
    if (!showSidebar || !visitorId) {
      setSessionPath([]);
      return;
    }
    let cancelled = false;
    void api
      .visitorProfile(visitorId)
      .then((p) => {
        if (!cancelled) setSessionPath(p.sessionPath ?? []);
      })
      .catch(() => {
        if (!cancelled) setSessionPath([]);
      });
    return () => {
      cancelled = true;
    };
  }, [visitorId, showSidebar]);

  const canSend = useMemo(() => {
    if (!me || !conversation) return false;
    if (conversation.status === 'CLOSED' || conversation.status === 'MISSED') return false;
    const boss = me.role === 'ADMIN' || me.role === 'MANAGER'; // full chat access
    const assigneeIsMyCsr =
      me.role === 'LEAD' &&
      conversation.assignedUserId != null &&
      csrIds.includes(conversation.assignedUserId);
    if (conversation.status === 'WAITING') {
      // Zendesk-style: typing in a queued chat joins it.
      return (
        conversation.assignedUserId === me.id ||
        conversation.assignedUserId == null ||
        assigneeIsMyCsr ||
        boss
      );
    }
    // ACTIVE: assignee, ADMIN/MANAGER, or the assignee's Team Lead may reply.
    return conversation.assignedUserId === me.id || boss || assigneeIsMyCsr;
  }, [me, csrIds, conversation]);

  const joinByTyping = canSend && conversation?.status === 'WAITING';

  // Keep the composer focused across the WAITING→ACTIVE transition (sending the
  // first "Hi" claims the chat and re-renders the composer — previously the
  // agent had to click back into the box to type the next message).
  useEffect(() => {
    if (canSend) composerRef.current?.focus();
  }, [canSend, conversation?.status]);

  const watchingReadOnly = !!conversation && !canSend && !openError &&
    conversation.status !== 'CLOSED' && conversation.status !== 'MISSED' &&
    (me?.role === 'LEAD' || me?.role === 'ADMIN' || me?.role === 'MANAGER') &&
    conversation.assignedUserId !== me?.id;

  const markRead = useCallback(
    (msgs: ChatMessage[]) => {
      const socket = getSocket();
      if (!socket) return;
      const ids = msgs
        .filter((m) => m.senderType === 'VISITOR' && !m.readAt && !readSentRef.current.has(m.id))
        .map((m) => m.id);
      if (ids.length === 0) return;
      for (const id of ids) readSentRef.current.add(id);
      socket.emit(EV.AgentRead, { conversationId, messageIds: ids });
      setMessages((prev) =>
        prev.map((m) => (ids.includes(m.id) ? { ...m, readAt: new Date().toISOString() } : m)),
      );
      markConversationRead(conversationId);
    },
    [conversationId, markConversationRead],
  );

  // ─── Open conversation + live listeners ────────────────────
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    let disposed = false;
    setMessages([]);
    setHistory([]);
    setOpenError(null);
    setLoading(true);
    setVisitorTyping(false);
    setDraft('');
    readSentRef.current = new Set();

    socket.emit(EV.AgentOpen, { conversationId }, (ack: OpenAck) => {
      if (disposed) return;
      setLoading(false);
      if (!ack || ack.error) {
        // Forbidden / not-found → this chat should not be sitting in the dock
        // waiting to be re-clicked. Drop the tile and close the floating
        // window so the agent isn't stuck staring at a dead 'Forbidden' popup.
        const err = ack?.error ?? 'Could not open this conversation.';
        setOpenError(err);
        if (err === 'Forbidden' || err === 'Conversation not found') {
          closeChatTab(conversationId);
          closeDockedChat();
          pushToast(
            'Chat unavailable',
            err === 'Forbidden'
              ? 'This chat is assigned to another agent.'
              : 'This chat is no longer available.',
            'info',
          );
        }
        return;
      }
      if (ack.conversation) updateConversation(ack.conversation);
      setMessages(ack.messages ?? []);
      setHistory(ack.history ?? []);
      markRead(ack.messages ?? []);
    });

    const onMessage = (payload: { message: ChatMessage }) => {
      const msg = payload.message;
      if (!msg || msg.conversationId !== conversationId) return;
      setMessages((prev) => {
        if (msg.tempId) {
          const idx = prev.findIndex((m) => m.tempId === msg.tempId && m.id.startsWith('tmp_'));
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = msg;
            return next;
          }
        }
        if (prev.some((m) => m.id === msg.id)) {
          return prev.map((m) => (m.id === msg.id ? msg : m));
        }
        return [...prev, msg];
      });
      if (msg.senderType === 'VISITOR') {
        setVisitorTyping(false);
        markRead([msg]);
      }
    };

    const onReceipt = (payload: {
      conversationId: string;
      messageIds: string[];
      deliveredAt?: string;
      readAt?: string;
    }) => {
      if (payload.conversationId !== conversationId) return;
      const ids = new Set(payload.messageIds ?? []);
      setMessages((prev) =>
        prev.map((m) =>
          ids.has(m.id)
            ? {
                ...m,
                deliveredAt: payload.deliveredAt ?? m.deliveredAt,
                readAt: payload.readAt ?? m.readAt,
              }
            : m,
        ),
      );
    };

    const onTyping = (payload: { conversationId: string; from: 'VISITOR' | 'AGENT'; typing: boolean }) => {
      if (payload.conversationId !== conversationId || payload.from !== 'VISITOR') return;
      setVisitorTyping(payload.typing);
    };

    // Keep CALL message cards in sync (Ringing… → In progress → Call ended).
    const onCallStatus = (payload: { call: CallMeta }) => {
      const meta = payload.call;
      if (!meta || meta.conversationId !== conversationId) return;
      setMessages((prev) => prev.map((m) => (m.callId === meta.id ? { ...m, call: meta } : m)));
    };

    // Auto-translate: a visitor message's English translation arrives a beat
    // after the message itself → patch the bubble in place.
    const onTranslation = (payload: {
      conversationId: string;
      messageId: string;
      translatedBody: string;
      origLang: string;
    }) => {
      if (payload.conversationId !== conversationId) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === payload.messageId
            ? { ...m, translatedBody: payload.translatedBody, origLang: payload.origLang }
            : m,
        ),
      );
    };

    socket.on(EV.ChatMessage, onMessage);
    socket.on(EV.ChatReceipt, onReceipt);
    socket.on(EV.ChatTyping, onTyping);
    socket.on(EV.CallStatus, onCallStatus);
    socket.on(EV.ChatTranslation, onTranslation);

    return () => {
      disposed = true;
      socket.off(EV.ChatMessage, onMessage);
      socket.off(EV.ChatReceipt, onReceipt);
      socket.off(EV.ChatTyping, onTyping);
      socket.off(EV.CallStatus, onCallStatus);
      socket.off(EV.ChatTranslation, onTranslation);
      const t = typingRef.current;
      if (t.timer !== null) window.clearTimeout(t.timer);
      t.active = false;
      t.timer = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Auto-scroll to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, visitorTyping]);

  // ─── Actions ───────────────────────────────────────────────
  const emitTyping = (typing: boolean) => {
    const socket = getSocket();
    if (!socket || !canSend) return;
    const state = typingRef.current;
    if (typing) {
      if (!state.active) {
        state.active = true;
        socket.emit(EV.AgentTyping, { conversationId, typing: true });
      }
      if (state.timer !== null) window.clearTimeout(state.timer);
      state.timer = window.setTimeout(() => {
        state.active = false;
        socket.emit(EV.AgentTyping, { conversationId, typing: false });
      }, 1800);
    } else if (state.active) {
      state.active = false;
      if (state.timer !== null) window.clearTimeout(state.timer);
      state.timer = null;
      socket.emit(EV.AgentTyping, { conversationId, typing: false });
    }
  };

  const send = () => {
    const socket = getSocket();
    const body = draft.trim();
    if (!socket || !body || !canSend || !me) return;
    const tempId = newTempId();
    const optimistic: ChatMessage = {
      id: `tmp_${tempId}`,
      conversationId,
      senderType: 'AGENT',
      senderUserId: me.id,
      body,
      kind: 'TEXT',
      fileId: null,
      callId: null,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      readAt: null,
      sender: { name: me.name, avatarColor: me.avatarColor },
      tempId,
    };
    setMessages((prev) => [...prev, optimistic]);
    socket.emit(EV.AgentMessage, { conversationId, body, tempId });
    setDraft('');
    emitTyping(false);
    // Stay in the box for the next message.
    composerRef.current?.focus();
  };

  const accept = () => {
    getSocket()?.emit(EV.AgentAccept, { conversationId });
  };

  const closeConversation = () => {
    // The visitor is still browsing — make sure this isn't a mis-click that
    // kills a live conversation.
    if (conversation?.visitor?.online) {
      const name = conversation.visitor.name || 'The visitor';
      if (!window.confirm(`${name} is still on the website. End this chat anyway?`)) return;
    }
    getSocket()?.emit(EV.AgentClose, { conversationId });
  };

  const attach = async (file: File) => {
    setUploading(true);
    try {
      await uploadFile(conversationId, file);
    } catch (err) {
      pushToast('Upload failed', err instanceof Error ? err.message : undefined, 'error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Drag & drop a file anywhere over the chat to upload it.
  const [dragOver, setDragOver] = useState(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!canSend) return;
    const f = e.dataTransfer.files?.[0];
    if (f) void attach(f);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!canSend) return;
    e.preventDefault();
    if (!dragOver) setDragOver(true);
  };

  // ─── Render ────────────────────────────────────────────────
  if (openError) {
    return (
      <div className="chatpane">
        <div className="chat-main">
          <div className="chat-empty">
            <p>{openError}</p>
            <p className="chat-empty-sub">
              You may not have access yet — queued chats open once they are assigned.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const visitorName = conversation?.visitor?.name || `Visitor ${visitorNumber(conversation?.visitorId)}`;
  const showAccept =
    !!conversation &&
    conversation.status === 'WAITING' &&
    !!me &&
    (conversation.assignedUserId === me.id ||
      conversation.assignedUserId == null ||
      me.role === 'ADMIN' ||
      (me.role === 'LEAD' &&
        conversation.assignedUserId != null &&
        csrIds.includes(conversation.assignedUserId)));

  // Keyboard shortcut: Space or Enter accepts a waiting chat, so the agent
  // never has to reach for the mouse. Ignored while typing in a field so a
  // draft note isn't hijacked, and only wired while showAccept is true so
  // stray keystrokes on an already-live chat do nothing.
  useEffect(() => {
    if (!showAccept) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      e.preventDefault();
      accept();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAccept, conversationId]);

  let lastDay = '';

  return (
    <div
      className={classNames('chatpane', dragOver && 'chatpane-drag')}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
    >
      {dragOver && (
        <div className="chat-drop-overlay">
          <IconPaperclip size={28} />
          <span>Drop the file to send</span>
        </div>
      )}
      <div className="chat-main">
        {/* Header */}
        <div className="chat-head">
          <div className="chat-head-id">
            <span
              className="avatar"
              style={{ background: conversation?.website?.primaryColor || 'var(--accent)' }}
            >
              {initials(visitorName)}
            </span>
            <div className="chat-head-meta">
              <span className="chat-head-name">
                <span className="chat-head-name-text">{visitorName}</span>
                {conversation?.visitor?.online && <span className="dot dot-online" title="Online" />}
              </span>
              <span className="chat-head-sub">
                <span className="chat-head-email">
                  {conversation?.visitor?.email || 'No email provided'}
                </span>
                {conversation?.website?.name && (
                  <span className="chip chip-site">
                    <span
                      className="chip-dot"
                      style={{ background: conversation.website.primaryColor || 'var(--accent)' }}
                    />
                    {siteLabel(conversation.website)}
                  </span>
                )}
                {conversation && <StatusPill status={conversation.status} />}
              </span>
            </div>
          </div>
          <div className="chat-head-actions">
            {showAccept && (
              <button
                className="btn btn-primary btn-sm"
                onClick={accept}
                autoFocus
                title="Accept (Space / Enter)"
              >
                <IconCheck size={15} /> Accept
              </button>
            )}
            {canSend && conversation?.status === 'ACTIVE' && (
              <>
                <button
                  className="icon-btn"
                  title="Request feedback — the customer gets a rating prompt"
                  onClick={() => {
                    getSocket()?.emit(EV.AgentRequestFeedback, { conversationId });
                    pushToast('Feedback requested', 'The customer can now rate this chat. ⭐', 'success');
                  }}
                >
                  <IconStar size={17} />
                </button>
                <button
                  className="icon-btn"
                  title="Start audio call"
                  onClick={() => startCall(conversationId, 'AUDIO')}
                >
                  <IconPhone size={17} />
                </button>
                <button
                  className="icon-btn"
                  title="Start video call"
                  onClick={() => startCall(conversationId, 'VIDEO')}
                >
                  <IconVideo size={17} />
                </button>
              </>
            )}
            {conversation && conversation.status !== 'CLOSED' && conversation.status !== 'MISSED' && (me?.role !== 'CSR' || canSend) && (
              <>
                <button className="icon-btn" title="Transfer" onClick={() => setShowTransfer(true)}>
                  <IconTransfer size={17} />
                </button>
                <button className="icon-btn icon-btn-danger" title="Close conversation" onClick={closeConversation}>
                  <IconX size={17} />
                </button>
              </>
            )}
          </div>
        </div>

        {watchingReadOnly && (
          <div className="watch-banner">
            <IconEye size={15} />
            Monitoring — you are watching this conversation live. Only the assigned agent can reply.
          </div>
        )}

        {/* Messages */}
        <div className="chat-scroll" ref={scrollRef}>
          {loading && <div className="empty-hint">Loading conversation…</div>}
          {!loading && messages.length === 0 && <div className="empty-hint">No messages yet.</div>}
          {messages.map((m) => {
            const day = formatDay(m.createdAt);
            const sep = day !== lastDay;
            lastDay = day;
            return (
              <React.Fragment key={m.tempId ?? m.id}>
                {sep && (
                  <div className="day-sep">
                    <span>{day}</span>
                  </div>
                )}
                <MessageBubble message={m} />
              </React.Fragment>
            );
          })}
          {visitorTyping && (
            <div className="msg-row msg-row-other">
              <div className="msg-bubble msg-bubble-other typing-bubble">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
            </div>
          )}
        </div>

        {/* Composer */}
        {joinByTyping && (
          <div className="composer-join-hint">
            <span className="composer-join-eye">👀</span> You&apos;re viewing this chat — start
            typing to join
          </div>
        )}
        <div className="composer">
          {conversation?.status === 'CLOSED' || conversation?.status === 'MISSED' ? (
            <div className="composer-closed">
              This conversation is {conversation.status === 'CLOSED' ? 'closed' : 'marked as missed'}.
            </div>
          ) : !canSend ? (
            <div className="composer-closed">
              {watchingReadOnly
                  ? 'Read-only view.'
                  : conversation?.status === 'WAITING'
                    ? 'Accept the chat to start replying.'
                    : 'Only the assigned agent can reply.'}
            </div>
          ) : (
            <>
              <input
                ref={fileInputRef}
                type="file"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void attach(f);
                }}
              />
              <button
                className="icon-btn"
                title="Attach file"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                <IconPaperclip size={17} className={uploading ? 'spin-soft' : undefined} />
              </button>
              <button
                className={classNames('icon-btn', scOpen && 'active')}
                title="Shortcuts — or type / in the box"
                onClick={() => setScOpen((v) => !v)}
              >
                ⚡
              </button>
              {scVisible && (
                <div className="sc-pop">
                  {scList.map((s, i) => (
                    <button
                      key={s.id}
                      className={classNames('sc-item', i === scIndex && 'active')}
                      onMouseEnter={() => setScIndex(i)}
                      onClick={() => applyShortcut(s)}
                    >
                      <span className="sc-title">{s.title}</span>
                      <span className="sc-body">{s.body}</span>
                    </button>
                  ))}
                  <button className="sc-manage" onClick={() => { setScOpen(false); setScManage(true); }}>
                    Manage shortcuts…
                  </button>
                </div>
              )}
              {scOpen && !scVisible && (
                <div className="sc-pop">
                  <div className="sc-empty">No shortcuts yet.</div>
                  <button className="sc-manage" onClick={() => { setScOpen(false); setScManage(true); }}>
                    Add shortcuts…
                  </button>
                </div>
              )}
              <textarea
                ref={composerRef}
                className="composer-input"
                placeholder={
                  uploading ? 'Uploading…' : joinByTyping ? 'Type to join the chat…' : 'Type a reply… ("/" for shortcuts)'
                }
                value={draft}
                rows={1}
                onChange={(e) => {
                  setDraft(e.target.value);
                  emitTyping(e.target.value.length > 0);
                }}
                onKeyDown={(e) => {
                  if (scVisible) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setScIndex((i) => (i + 1) % scList.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setScIndex((i) => (i - 1 + scList.length) % scList.length);
                      return;
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      applyShortcut(scList[scIndex]);
                      return;
                    }
                    if (e.key === 'Escape') {
                      setScOpen(false);
                      if (slashMode) setDraft('');
                      return;
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button
                className="btn btn-primary btn-send"
                onClick={send}
                disabled={!draft.trim()}
                title="Send"
              >
                <IconSend size={16} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Info sidebar */}
      {showSidebar && conversation && (
        <div className="chat-side">
          <div className="side-section">
            <h4>Visitor</h4>
            <div className="side-visitor">
              <span
                className="avatar avatar-lg"
                style={{ background: conversation.website?.primaryColor || 'var(--accent)' }}
              >
                {initials(visitorName)}
              </span>
              <div>
                <div className="side-visitor-name">
                  {visitorName}
                  <span
                    className={classNames('dot', conversation.visitor?.online ? 'dot-online' : 'dot-offline')}
                  />
                </div>
                <div className="side-visitor-sub">{conversation.visitor?.email || 'No email'}</div>
              </div>
            </div>
            <div className="side-kv">
              <span className="side-k">
                <IconGlobe size={13} /> Website
              </span>
              <span className="side-v">{conversation.website ? siteLabel(conversation.website) : '—'}</span>
            </div>
            {(conversation.visitor?.city || conversation.visitor?.country) && (
              <div className="side-kv">
                <span className="side-k">📍 Location</span>
                <span className="side-v">
                  {[conversation.visitor?.city, conversation.visitor?.country].filter(Boolean).join(', ')}
                </span>
              </div>
            )}
            {conversation.visitor?.ip && (
              <div className="side-kv">
                <span className="side-k">IP address</span>
                <span className="side-v">{conversation.visitor.ip}</span>
              </div>
            )}
            <div className="side-kv">
              <span className="side-k">Started</span>
              <span className="side-v">
                {formatDay(conversation.createdAt)} · {formatTime(conversation.createdAt)}
              </span>
            </div>
            {conversation.assignedUser && (
              <div className="side-kv">
                <span className="side-k">Assigned to</span>
                <span className="side-v">
                  {conversation.assignedUser.name}
                  <span
                    className={classNames(
                      'dot',
                      online[conversation.assignedUser.id] ? 'dot-online' : 'dot-offline',
                    )}
                  />
                </span>
              </div>
            )}
          </div>
          <div className="side-section">
            <h4>Assignment history</h4>
            <HistoryTimeline history={history} />
          </div>
          <div className="side-section side-section-grow">
            <h4>
              <IconEye size={13} /> Visitor path
            </h4>
            {sessionPath.length > 0 ? (
              <ol className="vd-path side-path-list">
                {[...sessionPath].reverse().slice(0, 12).map((p, i) => (
                  <li
                    key={`${p.at}_${i}`}
                    className={classNames('vd-path-item', i === 0 && conversation.visitor?.online && 'current')}
                  >
                    <span className="vd-path-time">{formatWhen(p.at)}</span>
                    <div className="vd-path-page">
                      <span className="vd-path-title">{p.title || pageLabel(p.url)}</span>
                      {p.url && (
                        <a
                          className="vd-path-url"
                          href={p.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={p.url}
                        >
                          {pageLabel(p.url)}
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            ) : currentPage ? (
              <a
                className="side-v-link side-v-trunc"
                href={currentPage}
                target="_blank"
                rel="noopener noreferrer"
                title={currentPage}
              >
                {currentPage}
              </a>
            ) : (
              <p className="side-empty">No pages recorded yet.</p>
            )}
          </div>
        </div>
      )}

      {showTransfer && conversation && (
        <TransferModal conversation={conversation} onClose={() => setShowTransfer(false)} />
      )}

      {scManage && (
        <div className="modal-backdrop" onClick={() => setScManage(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Message shortcuts</h3>
              <button className="icon-btn" onClick={() => setScManage(false)} aria-label="Close">
                <IconX size={16} />
              </button>
            </div>
            <div className="sc-list">
              {shortcuts.length === 0 && <div className="empty-hint">No shortcuts yet — add one below.</div>}
              {shortcuts.map((s) => (
                <div key={s.id} className="sc-row">
                  <div className="sc-row-meta">
                    <span className="sc-title">{s.title}</span>
                    <span className="sc-body">{s.body}</span>
                  </div>
                  <button
                    className="icon-btn icon-btn-danger"
                    title="Delete"
                    onClick={() => {
                      void api.deleteShortcut(s.id).then(() => loadShortcuts(true).then(setShortcuts));
                    }}
                  >
                    <IconX size={14} />
                  </button>
                </div>
              ))}
            </div>
            <label className="field">
              <span>Title</span>
              <input
                value={scTitle}
                maxLength={80}
                placeholder="e.g. Greeting"
                onChange={(e) => setScTitle(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Message</span>
              <textarea
                rows={3}
                value={scBody}
                maxLength={2000}
                placeholder="Are you looking for custom printed boxes?"
                onChange={(e) => setScBody(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setScManage(false)}>
                Close
              </button>
              <button
                className="btn btn-primary"
                disabled={!scTitle.trim() || !scBody.trim()}
                onClick={() => {
                  void api.addShortcut(scTitle.trim(), scBody.trim()).then(() => {
                    setScTitle('');
                    setScBody('');
                    void loadShortcuts(true).then(setShortcuts);
                  });
                }}
              >
                Add shortcut
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
