// ─────────────────────────────────────────────────────────────
// Shared contract between server, widget and dashboard.
// Import via the `@livechat/shared` alias (tsconfig paths / vite alias).
// ─────────────────────────────────────────────────────────────

// ADMIN → full control · MANAGER → view everything, edit nothing ·
// LEAD ("Team Lead") → owns CSRs via teamLeadId · CSR → frontline agent.
export type Role = 'ADMIN' | 'MANAGER' | 'LEAD' | 'CSR';
export type ConversationStatus = 'WAITING' | 'OFFERED' | 'ACTIVE' | 'CLOSED' | 'MISSED';
export type SenderType = 'VISITOR' | 'AGENT' | 'SYSTEM' | 'BOT';
export type MessageKind = 'TEXT' | 'FILE' | 'CALL' | 'SYSTEM';
export type ScanStatus = 'PENDING' | 'CLEAN' | 'BLOCKED';
export type CallKind = 'AUDIO' | 'VIDEO';
export type CallStatus = 'INVITED' | 'ACTIVE' | 'DECLINED' | 'ENDED';
export type CallProvider = 'BUILTIN' | 'DAILY';
export type AssignmentReason = 'AUTO' | 'OFFER' | 'TRANSFER';

export interface UserPublic {
  id: string;
  email: string;
  name: string;
  role: Role;
  maxChats: number;
  avatarColor: string;
  avatarUrl?: string | null; // server path, e.g. /api/users/:id/avatar?v=...
  teamLeadId?: string | null; // for CSRs: the Team Lead they report to
  allowedIps?: string | null; // comma-separated IPs/CIDRs; empty = unrestricted
  online?: boolean;
  away?: boolean;
  activeChats?: number;
}

export interface WebsiteBranding {
  id: string;
  name: string;
  label?: string | null; // short name agents see in the website chip (falls back to name)
  logoUrl: string | null;
  primaryColor: string;
  headerColor?: string | null; // widget header bar; NULL = primaryColor
  greeting: string;
}

export interface Website extends WebsiteBranding {
  widgetKey: string;
  domains: string[];
  teamId: string;
  aiEnabled?: boolean; // AI assistant greets queued visitors on this site
}

export interface Team {
  id: string;
  name: string;
  members?: (UserPublic & { isLead: boolean })[];
}

export interface Visitor {
  id: string;
  websiteId: string;
  name: string | null;
  email: string | null;
  lastSeenAt: string;
  online?: boolean;
  currentPage?: string | null;
  ip?: string | null;
  country?: string | null;
  city?: string | null;
  countryCode?: string | null;      // ISO-2, for the flag
  userAgent?: string | null;
  referrer?: string | null;
  totalVisits?: number;
  sessionStartedAt?: string | null; // current/last session start (time-on-site)
  sessionPages?: number;            // pages viewed this session
  phone?: string | null;
  notes?: string | null;
  chats?: number;                   // lifetime conversation count
  // Live open conversation (WAITING/OFFERED/ACTIVE), if any — drives the
  // "busy with another agent" hint independent of history scoping.
  activeConversation?: {
    id: string;
    status: ConversationStatus;
    assignedUserId: string | null;
    agentName: string | null;
  } | null;
}

export interface VisitorPage {
  url: string | null;
  title: string | null;
  at: string;
}

export interface FileMeta {
  id: string;
  originalName: string;
  mime: string;
  size: number;
  scanStatus: ScanStatus;
  downloadUrl?: string;
}

export interface CallMeta {
  id: string;
  conversationId: string;
  kind: CallKind;
  provider: CallProvider;
  status: CallStatus;
  roomUrl: string | null;
  startedBy: string; // 'AGENT:<userId>' | 'VISITOR:<visitorId>'
  createdAt: string;
  endedAt: string | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderType: SenderType;
  senderUserId: string | null;
  body: string;
  kind: MessageKind;
  fileId: string | null;
  callId: string | null;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  file?: FileMeta | null;
  call?: CallMeta | null;
  sender?: { name: string; avatarColor: string; avatarUrl?: string | null } | null;
  tempId?: string;
}

export interface ConversationSummary {
  id: string;
  websiteId: string;
  visitorId: string;
  status: ConversationStatus;
  assignedUserId: string | null;
  createdAt: string;
  activatedAt: string | null;
  closedAt: string | null;
  rating?: number | null;        // CSAT 1–5, set by the visitor after close
  visitor?: Visitor;
  website?: WebsiteBranding;
  assignedUser?: UserPublic | null;
  lastMessage?: ChatMessage | null;
  unreadCount?: number;
}

export interface AssignmentRecord {
  id: string;
  conversationId: string;
  fromUserId: string | null;
  toUserId: string;
  reason: AssignmentReason;
  createdAt: string;
  fromUser?: UserPublic | null;
  toUser?: UserPublic | null;
}

