import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { API } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import {
  hashPassword,
  requireAgent,
  signAgentToken,
  toUserPublic,
  verifyPassword,
  type UserRow,
} from '../../core/auth.js';
import { ipAllowed, reqIp } from '../../core/ip.js';
import {
  HttpError,
  accessibleWebsiteRows,
  agent,
  asString,
  h,
  myCsrIds,
  requireString,
  toWebsite,
  visibleTeams,
} from '../helpers.js';

const AVATAR_MIMES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

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
      // Per-user IP allow-list: block sign-in from a network not on the list.
      if (!ipAllowed(user.allowed_ips, reqIp(req))) {
        res.status(403).json({
          error: 'Your account can only be used from an approved network. Contact your admin.',
        });
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
      const [websiteRows, teams, csrIds] = await Promise.all([
        accessibleWebsiteRows(deps, user),
        visibleTeams(deps, user),
        user.role === 'LEAD' ? myCsrIds(deps, user.id) : Promise.resolve([]),
      ]);
      res.json({
        user: toUserPublic(user),
        websites: websiteRows.map(toWebsite),
        teams,
        csrIds,
      });
    }),
  );

  // PATCH /api/me — own profile: name, avatar color, password
  router.patch(
    API.me,
    auth,
    h(async (req, res) => {
      const user = agent(req);
      const body = (req.body ?? {}) as Record<string, unknown>;

      const sets: string[] = [];
      const params: unknown[] = [];

      const name = asString(body.name)?.trim();
      if (name !== undefined) {
        if (name.length < 2 || name.length > 255) throw new HttpError(400, 'Name must be 2–255 characters');
        sets.push('name = ?');
        params.push(name);
      }
      const avatarColor = asString(body.avatarColor)?.trim();
      if (avatarColor !== undefined) {
        if (!/^#[0-9a-fA-F]{6}$/.test(avatarColor)) throw new HttpError(400, 'Invalid color');
        sets.push('avatar_color = ?');
        params.push(avatarColor);
      }
      const newPassword = asString(body.newPassword);
      if (newPassword !== undefined) {
        const current = asString(body.currentPassword) ?? '';
        if (!verifyPassword(current, user.password_hash)) {
          throw new HttpError(403, 'Current password is incorrect');
        }
        if (newPassword.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
        sets.push('password_hash = ?');
        params.push(hashPassword(newPassword));
      }

      if (sets.length > 0) {
        params.push(user.id);
        await deps.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
      }
      const updated = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [user.id]);
      if (!updated) throw new HttpError(404, 'User not found');
      res.json({ user: toUserPublic(updated) });
    }),
  );

  // POST /api/me/avatar — profile picture upload (≤2MB image)
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
  });
  router.post(
    `${API.me}/avatar`,
    auth,
    avatarUpload.single('file'),
    h(async (req, res) => {
      const user = agent(req);
      const file = (req as unknown as { file?: { buffer: Buffer; mimetype: string } }).file;
      if (!file) throw new HttpError(400, 'No image uploaded');
      const ext = AVATAR_MIMES[file.mimetype];
      if (!ext) throw new HttpError(400, 'Use a PNG, JPG, WebP or GIF image');

      const dir = path.join(deps.config.storageDir, 'avatars');
      fs.mkdirSync(dir, { recursive: true });
      // One file per user; drop older extensions.
      for (const e of Object.values(AVATAR_MIMES)) {
        const old = path.join(dir, `${user.id}.${e}`);
        if (e !== ext && fs.existsSync(old)) fs.unlinkSync(old);
      }
      await fs.promises.writeFile(path.join(dir, `${user.id}.${ext}`), file.buffer);

      const url = `/api/users/${user.id}/avatar?v=${Date.now()}`;
      await deps.db.run('UPDATE users SET avatar_url = ? WHERE id = ?', [url, user.id]);
      const updated = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [user.id]);
      if (!updated) throw new HttpError(404, 'User not found');
      res.json({ user: toUserPublic(updated) });
    }),
  );

  // DELETE /api/me/avatar — back to initials
  router.delete(
    `${API.me}/avatar`,
    auth,
    h(async (req, res) => {
      const user = agent(req);
      await deps.db.run('UPDATE users SET avatar_url = NULL WHERE id = ?', [user.id]);
      const updated = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [user.id]);
      if (!updated) throw new HttpError(404, 'User not found');
      res.json({ user: toUserPublic(updated) });
    }),
  );

  // GET /api/users/:id/avatar — serve the picture (public; <img> friendly)
  router.get(
    '/api/users/:id/avatar',
    h(async (req, res) => {
      const id = (req.params.id as string).replace(/[^0-9a-fA-F-]/g, '');
      const dir = path.join(deps.config.storageDir, 'avatars');
      for (const [mime, ext] of Object.entries(AVATAR_MIMES)) {
        const p = path.join(dir, `${id}.${ext}`);
        if (fs.existsSync(p)) {
          res.setHeader('Content-Type', mime);
          res.setHeader('Cache-Control', 'public, max-age=300');
          fs.createReadStream(p).pipe(res);
          return;
        }
      }
      res.status(404).end();
    }),
  );

  return router;
}
