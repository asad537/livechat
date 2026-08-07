import { Router } from 'express';
import { API } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import {
  requireAgent,
  signAgentToken,
  toUserPublic,
  verifyPassword,
  type UserRow,
} from '../../core/auth.js';
import { accessibleWebsiteRows, agent, h, requireString, toWebsite, visibleTeams } from '../helpers.js';

export function buildAuthRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  // POST /api/auth/login — no auth
  router.post(
    API.login,
    h(async (req, res) => {
      const email = requireString(req.body?.email, 'email', 255).toLowerCase();
      const password = requireString(req.body?.password, 'password', 255);
      const user = await deps.db.get<UserRow>('SELECT * FROM users WHERE email = ?', [email]);
      if (!user || !verifyPassword(password, user.password_hash)) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }
      const token = signAgentToken(deps.config, user.id, user.role);
      res.json({ token, user: toUserPublic(user) });
    }),
  );

  // GET /api/me — current agent + scoped websites/teams
  router.get(
    API.me,
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const [websiteRows, teams] = await Promise.all([
        accessibleWebsiteRows(deps, user),
        visibleTeams(deps, user),
      ]);
      res.json({
        user: toUserPublic(user),
        websites: websiteRows.map(toWebsite),
        teams,
      });
    }),
  );

  return router;
}
