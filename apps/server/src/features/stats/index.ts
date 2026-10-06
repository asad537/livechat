/**
 * Chat statistics aggregates — the source of truth for the dashboard overview.
 *
 * A CLOSED conversation never changes again (only a late CSAT rating can
 * arrive), so its numbers are folded ONCE into `chat_stats_hourly` and never
 * rescanned. A request then reads the pre-summed buckets and only computes the
 * small live remainder (open chats + chats closed since the last aggregation
 * run) from the raw tables. Both paths run through the SAME reducer below, so
 * aggregated and live numbers cannot drift apart.
 *
 * Buckets are UTC HOURS, not days: the dashboard's "day" starts at 12:00 PKT,
 * its 7/30-day ranges are rolling (now − N×24h), and it charts chats by hour —
 * hourly buckets reproduce all of those exactly; a daily table could not.
 *
 * Three kinds of row (dimensions: bucket hour, website, assigned agent):
 *   S — chats bucketed by the hour they STARTED   (started / answered / FRT …)
 *   C — chats bucketed by the hour they CLOSED    (closed / duration / ratings)
 *   K — "CSR clicks": one row per agent who sent a message in the chat,
 *       bucketed by the hour the chat started (extra dimension: sender)
 *
 * NOT aggregated here on purpose: visitors, returning visitors, countries and
 * topics are unique/"top-N" counts — daily or hourly totals of them cannot be
 * added up without double counting, so the overview still counts those directly.
 */
import type { AppDeps } from '../../core/deps.js';

/** Bump when the reducer's meaning changes — forces a full rebuild on boot. */
const STATS_VERSION = '1';
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
/** The business day starts at 12:00 PKT = 07:00 UTC (same boundary as the dashboard). */
const BIZ_DAY_START_UTC_MS = 7 * HOUR_MS;
/** Chats closed in the last moments stay "live" so an in-flight close is never half-counted. */
const WATERMARK_LAG_MS = 30_000;
/** Each run re-checks a little before the previous watermark (idempotent). */
const WATERMARK_SLACK_MS = 5 * 60_000;
const RUN_EVERY_MS = 2 * 60_000;

export type StatKind = 'S' | 'C' | 'K';

/** Additive measures. Durations are summed in whole milliseconds (exact). */
export interface Measures {
  n: number; // S: engaged chats started · C: engaged chats closed · K: chats the sender messaged in
  csr_n: number; // S: chats (engaged or not) that have an agent message
  answered: number; // S: engaged chats with activated_at
  closed: number; // S: engaged chats whose status is CLOSED
  open_n: number; // S: engaged chats still open (live part only)
  missed: number; // S: engaged chats with status MISSED (retired status; live part only)
  transferred: number; // S: engaged CLOSED chats that were transferred
  frt_ms: number; // first response time (created → activated)
  frt_n: number;
  dur_ms: number; // chat duration (activated → closed), CLOSED chats
  dur_n: number;
  rating_sum: number; // C
  rating_n: number;
  r1: number;
  r2: number;
  r3: number;
  r4: number;
  r5: number;
  // S: engaged CLOSED chats started AND activated in one business day but closed
  // in a later one. A bounded one-business-day window ("yesterday") counts these
  // as handled by the agent even though they closed outside the window.
  extra_n: number;
  extra_frt_ms: number;
  extra_frt_n: number;
}

const MEASURE_KEYS = [
  'n',
  'csr_n',
  'answered',
  'closed',
  'open_n',
  'missed',
  'transferred',
  'frt_ms',
  'frt_n',
  'dur_ms',
  'dur_n',
  'rating_sum',
  'rating_n',
  'r1',
  'r2',
  'r3',
  'r4',
  'r5',
  'extra_n',
  'extra_frt_ms',
  'extra_frt_n',
] as const satisfies readonly (keyof Measures)[];

