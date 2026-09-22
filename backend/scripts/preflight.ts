import { readFileSync } from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

import {
  findPlaceholderSecrets,
  readExamplePlaceholders,
} from '../src/config/productionSecrets';

/**
 * `npm run preflight` — everything a deployer should confirm before starting the process.
 *
 * One pass/fail list, every failure named at once. A check that stops at the first problem makes
 * the deployer do five round trips to find five things.
 *
 * KEY NAMES ONLY. Never a value, not even masked, and never a connection string.
 */

const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');

dotenv.config({ path: path.join(backendRoot, '.env') });

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];
const record = (name: string, ok: boolean, detail?: string): void => {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
};

/* ------------------------------------------------------------------ node */

function satisfies(version: string, range: string): boolean {
  const wanted = /(\d+)/.exec(range)?.[1];
  const actual = /(\d+)/.exec(version.replace(/^v/, ''))?.[1];

  return wanted !== undefined && actual !== undefined && Number(actual) >= Number(wanted);
}

const engines = (JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  engines?: { node?: string };
}).engines;

if (engines?.node) {
  record(
    `node ${process.version} satisfies engines.node "${engines.node}"`,
    satisfies(process.version, engines.node),
  );
} else {
  record('package.json declares engines.node', false, 'no engines field to check against');
}

/* ------------------------------------------------------------------- env */

const placeholders = readExamplePlaceholders(path.join(backendRoot, '.env.example'));
const declaredKeys = [...placeholders.keys()];

record('.env.example was readable', declaredKeys.length > 0, `${declaredKeys.length} keys`);

const missing = declaredKeys.filter((key) => {
  const value = process.env[key];
  return value === undefined || value === '';
});

// Blank is legitimate for the handful that mean "use the default"; report rather than fail.
record(
  'every key in .env.example is present in .env',
  missing.length === 0,
  missing.length === 0 ? undefined : `not set: ${missing.join(', ')}`,
);

const unsafe = findPlaceholderSecrets(process.env, placeholders);

record(
  'no guarded secret still holds its .env.example placeholder',
  unsafe.length === 0,
  unsafe.length === 0 ? undefined : unsafe.map((problem) => problem.key).join(', '),
);

/* --------------------------------------------------------------- drivers */

const STUBS: Record<string, string[]> = {
  PAYMENT_DRIVER: ['mock'],
  MAIL_DRIVER: ['log'],
  OTP_DRIVER: ['log'],
  SHIPPING_DRIVER: ['manual'],
  CACHE_DRIVER: ['memory'],
  STORAGE_DRIVER: ['local'],
  SEARCH_DRIVER: [],
};

const stubbed: string[] = [];

for (const [key, stubValues] of Object.entries(STUBS)) {
  const value = process.env[key] ?? '(unset)';
  if (stubValues.includes(value)) stubbed.push(`${key}=${value}`);
}

// Not a failure: stubs are deliberate right now. The deployer simply must know.
record(
  'selected drivers',
  true,
  stubbed.length === 0 ? 'none stubbed' : `STUBS IN USE — ${stubbed.join(', ')}`,
);

/* -------------------------------------------------------------- database */

async function checkDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL;

  if (!url) {
    record('DATABASE_URL is set', false);
    return;
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    record('DATABASE_URL parses', false);
    return;
  }

  // The host and port only. The rest of the URL never appears in output.
  const where = `${parsed.hostname}:${parsed.port || 3306}`;
  let connection: mysql.Connection | undefined;

  try {
    connection = await mysql.createConnection({
      host: parsed.hostname,
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, ''),
      connectTimeout: 10_000,
    });

    record(`the database at ${where} is reachable`, true);

    const [tables] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'",
    );
    const tableCount = Number(tables[0]!.n);
    record('the schema is present', tableCount >= 108, `${tableCount} tables`);

    const [ledger] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '_prisma_migrations'",
    );

    if (Number(ledger[0]!.n) === 0) {
      record('the migration ledger exists', false, 'no _prisma_migrations table');
      return;
    }

    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) total, SUM(finished_at IS NULL) pending, SUM(rolled_back_at IS NOT NULL) rolled FROM `_prisma_migrations`',
    );

    const total = Number(rows[0]!.total);
    const pending = Number(rows[0]!.pending ?? 0);
    const rolled = Number(rows[0]!.rolled ?? 0);

    record(
      'every migration is applied and none rolled back',
      total > 0 && pending === 0 && rolled === 0,
      `${total} applied, ${pending} unfinished, ${rolled} rolled back`,
    );

    // The collation contract: 45 columns must be byte-compared. See PROJECT_CONTEXT §38.
    const [collations] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema = DATABASE() AND collation_name = 'utf8mb4_bin'",
    );
    const binary = Number(collations[0]!.n);
    record('case-sensitive columns are collated utf8mb4_bin', binary === 45, `${binary} columns`);
  } catch (error) {
    // The message can carry the host but never the credentials.
    record(`the database at ${where} is reachable`, false, (error as { code?: string }).code ?? 'connection failed');
  } finally {
    await connection?.end();
  }
}

async function main(): Promise<void> {
  await checkDatabase();

  const width = Math.max(...checks.map((check) => check.name.length));

  for (const check of checks) {
    const status = check.ok ? 'PASS' : 'FAIL';
    console.log(`${status}  ${check.name.padEnd(width)}${check.detail ? `  — ${check.detail}` : ''}`);
  }

  const failed = checks.filter((check) => !check.ok);

  console.log(
    failed.length === 0
      ? `\nAll ${checks.length} checks passed.`
      : `\n${failed.length} of ${checks.length} checks FAILED: ${failed.map((check) => check.name).join('; ')}`,
  );

  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
