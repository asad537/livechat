/** Small shared formatting helpers for the dashboard UI. */

export function classNames(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const words = name.trim().split(/\s+/);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? words[words.length - 1]?.[0] ?? '' : '';
  return (first + last).toUpperCase() || '?';
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return 'Today';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Compact "time ago / clock" label for list rows. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return formatTime(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest > 0 ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ─── Visitor module helpers ──────────────────────────────────

/** ISO-2 country code → flag emoji (e.g. "PK" → 🇵🇰). */
export function flagEmoji(cc: string | null | undefined): string {
  if (!cc || !/^[a-z]{2}$/i.test(cc)) return '🌐';
  const base = 0x1f1e6 - 65;
  const up = cc.toUpperCase();
  return String.fromCodePoint(base + up.charCodeAt(0), base + up.charCodeAt(1));
}

/** Lightweight user-agent sniff — enough for browser/OS/device chips. */
export function uaParse(ua: string | null | undefined): {
  browser: string;
  os: string;
  device: 'Mobile' | 'Desktop';
} {
  const s = ua ?? '';
  let browser = 'Unknown';
  if (/edg\//i.test(s)) browser = 'Edge';
  else if (/opr\/|opera/i.test(s)) browser = 'Opera';
  else if (/samsungbrowser/i.test(s)) browser = 'Samsung Internet';
  else if (/firefox\//i.test(s)) browser = 'Firefox';
  else if (/chrome\/|crios\//i.test(s)) browser = 'Chrome';
  else if (/safari\//i.test(s)) browser = 'Safari';
  let os = 'Unknown';
  if (/windows nt/i.test(s)) os = 'Windows';
  else if (/iphone|ipad|ipod/i.test(s)) os = 'iOS';
  else if (/android/i.test(s)) os = 'Android';
  else if (/mac os x|macintosh/i.test(s)) os = 'macOS';
  else if (/linux/i.test(s)) os = 'Linux';
  const device: 'Mobile' | 'Desktop' = /mobi|iphone|ipod|android.*mobile/i.test(s)
    ? 'Mobile'
    : 'Desktop';
  return { browser, os, device };
}

/** Live "time on site" label from a session start timestamp (ticks per render). */
export function durationSince(iso: string | null | undefined): string {
  if (!iso) return '—';
  const start = Date.parse(iso);
  if (Number.isNaN(start)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Compact page label: pathname (or host for the root page). */
export function pageLabel(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.host : decodeURIComponent(u.pathname);
  } catch {
    return url;
  }
}

/** Referrer host, or a friendly source name for known engines. */
export function referrerLabel(url: string | null | undefined): string {
  if (!url) return 'Direct';
  try {
    const host = new URL(url).host.replace(/^www\./, '');
    if (/google\./i.test(host)) return 'Google';
    if (/bing\./i.test(host)) return 'Bing';
    if (/facebook\.|fb\./i.test(host)) return 'Facebook';
    if (/instagram\./i.test(host)) return 'Instagram';
    if (/t\.co$|twitter\.|x\.com$/i.test(host)) return 'X (Twitter)';
    if (/linkedin\./i.test(host)) return 'LinkedIn';
    if (/youtube\./i.test(host)) return 'YouTube';
    return host;
  } catch {
    return 'Direct';
  }
}

let tempCounter = 0;
export function newTempId(): string {
  tempCounter += 1;
  return `tmp_${Date.now().toString(36)}_${tempCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Clickable links in message text ─────────────────────────
import React from 'react';

const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,!?;:]/g;

/** Render plain text with URLs as clickable links (safe — no innerHTML). */
export function linkify(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push(
      React.createElement(
        'a',
        { key: idx, className: 'msg-link', href: m[0], target: '_blank', rel: 'noopener noreferrer' },
        m[0],
      ),
    );
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// ─── Colorful visitor avatars (deterministic per id) ─────────
const AVATAR_GRADIENTS: [string, string][] = [
  ['#34d399', '#0ea5e9'],
  ['#38bdf8', '#2563eb'],
  ['#fbbf24', '#f97316'],
  ['#a78bfa', '#7c3aed'],
  ['#f472b6', '#db2777'],
  ['#f87171', '#e11d48'],
  ['#2dd4bf', '#0d9488'],
  ['#818cf8', '#4f46e5'],
];

export function avatarGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const [a, b] = AVATAR_GRADIENTS[Math.abs(h) % AVATAR_GRADIENTS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

/** Human label for a role — LEAD reads as "Team Lead" everywhere in the UI. */
export function roleLabel(role: string): string {
  if (role === 'LEAD') return 'TEAM LEAD';
  return role;
}

/** Short name agents see in the website chip — the label if set, else the name. */
export function siteLabel(w: { label?: string | null; name?: string | null } | null | undefined): string {
  return (w?.label?.trim() || w?.name || '') as string;
}

