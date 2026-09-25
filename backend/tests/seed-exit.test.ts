import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The seed must exit on its own when the Redis cache is configured. It imports the container,
 * which opens the shared Redis client at import time; that client's socket (or, with Redis down,
 * its reconnect timer) keeps Node alive unless the seed closes the drivers.
 *
 * An unreachable Redis is used on purpose: it needs no server, and the reconnect loop holds the
 * process open exactly like a live connection does.
 */

const SEED_TIMEOUT_MS = 120_000;
const tsxCli = createRequire(path.join(process.cwd(), 'package.json')).resolve('tsx/cli');

describe('prisma db seed with CACHE_DRIVER=redis', () => {
  it(
    'terminates by itself once the seed is done',
    () => {
      const result = spawnSync(process.execPath, [tsxCli, path.join('prisma', 'seed.ts')], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: process.env.DATABASE_URL ?? '',
          SEED_DEMO: 'false',
          LOG_LEVEL: 'silent',
          CACHE_DRIVER: 'redis',
          REDIS_URL: 'redis://127.0.0.1:1/0',
          REDIS_CONNECT_TIMEOUT_MS: '200',
        },
        encoding: 'utf8',
        timeout: SEED_TIMEOUT_MS,
      });

      expect(
        result.error?.message,
        'the seed was still running when the timeout hit',
      ).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
    },
    SEED_TIMEOUT_MS + 10_000,
  );
});