export function emptyMeasures(): Measures {
  return {
    n: 0,
    csr_n: 0,
    answered: 0,
    closed: 0,
    open_n: 0,
    missed: 0,
    transferred: 0,
    frt_ms: 0,
    frt_n: 0,
    dur_ms: 0,
    dur_n: 0,
    rating_sum: 0,
    rating_n: 0,
    r1: 0,
    r2: 0,
    r3: 0,
    r4: 0,
    r5: 0,
    extra_n: 0,
    extra_frt_ms: 0,
    extra_frt_n: 0,
  };
}

export function addMeasures(into: Measures, from: Partial<Measures>): void {
  for (const k of MEASURE_KEYS) into[k] += Number(from[k] ?? 0);
}

/** Everything the reducer needs to know about one conversation. */
export interface ConvFact {
  id: string;
  website_id: string;
  status: string;
  assigned_user_id: string | null;
  created_at: string;
  activated_at: string | null;
  closed_at: string | null;
  rating: number | null;
  engaged: boolean; // the CLIENT sent at least one message
  agentMsg: boolean; // an agent sent at least one message
  transferred: boolean;
  senders: string[]; // distinct agents who sent a message
}

interface Cell extends Measures {
  kind: StatKind;
  bucket: string;
  website_id: string;
  agent_id: string;
  sender_id: string;
}

// ─── Time helpers ────────────────────────────────────────────

/** 'YYYY-MM-DDTHH' — the UTC hour an ISO timestamp falls in. */
export const hourKey = (iso: string): string => iso.slice(0, 13);
/** ISO start of an hour bucket. */
export const bucketIso = (bucket: string): string => `${bucket}:00:00.000Z`;
const floorHourMs = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;
const ceilHourMs = (ms: number): number => Math.ceil(ms / HOUR_MS) * HOUR_MS;
const bizDay = (iso: string): number => Math.floor((Date.parse(iso) - BIZ_DAY_START_UTC_MS) / DAY_MS);

/** Whole milliseconds between two ISO timestamps when non-negative, else null. */
function msBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

// ─── The reducer (shared by the aggregator and the live path) ─

const OPEN_STATUSES = new Set(['ACTIVE', 'WAITING', 'OFFERED']);

/** What a conversation contributes to the hour it STARTED in. */
export function startedMeasures(f: ConvFact): Measures {
  const m = emptyMeasures();
  if (f.agentMsg) m.csr_n = 1;
  if (!f.engaged) return m;
  m.n = 1;
  if (f.status === 'CLOSED') m.closed = 1;
  else if (f.status === 'MISSED') m.missed = 1;
  else if (OPEN_STATUSES.has(f.status)) m.open_n = 1;
  if (f.activated_at != null) m.answered = 1;
  const frt = msBetween(f.created_at, f.activated_at);
  if (frt != null) {
    m.frt_ms = frt;
    m.frt_n = 1;
  }
  if (f.status === 'CLOSED') {
    if (f.transferred) m.transferred = 1;
    const dur = msBetween(f.activated_at, f.closed_at);
    if (dur != null) {
      m.dur_ms = dur;
      m.dur_n = 1;
    }
    if (
      f.activated_at != null &&
      f.closed_at != null &&
      bizDay(f.activated_at) === bizDay(f.created_at) &&
      bizDay(f.closed_at) > bizDay(f.created_at)
    ) {
      m.extra_n = 1;
      if (frt != null) {
        m.extra_frt_ms = frt;
        m.extra_frt_n = 1;
      }
    }
  }
  return m;
}

/** What an engaged CLOSED conversation contributes to the hour it CLOSED in (else null). */
export function closedMeasures(f: ConvFact): Measures | null {
  if (f.status !== 'CLOSED' || !f.engaged || !f.closed_at) return null;
  const m = emptyMeasures();
  m.n = 1;
  const rating = f.rating == null ? null : Number(f.rating);
  if (rating != null) {
    m.rating_sum = rating;
    m.rating_n = 1;
    if (rating >= 1 && rating <= 5) m[`r${rating}` as 'r1'] = 1;
  }
  const dur = msBetween(f.activated_at, f.closed_at);
  if (dur != null) {
    m.dur_ms = dur;
    m.dur_n = 1;
  }
  const frt = msBetween(f.created_at, f.activated_at);
  if (frt != null) {
    m.frt_ms = frt;
    m.frt_n = 1;
  }
  return m;
}

