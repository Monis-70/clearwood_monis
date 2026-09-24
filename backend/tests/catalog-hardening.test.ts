import { randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { cache } from '../src/container';
import { catalogEvents } from '../src/events/catalogEvents';
import { rateLimitKey } from '../src/middleware/authRateLimit';
import { passwordService } from '../src/modules/auth/password.service';
import { catalogCacheService } from '../src/modules/catalog-admin/catalogCache.service';
import { importService } from '../src/modules/catalog-admin/import-export/import.service';
import { pageRendererService } from '../src/modules/cms/pageRenderer.service';
import { listingReconciler } from '../src/modules/storefront/listingReconciler.service';
import { searchIndexerService } from '../src/modules/storefront/searchIndexer.service';
import { categoryService } from '../src/services/category.service';
import { mark } from '../src/utils/uniqueMark';

/**
 * Catalog hardening (PROJECT_CONTEXT §48): scoped import invalidation, typed product
 * relationships, the category and contract-work contracts, category counts that follow every
 * write, the catalog clock (collection windows, new arrivals, racing workers), data-driven badges
 * on every surface, and search, pricing and media staying in step with admin writes.
 *
 * Fixtures live under trees of their own, so exact sets can be asserted.
 */

const app = createApp();
const API = '/api/v1';
const tag = randomUUID().slice(0, 6);
const TAG = tag.toUpperCase().replace(/[^A-Z0-9]/g, 'X');
const PASSWORD = 'Rosewood-Teak-2026';
const DAY = 86_400_000;

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

/** Every event handler and background reconcile this process started has finished. */
async function settle(): Promise<void> {
  await catalogEvents.settled();
  await listingReconciler.idle();
  await catalogEvents.settled();
}

/* ---------------------------------------------------------------- sessions */

interface Session {
  header: string;
  csrf: string;
}

async function admin(email: string, roleCode: string): Promise<Session> {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: `Hardening ${roleCode}`,
      passwordHash: await passwordService.hash(PASSWORD),
      status: 'ACTIVE',
    },
  });
  await prisma.adminUserRole.upsert({
    where: { adminUserId_roleId: { adminUserId: user.id, roleId: role.id } },
    update: {},
    create: { adminUserId: user.id, roleId: role.id },
  });

  const login = await request(app)
    .post(`${API}/admin/auth/login`)
    .send({ email, password: PASSWORD });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const raw = login.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];

  return {
    header: cookies.map((cookie) => cookie.split(';')[0]).join('; '),
    csrf:
      cookies
        .find((cookie) => cookie.startsWith('cw_adm_csrf='))
        ?.split(';')[0]
        ?.split('=')[1] ?? '',
  };
}

let catalogManager: Session;

function api() {
  const send = (method: 'post' | 'patch' | 'put' | 'delete', url: string) =>
    request(app)
      [method](`${API}${url}`)
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf);
  return {
    get: (url: string) => request(app).get(`${API}${url}`).set('Cookie', catalogManager.header),
    post: (url: string) => send('post', url),
    patch: (url: string) => send('patch', url),
    put: (url: string) => send('put', url),
    delete: (url: string) => send('delete', url),
  };
}

/* ---------------------------------------------------------------- fixtures */

interface Node {
  id: string;
  slug: string;
  path: string;
  depth: number;
  name: string;
}

async function category(
  name: string,
  parent?: Node,
  extra: Partial<Prisma.CategoryUncheckedCreateInput> = {},
): Promise<Node> {
  const slug = `ch-${name}-${tag}`;
  return prisma.category.create({
    data: {
      name: `CH ${name} ${tag}`,
      slug,
      parentId: parent?.id ?? null,
      path: parent ? `${parent.path}/${slug}` : slug,
      depth: parent ? parent.depth + 1 : 0,
      ...extra,
    },
    select: { id: true, slug: true, path: true, depth: true, name: true },
  });
}

interface Made {
  id: string;
  slug: string;
  sku: string;
  variantId: string;
}

/** A live product, published long ago unless told otherwise, with one stocked variant. */
async function product(
  key: string,
  categoryId: string,
  extra: Partial<Prisma.ProductUncheckedCreateInput> = {},
): Promise<Made> {
  const old = new Date(Date.now() - 400 * DAY);
  const created = await prisma.product.create({
    data: {
      sku: `CH-${key}-${tag}`,
      slug: `ch-${key}-${tag}`,
      name: `Hardening ${key} ${tag}`,
      status: 'ACTIVE',
      visibility: 'PUBLIC',
      basePricePaise: 10_000_00,
      taxClassId: defaultTaxClassId,
      publishedAt: old,
      createdAt: old,
      ...extra,
      categories: { create: { categoryId, isPrimary: true, primaryMark: mark(true) } },
      variants: {
        create: {
          sku: `CH-${key}-${tag}-v`,
          isDefault: true,
          defaultMark: mark(true),
          stockQty: 5,
        },
      },
    },
    include: { variants: { select: { id: true } } },
  });
  return {
    id: created.id,
    slug: created.slug,
    sku: created.sku,
    variantId: created.variants[0]!.id,
  };
}

/** Fixtures are written straight to MySQL, so what their writes would have done is done here. */
async function fresh(productIds: string[] = []): Promise<void> {
  if (productIds.length > 0) await searchIndexerService.indexProducts(productIds);
  await categoryService.recomputeProductCounts();
  await catalogCacheService.invalidateAll();
  await settle();
}

interface Card {
  id: string;
  slug: string;
  name: string;
  pricePaise: number;
  indexedMinPricePaise: number | null;
  isNewArrival: boolean;
  badges: { code: string; label: string; color: string | null }[];
  [key: string]: unknown;
}

async function listing(params: Record<string, string | number | boolean>): Promise<Card[]> {
  const response = await request(app)
    .get(`${API}/catalog/products`)
    .query({ limit: 96, includeFacets: false, ...params });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.items as Card[];
}

const slugsOf = (cards: { slug: string }[]) => cards.map((card) => card.slug).sort();

