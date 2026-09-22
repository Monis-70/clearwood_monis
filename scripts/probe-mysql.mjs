// Phase 0 probe: reports what the target server actually is. Reads DATABASE_URL, prints no secret.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import mysql from 'mysql2/promise';

const envPath = path.resolve(process.cwd(), 'backend', '.env');
const line = readFileSync(envPath, 'utf8')
  .split(/\r?\n/)
  .find((row) => row.startsWith('DATABASE_URL='));

if (!line) throw new Error('DATABASE_URL not found in backend/.env');

const url = new URL(line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, ''));

const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
  connectTimeout: 15_000,
});

const scalar = async (sql) => {
  const [rows] = await connection.query(sql);
  return rows[0];
};

console.log('HOST', url.hostname + ':' + (url.port || 3306), 'DB', url.pathname.slice(1));
console.log('VERSION', JSON.stringify(await scalar('SELECT VERSION() v, @@version_comment c')));
console.log(
  'CHARSET',
  JSON.stringify(
    await scalar(
      'SELECT @@character_set_server cs, @@collation_server co, @@character_set_database dcs, @@collation_database dco',
    ),
  ),
);
console.log('SQL_MODE', JSON.stringify(await scalar('SELECT @@sql_mode m')));
console.log(
  'TIME',
  JSON.stringify(await scalar('SELECT @@time_zone tz, @@system_time_zone stz, NOW() now6')),
);
console.log(
  'LIMITS',
  JSON.stringify(
    await scalar(
      'SELECT @@max_connections mc, @@innodb_lock_wait_timeout lwt, @@transaction_isolation iso, @@max_allowed_packet map, @@innodb_ft_min_token_size ftmin',
    ),
  ),
);
console.log('USER', JSON.stringify(await scalar('SELECT CURRENT_USER() cu, USER() u')));

const [grants] = await connection.query('SHOW GRANTS FOR CURRENT_USER()');
console.log('GRANTS', JSON.stringify(grants.map((row) => Object.values(row)[0])));

const probeDb = `clearwood_shadow_probe_${Date.now()}`;
let canCreate = false;
try {
  await connection.query(`CREATE DATABASE \`${probeDb}\``);
  canCreate = true;
  await connection.query(`DROP DATABASE \`${probeDb}\``);
} catch (error) {
  console.log('CREATE_DB_ERROR', error.code, error.message);
}
console.log('CAN_CREATE_DROP_DATABASE', canCreate);

const [dbs] = await connection.query('SHOW DATABASES');
console.log('DATABASES', JSON.stringify(dbs.map((row) => Object.values(row)[0])));

const [tables] = await connection.query(
  'SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE()',
);
console.log('EXISTING_TABLES', tables[0].n);

// 20 round trips, so the budgets can be turned into real milliseconds.
const samples = [];
for (let i = 0; i < 20; i += 1) {
  const started = process.hrtime.bigint();
  await connection.query('SELECT 1');
  samples.push(Number(process.hrtime.bigint() - started) / 1e6);
}
samples.sort((a, b) => a - b);
const at = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
console.log(
  'LATENCY_MS',
  JSON.stringify({
    min: +samples[0].toFixed(2),
    median: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    max: +samples[samples.length - 1].toFixed(2),
  }),
);

await connection.end();
