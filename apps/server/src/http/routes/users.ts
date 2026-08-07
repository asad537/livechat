import { Router } from 'express';
import { API, DEFAULT_MAX_CHATS, type Role } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { hashPassword, requireAgent, requireRole, type UserRow } from '../../core/auth.js';
import { newId, nowIso } from '../../core/db.js';
import { HttpError, h, requireString, toUserWithPresence } from '../helpers.js';

const ROLES: Role[] = ['ADMIN', 'LEAD', 'CSR'];

const AVATAR_COLORS = [
  '#6366f1',
  '#0891b2',
  '#16a34a',
  '#ea580c',
  '#dc2626',
  '#7c3aed',
  '#db2777',
  '#0d9488',
];

function pickAvatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

export function buildUsersRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  // GET /api/users — ADMIN only
  router.get(
    API.users,
    auth,
    requireRole('ADMIN'),
    h(async (_req, res) => {
      const [rows, activeCounts] = await Promise.all([
        deps.db.all<UserRow>('SELECT * FROM users ORDER BY name'),
        deps.db.all<{ uid: string; n: number }>(
          `SELECT assigned_user_id AS uid, COUNT(*) AS n
             FROM conversations
            WHERE status = 'ACTIVE' AND assigned_user_id IS NOT NULL
            GROUP BY assigned_user_id`,
        ),
      ]);
      const active = new Map(activeCounts.map((r) => [r.uid, Number(r.n)]));
      res.json(
        rows.map((row) => ({
          ...toUserWithPresence(deps, row),
          activeChats: active.get(row.id) ?? 0,
        })),
      );
    }),
  );

  // POST /api/users — ADMIN only
  router.post(
    API.users,
    auth,
    requireRole('ADMIN'),
    h(async (req, res) => {
      const email = requireString(req.body?.email, 'email', 255).toLowerCase();
      const name = requireString(req.body?.name, 'name', 255);
      const password = requireString(req.body?.password, 'password', 255);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new HttpError(400, 'Invalid email address');
      }
      if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');

      const role = (req.body?.role ?? 'CSR') as Role;
      if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid role');

      const maxChatsRaw = req.body?.maxChats;
      const maxChats =
        maxChatsRaw === undefined || maxChatsRaw === null ? DEFAULT_MAX_CHATS : Number(maxChatsRaw);
      if (!Number.isInteger(maxChats) || maxChats < 1 || maxChats > 100) {
        throw new HttpError(400, 'maxChats must be an integer between 1 and 100');
      }

      const existing = await deps.db.get<UserRow>('SELECT * FROM users WHERE email = ?', [email]);
      if (existing) throw new HttpError(409, 'A user with this email already exists');

      const id = newId();
      await deps.db.run(
        `INSERT INTO users (id, email, name, password_hash, role, max_chats, avatar_color, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, email, name, hashPassword(password), role, maxChats, pickAvatarColor(id), nowIso()],
      );
      const created = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
      if (!created) throw new HttpError(500, 'Failed to create user');
      res.status(201).json(toUserWithPresence(deps, created));
    }),
  );

  return router;
}
