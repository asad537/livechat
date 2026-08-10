// ─── Widget application root ─────────────────────────────────
import { io, type Socket } from 'socket.io-client';
import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  API,
  EV,
  MAX_FILE_BYTES,
  WIDGET_NAMESPACE,
  type CallMeta,
  type ChatMessage,
  type ConversationStatus,
  type ConversationSummary,
  type Visitor,
  type WebsiteBranding,
} from '@livechat/shared';
import { CallSession } from './rtc';
import { CallOverlay, IncomingCallCard, type Invite } from './call-ui';
import {
  IconChat,
  IconClip,
  IconClose,
  IconSend,
  RatingCard,
  renderMessages,
  TypingRow,
  type LocalMessage,
} from './messages';
import { initials, lsGet, lsSet, newTempId, onColor, rgba, shade, ssGet, ssSet } from './util';

interface ReadyPayload {
  visitorToken: string;
  visitor: Visitor;
  website: WebsiteBranding;
  conversation?: ConversationSummary | null;
  messages?: ChatMessage[];
  agent?: { name: string; avatarColor: string } | null;
}

interface ConvState {
  id: string;
  status: ConversationStatus;
}

interface ActiveCall {
  session: CallSession;
  meta: CallMeta;
}

const DEFAULT_PRIMARY = '#6366f1';

