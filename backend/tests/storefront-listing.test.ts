import { randomUUID } from 'node:crypto';

import { applyBasisPoints } from '@shared/money';
import { bulkActionSchema, priceAdjustmentCreateSchema } from '@shared/schemas/catalogAdmin';
import { storefrontListQuerySchema } from '@shared/schemas/storefront';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { catalogEvents } from '../src/events/catalogEvents';
import { bulkActionService } from '../src/modules/catalog-admin/bulkAction.service';
import { catalogCacheService } from '../src/modules/catalog-admin/catalogCache.service';
import { importService } from '../src/modules/catalog-admin/import-export/import.service';
import { inventoryService } from '../src/modules/catalog-admin/inventory.service';
import { priceAdjustmentAdminService } from '../src/modules/catalog-admin/priceAdjustment.admin.service';
import { productAdminService } from '../src/modules/catalog-admin/product.admin.service';
import { variantAdminService } from '../src/modules/catalog-admin/variant.admin.service';
import { combinationKeyOf } from '../src/modules/catalog-admin/variantOptions';
import { pricingFacade } from '../src/modules/pricing/pricing.facade';
import { listingIndexService } from '../src/modules/storefront/listingIndex.service';
import { listingCacheKey, storefrontFacade } from '../src/modules/storefront/storefront.facade';
import { mark } from '../src/utils/uniqueMark';

import { runConcurrently } from './helpers/concurrency';

/**
 * Prompt 4 - the SQL listing: every filter, sort and page is decided by MySQL, the navigation
 * price comes from the catalog's listing index, displayed prices are quoted per caller, cached
 * grids never cross shoppers and every write that changes a card or its order reaches the grid.
 *
 * All fixtures live under a category tree of their own, so exact sets can be asserted.
 */

const app = createApp();
const API = '/api/v1';
const tag = randomUUID().slice(0, 6);

interface Card {
  id: string;
  slug: string;
  name: string;
  pricePaise: number;
  indexedMinPricePaise: number | null;
  inStock: boolean;
  [key: string]: unknown;
}
interface Listing {
  items: Card[];
  facets: { key: string; values: { value: string; count: number; selected: boolean }[] }[];
  totalCount: number;
  pricingBasis: string;
  priceBounds: { minPaise: number; maxPaise: number };
}

async function list(params: Record<string, string | number | boolean>): Promise<Listing> {
  const response = await request(app)
    .get(`${API}/catalog/products`)
    .query({ limit: 96, ...params });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as Listing;
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  return value;
}

/* ------------------------------------------------------------------ fixture */

const keys = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11'] as const;
type Key = (typeof keys)[number];

const ids = {} as Record<Key, string>;
const slugOf = (key: Key) => `${key}-${tag}`;
const defaultVariant = {} as Record<Key, string>;
let root: { id: string; slug: string };
let a: { id: string; slug: string };
let a1: { id: string; slug: string };
let b: { id: string; slug: string };
let brandA: string;
let brandB: string;
let brandUnused: string;
const value = {} as Record<string, string>;

async function category(name: string, parent?: { id: string; path: string; depth: number }) {
  const slug = `lt-${name}-${tag}`;
  return prisma.category.create({
    data: {
      name: `LT ${name}`,
      slug,
      parentId: parent?.id ?? null,
      path: parent ? `${parent.path}/${slug}` : slug,
      depth: parent ? parent.depth + 1 : 0,
    },
  });
}

async function attribute(code: string, codes: string[], variantDefining: boolean) {
  return prisma.attribute.create({
    data: {
      code: `${code}-${tag}`,
      name: code,
      inputType: 'SELECT',
      isVariantDefining: variantDefining,
      isFilterable: true,
      showInSwatch: code === 'finish',
      values: { create: codes.map((entry, position) => ({ code: entry, label: entry, position })) },
    },
    include: { values: true },
  });
}

interface VariantSpec {
  options: string[];
  pricePaise?: number;
  stockQty?: number;
  reservedQty?: number;
  allowBackorder?: boolean;
  isActive?: boolean;
}

interface ProductSpec {
  name: string;
  categories: { id: string; position?: number }[];
  brandId: string;
  basePricePaise: number;
  variants: VariantSpec[];
  specs?: string[];
  status?: string;
  visibility?: string;
  publishedAt?: Date;
  deleted?: boolean;
  isMadeToOrder?: boolean;
  compareAtPricePaise?: number;
  ratingAvgBp?: number;
  ratingCount?: number;
  soldCount?: number;
  position?: number;
  popularity?: number;
}

const optionAttribute = new Map<string, string>();

