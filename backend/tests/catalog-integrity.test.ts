import { randomUUID } from 'node:crypto';

import {
  productCreateSchema,
  productListQuerySchema,
  variantCreateSchema,
} from '@shared/schemas/catalogAdmin';
import { productMediaAttachSchema } from '@shared/schemas/media';
import { beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import { combinationKeyOf } from '../src/modules/catalog-admin/variantOptions';
import { importService } from '../src/modules/catalog-admin/import-export/import.service';
import { productAdminService } from '../src/modules/catalog-admin/product.admin.service';
import { variantAdminService } from '../src/modules/catalog-admin/variant.admin.service';
import { productMediaService } from '../src/modules/media/product-media.service';
import { orderBy } from '../src/repositories/helpers';
import { runConcurrently } from './helpers/concurrency';

/**
 * Prompt 3 — catalog invariants that must hold no matter which code path (or which race)
 * writes the row: one default variant, one primary image, one primary category, one variant
 * per option combination, reusable slugs after soft delete, and deterministic list ordering.
 */

const tag = () => randomUUID().slice(0, 8);

async function freshProduct(name = `Integrity Bench ${tag()}`) {
  return productAdminService.create(productCreateSchema.parse({ sku: `INT-${tag()}`, name }));
}

async function freshVariant(productId: string, extra: Record<string, unknown> = {}) {
  return variantAdminService.create(
    productId,
    variantCreateSchema.parse({ sku: `INTV-${tag()}`, ...extra }),
  );
}

/** Two variant-defining attributes whose ids sort differently from their creation order. */
async function freshOptions() {
  const suffix = tag();
  const make = async (code: string, values: string[]) =>
    prisma.attribute.create({
      data: {
        code: `${code}-${suffix}`,
        name: code,
        inputType: 'SELECT',
        isVariantDefining: true,
        values: {
          create: values.map((value, position) => ({ code: value, label: value, position })),
        },
      },
      include: { values: { orderBy: { position: 'asc' } } },
    });

  return { finish: await make('finish', ['teak', 'walnut']), size: await make('size', ['s', 'l']) };
}

async function checkNames(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT CONSTRAINT_NAME AS name FROM information_schema.CHECK_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()`;
  return rows.map((row) => row.name);
}

let categoryIds: string[];
let mediaIds: string[];

beforeAll(async () => {
  const categories = await prisma.category.findMany({
    where: { deletedAt: null, parentId: null },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    take: 3,
    select: { id: true },
  });
  categoryIds = categories.map((row) => row.id);

  const media = await prisma.media.findMany({
    where: { deletedAt: null, status: 'READY' },
    orderBy: { id: 'asc' },
    take: 4,
    select: { id: true },
  });
  mediaIds = media.map((row) => row.id);
});

/* --------------------------------------------------------------- database level */

describe('the database refuses invalid catalog state on its own', () => {
  it('ships every CHECK constraint the invariants depend on', async () => {
    expect(await checkNames()).toEqual(
      expect.arrayContaining([
        'ProductVariant_defaultMark_check',
        'ProductCategory_primaryMark_check',
        'ProductMedia_primaryMark_check',
      ]),
    );
  });

  it('allows at most one default variant per product', async () => {
    const product = await freshProduct();
    await prisma.productVariant.create({
      data: { productId: product.id, sku: `RAW-${tag()}`, isDefault: true, defaultMark: true },
    });

    await expect(
      prisma.productVariant.create({
        data: { productId: product.id, sku: `RAW-${tag()}`, isDefault: true, defaultMark: true },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('refuses a default flag that disagrees with its mark', async () => {
    const product = await freshProduct();

    await expect(
      prisma.productVariant.create({
        data: { productId: product.id, sku: `RAW-${tag()}`, isDefault: true, defaultMark: null },
      }),
    ).rejects.toThrow(/ProductVariant_defaultMark_check/);
    await expect(
      prisma.productVariant.create({
        data: { productId: product.id, sku: `RAW-${tag()}`, isDefault: false, defaultMark: true },
      }),
    ).rejects.toThrow(/ProductVariant_defaultMark_check/);
  });

  it('allows at most one primary image and one primary category per product', async () => {
    const product = await freshProduct();
    await prisma.productMedia.create({
      data: { productId: product.id, mediaId: mediaIds[0]!, role: 'PRIMARY', primaryMark: true },
    });
    await expect(
      prisma.productMedia.create({
        data: { productId: product.id, mediaId: mediaIds[1]!, role: 'PRIMARY', primaryMark: true },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.productMedia.create({
        data: { productId: product.id, mediaId: mediaIds[1]!, role: 'PRIMARY', primaryMark: null },
      }),
    ).rejects.toThrow(/ProductMedia_primaryMark_check/);

    await prisma.productCategory.create({
      data: {
        productId: product.id,
        categoryId: categoryIds[0]!,
        isPrimary: true,
        primaryMark: true,
      },
    });
    await expect(
      prisma.productCategory.create({
        data: {
          productId: product.id,
          categoryId: categoryIds[1]!,
          isPrimary: true,
          primaryMark: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.productCategory.create({
        data: {
          productId: product.id,
          categoryId: categoryIds[1]!,
          isPrimary: true,
          primaryMark: null,
        },
      }),
    ).rejects.toThrow(/ProductCategory_primaryMark_check/);
  });

  it('allows one live variant per option combination', async () => {
    const product = await freshProduct();
    const key = combinationKeyOf([{ attributeId: 'a', attributeValueId: 'b' }]);
    await prisma.productVariant.create({
      data: { productId: product.id, sku: `RAW-${tag()}`, combinationKey: key },
    });

    await expect(
      prisma.productVariant.create({
        data: { productId: product.id, sku: `RAW-${tag()}`, combinationKey: key },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

/* ------------------------------------------------------------------ service level */

describe('combination keys', () => {
  it('are independent of pair order and distinct per value', () => {
    const a = { attributeId: 'size', attributeValueId: 'l' };
    const b = { attributeId: 'finish', attributeValueId: 'teak' };

    expect(combinationKeyOf([a, b])).toBe(combinationKeyOf([b, a]));
    expect(combinationKeyOf([a, b])).toMatch(/^[0-9a-f]{64}$/);
    expect(combinationKeyOf([a])).not.toBe(combinationKeyOf([b]));
    expect(combinationKeyOf([])).toBeNull();
  });
});

describe('variant writes', () => {
  it('refuse a second variant with the same options, whatever the order', async () => {
    const product = await freshProduct();
    const { finish, size } = await freshOptions();
    const teakLarge = [
      { attributeId: finish.id, attributeValueId: finish.values[0]!.id },
      { attributeId: size.id, attributeValueId: size.values[1]!.id },
    ];

    await freshVariant(product.id, { attributeValues: teakLarge });
    await expect(
      freshVariant(product.id, { attributeValues: [...teakLarge].reverse() }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'VARIANT_COMBINATION_EXISTS' });

    // A different combination is fine; editing it onto the taken one is not.
    const walnutLarge = await freshVariant(product.id, {
      attributeValues: [
        { attributeId: finish.id, attributeValueId: finish.values[1]!.id },
        { attributeId: size.id, attributeValueId: size.values[1]!.id },
      ],
    });
    await expect(
      variantAdminService.update(product.id, walnutLarge.id, {
        version: walnutLarge.version,
        attributeValues: teakLarge,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'VARIANT_COMBINATION_EXISTS' });
  });

  it('free a combination when the variant holding it is deleted', async () => {
    const product = await freshProduct();
    const { finish } = await freshOptions();
    const teak = [{ attributeId: finish.id, attributeValueId: finish.values[0]!.id }];

    const first = await freshVariant(product.id, { attributeValues: teak });
    await variantAdminService.remove(product.id, first.id);

    await expect(freshVariant(product.id, { attributeValues: teak })).resolves.toBeTruthy();
  });

  it('reject a value that does not belong to its attribute, or two values for one attribute', async () => {
    const product = await freshProduct();
    const { finish, size } = await freshOptions();

    await expect(
      freshVariant(product.id, {
        attributeValues: [{ attributeId: finish.id, attributeValueId: size.values[0]!.id }],
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      freshVariant(product.id, {
        attributeValues: [
          { attributeId: finish.id, attributeValueId: finish.values[0]!.id },
          { attributeId: finish.id, attributeValueId: finish.values[1]!.id },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('keep exactly one default when defaults are created and switched in sequence', async () => {
    const product = await freshProduct();
    await freshVariant(product.id, { isDefault: true });
    const second = await freshVariant(product.id, { isDefault: true });
    const third = await freshVariant(product.id);
    await variantAdminService.setDefault(product.id, third.id);

    const defaults = await prisma.productVariant.findMany({
      where: { productId: product.id, isDefault: true },
      select: { id: true },
    });
    expect(defaults.map((row) => row.id)).toEqual([third.id]);
    expect(second.id).not.toBe(third.id);
  });

  it('keep exactly one default when a CSV import marks several rows default', async () => {
    const product = await freshProduct();
    await freshVariant(product.id, { isDefault: true });
    const [a, b] = [`CSV-${tag()}`, `CSV-${tag()}`];
    const csv = [
      'sku,productSku,isDefault',
      `${a},${product.sku},true`,
      `${b},${product.sku},true`,
    ].join('\n');

    const job = await importService.createJob(
      'VARIANT',
      { buffer: Buffer.from(csv), originalName: 'variants.csv' },
      false,
      null,
    );
    expect(job.status).toBe('COMPLETED');

    const defaults = await prisma.productVariant.findMany({
      where: { productId: product.id, isDefault: true },
      select: { sku: true },
    });
    expect(defaults).toEqual([{ sku: b }]);
  });
});

/* --------------------------------------------------------------------- concurrency */

describe('concurrent admin writes never leave invalid state', () => {
  it('two-or-more simultaneous "make default" calls end with exactly one default', async () => {
    const product = await freshProduct();
    const variants: Awaited<ReturnType<typeof freshVariant>>[] = [];
    for (let index = 0; index < 4; index += 1) variants.push(await freshVariant(product.id));

    const result = await runConcurrently(variants.length, (index) =>
      variantAdminService.setDefault(product.id, variants[index]!.id),
    );

    expect(result.infra, result.reasons.join('; ')).toBe(0);
    expect(result.ok + result.contended).toBe(variants.length);
    expect(
      await prisma.productVariant.count({ where: { productId: product.id, isDefault: true } }),
    ).toBe(1);
    expect(
      await prisma.productVariant.count({ where: { productId: product.id, defaultMark: true } }),
    ).toBe(1);
  });

  it('simultaneous creates of one combination produce exactly one variant', async () => {
    const product = await freshProduct();
    const { finish } = await freshOptions();
    const teak = [{ attributeId: finish.id, attributeValueId: finish.values[0]!.id }];

    const result = await runConcurrently(4, () =>
      freshVariant(product.id, { attributeValues: teak }),
    );

    expect(result.infra, result.reasons.join('; ')).toBe(0);
    expect(result.ok).toBe(1);
    expect(result.reasons).toEqual(['AppError VARIANT_COMBINATION_EXISTS']);
    expect(
      await prisma.productVariant.count({ where: { productId: product.id, deletedAt: null } }),
    ).toBe(1);
  });

  it('simultaneous primary-image attaches leave exactly one primary', async () => {
    expect(mediaIds.length).toBeGreaterThanOrEqual(3);
    const product = await freshProduct();

    const result = await runConcurrently(mediaIds.length, (index) =>
      productMediaService.attach(
        product.id,
        productMediaAttachSchema.parse({ items: [{ mediaId: mediaIds[index], role: 'PRIMARY' }] }),
      ),
    );

    expect(result.infra, result.reasons.join('; ')).toBe(0);
    expect(result.ok).toBe(mediaIds.length);
    expect(
      await prisma.productMedia.count({ where: { productId: product.id, role: 'PRIMARY' } }),
    ).toBe(1);
    expect(await prisma.productMedia.count({ where: { productId: product.id } })).toBe(
      mediaIds.length,
    );
  });

  it('simultaneous category assignments leave exactly one primary category', async () => {
    const product = await freshProduct();

    const result = await runConcurrently(categoryIds.length, (index) =>
      productAdminService.setCategories(product.id, {
        primaryCategoryId: categoryIds[index]!,
        categoryIds,
      }),
    );

    expect(result.infra, result.reasons.join('; ')).toBe(0);
    expect(
      await prisma.productCategory.count({ where: { productId: product.id, isPrimary: true } }),
    ).toBe(1);
  });
});

/* ---------------------------------------------------------------------------- slugs */

describe('slugs of soft-deleted products', () => {
  it('can be reused, and a restore reclaims the slug or takes the next free one', async () => {
    const name = `Reusable Bench ${tag()}`;
    const original = await freshProduct(name);
    const slug = original.slug;

    await productAdminService.softDelete(original.id);
    const tombstone = await prisma.product.findUniqueOrThrow({ where: { id: original.id } });
    expect(tombstone.slug).toBe(`deleted-${original.id}`);
    expect(tombstone.deletedSlug).toBe(slug);

    const replacement = await freshProduct(name);
    expect(replacement.slug).toBe(slug);

    const restored = await productAdminService.restore(original.id);
    expect(restored.slug).toBe(`${slug}-2`);
    expect((await productAdminService.get(replacement.id)).slug).toBe(slug);

    // With the name free again, a restore gets its own slug back.
    await productAdminService.softDelete(replacement.id);
    const back = await productAdminService.restore(replacement.id);
    expect(back.slug).toBe(slug);
  });

  it('soft delete and restore are idempotent', async () => {
    const product = await freshProduct();
    await productAdminService.softDelete(product.id);
    await productAdminService.softDelete(product.id);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).deletedSlug,
    ).toBe(product.slug);

    const restored = await productAdminService.restore(product.id);
    expect(restored.slug).toBe(product.slug);
    const again = await productAdminService.restore(product.id);
    expect(again.slug).toBe(product.slug);
  });
});

/* ------------------------------------------------------------------------- ordering */

describe('list ordering is deterministic', () => {
  it('appends the id tie-breaker unless the ordering already names id', () => {
    expect(orderBy('name', 'desc', ['name'] as const, [{ name: 'asc' }])).toEqual([
      { name: 'desc' },
      { id: 'asc' },
    ]);
    expect(orderBy(undefined, 'asc', ['name', 'id'] as const, [{ id: 'desc' }])).toEqual([
      { id: 'desc' },
    ]);
  });

  it('pages through products with equal sort values without overlap or reordering', async () => {
    const marker = `Tie Stool ${tag()}`;
    const ids: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const product = await productAdminService.create(
        productCreateSchema.parse({
          sku: `TIE-${tag()}`,
          name: `${marker} ${index}`,
          basePricePaise: 1_000_00,
        }),
      );
      ids.push(product.id);
    }

    const walk = async () => {
      const seen: string[] = [];
      for (let page = 1; page <= 4; page += 1) {
        const result = await productAdminService.list(
          productListQuerySchema.parse({
            q: marker,
            sort: 'basePricePaise',
            order: 'asc',
            limit: 2,
            page,
          }),
        );
        seen.push(...result.items.map((item) => item.id));
      }
      return seen;
    };

    const first = await walk();
    expect(new Set(first).size).toBe(first.length);
    expect([...first].sort()).toEqual([...ids].sort());
    expect(first).toEqual([...ids].sort());
    expect(await walk()).toEqual(first);
  });
});
