import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * H0 - a secret committed once is in the history forever.
 *
 * `.gitignore` only protects files nobody has added yet; `git add -f` and "stage all" both walk
 * straight past it. So the repository itself is asserted here, every test run.
 *
 * The real script is executed rather than reimplemented, so the thing under test is the thing that
 * runs in the pre-commit hook.
 */

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-secrets.mjs');
const scriptUrl = pathToFileURL(scriptPath).href;

/** Counts offences by calling the script's own matcher in a separate module-friendly process. */
function countOffences(files: string[]): number {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { findForbidden } from ${JSON.stringify(scriptUrl)};
       console.log(findForbidden(${JSON.stringify(files)}).length);`,
    ],
    { encoding: 'utf8', cwd: repoRoot },
  );

  return Number(output.trim());
}

describe('repository hygiene', () => {
  it('tracks no secrets, databases or build output', () => {
    let output = '';
    let code = 0;

    try {
      output = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8', cwd: repoRoot });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      code = failure.status ?? 1;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }

    expect(output, output).toContain('OK - no secrets');
    expect(code).toBe(0);
  });

  it('refuses every kind of file that must never be committed', () => {
    const forbidden = [
      'backend/.env',
      'backend/.env.production',
      'backend/prisma/dev.db',
      'backend/prisma/dev.db-journal',
      'backend/dist/app.js',
      'node_modules/left-pad/index.js',
      'certs/server.key',
      'backend/storage/uploads/invoice.pdf',
    ];

    expect(countOffences(forbidden)).toBe(forbidden.length);
  });

  it('leaves legitimate files alone', () => {
    expect(
      countOffences([
        'backend/.env.example',
        'frontend/web/.env.example',
        'backend/storage/uploads/.gitkeep',
        'backend/src/config/env.ts',
        'docs/PROJECT_CONTEXT.md',
      ]),
    ).toBe(0);
  });

  it('refuses a test database checked in under prisma/', () => {
    expect(countOffences(['backend/prisma/test.db'])).toBe(1);
  });

  it('allows no stock write outside inventory.service', () => {
    let output = '';
    let code = 0;

    try {
      output = execFileSync(
        process.execPath,
        [path.join(repoRoot, 'scripts', 'check-stock-writes.mjs')],
        { encoding: 'utf8', cwd: repoRoot },
      );
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      code = failure.status ?? 1;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }

    expect(output, output).toContain('OK - stockQty is only written by inventory.service');
    expect(code).toBe(0);
  });
});

describe('test database isolation', () => {
  /**
   * The database NAME, never the URL.
   *
   * These assertions used to render `DATABASE_URL`, which on MySQL carries the password. A secret
   * that only prints when a test fails still lands in a CI log, so nothing here may echo the URL,
   * the host or the credentials - `tests/no-connection-strings.test.ts` enforces that repo-wide.
   */
  const databaseName = (): string => {
    const url = process.env.DATABASE_URL ?? '';
    if (url === '') return '';

    try {
      return new URL(url).pathname.replace(/^\//, '');
    } catch {
      return '';
    }
  };

  it('does not point at the development database', () => {
    const name = databaseName();

    expect(name, 'globalSetup must set DATABASE_URL for the run').not.toBe('');
    expect(name).not.toBe('clearwood_db');
    expect(name).not.toMatch(/dev/);
  });

  it('is disposable, and named so global teardown can find it', () => {
    /*
     * Every test FILE gets its own database replayed from the seeded template, so files run in
     * parallel and cannot leak state into one another. The name carries the runner pid, the worker
     * id and a random suffix, which is also how teardown sweeps a run that died early.
     */
    expect(databaseName()).toMatch(/^clearwood_test_r\d+_/);
  });

  it('is a private database, not the shared template', () => {
    const name = databaseName();

    expect(name).not.toMatch(/^clearwood_test_tpl_/);

    const dump = process.env.CLEARWOOD_TEST_DUMP ?? '';
    expect(dump, 'globalSetup must publish the template dump path').not.toBe('');
    expect(statSync(dump).size, 'the template dump is empty').toBeGreaterThan(1_000);
  });

  it('writes here without touching any other database', async () => {
    const { prisma } = await import('../src/config/prisma');

    // Proves this database is genuinely seeded, genuinely writable and genuinely its own.
    const before = await prisma.appSetting.count();
    expect(before).toBeGreaterThan(0);

    const marker = `isolation.${process.pid}.${Date.now()}`;
    await prisma.appSetting.create({
      data: { key: marker, value: '1', valueType: 'string', group: 'test', isPublic: false },
    });

    expect(await prisma.appSetting.count()).toBe(before + 1);

    await prisma.appSetting.delete({ where: { key: marker } });
    expect(await prisma.appSetting.count()).toBe(before);
  });
});
