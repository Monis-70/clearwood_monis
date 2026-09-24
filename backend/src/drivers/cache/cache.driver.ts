import type { CacheDriver as CacheDriverName } from '@shared/enums';

/**
 * Every external dependency sits behind an interface picked by an env var, so going live is a
 * config change and never a code change (docs/PROJECT_CONTEXT.md §2).
 *
 * Contract: the cache never throws for being unavailable — `get` misses, writes and invalidations
 * log and carry on (failed invalidations are replayed, and their prefixes miss until then). Values
 * are plain JSON; `ttlSeconds <= 0` means "do not store"; nothing outlives `MAX_TTL_SECONDS`.
 */
export interface CacheDriver {
  readonly name: CacheDriverName;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Invalidates a whole namespace, e.g. `settings:` after an admin edit. */
  delByPrefix(prefix: string): Promise<void>;
  /**
   * Read-through helper: returns the cached value or produces, stores and returns a fresh one.
   * Concurrent misses for the same key in one process share a single producer call.
   */
  wrap<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T>;
  /** Used by GET /ready. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const DEFAULT_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 86_400;

/** The TTL a driver actually applies, or `null` for "do not store". */
export function effectiveTtl(ttlSeconds: number | undefined): number | null {
  const ttl = ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  return Math.min(Math.ceil(ttl), MAX_TTL_SECONDS);
}
