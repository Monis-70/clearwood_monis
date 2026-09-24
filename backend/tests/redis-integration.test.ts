import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import express from 'express';
import rateLimit from 'express-rate-limit';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RedisCacheDriver } from '../src/drivers/cache/redis.cache';
import { closeRedisClient, createRedisClient } from '../src/drivers/cache/redis.connection';
import { RedisRateLimitStore } from '../src/middleware/rateLimitStore';

/**
 * Prompt 2 — the cache and the rate-limit store against a REAL Redis, including a second OS
 * process standing in for a second PM2 worker.
 *
 * Runs only when CLEARWOOD_TEST_REDIS_URL is set (e.g. redis://127.0.0.1:6380) and refuses any
 * host but this machine. Every key carries a per-run prefix and is removed afterwards; nothing
 * here ever flushes a database.
 */

const redisUrl = process.env.CLEARWOOD_TEST_REDIS_URL;
const backendRoot = path.resolve(__dirname, '..');
const tsxCli = path.resolve(backendRoot, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const runPrefix = `cwtest-${randomBytes(4).toString('hex')}:`;

function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    throw new Error(`Refusing to run Redis tests against ${host}: localhost only.`);
  }
}

function connect(name: string): Redis {
  return createRedisClient(
    { REDIS_URL: redisUrl!, REDIS_CONNECT_TIMEOUT_MS: 5_000, REDIS_COMMAND_TIMEOUT_MS: 5_000 },
    name,
  );
}

async function ready(client: Redis): Promise<void> {
  if (client.status === 'ready') return;
  await new Promise<void>((resolve) => client.once('ready', () => resolve()));
}

const drivers = new Map<string, RedisCacheDriver>();

/** One driver per connection and prefix, as in production (one per process). */
function cacheOn(client: Redis, keyPrefix = runPrefix): RedisCacheDriver {
  const id = `${client.options.connectionName}|${keyPrefix}`;
  let driver = drivers.get(id);
  if (!driver) {
    driver = new RedisCacheDriver(client, {
      keyPrefix,
      maxValueBytes: 64 * 1024,
      onClose: async () => undefined,
    });
    drivers.set(id, driver);
  }
  return driver;
}

async function keysUnder(client: Redis, prefix: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    found.push(...keys);
  } while (cursor !== '0');
  return found.sort();
}

/** Runs `body` in a separate Node process with its own Redis connection: a second worker. */
function inAnotherProcess(body: string): string {
  const script = `
    (async () => {
      const { createRedisClient, closeRedisClient } = await import('./src/drivers/cache/redis.connection');
      const { RedisCacheDriver } = await import('./src/drivers/cache/redis.cache');
      const { RedisRateLimitStore } = await import('./src/middleware/rateLimitStore');
      const client = createRedisClient(
        { REDIS_URL: process.env.CW_REDIS, REDIS_CONNECT_TIMEOUT_MS: 5000, REDIS_COMMAND_TIMEOUT_MS: 5000 },
        'cw-test-other-process',
      );
      await new Promise((resolve) => client.once('ready', resolve));
      const cache = new RedisCacheDriver(client, {
        keyPrefix: process.env.CW_PREFIX, maxValueBytes: 65536, onClose: async () => undefined,
      });
      ${body}
      await closeRedisClient(client);
    })().catch((error) => { console.error(error); process.exit(1); });
  `;

  return execFileSync(process.execPath, [tsxCli, '-e', script], {
    cwd: backendRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CW_REDIS: redisUrl,
      CW_PREFIX: runPrefix,
    },
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60_000,
  });
}