// ─── Loading conversation facts from the raw tables ──────────

/**
 * Load facts for conversations matching `where` (written against alias `c`).
 */
export async function loadFacts(deps: AppDeps, where: string, params: unknown[]): Promise<ConvFact[]> {
  const [rows, senderRows] = await Promise.all([
    deps.db.all<{
      id: string;
      website_id: string;
      status: string;
      assigned_user_id: string | null;
      created_at: string;
      activated_at: string | null;
      closed_at: string | null;
      rating: number | null;
      engaged: unknown;
      agent_msg: unknown;
      transferred: unknown;
    }>(
      `SELECT c.id, c.website_id, c.status, c.assigned_user_id, c.created_at, c.activated_at, c.closed_at, c.rating,
              (SELECT COUNT(*) FROM messages em WHERE em.conversation_id = c.id AND em.sender_type = 'VISITOR') AS engaged,
              (SELECT COUNT(*) FROM messages am WHERE am.conversation_id = c.id AND am.sender_type = 'AGENT') AS agent_msg,
              (SELECT COUNT(*) FROM assignment_history h WHERE h.conversation_id = c.id AND h.reason = 'TRANSFER') AS transferred
         FROM conversations c WHERE ${where}`,
      params,
    ),
    deps.db.all<{ cid: string; uid: string }>(
      `SELECT DISTINCT m.conversation_id AS cid, m.sender_user_id AS uid
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.sender_type = 'AGENT' AND m.sender_user_id IS NOT NULL AND (${where})`,
      params,
    ),
  ]);
  const senders = new Map<string, string[]>();
  for (const s of senderRows) {
    const list = senders.get(s.cid);
    if (list) list.push(s.uid);
    else senders.set(s.cid, [s.uid]);
  }
  return rows.map((r) => ({
    id: r.id,
    website_id: r.website_id,
    status: r.status,
    assigned_user_id: r.assigned_user_id,
    created_at: r.created_at,
    activated_at: r.activated_at,
    closed_at: r.closed_at,
    rating: r.rating == null ? null : Number(r.rating),
    engaged: Number(r.engaged) > 0,
    agentMsg: Number(r.agent_msg) > 0,
    transferred: Number(r.transferred) > 0,
    senders: senders.get(r.id) ?? [],
  }));
}

// ─── Aggregator (writes chat_stats_hourly) ───────────────────

const COLUMNS = ['kind', 'bucket', 'website_id', 'agent_id', 'sender_id', ...MEASURE_KEYS] as const;

async function writeCells(deps: AppDeps, cells: Cell[]): Promise<void> {
  // Upsert only — a closed chat is never "un-closed", so cells never disappear
  // and readers never see a half-written bucket (no delete-then-insert gap).
  const row = `(${COLUMNS.map(() => '?').join(', ')})`;
  const head =
    deps.db.dialect === 'mysql'
      ? 'REPLACE INTO'
      : deps.db.dialect === 'sqlite'
        ? 'INSERT OR REPLACE INTO'
        : 'INSERT INTO';
  const tail =
    deps.db.dialect === 'postgres'
      ? ` ON CONFLICT (kind, bucket, website_id, agent_id, sender_id) DO UPDATE SET ${MEASURE_KEYS.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}`
      : '';
  const CHUNK = 200;
  for (let i = 0; i < cells.length; i += CHUNK) {
    const part = cells.slice(i, i + CHUNK);
    await deps.db.run(
      `${head} chat_stats_hourly (${COLUMNS.join(', ')}) VALUES ${part.map(() => row).join(', ')}${tail}`,
      part.flatMap((c) => COLUMNS.map((k) => c[k])),
    );
  }
}

