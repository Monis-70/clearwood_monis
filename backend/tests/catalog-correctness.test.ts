import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { applyBasisPoints } from '@shared/money';
import { storefrontListQuerySchema } from '@shared/schemas/storefront';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { cache } from '../src/container';
import { catalogEvents } from '../src/events/catalogEvents';
import { catalogCacheService } from '../src/modules/catalog-admin/catalogCache.service';
import { inventoryService } from '../src/modules/catalog-admin/inventory.service';
import { priceAdjustmentAdminService } from '../src/modules/catalog-admin/priceAdjustment.admin.service';
import { combinationKeyOf } from '../src/modules/catalog-admin/variantOptions';
import { recentlyViewedService } from '../src/modules/cart/recentlyViewed.service';
import { pageRendererService } from '../src/modules/cms/pageRenderer.service';
import { customerGroupService } from '../src/modules/pricing/pricingAdmin.service';
import { pricingFacade } from '../src/modules/pricing/pricing.facade';
import { collectionRulesService } from '../src/modules/storefront/collectionRules.service';
import { listingIndexService } from '../src/modules/storefront/listingIndex.service';
import {
  LISTING_TASK,
  listingReconciler,
} from '../src/modules/storefront/listingReconciler.service';
import { productQueryService } from '../src/modules/storefront/productQuery.service';
import { searchIndexerService } from '../src/modules/storefront/searchIndexer.service';
import { listingCacheKey, storefrontFacade } from '../src/modules/storefront/storefront.facade';
import { maintenanceTaskRepository } from '../src/repositories/maintenanceTask.repository';
import { categoryService } from '../src/services/category.service';
import { mark } from '../src/utils/uniqueMark';

import { runConcurrently } from './helpers/concurrency';

/**
 * Prompt 5 - catalog correctness: one visibility rule on every public path, the customer-group
 * discount and per-card pricing, a listing index that stays true over time (price windows,
 * lost events) under a lease one worker holds, one availability rule, per-audience caches and
 * card-sized image payloads.
 *
 * Every fixture lives under category trees of its own, so exact sets can be asserted.
 */