describe.skipIf(!redisUrl)('Redis integration (real server)', () => {
  let a: Redis;
  let b: Redis;

  beforeAll(async () => {
    assertLocal(redisUrl!);
    a = connect('cw-test-worker-a');
    b = connect('cw-test-worker-b');
    await Promise.all([ready(a), ready(b)]);
  });

  afterAll(async () => {
    if (!a) return;
    const leftovers = await keysUnder(a, runPrefix);
    if (leftovers.length > 0) await a.unlink(...leftovers);
    await Promise.all([closeRedisClient(a), closeRedisClient(b)]);
  });

  describe('RedisCacheDriver', () => {
    it('round-trips JSON and applies the TTL with SET EX', async () => {
      const cache = cacheOn(a);
      await cache.set('sf:pdp:kabir', { name: 'Kabir', pricePaise: 4_999_900 }, 30);

      expect(await cache.get('sf:pdp:kabir')).toEqual({ name: 'Kabir', pricePaise: 4_999_900 });
      const ttl = await a.pttl(`${runPrefix}sf:pdp:kabir`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30_000);
    });

    it('caps a huge TTL at a day and stores nothing for ttl <= 0 or an oversized value', async () => {
      const cache = cacheOn(a);
      await cache.set('ttl:huge', 1, 10_000_000);
      await cache.set('ttl:zero', 1, 0);
      await cache.set('ttl:big', 'x'.repeat(128 * 1024), 60);

      expect(await a.ttl(`${runPrefix}ttl:huge`)).toBeLessThanOrEqual(86_400);
      expect(await a.exists(`${runPrefix}ttl:zero`, `${runPrefix}ttl:big`)).toBe(0);
    });

    it('treats a malformed entry as a miss and removes it', async () => {
      const cache = cacheOn(a);
      await a.set(`${runPrefix}settings:public:all`, '{"half":', 'EX', 60);

      expect(await cache.get('settings:public:all')).toBeNull();
      expect(await a.exists(`${runPrefix}settings:public:all`)).toBe(0);
    });

    it('drops one namespace only, literally, and never touches another prefix', async () => {
      const mine = cacheOn(a);
      const otherApp = cacheOn(a, `${runPrefix}other:`);

      await mine.set('sf:pdp:1', 1, 60);
      await mine.set('sf:pdp:2', 1, 60);
      await mine.set('sf:list:1', 1, 60);
      await mine.set('sf:sugg:so*:1', 1, 60);
      await mine.set('sf:sugg:sofa:1', 1, 60);
      await otherApp.set('sf:pdp:1', 1, 60);

      await mine.delByPrefix('sf:pdp:');
      await mine.delByPrefix('sf:sugg:so*:');

      expect(await mine.get('sf:pdp:1')).toBeNull();
      expect(await mine.get('sf:pdp:2')).toBeNull();
      expect(await mine.get('sf:list:1')).toBe(1);
      expect(await mine.get('sf:sugg:so*:1')).toBeNull();
      // A glob `*` in the prefix must not have matched "sofa".
      expect(await mine.get('sf:sugg:sofa:1')).toBe(1);
      expect(await otherApp.get('sf:pdp:1')).toBe(1);
    });

    it('sweeps the prefixes of one edit in a single SCAN pass', async () => {
      const cache = cacheOn(a);
      await cache.set('prod:1', 1, 60);
      await cache.set('sf:pdp:1', 1, 60);
      const scan = vi.spyOn(a, 'scan');

      await Promise.all([
        cache.delByPrefix('prod:'),
        cache.delByPrefix('sf:pdp:'),
        cache.delByPrefix('sf:list:'),
      ]);

      const passes = scan.mock.calls.filter((call) => call[0] === '0');
      scan.mockRestore();
      expect(passes).toHaveLength(1);
      expect(await cache.get('prod:1')).toBeNull();
      expect(await cache.get('sf:pdp:1')).toBeNull();
    });

    it('collapses concurrent misses in one process onto a single producer call', async () => {
      const cache = cacheOn(a);
      const producer = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { built: true };
      });

      await Promise.all(Array.from({ length: 10 }, () => cache.wrap('hot:key', 60, producer)));
      expect(producer).toHaveBeenCalledTimes(1);
      expect(await cache.get('hot:key')).toEqual({ built: true });
    });

    it('shares invalidation between two connections (two workers in one process)', async () => {
      const workerA = cacheOn(a);
      const workerB = cacheOn(b);

      await workerA.set('sf:pdp:shared', { name: 'before' }, 120);
      expect(await workerB.get('sf:pdp:shared')).toEqual({ name: 'before' });

      await workerB.delByPrefix('sf:pdp:');

      expect(await workerA.get('sf:pdp:shared')).toBeNull();
    });

    it('never caches a read that began before another worker invalidated it', async () => {
      const workerA = cacheOn(a);
      const workerB = cacheOn(b);
      let finish!: (value: { name: string }) => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });

      const racing = workerA.wrap('sf:pdp:race', 120, () => {
        markStarted();
        return new Promise<{ name: string }>((resolve) => {
          finish = resolve;
        });
      });
      await started;
      await workerB.delByPrefix('sf:pdp:');
      finish({ name: 'stale' });

      expect(await racing).toEqual({ name: 'stale' });
      expect(await a.exists(`${runPrefix}sf:pdp:race`)).toBe(0);

      await workerA.wrap('sf:pdp:race', 120, async () => ({ name: 'fresh' }));
      expect(await workerB.get('sf:pdp:race')).toEqual({ name: 'fresh' });
    });

    it('shares invalidation with a separate OS process', async () => {
      const cache = cacheOn(a);
      await cache.set('sf:pdp:cross', { name: 'before' }, 120);
      await cache.set('sf:list:cross', { keep: true }, 120);

      inAnotherProcess(`await cache.delByPrefix('sf:pdp:');`);

      expect(await cache.get('sf:pdp:cross')).toBeNull();
      expect(await cache.get('sf:list:cross')).toEqual({ keep: true });
    }, 60_000);

    it('reads a value written by a separate OS process', async () => {
      inAnotherProcess(`await cache.set('sf:set:v1', { defaultPageSize: 24 }, 120);`);
      expect(await cacheOn(a).get('sf:set:v1')).toEqual({ defaultPageSize: 24 });
    }, 60_000);

    it('reports up to the readiness probe', async () => {
      expect(await cacheOn(a).ping()).toBe(true);
    });
  });

  describe('RedisRateLimitStore', () => {
    const windowMs = 60_000;
    const init = (store: RedisRateLimitStore) =>
      store.init({ windowMs } as Parameters<RedisRateLimitStore['init']>[0]);

    it('counts hits from two workers against one limit and bounds the counter by the window', async () => {
      const prefix = `${runPrefix}rl:two-workers:`;
      const workerA = new RedisRateLimitStore(a, prefix);
      const workerB = new RedisRateLimitStore(b, prefix);
      init(workerA);
      init(workerB);

      expect((await workerA.increment('198.51.100.7')).totalHits).toBe(1);
      expect((await workerB.increment('198.51.100.7')).totalHits).toBe(2);
      expect((await workerA.increment('198.51.100.7')).totalHits).toBe(3);

      const ttl = await a.pttl(`${prefix}198.51.100.7`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(windowMs);
    });

    it('counts hits from a separate OS process against the same limit', async () => {
      const prefix = `${runPrefix}rl:cross-process:`;
      const output = inAnotherProcess(`
        const store = new RedisRateLimitStore(client, process.env.CW_PREFIX + 'rl:cross-process:');
        store.init({ windowMs: ${windowMs} });
        let info;
        for (let i = 0; i < 3; i += 1) info = await store.increment('198.51.100.8');
        console.log(JSON.stringify({ totalHits: info.totalHits }));
      `);
      expect(output).toContain('"totalHits":3');

      const store = new RedisRateLimitStore(a, prefix);
      init(store);
      expect((await store.increment('198.51.100.8')).totalHits).toBe(4);
    }, 60_000);

    it('makes express-rate-limit refuse the request that crosses the shared limit', async () => {
      const prefix = `${runPrefix}rl:http:`;
      const worker = (client: Redis) => {
        const app = express();
        app.use(
          rateLimit({
            windowMs,
            limit: 3,
            standardHeaders: 'draft-7',
            legacyHeaders: false,
            store: new RedisRateLimitStore(client, prefix),
            keyGenerator: () => 'same-client',
          }),
        );
        app.get('/', (_req, res) => {
          res.json({ ok: true });
        });
        return app;
      };
      const workerA = worker(a);
      const workerB = worker(b);

      const statuses = [];
      for (const app of [workerA, workerB, workerA, workerB]) {
        statuses.push((await request(app).get('/')).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
    });

    it('never creates a counter on decrement and removes it on reset', async () => {
      const prefix = `${runPrefix}rl:housekeeping:`;
      const store = new RedisRateLimitStore(a, prefix);
      init(store);

      await store.decrement('never-seen');
      expect(await a.exists(`${prefix}never-seen`)).toBe(0);

      await store.increment('seen');
      await store.increment('seen');
      await store.decrement('seen');
      expect(await a.get(`${prefix}seen`)).toBe('1');

      await store.resetKey('seen');
      expect(await a.exists(`${prefix}seen`)).toBe(0);
    });
  });
});
