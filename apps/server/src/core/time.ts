// Business-day time helpers, shared so the dashboard reports and the Source page
// use the EXACT same day boundary. A support "day" runs noon→noon in Pakistan
// time (12:00 PKT = 07:00 UTC), so overnight shifts aren't split at midnight.
const PKT_OFFSET_MS = 5 * 3600_000;
const DAY_MS = 24 * 3600_000;

/** ISO timestamp of the most-recent 12:00-PKT boundary, shifted back `daysAgo` days. */
export function pktDayStart(daysAgo = 0): string {
  const nowPktWall = Date.now() + PKT_OFFSET_MS; // ms in the PKT wall-clock frame
  const d = new Date(nowPktWall);
  // Anchor to 12:00 on the PKT calendar date (UTC getters read the shifted wall clock).
  let boundaryWall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0);
  if (nowPktWall < boundaryWall) boundaryWall -= DAY_MS; // before noon → yesterday's noon
  boundaryWall -= daysAgo * DAY_MS;
  return new Date(boundaryWall - PKT_OFFSET_MS).toISOString(); // convert back to real UTC
}

/** Lower + optional upper bound for a named range. `until` is set only for a
 *  bounded window (yesterday = the previous noon-PKT business day); open-ended
 *  ranges leave it null so they keep the simple `>= since` behavior. */
export function rangeBounds(range: string): { since: string | null; until: string | null } {
  const now = Date.now();
  if (range === 'today') return { since: pktDayStart(0), until: null }; // noon-PKT → now
  if (range === 'yesterday') return { since: pktDayStart(1), until: pktDayStart(0) }; // prev noon→noon
  if (range === '7d') return { since: new Date(now - 7 * DAY_MS).toISOString(), until: null };
  if (range === '30d') return { since: new Date(now - 30 * DAY_MS).toISOString(), until: null };
  return { since: null, until: null }; // all time
}
