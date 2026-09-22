import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * No test may put a connection string where a human or a CI log will see it.
 *
 * `repo-hygiene.test.ts` used to render `DATABASE_URL` into an assertion message. On SQLite that
 * was a file path; on MySQL it is `mysql://user:password@host/db`, so the database password
 * printed on every failure of that test. A secret that leaks only on failure still leaks, and a
 * CI log is exactly where it lands.
 *
 * The rule is therefore mechanical rather than a matter of care: a raw connection string, or the
 * environment variable that holds one, may not be interpolated into an assertion message, a
 * console call, or a thrown Error. Reading the URL is fine - printing it is not.
 */

const testsDir = __dirname;

const URL_BEARING = String.raw`(?:DATABASE_URL|SHADOW_DATABASE_URL|CLEARWOOD_TEST_ADMIN_URL|CLEARWOOD_TEST_DATABASE_URL|adminUrl|connectionString|mysql:\/\/)`;

/** An expect() whose message argument mentions a URL, a console call, or a thrown Error. */
const PATTERNS: { name: string; regex: RegExp }[] = [
  {
    name: 'an assertion message',
    regex: new RegExp(String.raw`expect\([^)]*,\s*[^)]*${URL_BEARING}`, 'g'),
  },
  {
    name: 'a console call',
    regex: new RegExp(String.raw`console\.\w+\([^)]*${URL_BEARING}`, 'g'),
  },
  {
    name: 'a thrown Error',
    regex: new RegExp(String.raw`throw new \w*Error\([^)]*${URL_BEARING}`, 'g'),
  },
  {
    name: 'an expect() subject that is the URL itself',
    regex: new RegExp(String.raw`expect\(\s*(?:process\.env\.)?${URL_BEARING}`, 'g'),
  },
];

export function findConnectionStringLeaks(files: string[]): string[] {
  const leaks: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');

    source.split(/\r?\n/).forEach((line, index) => {
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;

      /*
       * Plain quoted strings are dropped first, so prose that merely NAMES the variable -
       * "globalSetup must set DATABASE_URL" - is not a leak. Template literals survive, because
       * they are the thing that can interpolate the value.
       */
      const code = line.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');

      for (const { name, regex } of PATTERNS) {
        regex.lastIndex = 0;
        if (regex.test(code)) {
          leaks.push(`${path.basename(file)}:${index + 1} puts a connection string in ${name}`);
          return;
        }
      }
    });
  }

  return leaks;
}

function collectTestFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);

    if (statSync(full).isDirectory()) {
      files.push(...collectTestFiles(full));
      continue;
    }

    if (full.endsWith('.ts')) files.push(full);
  }

  return files;
}

const files = collectTestFiles(testsDir).filter(
  (file) => path.basename(file) !== 'no-connection-strings.test.ts',
);

describe('no test renders a connection string', () => {
  it('scanned the whole test tree', () => {
    // G1: every assertion below is vacuously true if the scanner found nothing to read.
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((file) => file.endsWith('repo-hygiene.test.ts'))).toBe(true);
  });

  it('catches a file that does render one', () => {
    // Written to temp rather than committed, so the repo never carries a file shaped like a leak.
    const fixture = path.join(mkdtempSync(path.join(os.tmpdir(), 'cw-leak-')), 'leaky.test.ts');

    writeFileSync(
      fixture,
      [
        "import { expect } from 'vitest';",
        "expect(url, `pointed at ${process.env.DATABASE_URL}`).toBe('x');",
      ].join('\n'),
    );

    try {
      const offenders = findConnectionStringLeaks([fixture]);

      expect(offenders.length, 'the guard did not fire on a file that leaks').toBeGreaterThan(0);
      expect(offenders.join(' ')).toContain('an assertion message');
    } finally {
      rmSync(path.dirname(fixture), { recursive: true, force: true });
    }
  });

  it('finds no leak in the real test tree', () => {
    expect(
      findConnectionStringLeaks(files),
      'A connection string carries the database password. Assert on the database NAME instead: ' +
        'new URL(process.env.DATABASE_URL).pathname.',
    ).toEqual([]);
  });
});