const app = createApp();
const API = '/api/v1';
const tag = randomUUID().slice(0, 6);
const token = `vistok${tag}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(100);
    value = await read();
  }
  return value;
}

/* ------------------------------------------------------------------ fixture */

let brandId: string;
let otherBrandId: string;
let finishId: string;
const finish: Record<string, string> = {};

async function category(name: string, parent?: { id: string; path: string; depth: number }) {
  const slug = `cc-${name}-${tag}`;
  return prisma.category.create({
    data: {
      name: `CC ${name}`,
      slug,
      parentId: parent?.id ?? null,
      path: parent ? `${parent.path}/${slug}` : slug,
      depth: parent ? parent.depth + 1 : 0,
    },
  });
}

interface VariantSpec {
  pricePaise?: number;
  stockQty?: number;
  reservedQty?: number;
  allowBackorder?: boolean;
  finish?: string;
}

interface ProductSpec {
  categoryId: string;
  basePricePaise?: number;
  status?: string;
  visibility?: string;
  publishedAt?: Date;
  deleted?: boolean;
  isMadeToOrder?: boolean;
  brandId?: string;
  variants?: VariantSpec[];
}

interface Made {
  id: string;
  slug: string;
  variants: string[];
}

async function product(key: string, spec: ProductSpec): Promise<Made> {
  const slug = `cc-${key}-${tag}`;
  const created = await prisma.product.create({
    data: {
      sku: `CC-${key}-${tag}`,
      slug,
      name: `Vistok ${key} ${token}`,
      status: spec.status ?? 'ACTIVE',
      visibility: spec.visibility ?? 'PUBLIC',
      brandId: spec.brandId ?? brandId,
      basePricePaise: spec.basePricePaise ?? 10_000_00,
      isMadeToOrder: spec.isMadeToOrder ?? false,
      isNewArrival: true,
      publishedAt: spec.publishedAt ?? new Date(Date.now() - 86_400_000),
      deletedAt: spec.deleted ? new Date() : null,
      categories: {
        create: { categoryId: spec.categoryId, isPrimary: true, primaryMark: mark(true) },
      },
    },
  });

  const variants: string[] = [];
  for (const [index, variant] of (spec.variants ?? [{}]).entries()) {
    const pairs = [{ attributeId: finishId, attributeValueId: finish[variant.finish ?? 'teak']! }];
    const row = await prisma.productVariant.create({
      data: {
        productId: created.id,
        sku: `CC-${key}-${tag}-${index}`,
        position: index,
        isDefault: index === 0,
        defaultMark: mark(index === 0),
        pricePaise: variant.pricePaise ?? null,
        stockQty: variant.stockQty ?? 5,
        reservedQty: variant.reservedQty ?? 0,
        allowBackorder: variant.allowBackorder ?? false,
        combinationKey: combinationKeyOf(pairs),
        attributeValues: { create: pairs },
      },
    });
    variants.push(row.id);
  }
  return { id: created.id, slug, variants };
}

/* The visibility matrix: every lifecycle state a product can be in. */
const VIS = ['pub', 'cat', 'srch', 'hid', 'draft', 'arch', 'sched', 'del'] as const;
type Vis = (typeof VIS)[number];
const BROWSE: Vis[] = ['pub', 'cat'];
const SEARCH: Vis[] = ['pub', 'srch'];
const REACHABLE: Vis[] = ['pub', 'cat', 'srch'];

const vis = {} as Record<Vis, Made>;
let visCategory: { slug: string; id: string };
let visCollection: { slug: string; id: string };
let host: Made;

let priced: Made;
let priceCategory: { slug: string; id: string };

let groupTen: { id: string; code: string };
let groupTwenty: { id: string; code: string };
let groupPlain: { id: string; code: string };
const customer = {
  ten: `cc-ten-${tag}`,
  twenty: `cc-twenty-${tag}`,
  plain: `cc-plain-${tag}`,
  ungrouped: `cc-ungrouped-${tag}`,
  returning: `cc-returning-${tag}`,
};

beforeAll(async () => {
  const brands = await Promise.all(
    ['vis', 'other'].map((name) =>
      prisma.brand.create({ data: { name: `CC ${name} ${tag}`, slug: `cc-${name}-${tag}` } }),
    ),
  );
  [brandId, otherBrandId] = brands.map((row) => row.id) as [string, string];

  const attribute = await prisma.attribute.create({
    data: {
      code: `cc-finish-${tag}`,
      name: 'Finish',
      inputType: 'SWATCH_COLOR',
      isVariantDefining: true,
      isFilterable: true,
      showInSwatch: true,
      values: {
        create: ['teak', 'oak'].map((code, position) => ({ code, label: code, position })),
      },
    },
    include: { values: true },
  });
  finishId = attribute.id;
  for (const entry of attribute.values) finish[entry.code] = entry.id;

  const visRoot = await category('vis');
  visCategory = visRoot;
  const states: Record<Vis, Partial<ProductSpec>> = {
    pub: {},
    cat: { visibility: 'CATALOG_ONLY' },
    srch: { visibility: 'SEARCH_ONLY' },
    hid: { visibility: 'HIDDEN' },
    draft: { status: 'DRAFT' },
    arch: { status: 'ARCHIVED' },
    sched: { publishedAt: new Date(Date.now() + 7 * 86_400_000) },
    del: { deleted: true },
  };
  for (const key of VIS) vis[key] = await product(key, { categoryId: visRoot.id, ...states[key] });

  const collection = await prisma.collection.create({
    data: { slug: `cc-col-${tag}`, name: `CC collection ${tag}` },
  });
  visCollection = collection;
  await prisma.collectionProduct.createMany({
    data: VIS.map((key, position) => ({
      collectionId: collection.id,
      productId: vis[key].id,
      position,
    })),
  });

  const hostCategory = await category('host');
  host = await product('host', { categoryId: hostCategory.id, brandId: otherBrandId });
  await prisma.productRelation.createMany({
    data: VIS.map((key, position) => ({
      productId: host.id,
      relatedProductId: vis[key].id,
      type: 'SIMILAR',
      position,
    })),
  });

  priceCategory = await category('price');
  priced = await product('priced', {
    categoryId: priceCategory.id,
    brandId: otherBrandId,
    basePricePaise: 12_345,
    variants: [{}, { pricePaise: 20_000, finish: 'oak' }],
  });

  const group = (code: string, discountBp: number | null) =>
    prisma.customerGroup.create({
      data: { code: `${code}-${tag}`, name: code, priority: 500, discountBp },
    });
  groupTen = await group('CC10', 1_000);
  groupTwenty = await group('CC20', 2_000);
  groupPlain = await group('CCPLAIN', null);
  await prisma.customerGroupMember.createMany({
    data: [
      { customerId: customer.ten, groupId: groupTen.id },
      { customerId: customer.twenty, groupId: groupTwenty.id },
      { customerId: customer.plain, groupId: groupPlain.id },
    ],
  });
  const coupon = await prisma.coupon.findFirstOrThrow({ where: { deletedAt: null } });
  await prisma.couponRedemption.create({
    data: { couponId: coupon.id, customerId: customer.returning, status: 'CONFIRMED' },
  });

  const all = [...VIS.map((key) => vis[key].id), host.id, priced.id];
  await listingIndexService.refreshMany(all);
  await searchIndexerService.indexProducts(all);
  await catalogEvents.settled();
  await catalogCacheService.invalidateStorefront();
}, 180_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await catalogEvents.settled();
  await listingReconciler.idle();
});

const slugsOf = (items: { slug: string }[]) => new Set(items.map((item) => item.slug));
const pricedCard = (listing: {
  items: { slug: string; pricePaise: number; indexedMinPricePaise: number | null }[];
}) => listing.items.find((item) => item.slug === priced.slug)!;
const expected = (keys: Vis[]) => new Set(keys.map((key) => vis[key].slug));
const only = (found: Set<string>) =>
  new Set(VIS.map((key) => vis[key].slug).filter((slug) => found.has(slug)));

/* --------------------------------------------------------------- visibility */

describe('one visibility rule on every public path', () => {
  it('lists PUBLIC and CATALOG_ONLY in categories, collections, curated strips and facets', async () => {
    const listing = await request(app)
      .get(`${API}/catalog/products`)
      .query({ categorySlug: visCategory.slug, limit: 96 });
    expect(listing.status).toBe(200);
    expect(slugsOf(listing.body.data.items)).toEqual(expected(BROWSE));
    expect(listing.body.data.totalCount).toBe(BROWSE.length);

    const collection = await request(app)
      .get(`${API}/catalog/collections/${visCollection.slug}`)
      .query({ limit: 96 });
    expect(collection.status).toBe(200);
    expect(slugsOf(collection.body.data.products.items)).toEqual(expected(BROWSE));
    // The collection's own count agrees with what its listing can show.
    expect(collection.body.data.collection.productCount).toBe(BROWSE.length);

    const strip = await request(app).get(`${API}/catalog/new-arrivals`).query({ limit: 100 });
    expect(only(slugsOf(strip.body.data))).toEqual(expected(BROWSE));

    const facets = await request(app)
      .get(`${API}/catalog/filters`)
      .query({ categorySlug: visCategory.slug });
    const brand = (facets.body.data as { key: string; values: { count: number }[] }[]).find(
      (facet) => facet.key === 'brand',
    )!;
    expect(brand.values.reduce((sum, value) => sum + value.count, 0)).toBe(BROWSE.length);
  });

  it('answers a search with PUBLIC and SEARCH_ONLY, in results and in autocomplete', async () => {
    const search = await request(app).get(`${API}/search`).query({ q: token, limit: 96 });
    expect(search.status).toBe(200);
    expect(only(slugsOf(search.body.data.products.items))).toEqual(expected(SEARCH));

    const suggest = await request(app).get(`${API}/search/suggest`).query({ q: token });
    expect(suggest.status).toBe(200);
    const suggested = new Set(
      (suggest.body.data as { type: string; slug: string | null }[])
        .filter((entry) => entry.type === 'PRODUCT')
        .map((entry) => entry.slug ?? ''),
    );
    expect(only(suggested)).toEqual(expected(SEARCH));
  });

  it('opens a reachable product by slug everywhere and nothing else anywhere', async () => {
    for (const key of VIS) {
      const { slug } = vis[key];
      const want = REACHABLE.includes(key) ? 200 : 404;

      const pdp = await request(app).get(`${API}/catalog/products/${slug}`);
      const options = await request(app).get(`${API}/catalog/products/${slug}/options`);
      const gallery = await request(app).get(`${API}/catalog/products/${slug}/gallery`);
      const price = await request(app).get(`${API}/catalog/products/${slug}/price?qty=1`);
      const related = await request(app).get(`${API}/catalog/products/${slug}/related`);
      const view = await request(app).post(`${API}/catalog/products/${slug}/view`).send({});
      for (const [surface, response] of Object.entries({
        pdp,
        options,
        gallery,
        price,
        related,
      })) {
        expect(response.status, `${key} ${surface}`).toBe(want);
      }
      expect(view.status, `${key} view`).toBe(want === 200 ? 202 : 404);

      const resolved = await request(app)
        .get(`${API}/catalog/resolve`)
        .query({ path: `/products/${slug}` });
      expect(resolved.body.data.type, `${key} resolve`).toBe(
        want === 200 ? 'PRODUCT' : 'NOT_FOUND',
      );
    }
  });

  it('never shows an unreachable product where it is linked explicitly', async () => {
    const related = await request(app).get(`${API}/catalog/products/${host.slug}/related`);
    expect(only(slugsOf(related.body.data))).toEqual(expected(REACHABLE));

    const byId = await request(app)
      .post(`${API}/catalog/products/batch`)
      .send({ ids: VIS.map((key) => vis[key].id) });
    expect(byId.status).toBe(200);
    expect(slugsOf(byId.body.data)).toEqual(expected(REACHABLE));

    const bySlug = await request(app)
      .post(`${API}/catalog/products/batch`)
      .send({ slugs: VIS.map((key) => vis[key].slug) });
    expect(slugsOf(bySlug.body.data)).toEqual(expected(REACHABLE));

    const owner = { customerId: `cc-viewer-${tag}`, sessionId: null, isNewSession: false };
    await prisma.recentlyViewed.createMany({
      data: VIS.map((key) => ({ customerId: owner.customerId, productId: vis[key].id })),
    });
    const strip = await recentlyViewedService.list(owner);
    const shown = new Set(strip.filter((row) => row.product).map((row) => row.product!.slug));
    expect(shown).toEqual(expected(REACHABLE));

    const page = await prisma.page.findFirstOrThrow({ where: { slug: 'privacy-policy' } });
    const block = await prisma.pageBlock.create({
      data: {
        pageId: page.id,
        type: 'PRODUCT_GRID',
        position: 990,
        isActive: true,
        configJson: JSON.stringify({ productIds: VIS.map((key) => vis[key].id), limit: 12 }),
      },
    });
    try {
      await catalogCacheService.invalidateCmsPages();
      const rendered = await pageRendererService.renderBySlug('privacy-policy', {});
      const grid = rendered.blocks.find((entry) => entry.id === block.id)!;
      const cards = (grid.data.products ?? []) as { slug: string }[];
      expect(slugsOf(cards)).toEqual(expected(REACHABLE));
    } finally {
      await prisma.pageBlock.delete({ where: { id: block.id } });
      await catalogCacheService.invalidateCmsPages();
    }
  });

  it('refuses public quotes for unreachable products while carts keep pricing their lines', async () => {
    for (const key of VIS) {
      const quote = await request(app)
        .post(`${API}/pricing/quote`)
        .send({ items: [{ productId: vis[key].id, qty: 1 }] });
      expect(quote.status, key).toBe(REACHABLE.includes(key) ? 200 : 404);
    }

    // A cart line whose product was hidden after it was added is still priced (and flagged).
    const internal = await pricingFacade.quoteCart({ items: [{ productId: vis.hid.id, qty: 1 }] });
    expect(internal.lines[0]!.unitPricePaise).toBe(10_000_00);
  });

  it('counts only what a listing can show, and keeps scheduled products out of ANY-rule collections', async () => {
    await categoryService.recomputeProductCounts();
    const counted = await prisma.category.findUniqueOrThrow({ where: { id: visCategory.id } });
    expect(counted.productCountCache).toBe(BROWSE.length);

    const preview = await collectionRulesService.preview(
      {
        match: 'ANY',
        groups: [
          { match: 'ANY', rules: [{ field: 'brandId', operator: 'EQUALS', value: brandId }] },
        ],
      },
      50,
    );
    expect(preview.matched).toBe(BROWSE.length);
    expect(new Set(preview.sample.map((row) => row.id))).toEqual(
      new Set(BROWSE.map((key) => vis[key].id)),
    );
  });
});

/* ------------------------------------------------------------------ pricing */

describe('customer pricing', () => {
  const unit = async (customerId: string | null, variantId: string | null = null, qty = 1) =>
    (
      await pricingFacade.quoteProduct({
        items: [{ productId: priced.id, variantId, qty }],
        customerId,
      })
    ).lines[0]!;

  it('applies the group discount once, after every rule, rounded half-up', async () => {
    expect((await unit(null)).unitPricePaise).toBe(12_345);
    expect((await unit(customer.ungrouped)).unitPricePaise).toBe(12_345);
    expect((await unit(customer.plain)).unitPricePaise).toBe(12_345);

    const ten = await unit(customer.ten);
    // 10% of 12,345 is 1,234.5: half-up to 1,235.
    expect(ten.unitPricePaise).toBe(11_110);
    expect((await unit(customer.twenty)).unitPricePaise).toBe(12_345 - 2_469);

    const tripled = await unit(customer.ten, null, 3);
    const discounts = tripled.components.filter((row) => row.sourceType === 'CUSTOMER_GROUP');
    expect(discounts).toHaveLength(1);
    expect(discounts[0]!.amountPaise).toBe(-1_235 * 3);
    expect(tripled.totalPaise - tripled.taxPaise).toBe(11_110 * 3);
  });

  it('discounts a variant price, a price rule and a tier in the documented order', async () => {
    expect((await unit(customer.ten, priced.variants[1]!)).unitPricePaise).toBe(20_000 - 2_000);

    const rule = await prisma.priceAdjustment.create({
      data: {
        name: `CC rule ${tag}`,
        scope: 'PRODUCT',
        adjustmentType: 'FIXED_AMOUNT',
        valuePaise: -1_000,
        productId: priced.id,
      },
    });
    const tier = await prisma.tierPrice.create({
      data: { productId: priced.id, minQty: 2, discountBp: 500 },
    });
    await catalogCacheService.invalidatePricing({ affectsCatalogPrices: false });
    try {
      const afterRule = 12_345 - 1_000;
      expect((await unit(null)).unitPricePaise).toBe(afterRule);
      expect((await unit(customer.ten)).unitPricePaise).toBe(
        afterRule - applyBasisPoints(afterRule, 1_000),
      );

      // Tier (qty 2) -> rule -> group.
      const tiered = 12_345 - applyBasisPoints(12_345, 500) - 1_000;
      expect((await unit(customer.ten, null, 2)).unitPricePaise).toBe(
        tiered - applyBasisPoints(tiered, 1_000),
      );
    } finally {
      await prisma.priceAdjustment.delete({ where: { id: rule.id } });
      await prisma.tierPrice.delete({ where: { id: tier.id } });
      await catalogCacheService.invalidatePricing({ affectsCatalogPrices: false });
    }
  });

  it('shows each audience its own price on the card, the PDP and the quote, and indexes the default', async () => {
    const query = storefrontListQuerySchema.parse({
      categorySlug: priceCategory.slug,
      includeFacets: 'false',
    });
    for (const who of [null, customer.ten, customer.twenty]) {
      const card = pricedCard(
        (await storefrontFacade.listProducts(query, { customerId: who })).data,
      );
      expect(card.pricePaise, String(who)).toBe((await unit(who)).unitPricePaise);
      expect(card.indexedMinPricePaise).toBe(12_345);
    }
  });

  it('prices a card as if bought alone, whatever else shares the page', async () => {
    const cic = await category('cic');
    const trio = await Promise.all(
      ['cic1', 'cic2', 'cic3'].map((key) =>
        product(key, { categoryId: cic.id, basePricePaise: 5_000_00 }),
      ),
    );
    // "Two or more items in the cart": a real cart rule, which a card must not see.
    const rule = await prisma.priceAdjustment.create({
      data: {
        name: `CC two-or-more ${tag}`,
        scope: 'PRODUCT',
        adjustmentType: 'FIXED_AMOUNT',
        valuePaise: -500_00,
        productId: trio[0]!.id,
        conditionsJson: JSON.stringify({
          match: 'ALL',
          conditions: [{ field: 'cartItemCount', operator: 'GREATER_OR_EQUAL', value: 2 }],
        }),
      },
    });
    await listingIndexService.refreshMany(trio.map((row) => row.id));
    await catalogCacheService.invalidatePricing({ affectsCatalogPrices: false });

    try {
      const listing = await request(app)
        .get(`${API}/catalog/products`)
        .query({ categorySlug: cic.slug, includeFacets: false });
      const card = (
        listing.body.data.items as {
          slug: string;
          pricePaise: number;
          indexedMinPricePaise: number;
        }[]
      ).find((item) => item.slug === trio[0]!.slug)!;
      const alone = await pricingFacade.quoteProduct({
        items: [{ productId: trio[0]!.id, qty: 1 }],
      });
      expect(card.pricePaise).toBe(alone.lines[0]!.unitPricePaise);
      expect(card.pricePaise).toBe(5_000_00);
      expect(card.indexedMinPricePaise).toBe(5_000_00);

      // The rule is intact where it belongs: a cart holding two of them.
      const cart = await pricingFacade.quoteCart({ items: [{ productId: trio[0]!.id, qty: 2 }] });
      expect(cart.lines[0]!.unitPricePaise).toBe(4_500_00);
    } finally {
      await prisma.priceAdjustment.delete({ where: { id: rule.id } });
      await catalogCacheService.invalidatePricing({ affectsCatalogPrices: false });
    }
  });

  it('names the pricing basis for any non-default group, with or without a blanket discount', async () => {
    expect(await productQueryService.pricingBasis(null)).toBe('DEFAULT_GROUP');
    expect(await productQueryService.pricingBasis(customer.ungrouped)).toBe('DEFAULT_GROUP');
    expect(await productQueryService.pricingBasis(customer.plain)).toBe(
      `CUSTOMER_GROUP:${groupPlain.code}`,
    );
    expect(await productQueryService.pricingBasis(customer.ten)).toBe(
      `CUSTOMER_GROUP:${groupTen.code}`,
    );
  });
});

/* ------------------------------------------------------------------- caches */

describe('caches keyed on whose prices they show', () => {
  it('shares one grid between identically priced shoppers and isolates every other audience', async () => {
    const audience = async (who: string | null) =>
      (await productQueryService.pricingAudience(who)).key;
    expect(await audience(null)).toBe('anon');
    expect(await audience(customer.ungrouped)).toBe('anon');
    expect(await audience(customer.returning)).not.toBe('anon');
    expect(await audience(customer.ten)).not.toBe('anon');
    expect(await audience(customer.ten)).not.toBe(await audience(customer.twenty));
    expect(await audience(customer.plain)).not.toBe(await audience(customer.ten));

    const query = storefrontListQuerySchema.parse({
      categorySlug: priceCategory.slug,
      includeFacets: 'false',
    });
    await catalogCacheService.invalidateStorefront();

    // The discounted audience fills first; nobody else may receive its entry.
    const ten = await storefrontFacade.listProducts(query, { customerId: customer.ten });
    const anon = await storefrontFacade.listProducts(query, { customerId: null });
    expect(pricedCard(ten.data).pricePaise).toBe(11_110);
    expect(pricedCard(anon.data).pricePaise).toBe(12_345);

    // An ungrouped signed-in shopper is served the anonymous entry, not a copy of it.
    expect(await cache.get(listingCacheKey(query, 'anon'))).not.toBeNull();
    const ungrouped = await storefrontFacade.listProducts(query, {
      customerId: customer.ungrouped,
    });
    expect(pricedCard(ungrouped.data).pricePaise).toBe(12_345);
    expect(ungrouped.data.pricingBasis).toBe('DEFAULT_GROUP');
  });

  it('caches a CMS page per pricing audience, so a group price never reaches anyone else', async () => {
    const page = await prisma.page.findFirstOrThrow({ where: { slug: 'privacy-policy' } });
    const block = await prisma.pageBlock.create({
      data: {
        pageId: page.id,
        type: 'PRODUCT_GRID',
        position: 991,
        isActive: true,
        configJson: JSON.stringify({ productIds: [priced.id], limit: 4 }),
      },
    });
    const priceIn = (rendered: Awaited<ReturnType<typeof pageRendererService.renderBySlug>>) =>
      (
        (rendered.blocks.find((entry) => entry.id === block.id)!.data.products ?? []) as {
          pricePaise: number;
        }[]
      )[0]!.pricePaise;

    try {
      await catalogCacheService.invalidateCmsPages();
      const ten = await pageRendererService.renderBySlug('privacy-policy', {
        customerId: customer.ten,
      });
      const anon = await pageRendererService.renderBySlug('privacy-policy', {});
      expect(priceIn(ten)).toBe(11_110);
      expect(priceIn(anon)).toBe(12_345);
      expect(anon.pricingBasis).toBe('DEFAULT_GROUP');
    } finally {
      await prisma.pageBlock.delete({ where: { id: block.id } });
      await catalogCacheService.invalidateCmsPages();
    }
  });
});

/* ------------------------------------------------ the index over time */

describe('the listing index stays true over time', () => {
  const indexed = async (productId: string) =>
    (await prisma.productListingIndex.findUnique({ where: { productId } }))?.minPricePaise ?? null;

  const gridPrice = async (made: Made, categorySlug: string) => {
    const listing = await request(app)
      .get(`${API}/catalog/products`)
      .query({ categorySlug, includeFacets: false });
    return (listing.body.data.items as { slug: string; indexedMinPricePaise: number }[]).find(
      (item) => item.slug === made.slug,
    )?.indexedMinPricePaise;
  };

  it('re-prices when a rule window opens and when it closes, with no write in between', async () => {
    const win = await category('win');
    const opening = await product('opening', { categoryId: win.id, basePricePaise: 7_000_00 });
    const closing = await product('closing', { categoryId: win.id, basePricePaise: 7_000_00 });
    await listingReconciler.runOnce('test-baseline');

    const boundary = new Date(Date.now() + 2_000);
    const rule = (productId: string, window: { startsAt?: Date; endsAt?: Date }) =>
      priceAdjustmentAdminService.create({
        name: `CC window ${productId}`,
        scope: 'PRODUCT',
        adjustmentType: 'FIXED_AMOUNT',
        basis: 'BASE',
        priority: 100,
        isActive: true,
        valuePaise: -2_000_00,
        productId,
        ...window,
      } as Parameters<typeof priceAdjustmentAdminService.create>[0]);
    await rule(opening.id, { startsAt: boundary });
    await rule(closing.id, { endsAt: boundary });
    await catalogEvents.settled();

    expect(await indexed(opening.id)).toBe(7_000_00);
    expect(await indexed(closing.id)).toBe(5_000_00);
    // Cached now, before the boundary: the run after it must not leave this entry behind.
    expect(await gridPrice(opening, win.slug)).toBe(7_000_00);

    const early = await listingReconciler.runOnce('test-early');
    expect(early.ran).toBe(true);
    expect(await indexed(opening.id)).toBe(7_000_00);

    await sleep(Math.max(0, boundary.getTime() - Date.now()) + 50);
    const late = await listingReconciler.runOnce('test-late');
    expect(late.ran).toBe(true);
    expect(late.windows).toBeGreaterThanOrEqual(2);
    expect(late.cachesDropped).toBe(true);

    expect(await indexed(opening.id)).toBe(5_000_00);
    expect(await indexed(closing.id)).toBe(7_000_00);
    expect(await gridPrice(opening, win.slug)).toBe(5_000_00);
    expect(await gridPrice(closing, win.slug)).toBe(7_000_00);

    // The same span again: nothing crossed, nothing moves.
    const again = await listingReconciler.runOnce('test-again');
    expect(again.windows).toBe(0);
    expect(await indexed(opening.id)).toBe(5_000_00);
  });

  it('repairs rows whose writes never announced themselves, and prunes what cannot list', async () => {
    await listingReconciler.runOnce('test-baseline');
    const quiet = await product('quiet', {
      categoryId: priceCategory.id,
      basePricePaise: 3_000_00,
    });
    const leaving = await product('leaving', { categoryId: priceCategory.id });
    await listingIndexService.refreshMany([quiet.id, leaving.id]);

    // Straight to the table: no admin service, no event.
    await prisma.productVariant.update({
      where: { id: quiet.variants[0]! },
      data: { pricePaise: 3_333_00 },
    });
    await prisma.product.update({ where: { id: leaving.id }, data: { status: 'DRAFT' } });
    const orphan = await product('orphan', {
      categoryId: priceCategory.id,
      basePricePaise: 4_000_00,
    });

    const run = await listingReconciler.runOnce('test-repair');
    expect(run.stale).toBeGreaterThanOrEqual(2);
    expect(await indexed(quiet.id)).toBe(3_333_00);
    expect(await indexed(orphan.id)).toBe(4_000_00);
    expect(
      await prisma.productListingIndex.findUnique({ where: { productId: leaving.id } }),
    ).toBeNull();
  });

  it('agrees with the pricing engine for every product it holds', async () => {
    await listingReconciler.runOnce('test-agree');
    const rows = await prisma.productListingIndex.findMany({
      include: {
        product: {
          select: {
            variants: { where: { deletedAt: null, isActive: true }, select: { id: true } },
          },
        },
      },
    });
    expect(rows.length).toBeGreaterThan(20);

    for (const row of rows) {
      const targets = row.product.variants.length
        ? row.product.variants.map((variant) => ({
            productId: row.productId,
            variantId: variant.id,
            qty: 1,
          }))
        : [{ productId: row.productId, variantId: null, qty: 1 }];
      const prices: number[] = [];
      for (let index = 0; index < targets.length; index += 50) {
        const lines = await pricingFacade.quoteEach({ items: targets.slice(index, index + 50) });
        prices.push(...lines.map((line) => line.unitPricePaise));
      }
      expect(row.minPricePaise, row.productId).toBe(Math.min(...prices));
      expect(row.maxPricePaise, row.productId).toBe(Math.max(...prices));
    }

    // The attribute projection holds exactly the specs and active-variant options, once each.
    const drift = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM (
        SELECT s.productId, s.attributeValueId, la.id AS projected
        FROM (
          SELECT pav.productId, pav.attributeValueId FROM ProductAttributeValue pav
          JOIN ProductListingIndex li ON li.productId = pav.productId
          WHERE pav.attributeValueId IS NOT NULL
          UNION
          SELECT v.productId, vav.attributeValueId FROM VariantAttributeValue vav
          JOIN ProductVariant v ON v.id = vav.variantId AND v.deletedAt IS NULL AND v.isActive = TRUE
          JOIN ProductListingIndex li ON li.productId = v.productId
        ) s
        LEFT JOIN ProductListingAttribute la
          ON la.productId = s.productId AND la.attributeValueId = s.attributeValueId
        WHERE la.id IS NULL
      ) missing`;
    expect(Number(drift[0]!.n)).toBe(0);
    const [{ n: projected }] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM ProductListingAttribute la
      JOIN ProductListingIndex li ON li.productId = la.productId`;
    const [{ n: source }] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM (
        SELECT pav.productId, pav.attributeValueId FROM ProductAttributeValue pav
        JOIN ProductListingIndex li ON li.productId = pav.productId
        WHERE pav.attributeValueId IS NOT NULL
        UNION
        SELECT v.productId, vav.attributeValueId FROM VariantAttributeValue vav
        JOIN ProductVariant v ON v.id = vav.variantId AND v.deletedAt IS NULL AND v.isActive = TRUE
        JOIN ProductListingIndex li ON li.productId = v.productId
      ) s`;
    expect(Number(projected)).toBe(Number(source));
  });

  it('re-prices exactly what a rule write reaches, and asks for everything only when it must', async () => {
    const refresh = vi.spyOn(listingIndexService, 'refreshMany');
    const rebuild = vi.spyOn(listingReconciler, 'requestRebuild').mockResolvedValue();

    const scoped = await priceAdjustmentAdminService.create({
      name: `CC scoped ${tag}`,
      scope: 'PRODUCT',
      adjustmentType: 'FIXED_AMOUNT',
      basis: 'BASE',
      priority: 100,
      isActive: true,
      valuePaise: -1,
      productId: priced.id,
    } as Parameters<typeof priceAdjustmentAdminService.create>[0]);
    await catalogEvents.settled();
    expect(refresh).toHaveBeenCalledWith([priced.id]);
    expect(rebuild).not.toHaveBeenCalled();

    const global = await priceAdjustmentAdminService.create({
      name: `CC global ${tag}`,
      scope: 'GLOBAL',
      adjustmentType: 'FIXED_AMOUNT',
      basis: 'BASE',
      priority: 100,
      isActive: false,
      valuePaise: -1,
    } as Parameters<typeof priceAdjustmentAdminService.create>[0]);
    await catalogEvents.settled();
    expect(rebuild).toHaveBeenCalledTimes(1);

    // Group membership, like coupons, shipping and settings, moves no catalog price.
    rebuild.mockClear();
    refresh.mockClear();
    await customerGroupService.addMembers(groupTen.id, [`cc-new-member-${tag}`]);
    await catalogEvents.settled();
    expect(rebuild).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    await prisma.priceAdjustment.deleteMany({ where: { id: { in: [scoped.id, global.id] } } });
    await listingIndexService.refreshMany([priced.id]);
  });
});

