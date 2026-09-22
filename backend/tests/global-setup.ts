import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RowDataPacket } from 'mysql2';

import {
  TEST_DB_PREFIX,
  connect,
  fingerprintSources,
  parseUrl,
  serialise,
  urlFor,
} from './helpers/mysqlTemplate';
import { assertLocalTestTarget } from './helpers/testTarget';

/**
 * Migrates and seeds ONE template database, then caches it as replayable SQL.
 *
 * `tests/setup.ts` replays that SQL into a database per test file, which is how per-file isolation
 * and `fileParallelism` both survive the move off SQLite - MySQL has no file to copy. The cache
 * key is the same fingerprint of `schema.prisma` + `prisma/migrations/` + `prisma/seed/**` the
 * SQLite bootstrap used, so a re-run with no source change never migrates or seeds again.
 *
 * Vitest takes the teardown from the default export's RETURN VALUE; a named `teardown` alongside a
 * default export is ignored, which is how an early version leaked state between runs.
 */

const backendDir = process.cwd();
const schema = path.join(backendDir, 'prisma', 'schema.prisma');

function readDatabaseUrlFromEnvFile(): string | undefined {
  const envFile = path.join(backendDir, '.env');
  if (!existsSync(envFile)) return undefined;

  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (match) return match[1]!.trim().replace(/^["']|["']$/g, '');
  }

  return undefined;
}

function adminUrl(): string {
  const url = process.env.CLEARWOOD_TEST_DATABASE_URL ?? readDatabaseUrlFromEnvFile();

  if (!url) {
    throw new Error(
      'No MySQL URL for the test suite. Set CLEARWOOD_TEST_DATABASE_URL, or leave DATABASE_URL in ' +
        'backend/.env pointing at a server whose user holds the clearwood_test_% grant ' +
        '(see infra/README.md).',
    );
  }

  return url;
}

export default async function setup(): Promise<() => Promise<void>> {
  if (!existsSync(schema)) {
    throw new Error(
      `Expected to run vitest from the backend workspace, but ${schema} does not exist. ` +
        'Run `npm test --workspace backend` (or `npm test` from the repo root).',
    );
  }

  const url = adminUrl();

  // The suite creates and drops databases. It may only ever do that locally - see testTarget.ts.
  assertLocalTestTarget(url);

  const base = parseUrl(url);
  const fingerprint = fingerprintSources(backendDir);

  const cacheDir = path.join(os.tmpdir(), 'clearwood-test-templates');
  const dumpFile = path.join(cacheDir, `template-${fingerprint}.sql`);
  mkdirSync(cacheDir, { recursive: true });

  if (!existsSync(dumpFile)) {
    const templateDb = `${TEST_DB_PREFIX}tpl_${fingerprint}`;
    const admin = await connect(base);

    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${templateDb}\``);
      await admin.query(
        `CREATE DATABASE \`${templateDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
      await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_PREFIX}shadow\``);
      await admin.query(`CREATE DATABASE \`${TEST_DB_PREFIX}shadow\``);

      /*
       * These steps are SUBPROCESSES and load backend/.env, not vitest's overrides. Without them
       * the suite fails to boot the moment a developer points their .env at a real S3 bucket or
       * Redis - the test bootstrap must never depend on anyone's cloud configuration.
       */
      const buildEnv = {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_PROVIDER: 'mysql',
        DATABASE_URL: urlFor(base, templateDb, 5),
        SHADOW_DATABASE_URL: urlFor(base, `${TEST_DB_PREFIX}shadow`, 2),
        SEED_DEMO: 'true',
        LOG_LEVEL: 'silent',
        STORAGE_DRIVER: 'local',
        CACHE_DRIVER: 'memory',
        MAIL_DRIVER: 'log',
        PAYMENT_DRIVER: 'mock',
        OTP_DRIVER: 'log',
        SEARCH_DRIVER: 'sql',
      };

      execSync('npx prisma migrate deploy', { cwd: backendDir, env: buildEnv, stdio: 'pipe' });
      execSync('npx prisma db seed', { cwd: backendDir, env: buildEnv, stdio: 'pipe' });

      const sql = await serialise(admin, templateDb);

      // Written to scratch and renamed, so a killed run cannot leave a half-written template that
      // the next run would happily reuse.
      const scratch = `${dumpFile}.${process.pid}.partial`;
      writeFileSync(scratch, sql);
      renameSync(scratch, dumpFile);

      await admin.query(`DROP DATABASE IF EXISTS \`${templateDb}\``);
      await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_PREFIX}shadow\``);
    } finally {
      await admin.end();
    }
  }

  process.env.CLEARWOOD_TEST_DUMP = dumpFile;
  process.env.CLEARWOOD_TEST_ADMIN_URL = url;
  process.env.CLEARWOOD_TEST_RUN = String(process.pid);

  return async () => {
    // Drops every per-file database from THIS run, including files that never reached afterAll.
    const admin = await connect(base);

    try {
      const [rows] = await admin.query<RowDataPacket[]>(
        'SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name LIKE ?',
        [`${TEST_DB_PREFIX}r${process.pid}\\_%`],
      );

      for (const row of rows) {
        await admin.query(`DROP DATABASE IF EXISTS \`${String(row.name)}\``);
      }
    } finally {
      await admin.end();
    }
  };
}
