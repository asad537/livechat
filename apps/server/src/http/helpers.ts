import type { NextFunction, Request, Response } from 'express';
import type { Team, UserPublic, Visitor, Website, WebsiteBranding } from '@livechat/shared';
import type { AppDeps } from '../core/deps.js';
import type { AuthedRequest, UserRow } from '../core/auth.js';
import { toUserPublic } from '../core/auth.js';

// ─── Errors + async wrapper ──────────────────────────────────

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

type AsyncHandler = (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void>;

/** Wraps an async route handler so rejections reach the error middleware. */
export function h(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req as AuthedRequest, res, next).catch(next);
  };
}

/** After requireAgent, req.user is always present — narrow it safely. */
export function agent(req: AuthedRequest): UserRow {
  if (!req.user) throw new HttpError(401, 'Unauthorized');
  return req.user;
}

// ─── Small utilities ─────────────────────────────────────────

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function requireString(v: unknown, field: string, maxLen = 500): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new HttpError(400, `Missing or invalid field: ${field}`);
  }
  const s = v.trim();
  if (s.length > maxLen) throw new HttpError(400, `Field too long: ${field}`);
  return s;
}

// ─── DB row shapes (snake_case) ──────────────────────────────

export interface WebsiteRow {
  id: string;
  name: string;
  widget_key: string;
  domains: string | null;
  team_id: string;
  logo_url: string | null;
  primary_color: string;
  greeting: string;
  ai_enabled?: number | null;
  header_color?: string | null;
  created_at: string;
}

export interface TeamRow {
  id: string;
  name: string;
  created_at: string;
}

export interface TeamMemberRow {
  id: string;
  team_id: string;
  user_id: string;
  is_lead: number;
}

export interface VisitorRow {
  id: string;
  website_id: string;
  name: string | null;
  email: string | null;
  created_at: string;
  last_seen_at: string;
  ip?: string | null;
  geo_country?: string | null;
  geo_city?: string | null;
  geo_cc?: string | null;
  user_agent?: string | null;
  referrer?: string | null;
  total_visits?: number | null;
  session_started_at?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export interface ConversationRow {
  id: string;
  website_id: string;
  visitor_id: string;
  status: string;
  assigned_user_id: string | null;
  created_at: string;
  activated_at: string | null;
  closed_at: string | null;
}

// ─── Row → public shape mappers ──────────────────────────────

export function toBranding(row: WebsiteRow): WebsiteBranding {
  return {
    id: row.id,
    name: row.name,
    logoUrl: row.logo_url ?? null,
    primaryColor: row.primary_color,
    headerColor: row.header_color ?? null,
    greeting: row.greeting,
  };
}

export function toWebsite(row: WebsiteRow): Website {
  return {
    ...toBranding(row),
    widgetKey: row.widget_key,
    domains: (row.domains ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter((d) => d.length > 0),
    teamId: row.team_id,
    aiEnabled: row.ai_enabled == null || Number(row.ai_enabled) !== 0,
  };
}

export function toVisitor(row: VisitorRow): Visitor {
  return {
    id: row.id,
    websiteId: row.website_id,
    name: row.name ?? null,
    email: row.email ?? null,
    lastSeenAt: row.last_seen_at,
    ip: row.ip ?? null,
    country: row.geo_country ?? null,
    city: row.geo_city ?? null,
    countryCode: row.geo_cc ?? null,
    userAgent: row.user_agent ?? null,
    referrer: row.referrer ?? null,
    totalVisits: row.total_visits ?? 0,
    sessionStartedAt: row.session_started_at ?? null,
    phone: row.phone ?? null,
    notes: row.notes ?? null,
  };
}

export function toTeam(row: TeamRow): Team {
  return { id: row.id, name: row.name };
}

/** UserPublic decorated with the live presence flags. */
export function toUserWithPresence(deps: AppDeps, row: UserRow): UserPublic {
  return {
    ...toUserPublic(row),
    online: deps.presence.isAgentOnline(row.id),
    away: deps.presence.isAgentAway(row.id),
  };
}

// ─── Scoping helpers ─────────────────────────────────────────

/** Ids of teams the user belongs to. */
export async function userTeamIds(deps: AppDeps, userId: string): Promise<string[]> {
  const rows = await deps.db.all<{ team_id: string }>(
    'SELECT team_id FROM team_members WHERE user_id = ?',
    [userId],
  );
  return rows.map((r) => r.team_id);
}

/** Websites the user may see: ADMIN = all, otherwise via team membership. */
export async function accessibleWebsiteRows(deps: AppDeps, user: UserRow): Promise<WebsiteRow[]> {
  if (user.role === 'ADMIN') {
    return deps.db.all<WebsiteRow>('SELECT * FROM websites ORDER BY name');
  }
  const teamIds = await userTeamIds(deps, user.id);
  if (teamIds.length === 0) return [];
  return deps.db.all<WebsiteRow>(
    `SELECT * FROM websites WHERE team_id IN (${placeholders(teamIds.length)}) ORDER BY name`,
    teamIds,
  );
}

/** Teams visible to the user (with members): ADMIN = all, otherwise own memberships. */
export async function visibleTeams(deps: AppDeps, user: UserRow): Promise<Team[]> {
  let teamRows: TeamRow[];
  if (user.role === 'ADMIN') {
    teamRows = await deps.db.all<TeamRow>('SELECT * FROM teams ORDER BY name');
  } else {
    teamRows = await deps.db.all<TeamRow>(
      `SELECT t.* FROM teams t
         JOIN team_members tm ON tm.team_id = t.id
        WHERE tm.user_id = ?
        ORDER BY t.name`,
      [user.id],
    );
  }
  if (teamRows.length === 0) return [];

  const memberRows = await deps.db.all<TeamMemberRow & UserRow>(
    `SELECT tm.team_id, tm.is_lead, u.*
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id IN (${placeholders(teamRows.length)})
      ORDER BY u.name`,
    teamRows.map((t) => t.id),
  );

  return teamRows.map((t) => ({
    ...toTeam(t),
    members: memberRows
      .filter((m) => m.team_id === t.id)
      .map((m) => ({ ...toUserWithPresence(deps, m), isLead: Number(m.is_lead) === 1 })),
  }));
}

/** Load a conversation row or throw 404. */
export async function getConversationRow(
  deps: AppDeps,
  conversationId: string,
): Promise<ConversationRow> {
  const row = await deps.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [
    conversationId,
  ]);
  if (!row) throw new HttpError(404, 'Conversation not found');
  return row;
}

/**
 * May this agent view a conversation's transcript/history?
 * ADMIN → always; assignee → yes; team lead of the website's team → yes;
 * plain team member → only while the conversation is unassigned (queue preview).
 */
export async function canViewConversation(
  deps: AppDeps,
  user: UserRow,
  conv: ConversationRow,
): Promise<boolean> {
  if (user.role === 'ADMIN') return true;
  if (conv.assigned_user_id === user.id) return true;
  const site = await deps.db.get<{ team_id: string }>(
    'SELECT team_id FROM websites WHERE id = ?',
    [conv.website_id],
  );
  if (!site) return false;
  const membership = await deps.db.get<{ is_lead: number }>(
    'SELECT is_lead FROM team_members WHERE team_id = ? AND user_id = ?',
    [site.team_id, user.id],
  );
  if (!membership) return false;
  if (Number(membership.is_lead) === 1) return true;
  return conv.assigned_user_id === null || conv.assigned_user_id === undefined;
}
