import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssignmentRecord,
  CallMeta,
  ChatMessage,
  ConversationSummary,
} from '@livechat/shared';
import { EV } from '@livechat/shared';
import { useApp } from '../state';
import { getSocket } from '../socket';
import { uploadFile } from '../api';
import { classNames, formatDay, formatTime, initials, newTempId, siteLabel } from '../util';
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
  } = useApp();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<AssignmentRecord[]>([]);
  const [openError, setOpenError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [visitorTyping, setVisitorTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const typingRef = useRef<{ active: boolean; timer: number | null }>({ active: false, timer: null });
  const readSentRef = useRef<Set<string>>(new Set());

  const conversation = conversations[conversationId];

  const canSend = useMemo(() => {
    if (!me || !conversation) return false;
    if (me.role === 'MANAGER') return false; // view-only role
    if (conversation.status === 'CLOSED' || conversation.status === 'MISSED') return false;
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
        me.role === 'ADMIN'
      );
    }
    // ACTIVE: assignee, ADMIN, or the assignee's Team Lead may reply.
    return conversation.assignedUserId === me.id || me.role === 'ADMIN' || assigneeIsMyCsr;
  }, [me, csrIds, conversation]);

  const joinByTyping = canSend && conversation?.status === 'WAITING';

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
        setOpenError(ack?.error ?? 'Could not open this conversation.');
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

    socket.on(EV.ChatMessage, onMessage);
    socket.on(EV.ChatReceipt, onReceipt);
    socket.on(EV.ChatTyping, onTyping);
    socket.on(EV.CallStatus, onCallStatus);

    return () => {
      disposed = true;
      socket.off(EV.ChatMessage, onMessage);
      socket.off(EV.ChatReceipt, onReceipt);
      socket.off(EV.ChatTyping, onTyping);
      socket.off(EV.CallStatus, onCallStatus);
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
  };

  const accept = () => {
    getSocket()?.emit(EV.AgentAccept, { conversationId });
  };

  const closeConversation = () => {
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

  const visitorName = conversation?.visitor?.name || `Visitor ${conversation?.visitorId.slice(0, 6) ?? ''}`;
  const showAccept =
    !!conversation &&
    conversation.status === 'WAITING' &&
    !!me &&
    me.role !== 'MANAGER' &&
    (conversation.assignedUserId === me.id ||
      conversation.assignedUserId == null ||
      me.role === 'ADMIN' ||
      (me.role === 'LEAD' &&
        conversation.assignedUserId != null &&
        csrIds.includes(conversation.assignedUserId)));

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
                {visitorName}
                {conversation?.visitor?.online && <span className="dot dot-online" title="Online" />}
              </span>
              <span className="chat-head-sub">
                {conversation?.visitor?.email || 'No email provided'}
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
              <button className="btn btn-primary btn-sm" onClick={accept}>
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
            {conversation && conversation.status !== 'CLOSED' && conversation.status !== 'MISSED' && me?.role !== 'MANAGER' && (me?.role !== 'CSR' || canSend) && (
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
            {me?.role === 'MANAGER'
              ? 'Monitoring — view-only. Managers can watch every conversation but never reply.'
              : 'Monitoring — you are watching this conversation live. Only the assigned agent can reply.'}
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
              {me?.role === 'MANAGER'
                ? 'View-only (Manager).'
                : watchingReadOnly
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
              <textarea
                className="composer-input"
                placeholder={
                  uploading ? 'Uploading…' : joinByTyping ? 'Type to join the chat…' : 'Type a reply…'
                }
                value={draft}
                rows={1}
                onChange={(e) => {
                  setDraft(e.target.value);
                  emitTyping(e.target.value.length > 0);
                }}
                onKeyDown={(e) => {
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
            {conversation.visitor?.currentPage && (
              <div className="side-kv">
                <span className="side-k">Current page</span>
                <span className="side-v side-v-trunc" title={conversation.visitor.currentPage}>
                  {conversation.visitor.currentPage}
                </span>
              </div>
            )}
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
        </div>
      )}

      {showTransfer && conversation && (
        <TransferModal conversation={conversation} onClose={() => setShowTransfer(false)} />
      )}
    </div>
  );
}
