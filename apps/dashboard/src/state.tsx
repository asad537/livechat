import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  AgentDirectMessage,
  AgentDirectThread,
  CallKind,
  CallMeta,
  ChatMessage,
  ConversationSummary,
  Team,
  UserPublic,
  Visitor,
  Website,
} from '@livechat/shared';
import { EV } from '@livechat/shared';
import { desktopNotify, ensureNotifyPermission, playChime, playVisitorSound } from './notify';
import { api, clearToken, getToken, setToken } from './api';
import { connectSocket, disconnectSocket, getSocket } from './socket';

// ─── Toasts ──────────────────────────────────────────────────
export interface Toast {
  id: number;
  title: string;
  body?: string;
  kind: 'info' | 'success' | 'error';
}

export interface IncomingCall {
  call: CallMeta;
  from: string;
}

interface AppContextValue {
  authed: boolean;
  booting: boolean;
  me: UserPublic | null;
  csrIds: string[]; // when I'm a Team Lead: ids of my CSRs
  websites: Website[];
  teams: Team[];
  conversations: Record<string, ConversationSummary>;
  visitorsByWebsite: Record<string, Visitor[]>;
  online: Record<string, boolean>;
  awayMap: Record<string, boolean>;
  setAway(away: boolean): void;
  connected: boolean;
  toasts: Toast[];
  incomingCall: IncomingCall | null;
  activeCall: CallMeta | null;
  openChats: string[];
  openChatTab(id: string): void;
  closeChatTab(id: string): void;
  dockedChatId: string | null;
  openDockedChat(id: string): void;
  closeDockedChat(): void;
  /** Dock tabs pulsing for attention (e.g. a just-transferred chat). */
  blinkChatIds: string[];
  stopBlink(id: string): void;
  setMeUser(user: UserPublic): void;
  login(email: string, password: string, remember?: boolean): Promise<void>;
  logout(): void;
  pushToast(title: string, body?: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
  refreshConversations(): Promise<void>;
  refreshDirectory(): Promise<void>;
  updateConversation(c: ConversationSummary): void;
  markConversationRead(id: string): void;
  startCall(conversationId: string, kind: CallKind): void;
  acceptIncomingCall(): void;
  declineIncomingCall(): void;
  clearActiveCall(): void;

  // ─── Internal team chat (agent ↔ agent DMs) ──
  dmThreads: AgentDirectThread[];
  dmMessages: Record<string, AgentDirectMessage[]>; // peerUserId → messages
  dmUnreadTotal: number;
  dmOpenPeerId: string | null;
  openDMDrawer(peerId: string): void;
  closeDMDrawer(): void;
  sendDM(peerId: string, body: string): Promise<void>;
  markDMRead(peerId: string): void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}

let toastCounter = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [me, setMe] = useState<UserPublic | null>(null);
  const [csrIds, setCsrIds] = useState<string[]>([]);
  const [websites, setWebsites] = useState<Website[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [conversations, setConversations] = useState<Record<string, ConversationSummary>>({});
  const [visitorsByWebsite, setVisitorsByWebsite] = useState<Record<string, Visitor[]>>({});
  const [online, setOnline] = useState<Record<string, boolean>>({});
  const [awayMap, setAwayMap] = useState<Record<string, boolean>>({});
  const setAway = useCallback((away: boolean) => {
    getSocket()?.emit(EV.AgentSetAway, { away });
    setMe((m) => (m ? { ...m, away } : m));
  }, []);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [activeCall, setActiveCall] = useState<CallMeta | null>(null);
  // Internal team chat — DM threads (one per peer) + open drawer target.
  const [dmThreads, setDmThreads] = useState<AgentDirectThread[]>([]);
  const [dmMessages, setDmMessages] = useState<Record<string, AgentDirectMessage[]>>({});
  const [dmOpenPeerId, setDmOpenPeerId] = useState<string | null>(null);
  const dmOpenPeerIdRef = useRef<string | null>(null);
  useEffect(() => {
    dmOpenPeerIdRef.current = dmOpenPeerId;
  }, [dmOpenPeerId]);
  const refreshDMThreadsMeta = useCallback(async () => {
    try {
      const threads = await api.agentDMThreads();
      setDmThreads(threads);
    } catch {
      /* transient */
    }
  }, []);
  // Forward-ref to clearSessionState so the socket useEffect's auth-failure
  // path (declared before clearSessionState) can invoke it without a circular
  // dep. The ref is populated by an effect further down.
  const clearSessionStateRef = useRef<() => void>(() => {});

  const meRef = useRef<UserPublic | null>(null);
  // Known online-visitor ids per website — to knock only for genuinely new ones.
  const seenVisitorsRef = useRef<Record<string, Set<string>>>({});
  // Conversation ids we already toasted for arrival — synchronous dedupe so
  // two rapid-fire InboxUpdate events (message + status) can't fire twice
  // before React re-renders and refreshes `conversationsRef.current`.
  const notifiedArrivalRef = useRef<Set<string>>(new Set());
  // Same dedupe pattern for the 'Visitor is back' chime — the server can emit
  // two InboxUpdates for the same system message in a burst, and `prev` in
  // the handler is only refreshed on React render.
  const notifiedReturnRef = useRef<Set<string>>(new Set());
  meRef.current = me;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const websitesRef = useRef(websites);
  websitesRef.current = websites;
  const activeCallRef = useRef<CallMeta | null>(null);
  activeCallRef.current = activeCall;
  /** Conversation id we just started a call in — used to pick up the CALL message. */
  const pendingCallConvRef = useRef<string | null>(null);

  const pushToast = useCallback((title: string, body?: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { id, title, body, kind }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const updateConversation = useCallback((c: ConversationSummary) => {
    setConversations((prev) => ({ ...prev, [c.id]: { ...prev[c.id], ...c } }));
  }, []);

  const markConversationRead = useCallback((id: string) => {
    setConversations((prev) => {
      const existing = prev[id];
      if (!existing || !existing.unreadCount) return prev;
      return { ...prev, [id]: { ...existing, unreadCount: 0 } };
    });
  }, []);

  const refreshConversations = useCallback(async () => {
    const user = meRef.current;
    if (!user) return;
    const scope =
      user.role === 'ADMIN' || user.role === 'MANAGER'
        ? 'all'
        : user.role === 'LEAD'
          ? 'team'
          : 'mine';
    try {
      const list = await api.conversations({ scope });
      setConversations((prev) => {
        const next = { ...prev };
        for (const c of list) next[c.id] = { ...next[c.id], ...c };
        return next;
      });
    } catch {
      /* transient — inbox stays live via socket updates */
    }
  }, []);

  const refreshDirectory = useCallback(async () => {
    try {
      const data = await api.me();
      setMe(data.user);
      setWebsites(data.websites);
      setTeams(data.teams);
      setCsrIds(data.csrIds ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  // ── Bottom chat dock (Zendesk-style open-chat tabs) ──
  const [openChats, setOpenChats] = useState<string[]>([]);
  // Dock tabs that should pulse for attention (e.g. a chat just transferred to
  // me) until I actually look at them.
  const [blinkChatIds, setBlinkChatIds] = useState<string[]>([]);
  const stopBlink = useCallback((id: string) => {
    setBlinkChatIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev));
  }, []);
  const openChatTab = useCallback((id: string) => {
    setOpenChats((prev) => (prev.includes(id) ? prev : [...prev.slice(-7), id]));
  }, []);
  // Floating docked chat window (opened from the dock or the visitor drawer).
  const [dockedChatId, setDockedChatId] = useState<string | null>(null);
  const openDockedChat = useCallback(
    (id: string) => {
      openChatTab(id);
      setDockedChatId(id);
      stopBlink(id); // opening it clears the attention pulse
    },
    [openChatTab, stopBlink],
  );
  const closeDockedChat = useCallback(() => setDockedChatId(null), []);

  const closeChatTab = useCallback(
    (id: string) => {
      setOpenChats((prev) => prev.filter((c) => c !== id));
      setDockedChatId((prev) => (prev === id ? null : prev));
      stopBlink(id);
    },
    [stopBlink],
  );

  // ─── Socket lifecycle ──────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    // Validate the token via REST first so a stale token bounces to /login.
    api
      .me()
      .then((data) => {
        if (cancelled) return;
        setMe(data.user);
        setWebsites(data.websites);
        setTeams(data.teams);
        setCsrIds(data.csrIds ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        clearToken();
        setTokenState(null);
      });

    const socket = connectSocket(token);

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    let authFailures = 0;
    const onConnectError = (err: Error) => {
      setConnected(false);
      // A repeatedly-rejected handshake usually means the 12h token expired
      // during a long sleep. Verify via REST; a 401 bounces to login instead
      // of spinning on "Reconnecting…" forever.
      const looksAuth = /unauthor|forbidden|token|auth/i.test(err?.message ?? '');
      if (looksAuth && ++authFailures >= 2) {
        authFailures = 0;
        void api.me().catch((e: unknown) => {
          const status = (e as { status?: number })?.status;
          if (status === 401 || status === 403) {
            // Full session reset — a different agent logging in on the same
            // tab must not inherit our conversations/dock/DM cache.
            clearSessionStateRef.current();
          }
        });
      }
    };

    const onReady = (payload: {
      me: UserPublic;
      websites: Website[];
      teams: Team[];
      csrIds?: string[];
    }) => {
      setMe(payload.me);
      setWebsites(payload.websites);
      setTeams(payload.teams);
      setCsrIds(payload.csrIds ?? []);
      // Seed presence from the roster's online + away flags.
      setOnline(() => {
        const next: Record<string, boolean> = { [payload.me.id]: true };
        for (const team of payload.teams) {
          for (const member of team.members ?? []) {
            if (member.online !== undefined) next[member.id] = !!member.online;
          }
        }
        return next;
      });
      setAwayMap((prev) => {
        const next = { ...prev, [payload.me.id]: !!payload.me.away };
        for (const team of payload.teams) {
          for (const member of team.members ?? []) {
            if (member.away !== undefined) next[member.id] = !!member.away;
          }
        }
        return next;
      });
      // Watch every accessible website → live visitor lists + inbox updates.
      for (const site of payload.websites) {
        socket.emit(EV.AgentWatchWebsite, { websiteId: site.id });
      }
      ensureNotifyPermission();
      void refreshConversations();
    };

    const onInboxUpdate = (payload: { conversation: ConversationSummary }) => {
      const conv = payload.conversation;
      if (!conv?.id) return;
      const user = meRef.current;
      const prev = conversationsRef.current[conv.id];
      // Synchronous dedupe key — set before firing any arrival popup so a
      // burst of two InboxUpdates (message + status) can't double-notify.
      const arrivalKey = `${conv.id}:${conv.assignedUserId ?? 'queue'}`;
      const alreadyNotified = notifiedArrivalRef.current.has(arrivalKey);
      if (
        user &&
        !alreadyNotified &&
        conv.assignedUserId === user.id &&
        (!prev || prev.assignedUserId !== user.id) &&
        (conv.status === 'WAITING' || conv.status === 'ACTIVE' || conv.status === 'OFFERED')
      ) {
        notifiedArrivalRef.current.add(arrivalKey);
        const who = conv.visitor?.name || 'A visitor';
        const where = conv.website?.label?.trim() || conv.website?.name || 'your site';
        // A hand-off to an already-running chat is a transfer, not a fresh chat.
        const transferred = conv.status !== 'WAITING' || !!prev;
        const title = transferred ? 'Chat transferred to you' : 'New chat assigned';
        pushToast(title, `${who} on ${where}.`, 'info');
        playChime('new-chat');
        desktopNotify(title, `${who} on ${where}.`, `chat-${conv.id}`);
        // Transferred chat → dock the tile and make it blink so the receiving
        // agent notices the hand-off even if they're on another page.
        if (transferred) {
          setOpenChats((cur) => (cur.includes(conv.id) ? cur : [...cur.slice(-7), conv.id]));
          setBlinkChatIds((cur) => (cur.includes(conv.id) ? cur : [...cur, conv.id]));
        }
      } else if (
        // Unclaimed queue chat — a visitor started a chat but nobody is
        // handling it yet. Ring EVERY agent watching this site (CSR, Lead,
        // Manager, Admin) so the offline queue isn't missed. Fires once, on
        // the first inbox update for this conversation (i.e. when it first
        // appears — either genuinely new, or newly returned to WAITING).
        user &&
        !alreadyNotified &&
        !conv.assignedUserId &&
        conv.status === 'WAITING' &&
        (!prev || prev.assignedUserId || prev.status !== 'WAITING')
      ) {
        notifiedArrivalRef.current.add(arrivalKey);
        const who = conv.visitor?.name || 'A visitor';
        const where = conv.website?.label?.trim() || conv.website?.name || 'your site';
        pushToast('New chat in queue', `${who} on ${where}.`, 'info');
        playChime('new-chat');
        desktopNotify('New chat in queue', `${who} on ${where}.`, `chat-${conv.id}`);
      } else if (
        user &&
        conv.assignedUserId === user.id &&
        conv.lastMessage?.senderType === 'VISITOR' &&
        prev?.lastMessage?.id !== conv.lastMessage.id &&
        !document.hasFocus()
      ) {
        // Visitor replied while the agent is looking elsewhere.
        playChime('message');
        desktopNotify(
          conv.visitor?.name || 'Visitor',
          conv.lastMessage.body || 'New message',
          `chat-${conv.id}`,
        );
      }
      // The visitor left the site → only MINIMIZE the floating window; keep
      // the chat head in the bottom dock so the agent can still add notes,
      // capture details, and see the tab wake up the moment the visitor
      // returns. (Dropping the tab was the "chat head disappeared" complaint.)
      if (conv.lastMessage?.kind === 'SYSTEM' && conv.lastMessage.body === 'Visitor left the site') {
        setDockedChatId((prevId) => (prevId === conv.id ? null : prevId));
      }
      // The visitor came back → restore the tab (if it slipped) and ping the
      // agent so they know to resume. Only for the agent actually handling
      // this chat — never for someone just watching the website (or the tab
      // would be a dead "Forbidden" tile for another CSR's conversation).
      if (
        conv.lastMessage?.kind === 'SYSTEM' &&
        conv.lastMessage.body === 'Visitor is back on the site' &&
        !!user &&
        conv.assignedUserId === user.id &&
        prev?.lastMessage?.id !== conv.lastMessage.id &&
        !notifiedReturnRef.current.has(conv.lastMessage.id)
      ) {
        notifiedReturnRef.current.add(conv.lastMessage.id);
        setOpenChats((cur) => (cur.includes(conv.id) ? cur : [...cur.slice(-7), conv.id]));
        const who = conv.visitor?.name || 'Visitor';
        pushToast('Visitor is back', `${who} returned to the site.`, 'info');
        playChime('message');
        desktopNotify('Visitor is back', `${who} returned to the site.`, `chat-${conv.id}`);
      }
      setConversations((current) => ({ ...current, [conv.id]: { ...current[conv.id], ...conv } }));
    };

    const onChatStatus = (payload: { conversation: ConversationSummary }) => {
      if (payload.conversation?.id) {
        setConversations((current) => ({
          ...current,
          [payload.conversation.id]: { ...current[payload.conversation.id], ...payload.conversation },
        }));
      }
    };

    const onVisitorsUpdate = (payload: { websiteId: string; visitors: Visitor[] }) => {
      const list = payload.visitors ?? [];
      // Knock (door sound) when a brand-new online visitor lands on a site.
      const onlineIds = list.filter((v) => v.online).map((v) => v.id);
      const prevSeen = seenVisitorsRef.current[payload.websiteId];
      if (prevSeen) {
        // Not the first snapshot for this site → any id we haven't seen is new.
        const hasNew = onlineIds.some((id) => !prevSeen.has(id));
        if (hasNew) playVisitorSound();
      }
      seenVisitorsRef.current[payload.websiteId] = new Set(onlineIds);
      setVisitorsByWebsite((prev) => ({ ...prev, [payload.websiteId]: list }));
    };

    const onPresence = (payload: { userId: string; online: boolean; away?: boolean }) => {
      setOnline((prev) => ({ ...prev, [payload.userId]: payload.online }));
      setAwayMap((prev) => ({ ...prev, [payload.userId]: !!payload.away }));
    };

    const onChatMessage = (payload: { message: ChatMessage }) => {
      const msg = payload.message;
      const user = meRef.current;
      if (!msg || !user) return;
      // Pick up the CALL message for a call this agent just started → open the overlay.
      if (
        msg.kind === 'CALL' &&
        msg.call &&
        pendingCallConvRef.current === msg.conversationId &&
        msg.call.startedBy === `AGENT:${user.id}` &&
        (msg.call.status === 'INVITED' || msg.call.status === 'ACTIVE')
      ) {
        pendingCallConvRef.current = null;
        setActiveCall(msg.call);
      }
    };

    const onCallInvite = (payload: { call: CallMeta; from: { name: string } }) => {
      if (!payload?.call) return;
      if (activeCallRef.current && activeCallRef.current.id === payload.call.id) return;
      setIncomingCall({ call: payload.call, from: payload.from?.name ?? 'Unknown' });
    };

    const onCallStatus = (payload: { call: CallMeta }) => {
      const call = payload?.call;
      if (!call) return;
      setActiveCall((prev) => {
        if (!prev || prev.id !== call.id) return prev;
        if (call.status === 'ENDED') return null;
        if (call.status === 'DECLINED') {
          pushToast('Call declined', 'The other side declined the call.', 'info');
          return null;
        }
        return { ...prev, ...call };
      });
      setIncomingCall((prev) =>
        prev && prev.call.id === call.id && (call.status === 'ENDED' || call.status === 'DECLINED')
          ? null
          : prev,
      );
    };

    const onAppError = (payload: { message: string }) => {
      pushToast('Something went wrong', payload?.message ?? 'Unknown error', 'error');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on(EV.AgentReady, onReady);
    const onAgentAlert = (p: { message?: string }) => {
      if (p?.message) {
        pushToast('Heads up', p.message, 'info');
        playChime('new-chat');
      }
    };
    socket.on(EV.AgentAlert, onAgentAlert);
    socket.on(EV.InboxUpdate, onInboxUpdate);
    socket.on(EV.ChatStatus, onChatStatus);
    socket.on(EV.VisitorsUpdate, onVisitorsUpdate);
    socket.on(EV.PresenceUpdate, onPresence);
    socket.on(EV.ChatMessage, onChatMessage);
    socket.on(EV.CallInvite, onCallInvite);
    socket.on(EV.CallStatus, onCallStatus);
    socket.on(EV.AppError, onAppError);

    // ─── Internal team chat (agent ↔ agent DMs) ──
    const onAgentDM = (payload: { message: AgentDirectMessage }) => {
      const msg = payload?.message;
      const user = meRef.current;
      if (!msg || !user) return;
      const peerId = msg.fromUserId === user.id ? msg.toUserId : msg.fromUserId;
      const incoming = msg.toUserId === user.id;
      setDmMessages((prev) => {
        const list = prev[peerId] ?? [];
        // Dedupe by id (server echoes back the sender's own message too).
        if (list.some((m) => m.id === msg.id)) return prev;
        // If the sender optimistically added a temp-id row, swap it out.
        const filtered = msg.tempId
          ? list.filter((m) => m.id !== msg.tempId)
          : list;
        return { ...prev, [peerId]: [...filtered, msg] };
      });
      // Bump the thread list — the peer moves to the top and unread grows if
      // it's an incoming message not currently open in the drawer.
      setDmThreads((prev) => {
        const drawerOpen = dmOpenPeerIdRef.current === peerId && document.hasFocus();
        const shouldMarkUnread = incoming && !drawerOpen;
        const existing = prev.find((t) => t.peerUserId === peerId);
        const bumped: AgentDirectThread = existing
          ? {
              ...existing,
              lastMessage: msg,
              unread: shouldMarkUnread ? existing.unread + 1 : existing.unread,
            }
          : {
              peerUserId: peerId,
              // We may not know the name yet — filled in by the next thread refresh.
              peerName: 'Agent',
              peerAvatarColor: null,
              lastMessage: msg,
              unread: shouldMarkUnread ? 1 : 0,
            };
        const rest = prev.filter((t) => t.peerUserId !== peerId);
        return [bumped, ...rest];
      });
      if (incoming) {
        const drawerOpen = dmOpenPeerIdRef.current === peerId && document.hasFocus();
        if (drawerOpen) {
          // Auto-mark as read since we're actively looking at this thread.
          getSocket()?.emit(EV.AgentDMRead, { fromUserId: peerId });
        } else {
          playChime('message');
          if (!document.hasFocus()) {
            void refreshDMThreadsMeta();
          }
        }
      }
    };
    const onAgentDMReadReceipt = (payload: {
      fromUserId: string;
      toUserId: string;
      readAt: string;
    }) => {
      const user = meRef.current;
      if (!user || !payload) return;
      // Either "peer read my DMs to them" or "I read peer's DMs" — both zero unread on that side.
      const peerId = payload.toUserId === user.id ? payload.fromUserId : payload.toUserId;
      setDmMessages((prev) => {
        const list = prev[peerId];
        if (!list) return prev;
        let changed = false;
        const next = list.map((m) => {
          if (m.readAt == null && (m.fromUserId === user.id ? m.toUserId === peerId : true)) {
            changed = true;
            return { ...m, readAt: payload.readAt };
          }
          return m;
        });
        return changed ? { ...prev, [peerId]: next } : prev;
      });
      // Zero the peer's unread badge if we are the reader.
      if (payload.toUserId === user.id) {
        setDmThreads((prev) =>
          prev.map((t) => (t.peerUserId === peerId ? { ...t, unread: 0 } : t)),
        );
      }
    };
    socket.on(EV.AgentDM, onAgentDM);
    socket.on(EV.AgentDMReadReceipt, onAgentDMReadReceipt);

    return () => {
      cancelled = true;
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off(EV.AgentReady, onReady);
      socket.off(EV.AgentAlert, onAgentAlert);
      socket.off(EV.InboxUpdate, onInboxUpdate);
      socket.off(EV.ChatStatus, onChatStatus);
      socket.off(EV.VisitorsUpdate, onVisitorsUpdate);
      socket.off(EV.PresenceUpdate, onPresence);
      socket.off(EV.ChatMessage, onChatMessage);
      socket.off(EV.CallInvite, onCallInvite);
      socket.off(EV.CallStatus, onCallStatus);
      socket.off(EV.AppError, onAppError);
      socket.off(EV.AgentDM, onAgentDM);
      socket.off(EV.AgentDMReadReceipt, onAgentDMReadReceipt);
    };
  }, [token, pushToast, refreshConversations]);

  // ─── Focus re-sync ─────────────────────────────────────────
  // If a live update was missed (network blip, server restart, tab asleep),
  // coming back to the dashboard pulls a fresh visitor list + inbox — no
  // manual reload needed. AgentWatchWebsite replies with a full snapshot.
  useEffect(() => {
    if (!token) return;
    const resync = () => {
      if (document.visibilityState !== 'visible') return;
      const socket = getSocket();
      // After sleep/lock the socket often thinks it's "connecting" but the
      // transport is dead and its backoff is stuck — force an immediate
      // reconnect so we don't hang on "Reconnecting…".
      if (socket && !socket.connected) {
        try {
          socket.connect();
        } catch {
          /* ignore */
        }
        return; // onConnect (below) will re-sync once it's back
      }
      if (!socket?.connected) return;
      for (const site of websitesRef.current) {
        socket.emit(EV.AgentWatchWebsite, { websiteId: site.id });
      }
      void refreshConversations();
    };
    document.addEventListener('visibilitychange', resync);
    window.addEventListener('focus', resync);
    window.addEventListener('online', resync); // network came back
    // Wall-screen dashboards stay focused for hours — also re-sync on a
    // timer so a single missed broadcast (or a wedged socket) can't stick.
    const interval = window.setInterval(resync, 30_000);
    return () => {
      document.removeEventListener('visibilitychange', resync);
      window.removeEventListener('focus', resync);
      window.removeEventListener('online', resync);
      window.clearInterval(interval);
    };
  }, [token, refreshConversations]);

  // ─── Tab title unread counter ──────────────────────────────
  const unreadTotal = useMemo(() => {
    let total = 0;
    for (const c of Object.values(conversations)) {
      if (c.status === 'CLOSED' || c.status === 'MISSED') continue;
      total += c.unreadCount ?? 0;
    }
    return total;
  }, [conversations]);

  useEffect(() => {
    document.title = unreadTotal > 0 ? `(${unreadTotal}) TCB Connect` : 'TCB Connect — Agent Dashboard';
  }, [unreadTotal]);

  // ─── Auth actions ──────────────────────────────────────────
  const login = useCallback(async (email: string, password: string, remember = true) => {
    const res = await api.login(email, password);
    setToken(res.token, remember);
    setMe(res.user);
    setTokenState(res.token);
  }, []);

  /** Reset every piece of per-session state without touching the socket
   * connection. Shared between logout() (user action) and the auth-failure
   * eviction path (2 consecutive 401/403 handshakes) so a different user
   * signing in on the same tab never sees the previous agent's cached data. */
  const clearSessionState = useCallback(() => {
    clearToken();
    setTokenState(null);
    setMe(null);
    setWebsites([]);
    setTeams([]);
    setConversations({});
    setVisitorsByWebsite({});
    setOnline({});
    setAwayMap({});
    setConnected(false);
    setIncomingCall(null);
    setActiveCall(null);
    setOpenChats([]);
    setBlinkChatIds([]);
    setDockedChatId(null);
    setToasts([]);
    setDmThreads([]);
    setDmMessages({});
    setDmOpenPeerId(null);
    notifiedArrivalRef.current.clear();
    notifiedReturnRef.current.clear();
  }, []);

  // Keep the socket useEffect's auth-failure branch pointed at the latest
  // clearSessionState — it's a stable useCallback but the ref makes the
  // dependency explicit and avoids ordering fragility.
  clearSessionStateRef.current = clearSessionState;

  const logout = useCallback(() => {
    disconnectSocket();
    clearSessionState();
  }, [clearSessionState]);

  // ─── Calls ─────────────────────────────────────────────────
  const startCall = useCallback(
    (conversationId: string, kind: CallKind) => {
      const socket = getSocket();
      if (!socket) return;
      if (activeCallRef.current) {
        pushToast('Already in a call', 'Hang up before starting another call.', 'error');
        return;
      }
      pendingCallConvRef.current = conversationId;
      socket.emit(EV.AgentCallStart, { conversationId, kind });
    },
    [pushToast],
  );

  const acceptIncomingCall = useCallback(() => {
    setIncomingCall((prev) => {
      if (prev) setActiveCall(prev.call);
      return null;
    });
  }, []);

  const declineIncomingCall = useCallback(() => {
    setIncomingCall(null);
  }, []);

  const clearActiveCall = useCallback(() => {
    setActiveCall(null);
  }, []);

  // ─── Internal team chat ─────────────────────────────────────
  const openDMDrawer = useCallback(
    (peerId: string) => {
      setDmOpenPeerId(peerId);
      // Lazily hydrate messages for this peer the first time we open the thread.
      setDmMessages((prev) => {
        if (prev[peerId]) return prev;
        void api
          .agentDMMessages(peerId)
          .then((msgs) => setDmMessages((cur) => ({ ...cur, [peerId]: msgs })))
          .catch(() => undefined);
        return prev;
      });
      // Mark as read on both sides.
      getSocket()?.emit(EV.AgentDMRead, { fromUserId: peerId });
      setDmThreads((prev) =>
        prev.map((t) => (t.peerUserId === peerId ? { ...t, unread: 0 } : t)),
      );
    },
    [],
  );
  const closeDMDrawer = useCallback(() => setDmOpenPeerId(null), []);
  const markDMRead = useCallback((peerId: string) => {
    getSocket()?.emit(EV.AgentDMRead, { fromUserId: peerId });
    setDmThreads((prev) =>
      prev.map((t) => (t.peerUserId === peerId ? { ...t, unread: 0 } : t)),
    );
  }, []);
  const sendDM = useCallback(async (peerId: string, body: string) => {
    const trimmed = body.trim().slice(0, 4000);
    if (!trimmed) return;
    const socket = getSocket();
    if (!socket) return;
    const tempId = `tmp_${Math.random().toString(36).slice(2)}_${performance.now()}`;
    const user = meRef.current;
    if (!user) return;
    // Optimistic echo — the server's own AgentDM event will replace this row.
    const nowTs = new Date().toISOString();
    const optimistic: AgentDirectMessage = {
      id: tempId,
      fromUserId: user.id,
      toUserId: peerId,
      body: trimmed,
      createdAt: nowTs,
      readAt: null,
      tempId,
    };
    setDmMessages((prev) => ({
      ...prev,
      [peerId]: [...(prev[peerId] ?? []), optimistic],
    }));
    socket.emit(EV.AgentDMSend, { toUserId: peerId, body: trimmed, tempId });
  }, []);
  // Refresh DM thread metadata (unread counts, peer names) whenever we (re)connect.
  useEffect(() => {
    if (!token || !me) return;
    void refreshDMThreadsMeta();
    // Depend on me?.id (not `me`) so this doesn't re-fetch on every setMe
    // triggered by setAway / refreshDirectory / socket AgentReady.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, me?.id, refreshDMThreadsMeta]);

  const dmUnreadTotal = React.useMemo(
    () => dmThreads.reduce((n, t) => n + t.unread, 0),
    [dmThreads],
  );

  const value: AppContextValue = {
    authed: !!token,
    booting: !!token && !me,
    me,
    csrIds,
    websites,
    teams,
    conversations,
    visitorsByWebsite,
    online,
    awayMap,
    setAway,
    connected,
    toasts,
    incomingCall,
    activeCall,
    openChats,
    openChatTab,
    closeChatTab,
    dockedChatId,
    openDockedChat,
    closeDockedChat,
    blinkChatIds,
    stopBlink,
    setMeUser: setMe,
    login,
    logout,
    pushToast,
    dismissToast,
    refreshConversations,
    refreshDirectory,
    updateConversation,
    markConversationRead,
    startCall,
    acceptIncomingCall,
    declineIncomingCall,
    clearActiveCall,
    dmThreads,
    dmMessages,
    dmUnreadTotal,
    dmOpenPeerId,
    openDMDrawer,
    closeDMDrawer,
    sendDM,
    markDMRead,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