async function pdp(slug: string) {
  const response = await request(app).get(`${API}/catalog/products/${slug}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as {
    name: string;
    badges: Card['badges'];
    related: Card[];
    frequentlyBoughtTogether: Card[];
    relationGroups: { type: string; items: Card[] }[];
    gallery: { mediaId: string }[];
    price: { lines: { unitPricePaise: number }[] };
  };
}

const countOf = async (categoryId: string) =>
  (await prisma.category.findUniqueOrThrow({ where: { id: categoryId } })).productCountCache;

async function importCsv(entity: Parameters<typeof importService.createJob>[0], lines: string[]) {
  const job = await importService.createJob(
    entity,
    { buffer: Buffer.from(lines.join('\n')), originalName: `${entity.toLowerCase()}.csv` },
    false,
    null,
  );
  await settle();
  return job;
}

/* Sentinels: a planted key that is still there afterwards was not invalidated. */
async function plant(keys: string[]): Promise<void> {
  for (const key of keys) await cache.set(key, { planted: true }, 300);
}

async function present(keys: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const key of keys) if (await cache.get(key)) left.push(key);
  return left;
}

let defaultTaxClassId: string;
let readyMediaIds: string[];

beforeAll(async () => {
  defaultTaxClassId = (
    await prisma.taxClass.findFirstOrThrow({ where: { isDefault: true, deletedAt: null } })
  ).id;
  readyMediaIds = (
    await prisma.media.findMany({
      where: { deletedAt: null, status: 'READY', kind: 'IMAGE' },
      orderBy: { id: 'asc' },
      take: 3,
      select: { id: true },
    })
  ).map((row) => row.id);
  expect(readyMediaIds).toHaveLength(3);

  catalogManager = await admin(`ch.catalog.${tag}@clearwood.local`, 'CATALOG_MANAGER');
}, 120_000);

afterAll(async () => {
  await settle();
});

/* ------------------------------------------------------ scoped import invalidation */

describe('CSV import invalidates what it wrote, and nothing else', () => {
  const UNRELATED = [
    `nav:ch-${tag}`,
    `sf:set:ch-${tag}`,
    `cat:attrs:ch-${tag}`,
    `cms:faq:ch-${tag}`,
    `cms:banner:ch-${tag}`,
    `addr:pin:ch-${tag}`,
  ];

  it('a product import drops product payloads, spares the rest, and every surface follows', async () => {
    const home = await category('imp-home');
    const away = await category('imp-away');
    const item = await product('imp-item', home.id);
    await fresh([item.id]);

    expect(slugsOf(await listing({ categorySlug: home.slug }))).toEqual([item.slug]);
    expect((await pdp(item.slug)).price.lines[0]!.unitPricePaise).toBe(10_000_00);
    expect(await countOf(home.id)).toBe(1);

    const RENDERS = [
      `sf:list:ch-${tag}`,
      `sf:pdp:ch-${tag}`,
      `sf:facet:ch-${tag}`,
      `sf:sugg:ch-${tag}`,
      `cms:page:ch-${tag}`,
      `price:quote:ch-${tag}`,
    ];
    await plant([...RENDERS, ...UNRELATED, `price:set:ch-${tag}`]);

    const job = await importCsv('PRODUCT', [
      'sku,basePriceRupees,primaryCategorySlug,categorySlugs',
      `${item.sku},12345,${away.slug},${away.slug}`,
    ]);
    expect(job.status, JSON.stringify(job.errors)).toBe('COMPLETED');

    // Scoped: product payloads went, configuration caches no import can change stayed warm.
    expect(await present(RENDERS)).toEqual([]);
    expect(await present([...UNRELATED, `price:set:ch-${tag}`])).toEqual([
      ...UNRELATED,
      `price:set:ch-${tag}`,
    ]);

    // Mutation -> read: listing (live price and index), PDP, search and counts, no manual flush.
    const moved = await listing({ categorySlug: away.slug });
    expect(slugsOf(moved)).toEqual([item.slug]);
    expect(moved[0]!.pricePaise).toBe(12_345_00);
    expect(moved[0]!.indexedMinPricePaise).toBe(12_345_00);
    expect(await listing({ categorySlug: home.slug })).toEqual([]);
    expect((await pdp(item.slug)).price.lines[0]!.unitPricePaise).toBe(12_345_00);

    const document = await prisma.searchDocument.findFirstOrThrow({
      where: { entityType: 'PRODUCT', entityId: item.id },
    });
    expect(document.minPricePaise).toBe(12_345_00);
    expect(document.categoryText).toContain(away.name);
    expect(document.categoryText).not.toContain(home.name);

    expect(await countOf(home.id)).toBe(0);
    expect(await countOf(away.id)).toBe(1);
  });

  it('a rolled-back chunk writes nothing and announces nothing', async () => {
    const home = await category('imp-rollback');
    const item = await product('imp-rollback', home.id);
    await fresh([item.id]);

    const RENDERS = [`sf:list:ch-rb-${tag}`, `sf:pdp:ch-rb-${tag}`];
    await plant(RENDERS);

    const job = await importCsv('PRODUCT', [
      'sku,basePriceRupees,productType',
      `${item.sku},999,SIMPLE`,
      `${item.sku},999,NOT_A_TYPE`,
    ]);
    expect(job.status).toBe('FAILED');
    expect(job.errors.map((error) => error.column)).toContain('productType');

    const stored = await prisma.product.findUniqueOrThrow({ where: { id: item.id } });
    expect(stored.basePricePaise).toBe(10_000_00);
    expect(await present(RENDERS)).toEqual(RENDERS);
  });

  it('a category import renames the tree and re-indexes its products, sparing pricing caches', async () => {
    const home = await category('imp-rename');
    const item = await product('imp-rename', home.id);
    await fresh([item.id]);

    const TREE = [`cat:tree:ch-${tag}`, `cat:slug:ch-${tag}`, `nav:ch-cat-${tag}`];
    const PRICING = [
      `price:set:ch-cat-${tag}`,
      `price:quote:ch-cat-${tag}`,
      `sf:set:ch-cat-${tag}`,
    ];
    await plant([...TREE, ...PRICING]);

    const renamed = `CH Renamed ${tag}`;
    const job = await importCsv('CATEGORY', ['slug,name', `${home.slug},${renamed}`]);
    expect(job.status, JSON.stringify(job.errors)).toBe('COMPLETED');

    expect(await present(TREE)).toEqual([]);
    expect(await present(PRICING)).toEqual(PRICING);

    const tree = JSON.stringify((await request(app).get(`${API}/catalog/categories/tree`)).body);
    expect(tree).toContain(renamed);
    const document = await prisma.searchDocument.findFirstOrThrow({
      where: { entityType: 'PRODUCT', entityId: item.id },
    });
    expect(document.categoryText).toContain(renamed);
  });

  it('an attribute value import relabels facets and search text for that attribute only', async () => {
    const home = await category('imp-attr');
    const item = await product('imp-attr', home.id);
    const attribute = await prisma.attribute.create({
      data: {
        code: `CH_TONE_${TAG}`,
        name: `Tone ${tag}`,
        inputType: 'SELECT',
        isFilterable: true,
        isVariantDefining: true,
        values: { create: { code: 'CALM', label: 'Calm', position: 0 } },
      },
      include: { values: true },
    });
    const value = attribute.values[0]!;
    await prisma.categoryAttribute.create({
      data: { categoryId: home.id, attributeId: attribute.id, isFilterable: true, position: 0 },
    });
    await prisma.variantAttributeValue.create({
      data: { variantId: item.variantId, attributeId: attribute.id, attributeValueId: value.id },
    });
    await prisma.productAttributeValue.create({
      data: { productId: item.id, attributeId: attribute.id, attributeValueId: value.id },
    });
    await fresh([item.id]);

    const DROPPED = [`cat:attrs:ch-attr-${tag}`, `sf:facet:ch-attr-${tag}`];
    const SPARED = [`nav:ch-attr-${tag}`, `cat:tree:ch-attr-${tag}`, `price:set:ch-attr-${tag}`];
    await plant([...DROPPED, ...SPARED]);

    const label = `Serene ${tag}`;
    const job = await importCsv('ATTRIBUTE_VALUE', [
      'attributeCode,code,label',
      `${attribute.code},CALM,${label}`,
    ]);
    expect(job.status, JSON.stringify(job.errors)).toBe('COMPLETED');

    expect(await present(DROPPED)).toEqual([]);
    expect(await present(SPARED)).toEqual(SPARED);

    const document = await prisma.searchDocument.findFirstOrThrow({
      where: { entityType: 'PRODUCT', entityId: item.id },
    });
    expect(document.attributeText).toContain(label);

    const filters = await request(app)
      .get(`${API}/catalog/filters`)
      .query({ categorySlug: home.slug });
    expect(filters.status).toBe(200);
    const facet = (filters.body.data as { key: string; values: { label: string }[] }[]).find(
      (entry) => entry.key === attribute.code,
    );
    expect(facet?.values.map((entry) => entry.label)).toEqual([label]);
  });

  it('a price rule import re-prices what the rule reaches: card, index, filter, sort and PDP', async () => {
    const home = await category('imp-rule');
    const target = await product('imp-rule-target', home.id);
    const sibling = await product('imp-rule-sibling', home.id, { basePricePaise: 9_500_00 });
    await fresh([target.id, sibling.id]);

    expect(slugsOf(await listing({ categorySlug: home.slug, sort: 'PRICE_ASC' }))).toEqual(
      [sibling.slug, target.slug].sort(),
    );

    const job = await importCsv('PRICE_ADJUSTMENT', [
      'name,scope,adjustmentType,basis,valueBp,productSku,isActive',
      `CH rule ${tag},PRODUCT,PERCENT,BASE,-1000,${target.sku},true`,
    ]);
    expect(job.status, JSON.stringify(job.errors)).toBe('COMPLETED');

    const cards = await listing({ categorySlug: home.slug, sort: 'PRICE_ASC' });
    expect(cards.map((card) => card.slug)).toEqual([target.slug, sibling.slug]);
    expect(cards[0]!.pricePaise).toBe(9_000_00);
    expect(cards[0]!.indexedMinPricePaise).toBe(9_000_00);
    expect(slugsOf(await listing({ categorySlug: home.slug, priceMax: 9_100_00 }))).toEqual([
      target.slug,
    ]);
    expect((await pdp(target.slug)).price.lines[0]!.unitPricePaise).toBe(9_000_00);

    // The rule reached one product; the other kept its price and its index row.
    expect(cards[1]!.pricePaise).toBe(9_500_00);
  });
});

/* ------------------------------------------------------------- relationships */

describe('product relationships', () => {
  let host: Made;
  let b: Made;
  let c: Made;
  let hidden: Made;
  let draft: Made;
  let gone: Made;

  beforeAll(async () => {
    const home = await category('rel-home');
    host = await product('rel-host', home.id);
    b = await product('rel-b', home.id);
    c = await product('rel-c', home.id);
    hidden = await product('rel-hidden', home.id, { visibility: 'HIDDEN' });
    draft = await product('rel-draft', home.id, { status: 'DRAFT', publishedAt: null });
    gone = await product('rel-gone', home.id, { deletedAt: new Date() });
    await fresh([host.id, b.id, c.id]);
  });

  const put = (
    id: string,
    relations: { relatedProductId: string; type: string; position?: number }[],
  ) => api().put(`/admin/catalog/products/${id}/relations`).send({ relations });

  it('refuses a self-relation, a repeated pair and a deleted product with 422', async () => {
    expect((await put(host.id, [{ relatedProductId: host.id, type: 'RELATED' }])).status).toBe(422);

    const repeated = await put(host.id, [
      { relatedProductId: b.id, type: 'RELATED', position: 0 },
      { relatedProductId: b.id, type: 'RELATED', position: 1 },
    ]);
    expect(repeated.status, JSON.stringify(repeated.body)).toBe(422);
    expect(repeated.body.error.details.repeated).toEqual([
      { type: 'RELATED', relatedProductId: b.id },
    ]);

    const deleted = await put(host.id, [{ relatedProductId: gone.id, type: 'ALTERNATIVE' }]);
    expect(deleted.status).toBe(422);
    expect(deleted.body.error.details.productIds).toEqual([gone.id]);

    // The same product under two different types is two relations, and fine.
    const twoTypes = await put(host.id, [
      { relatedProductId: b.id, type: 'RELATED' },
      { relatedProductId: b.id, type: 'COMPLEMENTARY' },
    ]);
    expect(twoTypes.status, JSON.stringify(twoTypes.body)).toBe(200);
  });

  it('groups every type in order on the PDP, and never shows a product a shopper cannot open', async () => {
    const saved = await put(host.id, [
      { relatedProductId: b.id, type: 'RELATED', position: 2 },
      { relatedProductId: c.id, type: 'RELATED', position: 1 },
      { relatedProductId: hidden.id, type: 'ALTERNATIVE', position: 0 },
      { relatedProductId: draft.id, type: 'REPLACEMENT', position: 0 },
      { relatedProductId: c.id, type: 'COMPLEMENTARY', position: 0 },
      { relatedProductId: b.id, type: 'FREQUENTLY_BOUGHT', position: 0 },
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.relations).toHaveLength(6);
    await settle();

    const page = await pdp(host.slug);
    expect(
      page.relationGroups.map((group) => ({
        type: group.type,
        slugs: group.items.map((i) => i.slug),
      })),
    ).toEqual([
      { type: 'RELATED', slugs: [c.slug, b.slug] },
      { type: 'COMPLEMENTARY', slugs: [c.slug] },
      { type: 'FREQUENTLY_BOUGHT', slugs: [b.slug] },
    ]);
    expect(page.related.map((card) => card.slug)).toEqual([c.slug, b.slug]);
    expect(page.frequentlyBoughtTogether.map((card) => card.slug)).toEqual([b.slug]);

    const shown = JSON.stringify(page);
    for (const unseen of [hidden, draft, gone]) expect(shown).not.toContain(unseen.slug);
  });

  it('serves exactly one curated type on request, never the category fallback under its name', async () => {
    const typed = async (type?: string) => {
      const response = await request(app)
        .get(`${API}/catalog/products/${host.slug}/related`)
        .query(type ? { type } : {});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return (response.body.data as Card[]).map((card) => card.slug);
    };

    expect(await typed('FREQUENTLY_BOUGHT')).toEqual([b.slug]);
    expect(await typed('RELATED')).toEqual([c.slug, b.slug]);
    // Only a hidden product is curated as ALTERNATIVE, and nothing is SIMILAR: both are empty.
    expect(await typed('ALTERNATIVE')).toEqual([]);
    expect(await typed('SIMILAR')).toEqual([]);
    expect(await typed()).toEqual([c.slug, b.slug]);
  });

  it('mirrors SIMILAR, and follows the related products own changes without a manual flush', async () => {
    const saved = await put(host.id, [
      { relatedProductId: b.id, type: 'SIMILAR', position: 0 },
      { relatedProductId: hidden.id, type: 'ALTERNATIVE', position: 0 },
    ]);
    expect(saved.status).toBe(200);
    await settle();

    const mirrored = await pdp(b.slug);
    expect(
      mirrored.relationGroups.find((group) => group.type === 'SIMILAR')?.items.map((i) => i.slug),
    ).toEqual([host.slug]);

    // Warm the host page, then let the hidden alternative go public through the admin API.
    expect((await pdp(host.slug)).relationGroups.map((group) => group.type)).toEqual(['SIMILAR']);
    const current = await prisma.product.findUniqueOrThrow({ where: { id: hidden.id } });
    const shown = await api()
      .patch(`/admin/catalog/products/${hidden.id}`)
      .send({ visibility: 'PUBLIC', version: current.version });
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    await settle();
    expect(
      (await pdp(host.slug)).relationGroups.map((group) => [group.type, group.items[0]!.slug]),
    ).toEqual([
      ['SIMILAR', b.slug],
      ['ALTERNATIVE', hidden.slug],
    ]);

    // Deleting a related product takes it off every related list at once.
    expect((await api().delete(`/admin/catalog/products/${b.id}`)).status).toBe(200);
    await settle();
    const after = await pdp(host.slug);
    expect(after.relationGroups.map((group) => group.type)).toEqual(['ALTERNATIVE']);
    expect(JSON.stringify(after)).not.toContain(b.slug);
  });
});

/* ------------------------------------------------ categories and contract work */

describe('the category contract', () => {
  it('tells the storefront which categories take enquiries, on the tree and the landing', async () => {
    const tree = await request(app).get(`${API}/catalog/categories/tree`);
    const flat: { slug: string; kind: string; leadFormKey: string | null; children: unknown[] }[] =
      [];
    const walk = (nodes: typeof flat) => {
      for (const node of nodes) {
        flat.push(node);
        walk(node.children as typeof flat);
      }
    };
    walk(tree.body.data);
    expect(flat.find((node) => node.slug === 'custom-hotel-furniture')).toMatchObject({
      kind: 'SERVICE',
      leadFormKey: 'contract-work',
    });
    expect(flat.find((node) => node.slug === 'sofas')).toMatchObject({
      kind: 'STANDARD',
      leadFormKey: null,
    });

    const landing = await request(app).get(`${API}/catalog/categories/contract-based-work/landing`);
    expect(landing.status, JSON.stringify(landing.body)).toBe(200);
    expect(landing.body.data.category).toMatchObject({
      kind: 'SERVICE',
      leadFormKey: 'contract-work',
    });
    expect(landing.body.data.featured).toEqual([]);
    expect(landing.body.data.productCount).toBe(0);
    expect(landing.body.data.children.length).toBeGreaterThan(0);
    for (const child of landing.body.data.children as { kind: string; leadFormKey: string }[]) {
      expect(child).toMatchObject({ kind: 'SERVICE', leadFormKey: 'contract-work' });
    }
  });

  it('never files a product under a service category, on any write path', async () => {
    const home = await category('svc-home');
    const item = await product('svc-item', home.id);
    const service = await prisma.category.findUniqueOrThrow({
      where: { slug: 'custom-hotel-furniture' },
    });

    const direct = await api()
      .put(`/admin/catalog/products/${item.id}/categories`)
      .send({ primaryCategoryId: service.id, categoryIds: [service.id] });
    expect(direct.status).toBe(422);
    expect(direct.body.error.code).toBe('CATEGORY_NOT_PURCHASABLE');

    const bulk = await api()
      .post('/admin/catalog/bulk')
      .send({ action: 'ADD_CATEGORY', ids: [item.id], categoryId: service.id });
    expect(bulk.status).toBe(422);
    expect(bulk.body.error.code).toBe('CATEGORY_NOT_PURCHASABLE');

    const imported = await importCsv('PRODUCT', [
      'sku,primaryCategorySlug',
      `${item.sku},${service.slug}`,
    ]);
    expect(imported.status).toBe('FAILED');
    expect(imported.errors[0]).toMatchObject({ column: 'categorySlugs' });

    expect(await prisma.productCategory.count({ where: { categoryId: service.id } })).toBe(0);

    // A shelf that holds products cannot quietly turn into a service line either.
    const shelf = await prisma.category.findUniqueOrThrow({ where: { id: home.id } });
    const flip = await api()
      .patch(`/admin/catalog/categories/${home.id}`)
      .send({ kind: 'SERVICE', version: shelf.version });
    expect(flip.status).toBe(409);
    expect(flip.body.error.code).toBe('CATEGORY_HAS_PRODUCTS');
  });

  it('keys the enquiry limiter on the client, so rotating the contact buys nothing', () => {
    const from = (email: string) => ({ ip: '203.0.113.9', body: { email } });
    expect(rateLimitKey('enquiry', from('a@example.com'), false)).toBe(
      rateLimitKey('enquiry', from('b@example.com'), false),
    );
    // Credential endpoints still key on the identifier being attacked.
    expect(rateLimitKey('login', from('a@example.com'))).not.toBe(
      rateLimitKey('login', from('b@example.com')),
    );
  });

  it('keeps counts right through moves, deletes, restores, bulk moves and tree changes', async () => {
    const root = await category('cnt-root');
    const shelfA = await category('cnt-a', root);
    const shelfB = await category('cnt-b', root);
    const arrivals = await category('cnt-new', root, { kind: 'NEW_ARRIVALS' });
    const recent = new Date(Date.now() - DAY);
    const item = await product('cnt-item', shelfA.id, { publishedAt: recent, createdAt: recent });
    await prisma.productMedia.create({
      data: { productId: item.id, mediaId: readyMediaIds[0]!, role: 'PRIMARY', primaryMark: true },
    });
    await prisma.product.update({
      where: { id: item.id },
      data: { description: 'Built one at a time in our own workshop. '.repeat(4) },
    });
    await fresh([item.id]);

    const counts = async () => ({
      a: await countOf(shelfA.id),
      b: await countOf(shelfB.id),
      new: await countOf(arrivals.id),
    });
    expect(await counts()).toEqual({ a: 1, b: 0, new: 1 });

    // Move through the admin API: counted at once, not on the reconciler's next pass.
    const moved = await api()
      .put(`/admin/catalog/products/${item.id}/categories`)
      .send({ primaryCategoryId: shelfB.id, categoryIds: [shelfB.id] });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    await settle();
    expect(await counts()).toEqual({ a: 0, b: 1, new: 1 });

    expect((await api().delete(`/admin/catalog/products/${item.id}`)).status).toBe(200);
    await settle();
    expect(await counts()).toEqual({ a: 0, b: 0, new: 0 });

    // A restore comes back as a draft (not counted) until it is published again.
    expect((await api().post(`/admin/catalog/products/${item.id}/restore`)).status).toBe(200);
    await settle();
    expect(await counts()).toEqual({ a: 0, b: 0, new: 0 });
    const published = await api().post(`/admin/catalog/products/${item.id}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    await settle();
    expect(await counts()).toEqual({ a: 0, b: 1, new: 1 });

    const bulk = await api()
      .post('/admin/catalog/bulk')
      .send({ action: 'MOVE_CATEGORY', ids: [item.id], categoryId: shelfA.id });
    expect(bulk.status, JSON.stringify(bulk.body)).toBe(200);
    expect(bulk.body.data.succeeded).toBe(1);
    await settle();
    expect(await counts()).toEqual({ a: 1, b: 0, new: 1 });

    // Moving the shelf out of the root takes its product out of the root's new-arrivals count.
    const shelf = await prisma.category.findUniqueOrThrow({ where: { id: shelfA.id } });
    const out = await api()
      .post(`/admin/catalog/categories/${shelfA.id}/move`)
      .send({ parentId: null, version: shelf.version });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    await settle();
    expect(await counts()).toEqual({ a: 1, b: 0, new: 0 });
  });

  it('keeps a subtree unreachable behind a deleted parent, and brings it back on restore', async () => {
    const parent = await category('del-parent');
    const child = await category('del-child', parent);
    const item = await product('del-item', child.id);
    await fresh([item.id]);
    expect(slugsOf(await listing({ categorySlug: child.slug }))).toEqual([item.slug]);

    const removed = await api().delete(`/admin/catalog/categories/${parent.id}?strategy=SOFT`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    await settle();

    // The child's own row was never touched, yet no public surface reaches it.
    expect(
      (await prisma.category.findUniqueOrThrow({ where: { id: child.id } })).deletedAt,
    ).toBeNull();
    expect((await request(app).get(`${API}/catalog/categories/${child.slug}`)).status).toBe(404);
    expect((await request(app).get(`${API}/catalog/categories/${child.slug}/landing`)).status).toBe(
      404,
    );
    expect(
      (await request(app).get(`${API}/catalog/products`).query({ categorySlug: child.slug }))
        .status,
    ).toBe(404);
    const tree = JSON.stringify((await request(app).get(`${API}/catalog/categories/tree`)).body);
    expect(tree).not.toContain(child.slug);
    const page = await pdp(item.slug);
    expect(JSON.stringify(page)).not.toContain(child.slug);
    expect(
      await prisma.searchDocument.count({ where: { entityType: 'CATEGORY', entityId: child.id } }),
    ).toBe(0);

    expect((await api().post(`/admin/catalog/categories/${parent.id}/restore`)).status).toBe(200);
    await settle();
    expect(slugsOf(await listing({ categorySlug: child.slug }))).toEqual([item.slug]);
  });

  it('lists Make Your Own by the category kind and the product fact, never by a name', async () => {
    const root = await category('myo-root');
    const shelf = await category('myo-shelf', root);
    const byKind = await category('myo-kind', root, { kind: 'MAKE_YOUR_OWN' });
    // Named like the feature, but an ordinary shelf: it must not pick products up by its name.
    const byName = await category('myo-name', root, { name: `Make Your Own Sofa ${tag}` });
    const custom = await product('myo-custom', shelf.id, { allowCustomization: true });
    await product('myo-plain', shelf.id);
    await fresh([custom.id]);

    expect(slugsOf(await listing({ categorySlug: byKind.slug }))).toEqual([custom.slug]);
    expect(await listing({ categorySlug: byName.slug })).toEqual([]);
    expect(await countOf(byKind.id)).toBe(1);
    expect(await countOf(byName.id)).toBe(0);
  });
});

