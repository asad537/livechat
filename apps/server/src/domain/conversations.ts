import {
  AGENT_NAMESPACE,
  WIDGET_NAMESPACE,
  EV,
  type ConversationStatus,
  type ConversationSummary,
  type Role,
  type Visitor,
  type WebsiteBranding,
} from '@livechat/shared';
import type { AppDeps } from '../core/deps.js';
import { newId, nowIso } from '../core/db.js';
import { toUserPublic, type UserRow } from '../core/auth.js';
import { hydrateMessages, postMessage, type MessageRow } from './messages.js';
import { sendTranscriptEmail } from '../features/email/index.js';

// ─── Row shapes (snake_case DB columns) ──────────────────────

export interface ConversationRow {
  id: string;
  website_id: string;
  visitor_id: string;
  status: ConversationStatus;
  assigned_user_id: string | null;
  created_at: string;
  activated_at: string | null;
  closed_at: string | null;
  rating: number | null;
  rating_comment: string | null;
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

export interface WebsiteRow {
  id: string;
  name: string;
  label?: string | null;
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

export function toVisitor(row: VisitorRow, online?: boolean, currentPage?: string | null): Visitor {
  return {
    id: row.id,
    websiteId: row.website_id,
    name: row.name,
    email: row.email,
    lastSeenAt: row.last_seen_at,
    online,
    currentPage: currentPage ?? null,
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

export function toBranding(row: WebsiteRow): WebsiteBranding {
  return {
    id: row.id,
    name: row.name,
    label: row.label ?? null,
    logoUrl: row.logo_url,
    primaryColor: row.primary_color,
    headerColor: row.header_color ?? null,
    greeting: row.greeting,
  };
}

const convRoom = (id: string): string => `conv:${id}`;

// ─── Summaries ───────────────────────────────────────────────

/** Full ConversationSummary: visitor, website branding, assigned user, last message, unread count. */
export async function loadSummary(
  deps: AppDeps,
  conversationId: string,
): Promise<ConversationSummary | undefined> {
  return (await loadSummaries(deps, [conversationId]))[0];
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/**
 * Batched summary loader — a fixed 6 queries for ANY number of ids
 * (instead of ~6 queries PER conversation). This is the hot path for the
 * inbox list with many concurrent agents.
 */
export async function loadSummaries(
  deps: AppDeps,
  conversationIds: string[],
): Promise<ConversationSummary[]> {
  if (conversationIds.length === 0) return [];
  const idPh = placeholders(conversationIds.length);

  const convs = await deps.db.all<ConversationRow>(
    `SELECT * FROM conversations WHERE id IN (${idPh})`,
    conversationIds,
  );
  if (convs.length === 0) return [];

  const visitorIds = [...new Set(convs.map((c) => c.visitor_id))];
  const websiteIds = [...new Set(convs.map((c) => c.website_id))];
  const userIds = [...new Set(convs.map((c) => c.assigned_user_id).filter(Boolean))] as string[];
  const convIds = convs.map((c) => c.id);
  const cPh = placeholders(convIds.length);

  const [visitorRows, websiteRows, userRows, lastMsgRows, unreadRows, visitorSpokeRows] =
    await Promise.all([
    deps.db.all<VisitorRow>(
      `SELECT * FROM visitors WHERE id IN (${placeholders(visitorIds.length)})`,
      visitorIds,
    ),
    deps.db.all<WebsiteRow>(
      `SELECT * FROM websites WHERE id IN (${placeholders(websiteIds.length)})`,
      websiteIds,
    ),
    userIds.length > 0
      ? deps.db.all<UserRow>(
          `SELECT * FROM users WHERE id IN (${placeholders(userIds.length)})`,
          userIds,
        )
      : Promise.resolve([] as UserRow[]),
    // Latest message per conversation in one pass (ties deduped in JS).
    deps.db.all<MessageRow>(
      `SELECT m.* FROM messages m
         JOIN (SELECT conversation_id, MAX(created_at) AS mc FROM messages
                WHERE conversation_id IN (${cPh}) GROUP BY conversation_id) x
           ON x.conversation_id = m.conversation_id AND m.created_at = x.mc`,
      convIds,
    ),
    deps.db.all<{ conversation_id: string; n: number }>(
      `SELECT conversation_id, COUNT(*) AS n FROM messages
        WHERE conversation_id IN (${cPh}) AND sender_type = 'VISITOR' AND read_at IS NULL
        GROUP BY conversation_id`,
      convIds,
    ),
    // Which conversations the visitor has actually spoken in (any message).
    deps.db.all<{ conversation_id: string }>(
      `SELECT DISTINCT conversation_id FROM messages
        WHERE conversation_id IN (${cPh}) AND sender_type = 'VISITOR'`,
      convIds,
    ),
  ]);

  const visitors = new Map(visitorRows.map((r) => [r.id, r]));
  const websites = new Map(websiteRows.map((r) => [r.id, r]));
  const users = new Map(userRows.map((r) => [r.id, r]));
  const unread = new Map(unreadRows.map((r) => [r.conversation_id, Number(r.n)]));
  const visitorSpoke = new Set(visitorSpokeRows.map((r) => r.conversation_id));
  const lastByConv = new Map<string, MessageRow>();
  for (const m of lastMsgRows) {
    const prev = lastByConv.get(m.conversation_id);
    if (!prev || m.id > prev.id) lastByConv.set(m.conversation_id, m);
  }
  const hydrated = await hydrateMessages(deps, [...lastByConv.values()]);
  const lastHydrated = new Map(hydrated.map((m) => [m.conversationId, m]));

  const byId = new Map(convs.map((c) => [c.id, c]));
  const summaries: ConversationSummary[] = [];
  for (const id of conversationIds) {
    const conv = byId.get(id);
    if (!conv) continue;
    const visitorRow = visitors.get(conv.visitor_id);
    const websiteRow = websites.get(conv.website_id);
    const assignedRow = conv.assigned_user_id ? users.get(conv.assigned_user_id) : undefined;
    summaries.push({
      id: conv.id,
      websiteId: conv.website_id,
      visitorId: conv.visitor_id,
      status: conv.status,
      assignedUserId: conv.assigned_user_id,
      createdAt: conv.created_at,
      activatedAt: conv.activated_at,
      closedAt: conv.closed_at,
      rating: conv.rating === null || conv.rating === undefined ? null : Number(conv.rating),
      visitor: visitorRow
        ? toVisitor(
            visitorRow,
            deps.presence.isVisitorOnline(conv.visitor_id),
            deps.presence.getVisitorPage(conv.visitor_id),
          )
        : undefined,
      website: websiteRow ? toBranding(websiteRow) : undefined,
      assignedUser: assignedRow ? toUserPublic(assignedRow) : null,
      lastMessage: lastHydrated.get(conv.id) ?? null,
      unreadCount: unread.get(conv.id) ?? 0,
      hasVisitorMessage: visitorSpoke.has(conv.id),
    });
  }
  return summaries;
}

// Registered by the realtime layer — lets domain trigger a live visitor-list
// refresh (which carries each visitor's current open conversation + agent)
// whenever an assignment/status change happens, so "busy with another agent"
// and post-transfer ownership update everywhere without a page reload.
let visitorRefresh: ((websiteId: string) => void) | null = null;
export function setVisitorRefresh(fn: (websiteId: string) => void): void {
  visitorRefresh = fn;
}
/** Ask the realtime layer to rebroadcast a website's live visitor list. */
export function requestVisitorRefresh(websiteId: string): void {
  visitorRefresh?.(websiteId);
}

/** Push a fresh summary to the assignee's room and the website watchers' room in `/agent`. */
export async function emitInboxUpdate(deps: AppDeps, conversationId: string): Promise<void> {
  const conversation = await loadSummary(deps, conversationId);
  if (!conversation) return;
  const agentNs = deps.io.of(AGENT_NAMESPACE);
  if (conversation.assignedUserId) {
    agentNs.to(`user:${conversation.assignedUserId}`).emit(EV.InboxUpdate, { conversation });
  }
  agentNs.to(`website:${conversation.websiteId}`).emit(EV.InboxUpdate, { conversation });
  // Keep the live visitor list (open-conversation + agent name) in sync.
  visitorRefresh?.(conversation.websiteId);
}

/** Emit `EV.ChatStatus` with a fresh summary to the conversation room in both namespaces. */
export async function emitConversationStatus(deps: AppDeps, conversationId: string): Promise<void> {
  const conversation = await loadSummary(deps, conversationId);
  if (!conversation) return;
  const room = convRoom(conversationId);
  deps.io.of(WIDGET_NAMESPACE).to(room).emit(EV.ChatStatus, { conversation });
  deps.io.of(AGENT_NAMESPACE).to(room).emit(EV.ChatStatus, { conversation });
}

/** Emit `EV.ChatAgent` (assigned agent chip) to the widget side of a conversation. */
export async function emitConversationAgent(deps: AppDeps, conversationId: string): Promise<void> {
  const conv = await deps.db.get<ConversationRow>(
    'SELECT * FROM conversations WHERE id = ?',
    [conversationId],
  );
  if (!conv) return;
  let agent: { name: string; avatarColor: string; avatarUrl?: string | null } | null = null;
  if (conv.assigned_user_id) {
    const user = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [
      conv.assigned_user_id,
    ]);
    if (user) {
      agent = { name: user.name, avatarColor: user.avatar_color, avatarUrl: user.avatar_url ?? null };
    }
  }
  deps.io.of(WIDGET_NAMESPACE).to(convRoom(conversationId)).emit(EV.ChatAgent, {
    conversationId,
    agent,
  });
}

// ─── Assignment / routing ────────────────────────────────────

async function countActiveChats(deps: AppDeps, userId: string): Promise<number> {
  const row = await deps.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM conversations WHERE assigned_user_id = ? AND status = 'ACTIVE'",
    [userId],
  );
  return Number(row?.n ?? 0);
}

/** True when the user is online AND has spare capacity (ACTIVE chats < max_chats). */
export async function hasCapacity(deps: AppDeps, user: UserRow): Promise<boolean> {
  // No per-agent chat cap — an online (non-away) agent can always take a chat.
  return deps.presence.isAgentAvailable(user.id);
}

/**
 * Least-loaded online member of the website's team whose count of ACTIVE
 * conversations is below their `max_chats`. Returns the user id or null.
 */
export async function findEligibleCsr(
  deps: AppDeps,
  websiteId: string,
  excludeUserId?: string,
): Promise<string | null> {
  const website = await deps.db.get<WebsiteRow>('SELECT * FROM websites WHERE id = ?', [websiteId]);
  if (!website) return null;

  // One query: every team member with their live ACTIVE-chat count.
  const members = await deps.db.all<UserRow & { active: number }>(
    `SELECT u.*,
            (SELECT COUNT(*) FROM conversations c
              WHERE c.assigned_user_id = u.id AND c.status = 'ACTIVE') AS active
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ?`,
    [website.team_id],
  );

  // No per-agent chat cap anymore: any available, non-manager team member is
  // eligible; the least-loaded one is picked so load still spreads evenly.
  const candidates = members
    .filter(
      (m) =>
        m.id !== excludeUserId &&
        m.role !== 'MANAGER' && // managers are view-only, never auto-assigned
        deps.presence.isAgentAvailable(m.id),
    )
    .sort((a, b) => Number(a.active) - Number(b.active));

  return candidates[0]?.id ?? null;
}

export async function recordAssignment(
  deps: AppDeps,
  conversationId: string,
  fromUserId: string | null,
  toUserId: string,
  reason: 'AUTO' | 'OFFER' | 'TRANSFER',
): Promise<void> {
  await deps.db.run(
    'INSERT INTO assignment_history (id, conversation_id, from_user_id, to_user_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId(), conversationId, fromUserId, toUserId, reason, nowIso()],
  );
}

// ─── Lifecycle transitions ───────────────────────────────────

/** WAITING/OFFERED → ACTIVE (+activated_at) with status + agent-chip broadcasts. */
export async function activateConversation(deps: AppDeps, conversationId: string): Promise<void> {
  const conv = await deps.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [
    conversationId,
  ]);
  if (!conv) return;
  if (conv.status !== 'ACTIVE') {
    await deps.db.run(
      "UPDATE conversations SET status = 'ACTIVE', activated_at = ? WHERE id = ?",
      [nowIso(), conversationId],
    );
  }
  await emitConversationStatus(deps, conversationId);
  await emitConversationAgent(deps, conversationId);
  await emitInboxUpdate(deps, conversationId);
}

/** → CLOSED (+closed_at), SYSTEM message, status broadcast, then drain the queue. */
export async function closeConversation(deps: AppDeps, conversationId: string): Promise<void> {
  const conv = await deps.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [
    conversationId,
  ]);
  if (!conv || conv.status === 'CLOSED') return;

