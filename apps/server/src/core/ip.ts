// ─────────────────────────────────────────────────────────────
// Per-user IP allow-listing. A user row may carry `allowed_ips`
// (comma-separated). Empty/null = no restriction. Entries can be:
//   • an exact IPv4/IPv6 address (192.168.1.10 / 2001:db8::1)
//   • an IPv4 CIDR range (203.0.113.0/24)
// The client IP is taken from X-Forwarded-For (first hop) so it works
// behind nginx/Cloudflare; set the proxy to forward it.
// ─────────────────────────────────────────────────────────────
import type { Request } from 'express';

/** Normalize an IP: strip the IPv4-mapped IPv6 prefix, trim, lowercase. */
export function normalizeIp(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/^::ffff:/i, '').trim().toLowerCase();
}

/** Client IP from an Express request (proxy-aware). */
export function reqIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  const raw = first || req.socket?.remoteAddress || '';
  return normalizeIp(raw);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/** Does `ip` fall inside a single allow-list entry (exact or CIDR)? */
function matchesEntry(entry: string, ip: string): boolean {
  const e = normalizeIp(entry);
  if (!e) return false;
  if (e.includes('/')) {
    const [range, bitsRaw] = e.split('/');
    const bits = Number(bitsRaw);
    const ipN = ipv4ToInt(ip);
    const rangeN = ipv4ToInt(range);
    if (ipN == null || rangeN == null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      return false;
    }
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    return (ipN & mask) === (rangeN & mask);
  }
  return e === ip;
}

/**
 * Is this client IP allowed for a user with the given `allowed_ips` string?
 * No restriction (empty list) → always true.
 */
export function ipAllowed(allowedIps: string | null | undefined, clientIp: string): boolean {
  const list = (allowedIps ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return true; // unrestricted
  const ip = normalizeIp(clientIp);
  if (!ip) return false; // restricted user but no resolvable IP → deny
  return list.some((entry) => matchesEntry(entry, ip));
}

/** Validate + normalize an admin-supplied allow-list; throws on a bad entry. */
export function sanitizeAllowedIps(input: unknown): string | null {
  if (input == null || input === '') return null;
  if (typeof input !== 'string') throw new Error('allowedIps must be text');
  const entries = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return null;
  const ipRe = /^[0-9a-f:.]+$/i;
  for (const e of entries) {
    const base = e.includes('/') ? e.split('/')[0] : e;
    if (!ipRe.test(base) || base.length > 45) {
      throw new Error(`Invalid IP or range: ${e}`);
    }
    if (e.includes('/')) {
      const bits = Number(e.split('/')[1]);
      if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
        throw new Error(`Invalid CIDR range: ${e}`);
      }
    }
  }
  return entries.join(', ').slice(0, 1000);
}
