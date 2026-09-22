/**
 * Tiny in-memory TTL cache for dashboard reads.
 *
 * Deliberately isolated and dependency-free. Two properties matter:
 *
 *  - In-flight de-duplication. Concurrent identical requests (a page load
 *    fires KPIs, the chart and the campaign table at once, and a user can
 *    refresh mid-flight) share one Meta call instead of racing. The promise is
 *    stored, not the value.
 *  - Failures are never cached. A rejected loader evicts its own entry so the
 *    next request retries rather than serving an error for the whole TTL.
 *
 * Per-instance, like every other limiter in this codebase, so the effective
 * hit rate on Cloud Run scales down with the instance count.
 */

interface Entry<T> {
  promise: Promise<T>;
  /** Set once the promise resolves; until then the entry is in flight and never expires. */
  expiresAt: number | null;
}

export interface TtlCache {
  getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T>;
  invalidatePrefix(prefix: string): void;
  clear(): void;
  stats(): { entries: number };
}

export interface TtlCacheConfig {
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 500;

export function createTtlCache(config: TtlCacheConfig = {}): TtlCache {
  const now = config.now ?? Date.now;
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, Entry<unknown>>();

  const purgeExpired = (current: number): void => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= current) entries.delete(key);
    }
  };

  const evictIfNeeded = (): void => {
    while (entries.size > maxEntries) {
      // Map preserves insertion order, so this drops the oldest key.
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  };

  return {
    getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
      const current = now();
      purgeExpired(current);

      const existing = entries.get(key) as Entry<T> | undefined;
      if (existing) return existing.promise;

      const entry: Entry<T> = { promise: Promise.resolve() as Promise<T>, expiresAt: null };
      entry.promise = loader().then(
        (value) => {
          // Only mark it cacheable if this entry is still the live one; a
          // clear() or invalidatePrefix() during the call must not resurrect it.
          if (entries.get(key) === (entry as Entry<unknown>)) {
            entry.expiresAt = now() + ttlMs;
          }
          return value;
        },
        (error: unknown) => {
          if (entries.get(key) === (entry as Entry<unknown>)) entries.delete(key);
          throw error;
        },
      );

      entries.set(key, entry as Entry<unknown>);
      evictIfNeeded();
      return entry.promise;
    },

    invalidatePrefix(prefix: string): void {
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) entries.delete(key);
      }
    },

    clear(): void {
      entries.clear();
    },

    stats() {
      return { entries: entries.size };
    },
  };
}

/**
 * Build a cache key. The tenant (fbUserId) and the token identity (a hash,
 * never the token) always lead, so one user's cached rows can never be served
 * to another, and switching the active Meta token misses the cache instead of
 * returning the previous token's data.
 */
export function cacheKey(parts: {
  fbUserId: string;
  tokenHash: string;
  endpoint: string;
  params?: Record<string, string | number | boolean | null | undefined>;
}): string {
  const params = parts.params ?? {};
  const serialized = Object.keys(params)
    .sort()
    .map((k) => `${k}=${String(params[k] ?? "")}`)
    .join("&");
  return `${parts.fbUserId}|${parts.tokenHash}|${parts.endpoint}|${serialized}`;
}

/** Shared instance used by the dashboard services. */
export const dashboardCache = createTtlCache();

/**
 * Drop every cached read belonging to one tenant's token.
 *
 * Called after a confirmed write lands at Meta. It has to be tenant-wide
 * rather than surgical: a budget change moves the campaign list, the ad set
 * rows underneath it and every insights window that includes it, and those
 * live under different endpoints and different date-range parameters. Working
 * out which of them a given write touched is a rule that would be wrong the
 * first time a new endpoint is added — and being wrong means showing the user
 * a number Meta no longer holds, which is the failure this whole surface
 * exists to prevent.
 *
 * The cost is one tenant re-reading after their own write, which is rare:
 * writes are rate-limited to ten per ten minutes and every one of them is
 * behind a confirmation dialog. It lives here, next to `cacheKey`, so the
 * prefix can never drift from the key format it has to match.
 */
export function invalidateTenantCache(parts: { fbUserId: string; tokenHash: string }): void {
  dashboardCache.invalidatePrefix(`${parts.fbUserId}|${parts.tokenHash}|`);
}

export const CACHE_TTL_MS = {
  /** Account list changes rarely and gates authorization, so it is the longest. */
  accounts: 5 * 60_000,
  insights: 60_000,
  campaigns: 60_000,
} as const;
