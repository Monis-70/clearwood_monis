// Writes the module-type markers that Node needs to read dist/cjs as CommonJS and dist/esm as ESM.
// The ESM output keeps extensionless relative imports, so it is intended for bundlers (Vite);
// Node consumers (the backend) use the CommonJS output.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const [dir, type] of [
  ['cjs', 'commonjs'],
  ['esm', 'module'],
]) {
  const target = join(root, 'dist', dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`, 'utf8');
}

console.log('[shared] wrote dist/cjs/package.json and dist/esm/package.json');
