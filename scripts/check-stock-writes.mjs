#!/usr/bin/env node
/**
 * Refuses any write to `ProductVariant.stockQty` outside `inventory.service.ts`.
 *
 * `inventory.service` is the single writer by design: it compare-and-sets the balance and records
 * an `InventoryLedger` row in the same transaction, so every movement is auditable. A bare
 * `productVariant.update({ data: { stockQty } })` anywhere else silently breaks that, and the
 * damage (stock that disagrees with its own history) surfaces weeks later as a mis-sold item.
 *
 * Creating a variant AT zero is allowed: that is establishing a starting balance, not moving stock.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The one file permitted to move stock. */
const OWNER = path.join('backend', 'src', 'modules', 'catalog-admin', 'inventory.service.ts');

const SEARCH_ROOTS = [
  path.join('backend', 'src'),
  path.join('backend', 'tests'),
  path.join('backend', 'prisma', 'seed'),
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

/** `stockQty:` inside a `data:` payload is a write; anywhere else it is a read or a filter. */
const WRITE_PATTERN = /\bstockQty\s*:/;
const ALLOWED_INITIAL = /\bstockQty\s*:\s*0\b/;

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;

    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|tsx|mts)$/.test(entry)) files.push(full);
  }

  return files;
}

/**
 * Finds `stockQty:` assignments that sit inside a Prisma `data:` block.
 *
 * Deliberately simple: it scans backwards a few lines for `data:` rather than parsing TypeScript.
 * A false positive is a two-second look by a human; a missed write is a silent stock bug.
 */
export function findStockWrites(source, relativePath) {
  if (relativePath.replace(/\//g, path.sep) === OWNER) return [];

  const lines = source.split(/\r?\n/);
  const offences = [];

  lines.forEach((line, index) => {
    if (!WRITE_PATTERN.test(line)) return;
    if (ALLOWED_INITIAL.test(line)) return;

    const context = lines.slice(Math.max(0, index - 6), index + 1).join('\n');
    if (!/\bdata\s*:/.test(context)) return;

    offences.push({
      file: relativePath,
      line: index + 1,
      text: line.trim().slice(0, 120),
    });
  });

  return offences;
}

function main() {
  const offences = [];

  for (const root of SEARCH_ROOTS) {
    for (const file of walk(path.join(repoRoot, root))) {
      const relative = path.relative(repoRoot, file).replace(/\\/g, '/');
      offences.push(...findStockWrites(readFileSync(file, 'utf8'), relative));
    }
  }

  if (offences.length === 0) {
    console.log('OK - stockQty is only written by inventory.service');
    return;
  }

  console.error(`\nREFUSING: ${offences.length} stock write(s) outside inventory.service\n`);
  for (const offence of offences) {
    console.error(`  ${offence.file}:${offence.line}  ${offence.text}`);
  }
  console.error(
    '\ninventory.service.adjust() is the only writer: it compare-and-sets the balance and',
    '\nrecords an InventoryLedger row in the same transaction. In tests use',
    '\ntests/helpers/stock.ts (setStockForProduct / setStockForVariant).\n',
  );

  process.exit(1);
}

if (process.argv[1]?.endsWith('check-stock-writes.mjs')) main();
