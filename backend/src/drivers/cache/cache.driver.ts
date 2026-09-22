import type { CacheDriver as CacheDriverName } from '@shared/enums';

/**
 * Every external dependency sits behind an interface picked by an env var, so going live is a
 * config change and never a code change (docs/PROJECT_CONTEXT.md §2).
 */
export interface CacheDriver {
  readonly name: CacheDriverName;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Invalidates a whole namespace, e.g. `settings:` after an admin edit. */
  delByPrefix(prefix: string): Promise<void>;
  /** Read-through helper: returns the cached value or produces, stores and returns a fresh one. */
  wrap<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T>;
  /** Used by GET /ready. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const DEFAULT_TTL_SECONDS = 60;
