import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ALLOWED_TARGETS,
  allowedTargets,
  assertLocalTestTarget,
} from './helpers/testTarget';

/**
 * The guard that stops `npm test` from dropping databases on production.
 *
 * The dangerous case is specific and easy to get wrong: the SSH tunnel makes the hosted database
 * answer on `127.0.0.1:3307`. A hostname check passes that. So the assertions below are mostly
 * about the PORT, because the host is the part that lies.
 */

const LOCAL = 'mysql://user:pass@127.0.0.1:3306/clearwood_db';
const TUNNELLED_PRODUCTION = 'mysql://user:pass@127.0.0.1:3307/clearwood_prod';

describe('the test suite refuses a non-local target', () => {
  it('has a non-empty allowlist of host AND port', () => {
    // G1: an empty allowlist would make every rejection below vacuous.
    expect(DEFAULT_ALLOWED_TARGETS.length).toBeGreaterThan(0);
    expect(allowedTargets({})).toEqual(DEFAULT_ALLOWED_TARGETS);

    for (const target of DEFAULT_ALLOWED_TARGETS) {
      expect(target, 'every allowlist entry must carry a port').toMatch(/:\d+$/);
    }
  });

  it('accepts the local database', () => {
    const target = assertLocalTestTarget(LOCAL, {});

    expect(target.host).toBe('127.0.0.1');
    expect(target.port).toBe(3306);
    expect(target.database).toBe('clearwood_db');
  });

  it('refuses the tunnel, where the host looks local and is not', () => {
    expect(() => assertLocalTestTarget(TUNNELLED_PRODUCTION, {})).toThrow(/clearwood_prod/);
  });

  it('refuses port 3307 even when the database is not named prod', () => {
    expect(() =>
      assertLocalTestTarget('mysql://user:pass@127.0.0.1:3307/clearwood_db', {}),
    ).toThrow(/127\.0\.0\.1:3307/);
  });

  it('refuses a remote host', () => {
    expect(() => assertLocalTestTarget('mysql://user:pass@db.example.com:3306/x', {})).toThrow(
      /db\.example\.com:3306/,
    );
  });

  it('never names the user, the password or the URL in the refusal', () => {
    let message = '';

    try {
      assertLocalTestTarget('mysql://someuser:hunter2@db.example.com:3306/x', {});
    } catch (error) {
      message = String((error as Error).message);
    }

    // G1: the guard must actually have fired, or the absences below prove nothing.
    expect(message).not.toBe('');
    expect(message).toContain('db.example.com:3306');

    expect(message).not.toContain('someuser');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('mysql://');
  });

  it('can be widened deliberately, and only deliberately', () => {
    const env = { CLEARWOOD_TEST_ALLOWED_HOSTS: '127.0.0.1:3307' };

    expect(allowedTargets(env)).toEqual(['127.0.0.1:3307']);

    // Widened for the port, still refused for the database name.
    expect(() => assertLocalTestTarget(TUNNELLED_PRODUCTION, env)).toThrow(/clearwood_prod/);
    expect(assertLocalTestTarget('mysql://u:p@127.0.0.1:3307/clearwood_db', env).port).toBe(3307);
  });

  it('is actually wired into the bootstrap that creates databases', () => {
    const source = readFileSync(path.resolve(__dirname, 'global-setup.ts'), 'utf8');

    expect(source).toContain('assertLocalTestTarget');
  });
});
