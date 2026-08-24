import { Router } from 'express';
import type { AppDeps } from '../../core/deps.js';
import { requireAgent } from '../../core/auth.js';
import { newId, nowIso } from '../../core/db.js';
import { HttpError, asString, h } from '../helpers.js';

interface ShortcutRow {
  id: string;
  title: string;
  body: string;
  created_at: string;
}

/** Canned response shortcuts — team-wide list; any signed-in agent can add or prune. */
export function buildShortcutsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  router.get(
    '/api/shortcuts',
    auth,
    h(async (_req, res) => {
      const rows = await deps.db.all<ShortcutRow>(
        'SELECT id, title, body, created_at FROM shortcuts ORDER BY title',
      );
      res.json({ shortcuts: rows.map((r) => ({ id: r.id, title: r.title, body: r.body })) });
    }),
  );

  router.post(
    '/api/shortcuts',
    auth,
    h(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const title = asString(b.title)?.trim().slice(0, 80);
      const body = asString(b.body)?.trim().slice(0, 2000);
      if (!title || !body) throw new HttpError(400, 'Title and message are both required');
      const id = newId();
      await deps.db.run(
        'INSERT INTO shortcuts (id, title, body, created_at) VALUES (?, ?, ?, ?)',
        [id, title, body, nowIso()],
      );
      res.json({ shortcut: { id, title, body } });
    }),
  );

  router.delete(
    '/api/shortcuts/:id',
    auth,
    h(async (req, res) => {
      await deps.db.run('DELETE FROM shortcuts WHERE id = ?', [req.params.id as string]);
      res.json({ ok: true });
    }),
  );

  return router;
}
