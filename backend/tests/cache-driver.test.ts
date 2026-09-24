import { EventEmitter } from 'node:events';

import type { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { decode, encode } from '../src/drivers/cache/cache.codec';
import { MAX_TTL_SECONDS, effectiveTtl } from '../src/drivers/cache/cache.driver';
import { MemoryCacheDriver } from '../src/drivers/cache/memory.cache';
import { RedisCacheDriver } from '../src/drivers/cache/redis.cache';
import {
  closeRedisClient,
  createRedisClient,
  describeRedisUrl,
} from '../src/drivers/cache/redis.connection';
import { RedisRateLimitStore } from '../src/middleware/rateLimitStore';

/**
 * Prompt 2 (Redis foundation) — the cache contract without a Redis server: the codec, the memory
 * driver, and the Redis driver's failure semantics against an unreachable port and a scripted
 * client. The same behaviour against a real Redis lives in redis-integration.test.ts.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('cache codec', () => {
  it('round-trips plain JSON and reports the encoded size', () => {
    const encoded = encode({ name: 'Kabir', pricePaise: 4_999_900, tags: ['sofa'] }, 1024);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.bytes).toBe(Buffer.byteLength(encoded.text));
    expect(decode(encoded.text)).toEqual({ name: 'Kabir', pricePaise: 4_999_900, tags: ['sofa'] });
  });

  it('refuses what JSON cannot carry and what is over the size cap', () => {
    expect(encode(undefined, 1024).ok).toBe(false);
    expect(encode({ big: 10n }, 1024).ok).toBe(false);
    expect(encode('x'.repeat(2048), 1024).ok).toBe(false);
  });

  it('reads unparseable text as undefined, which callers treat as a miss', () => {
    expect(decode('{"half":')).toBeUndefined();
  });

  it('never stores for ttl <= 0 and never longer than a day', () => {
    expect(effectiveTtl(0)).toBeNull();
    expect(effectiveTtl(-5)).toBeNull();
    expect(effectiveTtl(Number.NaN)).toBeNull();
    expect(effectiveTtl(10_000_000)).toBe(MAX_TTL_SECONDS);
    expect(effectiveTtl(undefined)).toBe(60);
  });
});

describe('MemoryCacheDriver', () => {
  it('hands back a copy, so a caller cannot mutate the cached value', async () => {
    const cache = new MemoryCacheDriver();
    await cache.set('k', { items: [1, 2] }, 60);

    const first = await cache.get<{ items: number[] }>('k');
    first!.items.push(3);

    expect(await cache.get('k')).toEqual({ items: [1, 2] });
  });

  it('returns what Redis would: dates come back as ISO strings', async () => {
    const cache = new MemoryCacheDriver();
    await cache.set('k', { at: new Date('2026-01-02T03:04:05.000Z') }, 60);
    expect(await cache.get('k')).toEqual({ at: '2026-01-02T03:04:05.000Z' });
  });

  it('expires entries after their TTL, and caps a huge TTL at one day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const cache = new MemoryCacheDriver();

    await cache.set('short', 1, 30);
    await cache.set('huge', 1, 10_000_000);

    vi.setSystemTime(new Date('2026-01-01T00:00:31Z'));
    expect(await cache.get('short')).toBeNull();
    expect(await cache.get('huge')).toBe(1);

    vi.setSystemTime(new Date('2026-01-02T00:00:01Z'));
    expect(await cache.get('huge')).toBeNull();
  });

  it('does not store for ttl <= 0 or for a value over the size cap', async () => {
    const cache = new MemoryCacheDriver(100, 1024);
    await cache.set('zero', 1, 0);
    await cache.set('big', 'x'.repeat(4096), 60);

    expect(await cache.get('zero')).toBeNull();
    expect(await cache.get('big')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('drops only the namespace asked for', async () => {
    const cache = new MemoryCacheDriver();
    await cache.set('sf:pdp:a', 1, 60);
    await cache.set('sf:pdp:b', 1, 60);
    await cache.set('sf:list:a', 1, 60);

    await cache.delByPrefix('sf:pdp:');

    expect(await cache.get('sf:pdp:a')).toBeNull();
    expect(await cache.get('sf:pdp:b')).toBeNull();
    expect(await cache.get('sf:list:a')).toBe(1);
  });

  it('evicts the least recently used entry past its cap', async () => {
    const cache = new MemoryCacheDriver(2);
    await cache.set('a', 1, 60);
    await cache.set('b', 2, 60);
    await cache.get('a');
    await cache.set('c', 3, 60);

    expect(await cache.get('a')).toBe(1);
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('c')).toBe(3);
  });

  it('collapses concurrent misses onto one producer call and caches nothing on failure', async () => {
    const cache = new MemoryCacheDriver();
    const producer = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { value: 42 };
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => cache.wrap('hot', 60, producer)),
    );
    expect(producer).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.value === 42)).toBe(true);

    await expect(
      cache.wrap('broken', 60, async () => {
        throw new Error('database down');
      }),
    ).rejects.toThrow('database down');
    expect(await cache.get('broken')).toBeNull();
  });
});

describe('describeRedisUrl', () => {
  it('never includes the password', () => {
    const described = describeRedisUrl('redis://:s3cr3t-pass@10.0.0.5:6380/2');
    expect(described).toBe('redis://10.0.0.5:6380/2');
    expect(described).not.toContain('s3cr3t');
  });
});

/* ------------------------------------------------------------------ Redis unreachable */

describe('RedisCacheDriver when Redis is unreachable', () => {
  // Port 1 refuses connections; with no offline queue every command fails at once.
  const client = createRedisClient(
    {
      REDIS_URL: 'redis://127.0.0.1:1',
      REDIS_CONNECT_TIMEOUT_MS: 200,
      REDIS_COMMAND_TIMEOUT_MS: 200,
    },
    'cw-test-unreachable',
  );
  const cache = new RedisCacheDriver(client, {
    keyPrefix: 'cwtest:',
    maxValueBytes: 1_048_576,
    onClose: () => closeRedisClient(client),
  });

  afterAll(async () => {
    await cache.close();
  });

  it('answers every read as a miss and never throws', async () => {
    const started = Date.now();
    expect(await cache.get('sf:pdp:a')).toBeNull();
    await expect(cache.set('sf:pdp:a', { a: 1 }, 60)).resolves.toBeUndefined();
    // Failing fast is the point: a request must not wait on a dead cache.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('serves from the producer (MySQL) through wrap', async () => {
    const producer = vi.fn(async () => ({ from: 'mysql' }));
    expect(await cache.wrap('sf:pdp:b', 60, producer)).toEqual({ from: 'mysql' });
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('remembers an invalidation it could not deliver', async () => {
    await cache.delByPrefix('sf:list:');
    await cache.del('settings:one:x');
    expect(cache.unconfirmedPrefixes).toEqual(
      expect.arrayContaining(['sf:list:', 'settings:one:x']),
    );
  });

  it('reports itself down to the readiness probe', async () => {
    expect(await cache.ping()).toBe(false);
  });
});

describe('RedisRateLimitStore when Redis is unreachable', () => {
  const client = createRedisClient(
    {
      REDIS_URL: 'redis://127.0.0.1:1',
      REDIS_CONNECT_TIMEOUT_MS: 200,
      REDIS_COMMAND_TIMEOUT_MS: 200,
    },
    'cw-test-unreachable-rl',
  );

  afterAll(async () => {
    await closeRedisClient(client);
  });

  it('keeps limiting on a per-process counter instead of failing open or closed', async () => {
    const store = new RedisRateLimitStore(client, 'cwtest:rl:fallback:');
    store.init({ windowMs: 60_000 } as Parameters<RedisRateLimitStore['init']>[0]);

    const hits: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      hits.push((await store.increment('203.0.113.9')).totalHits);
    }
    expect(hits).toEqual([1, 2, 3]);

    await store.resetKey('203.0.113.9');
    expect((await store.increment('203.0.113.9')).totalHits).toBe(1);
  });
});

/* ------------------------------------------------------------------ scripted client */

/** Just enough of ioredis for the driver, with a switch that makes every command fail. */
class ScriptedRedis extends EventEmitter {
  status = 'ready';
  down = false;
  readonly data = new Map<string, string>();
  readonly calls: string[] = [];

  private guard(command: string): void {
    this.calls.push(command);
    if (this.down) throw new Error('Connection is closed.');
  }

  async get(key: string): Promise<string | null> {
    this.guard('get');
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.guard('set');
    this.data.set(key, value);
    return 'OK';
  }

  async unlink(...keys: string[]): Promise<number> {
    this.guard('unlink');
    return keys.filter((key) => this.data.delete(key)).length;
  }

  async scan(_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
    this.guard('scan');
    const prefix = pattern.replace(/\*$/, '').replace(/\\(.)/g, '$1');
    return ['0', [...this.data.keys()].filter((key) => key.startsWith(prefix))];
  }

  async ping(): Promise<string> {
    this.guard('ping');
    return 'PONG';
  }

  async incr(key: string): Promise<number> {
    this.guard('incr');
    const next = Number(this.data.get(key) ?? '0') + 1;
    this.data.set(key, String(next));
    return next;
  }

  multi() {
    const queued: (() => Promise<unknown>)[] = [];
    const chain = {
      incr: (key: string) => (queued.push(() => this.incr(key)), chain),
      unlink: (...keys: string[]) => (queued.push(() => this.unlink(...keys)), chain),
      exec: async () => {
        const results: unknown[] = [];
        for (const run of queued) results.push([null, await run()]);
        return results;
      },
    };
    return chain;
  }

  /** The driver's only script: SET key value if the epoch still equals the one it read. */
  async eval(
    _script: string,
    _keys: number,
    epochKey: string,
    key: string,
    epoch: string,
    text: string,
  ): Promise<number> {
    this.guard('eval');
    if ((this.data.get(epochKey) ?? '0') !== epoch) return 0;
    this.data.set(key, text);
    return 1;
  }
}

describe('RedisCacheDriver invalidation replay', () => {
  function driver(redis: ScriptedRedis): RedisCacheDriver {
    return new RedisCacheDriver(redis as unknown as Redis, {
      keyPrefix: 'cw:',
      maxValueBytes: 1_048_576,
      onClose: async () => undefined,
    });
  }

  it('never serves a value whose invalidation did not reach Redis', async () => {
    const redis = new ScriptedRedis();
    const cache = driver(redis);
    await cache.set('sf:pdp:kabir', { name: 'old' }, 60);

    // The admin edit's invalidation fails (a timeout, a blip) ...
    redis.down = true;
    await cache.delByPrefix('sf:pdp:');
    expect(cache.unconfirmedPrefixes).toEqual(['sf:pdp:']);

    // ... and even though Redis is reachable again and still holds the stale value, it is a miss.
    redis.down = false;
    redis.calls.length = 0;
    expect(await cache.get('sf:pdp:kabir')).toBeNull();
    expect(redis.calls).not.toContain('get');
  });

  it('replays the invalidation once Redis answers, then caches normally again', async () => {
    const redis = new ScriptedRedis();
    const cache = driver(redis);
    await cache.set('sf:pdp:kabir', { name: 'old' }, 60);
    await cache.set('sf:list:x', 1, 60);

    redis.down = true;
    await cache.delByPrefix('sf:pdp:');
    await cache.set('sf:pdp:kabir', { name: 'refused' }, 60);

    redis.down = false;
    redis.emit('ready');
    await vi.waitFor(() => expect(cache.unconfirmedPrefixes).toEqual([]));

    expect(redis.data.has('cw:sf:pdp:kabir')).toBe(false);
    expect(redis.data.has('cw:sf:list:x')).toBe(true);

    await cache.set('sf:pdp:kabir', { name: 'new' }, 60);
    expect(await cache.get('sf:pdp:kabir')).toEqual({ name: 'new' });
  });

  it('drops an unreadable entry instead of serving it', async () => {
    const redis = new ScriptedRedis();
    const cache = driver(redis);
    redis.data.set('cw:settings:public:all', '{"half":');

    expect(await cache.get('settings:public:all')).toBeNull();
    expect(redis.data.has('cw:settings:public:all')).toBe(false);
  });

  it('sweeps every prefix requested in the same tick with one SCAN pass', async () => {
    const redis = new ScriptedRedis();
    const cache = driver(redis);
    await cache.set('prod:1', 1, 60);
    await cache.set('sf:pdp:1', 1, 60);
    await cache.set('cms:page:1', 1, 60);
    redis.calls.length = 0;

    await Promise.all([
      cache.delByPrefix('prod:'),
      cache.delByPrefix('sf:pdp:'),
      cache.delByPrefix('sf:list:'),
    ]);

    expect(redis.calls.filter((call) => call === 'scan')).toHaveLength(1);
    expect(redis.data.has('cw:prod:1')).toBe(false);
    expect(redis.data.has('cw:sf:pdp:1')).toBe(false);
    expect(redis.data.has('cw:cms:page:1')).toBe(true);
  });

  it('matches a prefix literally, even when it contains glob characters', async () => {
    const redis = new ScriptedRedis();
    const cache = driver(redis);
    const scan = vi.spyOn(redis, 'scan');

    await cache.delByPrefix('sf:sugg:so*a?[x]:');

    expect(scan).toHaveBeenCalledWith('0', 'MATCH', 'cw:sf:sugg:so\\*a\\?\\[x\\]:*', 'COUNT', 500);
  });
});

/* ------------------------------------------------------------------ stale-write race */

/** A producer that stands for "read the database": it reports when it starts and finishes on cue. */
function slowRead<T>(): {
  producer: () => Promise<T>;
  started: Promise<void>;
  finish: (value: T) => void;
} {
  let finish!: (value: T) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const result = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return {
    producer: () => {
      markStarted();
      return result;
    },
    started,
    finish,
  };
}

describe('a value read before an invalidation is never cached after it', () => {
  it('memory driver: serves the old value to its caller but does not store it', async () => {
    const cache = new MemoryCacheDriver();
    const read = slowRead<{ name: string }>();

    const racing = cache.wrap('sf:pdp:kabir:x', 60, read.producer);
    await read.started;
    await cache.delByPrefix('sf:pdp:'); // another request's write + invalidation lands here
    read.finish({ name: 'old' });

    expect(await racing).toEqual({ name: 'old' });
    expect(await cache.get('sf:pdp:kabir:x')).toBeNull();

    // With no invalidation in between, the same path caches as usual.
    await cache.wrap('sf:pdp:kabir:x', 60, async () => ({ name: 'new' }));
    expect(await cache.get('sf:pdp:kabir:x')).toEqual({ name: 'new' });
  });

  it('redis driver: the write is a compare-and-set against the shared epoch', async () => {
    const redis = new ScriptedRedis();
    const workerA = new RedisCacheDriver(redis as unknown as Redis, {
      keyPrefix: 'cw:',
      maxValueBytes: 1_048_576,
      onClose: async () => undefined,
    });
    const workerB = new RedisCacheDriver(redis as unknown as Redis, {
      keyPrefix: 'cw:',
      maxValueBytes: 1_048_576,
      onClose: async () => undefined,
    });
    const read = slowRead<{ name: string }>();

    const racing = workerA.wrap('sf:pdp:kabir:x', 60, read.producer);
    await read.started;
    await workerB.delByPrefix('sf:pdp:');
    read.finish({ name: 'old' });

    expect(await racing).toEqual({ name: 'old' });
    expect(redis.data.has('cw:sf:pdp:kabir:x')).toBe(false);

    await workerA.wrap('sf:pdp:kabir:x', 60, async () => ({ name: 'new' }));
    expect(await workerB.get('sf:pdp:kabir:x')).toEqual({ name: 'new' });
  });
});