function cellInto(map: Map<string, Cell>, kind: StatKind, bucket: string, f: ConvFact, sender: string, m: Measures): void {
  const agent = f.assigned_user_id ?? '';
  const key = `${kind}|${bucket}|${f.website_id}|${agent}|${sender}`;
  let cell = map.get(key);
  if (!cell) {
    cell = { kind, bucket, website_id: f.website_id, agent_id: agent, sender_id: sender, ...emptyMeasures() };
    map.set(key, cell);
  }
  addMeasures(cell, m);
}

/**
 * (Re)build the buckets for conversations whose `column` timestamp falls in
 * [fromIso, toIso). Only chats CLOSED before `watermark` are aggregated.
 * `created_at` rebuilds the S + K rows, `closed_at` the C rows.
 */
async function aggregateRange(
  deps: AppDeps,
  column: 'created_at' | 'closed_at',
  fromIso: string,
  toIso: string,
  watermark: string,
): Promise<void> {
  const facts = await loadFacts(
    deps,
    `c.status = 'CLOSED' AND c.closed_at < ? AND c.${column} >= ? AND c.${column} < ?`,
    [watermark, fromIso, toIso],
  );
  const cells = new Map<string, Cell>();
  for (const f of facts) {
    if (column === 'created_at') {
      const bucket = hourKey(f.created_at);
      cellInto(cells, 'S', bucket, f, '', startedMeasures(f));
      for (const sender of f.senders) cellInto(cells, 'K', bucket, f, sender, { ...emptyMeasures(), n: 1 });
    } else {
      const m = closedMeasures(f);
      if (m && f.closed_at) cellInto(cells, 'C', hourKey(f.closed_at), f, '', m);
    }
  }
  await writeCells(deps, [...cells.values()]);
}

async function getMeta(deps: AppDeps, key: string): Promise<string | null> {
  const row = await deps.db.get<{ v: string }>('SELECT v FROM chat_stats_meta WHERE k = ?', [key]);
  return row?.v ?? null;
}

async function setMeta(deps: AppDeps, key: string, value: string | null): Promise<void> {
  await deps.db.run('DELETE FROM chat_stats_meta WHERE k = ?', [key]);
  if (value != null) await deps.db.run('INSERT INTO chat_stats_meta (k, v) VALUES (?, ?)', [key, value]);
}

/**
 * Chats closed BEFORE this instant are fully in chat_stats_hourly; everything
 * else (open, or closed since) must be read live. null = aggregates not built
 * yet, so the caller computes everything live (still correct, just slower).
 */
export async function statsWatermark(deps: AppDeps): Promise<string | null> {
  if ((await getMeta(deps, 'version')) !== STATS_VERSION) return null;
  return getMeta(deps, 'watermark');
}

/** One-time backfill of all history (also runs after a STATS_VERSION bump). */
async function rebuildAll(deps: AppDeps): Promise<void> {
  const started = Date.now();
  await setMeta(deps, 'watermark', null); // readers go fully live while we rebuild
  await deps.db.run('DELETE FROM chat_stats_hourly');
  const watermark = new Date(Date.now() - WATERMARK_LAG_MS).toISOString();
  const first = await deps.db.get<{ t: string | null }>('SELECT MIN(created_at) AS t FROM conversations');
  if (first?.t) {
    const end = Date.parse(watermark);
    for (let from = floorHourMs(Date.parse(first.t)); from < end; from += 7 * DAY_MS) {
      const fromIso = new Date(from).toISOString();
      const toIso = new Date(from + 7 * DAY_MS).toISOString();
      await aggregateRange(deps, 'created_at', fromIso, toIso, watermark);
      await aggregateRange(deps, 'closed_at', fromIso, toIso, watermark);
    }
  }
  await setMeta(deps, 'version', STATS_VERSION);
  await setMeta(deps, 'watermark', watermark);
  console.log(`[stats] rebuilt chat_stats_hourly in ${Date.now() - started}ms`);
}

