import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import {
  CASE_INSENSITIVE_BY_DECISION,
  CASE_SENSITIVE_COLLATION,
  CASE_SENSITIVE_COLUMNS,
} from '../src/db/caseSensitiveColumns';

/**
 * The collation contract.
 *
 * Two tests that do different jobs. The first reads `information_schema` and proves the DDL says
 * what `src/db/caseSensitiveColumns.ts` says - which is the control for the fact that Prisma has no
 * column-level collation attribute and may propose reverting it. The second proves the database
 * actually BEHAVES differently, because a shape assertion alone would pass against a schema that
 * had been declared correctly and then never used.
 */

interface CollationRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLLATION_NAME: string;
}

/**
 * The classifier that produced the register, re-run over schema.prisma.
 *
 * `id` columns and foreign keys are never candidates: both sides of a foreign key must share a
 * collation, and all 93 of them target an id.
 */
function opaqueCandidates(): string[] {
  const schema = readFileSync(path.resolve(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');

  const OPAQUE_SUFFIX = /(Hash|checksum|Checksum|Secret|Signature|Token)$/;
  const OPAQUE_EXACT = new Set([
    'checksum',
    'storageKey',
    'awbNumber',
    'activeOwnerKey',
    'idempotencyKey',
    'twoFactorSecret',
    'passwordHash',
    'blurhash',
    'utr',
    'pickupTokenNumber',
    'sessionId',
    'requestId',
  ]);
  const PROVIDER = /^provider[A-Z]/;
  const HUMAN = new Set(['email', 'phone', 'altPhone', 'slug', 'code', 'sku', 'name', 'title']);

  const candidates: string[] = [];
  let model: string | null = null;
  let fks = new Set<string>();
  let pending: { field: string; isId: boolean }[] = [];

  const flush = (): void => {
    for (const entry of pending) {
      if (entry.isId || fks.has(entry.field) || HUMAN.has(entry.field)) continue;

      const opaque =
        OPAQUE_EXACT.has(entry.field) ||
        OPAQUE_SUFFIX.test(entry.field) ||
        PROVIDER.test(entry.field) ||
        entry.field === 'key';

      if (opaque) candidates.push(`${model}.${entry.field}`);
    }
    pending = [];
    fks = new Set();
  };

  for (const line of schema.split(/\r?\n/)) {
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      model = open[1]!;
      continue;
    }
    if (model && /^\}/.test(line)) {
      flush();
      model = null;
      continue;
    }
    if (!model) continue;

    const relation = /@relation\([^)]*fields:\s*\[([^\]]+)\]/.exec(line);
    if (relation) for (const name of relation[1]!.split(',')) fks.add(name.trim());

    const field = /^\s+(\w+)\s+String(\??)\s*(.*)$/.exec(line);
    if (field) pending.push({ field: field[1]!, isId: /@id\b/.test(field[3]!) });
  }

  flush();
  return candidates;
}

