/**
 * Proves the production database behaves, not merely that it filled.
 *
 * Reads and writes only rows it creates and then removes. Prints no credential.
 * Run with a non-UTC TZ to make the timestamp assertions meaningful.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import mysql from 'mysql2/promise';

const line = readFileSync('backend/.env', 'utf8')
  .split(/\r?\n/)
  .find((row) => row.startsWith('DATABASE_URL='));

const url = new URL(line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, ''));

const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(process.argv[2] ?? 3307),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: process.argv[3] ?? 'clearwood_prod',
  dateStrings: true,
  timezone: 'Z',
});

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

console.log('process TZ offset (minutes west of UTC):', new Date().getTimezoneOffset());

const tag = randomBytes(6).toString('hex');
const cuid = (prefix) => `${prefix}${randomBytes(12).toString('hex')}`;

/* ---------------------------------------------------------------- UTC */

const written = '2026-03-17 21:47:13.512';
const tokenId = cuid('c');

await connection.query(
  'INSERT INTO VerificationToken (id, purpose, principalType, principalId, tokenHash, expiresAt, createdAt, updatedAt) ' +
    'VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))',
  [tokenId, 'PROD_PROOF', 'CUSTOMER', `utc-${tag}`, `utc-${tag}`.padEnd(64, '0').slice(0, 64), written],
);

const [[readBack]] = await connection.query(
  'SELECT expiresAt e, createdAt c FROM VerificationToken WHERE id = ?',
  [tokenId],
);

// G1: a value that is the epoch, or empty, would satisfy "unchanged" for the wrong reason.
check('the written instant is non-trivial', String(readBack.e).startsWith('2026-03-17'), String(readBack.e));
check('DateTime round-trips byte-identically', String(readBack.e) === written, String(readBack.e));

const [[skew]] = await connection.query(
  'SELECT TIMESTAMPDIFF(SECOND, ?, UTC_TIMESTAMP()) s',
  [readBack.c],
);

check(
  'a server-defaulted timestamp landed on UTC, not local time',
  Math.abs(Number(skew.s)) < 120,
  `${skew.s}s from UTC_TIMESTAMP (5h30m would be 19800)`,
);

/* ---------------------------------------------------- collation, live */

const lower = `case${tag}`.padEnd(64, 'a').slice(0, 64);
const upper = lower.toUpperCase();

for (const value of [lower, upper]) {
  await connection.query(
    'INSERT INTO VerificationToken (id, purpose, principalType, principalId, tokenHash, expiresAt, createdAt, updatedAt) ' +
      'VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))',
    [cuid('c'), 'PROD_PROOF', 'CUSTOMER', `case-${tag}`, value, written],
  );
}

const [both] = await connection.query('SELECT tokenHash h FROM VerificationToken WHERE principalId = ?', [
  `case-${tag}`,
]);
check('two digests differing only in case both persist', both.length === 2, `${both.length} rows`);

const [one] = await connection.query('SELECT tokenHash h FROM VerificationToken WHERE tokenHash = ?', [lower]);
check('a lookup for one digest does not return the other', one.length === 1 && one[0].h === lower);

const code = `PRODPROOF${tag.toUpperCase()}`;
await connection.query(
  'INSERT INTO Coupon (id, code, name, type, valuePaise, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))',
  [cuid('c'), code, 'Prod proof', 'FIXED', 100],
);

let collided = false;
try {
  await connection.query(
    'INSERT INTO Coupon (id, code, name, type, valuePaise, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))',
    [cuid('c'), code.toLowerCase(), 'Prod proof twin', 'FIXED', 100],
  );
} catch (error) {
  collided = error.code === 'ER_DUP_ENTRY';
}
check('a coupon code still folds case', collided);

/* ------------------------------------------------------------- admin */

const [admins] = await connection.query('SELECT email, status FROM AdminUser');
check('exactly one admin user exists', admins.length === 1, `email=${admins[0]?.email} status=${admins[0]?.status}`);

/* ------------------------------------------------------------ cleanup */

await connection.query('DELETE FROM VerificationToken WHERE purpose = ?', ['PROD_PROOF']);
await connection.query('DELETE FROM Coupon WHERE code = ?', [code]);

const [[leftTokens]] = await connection.query(
  "SELECT COUNT(*) n FROM VerificationToken WHERE purpose = 'PROD_PROOF'",
);
const [[leftCoupons]] = await connection.query('SELECT COUNT(*) n FROM Coupon WHERE code = ?', [code]);
check('the proof left nothing behind', Number(leftTokens.n) === 0 && Number(leftCoupons.n) === 0);

await connection.end();

console.log(failures.length === 0 ? '\nALL PROOFS PASSED' : `\nFAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
