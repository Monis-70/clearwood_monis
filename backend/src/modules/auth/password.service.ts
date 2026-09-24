import argon2 from 'argon2';

import { DEV_ADMIN_PASSWORD, env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../utils/AppError';

/**
 * R10 — argon2id with OWASP's second recommended profile (19 MiB, t=2, p=1).
 * Every failure path runs a real verify so an attacker cannot tell "no such user" from
 * "wrong password" by timing.
 */

/**
 * Production parameters. These are the security control and must not be weakened.
 *
 * The TEST profile exists only because the suite hashes hundreds of passwords to build fixtures,
 * and 19 MiB of memory-hard work each time dominated the runtime for no coverage whatsoever. It is
 * selected by NODE_ENV alone, and `password-params.test.ts` asserts that a production environment
 * gets the production numbers — so this can never be silently loosened on a live box.
 *
 * Timing-equalisation still holds under the test profile: both paths do the same cheap work.
 */
const PRODUCTION_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * argon2's own minimums: memoryCost 1024 KiB, timeCost 2. Still a real argon2id hash — 19x less
 * memory than production, which is what made it slow, and nothing else is relaxed.
 */
const TEST_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 1_024,
  timeCost: 2,
  parallelism: 1,
} as const;

export function argon2Options(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): typeof PRODUCTION_OPTIONS | typeof TEST_OPTIONS {
  return nodeEnv === 'test' ? TEST_OPTIONS : PRODUCTION_OPTIONS;
}

const OPTIONS = argon2Options();

/** Hash of a throwaway secret, used to burn the same CPU time when an account does not exist. */
let dummyHash: string | null = null;

const COMMON_PASSWORDS = new Set([
  '123456789',
  '1234567890',
  'password',
  'password1',
  'password123',
  'qwertyuiop',
  'qwerty12345',
  'admin12345',
  'administrator',
  'welcome123',
  'letmein123',
  'iloveyou123',
  'changeme123',
  'clearwood123',
  'furniture123',
  'abcd123456',
  '1q2w3e4r5t',
  'asdfghjkl',
  'monkey12345',
  'trustno1234',
]);

export const passwordService = {
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, OPTIONS);
  },

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch (error) {
      logger.warn({ err: error }, 'password verification failed to run');
      return false;
    }
  },

  /** Call when no account matched so the response time matches a real verification. */
  async verifyDummy(plain: string): Promise<false> {
    dummyHash ??= await argon2.hash('clearwood-timing-equaliser', OPTIONS);
    await this.verify(dummyHash, plain);
    return false;
  },

  /** True when the stored hash was produced with weaker parameters than the current profile. */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, OPTIONS);
    } catch {
      return true;
    }
  },

  /**
   * The development bootstrap password is committed to this repository, so it is public. It may
   * seed a development database; nobody may choose it, and production refuses to sign in with it.
   */
  isPublishedPlaceholder(plain: string): boolean {
    return plain.trim().toLowerCase() === DEV_ADMIN_PASSWORD.toLowerCase();
  },

  /**
   * Contextual strength policy. The length rule also lives in Zod so the client sees it, but this
   * is the authority because it can compare against the account's own email and phone.
   */
  assertPolicy(
    password: string,
    context: { email?: string | null; phone?: string | null } = {},
  ): void {
    const issues: string[] = [];
    const normalised = password.trim().toLowerCase();

    if (password.length < env.PASSWORD_MIN_LENGTH) {
      issues.push(`must be at least ${env.PASSWORD_MIN_LENGTH} characters`);
    }
    if (COMMON_PASSWORDS.has(normalised)) {
      issues.push('is too common');
    }
    if (this.isPublishedPlaceholder(password)) {
      issues.push('is the published development placeholder');
    }
    if (/^(.)\1+$/.test(normalised)) {
      issues.push('must not be a single repeated character');
    }
    if (context.email && normalised === context.email.toLowerCase()) {
      issues.push('must not be your email address');
    }
    if (context.email) {
      const localPart = context.email.split('@')[0]?.toLowerCase();
      if (localPart && localPart.length >= 4 && normalised === localPart) {
        issues.push('must not be your email address');
      }
    }
    if (context.phone && normalised === context.phone.toLowerCase()) {
      issues.push('must not be your phone number');
    }

    if (issues.length > 0) {
      throw AppError.validation(`Password ${issues[0]}`, {
        field: 'password',
        issues,
      });
    }
  },
};