async function product(key: Key, spec: ProductSpec): Promise<void> {
  const created = await prisma.product.create({
    data: {
      sku: `LT-${key}-${tag}`,
      slug: slugOf(key),
      name: `${spec.name} ${tag}`,
      status: spec.status ?? 'ACTIVE',
      visibility: spec.visibility ?? 'PUBLIC',
      brandId: spec.brandId,
      basePricePaise: spec.basePricePaise,
      compareAtPricePaise: spec.compareAtPricePaise ?? null,
      isMadeToOrder: spec.isMadeToOrder ?? false,
      ratingAvgBp: spec.ratingAvgBp ?? 0,
      ratingCount: spec.ratingCount ?? 0,
      soldCount: spec.soldCount ?? 0,
      position: spec.position ?? 0,
      publishedAt: spec.publishedAt ?? new Date(Date.UTC(2026, 0, 1 + keys.indexOf(key))),
      deletedAt: spec.deleted ? new Date() : null,
    },
  });
  ids[key] = created.id;

  for (const [index, link] of spec.categories.entries()) {
    await prisma.productCategory.create({
      data: {
        productId: created.id,
        categoryId: link.id,
        isPrimary: index === 0,
        primaryMark: mark(index === 0),
        position: link.position ?? 0,
      },
    });
  }

  for (const [index, variant] of spec.variants.entries()) {
    const pairs = variant.options.map((code) => ({
      attributeId: optionAttribute.get(code)!,
      attributeValueId: value[code]!,
    }));
    const row = await prisma.productVariant.create({
      data: {
        productId: created.id,
        sku: `LT-${key}-${tag}-${index}`,
        position: index,
        isDefault: index === 0,
        defaultMark: mark(index === 0),
        pricePaise: variant.pricePaise ?? null,
        stockQty: variant.stockQty ?? 5,
        reservedQty: variant.reservedQty ?? 0,
        allowBackorder: variant.allowBackorder ?? false,
        isActive: variant.isActive ?? true,
        combinationKey: combinationKeyOf(pairs),
        attributeValues: { create: pairs },
      },
    });
    if (index === 0) defaultVariant[key] = row.id;
  }

  for (const code of spec.specs ?? []) {
    await prisma.productAttributeValue.create({
      data: {
        productId: created.id,
        attributeId: optionAttribute.get(code)!,
        attributeValueId: value[code]!,
      },
    });
  }

  if (spec.popularity !== undefined) {
    await prisma.productStat.create({
      data: { productId: created.id, popularityScore: spec.popularity },
    });
  }
}

const listed: Key[] = ['p1', 'p2', 'p3', 'p4', 'p5', 'p10'];

beforeAll(async () => {
  const top = await category('root');
  const left = await category('a', top);
  const leaf = await category('a1', left);
  const right = await category('b', top);
  root = top;
  a = left;
  a1 = leaf;
  b = right;

  const brands = await Promise.all(
    ['alpha', 'beta', 'unused'].map((name) =>
      prisma.brand.create({ data: { name: `LT ${name}`, slug: `lt-${name}-${tag}` } }),
    ),
  );
  [brandA, brandB, brandUnused] = brands.map((row) => row.id) as [string, string, string];

  const finish = await attribute('finish', ['teak', 'walnut', 'oak'], true);
  const size = await attribute('size', ['s', 'l'], true);
  const material = await attribute('material', ['sheesham', 'mango'], false);
  for (const [attribute, position] of [
    [finish, 1],
    [size, 2],
    [material, 3],
  ] as const) {
    await prisma.categoryAttribute.create({
      data: {
        categoryId: top.id,
        attributeId: attribute.id,
        isVariantDefining: attribute.isVariantDefining,
        isFilterable: true,
        position,
      },
    });
    for (const entry of attribute.values) {
      value[entry.code] = entry.id;
      optionAttribute.set(entry.code, attribute.id);
    }
  }

  const past = (day: number) => new Date(Date.UTC(2026, 1, day));
  await product('p1', {
    name: 'Alpha',
    categories: [{ id: leaf.id }, { id: top.id, position: 5 }],
    brandId: brandA,
    basePricePaise: 10_000_00,
    variants: [{ options: ['teak', 's'] }, { options: ['walnut', 'l'], pricePaise: 15_000_00 }],
    specs: ['sheesham'],
    ratingAvgBp: 45_000,
    ratingCount: 10,
    soldCount: 40,
    position: 10,
    popularity: 50,
    publishedAt: past(3),
  });
  await product('p2', {
    name: 'Bravo',
    categories: [{ id: right.id }, { id: top.id, position: 0 }],
    brandId: brandB,
    basePricePaise: 20_000_00,
    compareAtPricePaise: 25_000_00,
    variants: [{ options: ['oak', 's'], stockQty: 0 }],
    specs: ['mango'],
    ratingAvgBp: 32_000,
    ratingCount: 4,
    soldCount: 30,
    position: 20,
    popularity: 90,
    publishedAt: past(1),
  });
  await product('p3', {
    name: 'Charlie',
    categories: [{ id: left.id }],
    brandId: brandA,
    basePricePaise: 30_000_00,
    variants: [{ options: ['walnut', 'l'], stockQty: 0 }],
    isMadeToOrder: true,
    ratingAvgBp: 45_000,
    ratingCount: 3,
    soldCount: 7,
    position: 1,
    publishedAt: past(9),
  });
  await product('p4', {
    name: 'Delta',
    categories: [{ id: right.id }],
    brandId: brandB,
    basePricePaise: 12_000_00,
    variants: [{ options: ['teak', 'l'], stockQty: 2, reservedQty: 2 }],
    soldCount: 7,
    position: 3,
    publishedAt: past(5),
  });
  await product('p5', {
    name: 'Echo',
    categories: [{ id: leaf.id }],
    brandId: brandA,
    basePricePaise: 8_000_00,
    variants: [{ options: ['walnut', 's'], stockQty: 0, allowBackorder: true }],
    soldCount: 7,
    position: 2,
    publishedAt: past(7),
  });
  await product('p6', {
    name: 'Draft',
    categories: [{ id: left.id }],
    brandId: brandA,
    basePricePaise: 1_000_00,
    variants: [{ options: ['teak', 's'] }],
    status: 'DRAFT',
  });
  await product('p7', {
    name: 'Scheduled',
    categories: [{ id: left.id }],
    brandId: brandA,
    basePricePaise: 1_000_00,
    variants: [{ options: ['teak', 's'] }],
    publishedAt: new Date(Date.now() + 7 * 86_400_000),
  });
  await product('p8', {
    name: 'Hidden',
    categories: [{ id: left.id }],
    brandId: brandA,
    basePricePaise: 1_000_00,
    variants: [{ options: ['teak', 's'] }],
    visibility: 'HIDDEN',
  });
  await product('p9', {
    name: 'Deleted',
    categories: [{ id: left.id }],
    brandId: brandA,
    basePricePaise: 1_000_00,
    variants: [{ options: ['teak', 's'] }],
    deleted: true,
  });
  await product('p10', {
    name: 'Foxtrot',
    categories: [{ id: right.id }],
    brandId: brandB,
    basePricePaise: 18_000_00,
    variants: [{ options: ['oak', 'l'], isActive: false }],
    position: 4,
    publishedAt: past(2),
  });
  await product('p11', {
    name: 'Golf',
    categories: [{ id: right.id }],
    brandId: brandB,
    basePricePaise: 9_000_00,
    variants: [{ options: ['oak', 'l'] }],
    status: 'DRAFT',
  });

  const media = await prisma.media.findFirstOrThrow({
    where: { status: 'READY', deletedAt: null },
    orderBy: { id: 'asc' },
  });
  await prisma.productMedia.create({
    data: { productId: ids.p1, mediaId: media.id, role: 'PRIMARY', primaryMark: true },
  });

  for (const key of keys) await listingIndexService.refresh(ids[key]);
  await catalogCacheService.invalidateStorefront();
}, 120_000);

