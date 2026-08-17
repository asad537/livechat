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

  const meRef = useRef<UserPublic | null>(null);
  // Known online-visitor ids per website — to knock only for genuinely new ones.
  const seenVisitorsRef = useRef<Record<string, Set<string>>>({});
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
  const openChatTab = useCallback((id: string) => {
    setOpenChats((prev) => (prev.includes(id) ? prev : [...prev.slice(-7), id]));
  }, []);
  // Floating docked chat window (opened from the dock or the visitor drawer).
  const [dockedChatId, setDockedChatId] = useState<string | null>(null);
  const openDockedChat = useCallback(
    (id: string) => {
      openChatTab(id);
      setDockedChatId(id);
    },
    [openChatTab],
  );
  const closeDockedChat = useCallback(() => setDockedChatId(null), []);

  const closeChatTab = useCallback((id: string) => {
    setOpenChats((prev) => prev.filter((c) => c !== id));
    setDockedChatId((prev) => (prev === id ? null : prev));
  }, []);

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
            clearToken();
            setTokenState(null);
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
      if (
        user &&
        conv.assignedUserId === user.id &&
        (!prev || prev.assignedUserId !== user.id) &&
        (conv.status === 'WAITING' || conv.status === 'ACTIVE' || conv.status === 'OFFERED')
      ) {
        const who = conv.visitor?.name || 'A visitor';
        const where = conv.website?.label?.trim() || conv.website?.name || 'your site';
        // A hand-off to an already-running chat is a transfer, not a fresh chat.
        const transferred = conv.status !== 'WAITING' || !!prev;
        const title = transferred ? 'Chat transferred to you' : 'New chat assigned';
        pushToast(title, `${who} on ${where}.`, 'info');
        playChime('new-chat');
        desktopNotify(title, `${who} on ${where}.`, `chat-${conv.id}`);
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
      // The visitor left the site → auto-minimize their floating chat window
      // (its tab stays in the dock below).
      if (conv.lastMessage?.kind === 'SYSTEM' && conv.lastMessage.body === 'Visitor left the site') {
        setDockedChatId((prevId) => (prevId === conv.id ? null : prevId));
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

  const logout = useCallback(() => {
    disconnectSocket();
    clearToken();
    setTokenState(null);
    setMe(null);
    setWebsites([]);
    setTeams([]);
    setConversations({});
    setVisitorsByWebsite({});
    setOnline({});
    setConnected(false);
    setIncomingCall(null);
    setActiveCall(null);
  }, []);

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
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