/* --------------------------------------------------------- the lease */

describe('one worker at a time', () => {
  it('lets exactly one of many racing workers run a pass', async () => {
    await listingReconciler.idle();
    const before = (await maintenanceTaskRepository.read(LISTING_TASK))?.runCount ?? 0;

    const result = await runConcurrently(6, (index) => listingReconciler.runOnce(`racer-${index}`));
    expect(result.infra, result.reasons.join('; ')).toBe(0);
    const ran = result.values.filter((outcome) => outcome?.ran);
    // Passes that start after the winner finished may run too; they can never overlap it.
    expect(ran.length).toBeGreaterThanOrEqual(1);
    const after = await maintenanceTaskRepository.read(LISTING_TASK);
    expect(after!.runCount - before).toBe(ran.length);
    expect(after!.leaseOwner).toBeNull();
  });

  it('never lets a run that lost its lease record its span', async () => {
    const now = new Date();
    const soon = new Date(now.getTime() + 60_000);
    expect(await maintenanceTaskRepository.tryAcquire(LISTING_TASK, 'slow', now, soon)).toBe(true);
    expect(await maintenanceTaskRepository.tryAcquire(LISTING_TASK, 'eager', now, soon)).toBe(
      false,
    );

    // The slow holder stalls past its lease; another worker takes over.
    await prisma.maintenanceTask.update({
      where: { name: LISTING_TASK },
      data: { leaseExpiresAt: new Date(now.getTime() - 1_000) },
    });
    const later = new Date();
    expect(
      await maintenanceTaskRepository.tryAcquire(
        LISTING_TASK,
        'eager',
        later,
        new Date(later.getTime() + 60_000),
      ),
    ).toBe(true);

    const watermark = (await maintenanceTaskRepository.read(LISTING_TASK))!.watermarkAt;
    expect(
      await maintenanceTaskRepository.complete(LISTING_TASK, 'slow', {
        watermarkAt: new Date(Date.now() + 86_400_000),
        rebuiltAt: null,
        completedAt: new Date(),
      }),
    ).toBe(false);
    expect(await maintenanceTaskRepository.renew(LISTING_TASK, 'slow', later, soon)).toBe(false);
    expect((await maintenanceTaskRepository.read(LISTING_TASK))!.watermarkAt).toEqual(watermark);

    await maintenanceTaskRepository.fail(LISTING_TASK, 'eager', 'test', new Date());
  });

  it('turns other processes away while the lease is held, and runs once it is free', async () => {
    const tsxCli = path.resolve(process.cwd(), '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const runProcess = () =>
      new Promise<{ ran: boolean }>((resolve, reject) => {
        const child = spawn(process.execPath, [tsxCli, 'scripts/reconcile-listing.ts'], {
          cwd: process.cwd(),
          env: { ...process.env, LOG_LEVEL: 'silent' },
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
        child.on('close', (code) => {
          const line = out.trim().split(/\r?\n/).pop() ?? '';
          if (code !== 0) reject(new Error(`exit ${code}: ${err}`));
          else resolve(JSON.parse(line) as { ran: boolean });
        });
      });

    await listingReconciler.idle();
    const now = new Date();
    expect(
      await maintenanceTaskRepository.tryAcquire(
        LISTING_TASK,
        'this-test',
        now,
        new Date(now.getTime() + 120_000),
      ),
    ).toBe(true);
    try {
      const [first, second] = await Promise.all([runProcess(), runProcess()]);
      expect(first.ran).toBe(false);
      expect(second.ran).toBe(false);
    } finally {
      await maintenanceTaskRepository.fail(
        LISTING_TASK,
        'this-test',
        'released by test',
        new Date(),
      );
    }

    expect((await runProcess()).ran).toBe(true);
  }, 120_000);

  it('serves any number of rebuild requests with one leased rebuild', async () => {
    await listingReconciler.idle();
    const reindex = vi.spyOn(searchIndexerService, 'reindexAll');

    await Promise.all(Array.from({ length: 5 }, () => listingReconciler.requestRebuild()));
    await listingReconciler.idle();

    expect(reindex.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(reindex.mock.calls.length).toBeLessThanOrEqual(2);
    const state = (await maintenanceTaskRepository.read(LISTING_TASK))!;
    expect(state.lastRebuiltAt!.getTime()).toBeGreaterThanOrEqual(
      state.rebuildRequestedAt!.getTime(),
    );
  }, 120_000);
});

/* ------------------------------------------------------------- availability */

describe('one availability rule on every surface', () => {
  const cases: Record<
    'stocked' | 'reserved' | 'backorder' | 'mto' | 'empty',
    { spec: Omit<ProductSpec, 'categoryId'>; inStock: boolean }
  > = {
    stocked: { spec: { variants: [{ stockQty: 3 }] }, inStock: true },
    reserved: { spec: { variants: [{ stockQty: 2, reservedQty: 2 }] }, inStock: false },
    backorder: { spec: { variants: [{ stockQty: 0, allowBackorder: true }] }, inStock: true },
    mto: { spec: { isMadeToOrder: true, variants: [{ stockQty: 0 }] }, inStock: true },
    empty: { spec: { variants: [{ stockQty: 0 }] }, inStock: false },
  };
  const made = {} as Record<keyof typeof cases, Made>;
  let avl: { id: string; slug: string };

  beforeAll(async () => {
    avl = await category('avl');
    for (const [key, entry] of Object.entries(cases)) {
      made[key as keyof typeof cases] = await product(key, { categoryId: avl.id, ...entry.spec });
    }
    const ids = Object.values(made).map((row) => row.id);
    await listingIndexService.refreshMany(ids);
    await searchIndexerService.indexProducts(ids);
    await catalogCacheService.invalidateStorefront();
  });

  it('agrees between the SQL filter, the card, its swatch, the PDP, the option matrix, the facet and the search document', async () => {
    const all = await request(app)
      .get(`${API}/catalog/products`)
      .query({ categorySlug: avl.slug, limit: 96 });
    const inStockOnly = await request(app)
      .get(`${API}/catalog/products`)
      .query({ categorySlug: avl.slug, inStockOnly: true, includeFacets: false, limit: 96 });
    const filtered = slugsOf(inStockOnly.body.data.items);
    const availability = (
      all.body.data.facets as { key: string; values: { value: string; count: number }[] }[]
    )
      .find((facet) => facet.key === 'availability')!
      .values.find((value) => value.value === 'IN_STOCK')!.count;
    expect(availability).toBe(Object.values(cases).filter((entry) => entry.inStock).length);

    for (const [key, entry] of Object.entries(cases)) {
      const row = made[key as keyof typeof cases];
      const card = (
        all.body.data.items as {
          slug: string;
          inStock: boolean;
          swatches: { isInStock: boolean }[];
        }[]
      ).find((item) => item.slug === row.slug)!;
      const pdp = await request(app).get(`${API}/catalog/products/${row.slug}`);
      const options = await request(app).get(`${API}/catalog/products/${row.slug}/options`);
      const document = await prisma.searchDocument.findFirstOrThrow({
        where: { entityType: 'PRODUCT', entityId: row.id },
      });

      expect(filtered.has(row.slug), `${key} filter`).toBe(entry.inStock);
      expect(card.inStock, `${key} card`).toBe(entry.inStock);
      expect(card.swatches[0]!.isInStock, `${key} swatch`).toBe(entry.inStock);
      expect(pdp.body.data.inStock, `${key} pdp`).toBe(entry.inStock);
      expect(options.body.data.combinations[0].isInStock, `${key} options`).toBe(entry.inStock);
      expect(document.inStock, `${key} search document`).toBe(entry.inStock);
    }
  });

  it('takes the last unit out of a cached grid when it is reserved and puts it back on release', async () => {
    const last = await product('last', { categoryId: avl.id, variants: [{ stockQty: 1 }] });
    await listingIndexService.refreshMany([last.id]);
    const shown = async () =>
      slugsOf(
        (
          await request(app)
            .get(`${API}/catalog/products`)
            .query({ categorySlug: avl.slug, inStockOnly: true, includeFacets: false })
        ).body.data.items,
      ).has(last.slug);

    await catalogCacheService.invalidateStorefront();
    expect(await shown()).toBe(true);

    await inventoryService.reserve(last.variants[0]!, 1, { type: 'TEST', id: tag });
    await catalogEvents.settled();
    expect(await shown()).toBe(false);

    await inventoryService.release(last.variants[0]!, 1, { type: 'TEST', id: tag });
    await catalogEvents.settled();
    expect(await shown()).toBe(true);
  });

  it('lets exactly one of many concurrent checkouts reserve the last unit', async () => {
    const contested = await product('contested', {
      categoryId: avl.id,
      variants: [{ stockQty: 1 }],
    });
    await listingIndexService.refreshMany([contested.id]);

    const result = await runConcurrently(8, () =>
      inventoryService.reserve(contested.variants[0]!, 1, { type: 'TEST', id: tag }),
    );
    expect(result.infra, result.reasons.join('; ')).toBe(0);
    expect(result.contended, result.reasons.join('; ')).toBe(0);
    expect(result.ok).toBe(1);
    expect(result.refused).toBe(7);

    await catalogEvents.settled();
    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { id: contested.variants[0]! },
    });
    expect(variant.reservedQty).toBe(1);
    const listed = await eventually(
      async () =>
        slugsOf(
          (
            await request(app)
              .get(`${API}/catalog/products`)
              .query({ categorySlug: avl.slug, inStockOnly: true, includeFacets: false })
          ).body.data.items,
        ),
      (set) => !set.has(contested.slug),
    );
    expect(listed.has(contested.slug)).toBe(false);
  });
});

/* -------------------------------------------------------------------- media */

describe('card payload', () => {
  it('carries only the card renditions while the PDP gallery keeps the whole ladder', async () => {
    const media = await prisma.media.findFirstOrThrow({
      where: { status: 'READY', deletedAt: null, variants: { some: { label: 'LARGE' } } },
      include: { variants: true },
    });
    const imaged = await product('imaged', { categoryId: priceCategory.id });
    await prisma.productMedia.create({
      data: { productId: imaged.id, mediaId: media.id, role: 'PRIMARY', primaryMark: true },
    });
    await catalogCacheService.invalidateStorefront();

    const listing = await request(app)
      .get(`${API}/catalog/products`)
      .query({ categorySlug: priceCategory.slug, includeFacets: false, limit: 96 });
    const card = (
      listing.body.data.items as { slug: string; image: { sources: { label: string }[] } }[]
    ).find((item) => item.slug === imaged.slug)!;
    const labels = new Set(card.image.sources.map((source) => source.label));
    expect(labels.size).toBeGreaterThan(0);
    expect([...labels].every((label) => label === 'SMALL' || label === 'MEDIUM')).toBe(true);
    expect(card.image.sources).toHaveLength(
      media.variants.filter((variant) => variant.label === 'SMALL' || variant.label === 'MEDIUM')
        .length,
    );

    const pdp = await request(app).get(`${API}/catalog/products/${imaged.slug}`);
    const gallery = pdp.body.data.gallery as { sources: { label: string }[] }[];
    expect(gallery[0]!.sources).toHaveLength(media.variants.length);
  });
});
