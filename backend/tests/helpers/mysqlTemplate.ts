import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import mysql from 'mysql2/promise';

/**
 * The MySQL replacement for the SQLite template-file copy.
 *
 * SQLite gave every test file its own database for the price of a file copy. MySQL has no such
 * thing, so the same two properties - per-file isolation and parallelism - are bought differently:
 * the schema is migrated and seeded ONCE into a template database, that template is serialised to
 * a single SQL file, and each test file replays that file into a database of its own.
 *
 * Serialising it here rather than shelling out to `mysqldump` keeps the bootstrap free of any
 * client binary and of Docker: a developer with nothing but Node and a reachable server can run
 * the suite. The dump is cached under the same fingerprint the SQLite bootstrap used, so a re-run
 * with no source change skips migrate and seed entirely.
 */

export const TEST_DB_PREFIX = 'clearwood_test_';

export interface AdminUrl {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function parseUrl(url: string): AdminUrl {
  const parsed = new URL(url);

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
  };
}

export function urlFor(base: AdminUrl, database: string, connectionLimit: number): string {
  const auth = `${encodeURIComponent(base.user)}:${encodeURIComponent(base.password)}`;
  return `mysql://${auth}@${base.host}:${base.port}/${database}?connection_limit=${connectionLimit}&pool_timeout=20&connect_timeout=10`;
}

/** Everything that can change what the seeded database contains. */
export function fingerprintSources(backendDir: string): string {
  const hash = createHash('sha256');

  const addFile = (file: string): void => {
    hash.update(file);
    hash.update(readFileSync(file));
  };

  const addTree = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) addTree(full);
      else addFile(full);
    }
  };

  addFile(path.join(backendDir, 'prisma', 'schema.prisma'));

  const seedEntry = path.join(backendDir, 'prisma', 'seed.ts');
  if (existsSync(seedEntry)) addFile(seedEntry);

  for (const dir of ['seed', 'migrations']) {
    const full = path.join(backendDir, 'prisma', dir);
    if (existsSync(full)) addTree(full);
  }

  return hash.digest('hex').slice(0, 16);
}

export async function connect(base: AdminUrl, database?: string): Promise<mysql.Connection> {
  return mysql.createConnection({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    ...(database ? { database } : {}),
    multipleStatements: true,
    connectTimeout: 20_000,
    /*
     * DATETIME is naive: it carries no zone. Left to itself mysql2 turns `2026-01-01 00:00:00`
     * into a JS Date in the RUNNER's zone, and serialising that back produced a dump in which
     * every timestamp had moved by the local offset - on a machine in IST, SEED_EPOCH came back
     * as 2025-12-31T18:30:00Z. Reading the raw string means nothing is ever interpreted.
     */
    dateStrings: true,
    timezone: 'Z',
  });
}

/** MySQL has no `CREATE DATABASE ... LIKE`, so the template is serialised to replayable SQL. */
export async function serialise(connection: mysql.Connection, database: string): Promise<string> {
  const [tableRows] = await connection.query<mysql.RowDataPacket[]>(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_type = ?',
    [database, 'BASE TABLE'],
  );

  const tables = tableRows.map((row) => String(row.name)).sort();
  if (tables.length === 0) throw new Error(`template database ${database} has no tables`);

  const parts: string[] = ['SET FOREIGN_KEY_CHECKS = 0;', 'SET UNIQUE_CHECKS = 0;'];

  for (const table of tables) {
    const [created] = await connection.query<mysql.RowDataPacket[]>(
      `SHOW CREATE TABLE \`${database}\`.\`${table}\``,
    );
    parts.push(`${String(created[0]!['Create Table'])};`);
  }

  for (const table of tables) {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT * FROM \`${database}\`.\`${table}\``,
    );
    if (rows.length === 0) continue;

    const columns = Object.keys(rows[0]!);
    const columnList = columns.map((column) => `\`${column}\``).join(',');

    // Batched so a table of a few thousand rows is a handful of statements, not one per row.
    for (let index = 0; index < rows.length; index += 200) {
      const chunk = rows.slice(index, index + 200);
      const values = chunk
        .map((row) => `(${columns.map((column) => literal(row[column])).join(',')})`)
        .join(',');

      parts.push(`INSERT INTO \`${table}\` (${columnList}) VALUES ${values};`);
    }
  }

  parts.push('SET UNIQUE_CHECKS = 1;', 'SET FOREIGN_KEY_CHECKS = 1;');
  return parts.join('\n');
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;

  // Dates arrive as strings because the connection sets dateStrings; see connect().
  return mysql.escape(String(value));
}
