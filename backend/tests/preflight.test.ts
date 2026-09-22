import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The preflight is what a deployer runs before starting the process, so it has to fail when it
 * should. A check that only ever passes is worse than no check: it certifies nothing.
 *
 * Run as a subprocess, the way `check-secrets` is tested, because the script's whole job is its
 * exit code and its output.
 */

const backendRoot = path.resolve(__dirname, '..');

function runPreflight(env: NodeJS.ProcessEnv): { status: number; output: string } {
  try {
    const output = execFileSync('npx', ['tsx', 'scripts/preflight.ts'], {
      cwd: backendRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      shell: true,
    });

    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('npm run preflight', () => {
  it('examines a non-zero number of keys and reports every check', () => {
    const { output } = runPreflight({});

    // G1: a preflight that examined nothing would print an empty list and could still "pass".
    const keyCount = /\.env\.example was readable\s+—\s+(\d+) keys/.exec(output);
    expect(keyCount, 'the preflight did not report how many keys it read').not.toBeNull();
    expect(Number(keyCount![1])).toBeGreaterThan(60);

    expect(output).toContain('node ');
    expect(output).toContain('selected drivers');
    expect(output).toMatch(/\d+ checks? (passed|FAILED)/);
  }, 120_000);

  it('fails, and says why, when the database is unreachable', () => {
    const { status, output } = runPreflight({
      DATABASE_URL: 'mysql://someuser:somepass@127.0.0.1:59999/clearwood_db',
    });

    expect(status).not.toBe(0);
    expect(output).toContain('FAIL');
    expect(output).toContain('127.0.0.1:59999');
  }, 120_000);

  it('never prints a value, only key names', () => {
    const { output } = runPreflight({
      DATABASE_URL: 'mysql://someuser:hunter2@127.0.0.1:59999/clearwood_db',
    });

    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('someuser');
    expect(output).not.toContain('mysql://');
  }, 120_000);
});
