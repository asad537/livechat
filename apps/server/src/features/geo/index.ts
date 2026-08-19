// ─── Visitor IP capture + geo lookup ─────────────────────────
// IP comes from the socket handshake (X-Forwarded-For behind the
// Caddy/nginx proxy, else the raw address). Location comes from the
// free ip-api.com endpoint — fire-and-forget, cached on the visitor
// row so each IP is looked up once.
import type { Socket } from 'socket.io';
import { WIDGET_NAMESPACE, EV } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { requestVisitorRefresh } from '../../domain/conversations.js';

/** Real client IP for a socket (proxy-aware). */
export function clientIp(socket: Socket): string | null {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  const raw = first || socket.handshake.address || '';
  const ip = raw.replace(/^::ffff:/i, '').trim();
  return ip.length > 0 ? ip.slice(0, 64) : null;
}

/** Real client IP for an HTTP request (proxy-aware) — mirrors `clientIp`. */
export function httpClientIp(req: {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null };
}): string | null {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  const raw = first || req.socket?.remoteAddress || '';
  const ip = raw.replace(/^::ffff:/i, '').trim();
  return ip.length > 0 ? ip.slice(0, 64) : null;
}

export function isPrivateIp(ip: string): boolean {
  return (
    ip === '::1' ||
    ip === 'localhost' ||
    /^127\.|^10\.|^192\.168\.|^169\.254\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^f[cd][0-9a-f]{2}:/i.test(ip)
  );
}

/**
 * Blocking country lookup for a public IP (ISO-3166 alpha-2, uppercased).
 * Returns null for private IPs, failures or timeouts. Used by the blocklist so
 * a brand-new visitor (no cached geo yet) can still be geo-blocked on connect.
 */
export async function lookupCountry(ip: string): Promise<string | null> {
  if (isPrivateIp(ip)) return null;
  const cached = ipGeoCache.get(ip);
  if (cached) return cached.cc?.toUpperCase() ?? null;
  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { status?: string; countryCode?: string };
    if (data.status !== 'success') return null;
    return (data.countryCode ?? '').slice(0, 4).toUpperCase() || null;
  } catch {
    return null;
  }
}

const inFlight = new Set<string>();

// ip-api.com's free tier allows ~45 lookups/minute — cache per IP so repeat
// visitors (and multi-tab loads) never spend a lookup, and retry a couple of
// times when the API throttles so the flag still lands moments later.
interface GeoResult {
  country: string | null;
  city: string | null;
  cc: string | null;
}
const ipGeoCache = new Map<string, GeoResult>();
const IP_CACHE_MAX = 5000;

async function fetchGeo(ip: string): Promise<GeoResult | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const res = await fetch(
        `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) continue; // throttled (429) or transient — retry
      const data = (await res.json()) as {
        status?: string;
        country?: string;
        countryCode?: string;
        city?: string;
      };
      if (data.status !== 'success') return null; // invalid IP — retrying won't help
      return {
        country: (data.country ?? '').slice(0, 64) || null,
        city: (data.city ?? '').slice(0, 64) || null,
        cc: (data.countryCode ?? '').slice(0, 4) || null,
      };
    } catch {
      /* timeout/network — retry */
    }
  }
  return null;
}

/** Store the visitor's IP; look up country/city when new (fire-and-forget). */
export function updateVisitorGeo(deps: AppDeps, visitorId: string, ip: string | null): void {
  if (!ip) return;
  void (async () => {
    try {
      const row = await deps.db.get<{
        ip: string | null;
        geo_country: string | null;
        website_id: string;
      }>('SELECT ip, geo_country, website_id FROM visitors WHERE id = ?', [visitorId]);
      if (!row) return;

      if (row.ip !== ip) {
        await deps.db.run('UPDATE visitors SET ip = ? WHERE id = ?', [ip, visitorId]);
      }
      // Already located for this IP, private range, or lookup in progress → done.
      if ((row.ip === ip && row.geo_country) || isPrivateIp(ip) || inFlight.has(visitorId)) return;

      inFlight.add(visitorId);
      try {
        // Same IP seen before? No API call at all — instant flag.
        let geo = ipGeoCache.get(ip) ?? null;
        if (!geo) {
          geo = await fetchGeo(ip);
          if (geo) {
            if (ipGeoCache.size >= IP_CACHE_MAX) {
              const first = ipGeoCache.keys().next().value;
              if (first) ipGeoCache.delete(first);
            }
            ipGeoCache.set(ip, geo);
          }
        }
        if (!geo) return;
        await deps.db.run(
          'UPDATE visitors SET geo_country = ?, geo_city = ?, geo_cc = ? WHERE id = ?',
          [geo.country, geo.city, geo.cc, visitorId],
        );
        // Country just resolved — push the visitor list again so the agent sees
        // the flag right away instead of a globe until the next broadcast.
        requestVisitorRefresh(row.website_id);
        // Reliable country-block enforcement: fetchGeo retries on throttle, so
        // this resolves the country even when the fast connect-time lookup
        // couldn't. If it's a blocked country, boot the visitor now.
        if (deps.blocklist.isCountryBlocked(geo.cc)) {
          for (const socket of deps.io.of(WIDGET_NAMESPACE).sockets.values()) {
            if ((socket.data as { visitorId?: string }).visitorId === visitorId) {
              socket.emit(EV.AppError, { message: 'Access blocked' });
              socket.disconnect(true);
            }
          }
        }
      } finally {
        inFlight.delete(visitorId);
      }
    } catch {
      /* geo is best-effort */
    }
  })();
}