const setOf = (listing: Listing) => new Set(listing.items.map((item) => item.slug));
const slugs = (...wanted: Key[]) => new Set(wanted.map(slugOf));

/* ------------------------------------------------------------------ filtering */

describe('filtering happens in MySQL', () => {
  it('scopes to a category and every category below it', async () => {
    expect(setOf(await list({ categorySlug: root.slug }))).toEqual(slugs(...listed));
    expect(setOf(await list({ categorySlug: a.slug }))).toEqual(slugs('p1', 'p3', 'p5'));
    expect(setOf(await list({ categorySlug: a1.slug }))).toEqual(slugs('p1', 'p5'));
    expect(setOf(await list({ categorySlug: b.slug }))).toEqual(slugs('p2', 'p4', 'p10'));
  });

  it('never lists drafts, scheduled, hidden or deleted products', async () => {
    const shown = setOf(await list({ categorySlug: root.slug }));
    for (const key of ['p6', 'p7', 'p8', 'p9', 'p11'] as const) {
      expect(shown.has(slugOf(key)), key).toBe(false);
    }
  });

  it('filters by brand id and by brand slug', async () => {
    expect(setOf(await list({ categorySlug: root.slug, brandIds: brandA }))).toEqual(
      slugs('p1', 'p3', 'p5'),
    );
    expect(setOf(await list({ categorySlug: root.slug, brandSlugs: `lt-beta-${tag}` }))).toEqual(
      slugs('p2', 'p4', 'p10'),
    );
  });

  it('ORs values inside an attribute, ANDs across attributes, and ignores inactive variants', async () => {
    const q = (valueIds: string) => list({ categorySlug: root.slug, attributeValueIds: valueIds });

    expect(setOf(await q(value.teak!))).toEqual(slugs('p1', 'p4'));
    expect(setOf(await q(`${value.teak},${value.walnut}`))).toEqual(slugs('p1', 'p3', 'p4', 'p5'));
    expect(setOf(await q(`${value.teak},${value.l}`))).toEqual(slugs('p1', 'p4'));
    expect(setOf(await q(value.mango!))).toEqual(slugs('p2'));
    // p10 carries oak only on an inactive variant.
    expect(setOf(await q(value.oak!))).toEqual(slugs('p2'));
  });

  it('filters on the listing index price, falling back to base price only when unindexed', async () => {
    const rows = await prisma.productListingIndex.findMany({
      where: { productId: { in: listed.map((key) => ids[key]) } },
    });
    expect(rows).toHaveLength(listed.length);

    const expected = new Set(
      listed
        .filter((key) => {
          const price = rows.find((row) => row.productId === ids[key])!.minPricePaise!;
          return price >= 9_000_00 && price <= 16_000_00;
        })
        .map(slugOf),
    );
    expect(expected.size).toBeGreaterThan(0);
    expect(
      setOf(await list({ categorySlug: root.slug, priceMin: 9_000_00, priceMax: 16_000_00 })),
    ).toEqual(expected);
  });

  it('agrees with the pricing engine on the indexed range', async () => {
    const variants = await prisma.productVariant.findMany({
      where: { productId: ids.p1, deletedAt: null, isActive: true },
    });
    const quotes = await Promise.all(
      variants.map((variant) =>
        pricingFacade.quoteProduct({
          items: [{ productId: ids.p1, variantId: variant.id, qty: 1 }],
          channel: 'WEB',
          customerId: null,
        }),
      ),
    );
    const prices = quotes.map((quote) => quote.lines[0]!.unitPricePaise);
    const row = await prisma.productListingIndex.findUniqueOrThrow({
      where: { productId: ids.p1 },
    });
    expect(row.minPricePaise).toBe(Math.min(...prices));
    expect(row.maxPricePaise).toBe(Math.max(...prices));
  });

  it('treats made-to-order, backorderable and unreserved stock as available, and nothing else', async () => {
    expect(setOf(await list({ categorySlug: root.slug, inStockOnly: true }))).toEqual(
      slugs('p1', 'p3', 'p5'),
    );

    const cards = (await list({ categorySlug: root.slug })).items;
    const card = (key: Key) => cards.find((item) => item.slug === slugOf(key))!;
    // The card, the filter and the facet use one rule: a fully reserved variant is not in stock.
    expect(card('p4').inStock).toBe(false);
    expect(card('p5').inStock).toBe(true);
  });

  it('hides out-of-stock products entirely when catalog.show_out_of_stock is false', async () => {
    await prisma.appSetting.update({
      where: { key: 'catalog.show_out_of_stock' },
      data: { value: 'false' },
    });
    await catalogCacheService.invalidateStorefrontSettings();

    try {
      const listing = await list({ categorySlug: root.slug });
      expect(setOf(listing)).toEqual(slugs('p1', 'p3', 'p5'));
      const availability = listing.facets.find((facet) => facet.key === 'availability')!;
      expect(availability.values.find((entry) => entry.value === 'OUT_OF_STOCK')!.count).toBe(0);
    } finally {
      await prisma.appSetting.update({
        where: { key: 'catalog.show_out_of_stock' },
        data: { value: 'true' },
      });
      await catalogCacheService.invalidateStorefrontSettings();
    }
  });

  it('returns an empty page cleanly', async () => {
    const listing = await list({ categorySlug: root.slug, brandIds: brandUnused });
    expect(listing.items).toEqual([]);
    expect(listing.totalCount).toBe(0);
    expect(listing.priceBounds).toEqual({ minPaise: 0, maxPaise: 0 });
  });
});

