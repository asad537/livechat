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
}

export interface WebsiteRow {
  id: string;
  name: string;
  widget_key: string;
  domains: string | null;
  team_id: string;
  logo_url: string | null;
  primary_color: string;
  greeting: string;
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
  };
}

export function toBranding(row: WebsiteRow): WebsiteBranding {
  return {
    id: row.id,
    name: row.name,
    logoUrl: row.logo_url,
    primaryColor: row.primary_color,
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
  const conv = await deps.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [
    conversationId,
  ]);
  if (!conv) return undefined;

  const [visitorRow, websiteRow, assignedRow, lastMessageRow, unreadRow] = await Promise.all([
    deps.db.get<VisitorRow>('SELECT * FROM visitors WHERE id = ?', [conv.visitor_id]),
    deps.db.get<WebsiteRow>('SELECT * FROM websites WHERE id = ?', [conv.website_id]),
    conv.assigned_user_id
      ? deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [conv.assigned_user_id])
      : Promise.resolve(undefined),
    deps.db.get<MessageRow>(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1',
      [conversationId],
    ),
    deps.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_type = 'VISITOR' AND read_at IS NULL",
      [conversationId],
    ),
  ]);

  const lastMessage = lastMessageRow ? (await hydrateMessages(deps, [lastMessageRow]))[0] : null;

  return {
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
      ? toVisitor(visitorRow, deps.presence.isVisitorOnline(conv.visitor_id))
      : undefined,
    website: websiteRow ? toBranding(websiteRow) : undefined,
    assignedUser: assignedRow ? toUserPublic(assignedRow) : null,
    lastMessage,
    unreadCount: Number(unreadRow?.n ?? 0),
  };
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
  let agent: { name: string; avatarColor: string } | null = null;
  if (conv.assigned_user_id) {
    const user = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [
      conv.assigned_user_id,
    ]);
    if (user) agent = { name: user.name, avatarColor: user.avatar_color };
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
  if (!deps.presence.isAgentOnline(user.id)) return false;
  return (await countActiveChats(deps, user.id)) < Number(user.max_chats);
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

  const candidates = members
    .filter(
      (m) =>
        m.id !== excludeUserId &&
        deps.presence.isAgentOnline(m.id) &&
        Number(m.active) < Number(m.max_chats),
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

/** ADMIN sees everything; everyone else must be a member of the website's team. */
export async function userCanAccessWebsite(
  deps: AppDeps,
  userId: string,
  role: Role,
  websiteId: string,
): Promise<boolean> {
  if (role === 'ADMIN') return true;
  const website = await deps.db.get<WebsiteRow>('SELECT * FROM websites WHERE id = ?', [websiteId]);
  if (!website) return false;
  const member = await deps.db.get<{ id: string }>(
    'SELECT id FROM team_members WHERE team_id = ? AND user_id = ?',
    [website.team_id, userId],
  );
  return !!member;
}
