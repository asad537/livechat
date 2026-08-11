import type {
  AssignmentRecord,
  ChatMessage,
  ConversationSummary,
  FileMeta,
  Role,
  Team,
  UserPublic,
  Visitor,
  VisitorPage,
  Website,
} from '@livechat/shared';
import { API } from '@livechat/shared';

// ─── Token storage ───────────────────────────────────────────
const TOKEN_KEY = 'livechat.dashboard.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY);
}

// remember=true → persist across browser restarts (localStorage);
// false → only for this tab session (sessionStorage).
export function setToken(token: string, remember = true): void {
  clearToken();
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

// ─── Fetch helper ────────────────────────────────────────────
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { method: opts.method ?? 'GET', headers, body });
  if (!res.ok) {
    let message = res.statusText || `Request failed (${res.status})`;
    try {
      const data: unknown = await res.json();
      if (data && typeof data === 'object') {
        const err = (data as Record<string, unknown>).error ?? (data as Record<string, unknown>).message;
        if (typeof err === 'string' && err) message = err;
      }
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Accept both bare arrays and `{ key: [...] }` envelopes from list endpoints. */
function unwrapList<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const inner = (data as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

// ─── Typed endpoints ─────────────────────────────────────────
export interface AgentReportRow {
  user: UserPublic;
  closed: number;
  active: number;
  handled: number;
  resolutionRate?: number | null;
  avgFirstResponseSeconds: number | null;
  avgDurationSeconds: number | null;
  rating: { average: number | null; count: number };
}

export type ReportRange = 'today' | '7d' | '30d' | 'all';

export interface WebsitePerfRow {
  id: string;
  name: string;
  color: string;
  chats: number;
  missed: number;
  avgReplySeconds: number | null;
  resolutionRate: number | null;
  csat: number | null;
}

export interface ReportsOverview {
  range?: string;
  totals: { active: number; waiting: number; closed: number; missed: number };
  avgFirstResponseSeconds: number | null;
  csat: { average: number | null; count: number };
  perAgent: AgentReportRow[];
  trend?: { day: string; count: number }[];
  tiles?: {
    resolutionRate: number | null;
    avgChatDurationSeconds: number | null;
    avgReplySeconds: number | null;
    peakHour: { start: number; share: number } | null;
    returningRate: number | null;
    conversionRate: number | null;
  };
  outcomes?: { resolved: number; transferred: number; missed: number; open: number };
  byHour?: number[];
  trendDetail?: { day: string; count: number; frtSeconds: number | null; durationSeconds: number | null; replySeconds?: number | null }[];
  csatDist?: number[];
  funnel?: { visitors: number; chats: number; answered: number; resolved: number };
  countries?: { country: string; cc: string | null; n: number; pct: number }[];
  topics?: { word: string; n: number; pct: number }[];
  websitePerf?: WebsitePerfRow[];
  yesterdayFrtSeconds?: number | null;
  yesterday?: { chats: number; closed: number; missed: number; frtSeconds: number | null };
  trendWindow?: number;
  trendMode?: 'day' | 'hour';
}

export interface ChatHistoryRow {
  id: string;
  status: string;
  createdAt: string;
  closedAt: string | null;
  durationSeconds: number | null;
  rating: number | null;
  websiteId: string;
  website: string;
  websiteColor: string;
  agent: string | null;
  visitorId: string;
  visitor: string | null;
  visitorEmail: string | null;
  messages: number;
}

export interface ReportRecord {
  id: string;
  createdAt: string;
  status: string;
  website: string;
  agent: string | null;
  visitor: string | null;
  visitorEmail: string | null;
  firstResponseSeconds: number | null;
  durationSeconds: number | null;
  messages: number;
  rating: number | null;
  ratingComment: string | null;
}

export interface CreateWebsiteInput {
  name: string;
  domains: string[];
  primaryColor: string;
  greeting: string;
  logoUrl: string | null;
  teamId: string;
  aiEnabled?: boolean;
  headerColor?: string | null;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: UserPublic }>(API.login, {
      method: 'POST',
      body: { email, password },
    }),

  me: () =>
    request<{ user: UserPublic; websites: Website[]; teams: Team[]; csrIds?: string[] }>(API.me),

  updateMe: (patch: {
    name?: string;
    avatarColor?: string;
    currentPassword?: string;
    newPassword?: string;
  }) => request<{ user: UserPublic }>(API.me, { method: 'PATCH', body: patch }),

  uploadMyAvatar: async (file: File): Promise<UserPublic> => {
    const fd = new FormData();
    fd.append('file', file);
    const token = getToken() ?? '';
    const res = await fetch(`${API.me}/avatar`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: fd,
    });
    if (!res.ok) {
      let message = 'Upload failed';
      try {
        const data = (await res.json()) as Record<string, unknown>;
        if (typeof data.error === 'string') message = data.error;
      } catch {
        /* ignore */
      }
      throw new ApiError(message, res.status);
    }
    return ((await res.json()) as { user: UserPublic }).user;
  },

  deleteMyAvatar: () => request<{ user: UserPublic }>(`${API.me}/avatar`, { method: 'DELETE' }),

  users: async (): Promise<UserPublic[]> =>
    unwrapList<UserPublic>(await request<unknown>(API.users), 'users'),

  createUser: (input: {
    email: string;
    name: string;
    password: string;
    role: Role;
    maxChats: number;
    teamLeadId?: string | null;
    allowedIps?: string | null;
  }) => request<unknown>(API.users, { method: 'POST', body: input }),

  updateUser: (
    id: string,
    patch: {
      name?: string;
      role?: Role;
      maxChats?: number;
      teamLeadId?: string | null;
      password?: string;
      allowedIps?: string | null;
    },
  ) => request<UserPublic>(`${API.users}/${id}`, { method: 'PATCH', body: patch }),

  deleteUser: (id: string) => request<{ ok: boolean }>(`${API.users}/${id}`, { method: 'DELETE' }),

  chatHistory: (opts: {
    page?: number;
    websiteId?: string;
    agentId?: string;
    status?: string;
    q?: string;
    from?: string;
    to?: string;
  }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    return request<{ chats: ChatHistoryRow[]; total: number; page: number; pages: number }>(
      `/api/chats/history?${params.toString()}`,
    );
  },

  teams: async (): Promise<Team[]> => unwrapList<Team>(await request<unknown>(API.teams), 'teams'),

  createTeam: (name: string) => request<unknown>(API.teams, { method: 'POST', body: { name } }),

  addTeamMember: (teamId: string, userId: string, isLead: boolean) =>
    request<unknown>(`${API.teams}/${encodeURIComponent(teamId)}/members`, {
      method: 'POST',
      body: { userId, isLead },
    }),

  removeTeamMember: (teamId: string, userId: string) =>
    request<unknown>(
      `${API.teams}/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),

  websites: async (): Promise<Website[]> =>
    unwrapList<Website>(await request<unknown>(API.websites), 'websites'),

  createWebsite: (input: CreateWebsiteInput) =>
    request<unknown>(API.websites, { method: 'POST', body: input }),

  updateWebsite: (id: string, patch: Partial<CreateWebsiteInput>) =>
    request<unknown>(`${API.websites}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    }),

  visitorHistory: (params: { limit?: number; offset?: number; q?: string; websiteId?: string }) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    if (params.q) qs.set('q', params.q);
    if (params.websiteId) qs.set('websiteId', params.websiteId);
    return request<{ visitors: Visitor[]; total: number; limit: number; offset: number }>(
      `/api/visitors/history?${qs.toString()}`,
    );
  },

  websiteVisitors: async (websiteId: string): Promise<Visitor[]> =>
    unwrapList<Visitor>(
      await request<unknown>(`${API.websites}/${encodeURIComponent(websiteId)}/visitors`),
      'visitors',
    ),

  // Visitors an agent has actually messaged (role-scoped), most recent first.
  servedVisitors: async (limit = 10): Promise<Visitor[]> =>
    (await request<{ visitors: Visitor[] }>(`/api/visitors/served?limit=${limit}`)).visitors ?? [],

  conversations: async (params: {
    websiteId?: string;
    status?: string;
    scope?: 'mine' | 'team' | 'all';
  }): Promise<ConversationSummary[]> => {
    const qs = new URLSearchParams();
    if (params.websiteId) qs.set('websiteId', params.websiteId);
    if (params.status) qs.set('status', params.status);
    if (params.scope) qs.set('scope', params.scope);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return unwrapList<ConversationSummary>(
      await request<unknown>(`${API.conversations}${suffix}`),
      'conversations',
    );
  },

  messages: async (conversationId: string): Promise<ChatMessage[]> =>
    unwrapList<ChatMessage>(
      await request<unknown>(`${API.conversations}/${encodeURIComponent(conversationId)}/messages`),
      'messages',
    ),

  history: async (conversationId: string): Promise<AssignmentRecord[]> =>
    unwrapList<AssignmentRecord>(
      await request<unknown>(`${API.conversations}/${encodeURIComponent(conversationId)}/history`),
      'history',
    ),

  reports: (websiteId?: string, range?: ReportRange) => {
    const qs = new URLSearchParams();
    if (websiteId) qs.set('websiteId', websiteId);
    if (range) qs.set('range', range);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<ReportsOverview>(`${API.reports}${suffix}`);
  },

  reportRecords: (params: {
    from?: string;
    to?: string;
    agentId?: string;
    websiteId?: string;
    status?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.agentId) qs.set('agentId', params.agentId);
    if (params.websiteId) qs.set('websiteId', params.websiteId);
    if (params.status) qs.set('status', params.status);
    return request<{ records: ReportRecord[]; total: number }>(
      `/api/reports/records?${qs.toString()}`,
    );
  },

  websiteStats: () =>
    request<Record<string, { chats: number; open: number; aiPages: number; aiUrls: number; aiLastScan: string | null }>>(
      `${API.websites}/stats`,
    ),

  deleteWebsite: (websiteId: string) =>
    request<{ ok: boolean; deletedConversations: number }>(
      `${API.websites}/${encodeURIComponent(websiteId)}`,
      { method: 'DELETE' },
    ),

  searchConversations: async (q: string): Promise<ConversationSummary[]> =>
    unwrapList<ConversationSummary>(
      await request<unknown>(`${API.conversations}/search?q=${encodeURIComponent(q)}`),
      'conversations',
    ),

  scanWebsite: (websiteId: string, url: string) =>
    request<{ ok: boolean; url: string; pages: number; chars: number; urls: number }>(
      `${API.websites}/${encodeURIComponent(websiteId)}/scan`,
      { method: 'POST', body: { url } },
    ),

  visitorProfile: (visitorId: string) =>
    request<VisitorProfile>(`/api/visitors/${encodeURIComponent(visitorId)}`),

  updateVisitor: (
    visitorId: string,
    patch: { name?: string; email?: string; phone?: string; notes?: string },
  ) =>
    request<Visitor>(`/api/visitors/${encodeURIComponent(visitorId)}`, {
      method: 'PATCH',
      body: patch,
    }),

  visitorConversations: async (visitorId: string): Promise<VisitorChat[]> =>
    unwrapList<VisitorChat>(
      await request<unknown>(`/api/visitors/${encodeURIComponent(visitorId)}/conversations`),
      'conversations',
    ),
};