describe('case-sensitive columns', () => {
  it('leaves no opaque column undecided', () => {
    const candidates = opaqueCandidates();

    // G1: both lists must be real, and the classifier must have had something to read.
    expect(candidates.length).toBeGreaterThan(50);
    expect(CASE_SENSITIVE_COLUMNS.length).toBeGreaterThan(30);
    expect(CASE_INSENSITIVE_BY_DECISION.length).toBeGreaterThan(5);

    const decided = new Set([
      ...CASE_SENSITIVE_COLUMNS.map((entry) => `${entry.table}.${entry.column}`),
      ...CASE_INSENSITIVE_BY_DECISION.map((entry) => `${entry.table}.${entry.column}`),
    ]);

    expect(
      candidates.filter((name) => !decided.has(name)),
      'These columns look opaque - a digest, a provider id, a key - but appear in neither list. ' +
        'Add each to CASE_SENSITIVE_COLUMNS, or to CASE_INSENSITIVE_BY_DECISION with a reason. ' +
        'The register cannot notice a new column on its own; this is what does.',
    ).toEqual([]);

    // And the inverse: a decision recorded for a column that no longer exists is stale.
    const stale = [...decided].filter((name) => !candidates.includes(name));
    expect(stale, 'Decisions recorded for columns the classifier no longer sees.').toEqual([]);
  });

  it('declares utf8mb4_bin on every column in the register', async () => {
    // G1: an empty register would make the loop below assert nothing at all.
    expect(CASE_SENSITIVE_COLUMNS.length).toBeGreaterThan(30);

    const rows = await prisma.$queryRawUnsafe<CollationRow[]>(
      `SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND collation_name IS NOT NULL`,
    );

    const found = new Map(
      rows.map((row) => [`${row.TABLE_NAME}.${row.COLUMN_NAME}`, row.COLLATION_NAME]),
    );

    // G1: a renamed column must fail loudly, not vanish from the comparison.
    expect(found.size).toBeGreaterThan(800);

    const missing: string[] = [];
    const wrong: string[] = [];

    for (const entry of CASE_SENSITIVE_COLUMNS) {
      const name = `${entry.table}.${entry.column}`;
      const collation = found.get(name);

      if (collation === undefined) missing.push(name);
      else if (collation !== CASE_SENSITIVE_COLLATION) wrong.push(`${name} is ${collation}`);
    }

    expect(missing, 'These registered columns do not exist. Rename in the register too.').toEqual(
      [],
    );
    expect(
      wrong,
      'Prisma cannot express column collation, so a migrate dev may have reverted these. ' +
        'Re-apply COLLATE utf8mb4_bin in the migration - see PROJECT_CONTEXT §38.',
    ).toEqual([]);
  });

  it('keeps the rest of the database case-insensitive', async () => {
    const rows = await prisma.$queryRawUnsafe<{ c: string; n: bigint }[]>(
      `SELECT collation_name c, COUNT(*) n
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND collation_name IS NOT NULL
        GROUP BY collation_name`,
    );

    const tally = new Map(rows.map((row) => [row.c, Number(row.n)]));

    expect(tally.get(CASE_SENSITIVE_COLLATION)).toBe(CASE_SENSITIVE_COLUMNS.length);
    expect(tally.get('utf8mb4_unicode_ci')).toBeGreaterThan(700);
    expect([...tally.keys()].sort()).toEqual(['utf8mb4_bin', 'utf8mb4_unicode_ci']);
  });

  it('treats two digests differing only in case as different rows', async () => {
    const stem = `A${Math.random().toString(36).slice(2, 10)}`;
    const lower = `${stem.toLowerCase()}`.padEnd(64, 'a').slice(0, 64);
    const upper = lower.toUpperCase();

    // G1: the two values must actually differ only in case, or this proves nothing.
    expect(lower).not.toBe(upper);
    expect(lower.toLowerCase()).toBe(upper.toLowerCase());

    const base = {
      principalType: 'CUSTOMER',
      principalId: `collation-${stem}`,
      familyId: `fam-${stem}`,
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    };

    // A UNIQUE case-sensitive column: both must be insertable.
    await prisma.refreshToken.create({ data: { ...base, tokenHash: lower } });
    await prisma.refreshToken.create({ data: { ...base, tokenHash: upper } });

    const both = await prisma.refreshToken.findMany({
      where: { principalId: base.principalId },
      select: { tokenHash: true },
    });
    expect(both).toHaveLength(2);

    // And a lookup for one must not return the other.
    const exact = await prisma.refreshToken.findMany({ where: { tokenHash: lower } });
    expect(exact).toHaveLength(1);
    expect(exact[0]!.tokenHash).toBe(lower);

    await prisma.refreshToken.deleteMany({ where: { principalId: base.principalId } });
  });

  it('treats two non-unique opaque keys differing only in case as different rows', async () => {
    const stem = Math.random().toString(36).slice(2, 10);
    const lower = `${stem}`.padEnd(64, 'b').slice(0, 64);
    const upper = lower.toUpperCase();

    const base = {
      scope: `collation-${stem}`,
      principalType: 'ADMIN',
      method: 'POST',
      path: '/collation',
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    };

    await prisma.idempotencyKey.create({ data: { ...base, key: `k1-${stem}`, requestHash: lower } });
    await prisma.idempotencyKey.create({ data: { ...base, key: `k2-${stem}`, requestHash: upper } });

    const matched = await prisma.idempotencyKey.findMany({ where: { requestHash: lower } });

    expect(matched).toHaveLength(1);
    expect(matched[0]!.requestHash).toBe(lower);

    await prisma.idempotencyKey.deleteMany({ where: { scope: base.scope } });
  });

  it('still folds case on a value a human types', async () => {
    const code = `COLLATE${Date.now()}${Math.floor(Math.random() * 1000)}`;

    await prisma.coupon.create({
      data: { code: code.toUpperCase(), name: 'Collation', type: 'FIXED', valuePaise: 100 },
    });

    // The inverse proof: a coupon code is case-INSENSITIVE, so the lower-case twin must collide.
    await expect(
      prisma.coupon.create({
        data: { code: code.toLowerCase(), name: 'Collation twin', type: 'FIXED', valuePaise: 100 },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const found = await prisma.coupon.findMany({ where: { code: code.toLowerCase() } });
    expect(found, 'a coupon code must be findable whatever case it is typed in').toHaveLength(1);

    await prisma.coupon.deleteMany({ where: { code: code.toUpperCase() } });
  });
});
