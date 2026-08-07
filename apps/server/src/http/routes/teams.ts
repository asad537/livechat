import { Router } from 'express';
import { API } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { requireAgent, requireRole, type UserRow } from '../../core/auth.js';
import { newId, nowIso } from '../../core/db.js';
import {
  HttpError,
  agent,
  h,
  requireString,
  toTeam,
  visibleTeams,
  type TeamMemberRow,
  type TeamRow,
} from '../helpers.js';

export function buildTeamsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  // GET /api/teams — ADMIN: all teams, LEAD: own teams
  router.get(
    API.teams,
    auth,
    requireRole('ADMIN', 'LEAD'),
    h(async (req, res) => {
      const user = agent(req);
      res.json(await visibleTeams(deps, user));
    }),
  );

  // POST /api/teams — ADMIN
  router.post(
    API.teams,
    auth,
    requireRole('ADMIN'),
    h(async (req, res) => {
      const name = requireString(req.body?.name, 'name', 255);
      const id = newId();
      await deps.db.run('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)', [
        id,
        name,
        nowIso(),
      ]);
      const created = await deps.db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [id]);
      if (!created) throw new HttpError(500, 'Failed to create team');
      res.status(201).json({ ...toTeam(created), members: [] });
    }),
  );

  // POST /api/teams/:id/members {userId, isLead} — ADMIN
  router.post(
    `${API.teams}/:id/members`,
    auth,
    requireRole('ADMIN'),
    h(async (req, res) => {
      const teamId = req.params.id as string;
      const userId = requireString(req.body?.userId, 'userId', 64);
      const isLead = req.body?.isLead === true || req.body?.isLead === 1 ? 1 : 0;

      const team = await deps.db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [teamId]);
      if (!team) throw new HttpError(404, 'Team not found');
      const user = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [userId]);
      if (!user) throw new HttpError(404, 'User not found');

      const existing = await deps.db.get<TeamMemberRow>(
        'SELECT * FROM team_members WHERE team_id = ? AND user_id = ?',
        [teamId, userId],
      );
      if (existing) {
        await deps.db.run('UPDATE team_members SET is_lead = ? WHERE id = ?', [
          isLead,
          existing.id,
        ]);
      } else {
        await deps.db.run(
          'INSERT INTO team_members (id, team_id, user_id, is_lead) VALUES (?, ?, ?, ?)',
          [newId(), teamId, userId, isLead],
        );
      }
      res.status(existing ? 200 : 201).json({ teamId, userId, isLead: isLead === 1 });
    }),
  );

  // DELETE /api/teams/:id/members/:userId — ADMIN
  router.delete(
    `${API.teams}/:id/members/:userId`,
    auth,
    requireRole('ADMIN'),
    h(async (req, res) => {
      const teamId = req.params.id as string;
      const userId = req.params.userId as string;
      const existing = await deps.db.get<TeamMemberRow>(
        'SELECT * FROM team_members WHERE team_id = ? AND user_id = ?',
        [teamId, userId],
      );
      if (!existing) throw new HttpError(404, 'Membership not found');
      await deps.db.run('DELETE FROM team_members WHERE id = ?', [existing.id]);
      res.json({ ok: true });
    }),
  );

  return router;
}