export function App({ server, widgetKey }: { server: string; widgetKey: string }): JSX.Element | null {
  const tokenKey = `livechat:token:${widgetKey}`;
  const infoDismissKey = `livechat:info-dismissed:${widgetKey}`;

  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [website, setWebsite] = useState<WebsiteBranding | null>(null);
  const [visitor, setVisitor] = useState<Visitor | null>(null);
  const [visitorToken, setVisitorToken] = useState('');
  const [conversation, setConversation] = useState<ConvState | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [agent, setAgent] = useState<{ name: string; avatarColor: string } | null>(null);
  const [agentTyping, setAgentTyping] = useState(false);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [infoDismissed, setInfoDismissed] = useState(() => lsGet(infoDismissKey) === '1');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [rated, setRated] = useState(false);
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [, setCallTick] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  const openRef = useRef(open);
  // Visitor explicitly closed the widget this session → agent messages badge
  // the launcher instead of popping the panel open again.
  const dismissKey = `livechat:minimized:${widgetKey}`;
  const dismissedRef = useRef(ssGet(dismissKey) === '1');
  const markDismissed = (v: boolean) => {
    dismissedRef.current = v;
    ssSet(dismissKey, v ? '1' : '0');
  };
  const callRef = useRef<ActiveCall | null>(null);
  const inviteRef = useRef<Invite | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const convRef = useRef<ConvState | null>(null);
  const reportedReads = useRef(new Set<string>());
  const typingTimer = useRef<number | undefined>(undefined);
  const agentTypingTimer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);

  openRef.current = open;
  callRef.current = call;
  inviteRef.current = invite;
  convRef.current = conversation;

  const bumpCall = useCallback(() => setCallTick((t) => t + 1), []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const endCall = useCallback((emitLeave: boolean) => {
    const active = callRef.current;
    if (!active) return;
    active.session.leave(emitLeave);
    setCall(null);
  }, []);

  // ── Socket lifecycle ───────────────────────────────────────
  useEffect(() => {
    const socket = io(`${server}${WIDGET_NAMESPACE}`, {
      auth: (cb) =>
        cb({
          widgetKey,
          visitorToken: lsGet(tokenKey) || undefined,
          page: window.location.href,
          pageTitle: document.title || undefined,
          referrer: document.referrer || undefined,
        }),
      reconnectionDelayMax: 8000,
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on(EV.WidgetReady, (payload: ReadyPayload) => {
      lsSet(tokenKey, payload.visitorToken);
      setVisitorToken(payload.visitorToken);
      setWebsite(payload.website);
      setVisitor(payload.visitor);
      setAgent(payload.agent ?? null);
      setConversation(
        payload.conversation ? { id: payload.conversation.id, status: payload.conversation.status } : null,
      );
      setMessages((payload.messages ?? []) as LocalMessage[]);
      setConnected(true);
    });

    socket.on(EV.ChatMessage, ({ message }: { message: ChatMessage }) => {
      setMessages((prev) => {
        if (message.tempId) {
          const i = prev.findIndex((m) => m.pending && m.tempId === message.tempId);
          if (i >= 0) {
            const next = prev.slice();
            next[i] = message;
            return next;
          }
        }
        if (prev.some((m) => m.id === message.id)) {
          return prev.map((m) => (m.id === message.id ? { ...m, ...message } : m));
        }
        return [...prev, message];
      });
      setConversation((prev) => prev ?? { id: message.conversationId, status: 'WAITING' });
      if (message.senderType === 'AGENT' && !openRef.current) {
        // Auto-open on an agent message — unless the visitor closed the
        // widget themselves, then just keep counting on the launcher badge.
        if (dismissedRef.current) setUnread((u) => u + 1);
        else setOpen(true);
      }
    });

    socket.on(
      EV.ChatReceipt,
      ({ messageIds, deliveredAt, readAt }: { conversationId: string; messageIds: string[]; deliveredAt?: string; readAt?: string }) => {
        if (!Array.isArray(messageIds) || messageIds.length === 0) return;
        const ids = new Set(messageIds);
        setMessages((prev) =>
          prev.map((m) =>
            ids.has(m.id)
              ? { ...m, deliveredAt: deliveredAt ?? m.deliveredAt, readAt: readAt ?? m.readAt }
              : m,
          ),
        );
      },
    );

    socket.on(EV.ChatTyping, ({ from, typing }: { conversationId: string; from: 'VISITOR' | 'AGENT'; typing: boolean }) => {
      if (from !== 'AGENT') return;
      setAgentTyping(typing);
      if (agentTypingTimer.current) window.clearTimeout(agentTypingTimer.current);
      if (typing) agentTypingTimer.current = window.setTimeout(() => setAgentTyping(false), 5000);
    });

    socket.on(EV.ChatStatus, ({ conversation: conv }: { conversation: ConversationSummary }) => {
      setConversation((prev) => {
        if (prev && prev.id !== conv.id && prev.status !== 'CLOSED' && prev.status !== 'MISSED') return prev;
        return { id: conv.id, status: conv.status };
      });
      if (conv.status === 'CLOSED' || conv.status === 'MISSED') setAgentTyping(false);
    });

    socket.on(EV.ChatAgent, ({ agent: a }: { conversationId: string; agent: { name: string; avatarColor: string } | null }) => {
      setAgent(a ?? null);
    });

    socket.on(EV.CallInvite, ({ call: meta, from }: { call: CallMeta; from?: { name: string } }) => {
      if (callRef.current) return; // already in a call
      setInvite({ call: meta, from: from ?? null });
    });

    socket.on(EV.CallStatus, ({ call: meta }: { call: CallMeta }) => {
      const pendingInvite = inviteRef.current;
      if (pendingInvite && pendingInvite.call.id === meta.id && meta.status !== 'INVITED') {
        setInvite(null);
      }
      const active = callRef.current;
      if (active && active.meta.id === meta.id) {
        if (meta.status === 'ENDED' || meta.status === 'DECLINED') {
          active.session.leave(false);
          setCall(null);
        } else {
          setCall({ session: active.session, meta });
        }
      }
      // Keep CALL message cards in the transcript in sync (Ringing… → Call ended).
      setMessages((prev) =>
        prev.map((m) => (m.callId === meta.id ? { ...m, call: meta } : m)),
      );
    });

    socket.on(EV.AppError, ({ message }: { message: string }) => {
      if (message) showToast(message);
    });

    return () => {
      callRef.current?.session.leave(false);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, widgetKey]);

  // ── Read receipts + unread reset when panel is open ────────
  useEffect(() => {
    if (!open) return;
    setUnread(0);
    const ids = messages
      .filter((m) => m.senderType === 'AGENT' && !m.pending && !m.readAt && !reportedReads.current.has(m.id))
      .map((m) => m.id);
    if (ids.length > 0) {
      for (const id of ids) reportedReads.current.add(id);
      socketRef.current?.emit(EV.WidgetRead, { messageIds: ids });
    }
  }, [open, messages]);

  // ── Auto-scroll message list ───────────────────────────────
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, agentTyping, open, conversation?.status]);

  // ── Composer ───────────────────────────────────────────────
  const emitTyping = useCallback((typing: boolean) => {
    socketRef.current?.emit(EV.WidgetTyping, { typing });
  }, []);

  const onDraftInput = (e: Event) => {
    const el = e.currentTarget as HTMLTextAreaElement;
    setDraft(el.value);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
    emitTyping(true);
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => emitTyping(false), 1400);
  };

  const send = useCallback(() => {
    const body = draft.trim();
    const socket = socketRef.current;
    if (!body || !socket) return;
    const tempId = newTempId();
    socket.emit(EV.WidgetMessage, { body, tempId });
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        tempId,
        conversationId: convRef.current?.id ?? '',
        senderType: 'VISITOR',
        senderUserId: null,
        body,
        kind: 'TEXT',
        fileId: null,
        callId: null,
        createdAt: new Date().toISOString(),
        deliveredAt: null,
        readAt: null,
        pending: true,
      },
    ]);
    setDraft('');
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    emitTyping(false);
    const ta = taRef.current;
    if (ta) {
      ta.value = '';
      ta.style.height = 'auto';
      ta.focus();
    }
  }, [draft, emitTyping]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // ── File upload ────────────────────────────────────────────
  const onPickFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const conv = convRef.current;
    if (!file || !conv) return;
    if (file.size > MAX_FILE_BYTES) {
      showToast(`File is too large (max ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB)`);
      return;
    }
    const token = lsGet(tokenKey) ?? visitorToken;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('conversationId', conv.id);
      fd.append('token', token);
      const url = `${server}${API.uploads}?conversationId=${encodeURIComponent(conv.id)}&token=${encodeURIComponent(token)}`;
      const res = await fetch(url, { method: 'POST', body: fd });
      if (!res.ok) {
        let msg = 'Upload failed';
        try {
          const json = (await res.json()) as { error?: string };
          if (json && typeof json.error === 'string') msg = json.error;
        } catch {
          /* non-JSON error body */
        }
        showToast(msg);
      }
    } catch {
      showToast('Upload failed — check your connection');
    } finally {
      setUploading(false);
    }
  };

  // ── Info mini-form ─────────────────────────────────────────
  const submitInfo = (name: string, email: string) => {
    const payload: { name?: string; email?: string } = {};
    if (name.trim()) payload.name = name.trim();
    if (email.trim()) payload.email = email.trim();
    if (payload.name || payload.email) {
      socketRef.current?.emit(EV.WidgetInfo, payload);
      setVisitor((v) => (v ? { ...v, name: payload.name ?? v.name, email: payload.email ?? v.email } : v));
    }
    lsSet(infoDismissKey, '1');
    setInfoDismissed(true);
  };

  const dismissInfo = () => {
    lsSet(infoDismissKey, '1');
    setInfoDismissed(true);
  };

  // ── Start new conversation after close ─────────────────────
  const startNewConversation = () => {
    setConversation(null);
    setMessages([]);
    setAgent(null);
    setAgentTyping(false);
    setRated(false);
    reportedReads.current.clear();
    const socket = socketRef.current;
    if (socket) {
      socket.disconnect();
      socket.connect();
    }
    taRef.current?.focus();
  };

  // ── CSAT rating after close ────────────────────────────────
  const submitRating = (rating: number, comment: string) => {
    socketRef.current?.emit(EV.WidgetRate, { rating, comment: comment || undefined });
    setRated(true);
  };

  // ── Calls ──────────────────────────────────────────────────
  const acceptCall = async (inv: Invite) => {
    const socket = socketRef.current;
    if (!socket) return;
    const session = new CallSession(socket, inv.call.id, inv.call.kind, bumpCall);
    try {
      await session.init();
    } catch {
      socket.emit(EV.WidgetCallDecline, { callId: inv.call.id });
      setInvite(null);
      showToast(
        inv.call.kind === 'VIDEO'
          ? 'Camera/microphone access is required for video calls'
          : 'Microphone access is required for audio calls',
      );
      return;
    }
    socket.emit(EV.WidgetCallAccept, { callId: inv.call.id });
    session.join();
    setCall({ session, meta: { ...inv.call, status: 'ACTIVE' } });
    setInvite(null);
  };

  const declineCall = (inv: Invite) => {
    socketRef.current?.emit(EV.WidgetCallDecline, { callId: inv.call.id });
    setInvite(null);
  };

  // ── Derived UI state ───────────────────────────────────────
  const primary = website?.primaryColor || DEFAULT_PRIMARY;
  const cssVars = useMemo(
    () =>
      `--lc-primary:${primary};` +
      `--lc-primary-dark:${shade(primary, -0.22)};` +
      `--lc-on-primary:${onColor(primary)};` +
      `--lc-soft:${rgba(primary, 0.1)};` +
      `--lc-glow:${rgba(primary, 0.38)}`,
    [primary],
  );

  if (!website) return null; // nothing renders until the socket handshake succeeds

  const status = conversation?.status ?? null;
  const ended = status === 'CLOSED' || status === 'MISSED';
  const showInfoForm =
    !infoDismissed && !!visitor && !visitor.name && !visitor.email && !ended;
  const selfLabel = visitor?.name || 'You';

  return (
    <div class="lc-root" style={cssVars}>
      {open && (
        <div class="lc-panel">
          {/* Header */}
          <div class="lc-header">
            <div class="lc-logo">
              {website.logoUrl ? <img src={website.logoUrl} alt="" /> : <IconChat size={20} />}
            </div>
            <div class="lc-head-info">
              <div class="lc-title">{website.name}</div>
              {agent ? (
                <div class="lc-agent-chip">
                  <span class="lc-avatar-dot" style={`background:${agent.avatarColor}`}>
                    {initials(agent.name)}
                  </span>
                  <span class="lc-agent-name">{agent.name}</span>
                  <span class="lc-online-dot" />
                </div>
              ) : (
                <div class="lc-subtitle">We're here to help</div>
              )}
            </div>
            {conversation && status !== 'CLOSED' && status !== 'MISSED' && (
              <button
                type="button"
                class="lc-iconbtn lc-endbtn"
                title="End chat"
                onClick={() => {
                  if (window.confirm('End this conversation?')) {
                    socketRef.current?.emit(EV.WidgetEndChat, {});
                  }
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                  <path d="M18.36 6.64a9 9 0 1 1-12.72 0" />
                  <line x1="12" y1="2" x2="12" y2="11" />
                </svg>
              </button>
            )}
            <button
              type="button"
              class="lc-iconbtn"
              title="Minimize"
              onClick={() => {
                markDismissed(true);
                setOpen(false);
              }}
            >
              <IconClose />
            </button>
          </div>

          {/* Status strips */}
          {!connected ? (
            <div class="lc-strip lc-strip-warn">
              <span class="lc-spin" /> Reconnecting…
            </div>
          ) : status === 'WAITING' ? (
            <div class="lc-strip lc-strip-queue">
              <span class="lc-radar"><span /><span /><span /></span>
              <span>
                Finding an agent
                <span class="lc-dots"><i>.</i><i>.</i><i>.</i></span>
              </span>
            </div>
          ) : null}

          {/* Messages */}
          <div class="lc-body" ref={bodyRef}>
            {messages.length === 0 && website.greeting && <div class="lc-greet">{website.greeting}</div>}
            {renderMessages(messages, { server, token: visitorToken, fallbackAgent: agent })}
            {agentTyping && !ended && <TypingRow agent={agent} />}
            {showInfoForm && <InfoForm onSubmit={submitInfo} onDismiss={dismissInfo} />}
          </div>

          {/* Composer / closed bar */}
          {ended ? (
            <div class="lc-closedbar">
              {status === 'CLOSED' && !rated ? (
                <RatingCard onSubmit={submitRating} />
              ) : (
                <span>
                  {status === 'MISSED'
                    ? 'We missed you — this conversation has ended.'
                    : rated
                      ? 'Thank you for your feedback! 💚'
                      : 'This conversation has ended.'}
                </span>
              )}
              <button type="button" class="lc-btn" onClick={startNewConversation}>
                Start new conversation
              </button>
            </div>
          ) : (
            <div class="lc-composer">
              <button
                type="button"
                class="lc-attach"
                title={conversation ? 'Attach a file' : 'Send a message first to attach files'}
                disabled={!conversation || uploading || !connected}
                onClick={() => {
                  const picker = document.createElement('input');
                  picker.type = 'file';
                  picker.onchange = (ev) => void onPickFile(ev);
                  picker.click();
                }}
              >
                {uploading ? <span class="lc-spin" /> : <IconClip />}
              </button>
              <textarea
                ref={taRef}
                class="lc-ta"
                rows={1}
                placeholder="Type your message…"
                value={draft}
                onInput={onDraftInput}
                onKeyDown={onKeyDown}
                disabled={!connected}
              />
              <button
                type="button"
                class="lc-send"
                title="Send"
                disabled={!draft.trim() || !connected}
                onClick={send}
              >
                <IconSend />
              </button>
            </div>
          )}

          {toast && <div class="lc-toast">{toast}</div>}
        </div>
      )}

      {/* Incoming call card — floats above everything, shown even when panel is closed */}
      {invite && !call && (
        <IncomingCallCard invite={invite} onAccept={() => void acceptCall(invite)} onDecline={() => declineCall(invite)} />
      )}

      {/* In-call overlay — independent of the panel so the call survives panel close */}
      {call && (
        <CallOverlay
          session={call.session}
          meta={call.meta}
          selfLabel={selfLabel}
          brandColor={primary}
          onHangup={() => endCall(true)}
        />
      )}

      {/* Launcher */}
      <button
        type="button"
        class={`lc-launcher ${unread > 0 ? 'lc-pulse' : ''}`}
        title={open ? 'Close chat' : `Chat with ${website.name}`}
        onClick={() => {
          const next = !openRef.current;
          markDismissed(!next);
          setOpen(next);
        }}
      >
        {open ? <IconClose /> : <IconChat />}
        {!open && unread > 0 && <span class="lc-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
    </div>
  );
}

// ─── Pre-chat name/email mini-form ───────────────────────────

function InfoForm({
  onSubmit,
  onDismiss,
}: {
  onSubmit: (name: string, email: string) => void;
  onDismiss: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const submit = (e: Event) => {
    e.preventDefault();
    onSubmit(name, email);
  };
  return (
    <form class="lc-form" onSubmit={submit}>
      <div class="lc-form-title">Introduce yourself</div>
      <div class="lc-form-sub">So we can follow up if you step away.</div>
      <input
        class="lc-input"
        type="text"
        placeholder="Your name"
        value={name}
        onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
      />
      <input
        class="lc-input"
        type="email"
        placeholder="Email address"
        value={email}
        onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)}
      />
      <div class="lc-form-row">
        <button type="submit" class="lc-btn" disabled={!name.trim() && !email.trim()}>
          Save
        </button>
        <button type="button" class="lc-btn lc-btn-ghost" onClick={onDismiss}>
          No thanks
        </button>
      </div>
    </form>
  );
}
