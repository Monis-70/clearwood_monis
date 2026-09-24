import { decode, encode } from './cache.codec';
import type { CacheDriver } from './cache.driver';
import { effectiveTtl } from './cache.driver';
import { throttledWarn } from './throttledLog';

interface Entry {
  text: string;
  expiresAt: number;
}

/**
 * In-process cache: TTL per entry plus an LRU cap so a long-running dev server cannot grow
 * unbounded. `Map` preserves insertion order, so the oldest key is simply the first one.
 * Values are stored serialised, exactly as Redis stores them, so a caller cannot mutate a cached
 * object and development cannot rely on anything Redis would not give back.
 */
export class MemoryCacheDriver implements CacheDriver {
  readonly name = 'memory' as const;

  private readonly store = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Bumped by every invalidation; see `wrap`. */
  private epoch = 0;

  constructor(
    private readonly maxItems: number = 2000,
    private readonly maxValueBytes: number = 1_048_576,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    // Touch for LRU recency.
    this.store.delete(key);
    this.store.set(key, entry);

    const value = decode<T>(entry.text);
    if (value === undefined) {
      this.store.delete(key);
      return null;
    }
    return value;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = effectiveTtl(ttlSeconds);
    if (ttl === null) return;

    const encoded = encode(value, this.maxValueBytes);
    if (!encoded.ok) {
      throttledWarn('cache.memory.skip', { key, reason: encoded.reason }, 'value not cached');
      return;
    }

    this.store.delete(key);
    this.store.set(key, { text: encoded.text, expiresAt: Date.now() + ttl * 1000 });
    this.evict();
  }

  async del(key: string): Promise<void> {
    this.epoch += 1;
    this.store.delete(key);
  }

  async delByPrefix(prefix: string): Promise<void> {
    this.epoch += 1;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  async wrap<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    // Collapse concurrent misses onto a single producer call.
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const epoch = this.epoch;
    const promise = producer()
      .then(async (value) => {
        // Invalidated while this was being built: it may hold pre-write data, so serve it only.
        if (this.epoch === epoch) await this.set(key, value, ttlSeconds);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.store.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.store.size;
  }

  private evict(): void {
    while (this.store.size > this.maxItems) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }
}
