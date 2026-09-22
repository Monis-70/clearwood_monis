#!/usr/bin/env node
/**
 * Refuses to let a secret or a build artefact enter git.
 *
 * Runs in two modes:
 *   --staged   what is about to be committed (use as a pre-commit hook)
 *   default    everything already tracked (use in CI, and in the test suite)
 *
 * This exists because `.gitignore` only protects files nobody has added yet: `git add -f`, an
 * editor's "stage all", or a rule added after the fact all bypass it silently. A real `.env`
 * committed once is in the history forever, so the cheap check runs every time.
 */

import { execFileSync } from 'node:child_process';

/** Anything matching these must never be tracked. */
const FORBIDDEN = [
  { pattern: /(^|\/)\.env$/, why: 'a real environment file with secrets' },
  { pattern: /(^|\/)\.env\.(?!example$)[^/]+$/, why: 'an environment file with secrets' },
  { pattern: /\.db$/, why: 'a local SQLite database' },
  { pattern: /\.db-(journal|wal|shm)$/, why: 'a SQLite journal' },
  {
    // The suite's database belongs in the OS temp directory; one inside prisma/ means the old
    // shared-file setup has come back, and with it the cross-run EPERM lock.
    pattern: /backend\/prisma\/test\.db/,
    why: 'a test database inside prisma/ (it must live in the OS temp directory)',
  },
  { pattern: /(^|\/)node_modules\//, why: 'a dependency tree' },
  { pattern: /(^|\/)(dist|build|coverage)\//, why: 'build output' },
  { pattern: /(^|\/)\.vite\//, why: 'a build cache' },
  { pattern: /\.pem$|\.key$|\.p12$|\.pfx$/, why: 'a private key' },
  {
    // The uploads folder is local storage; only its .gitkeep belongs in the repo.
    pattern: /backend\/storage\/uploads\/(?!\.gitkeep$).+/,
    why: 'a locally uploaded file',
  },
];

function tracked(staged) {
  const args = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM']
    : ['ls-files'];

  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function findForbidden(files) {
  const offences = [];

  for (const file of files) {
    const rule = FORBIDDEN.find((candidate) => candidate.pattern.test(file));
    if (rule) offences.push({ file, why: rule.why });
  }

  return offences;
}

function main() {
  const staged = process.argv.includes('--staged');
  const offences = findForbidden(tracked(staged));

  if (offences.length === 0) {
    console.log(`OK - no secrets or build artefacts ${staged ? 'staged' : 'tracked'}`);
    return;
  }

  console.error(`\nREFUSING: ${offences.length} file(s) must never be in git\n`);
  for (const offence of offences) console.error(`  ${offence.file}  - ${offence.why}`);
  console.error(
    '\nRemove it with:  git rm --cached <file>\nThen make sure .gitignore covers it.\n',
  );

  process.exit(1);
}

// Only run when invoked directly, so the test can import `findForbidden`.
if (process.argv[1]?.endsWith('check-secrets.mjs')) main();
