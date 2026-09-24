import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GUARDED_SECRETS,
  assertProductionSecrets,
  findPlaceholderSecrets,
  readExamplePlaceholders,
} from '../src/config/productionSecrets';

/**
 * Production must not start while a secret is still the value shipped in `.env.example`.
 *
 * The placeholders are knowingly in place during development, which is why this cannot be a note
 * in a document: the note would be true and ignored. The process refuses to start, and it names
 * EVERY offending key at once because the person reading it is usually mid-deploy.
 */

const exampleFile = path.resolve(__dirname, '..', '.env.example');
const placeholders = readExamplePlaceholders(exampleFile);

/** The values actually shipped, so the test cannot drift from what the guard reads. */
const shipped = Object.fromEntries(
  GUARDED_SECRETS.map((key) => [key, placeholders.get(key) ?? '']),
);

describe('production refuses to boot on a placeholder secret', () => {
  it('derives the placeholders from .env.example rather than a second copy', () => {
    // G1: an empty map would make every rejection below vacuous.
    expect(placeholders.size).toBeGreaterThan(20);
    expect(GUARDED_SECRETS.length).toBeGreaterThan(5);

    for (const key of GUARDED_SECRETS) {
      expect(placeholders.get(key), `${key} has no placeholder in .env.example`).toBeTruthy();
    }
  });

  it('names every offending key, not just the first', () => {
    const problems = findPlaceholderSecrets(
      { NODE_ENV: 'production', ...shipped },
      placeholders,
    );

    expect(problems.length).toBe(GUARDED_SECRETS.length);
    expect(problems.map((problem) => problem.key).sort()).toEqual([...GUARDED_SECRETS].sort());

    for (const problem of problems) {
      expect(problem.reason).toBe('still the placeholder from .env.example');
    }
  });

  it('refuses a short replacement, so swapping a placeholder for "abc" does not pass', () => {
    const problems = findPlaceholderSecrets(
      { ...shipped, JWT_ACCESS_SECRET: 'abc' },
      placeholders,
    );

    const jwt = problems.find((problem) => problem.key === 'JWT_ACCESS_SECRET');
    expect(jwt?.reason).toBe('too short to be a real secret');
  });

  it('accepts real values', () => {
    const real = Object.fromEntries(
      GUARDED_SECRETS.map((key) => [
        key,
        key === 'ADMIN_SEED_EMAIL' ? 'owner@clearwoodfurnitures.com' : 'x'.repeat(48),
      ]),
    );

    expect(findPlaceholderSecrets(real, placeholders)).toEqual([]);
  });

  it('throws in production, and the message carries no value', () => {
    let message = '';

    try {
      assertProductionSecrets({ NODE_ENV: 'production', ...shipped }, exampleFile);
    } catch (error) {
      message = String((error as Error).message);
    }

    // G1: the guard must have fired, or the absences below prove nothing.
    expect(message).not.toBe('');

    for (const key of GUARDED_SECRETS) expect(message).toContain(key);

    for (const value of Object.values(shipped)) {
      // The email placeholder is also a key-shaped word; only secrets must be absent.
      if (value === shipped.ADMIN_SEED_EMAIL) continue;
      expect(message, 'the refusal leaked a secret value').not.toContain(value);
    }
  });

  it('does nothing outside production', () => {
    for (const nodeEnv of ['development', 'test', 'staging']) {
      expect(() => assertProductionSecrets({ NODE_ENV: nodeEnv, ...shipped }, exampleFile)).not.toThrow();
    }
  });

  it('lets the app boot in development with the placeholders still in place', async () => {
    const { createApp } = await import('../src/app');

    // G1: proves the boot reached app construction, not merely that nothing threw.
    const app = createApp();
    expect(typeof app.listen).toBe('function');
  });
});
