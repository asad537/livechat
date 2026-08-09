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
import { desktopNotify, ensureNotifyPermission, playChime } from './notify';
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
  websites: Website[];
  teams: Team[];
  conversations: Record<string, ConversationSummary>;
  visitorsByWebsite: Record<string, Visitor[]>;
  online: Record<string, boolean>;
  connected: boolean;
  toasts: Toast[];
  incomingCall: IncomingCall | null;
  activeCall: CallMeta | null;
  openChats: string[];
  openChatTab(id: string): void;
  closeChatTab(id: string): void;
  login(email: string, password: string): Promise<void>;
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
  const [websites, setWebsites] = useState<Website[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [conversations, setConversations] = useState<Record<string, ConversationSummary>>({});
  const [visitorsByWebsite, setVisitorsByWebsite] = useState<Record<string, Visitor[]>>({});
  const [online, setOnline] = useState<Record<string, boolean>>({});
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [activeCall, setActiveCall] = useState<CallMeta | null>(null);

  const meRef = useRef<UserPublic | null>(null);
  meRef.current = me;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
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
    const scope = user.role === 'ADMIN' ? 'all' : user.role === 'LEAD' ? 'team' : 'mine';
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
    } catch {
      /* ignore */
    }
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
      })
      .catch(() => {
        if (cancelled) return;
        clearToken();
        setTokenState(null);
      });

    const socket = connectSocket(token);

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onConnectError = () => setConnected(false);

    const onReady = (payload: { me: UserPublic; websites: Website[]; teams: Team[] }) => {
      setMe(payload.me);
      setWebsites(payload.websites);
      setTeams(payload.teams);
      // Seed presence from the roster's online flags.
      setOnline(() => {
        const next: Record<string, boolean> = { [payload.me.id]: true };
        for (const team of payload.teams) {
          for (const member of team.members ?? []) {
            if (member.online !== undefined) next[member.id] = !!member.online;
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
        conv.status === 'WAITING' &&
        (!prev || prev.assignedUserId !== user.id)
      ) {
        const who = conv.visitor?.name || 'A visitor';
        const where = conv.website?.name ?? 'your site';
        pushToast('New chat assigned', `${who} is waiting on ${where}.`, 'info');
        playChime('new-chat');
        desktopNotify('New chat assigned', `${who} is waiting on ${where}.`, `chat-${conv.id}`);
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
      setVisitorsByWebsite((prev) => ({ ...prev, [payload.websiteId]: payload.visitors ?? [] }));
    };

    const onPresence = (payload: { userId: string; online: boolean }) => {
      setOnline((prev) => ({ ...prev, [payload.userId]: payload.online }));
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
    document.title = unreadTotal > 0 ? `(${unreadTotal}) LiveChat` : 'LiveChat — Agent Dashboard';
  }, [unreadTotal]);

  // ─── Auth actions ──────────────────────────────────────────
  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    setToken(res.token);
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

  // ── Bottom chat dock (Zendesk-style open-chat tabs) ──
  const [openChats, setOpenChats] = useState<string[]>([]);
  const openChatTab = useCallback((id: string) => {
    setOpenChats((prev) => (prev.includes(id) ? prev : [...prev.slice(-7), id]));
  }, []);
  const closeChatTab = useCallback((id: string) => {
    setOpenChats((prev) => prev.filter((c) => c !== id));
  }, []);

  const value: AppContextValue = {
    authed: !!token,
    booting: !!token && !me,
    me,
    websites,
    teams,
    conversations,
    visitorsByWebsite,
    online,
    connected,
    toasts,
    incomingCall,
    activeCall,
    openChats,
    openChatTab,
    closeChatTab,
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