/** Fold chats closed since the last run into their buckets, then advance the watermark. */
async function runIncremental(deps: AppDeps, previous: string): Promise<void> {
  const watermark = new Date(Date.now() - WATERMARK_LAG_MS).toISOString();
  if (watermark <= previous) return;
  const since = new Date(Date.parse(previous) - WATERMARK_SLACK_MS).toISOString();
  const closedRows = await deps.db.all<{ created_at: string; closed_at: string }>(
    "SELECT created_at, closed_at FROM conversations WHERE status = 'CLOSED' AND closed_at >= ? AND closed_at < ?",
    [since, watermark],
  );
  const createdHours = new Set(closedRows.map((r) => hourKey(r.created_at)));
  const closedHours = new Set(closedRows.map((r) => hourKey(r.closed_at)));
  const nextHour = (bucket: string) => new Date(Date.parse(bucketIso(bucket)) + HOUR_MS).toISOString();
  for (const b of createdHours) await aggregateRange(deps, 'created_at', bucketIso(b), nextHour(b), watermark);
  for (const b of closedHours) await aggregateRange(deps, 'closed_at', bucketIso(b), nextHour(b), watermark);
  await setMeta(deps, 'watermark', watermark);
}

let running = false;

/** Bring the aggregates up to date (full rebuild the first time). Never throws. */
export async function refreshStats(deps: AppDeps): Promise<void> {
  if (running) return;
  running = true;
  try {
    const watermark = await statsWatermark(deps);
    if (watermark) await runIncremental(deps, watermark);
    else await rebuildAll(deps);
  } catch (err) {
    console.error('[stats] aggregation run failed', err);
  } finally {
    running = false;
  }
}

/** Start the background aggregator: once at boot, then every couple of minutes. */
export function startStatsAggregator(deps: AppDeps): void {
  void refreshStats(deps);
  const t = setInterval(() => void refreshStats(deps), RUN_EVERY_MS);
  t.unref?.();
}

/**
 * A closed chat's only late change is its CSAT rating — rebuild the bucket it
 * closed in so the rating shows up without waiting for anything else.
 */
export async function refreshStatsForConversation(deps: AppDeps, conversationId: string): Promise<void> {
  try {
    const watermark = await statsWatermark(deps);
    if (!watermark) return;
    const conv = await deps.db.get<{ status: string; closed_at: string | null }>(
      'SELECT status, closed_at FROM conversations WHERE id = ?',
      [conversationId],
    );
    if (!conv || conv.status !== 'CLOSED' || !conv.closed_at || conv.closed_at >= watermark) return;
    const from = bucketIso(hourKey(conv.closed_at));
    await aggregateRange(deps, 'closed_at', from, new Date(Date.parse(from) + HOUR_MS).toISOString(), watermark);
  } catch (err) {
    console.error('[stats] conversation refresh failed', err);
  }
}

/** A website (and all its chats) was deleted — drop its aggregate rows too. */
export async function dropStatsForWebsite(deps: AppDeps, websiteId: string): Promise<void> {
  await deps.db.run('DELETE FROM chat_stats_hourly WHERE website_id = ?', [websiteId]);
}

// ─── Reading: aggregates + live remainder for a request ──────

export interface StatsWindow {
  since: string | null; // inclusive
  until: string | null; // exclusive
}

export interface StatsScope {
  siteIds: string[];
  /** Assigned agents in view; null = everyone (ADMIN/MANAGER). */
  agentIds: string[] | null;
  /** With agentIds: also include unassigned chats (Team Lead view). */
  includeUnassigned: boolean;
}

/** Sums for one window, split the ways the overview needs them. */
export interface WindowStats {
  /** S measures per started hour bucket (all sites/agents in scope merged). */
  startedByHour: Map<string, Measures>;
  /** S / C measures per "website|agent". */
  startedByDim: Map<string, Measures>;
  closedByDim: Map<string, Measures>;
  /** CSR clicks per sender agent. */
  clicksBySender: Map<string, number>;
}

