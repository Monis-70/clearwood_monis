import { execSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';

/**
 * The suite's database is created by tests/global-setup.ts, which runs the seed once. This file
 * runs it a second time and proves nothing is duplicated and nothing editorial is overwritten.
 */

const SEEDED_MODELS = [
  'appSetting',
  'taxClass',
  'attributeGroup',
  'attribute',
  'attributeValue',
  'category',
  'categoryAttribute',
  'collection',
  'navigationMenu',
  'navigationItem',
  'media',
  'product',
  'productCategory',
  'productAttributeValue',
  'productVariant',
  'variantAttributeValue',
  'productMedia',
  'priceAdjustment',
] as const;

type SeededModel = (typeof SEEDED_MODELS)[number];

async function rowCounts(): Promise<Record<SeededModel, number>> {
  const entries = await Promise.all(
    SEEDED_MODELS.map(async (model) => {
      const delegate = prisma[model] as unknown as { count(): Promise<number> };
      return [model, await delegate.count()] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<SeededModel, number>;
}

function runSeed(): void {
  execSync('npx prisma db seed', {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // Inherited, never hardcoded: global-setup allocates a unique database per run.
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      SEED_DEMO: 'true',
      LOG_LEVEL: 'silent',
    },
    stdio: 'pipe',
  });
}

const EDITED_NAME = 'Sofas — edited by an admin';
let originalName = 'Sofas';

describe('seed idempotency', () => {
  let before: Record<SeededModel, number>;

  beforeAll(async () => {
    before = await rowCounts();

    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    originalName = sofas.name;
    await prisma.category.update({ where: { id: sofas.id }, data: { name: EDITED_NAME } });

    runSeed();
  }, 180_000);

  afterAll(async () => {
    await prisma.category.update({ where: { slug: 'sofas' }, data: { name: originalName } });
  });

  it('does not create a single duplicate row in any seeded table', async () => {
    /**
     * G1: `after === before` also holds when every table is empty and the seed silently did
     * nothing. Prove the snapshot describes a populated database first.
     */
    const empty = Object.entries(before)
      .filter(([, count]) => count === 0)
      .map(([model]) => model);

    expect(Object.keys(before).length, 'no tables were counted').toBeGreaterThanOrEqual(18);
    expect(empty, 'these seeded tables have no rows, so comparing them proves nothing').toEqual([]);

    expect(await rowCounts()).toStrictEqual(before);
  });

  it('seeded the expected number of categories from the site map', () => {
    expect(before.category).toBe(111);
  });

  it('preserves an admin-edited category name (R8)', async () => {
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    expect(sofas.name).toBe(EDITED_NAME);
  });

  it('keeps structural columns in sync even when content is preserved', async () => {
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    expect(sofas.path).toBe('sofas');
    expect(sofas.depth).toBe(0);
    expect(sofas.kind).toBe('STANDARD');
  });
});