/* -------------------------------------------------------------------- sorting */

describe('sorting happens in MySQL, with id as the last key', () => {
  async function facts() {
    const products = await prisma.product.findMany({
      where: { id: { in: listed.map((key) => ids[key]) } },
      include: { listingIndex: true, stat: true, categories: true },
    });
    return products.map((row) => ({
      slug: row.slug,
      id: row.id,
      name: row.name,
      price: row.listingIndex?.minPricePaise ?? row.basePricePaise,
      newest: (row.publishedAt ?? row.createdAt).getTime(),
      popularity: row.stat?.popularityScore ?? row.soldCount,
      soldCount: row.soldCount,
      rating: row.ratingAvgBp,
      ratingCount: row.ratingCount,
      curated: row.categories.find((link) => link.categoryId === root.id)?.position ?? row.position,
    }));
  }

  const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

  it.each([
    ['PRICE_ASC', (x: Fact, y: Fact) => x.price - y.price],
    ['PRICE_DESC', (x: Fact, y: Fact) => y.price - x.price],
    ['NEWEST', (x: Fact, y: Fact) => y.newest - x.newest],
    ['POPULARITY', (x: Fact, y: Fact) => y.popularity - x.popularity],
    ['BEST_SELLING', (x: Fact, y: Fact) => y.soldCount - x.soldCount],
    ['RATING', (x: Fact, y: Fact) => y.rating - x.rating || y.ratingCount - x.ratingCount],
    ['NAME_ASC', (x: Fact, y: Fact) => x.name.localeCompare(y.name)],
    ['CURATED', (x: Fact, y: Fact) => x.curated - y.curated],
  ] as const)('%s', async (sort, compare) => {
    const expected = (await facts()).sort((x, y) => compare(x, y) || byId(x, y));
    const listing = await list({ categorySlug: root.slug, sort });
    expect(listing.items.map((item) => item.slug)).toEqual(expected.map((row) => row.slug));
  });

  it('pages through ties one row at a time with no repeat, gap or reordering', async () => {
    const walk = async () => {
      const seen: string[] = [];
      for (let page = 1; page <= listed.length + 1; page += 1) {
        const listing = await list({
          categorySlug: root.slug,
          sort: 'BEST_SELLING',
          limit: 1,
          page,
          includeFacets: false,
        });
        seen.push(...listing.items.map((item) => item.slug));
      }
      return seen;
    };

    const first = await walk();
    expect(first).toHaveLength(listed.length);
    expect(new Set(first)).toEqual(slugs(...listed));
    await catalogCacheService.invalidateStorefront();
    expect(await walk()).toEqual(first);
  });
});

