import type {
  AssignmentRecord,
  ChatMessage,
  ConversationSummary,
  FileMeta,
  Role,
  Team,
  UserPublic,
  Visitor,
  Website,
} from '@livechat/shared';
import { API } from '@livechat/shared';

// ─── Token storage ───────────────────────────────────────────
const TOKEN_KEY = 'livechat.dashboard.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
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
export interface ReportsOverview {
  totals: { active: number; waiting: number; closed: number; missed: number };
  avgFirstResponseSeconds: number | null;
  csat: { average: number | null; count: number };
  perAgent: { user: UserPublic; closed: number; active: number }[];
}

export interface CreateWebsiteInput {
  name: string;
  domains: string[];
  primaryColor: string;
  greeting: string;
  logoUrl: string | null;
  teamId: string;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: UserPublic }>(API.login, {
      method: 'POST',
      body: { email, password },
    }),

  me: () => request<{ user: UserPublic; websites: Website[]; teams: Team[] }>(API.me),

  users: async (): Promise<UserPublic[]> =>
    unwrapList<UserPublic>(await request<unknown>(API.users), 'users'),

  createUser: (input: { email: string; name: string; password: string; role: Role; maxChats: number }) =>
    request<unknown>(API.users, { method: 'POST', body: input }),

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

  websiteVisitors: async (websiteId: string): Promise<Visitor[]> =>
    unwrapList<Visitor>(
      await request<unknown>(`${API.websites}/${encodeURIComponent(websiteId)}/visitors`),
      'visitors',
    ),

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

  reports: (websiteId?: string) =>
    request<ReportsOverview>(
      websiteId ? `${API.reports}?websiteId=${encodeURIComponent(websiteId)}` : API.reports,
    ),
};

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
