import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';

import { argon2Options, passwordService } from '../src/modules/auth/password.service';

/**
 * Prompt B1 Task 3 — the test suite hashes hundreds of passwords, and argon2's production profile
 * is memory-hard by design, so it dominated the runtime for no coverage at all.
 *
 * The cheap profile is therefore selected by NODE_ENV. This file is the guard that stops that
 * becoming a silent weakening of a real security control: if anyone ever makes the cheap profile
 * reachable in production, these fail.
 */

describe('argon2 parameters', () => {
  it('uses the OWASP profile in production', () => {
    const options = argon2Options('production');

    expect(options.memoryCost).toBe(19_456);
    expect(options.timeCost).toBe(2);
    expect(options.parallelism).toBe(1);
    expect(options.type).toBe(argon2.argon2id);
  });

  it('uses the OWASP profile in development and staging', () => {
    for (const environment of ['development', 'staging', 'production']) {
      const options = argon2Options(environment);

      expect(options.memoryCost, `NODE_ENV=${environment}`).toBe(19_456);
      expect(options.timeCost).toBe(2);
    }
  });

  /**
   * The dangerous case: NODE_ENV unset on a live box. The default parameter reads process.env, so
   * this has to be exercised the way it actually happens rather than by passing `undefined`.
   */
  it('uses the OWASP profile when NODE_ENV is not set at all', () => {
    const original = process.env.NODE_ENV;

    try {
      delete process.env.NODE_ENV;
      const options = argon2Options();

      expect(options.memoryCost).toBe(19_456);
      expect(options.timeCost).toBe(2);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('only relaxes memory under NODE_ENV=test, and still uses argon2id', () => {
    const options = argon2Options('test');

    expect(options.memoryCost).toBeLessThan(19_456);
    expect(options.type).toBe(argon2.argon2id);
    // G1: "cheaper" must still be argon2's real minimum, not zero.
    expect(options.memoryCost).toBeGreaterThanOrEqual(1_024);
    expect(options.timeCost).toBeGreaterThanOrEqual(2);
  });

  it('produces a verifiable argon2id hash under the test profile', async () => {
    const hash = await passwordService.hash('Rosewood-Teak-2026');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await passwordService.verify(hash, 'Rosewood-Teak-2026')).toBe(true);
    expect(await passwordService.verify(hash, 'wrong-password')).toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    const [first, second] = await Promise.all([
      passwordService.hash('Rosewood-Teak-2026'),
      passwordService.hash('Rosewood-Teak-2026'),
    ]);

    expect(first.length).toBeGreaterThan(40);
    expect(second).not.toBe(first);
  });
});
