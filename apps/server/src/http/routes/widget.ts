import { Router } from 'express';
import { API } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { asString, h, toBranding, type WebsiteRow } from '../helpers.js';

export function buildWidgetRouter(deps: AppDeps): Router {
  const router = Router();

  // GET /api/widget/boot?key= — public branding lookup for the embed script (no auth)
  router.get(
    API.widgetBoot,
    h(async (req, res) => {
      const key = asString(req.query.key)?.trim();
      if (!key) {
        res.status(400).json({ error: 'Missing widget key' });
        return;
      }
      const site = await deps.db.get<WebsiteRow>('SELECT * FROM websites WHERE widget_key = ?', [
        key,
      ]);
      if (!site) {
        res.status(404).json({ error: 'Unknown widget key' });
        return;
      }
      res.json({ website: toBranding(site) });
    }),
  );

  return router;
}