  await deps.db.run("UPDATE conversations SET status = 'CLOSED', closed_at = ? WHERE id = ?", [
    nowIso(),
    conversationId,
  ]);
  await postMessage(deps, {
    conversationId,
    senderType: 'SYSTEM',
    kind: 'SYSTEM',
    body: 'Conversation closed',
  });
  await emitConversationStatus(deps, conversationId);
  // Freed capacity may pick up waiting chats.
  await drainQueue(deps, conv.website_id);
  // Email the transcript to the visitor (no-op without SMTP config).
  void sendTranscriptEmail(deps, conversationId);
}

/**
 * Reassign to `toUserId`: history TRANSFER, kick previous assignee's sockets out
 * of the conversation room, SYSTEM message, inbox updates to both sides,
 * agent chip refresh on the widget, then drain freed capacity.
 */
export async function transferConversation(
  deps: AppDeps,
  conversationId: string,
  fromUserId: string | null,
  toUserId: string,
): Promise<void> {
  const conv = await deps.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [
    conversationId,
  ]);
  if (!conv) throw new Error('Conversation not found');
  const toUser = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [toUserId]);
  if (!toUser) throw new Error('Target agent not found');

  await recordAssignment(deps, conversationId, fromUserId, toUserId, 'TRANSFER');
  await deps.db.run('UPDATE conversations SET assigned_user_id = ? WHERE id = ?', [
    toUserId,
    conversationId,
  ]);

  // Force the previous assignee's sockets out of the conversation room.
  if (fromUserId && fromUserId !== toUserId) {
    deps.io.of(AGENT_NAMESPACE).in(`user:${fromUserId}`).socketsLeave(convRoom(conversationId));
  }

  await postMessage(deps, {
    conversationId,
    senderType: 'SYSTEM',
    kind: 'SYSTEM',
    body: `Transferred to ${toUser.name}`,
  });

  // postMessage already notified the new assignee + website watchers; make sure
  // the previous assignee's inbox reflects the hand-off too.
  if (fromUserId && fromUserId !== toUserId) {
    const conversation = await loadSummary(deps, conversationId);
    if (conversation) {
      deps.io.of(AGENT_NAMESPACE).to(`user:${fromUserId}`).emit(EV.InboxUpdate, { conversation });
    }
  }

  await emitConversationStatus(deps, conversationId);
  await emitConversationAgent(deps, conversationId);
  await drainQueue(deps, conv.website_id);
}