function emptyWindowStats(): WindowStats {
  return { startedByHour: new Map(), startedByDim: new Map(), closedByDim: new Map(), clicksBySender: new Map() };
}

function bump(map: Map<string, Measures>, key: string, m: Partial<Measures>): void {
  let cur = map.get(key);
  if (!cur) {
    cur = emptyMeasures();
    map.set(key, cur);
  }
  addMeasures(cur, m);
}

const inWindow = (iso: string | null, w: StatsWindow): boolean =>
  iso != null && (!w.since || iso >= w.since) && (!w.until || iso < w.until);

/** The whole-hour buckets that lie entirely inside a window: [from, to) hour keys. */
function fullBuckets(w: StatsWindow): { from: string | null; to: string | null } {
  return {
    from: w.since ? hourKey(new Date(ceilHourMs(Date.parse(w.since))).toISOString()) : null,
    to: w.until ? hourKey(new Date(floorHourMs(Date.parse(w.until))).toISOString()) : null,
  };
}

export interface OverviewStats {
  windows: WindowStats[];
  /** Open (not CLOSED) engaged-or-not conversations in scope — for live-only rules. */
  openFacts: ConvFact[];
}

/**
 * Stats for several windows at once (same scope): pre-summed buckets for the
 * whole hours of closed history + a live pass over the remainder.
 *
 * `detail[i]` = true also fills the per-dimension maps and CSR clicks for
 * window i (the main range); false fills only `startedByHour` (trend, yesterday).
 */
