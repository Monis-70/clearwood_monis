import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Production refuses to boot while a secret is still the value shipped in `.env.example`.
 *
 * Several secrets are knowingly placeholders during development, which is fine, and catastrophic
 * in production. A note in a document will not survive the next six prompts, so this is the same
 * mechanism the UNVERIFIED shipping driver already uses: the process simply does not start.
 *
 * The placeholder list is DERIVED from `.env.example` rather than typed out a second time. A
 * second hardcoded copy would drift, and the copy that drifts is always the one doing the
 * checking.
 *
 * It names EVERY offending key at once. Someone fixing this at two in the morning needs the list,
 * not the first item of it. It prints key NAMES only - never a value, not even masked.
 */

/** Every key that must not still hold its shipped placeholder in production. */
export const GUARDED_SECRETS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'ADMIN_JWT_ACCESS_SECRET',
  'ADMIN_JWT_REFRESH_SECRET',
  'CART_COOKIE_SECRET',
  'MEDIA_SIGNING_SECRET',
  'ADMIN_SEED_PASSWORD',
  'ADMIN_SEED_EMAIL',
] as const;

/** Short enough that swapping a placeholder for "abc" does not pass. */
const MINIMUM_LENGTH: Record<string, number> = {
  ADMIN_SEED_EMAIL: 6,
  ADMIN_SEED_PASSWORD: 12,
};

const DEFAULT_MINIMUM_LENGTH = 32;

export function readExamplePlaceholders(exampleFile: string): Map<string, string> {
  const placeholders = new Map<string, string>();
  if (!existsSync(exampleFile)) return placeholders;

  for (const line of readFileSync(exampleFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const value = match[2]!.trim().replace(/^["']|["']$/g, '');
    if (value !== '') placeholders.set(match[1]!, value);
  }

  return placeholders;
}

export interface SecretProblem {
  key: string;
  reason: 'still the placeholder from .env.example' | 'too short to be a real secret' | 'not set';
}

export function findPlaceholderSecrets(
  env: NodeJS.ProcessEnv,
  placeholders: Map<string, string>,
): SecretProblem[] {
  const problems: SecretProblem[] = [];

  for (const key of GUARDED_SECRETS) {
    const value = env[key];

    if (value === undefined || value === '') {
      problems.push({ key, reason: 'not set' });
      continue;
    }

    if (placeholders.get(key) === value) {
      problems.push({ key, reason: 'still the placeholder from .env.example' });
      continue;
    }

    if (value.length < (MINIMUM_LENGTH[key] ?? DEFAULT_MINIMUM_LENGTH)) {
      problems.push({ key, reason: 'too short to be a real secret' });
    }
  }

  return problems;
}

export function describeSecretProblems(problems: SecretProblem[]): string {
  const lines = problems.map((problem) => `  - ${problem.key}: ${problem.reason}`);

  return (
    'Refusing to start in production while these secrets are unsafe:\n' +
    `${lines.join('\n')}\n` +
    'Set a real value for each. The placeholders are the ones shipped in backend/.env.example.'
  );
}

/** A no-op outside production. Throws, naming every offending key, inside it. */
export function assertProductionSecrets(
  env: NodeJS.ProcessEnv = process.env,
  exampleFile = path.resolve(__dirname, '..', '..', '.env.example'),
): void {
  if (env.NODE_ENV !== 'production') return;

  const problems = findPlaceholderSecrets(env, readExamplePlaceholders(exampleFile));
  if (problems.length === 0) return;

  throw new Error(describeSecretProblems(problems));
}
