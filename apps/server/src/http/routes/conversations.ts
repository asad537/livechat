import { Router } from 'express';
import {
  API,
  type AssignmentRecord,
  type ConversationStatus,
  type ConversationSummary,
} from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { requireAgent, toUserPublic, type UserRow } from '../../core/auth.js';
import { loadSummary, userCanAccessWebsite } from '../../domain/conversations.js';
import { hydrateMessages, type MessageRow } from '../../domain/messages.js';
import {
  HttpError,
  accessibleWebsiteRows,
  agent,
  asString,
  canViewConversation,
  getConversationRow,
  h,
  placeholders,
} from '../helpers.js';

const STATUSES: ConversationStatus[] = ['WAITING', 'OFFERED', 'ACTIVE', 'CLOSED', 'MISSED'];

type Scope = 'mine' | 'team' | 'all';

/** Clamp the requested scope to what the role allows (CSR→mine, LEAD≤team, ADMIN any). */
function effectiveScope(role: UserRow['role'], requested: string | undefined): Scope {
  if (role === 'CSR') return 'mine';
  if (role === 'LEAD') return requested === 'mine' ? 'mine' : 'team';
  if (requested === 'mine' || requested === 'team') return requested;
  return 'all';
}

interface AssignmentHistoryRow {
  id: string;
  conversation_id: string;
  from_user_id: string | null;
  to_user_id: string;
  reason: string;
  created_at: string;
}

export function buildConversationsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  // GET /api/conversations?websiteId=&status=&scope=mine|team|all
  router.get(
    API.conversations,
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const scope = effectiveScope(user.role, asString(req.query.scope));

      const websiteId = asString(req.query.websiteId);
      if (websiteId && !(await userCanAccessWebsite(deps, user.id, user.role, websiteId))) {
        throw new HttpError(403, 'Forbidden');
      }
      const status = asString(req.query.status);
      if (status && !STATUSES.includes(status as ConversationStatus)) {
        throw new HttpError(400, 'Invalid status');
      }

      const where: string[] = [];
      const params: unknown[] = [];

      if (scope !== 'all') {
        const siteIds = (await accessibleWebsiteRows(deps, user)).map((w) => w.id);
        if (scope === 'mine') {
          if (user.role === 'CSR') {
            // Mine + the unassigned queue of my sites.
            if (siteIds.length > 0) {
              where.push(
                `(c.assigned_user_id = ? OR (c.assigned_user_id IS NULL
                   AND c.status IN ('WAITING', 'OFFERED')
                   AND c.website_id IN (${placeholders(siteIds.length)})))`,
              );
              params.push(user.id, ...siteIds);
            } else {
              where.push('c.assigned_user_id = ?');
              params.push(user.id);
            }
          } else {
            where.push('c.assigned_user_id = ?');
            params.push(user.id);
          }
        } else {
          // team scope (LEAD, or ADMIN narrowing to team-style view)
          if (user.role === 'ADMIN') {
            // ADMIN has no team; team scope degrades to all.
          } else if (siteIds.length === 0) {
            res.json([]);
            return;
          } else {
            where.push(`c.website_id IN (${placeholders(siteIds.length)})`);
            params.push(...siteIds);
          }
        }
      }

      if (websiteId) {
        where.push('c.website_id = ?');
        params.push(websiteId);
      }
      if (status) {
        where.push('c.status = ?');
        params.push(status);
      }

      const sql = `SELECT c.id FROM conversations c
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.created_at DESC
        LIMIT 200`;
      const rows = await deps.db.all<{ id: string }>(sql, params);

      const summaries: ConversationSummary[] = [];
      for (const row of rows) {
        const summary = await loadSummary(deps, row.id);
        if (summary) summaries.push(summary);
      }
      res.json(summaries);
    }),
  );

  // GET /api/conversations/:id/messages — hydrated ChatMessage[]
  router.get(
    `${API.conversations}/:id/messages`,
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const conv = await getConversationRow(deps, req.params.id as string);
      if (!(await canViewConversation(deps, user, conv))) throw new HttpError(403, 'Forbidden');
      const rows = await deps.db.all<MessageRow>(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
        [conv.id],
      );
      res.json(await hydrateMessages(deps, rows));
    }),
  );

  // GET /api/conversations/:id/history — AssignmentRecord[] with user names
  router.get(
    `${API.conversations}/:id/history`,
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const conv = await getConversationRow(deps, req.params.id as string);
      if (!(await canViewConversation(deps, user, conv))) throw new HttpError(403, 'Forbidden');

      const rows = await deps.db.all<AssignmentHistoryRow>(
        'SELECT * FROM assignment_history WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
        [conv.id],
      );

      const userIds = [
        ...new Set(
          rows.flatMap((r) => [r.from_user_id, r.to_user_id]).filter((v): v is string => !!v),
        ),
      ];
      const users =
        userIds.length > 0
          ? await deps.db.all<UserRow>(
              `SELECT * FROM users WHERE id IN (${placeholders(userIds.length)})`,
              userIds,
            )
          : [];
      const byId = new Map(users.map((u) => [u.id, toUserPublic(u)]));

      const records: AssignmentRecord[] = rows.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        fromUserId: r.from_user_id ?? null,
        toUserId: r.to_user_id,
        reason: r.reason as AssignmentRecord['reason'],
        createdAt: r.created_at,
        fromUser: r.from_user_id ? (byId.get(r.from_user_id) ?? null) : null,
        toUser: byId.get(r.to_user_id) ?? null,
      }));
      res.json(records);
    }),
  );

  return router;
}
