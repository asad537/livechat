// ─────────────────────────────────────────────────────────────
// Website knowledge — the AI greeter's source of truth.
//
// Admin hits "Scan website" → we crawl the client's site (same
// host, ~25 pages, depth 2), strip the HTML down to text and store
// it per website. When a visitor asks something, the best-matching
// pages are put in the AI's context so it answers from the site's
// real content (products, pricing, policies) instead of guessing.
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import type { AppDeps } from '../../core/deps.js';
import { newId, nowIso } from '../../core/db.js';
import { requireAgent, requireRole } from '../../core/auth.js';

const MAX_PAGES = 25;
const MAX_DEPTH = 2;
const PAGE_TIMEOUT_MS = 10_000;
const CRAWL_DEADLINE_MS = 90_000;
const MAX_CONTENT_CHARS = 50_000;
const CONCURRENCY = 4;

interface KnowledgeRow {
  id: string;
  url: string;
  title: string | null;
  content: string | null;
}

// ─── HTML → text ─────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? m[1].trim().slice(0, 500) || null : null;
}

function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|pdf|zip|mp4|mp3|woff2?)(\?|$)/i.test(u.pathname))
        continue;
      u.hash = '';
      u.search = '';
      out.push(u.toString());
    } catch {
      /* bad href */
    }
  }
  return out;
}

/** Basic SSRF guard — public http(s) hosts only. */
function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname;
    if (h === 'localhost' || h === '0.0.0.0' || h === '::1') return false;
    if (/^127\.|^10\.|^192\.168\.|^169\.254\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

// ─── Crawler ─────────────────────────────────────────────────

async function fetchPage(url: string): Promise<{ html: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      headers: { 'user-agent': 'LiveChatKnowledgeBot/1.0 (+widget knowledge scan)' },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('text/html')) return null;
    return { html: await res.text() };
  } catch {
    return null;
  }
}

export interface ScanResult {
  pages: number;
  chars: number;
}

/** Crawl `startUrl` (same host only) and replace the website's stored knowledge. */
const bareHost = (h: string): string => h.replace(/^www\./i, '').toLowerCase();

export async function crawlWebsite(
  deps: AppDeps,
  websiteId: string,
  startUrl: string,
): Promise<ScanResult> {
  const start = new URL(startUrl);
  const host = bareHost(start.hostname);
  const deadline = Date.now() + CRAWL_DEADLINE_MS;

  const visited = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: start.toString(), depth: 0 }];
  const results: { url: string; title: string | null; content: string }[] = [];

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < deadline && results.length < MAX_PAGES) {
      const next = queue.shift();
      if (!next) {
        // Queue momentarily empty while other workers fetch — brief wait.
        await new Promise((r) => setTimeout(r, 150));
        if (queue.length === 0) return;
        continue;
      }
      const { url, depth } = next;
      if (visited.has(url)) continue;
      visited.add(url);

      const page = await fetchPage(url);
      if (!page) continue;

      const text = htmlToText(page.html);
      if (text.length > 100) {
        results.push({
          url,
          title: extractTitle(page.html),
          content: text.slice(0, MAX_CONTENT_CHARS),
        });
      }
      if (depth < MAX_DEPTH) {
        for (const link of extractLinks(page.html, url)) {
          try {
            if (bareHost(new URL(link).hostname) === host && !visited.has(link)) {
              queue.push({ url: link, depth: depth + 1 });
            }
          } catch {
            /* skip */
          }
        }
      }
    }
  });
  await Promise.all(workers);

  // Replace stored knowledge atomically enough for our purposes.
  await deps.db.run('DELETE FROM knowledge_pages WHERE website_id = ?', [websiteId]);
  const t = nowIso();
  for (const r of results.slice(0, MAX_PAGES)) {
    await deps.db.run(
      'INSERT INTO knowledge_pages (id, website_id, url, title, content, fetched_at) VALUES (?, ?, ?, ?, ?, ?)',
      [newId(), websiteId, r.url, r.title, r.content, t],
    );
  }

  return {
    pages: results.length,
    chars: results.reduce((s, r) => s + r.content.length, 0),
  };
}

// ─── Retrieval (keyword scoring — dependency-free) ───────────

