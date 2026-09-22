import path from 'node:path';

import { defineConfig } from 'vitest/config';

const backendDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@shared\/(.*)$/,
        replacement: `${path.resolve(backendDir, '..', 'shared', 'src')}/$1`,
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    // DATABASE_URL is deliberately ABSENT: `tests/global-setup.ts` seeds a TEMPLATE once and
    // `tests/setup.ts` replays it into a database per test file, setting DATABASE_URL before
    // Prisma is imported. Pinning it here would override that and put every worker on one schema.
    env: {
      NODE_ENV: 'test',
      DATABASE_PROVIDER: 'mysql',
      CACHE_DRIVER: 'memory',
      STORAGE_DRIVER: 'local',
      MAIL_DRIVER: 'log',
      PAYMENT_DRIVER: 'mock',
      SEED_DEMO: 'true',
      LOG_LEVEL: 'silent',
    },
    // Each test file has its OWN database, so there is no shared writer to serialise behind.
    fileParallelism: true,
    // Eight workers x 15 pooled connections is 120 against max_connections=200, leaving room for
    // the admin connection each file opens to create and load its database.
    minWorkers: 1,
    maxWorkers: 8,
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