/**
 * Assign every WAITING unassigned conversation (oldest first) to an eligible
 * CSR (history reason AUTO) and refresh inboxes. Runs for one website when
 * given, otherwise across all websites.
 */
export async function drainQueue(deps: AppDeps, websiteId?: string): Promise<void> {
  const waiting = websiteId
    ? await deps.db.all<ConversationRow>(
        "SELECT * FROM conversations WHERE status = 'WAITING' AND assigned_user_id IS NULL AND website_id = ? ORDER BY created_at ASC",
        [websiteId],
      )
    : await deps.db.all<ConversationRow>(
        "SELECT * FROM conversations WHERE status = 'WAITING' AND assigned_user_id IS NULL ORDER BY created_at ASC",
      );

  for (const conv of waiting) {
    const csrId = await findEligibleCsr(deps, conv.website_id);
    if (!csrId) continue;
    await deps.db.run('UPDATE conversations SET assigned_user_id = ? WHERE id = ?', [
      csrId,
      conv.id,
    ]);
    await recordAssignment(deps, conv.id, null, csrId, 'AUTO');
    await emitInboxUpdate(deps, conv.id);
  }
}

// ─── Access control ──────────────────────────────────────────

/**
 * ADMIN sees everything; MANAGER sees everything too (view-only — mutations
 * are blocked by role guards upstream); everyone else must be a member of
 * the website's team.
 */
export async function userCanAccessWebsite(
  deps: AppDeps,
  userId: string,
  role: Role,
  websiteId: string,
): Promise<boolean> {
  if (role === 'ADMIN' || role === 'MANAGER') return true;
  const website = await deps.db.get<WebsiteRow>('SELECT * FROM websites WHERE id = ?', [websiteId]);
  if (!website) return false;
  const member = await deps.db.get<{ id: string }>(
    'SELECT id FROM team_members WHERE team_id = ? AND user_id = ?',
    [website.team_id, userId],
  );
  return !!member;
}
