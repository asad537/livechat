import { Router } from 'express';
import { WIDGET_NAMESPACE, EV } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { requireAgent, requireRole } from '../../core/auth.js';
import { newId, nowIso } from '../../core/db.js';
import { sanitizeAllowedIps } from '../../core/ip.js';
import { clientIp } from '../../features/geo/index.js';
import { HttpError, asString, h } from '../helpers.js';

/** Boot any currently-connected widget visitors that a (just-added) rule now
    blocks — otherwise a block would only ever apply to future connections and
    already-online visitors would linger until they left on their own. */
async function kickBlockedVisitors(deps: AppDeps): Promise<void> {
  const ns = deps.io.of(WIDGET_NAMESPACE);
  const hasCountry = deps.blocklist.hasCountryBlocks();
  for (const socket of ns.sockets.values()) {
    const ip = clientIp(socket);
    let blocked = deps.blocklist.isIpBlocked(ip);
    if (!blocked && hasCountry) {
      const vid = (socket.data as { visitorId?: string }).visitorId;
      if (vid) {
        const row = await deps.db.get<{ geo_cc: string | null }>(
          'SELECT geo_cc FROM visitors WHERE id = ?',
          [vid],
        );
        blocked = deps.blocklist.isCountryBlocked(row?.geo_cc ?? null);
      }
    }
    if (blocked) {
      socket.emit(EV.AppError, { message: 'Access blocked' });
      socket.disconnect(true);
    }
  }
}

interface BlockRow {
  id: string;
  type: string;
  value: string;
  note: string | null;
  created_at: string;
}

const toPublic = (r: BlockRow) => ({
  id: r.id,
  type: r.type as 'IP' | 'COUNTRY',
  value: r.value,
  note: r.note,
  createdAt: r.created_at,
});

export function buildBlocklistRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  // GET /api/blocklist — all rules (ADMIN only)
  router.get(
    '/api/blocklist',
    auth,
    requireRole('ADMIN'),
    h(async (_req, res) => {
      const rows = await deps.db.all<BlockRow>(
        'SELECT id, type, value, note, created_at FROM blocklist ORDER BY type, created_at DESC',
      );
      res.json({ rules: rows.map(toPublic) });
    }),
  );

  // POST /api/blocklist — add a rule { type, value, note? } (ADMIN only)
  router.post(
    '/api/blocklist',
    auth,
    requireRole('ADMIN'),
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const type = asString(body.type)?.toUpperCase();
      const note = asString(body.note)?.slice(0, 255) || null;

      if (type !== 'IP' && type !== 'COUNTRY') {
        throw new HttpError(400, "type must be 'IP' or 'COUNTRY'");
      }

      // Normalize + validate the value per type.
      let values: string[];
      if (type === 'IP') {
        // Reuse the IP/CIDR validator; it accepts a comma-separated list, so one
        // POST may add several IPs at once.
        const clean = sanitizeAllowedIps(asString(body.value) ?? '');
        if (!clean) throw new HttpError(400, 'Enter a valid IP address or CIDR range');
        values = clean.split(',').map((s) => s.trim()).filter(Boolean);
      } else {
        const raw = (asString(body.value) ?? '').trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(raw)) {
          throw new HttpError(400, 'Country must be a 2-letter ISO code (e.g. PK, US)');
        }
        values = [raw];
      }

      const created: ReturnType<typeof toPublic>[] = [];
      for (const value of values) {
        // Skip duplicates silently (idempotent add).
        const existing = await deps.db.get<{ id: string }>(
          'SELECT id FROM blocklist WHERE type = ? AND value = ?',
          [type, value],
        );
        if (existing) continue;
        const id = newId();
        await deps.db.run(
          'INSERT INTO blocklist (id, type, value, note, created_at) VALUES (?, ?, ?, ?, ?)',
          [id, type, value, note, nowIso()],
        );
        created.push({ id, type, value, note, createdAt: nowIso() });
      }
      await deps.blocklist.reload();
      // Enforce the new rule on visitors who are already connected right now.
      await kickBlockedVisitors(deps).catch((err) =>
        console.warn('[blocklist] kick after add failed:', (err as Error).message),
      );
      res.json({ added: created });
    }),
  );

  // DELETE /api/blocklist/:id — remove a rule (ADMIN only)
  router.delete(
    '/api/blocklist/:id',
    auth,
    requireRole('ADMIN'),
    h(async (req, res) => {
      await deps.db.run('DELETE FROM blocklist WHERE id = ?', [req.params.id as string]);
      await deps.blocklist.reload();
      res.json({ ok: true });
    }),
  );

  return router;
}