export async function loadOverviewStats(
  deps: AppDeps,
  scope: StatsScope,
  windows: StatsWindow[],
  detail: boolean[],
): Promise<OverviewStats> {
  const ph = (n: number) => Array.from({ length: n }, () => '?').join(', ');
  // Scope filters for the aggregate table and for conversations (alias c).
  let aggScope = `website_id IN (${ph(scope.siteIds.length)})`;
  let convScope = `c.website_id IN (${ph(scope.siteIds.length)})`;
  const scopeParams: unknown[] = [...scope.siteIds];
  if (scope.agentIds) {
    const un = scope.includeUnassigned;
    aggScope += ` AND (agent_id IN (${ph(scope.agentIds.length)})${un ? " OR agent_id = ''" : ''})`;
    convScope += ` AND (c.assigned_user_id IN (${ph(scope.agentIds.length)})${un ? ' OR c.assigned_user_id IS NULL' : ''})`;
    scopeParams.push(...scope.agentIds);
  }

  // Read the watermark, then the buckets, then the watermark again: if an
  // aggregation run landed in between, the two would not line up — retry once.
  for (let attempt = 0; ; attempt++) {
    const watermark = await statsWatermark(deps);
    const out = windows.map(() => emptyWindowStats());
    const ranges = windows.map(fullBuckets);

    if (watermark) {
      await Promise.all(
        windows.map(async (_w, i) => {
          const r = ranges[i];
          const bucketSql = `${r.from ? ' AND bucket >= ?' : ''}${r.to ? ' AND bucket < ?' : ''}`;
          const bucketParams = [...(r.from ? [r.from] : []), ...(r.to ? [r.to] : [])];
          const sums = MEASURE_KEYS.map((k) => `SUM(${k}) AS ${k}`).join(', ');
          const [byHour, byDim] = await Promise.all([
            deps.db.all<Measures & { bucket: string }>(
              `SELECT bucket, ${sums} FROM chat_stats_hourly
                WHERE kind = 'S' AND ${aggScope}${bucketSql} GROUP BY bucket`,
              [...scopeParams, ...bucketParams],
            ),
            detail[i]
              ? deps.db.all<Measures & { kind: StatKind; website_id: string; agent_id: string; sender_id: string }>(
                  `SELECT kind, website_id, agent_id, sender_id, ${sums} FROM chat_stats_hourly
                    WHERE ${aggScope}${bucketSql} GROUP BY kind, website_id, agent_id, sender_id`,
                  [...scopeParams, ...bucketParams],
                )
              : Promise.resolve([]),
          ]);
          for (const row of byHour) bump(out[i].startedByHour, row.bucket, row);
          for (const row of byDim) {
            const dim = `${row.website_id}|${row.agent_id}`;
            if (row.kind === 'S') bump(out[i].startedByDim, dim, row);
            else if (row.kind === 'C') bump(out[i].closedByDim, dim, row);
            else out[i].clicksBySender.set(row.sender_id, (out[i].clicksBySender.get(row.sender_id) ?? 0) + Number(row.n));
          }
        }),
      );
    }

    // Live remainder: open chats, chats closed since the watermark, and the
    // partial hours at a window's edges (a rolling 7/30-day range starts mid-hour).
    const liveParts: string[] = [];
    const liveParams: unknown[] = [];
    if (!watermark) {
      // Nothing aggregated yet → every chat that can touch any window is live.
      const sinces = windows.map((w) => w.since);
      if (sinces.every((x): x is string => x != null)) {
        const min = sinces.reduce((a, b) => (a < b ? a : b));
        liveParts.push('c.created_at >= ? OR c.closed_at >= ?');
        liveParams.push(min, min);
      } else {
        liveParts.push('1 = 1');
      }
    } else {
      liveParts.push("c.status <> 'CLOSED' OR c.closed_at >= ?");
      liveParams.push(watermark);
      windows.forEach((w, i) => {
        const edges: [string, string][] = [];
        if (w.since) edges.push([w.since, new Date(ceilHourMs(Date.parse(w.since))).toISOString()]);
        if (w.until) edges.push([new Date(floorHourMs(Date.parse(w.until))).toISOString(), w.until]);
        for (const [a, b] of edges) {
          if (a >= b) continue; // boundary already on the hour
          liveParts.push('(c.created_at >= ? AND c.created_at < ?)');
          liveParams.push(a, b);
          if (detail[i]) {
            liveParts.push('(c.closed_at >= ? AND c.closed_at < ?)');
            liveParams.push(a, b);
          }
        }
      });
    }
    const facts = await loadFacts(deps, `${convScope} AND (${liveParts.join(' OR ')})`, [
      ...scopeParams,
      ...liveParams,
    ]);

    if (watermark && (await statsWatermark(deps)) !== watermark && attempt < 2) continue;

    // Is this conversation's contribution (bucketed at `iso`) already in the
    // aggregate rows we summed for window i?
    const covered = (f: ConvFact, iso: string, i: number): boolean => {
      if (!watermark || f.status !== 'CLOSED' || !f.closed_at || f.closed_at >= watermark) return false;
      const b = hourKey(iso);
      const r = ranges[i];
      return (!r.from || b >= r.from) && (!r.to || b < r.to);
    };

    for (const f of facts) {
      const dim = `${f.website_id}|${f.assigned_user_id ?? ''}`;
      windows.forEach((w, i) => {
        if (inWindow(f.created_at, w) && !covered(f, f.created_at, i)) {
          const m = startedMeasures(f);
          bump(out[i].startedByHour, hourKey(f.created_at), m);
          if (detail[i]) {
            bump(out[i].startedByDim, dim, m);
            for (const s of f.senders) out[i].clicksBySender.set(s, (out[i].clicksBySender.get(s) ?? 0) + 1);
          }
        }
        if (detail[i] && f.closed_at && inWindow(f.closed_at, w) && !covered(f, f.closed_at, i)) {
          const m = closedMeasures(f);
          if (m) bump(out[i].closedByDim, dim, m);
        }
      });
    }

    return { windows: out, openFacts: facts.filter((f) => f.status !== 'CLOSED') };
  }
}
