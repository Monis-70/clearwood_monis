/**
 * Reports the shape of a database, for comparing local against production.
 *
 * Reads only. Takes a port so the same script can look through the SSH tunnel without a second
 * connection string existing anywhere: the credentials and the database name are derived from
 * DATABASE_URL, and nothing about them is printed.
 *
 *   node scripts/db-shape.mjs [port] [database]
 */
import { readFileSync } from 'node:fs';

import mysql from 'mysql2/promise';

const line = readFileSync('backend/.env', 'utf8')
  .split(/\r?\n/)
  .find((row) => row.startsWith('DATABASE_URL='));

if (!line) throw new Error('DATABASE_URL is not set in backend/.env');

const url = new URL(line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, ''));

const port = Number(process.argv[2] ?? url.port ?? 3306);
const database = process.argv[3] ?? url.pathname.replace(/^\//, '');

const connection = await mysql.createConnection({
  host: url.hostname,
  port,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database,
  connectTimeout: 20_000,
});

const one = async (sql) => (await connection.query(sql))[0][0];
const all = async (sql) => (await connection.query(sql))[0];

const shape = {
  database,
  tables: Number(
    (
      await one(
        "SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'",
      )
    ).n,
  ),
  foreignKeys: Number(
    (
      await one(
        'SELECT COUNT(*) n FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE()',
      )
    ).n,
  ),
  indexes: Number(
    (
      await one(
        'SELECT COUNT(DISTINCT table_name, index_name) n FROM information_schema.statistics WHERE table_schema=DATABASE()',
      )
    ).n,
  ),
  autoIncrementColumns: Number(
    (
      await one(
        "SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND extra LIKE '%auto_increment%'",
      )
    ).n,
  ),
  defaultCollation: (
    await one(
      'SELECT default_collation_name c FROM information_schema.schemata WHERE schema_name = DATABASE()',
    )
  ).c,
  collations: Object.fromEntries(
    (
      await all(
        'SELECT collation_name c, COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND collation_name IS NOT NULL GROUP BY collation_name',
      )
    ).map((row) => [row.c, Number(row.n)]),
  ),
  currentTimestampDefaults: Number(
    (
      await one(
        "SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND column_default LIKE 'CURRENT_TIMESTAMP%'",
      )
    ).n,
  ),
};

const ledger = await all(
  "SELECT table_name t FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='_prisma_migrations'",
);

shape.migrationLedger = ledger.length > 0;

if (shape.migrationLedger) {
  shape.migrations = (
    await all(
      'SELECT migration_name n, finished_at f, rolled_back_at r FROM `_prisma_migrations` ORDER BY started_at',
    )
  ).map((row) => ({
    name: row.n,
    finished: row.f !== null,
    rolledBack: row.r !== null,
  }));
}

console.log(JSON.stringify(shape, null, 2));

await connection.end();
