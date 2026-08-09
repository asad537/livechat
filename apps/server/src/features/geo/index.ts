// ─── Visitor IP capture + geo lookup ─────────────────────────
// IP comes from the socket handshake (X-Forwarded-For behind the
// Caddy/nginx proxy, else the raw address). Location comes from the
// free ip-api.com endpoint — fire-and-forget, cached on the visitor
// row so each IP is looked up once.
import type { Socket } from 'socket.io';
import type { AppDeps } from '../../core/deps.js';

/** Real client IP for a socket (proxy-aware). */
export function clientIp(socket: Socket): string | null {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  const raw = first || socket.handshake.address || '';
  const ip = raw.replace(/^::ffff:/i, '').trim();
  return ip.length > 0 ? ip.slice(0, 64) : null;
}

function isPrivateIp(ip: string): boolean {
  return (
    ip === '::1' ||
    ip === 'localhost' ||
    /^127\.|^10\.|^192\.168\.|^169\.254\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^f[cd][0-9a-f]{2}:/i.test(ip)
  );
}

const inFlight = new Set<string>();

/** Store the visitor's IP; look up country/city when new (fire-and-forget). */
export function updateVisitorGeo(deps: AppDeps, visitorId: string, ip: string | null): void {
  if (!ip) return;
  void (async () => {
    try {
      const row = await deps.db.get<{ ip: string | null; geo_country: string | null }>(
        'SELECT ip, geo_country FROM visitors WHERE id = ?',
        [visitorId],
      );
      if (!row) return;

      if (row.ip !== ip) {
        await deps.db.run('UPDATE visitors SET ip = ? WHERE id = ?', [ip, visitorId]);
      }
      // Already located for this IP, private range, or lookup in progress → done.
      if ((row.ip === ip && row.geo_country) || isPrivateIp(ip) || inFlight.has(visitorId)) return;

      inFlight.add(visitorId);
      try {
        const res = await fetch(
          `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,city`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { status?: string; country?: string; city?: string };
        if (data.status !== 'success') return;
        await deps.db.run('UPDATE visitors SET geo_country = ?, geo_city = ? WHERE id = ?', [
          (data.country ?? '').slice(0, 64) || null,
          (data.city ?? '').slice(0, 64) || null,
          visitorId,
        ]);
      } finally {
        inFlight.delete(visitorId);
      }
    } catch {
      /* geo is best-effort */
    }
  })();
}
