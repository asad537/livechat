import { Router } from 'express';
import { API, DEFAULT_MAX_CHATS, type Role } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { hashPassword, requireAgent, requireRole, type UserRow } from '../../core/auth.js';
import { newId, nowIso } from '../../core/db.js';
import { sanitizeAllowedIps } from '../../core/ip.js';
import { HttpError, agent, h, requireString, toUserWithPresence } from '../helpers.js';

const ROLES: Role[] = ['ADMIN', 'MANAGER', 'LEAD', 'CSR'];

/** teamLeadId must point at an existing LEAD; only CSRs carry one. */
async function normalizeTeamLead(
  deps: AppDeps,
  role: Role,
  teamLeadId: unknown,
): Promise<string | null> {
  if (role !== 'CSR' || !teamLeadId || typeof teamLeadId !== 'string') return null;
  const lead = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [teamLeadId]);
  if (!lead || lead.role !== 'LEAD') throw new HttpError(400, 'Team lead must be a LEAD user');
  return lead.id;
}

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

  // GET /api/users — ADMIN/MANAGER see everyone; a LEAD sees self + own CSRs.
  router.get(
    API.users,
    auth,
    requireRole('ADMIN', 'MANAGER', 'LEAD'),
    h(async (req, res) => {
      const me = agent(req);
      const [rows, activeCounts] = await Promise.all([
        me.role === 'LEAD'
          ? deps.db.all<UserRow>(
              'SELECT * FROM users WHERE id = ? OR team_lead_id = ? ORDER BY name',
              [me.id, me.id],
            )
          : deps.db.all<UserRow>('SELECT * FROM users ORDER BY name'),
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

  // POST /api/users — ADMIN anyone; MANAGER may add agents (LEAD/CSR only,
  // never another ADMIN/MANAGER — no privilege escalation).
  router.post(
    API.users,
    auth,
    requireRole('ADMIN', 'MANAGER'),
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
      const creator = agent(req);
      if (creator.role === 'MANAGER' && role !== 'LEAD' && role !== 'CSR') {
        throw new HttpError(403, 'Managers can only add team leads and CSRs');
      }

      const maxChatsRaw = req.body?.maxChats;
      const maxChats =
        maxChatsRaw === undefined || maxChatsRaw === null ? DEFAULT_MAX_CHATS : Number(maxChatsRaw);
      if (!Number.isInteger(maxChats) || maxChats < 1 || maxChats > 100) {
        throw new HttpError(400, 'maxChats must be an integer between 1 and 100');
      }

      const existing = await deps.db.get<UserRow>('SELECT * FROM users WHERE email = ?', [email]);
      if (existing) throw new HttpError(409, 'A user with this email already exists');

      const teamLeadId = await normalizeTeamLead(deps, role, req.body?.teamLeadId);
      const allowedIps = sanitizeAllowedIps(req.body?.allowedIps);

      const id = newId();
      await deps.db.run(
        `INSERT INTO users (id, email, name, password_hash, role, max_chats, avatar_color, team_lead_id, allowed_ips, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          email,
          name,
          hashPassword(password),
          role,
          maxChats,
          pickAvatarColor(id),
          teamLeadId,
          allowedIps,
          nowIso(),
        ],
      );
      const created = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
      if (!created) throw new HttpError(500, 'Failed to create user');
      res.status(201).json(toUserWithPresence(deps, created));
    }),
  );

  // PATCH /api/users/:id — ADMIN only: name / role / maxChats / teamLeadId / password
  router.patch(
    `${API.users}/:id`,
    auth,
    requireRole('ADMIN'),
    h(async (req, res) => {
      const row = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [req.params.id]);
      if (!row) throw new HttpError(404, 'User not found');

      const sets: string[] = [];
      const args: unknown[] = [];

      if (req.body?.name !== undefined) {
        sets.push('name = ?');
        args.push(requireString(req.body.name, 'name', 255));
      }

      let role: Role = row.role;
      if (req.body?.role !== undefined) {
        role = req.body.role as Role;
        if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid role');
        sets.push('role = ?');
        args.push(role);
      }

      if (req.body?.maxChats !== undefined) {
        const maxChats = Number(req.body.maxChats);
        if (!Number.isInteger(maxChats) || maxChats < 1 || maxChats > 100) {
          throw new HttpError(400, 'maxChats must be an integer between 1 and 100');
        }
        sets.push('max_chats = ?');
        args.push(maxChats);
      }

      if (req.body?.teamLeadId !== undefined || (req.body?.role !== undefined && role !== 'CSR')) {
        const teamLeadId = await normalizeTeamLead(deps, role, req.body?.teamLeadId);
        if (teamLeadId === row.id) throw new HttpError(400, 'A user cannot be their own team lead');
        sets.push('team_lead_id = ?');
        args.push(teamLeadId);
      }

      if (req.body?.password !== undefined) {
        const password = requireString(req.body.password, 'password', 255);
        if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
        sets.push('password_hash = ?');
        args.push(hashPassword(password));
      }

      if (req.body?.allowedIps !== undefined) {
        sets.push('allowed_ips = ?');
        args.push(sanitizeAllowedIps(req.body.allowedIps));
      }

      if (sets.length === 0) throw new HttpError(400, 'Nothing to update');
      await deps.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...args, row.id]);

      // Demoted from Team Lead → orphan their CSRs so admin can reassign.
      if (row.role === 'LEAD' && role !== 'LEAD') {
        await deps.db.run('UPDATE users SET team_lead_id = NULL WHERE team_lead_id = ?', [row.id]);
      }

      const updated = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [row.id]);
      if (!updated) throw new HttpError(500, 'Failed to update user');
      res.json(toUserWithPresence(deps, updated));
    }),
  );

  // DELETE /api/users/:id — ADMIN only. Chats keep their history (the agent
  // column just goes blank); open chats return to the queue.
  router.delete(
    `${API.users}/:id`,
    auth,
    requireRole('ADMIN'),
    h(async (req, res) => {
      const me = agent(req);
      const row = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [req.params.id]);
      if (!row) throw new HttpError(404, 'User not found');
      if (row.id === me.id) throw new HttpError(400, 'You cannot delete your own account');
      if (row.role === 'ADMIN') {
        const admins = await deps.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN'",
        );
        if (Number(admins?.n ?? 0) <= 1) {
          throw new HttpError(400, 'Cannot delete the last admin');
        }
      }

      // Their open chats go back to the unassigned queue; closed history stays.
      await deps.db.run(
        "UPDATE conversations SET assigned_user_id = NULL WHERE assigned_user_id = ? AND status IN ('WAITING','OFFERED','ACTIVE')",
        [row.id],
      );
      // Orphan their CSRs (if a Team Lead) so admin can reassign.
      await deps.db.run('UPDATE users SET team_lead_id = NULL WHERE team_lead_id = ?', [row.id]);
      await deps.db.run('DELETE FROM team_members WHERE user_id = ?', [row.id]);
      await deps.db.run('DELETE FROM users WHERE id = ?', [row.id]);
      res.json({ ok: true });
    }),
  );

  return router;
}
