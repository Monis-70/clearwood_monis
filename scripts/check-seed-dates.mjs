#!/usr/bin/env node
// ASCII only. Unicode in a guard script has broken parsing here before.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Fails if a seed file reads the wall clock.
 *
 * Seeded data that moves with Date.now() makes the database a function of WHEN it was created: a
 * demo cart idle for a different number of hours every day, a countdown deal that expires a week
 * after whoever ran the seed, a bug report from Tuesday that cannot be reproduced on Thursday.
 *
 * Every seeded date is derived from prisma/seed/epoch.ts instead. That file is the one place
 * allowed to construct a Date from a string.
 */

const SEED_DIR = 'backend/prisma/seed/';
const EXEMPT = new Set(['backend/prisma/seed/epoch.ts']);

const PATTERNS = [
  {
    // Date.now() anywhere.
    test: /\bDate\.now\s*\(\s*\)/,
    message: 'Date.now() - use epochPlus/epochMinus from ./epoch instead',
  },
  {
    // `new Date()` with no argument. `new Date(something)` is fine.
    test: /\bnew\s+Date\s*\(\s*\)/,
    message: 'bare new Date() - use SEED_EPOCH from ./epoch instead',
  },
];

function trackedSeedFiles() {
  const out = execFileSync('git', ['ls-files', `${SEED_DIR}**`], { encoding: 'utf8' });

  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.ts'))
    .filter((line) => !EXEMPT.has(line));
}

export function findWallClockDates(files) {
  const offences = [];

  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    source.split('\n').forEach((line, index) => {
      // A line that is only a comment is documentation, not behaviour.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;

      for (const pattern of PATTERNS) {
        if (pattern.test.test(line)) {
          offences.push(`${file}:${index + 1}  ${pattern.message}`);
        }
      }
    });
  }

  return offences;
}

function main() {
  const files = trackedSeedFiles();

  if (files.length === 0) {
    console.error('FAIL - no seed files found; this guard is not actually checking anything');
    process.exit(1);
  }

  const offences = findWallClockDates(files);

  if (offences.length > 0) {
    console.error('FAIL - seed files must not read the wall clock:\n');
    for (const offence of offences) console.error(`  ${offence}`);
    console.error('\nDerive dates from prisma/seed/epoch.ts (SEED_EPOCH, epochPlus, epochMinus).');
    process.exit(1);
  }

  console.log(`OK - ${files.length} seed files are time-anchored`);
}

if (process.argv[1] && process.argv[1].endsWith('check-seed-dates.mjs')) main();