// ─── Socket.IO namespaces ────────────────────────────────────
export const WIDGET_NAMESPACE = '/widget';
export const AGENT_NAMESPACE = '/agent';

// ─── Socket.IO event names ───────────────────────────────────
export const EV = {
  // widget client → server
  WidgetMessage: 'widget:message',           // { body: string, tempId: string }
  WidgetTyping: 'widget:typing',             // { typing: boolean }
  WidgetRead: 'widget:read',                 // { messageIds: string[] }
  WidgetInfo: 'widget:info',                 // { name?: string, email?: string }
  WidgetCallAccept: 'widget:call:accept',    // { callId: string }
  WidgetCallDecline: 'widget:call:decline',  // { callId: string }
  WidgetEndChat: 'widget:end-chat',          // {} — visitor closes the conversation
  WidgetEmailTranscript: 'widget:email-transcript', // {} → ack {ok} | {error} — email me this chat
  WidgetRate: 'widget:rate',                 // { rating: 1-5, comment?: string } — CSAT after close

  // server → widget
  WidgetReady: 'widget:ready',               // { visitor, website: WebsiteBranding, conversation?, messages?, agent? }

  // both namespaces, server → client
  ChatMessage: 'chat:message',               // { message: ChatMessage }
  ChatReceipt: 'chat:receipt',               // { conversationId, messageIds: string[], deliveredAt?, readAt? }
  ChatTyping: 'chat:typing',                 // { conversationId, from: 'VISITOR'|'AGENT', typing: boolean }
  ChatStatus: 'chat:status',                 // { conversation: ConversationSummary }
  ChatAgent: 'chat:agent',                   // { conversationId, agent: {name, avatarColor} | null }
  ChatFeedbackRequest: 'chat:feedback-request', // { conversationId } — agent asked the visitor to rate

  // calls (both namespaces)
  CallInvite: 'call:invite',                 // { call: CallMeta, from: {name} }
  CallStatus: 'call:status',                 // { call: CallMeta }
  CallSignal: 'call:signal',                 // { callId, from: string, to?: string, data: any }  (WebRTC SDP/ICE relay)
  CallPeers: 'call:peers',                   // { callId, peers: {peerId, label}[] } sent on join (builtin provider)
  CallJoin: 'call:join',                     // client → server { callId } ; server → others { callId, peerId, label }
  CallLeave: 'call:leave',                   // client → server { callId } ; server → others { callId, peerId }

  // agent client → server
  AgentOpen: 'agent:open',                   // { conversationId } join conversation room, returns via ack: { messages, conversation, history }
  AgentMessage: 'agent:message',             // { conversationId, body, tempId }
  AgentStartChat: 'agent:start-chat',        // { websiteId, visitorId, body } CSR-initiated → OFFERED
  AgentAccept: 'agent:accept',               // { conversationId }
  AgentClose: 'agent:close',                 // { conversationId }
  AgentTransfer: 'agent:transfer',           // { conversationId, toUserId }
  AgentTyping: 'agent:typing',               // { conversationId, typing: boolean }
  AgentRead: 'agent:read',                   // { conversationId, messageIds: string[] }
  AgentRequestFeedback: 'agent:request-feedback', // { conversationId } → pops the rating UI on the widget
  AgentWatchWebsite: 'agent:watch-website',  // { websiteId } subscribe to visitor list + inbox of a website
  AgentSetAway: 'agent:set-away',            // { away: boolean } manual availability
  AgentCallStart: 'agent:call:start',        // { conversationId, kind: CallKind }
  AgentCallInvite: 'agent:call:invite-participant', // { callId, userId }

  // server → agent
  AgentReady: 'agent:ready',                 // { me: UserPublic, websites: Website[], teams: Team[], csrIds: string[] }
  InboxUpdate: 'inbox:update',               // { conversation: ConversationSummary }
  VisitorsUpdate: 'visitors:update',         // { websiteId, visitors: Visitor[] }
  PresenceUpdate: 'presence:update',         // { userId, online: boolean, away?: boolean }

  // errors (both namespaces)
  AppError: 'app:error',                     // { message: string }
} as const;

// ─── REST API paths (server prefix /api) ─────────────────────
export const API = {
  login: '/api/auth/login',
  me: '/api/me',
  users: '/api/users',
  teams: '/api/teams',
  websites: '/api/websites',
  conversations: '/api/conversations',
  uploads: '/api/uploads',
  files: '/api/files',
  reports: '/api/reports/overview',
  widgetBoot: '/api/widget/boot',
} as const;

export const DEFAULT_MAX_CHATS = 3;

// File limits (diagram: quarantine → scan → compress → private download)
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const BLOCKED_EXTENSIONS = ['exe', 'bat', 'cmd', 'sh', 'msi', 'scr', 'com', 'pif', 'jar'];
