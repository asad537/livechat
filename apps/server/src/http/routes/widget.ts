import express, { Router } from 'express';
import { API, WIDGET_NAMESPACE } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { verifyToken, type VisitorTokenPayload } from '../../core/auth.js';
import { httpClientIp } from '../../features/geo/index.js';
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
      // Admin blocklist — the IP check is synchronous and instant, so tell a
      // blocked visitor up-front and keep this endpoint fast. (Country blocking
      // needs a geo lookup — that stays on the socket path, off this hot call.)
      if (deps.blocklist.isIpBlocked(httpClientIp(req))) {
        res.json({ blocked: true });
        return;
      }
      res.json({ website: toBranding(site) });
    }),
  );

  // POST /api/widget/bye — sendBeacon from the page's pagehide event. Closing
  // a window/browser doesn't always flush the websocket close frame, so the
  // server would only notice at ping-timeout (~30-55s). The beacon force-
  // disconnects the visitor's sockets NOW; a tab that is merely navigating
  // auto-reconnects within the presence grace, so nothing flickers.
  router.post(
    '/api/widget/bye',
    express.text({ type: '*/*', limit: '2kb' }), // beacon sends text/plain (no CORS preflight)
    h(async (req, res) => {
      let token = '';
      try {
        token = String((JSON.parse(String(req.body || '{}')) as { token?: string }).token ?? '');
      } catch {
        /* malformed body */
      }
      const payload = token ? verifyToken<VisitorTokenPayload>(deps.config, token) : null;
      let dropped = 0;
      if (payload?.typ === 'visitor') {
        for (const s of deps.io.of(WIDGET_NAMESPACE).sockets.values()) {
          const d = s.data as { visitorId?: string };
          if (d.visitorId === payload.sub) {
            s.disconnect(true);
            dropped++;
          }
        }
      }
      res.json({ ok: true, tokenOk: payload?.typ === 'visitor', dropped });
    }),
  );

  // Debug: live presence state for a visitor (no PII — booleans only).
  router.get(
    '/api/widget/presence',
    h(async (req, res) => {
      const id = asString(req.query.visitorId) ?? '';
      const inNamespace = [...deps.io.of(WIDGET_NAMESPACE).sockets.values()].filter(
        (s) => (s.data as { visitorId?: string }).visitorId === id,
      ).length;
      res.json({ online: deps.presence.isVisitorOnline(id), sockets: inNamespace });
    }),
  );

  return router;
}