type Fact = {
  slug: string;
  id: string;
  name: string;
  price: number;
  newest: number;
  popularity: number;
  soldCount: number;
  rating: number;
  ratingCount: number;
  curated: number;
};

/* -------------------------------------------------------------------- facets */

describe('facets are SQL aggregates over the same filter', () => {
  it('count each value with its own attribute removed and the rest applied', async () => {
    const listing = await list({
      categorySlug: root.slug,
      attributeValueIds: value.teak!,
      brandIds: brandB,
    });
    const finish = listing.facets.find((facet) => facet.key === `finish-${tag}`)!;
    const count = (code: string) =>
      finish.values.find((entry) => entry.value === value[code])!.count;

    // Brand B stays applied; the finish selection does not narrow the finish counts.
    expect(count('teak')).toBe(1); // p4
    expect(count('oak')).toBe(1); // p2 (p10's oak variant is inactive)
    expect(count('walnut')).toBe(0);

    const brand = listing.facets.find((facet) => facet.key === 'brand')!;
    const brandCount = (id: string) => brand.values.find((entry) => entry.value === id)?.count;
    // The brand facet drops the brand filter but keeps teak: p1 (A) and p4 (B).
    expect(brandCount(brandA)).toBe(1);
    expect(brandCount(brandB)).toBe(1);
  });

  it('count real flags, and price buckets that sum to the result', async () => {
    const listing = await list({ categorySlug: root.slug });
    const flags = listing.facets.find((facet) => facet.key === 'flags')!;
    const flag = (name: string) => flags.values.find((entry) => entry.value === name)!.count;
    expect(flag('madeToOrder')).toBe(1); // p3
    expect(flag('onSale')).toBe(1); // p2 (compare-at above base)

    const price = listing.facets.find((facet) => facet.key === 'price') as unknown as {
      buckets: { count: number }[];
    };
    expect(price.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(listing.totalCount);

    // Backorderable p5 is available; fully reserved p4 is not - the same rule as the filter.
    const availability = listing.facets.find((facet) => facet.key === 'availability')!;
    const stock = (name: string) =>
      availability.values.find((entry) => entry.value === name)!.count;
    expect(stock('IN_STOCK')).toBe(3);
    expect(stock('OUT_OF_STOCK')).toBe(3);
  });
});

/* ------------------------------------------------------------ the card itself */

describe('the product card', () => {
  it('has exactly the listing contract fields, priced live and indexed separately', async () => {
    const listing = await list({ categorySlug: a1.slug });
    const card = listing.items.find((item) => item.slug === slugOf('p1'))!;

    expect(Object.keys(card).sort()).toEqual(
      [
        'id',
        'slug',
        'sku',
        'name',
        'subtitle',
        'shortDescription',
        'brandId',
        'brandName',
        'primaryCategorySlug',
        'primaryCategoryName',
        'image',
        'currency',
        'pricePaise',
        'indexedMinPricePaise',
        'indexedMaxPricePaise',
        'compareAtPricePaise',
        'savingsPaise',
        'savingsPercentBp',
        'priceNote',
        'inStock',
        'stockStatus',
        'isMadeToOrder',
        'leadTimeDays',
        'allowCustomization',
        'manufacturedInHouse',
        'ratingAvgBp',
        'ratingCount',
        'soldCount',
        'isNewArrival',
        'isFeatured',
        'isBestSeller',
        'variantCount',
        'swatches',
        'badges',
      ].sort(),
    );
    expect(card.brandName).toBe('LT alpha');
    expect(card.primaryCategorySlug).toBe(a1.slug);
    expect((card.image as { sources: unknown[] }).sources.length).toBeGreaterThan(0);
    expect(card.variantCount).toBe(2);
    expect((card.swatches as unknown[]).length).toBe(2);

    const row = await prisma.productListingIndex.findUniqueOrThrow({
      where: { productId: ids.p1 },
    });
    expect(card.indexedMinPricePaise).toBe(row.minPricePaise);
    const quote = await pricingFacade.quoteCart({
      items: [{ productId: ids.p1, variantId: defaultVariant.p1, qty: 1 }],
      channel: 'WEB',
    });
    expect(card.pricePaise).toBe(quote.lines[0]!.unitPricePaise);
  });
});

/* ------------------------------------------------------ pricing and caching */

describe('personalised prices and cache isolation', () => {
  it('quotes each customer group live, filters on the default group, never shares a cached grid', async () => {
    const group = await prisma.customerGroup.create({
      data: { code: `LT-${tag}`, name: 'Listing trade', priority: 900, discountBp: 500 },
    });
    const customerId = `lt-customer-${tag}`;
    await prisma.customerGroupMember.create({ data: { customerId, groupId: group.id } });
    await prisma.priceAdjustment.create({
      data: {
        name: `LT trade price ${tag}`,
        scope: 'PRODUCT',
        adjustmentType: 'FIXED_AMOUNT',
        valuePaise: -1_000_00,
        productId: ids.p1,
        customerGroupId: group.id,
      },
    });
    await catalogCacheService.invalidatePricing();

    const query = storefrontListQuerySchema.parse({
      categorySlug: a1.slug,
      includeFacets: 'false',
    });
    const pick = (listing: {
      items: { slug: string; pricePaise: number; indexedMinPricePaise: number | null }[];
    }) => listing.items.find((item) => item.slug === slugOf('p1'))!;

    // The customer fills the cache first; the anonymous shopper must not receive it.
    const trade = (await storefrontFacade.listProducts(query, { customerId })).data;
    const anon = (await storefrontFacade.listProducts(query, { customerId: null })).data;

    // The group's adjustment first, then its 5% blanket discount on that (engine step 6).
    const afterRule = pick(anon).pricePaise - 1_000_00;
    expect(pick(trade).pricePaise).toBe(afterRule - applyBasisPoints(afterRule, 500));
    expect(trade.pricingBasis).toBe(`CUSTOMER_GROUP:LT-${tag}`);
    expect(anon.pricingBasis).toBe('DEFAULT_GROUP');
    expect(pick(trade).indexedMinPricePaise).toBe(pick(anon).indexedMinPricePaise);

    // Filtering stays on the default group's price, for everyone (the pricingBasis policy).
    const below = storefrontListQuerySchema.parse({
      categorySlug: a1.slug,
      priceMax: String(pick(anon).indexedMinPricePaise! - 1),
    });
    const filtered = (await storefrontFacade.listProducts(below, { customerId })).data;
    expect(filtered.items.map((item) => item.slug)).not.toContain(slugOf('p1'));

    // A second customer in no group sees the public price.
    const other = (await storefrontFacade.listProducts(query, { customerId: `${customerId}-2` }))
      .data;
    expect(pick(other).pricePaise).toBe(pick(anon).pricePaise);

    await prisma.priceAdjustment.deleteMany({ where: { customerGroupId: group.id } });
    await prisma.customerGroup.delete({ where: { id: group.id } });
    await catalogCacheService.invalidatePricing();
  });

  it('keys a cached grid on every parameter and on whose prices it shows', () => {
    const q = (input: Record<string, unknown>) => storefrontListQuerySchema.parse(input);
    const plain = listingCacheKey(q({}), null);

    for (const filter of [
      { categorySlug: 'sofas' },
      { collectionSlug: 'new' },
      { priceMin: 1 },
      { priceMax: 1 },
      { brandIds: 'brand-1' },
      { brandSlugs: 'clearwood' },
      { attributeValueIds: 'value-1' },
      { inStockOnly: 'true' },
      { onSale: 'true' },
      { ratingMin: 4 },
      { leadTimeMax: 7 },
      { sort: 'NEWEST' },
      { page: 2 },
      { limit: 12 },
      { cursor: 'abc' },
      { q: 'teak' },
      { pincode: '400001' },
    ]) {
      expect(listingCacheKey(q(filter), null), JSON.stringify(filter)).not.toBe(plain);
    }

    expect(listingCacheKey(q({ includeFacets: 'false' }), null)).toBe(plain);
    expect(listingCacheKey(q({ attributeValueIds: 'b,a' }), null)).toBe(
      listingCacheKey(q({ attributeValueIds: 'a,b' }), null),
    );
    expect(listingCacheKey(q({}), 'customer-1')).not.toBe(plain);
    expect(listingCacheKey(q({}), 'customer-1')).not.toBe(listingCacheKey(q({}), 'customer-2'));
  });
});

/* ------------------------------------------------------------- invalidation */

describe('a write reaches the next cached grid', () => {
  const card = (listing: Listing, key: Key) =>
    listing.items.find((item) => item.slug === slugOf(key));

  it('after a product update', async () => {
    await list({ categorySlug: root.slug });
    const current = await prisma.product.findUniqueOrThrow({ where: { id: ids.p3 } });

    await productAdminService.update(ids.p3, {
      version: current.version,
      name: `Charlie Edited ${tag}`,
    });
    await catalogEvents.settled();

    expect(card(await list({ categorySlug: root.slug }), 'p3')!.name).toBe(`Charlie Edited ${tag}`);
  });

  it('after a variant price change, in the card and in the price order', async () => {
    await list({ categorySlug: root.slug, sort: 'PRICE_ASC' });
    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { id: defaultVariant.p5 },
    });

    await variantAdminService.update(ids.p5, variant.id, {
      version: variant.version,
      pricePaise: 50_000_00,
    });
    await catalogEvents.settled();

    const listing = await list({ categorySlug: root.slug, sort: 'PRICE_ASC' });
    const row = await prisma.productListingIndex.findUniqueOrThrow({
      where: { productId: ids.p5 },
    });
    expect(card(listing, 'p5')!.pricePaise).toBe(row.minPricePaise);
    expect(card(listing, 'p5')!.indexedMinPricePaise).toBe(row.minPricePaise);
    expect(listing.items.at(-1)!.slug).toBe(slugOf('p5'));
  });

  it('after a price rule change: at once in the card, then in the index', async () => {
    const before = card(await list({ categorySlug: root.slug }), 'p4')!;

    const rule = await priceAdjustmentAdminService.create(
      priceAdjustmentCreateSchema.parse({
        name: `LT delta cut ${tag}`,
        scope: 'PRODUCT',
        adjustmentType: 'FIXED_AMOUNT',
        valuePaise: -500_00,
        productId: ids.p4,
      }),
    );

    expect(card(await list({ categorySlug: root.slug }), 'p4')!.pricePaise).toBe(
      before.pricePaise - 500_00,
    );
    const indexed = await eventually(
      () => prisma.productListingIndex.findUniqueOrThrow({ where: { productId: ids.p4 } }),
      (row) => row.minPricePaise === before.indexedMinPricePaise! - 500_00,
    );
    expect(indexed.minPricePaise).toBe(before.indexedMinPricePaise! - 500_00);

    await priceAdjustmentAdminService.remove(rule.id);
  });

  it('after an inventory change', async () => {
    expect(
      setOf(await list({ categorySlug: root.slug, inStockOnly: true })).has(slugOf('p2')),
    ).toBe(false);

    await inventoryService.adjust(defaultVariant.p2, { delta: 3, reason: 'PURCHASE' });
    await catalogEvents.settled();

    const listing = await list({ categorySlug: root.slug, inStockOnly: true });
    expect(setOf(listing).has(slugOf('p2'))).toBe(true);
    expect(card(listing, 'p2')!.inStock).toBe(true);

    await inventoryService.adjust(defaultVariant.p2, { delta: -3, reason: 'CORRECTION' });
    await catalogEvents.settled();
  });

  it('after a category change', async () => {
    await list({ categorySlug: a.slug });
    await productAdminService.setCategories(ids.p2, { primaryCategoryId: a.id, categoryIds: [] });
    await catalogEvents.settled();

    expect(setOf(await list({ categorySlug: a.slug })).has(slugOf('p2'))).toBe(true);
    expect(setOf(await list({ categorySlug: b.slug })).has(slugOf('p2'))).toBe(false);

    await productAdminService.setCategories(ids.p2, {
      primaryCategoryId: b.id,
      categoryIds: [root.id],
    });
    await catalogEvents.settled();
  });
});