function scorePage(terms: string[], page: KnowledgeRow): number {
  const hay = `${page.title ?? ''} ${page.content ?? ''}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let count = 0;
    let idx = hay.indexOf(term);
    while (idx !== -1 && count < 5) {
      count++;
      idx = hay.indexOf(term, idx + term.length);
    }
    score += count * (term.length > 5 ? 2 : 1);
  }
  return score;
}

const LIVE_FETCH_TIMEOUT_MS = 4_000;

/**
 * Best-matching site content for a visitor question, ready to drop
 * into the AI system prompt. The index is used to *find* the right
 * pages; the top matches are re-fetched LIVE so prices/products are
 * current at answer time (stored copy is the fallback + gets
 * refreshed opportunistically).
 */
export async function findRelevantKnowledge(
  deps: AppDeps,
  websiteId: string,
  query: string,
  maxChars = 8000,
): Promise<string> {
  const pages = await deps.db.all<KnowledgeRow>(
    'SELECT id, url, title, content FROM knowledge_pages WHERE website_id = ?',
    [websiteId],
  );
  if (pages.length === 0) return '';

  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))];
  const ranked = pages
    .map((p) => ({ p, s: terms.length ? scorePage(terms, p) : 0 }))
    .sort((a, b) => b.s - a.s);

  // Top matches first; fall back to the first pages (home etc.) when no term hits.
  const chosen = (ranked[0].s > 0 ? ranked.filter((r) => r.s > 0) : ranked).slice(0, 2);

  // LIVE re-fetch the chosen pages in parallel (short timeout) so the
  // answer reflects today's content, not the last scan.
  const fresh = await Promise.all(
    chosen.map(async ({ p }) => {
      try {
        const res = await fetch(p.url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
          headers: { 'user-agent': 'LiveChatKnowledgeBot/1.0 (+live answer fetch)' },
        });
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) return null;
        const html = await res.text();
        const text = htmlToText(html).slice(0, MAX_CONTENT_CHARS);
        if (text.length > 100) {
          // Opportunistically refresh the stored copy (fire and forget).
          void deps.db
            .run('UPDATE knowledge_pages SET content = ?, title = ?, fetched_at = ? WHERE id = ?', [
              text,
              extractTitle(html),
              nowIso(),
              p.id,
            ])
            .catch(() => undefined);
          return text;
        }
        return null;
      } catch {
        return null; // fall back to stored copy
      }
    }),
  );

  const parts: string[] = [];
  let used = 0;
  chosen.forEach(({ p }, i) => {
    const budget = maxChars - used;
    if (budget < 500) return;
    const body = fresh[i] ?? p.content ?? '';
    const chunk = body.slice(0, Math.min(3500, budget));
    used += chunk.length;
    parts.push(`## ${p.title ?? p.url}${fresh[i] ? ' (live, just fetched)' : ''}\n(${p.url})\n${chunk}`);
  });
  return parts.join('\n\n');
}

// ─── Auto re-scan (every 24h per website) ────────────────────

const REFRESH_CHECK_MS = 60 * 60 * 1000; // hourly check
const REINDEX_AFTER_MS = 24 * 60 * 60 * 1000; // re-crawl when older than 24h
let refresherStarted = false;

/** Background refresher — re-crawls each indexed website daily so new pages appear. */
export function startKnowledgeRefresher(deps: AppDeps): void {
  if (refresherStarted) return;
  refresherStarted = true;

  const tick = async (): Promise<void> => {
    try {
      const rows = await deps.db.all<{ website_id: string; newest: string; root: string }>(
        `SELECT website_id, MAX(fetched_at) AS newest, MIN(url) AS root
           FROM knowledge_pages GROUP BY website_id`,
      );
      for (const row of rows) {
        if (Date.now() - Date.parse(row.newest) < REINDEX_AFTER_MS) continue;
        // Shortest URL of the index is (almost always) the site root.
        const all = await deps.db.all<{ url: string }>(
          'SELECT url FROM knowledge_pages WHERE website_id = ?',
          [row.website_id],
        );
        const root = all.map((r) => r.url).sort((a, b) => a.length - b.length)[0];
        if (!root || !isSafeUrl(root)) continue;
        console.log(`[knowledge] daily re-scan for website ${row.website_id} (${root})`);
        await crawlWebsite(deps, row.website_id, new URL(root).origin).catch((err) =>
          console.warn('[knowledge] re-scan failed:', (err as Error).message),
        );
      }
    } catch (err) {
      console.warn('[knowledge] refresher error:', (err as Error).message);
    }
  };

  setInterval(() => void tick(), REFRESH_CHECK_MS);
}

// ─── REST: trigger a scan (ADMIN) ────────────────────────────

export function buildKnowledgeRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAgent(deps.db, deps.config);

  // POST /api/websites/:id/scan  { url }
  router.post('/api/websites/:id/scan', auth, requireRole('ADMIN'), (req, res) => {
    void (async () => {
      const websiteId = String(req.params.id);
      const site = await deps.db.get<{ id: string; domains: string | null }>(
        'SELECT id, domains FROM websites WHERE id = ?',
        [websiteId],
      );
      if (!site) {
        res.status(404).json({ error: 'Website not found' });
        return;
      }
      const bodyUrl = typeof (req.body as { url?: unknown })?.url === 'string'
        ? ((req.body as { url: string }).url.trim())
        : '';
      const fallbackDomain = (site.domains ?? '').split(',').map((d) => d.trim()).filter(Boolean)[0];
      const target = bodyUrl || (fallbackDomain ? `https://${fallbackDomain}` : '');
      if (!target || !isSafeUrl(target)) {
        res.status(400).json({ error: 'Provide a valid public website URL to scan' });
        return;
      }
      try {
        const result = await crawlWebsite(deps, websiteId, target);
        res.json({ ok: true, url: target, ...result });
      } catch (err) {
        res.status(500).json({ error: `Scan failed: ${(err as Error).message}` });
      }
    })();
  });

  return router;
}