/* ------------------------------------------------------------------- the clock */

describe('the catalog clock', () => {
  it('opens and closes a collection window in cached menus and lists on the next reconcile', async () => {
    const home = await category('win-home');
    const item = await product('win-item', home.id);
    const collection = await prisma.collection.create({
      data: {
        name: `CH window ${tag}`,
        slug: `ch-window-${tag}`,
        type: 'MANUAL',
        startsAt: new Date(Date.now() + 1_500),
        products: { create: { productId: item.id, position: 0 } },
      },
    });
    const menu = await prisma.navigationMenu.findUniqueOrThrow({
      where: { key: 'FOOTER_SECONDARY' },
    });
    await prisma.navigationItem.create({
      data: {
        menuId: menu.id,
        label: `CH window ${tag}`,
        type: 'COLLECTION',
        collectionId: collection.id,
        position: 99,
      },
    });
    await fresh([item.id]);
    await listingReconciler.runOnce(`ch-win-baseline-${tag}`);

    const inMenu = async () =>
      JSON.stringify((await request(app).get(`${API}/navigation/FOOTER_SECONDARY`)).body).includes(
        collection.slug,
      );
    const listed = async () =>
      (
        (await request(app).get(`${API}/catalog/collections`).query({ limit: 100 })).body.data as {
          slug: string;
        }[]
      ).some((row) => row.slug === collection.slug);

    expect(await inMenu()).toBe(false);
    expect(await listed()).toBe(false);

    await sleep(1_700);
    const opened = await listingReconciler.runOnce(`ch-win-open-${tag}`);
    expect(opened.schedule.collectionWindows).toBeGreaterThanOrEqual(1);
    expect(opened.cachesDropped).toBe(true);
    expect(await inMenu()).toBe(true);
    expect(await listed()).toBe(true);

    // Closing is a direct write too; the cached menu still shows it until the boundary passes.
    await prisma.collection.update({
      where: { id: collection.id },
      data: { endsAt: new Date(Date.now() + 1_500) },
    });
    await sleep(1_700);
    const closed = await listingReconciler.runOnce(`ch-win-close-${tag}`);
    expect(closed.schedule.collectionWindows).toBeGreaterThanOrEqual(1);
    expect(await inMenu()).toBe(false);
    expect(await listed()).toBe(false);
  });

  it('ages a product out of the new-arrival window on time, counts included', async () => {
    const set = await api().put('/admin/catalog/settings').send({ newArrivalDays: 1 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    try {
      const root = await category('age-root');
      const shelf = await category('age-shelf', root);
      const arrivals = await category('age-new', root, { kind: 'NEW_ARRIVALS' });
      const almost = new Date(Date.now() - DAY + 2_000);
      const item = await product('age-item', shelf.id, { publishedAt: almost, createdAt: almost });
      await fresh([item.id]);
      await listingReconciler.runOnce(`ch-age-baseline-${tag}`);

      expect(slugsOf(await listing({ categorySlug: arrivals.slug }))).toEqual([item.slug]);
      expect((await listing({ categorySlug: shelf.slug }))[0]!.isNewArrival).toBe(true);
      expect(await countOf(arrivals.id)).toBe(1);

      await sleep(2_300);
      const run = await listingReconciler.runOnce(`ch-age-late-${tag}`);
      expect(run.schedule.arrivalsAged).toBeGreaterThanOrEqual(1);
      expect(run.schedule.countsUpdated).toBeGreaterThanOrEqual(1);

      // Nobody flushed a cache: the reconcile that saw the boundary did.
      expect(await listing({ categorySlug: arrivals.slug })).toEqual([]);
      expect((await listing({ categorySlug: shelf.slug }))[0]!.isNewArrival).toBe(false);
      expect(await countOf(arrivals.id)).toBe(0);
    } finally {
      const reset = await api().put('/admin/catalog/settings').send({ newArrivalDays: 30 });
      expect(reset.status).toBe(200);
    }
  });

  it('reports each transition exactly once across racing workers, and a rerun moves nothing', async () => {
    const home = await category('race-home');
    const item = await product('race-item', home.id, { publishedAt: new Date(Date.now() + 1_200) });
    await fresh();
    await listingReconciler.runOnce(`ch-race-baseline-${tag}`);

    await sleep(1_400);
    const racers = await Promise.all([
      listingReconciler.runOnce(`ch-race-a-${tag}`),
      listingReconciler.runOnce(`ch-race-b-${tag}`),
    ]);
    expect(racers.some((outcome) => outcome.ran)).toBe(true);
    expect(racers.reduce((sum, outcome) => sum + outcome.schedule.published, 0)).toBe(1);

    const rerun = await listingReconciler.runOnce(`ch-race-c-${tag}`);
    expect(rerun.ran).toBe(true);
    expect(rerun.schedule.published).toBe(0);

    expect(slugsOf(await listing({ categorySlug: home.slug }))).toEqual([item.slug]);
    expect(
      await prisma.searchDocument.count({ where: { entityType: 'PRODUCT', entityId: item.id } }),
    ).toBe(1);
  });
});

/* ------------------------------------------------------------- badges and CMS */

describe('badges and CMS product blocks follow the data', () => {
  async function gridOn(page: string, productIds: string[]) {
    const host = await prisma.page.findFirstOrThrow({ where: { slug: page } });
    const block = await prisma.pageBlock.create({
      data: {
        pageId: host.id,
        type: 'PRODUCT_GRID',
        position: 900 + Math.floor(Math.random() * 90),
        isActive: true,
        configJson: JSON.stringify({ productIds, limit: 4 }),
      },
    });
    await catalogCacheService.invalidateCmsPages();
    return block;
  }

  async function gridCards(page: string, blockId: string): Promise<Card[]> {
    const rendered = await pageRendererService.renderBySlug(page, {});
    return (rendered.blocks.find((entry) => entry.id === blockId)?.data.products ?? []) as Card[];
  }

  it('drops a disabled badge from cards, the PDP, search and cached CMS pages at once', async () => {
    const home = await category('badge-home');
    const token = `badgetoken${tag}`;
    const item = await product('badge-item', home.id, {
      compareAtPricePaise: 12_000_00,
      searchKeywords: token,
    });
    await fresh([item.id]);
    const block = await gridOn('privacy-policy', [item.id]);

    const hasSale = (badges: Card['badges']) => badges.some((badge) => badge.code === 'SALE');
    const surfaces = async () => {
      const search = await request(app)
        .get(`${API}/search`)
        .query({ q: token, includeFacets: false });
      expect(search.status, JSON.stringify(search.body)).toBe(200);
      const found = (search.body.data.products.items as Card[]).find((card) => card.id === item.id);
      return {
        card: hasSale((await listing({ categorySlug: home.slug }))[0]!.badges),
        pdp: hasSale((await pdp(item.slug)).badges),
        search: found ? hasSale(found.badges) : null,
        cms: hasSale((await gridCards('privacy-policy', block.id))[0]!.badges),
      };
    };

    try {
      expect(await surfaces()).toEqual({ card: true, pdp: true, search: true, cms: true });

      const off = await api()
        .put('/admin/catalog/settings')
        .send({ badges: { SALE: null } });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      await settle();
      expect(await surfaces()).toEqual({ card: false, pdp: false, search: false, cms: false });
    } finally {
      await api()
        .put('/admin/catalog/settings')
        .send({ badges: { SALE: { label: 'Sale', color: '#B23B3B' } } });
      await prisma.pageBlock.delete({ where: { id: block.id } });
      await catalogCacheService.invalidateCmsPages();
    }
  });

  it('re-renders a cached CMS product block when the product is edited', async () => {
    const home = await category('cms-home');
    const item = await product('cms-item', home.id);
    await fresh([item.id]);
    const block = await gridOn('privacy-policy', [item.id]);

    try {
      expect((await gridCards('privacy-policy', block.id))[0]!.name).toBe(
        `Hardening cms-item ${tag}`,
      );

      const current = await prisma.product.findUniqueOrThrow({ where: { id: item.id } });
      const renamed = await api()
        .patch(`/admin/catalog/products/${item.id}`)
        .send({ name: `Renamed in admin ${tag}`, version: current.version });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      await settle();

      expect((await gridCards('privacy-policy', block.id))[0]!.name).toBe(
        `Renamed in admin ${tag}`,
      );
    } finally {
      await prisma.pageBlock.delete({ where: { id: block.id } });
      await catalogCacheService.invalidateCmsPages();
    }
  });
});

/* -------------------------------------------------------------- search sync */

describe('search stays in step with admin writes', () => {
  const doc = (entityType: string, entityId: string) =>
    prisma.searchDocument.findFirst({ where: { entityType, entityId } });

  it('follows SKU, spec, brand and visibility changes, and prunes a deleted collection', async () => {
    const home = await category('srch-home');
    const item = await product('srch-item', home.id);
    await fresh([item.id]);

    const version = async () =>
      (await prisma.product.findUniqueOrThrow({ where: { id: item.id } })).version;

    // SKU
    const sku = `CH-RESKU-${TAG}`;
    const resku = await api()
      .patch(`/admin/catalog/products/${item.id}`)
      .send({ sku, version: await version() });
    expect(resku.status, JSON.stringify(resku.body)).toBe(200);
    await settle();
    expect((await doc('PRODUCT', item.id))?.sku).toBe(sku);
    const bySku = await request(app).get(`${API}/search`).query({ q: sku, includeFacets: false });
    expect((bySku.body.data.products.items as Card[]).map((card) => card.id)).toContain(item.id);

    // Spec value
    const attribute = await prisma.attribute.create({
      data: {
        code: `CH_WEAVE_${TAG}`,
        name: `Weave ${tag}`,
        inputType: 'SELECT',
        values: { create: { code: 'LOOSE', label: `Loose weave ${tag}`, position: 0 } },
      },
      include: { values: true },
    });
    await prisma.categoryAttribute.create({
      data: { categoryId: home.id, attributeId: attribute.id, position: 0 },
    });
    const specs = await api()
      .put(`/admin/catalog/products/${item.id}/attribute-values`)
      .send({
        values: [{ attributeId: attribute.id, attributeValueId: attribute.values[0]!.id }],
      });
    expect(specs.status, JSON.stringify(specs.body)).toBe(200);
    await settle();
    expect((await doc('PRODUCT', item.id))?.attributeText).toContain(`Loose weave ${tag}`);

    // Brand, then a brand rename
    const brand = await api()
      .post('/admin/catalog/brands')
      .send({ name: `CH Brand ${tag}`, slug: `ch-brand-${tag}` });
    expect(brand.status, JSON.stringify(brand.body)).toBe(201);
    const branded = await api()
      .patch(`/admin/catalog/products/${item.id}`)
      .send({ brandId: brand.body.data.id, version: await version() });
    expect(branded.status, JSON.stringify(branded.body)).toBe(200);
    await settle();
    expect((await doc('PRODUCT', item.id))?.brandText).toBe(`CH Brand ${tag}`);

    const rebrand = await api()
      .patch(`/admin/catalog/brands/${brand.body.data.id}`)
      .send({ name: `CH Maison ${tag}`, version: brand.body.data.version });
    expect(rebrand.status, JSON.stringify(rebrand.body)).toBe(200);
    await settle();
    expect((await doc('PRODUCT', item.id))?.brandText).toBe(`CH Maison ${tag}`);

    // Visibility
    const hide = await api()
      .patch(`/admin/catalog/products/${item.id}`)
      .send({ visibility: 'HIDDEN', version: await version() });
    expect(hide.status, JSON.stringify(hide.body)).toBe(200);
    await settle();
    const hiddenDoc = await doc('PRODUCT', item.id);
    expect(hiddenDoc === null || hiddenDoc.isActive === false).toBe(true);
    const gone = await request(app).get(`${API}/search`).query({ q: sku, includeFacets: false });
    expect((gone.body.data.products.items as Card[]).map((card) => card.id)).not.toContain(item.id);

    // A collection's document goes when the collection does
    const visible = await product('srch-coll', home.id);
    await fresh([visible.id]);
    const created = await api()
      .post('/admin/catalog/collections')
      .send({ name: `CH Search Coll ${tag}`, slug: `ch-search-coll-${tag}` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const collectionId = created.body.data.id as string;
    const filled = await api()
      .put(`/admin/catalog/collections/${collectionId}/products`)
      .send({ productIds: [visible.id] });
    expect(filled.status, JSON.stringify(filled.body)).toBe(200);
    await settle();
    expect(
      await eventually(
        () => doc('COLLECTION', collectionId),
        (row) => row !== null,
      ),
    ).not.toBeNull();

    expect((await api().delete(`/admin/catalog/collections/${collectionId}`)).status).toBe(200);
    await settle();
    expect(
      await eventually(
        () => doc('COLLECTION', collectionId),
        (row) => row === null,
      ),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------ pricing authority */

describe('price stays server-authoritative', () => {
  it('ignores a price a client sends with a quote', async () => {
    const home = await category('auth-home');
    const item = await product('auth-item', home.id);
    await fresh([item.id]);

    const quote = await request(app)
      .post(`${API}/pricing/quote`)
      .send({
        items: [{ productId: item.id, qty: 1, unitPricePaise: 1, pricePaise: 1 }],
        unitPricePaise: 1,
      });
    // Either refused outright or priced by the engine - never at the client's figure.
    if (quote.status === 200) {
      expect(quote.body.data.lines[0].unitPricePaise).toBe(10_000_00);
    } else {
      expect(quote.status).toBe(422);
    }
  });
});

/* -------------------------------------------------------------------- media */

describe('media follows its owners', () => {
  it('attaches, moves, detaches and restores a collection image usage', async () => {
    const [first, second] = readyMediaIds as [string, string, string];
    const usage = (mediaId: string, entityId: string) =>
      prisma.mediaUsage.count({ where: { mediaId, usageType: 'COLLECTION_IMAGE', entityId } });

    const created = await api()
      .post('/admin/catalog/collections')
      .send({ name: `CH Media Coll ${tag}`, slug: `ch-media-coll-${tag}`, imageMediaId: first });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    expect(await usage(first, id)).toBe(1);

    const moved = await api()
      .patch(`/admin/catalog/collections/${id}`)
      .send({ imageMediaId: second, version: created.body.data.version });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await usage(first, id)).toBe(0);
    expect(await usage(second, id)).toBe(1);

    expect((await api().delete(`/admin/catalog/collections/${id}`)).status).toBe(200);
    expect(await usage(second, id)).toBe(0);

    expect((await api().post(`/admin/catalog/collections/${id}/restore`)).status).toBe(200);
    expect(await usage(second, id)).toBe(1);
  });

  it('shows a gallery reorder on the product page at once', async () => {
    const home = await category('gal-home');
    const item = await product('gal-item', home.id);
    await fresh([item.id]);
    const [primary, one, two] = readyMediaIds as [string, string, string];

    const attached = await api()
      .post(`/admin/products/${item.id}/media`)
      .send({
        items: [
          { mediaId: primary, role: 'PRIMARY' },
          { mediaId: one, role: 'GALLERY', position: 1 },
          { mediaId: two, role: 'GALLERY', position: 2 },
        ],
      });
    expect(attached.status, JSON.stringify(attached.body)).toBe(201);
    const idOf = (mediaId: string) =>
      (attached.body.data as { id: string; mediaId: string }[]).find(
        (row) => row.mediaId === mediaId,
      )!.id;

    expect((await pdp(item.slug)).gallery.map((image) => image.mediaId)).toEqual([
      primary,
      one,
      two,
    ]);

    const reordered = await api()
      .patch(`/admin/products/${item.id}/media/reorder`)
      .send({
        items: [
          { id: idOf(two), position: 1 },
          { id: idOf(one), position: 2 },
        ],
      });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);

    expect((await pdp(item.slug)).gallery.map((image) => image.mediaId)).toEqual([
      primary,
      two,
      one,
    ]);
  });
});