/* ---------------------------------------------------- listing index upkeep */

describe('the listing index follows every write path', () => {
  const row = (key: Key) =>
    prisma.productListingIndex.findUnique({ where: { productId: ids[key] } });

  it('bulk activate writes a row; bulk deactivate removes it', async () => {
    expect(await row('p11')).toBeNull();

    // ACTIVATE runs the publish gate, so the draft first gets what a live product needs.
    const taxClass = await prisma.taxClass.findFirstOrThrow({
      where: { isDefault: true, deletedAt: null },
    });
    const media = await prisma.media.findFirstOrThrow({
      where: { status: 'READY', deletedAt: null },
      orderBy: { id: 'asc' },
    });
    await prisma.product.update({ where: { id: ids.p11 }, data: { taxClassId: taxClass.id } });
    await prisma.productMedia.create({
      data: { productId: ids.p11, mediaId: media.id, role: 'PRIMARY', primaryMark: true },
    });

    const activated = await bulkActionService.run(
      bulkActionSchema.parse({ action: 'ACTIVATE', ids: [ids.p11] }),
      null,
    );
    expect(activated.succeeded).toBe(1);
    await catalogEvents.settled();
    expect((await row('p11'))?.minPricePaise).toBeGreaterThan(0);

    await bulkActionService.run(
      bulkActionSchema.parse({ action: 'DEACTIVATE', ids: [ids.p11] }),
      null,
    );
    await catalogEvents.settled();
    expect(await row('p11')).toBeNull();
  });

  it('a CSV variant import reprices the product', async () => {
    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { id: defaultVariant.p10 },
    });
    await prisma.productVariant.update({ where: { id: variant.id }, data: { isActive: true } });
    await listingIndexService.refresh(ids.p10);

    const csv = ['sku,productSku,priceRupees,isDefault', `${variant.sku},LT-p10-${tag},4321,true`];
    const job = await importService.createJob(
      'VARIANT',
      { buffer: Buffer.from(csv.join('\n')), originalName: 'variants.csv' },
      false,
      null,
    );
    expect(job.status).toBe('COMPLETED');

    const repriced = await eventually(
      () => row('p10'),
      (current) => current?.minPricePaise === 4_321_00,
    );
    expect(repriced?.minPricePaise).toBe(4_321_00);

    await prisma.productVariant.update({ where: { id: variant.id }, data: { isActive: false } });
  });

  it('a soft delete removes the row', async () => {
    const temp = await prisma.product.create({
      data: {
        sku: `LT-tmp-${tag}`,
        slug: `lt-tmp-${tag}`,
        name: 'Temp',
        status: 'ACTIVE',
        basePricePaise: 1_00,
      },
    });
    await listingIndexService.refresh(temp.id);
    expect(
      await prisma.productListingIndex.findUnique({ where: { productId: temp.id } }),
    ).not.toBeNull();

    await productAdminService.softDelete(temp.id);
    await catalogEvents.settled();
    expect(
      await prisma.productListingIndex.findUnique({ where: { productId: temp.id } }),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------- concurrency */

describe('races between writes, the index and cached grids', () => {
  it('a refresh that read older data can never overwrite one that read newer data', async () => {
    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { id: defaultVariant.p1 },
    });
    const original = listingIndexService.priceRanges.bind(listingIndexService);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    // Whichever refresh of p1 prices first holds its old result; background rebuilds may be it.
    const spy = vi
      .spyOn(listingIndexService, 'priceRanges')
      .mockImplementation(async (products) => {
        const ranges = await original(products);
        if (products.some((product) => product.id === ids.p1) && !gated) {
          gated = true;
          await gate;
        }
        return ranges;
      });

    try {
      // refreshBatch skips the per-process queue, as a second worker would.
      const first = listingIndexService.refreshBatch([ids.p1]);
      await vi.waitFor(() => expect(gated).toBe(true));

      await prisma.productVariant.update({
        where: { id: variant.id },
        data: { pricePaise: 2_222_00 },
      });
      const second = listingIndexService.refreshBatch([ids.p1]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await Promise.all([first, second]);
    } finally {
      spy.mockRestore();
    }

    const row = await prisma.productListingIndex.findUniqueOrThrow({
      where: { productId: ids.p1 },
    });
    expect(row.minPricePaise).toBe(2_222_00);

    await prisma.productVariant.update({ where: { id: variant.id }, data: { pricePaise: null } });
    await listingIndexService.refresh(ids.p1);
  });

  it('shoppers reading while an admin reprices never keep the old price cached', async () => {
    const url = { categorySlug: root.slug, sort: 'PRICE_ASC', includeFacets: false };
    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { id: defaultVariant.p3 },
    });

    const result = await runConcurrently(12, async (index) => {
      if (index === 6) {
        await variantAdminService.update(ids.p3, variant.id, {
          version: variant.version,
          pricePaise: 31_500_00,
        });
        return null;
      }
      return list(url);
    });
    expect(result.infra, result.reasons.join('; ')).toBe(0);
    await catalogEvents.settled();

    const quote = await pricingFacade.quoteCart({
      items: [{ productId: ids.p3, variantId: variant.id, qty: 1 }],
      channel: 'WEB',
    });
    const card = (await list(url)).items.find((item) => item.slug === slugOf('p3'))!;
    expect(card.pricePaise).toBe(quote.lines[0]!.unitPricePaise);
    const row = await prisma.productListingIndex.findUniqueOrThrow({
      where: { productId: ids.p3 },
    });
    expect(card.indexedMinPricePaise).toBe(row.minPricePaise);
  });

  it('shoppers reading while stock arrives see the stock the database holds', async () => {
    const url = { categorySlug: root.slug, inStockOnly: true, includeFacets: false };
    expect(setOf(await list(url)).has(slugOf('p2'))).toBe(false);

    const result = await runConcurrently(12, async (index) => {
      if (index === 6) {
        await inventoryService.setAbsolute(defaultVariant.p2, 4, { reason: 'CORRECTION' });
        return null;
      }
      return list(url);
    });
    expect(result.infra, result.reasons.join('; ')).toBe(0);
    await catalogEvents.settled();

    expect(setOf(await list(url)).has(slugOf('p2'))).toBe(true);
    const all = await list({ categorySlug: root.slug, includeFacets: false });
    expect(all.items.find((item) => item.slug === slugOf('p2'))!.inStock).toBe(true);

    await inventoryService.setAbsolute(defaultVariant.p2, 0, { reason: 'CORRECTION' });
    await catalogEvents.settled();
    expect(setOf(await list(url)).has(slugOf('p2'))).toBe(false);
  });
});
