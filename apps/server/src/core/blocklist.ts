// ─────────────────────────────────────────────────────────────
// Admin blocklist: deny widget access by IP/CIDR or country code.
// Backed by the `blocklist` table, cached in memory (small list,
// checked on every widget connection) and reloaded on any change.
// ─────────────────────────────────────────────────────────────
import type { Db } from './db.js';
import { ipMatchesList, normalizeIp } from './ip.js';

export interface Blocklist {
  /** Reload the in-memory cache from the database. */
  reload(): Promise<void>;
  /** Is this client IP blocked (exact or CIDR match)? */
  isIpBlocked(ip: string | null | undefined): boolean;
  /** Is this ISO-3166 alpha-2 country code blocked? */
  isCountryBlocked(cc: string | null | undefined): boolean;
  /** Are there any country rules at all? (skip the geo lookup if not) */
  hasCountryBlocks(): boolean;
}

export async function createBlocklist(db: Db): Promise<Blocklist> {
  let ips: string[] = [];
  let countries = new Set<string>();

  const store: Blocklist = {
    async reload() {
      const rows = await db.all<{ type: string; value: string }>(
        'SELECT type, value FROM blocklist',
      );
      const nextIps: string[] = [];
      const nextCountries = new Set<string>();
      for (const r of rows) {
        if (r.type === 'IP') nextIps.push(r.value);
        else if (r.type === 'COUNTRY') nextCountries.add(r.value.toUpperCase());
      }
      ips = nextIps;
      countries = nextCountries;
    },
    isIpBlocked(ip) {
      if (!ip || ips.length === 0) return false;
      return ipMatchesList(ips, normalizeIp(ip));
    },
    isCountryBlocked(cc) {
      if (!cc || countries.size === 0) return false;
      return countries.has(cc.toUpperCase());
    },
    hasCountryBlocks() {
      return countries.size > 0;
    },
  };

  await store.reload();
  return store;
}
