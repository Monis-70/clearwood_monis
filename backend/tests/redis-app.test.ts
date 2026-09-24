import { randomBytes } from 'node:crypto';

import type { Express } from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as prismaModule from '../src/config/prisma';
import type * as redisConnection from '../src/drivers/cache/redis.connection';

/**
 * Prompt 2 — the whole app with CACHE_DRIVER=redis against a REAL Redis.
 *
 * The invariant under test: when an admin changes a product, no worker may keep serving the old
 * catalog response. A second, independent connection plays the other PM2 worker.
 *
 * Runs only when CLEARWOOD_TEST_REDIS_URL is set; localhost only; every key carries a per-run
 * prefix and is removed afterwards. `src/` is imported dynamically because the env has to be in
 * place before config/env parses it.
 */

const redisUrl = process.env.CLEARWOOD_TEST_REDIS_URL;
const keyPrefix = `cwapp-${randomBytes(4).toString('hex')}:`;
const API = '/api/v1';
const SLUG = 'kabir-3-seater-fabric-sofa';
const TEST_PASSWORD = 'Rosewood-Teak-2026';

if (redisUrl) {
  // Stubbed, not assigned: a worker process runs other test files afterwards.
  vi.stubEnv('CACHE_DRIVER', 'redis');
  vi.stubEnv('REDIS_URL', redisUrl);
  vi.stubEnv('REDIS_KEY_PREFIX', keyPrefix);
}

describe.skipIf(!redisUrl)('the app on a real Redis (CACHE_DRIVER=redis)', () => {
  let app: Express;
  let prisma: typeof prismaModule.prisma;
  let otherWorker: Redis;
  let closeRedisClient: typeof redisConnection.closeRedisClient;

  async function pdpKeys(): Promise<string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await otherWorker.scan(
        cursor,
        'MATCH',
        `${keyPrefix}sf:pdp:*`,
        'COUNT',
        500,
      );
      cursor = next;
      found.push(...keys);
    } while (cursor !== '0');
    return found;
  }

  async function catalogManager(): Promise<{ header: string; csrf: string }> {
    const { passwordService } = await import('../src/modules/auth/password.service');
    const email = 'redis.catalog@clearwood.local';
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'CATALOG_MANAGER' } });
    const user = await prisma.adminUser.upsert({
      where: { email },
      update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
      create: {
        email,
        name: 'Redis Catalog',
        passwordHash: await passwordService.hash(TEST_PASSWORD),
        status: 'ACTIVE',
      },
    });
    await prisma.adminUserRole.upsert({
      where: { adminUserId_roleId: { adminUserId: user.id, roleId: role.id } },
      update: {},
      create: { adminUserId: user.id, roleId: role.id },
    });

    const login = await request(app)
      .post(`${API}/admin/auth/login`)
      .send({ email, password: TEST_PASSWORD });
    const raw = login.headers['set-cookie'];
    const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

    return {
      header: cookies.map((cookie) => cookie.split(';')[0]).join('; '),
      csrf:
        cookies
          .find((cookie) => cookie.startsWith('cw_adm_csrf='))
          ?.split(';')[0]
          ?.split('=')[1] ?? '',
    };
  }

  beforeAll(async () => {
    const host = new URL(redisUrl!).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
      throw new Error(`Refusing to run Redis tests against ${host}: localhost only.`);
    }

    const { createApp } = await import('../src/app');
    const { cache } = await import('../src/container');
    const connection = await import('../src/drivers/cache/redis.connection');
    ({ prisma } = await import('../src/config/prisma'));
    closeRedisClient = connection.closeRedisClient;

    app = createApp();
    otherWorker = connection.createRedisClient(
      { REDIS_URL: redisUrl!, REDIS_CONNECT_TIMEOUT_MS: 5_000, REDIS_COMMAND_TIMEOUT_MS: 5_000 },
      'cw-test-other-worker',
    );

    // The app's own connection opens asynchronously; wait for it rather than race it.
    const deadline = Date.now() + 10_000;
    while (!(await cache.ping()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (otherWorker.status !== 'ready') {
      await new Promise((resolve) => otherWorker.once('ready', resolve));
    }
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!otherWorker) return;
    let cursor = '0';
    do {
      const [next, keys] = await otherWorker.scan(cursor, 'MATCH', `${keyPrefix}*`, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await otherWorker.unlink(...keys);
    } while (cursor !== '0');
    await closeRedisClient(otherWorker);
  });

  it('reports Redis as the cache on /ready', async () => {
    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ready');
    expect(response.body.data.dependencies.cache).toMatchObject({ driver: 'redis', status: 'up' });
  });

  it('serves the product page from Redis, and a stale entry only until another worker invalidates', async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { slug: SLUG } });

    const first = await request(app).get(`${API}/catalog/products/${SLUG}`);
    expect(first.status).toBe(200);
    expect(first.body.data.name).toBe(product.name);
    expect((await pdpKeys()).length).toBeGreaterThan(0);

    // A write that bypasses the invalidators proves the response really comes from Redis ...
    await prisma.product.update({ where: { id: product.id }, data: { name: `${product.name} X` } });
    try {
      const cached = await request(app).get(`${API}/catalog/products/${SLUG}`);
      expect(cached.body.data.name).toBe(product.name);

      // ... and a delete issued over a different connection is seen by this worker at once.
      const keys = await pdpKeys();
      await otherWorker.unlink(...keys);

      const fresh = await request(app).get(`${API}/catalog/products/${SLUG}`);
      expect(fresh.body.data.name).toBe(`${product.name} X`);
    } finally {
      await prisma.product.update({ where: { id: product.id }, data: { name: product.name } });
      const keys = await pdpKeys();
      if (keys.length > 0) await otherWorker.unlink(...keys);
    }
  });

  it('an admin product edit drops the cached product pages every worker reads', async () => {
    const session = await catalogManager();
    const product = await prisma.product.findUniqueOrThrow({ where: { slug: SLUG } });

    await request(app).get(`${API}/catalog/products/${SLUG}`).expect(200);
    const warmed = await pdpKeys();
    expect(warmed.length).toBeGreaterThan(0);

    const renamed = `${product.name} (edited)`;
    const edit = await request(app)
      .patch(`${API}/admin/catalog/products/${product.id}`)
      .set('Cookie', session.header)
      .set('X-CSRF-Token', session.csrf)
      .send({ name: renamed, version: product.version });
    expect(edit.status).toBe(200);

    // What the other worker would read: nothing, so it rebuilds from MySQL.
    expect(await otherWorker.exists(...warmed)).toBe(0);

    const after = await request(app).get(`${API}/catalog/products/${SLUG}`);
    expect(after.body.data.name).toBe(renamed);
  });
});
