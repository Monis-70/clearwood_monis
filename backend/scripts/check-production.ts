import path from 'node:path';

import dotenv from 'dotenv';

import {
  describeSecretProblems,
  findPlaceholderSecrets,
  readExamplePlaceholders,
} from '../src/config/productionSecrets';

/**
 * `npm run check:production` — the refusal the app performs at boot, run on demand.
 *
 * Deliberately NOT part of `npm run check`: it fails by design while the placeholders are still in
 * place, and a check people learn to ignore is worse than no check at all.
 */

const backendRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(backendRoot, '.env') });

const problems = findPlaceholderSecrets(
  process.env,
  readExamplePlaceholders(path.join(backendRoot, '.env.example')),
);

if (problems.length === 0) {
  console.log('OK - every production secret has a real value');
  process.exit(0);
}

console.error(describeSecretProblems(problems));
process.exit(1);
