/**
 * Per-table row counts, for comparing one seed run against the next.
 *
 * Reads only, and prints no credential. Takes a port and database so the same script can look
 * through the SSH tunnel without a second connection string existing anywhere.
 *
 *   node scripts/db-counts.mjs [port] [database]
 */
import { readFileSync } from 'node:fs';

import mysql from 'mysql2/promise';

const line = readFileSync('backend/.env', 'utf8')
  .split(/\r?\n/)
  .find((row) => row.startsWith('DATABASE_URL='));

if (!line) throw new Error('DATABASE_URL is not set in backend/.env');

const url = new URL(line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, ''));

const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(process.argv[2] ?? url.port ?? 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: process.argv[3] ?? url.pathname.replace(/^\//, ''),
  connectTimeout: 20_000,
});

const [tables] = await connection.query(
  "SELECT table_name n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name",
);

const counts = {};

for (const row of tables) {
  const name = String(row.n);
  const [[result]] = await connection.query(`SELECT COUNT(*) n FROM \`${name}\``);
  const value = Number(result.n);
  if (value > 0) counts[name] = value;
}

console.log(JSON.stringify(counts, null, 2));

await connection.end();
