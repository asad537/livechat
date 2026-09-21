import type { Config } from './config.js';

/**
 * Tiny read-through cache for expensive, mostly-static read endpoints (e.g. the
 * reports/overview KPIs). It ONLY stores computed query RESULTS for a few
 * seconds — it never touches writes, so it can never lose or corrupt data. On a
 * miss it recomputes from the database; entries expire on their own.
 *
 * Backend is chosen at boot:
 *   • REDIS_URL set + `ioredis` installed → shared Redis cache (multi-node safe)
 *   • otherwise                           → in-process memory cache (single node)
 * Both satisfy the same interface, so callers don't care which one is active.
 */
export interface Cache {
  /** Return the cached value for `key`, else run `fn`, store it for `ttlMs`, and return it. */
  wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
  /** Fetch a cached value (or undefined) — for handlers too large to wrap in a closure. */
  get<T>(key: string): Promise<T | undefined>;
  /** Store a value under `key` for `ttlMs`. */
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  /** Drop entries whose key starts with `prefix` (everything when omitted). */
  invalidate(prefix?: string): Promise<void>;
  /** Which backend is active — for the boot log. */
  readonly kind: 'redis' | 'memory';
}

function createMemoryCache(): Cache {
  const store = new Map<string, { expires: number; value: unknown }>();
  // Collapse concurrent misses for the same key into a single computation so a
  // burst of dashboard loads doesn't fire the heavy query several times at once.
  const inflight = new Map<string, Promise<unknown>>();

  // Bound memory: endpoints with many filter combinations (search terms, dates,
  // pages) would otherwise pile up keys forever. On write, once past the cap we
  // drop expired entries first, then the oldest ones (Map preserves insertion
  // order), keeping the cache small without any background timer.
  const MAX_ENTRIES = 500;
  const put = (key: string, value: unknown, ttlMs: number): void => {
    store.set(key, { expires: Date.now() + ttlMs, value });
    if (store.size <= MAX_ENTRIES) return;
    const now = Date.now();
    for (const [k, v] of store) if (v.expires <= now) store.delete(k);
    for (const k of store.keys()) {
      if (store.size <= MAX_ENTRIES) break;
      store.delete(k);
    }
  };

  return {
    kind: 'memory',
    async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
      const hit = store.get(key);
      if (hit && hit.expires > Date.now()) return hit.value as T;
      const running = inflight.get(key);
      if (running) return running as Promise<T>;
      const p = (async () => {
        const value = await fn();
        put(key, value, ttlMs);
        return value;
      })();
      inflight.set(
        key,
        p.finally(() => inflight.delete(key)),
      );
      return p;
    },
    async get<T>(key: string): Promise<T | undefined> {
      const hit = store.get(key);
      if (hit && hit.expires > Date.now()) return hit.value as T;
      return undefined;
    },
    async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
      put(key, value, ttlMs);
    },
    async invalidate(prefix?: string): Promise<void> {
      if (!prefix) {
        store.clear();
        return;
      }
      for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
    },
  };
}

interface MinimalRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
  scan(cursor: string, ...args: string[]): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<unknown>;
}

function createRedisCache(redis: MinimalRedis): Cache {
  const PREFIX = 'cache:';
  return {
    kind: 'redis',
    async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
      const rk = PREFIX + key;
      // A cache must never take the endpoint down: any Redis hiccup falls back
      // to computing straight from the database.
      try {
        const cached = await redis.get(rk);
        if (cached != null) return JSON.parse(cached) as T;
      } catch {
        /* fall through to compute */
      }
      const value = await fn();
      try {
        await redis.set(rk, JSON.stringify(value), 'PX', ttlMs);
      } catch {
        /* best effort — value is still returned */
      }
      return value;
    },
    async get<T>(key: string): Promise<T | undefined> {
      try {
        const cached = await redis.get(PREFIX + key);
        if (cached != null) return JSON.parse(cached) as T;
      } catch {
        /* treat as miss */
      }
      return undefined;
    },
    async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
      try {
        await redis.set(PREFIX + key, JSON.stringify(value), 'PX', ttlMs);
      } catch {
        /* best effort */
      }
    },
    async invalidate(prefix?: string): Promise<void> {
      const match = `${PREFIX}${prefix ?? ''}*`;
      try {
        let cursor = '0';
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', '200');
          cursor = next;
          if (keys.length > 0) await redis.del(...keys);
        } while (cursor !== '0');
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * Build the cache. Prefers Redis when configured and the driver is present,
 * otherwise falls back to the in-memory cache (no extra service required).
 */
export async function createCache(config: Config): Promise<Cache> {
  if (config.redisUrl) {
    try {
      const { default: Redis } = await import('ioredis' as string);
      const client = new Redis(config.redisUrl) as MinimalRedis;
      return createRedisCache(client);
    } catch {
      console.warn('[cache] REDIS_URL set but ioredis not installed — using in-memory cache');
    }
  }
  return createMemoryCache();
}
