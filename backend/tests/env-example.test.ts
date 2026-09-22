/**
 * `backend/.env.example` and the env schema must not drift apart.
 *
 * The example file is not documentation. `config/productionSecrets.ts` DERIVES its placeholder
 * list from it, so a key missing here is a key production will happily boot on with a leaked
 * development secret, and a value edited here silently changes what production refuses.
 *
 * A drifted example file is also how a deployment fails at two in the morning: the deployer copies
 * it, fills in what it lists, and discovers the missing key only when the process exits.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GUARDED_SECRETS, readExamplePlaceholders } from '../src/config/productionSecrets';

const backendRoot = path.resolve(__dirname, '..');
const exampleFile = path.join(backendRoot, '.env.example');
const schemaSource = readFileSync(path.join(backendRoot, 'src', 'config', 'env.ts'), 'utf8');

/**
 * Keys read straight from `process.env` rather than through the Zod schema, so they are legitimate
 * entries in the example file that the schema will never declare. Each one is deliberate.
 */
const OUTSIDE_THE_SCHEMA = new Set([
  // Prisma reads it itself, from the datasource block in schema.prisma.
  'SHADOW_DATABASE_URL',
  // prisma/seed/epoch.ts reads it, and the seed runs outside the app.
  'SEED_EPOCH',
  // Resolved per request so it can be toggled without a restart - see queryCount middleware.
  'DEBUG_QUERY_COUNT',
  // The test bootstrap reads these before any src/ module is imported.
  'CLEARWOOD_TEST_DATABASE_URL',
  'CLEARWOOD_TEST_ALLOWED_HOSTS',
]);

/** Keys the schema declares, and whether it supplies a default or marks them optional. */
function schemaKeys(): { key: string; required: boolean }[] {
  const keys: { key: string; required: boolean }[] = [];
  const lines = schemaSource.split(/\r?\n/);

  lines.forEach((line, index) => {
    // `KEY: z` may be followed by the rest of the chain on later lines.
    const match = /^\s{4}([A-Z][A-Z0-9_]+):\s*z\b/.exec(line);
    if (!match) return;

    let declaration = line;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^\s{4}[A-Z][A-Z0-9_]+:\s*z\b/.test(lines[next]!) || /^\s{2}\}\)/.test(lines[next]!)) break;
      declaration += lines[next]!;
    }

    keys.push({
      key: match[1]!,
      required: !/\.default\(|\.optional\(\)/.test(declaration),
    });
  });

  return keys;
}

const declared = schemaKeys();
const example = readExamplePlaceholders(exampleFile);
const exampleKeys = new Set(
  readFileSync(exampleFile, 'utf8')
    .split(/\r?\n/)
    .map((line) => /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1])
    .filter((key): key is string => Boolean(key)),
);

describe('.env.example matches the env schema', () => {
  it('compared a realistic number of keys', () => {
    // G1: a parser that found nothing would make every assertion below vacuous.
    expect(declared.length).toBeGreaterThan(60);
    expect(exampleKeys.size).toBeGreaterThan(60);
    expect(OUTSIDE_THE_SCHEMA.size).toBeGreaterThan(0);
  });

  it('lists every key the schema declares', () => {
    const missing = declared
      .filter((entry) => !exampleKeys.has(entry.key))
      .map((entry) => `${entry.key}${entry.required ? ' (REQUIRED - no default)' : ''}`);

    expect(
      missing,
      'A deployer copying .env.example would never know these keys exist.',
    ).toEqual([]);
  });

  it('lists nothing the schema has never heard of', () => {
    const known = new Set(declared.map((entry) => entry.key));

    // Documented-but-unused keys are how a deployer sets something that does nothing.
    const unknown = [...exampleKeys].filter(
      (key) => !known.has(key) && !OUTSIDE_THE_SCHEMA.has(key),
    );

    expect(
      unknown,
      'Keys in .env.example that nothing reads. Add them to OUTSIDE_THE_SCHEMA with a reason if ' +
        'they are consumed directly from process.env.',
    ).toEqual([]);
  });

  it('gives every guarded secret a placeholder to be refused on', () => {
    // The coupling productionSecrets.ts depends on: no placeholder, nothing to detect.
    for (const key of GUARDED_SECRETS) {
      expect(example.get(key), `${key} must carry a placeholder value in .env.example`).toBeTruthy();
    }
  });

  it('contains no value that looks like a real credential', () => {
    const suspicious: string[] = [];

    for (const [key, value] of example) {
      if (/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(value)) suspicious.push(key);
      if (/^rzp_(live|test)_/.test(value)) suspicious.push(key);
      if (/^sk_live_/.test(value)) suspicious.push(key);
    }

    expect(suspicious, 'These entries look like real credentials.').toEqual([]);
  });
});