// ─── Visitor module shapes ───────────────────────────────────
export interface VisitorProfile {
  visitor: Visitor;
  sessionPath: VisitorPage[];
  stats: {
    chats: number;
    pagesAllTime: number;
    ratedChats: number;
    avgRating: number | null;
    firstSeenAt: string;
  };
}

export interface VisitorChat {
  id: string;
  status: string;
  createdAt: string;
  closedAt: string | null;
  rating: number | null;
  assignedUserId: string | null;
  agentName: string | null;
  messageCount: number;
  preview: string | null;
}

// ─── File upload / download ──────────────────────────────────
export async function uploadFile(conversationId: string, file: File): Promise<void> {
  const token = getToken() ?? '';
  const fd = new FormData();
  fd.append('file', file);
  fd.append('conversationId', conversationId);
  fd.append('token', token);
  const qs = new URLSearchParams({ conversationId, token });
  const res = await fetch(`${API.uploads}?${qs.toString()}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: fd,
  });
  if (!res.ok) {
    let message = 'Upload failed';
    try {
      const data: unknown = await res.json();
      if (data && typeof data === 'object') {
        const err = (data as Record<string, unknown>).error;
        if (typeof err === 'string' && err) message = err;
      }
    } catch {
      /* ignore */
    }
    throw new ApiError(message, res.status);
  }
}

export function fileDownloadUrl(file: FileMeta): string {
  const base = file.downloadUrl ?? `${API.files}/${file.id}/download`;
  const token = getToken() ?? '';
  return `${base}?token=${encodeURIComponent(token)}`;
}
