import { randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { catalogEvents } from '../src/events/catalogEvents';
import { passwordService } from '../src/modules/auth/password.service';
import { catalogCacheService } from '../src/modules/catalog-admin/catalogCache.service';
import { importService } from '../src/modules/catalog-admin/import-export/import.service';
import { listingReconciler } from '../src/modules/storefront/listingReconciler.service';
import { searchIndexerService } from '../src/modules/storefront/searchIndexer.service';
import { mark } from '../src/utils/uniqueMark';

/**
 * The dynamic catalog (PROJECT_CONTEXT §47): an admin changes the catalog through the API and the
 * storefront follows - effective category visibility, rule categories, time-aware merchandising
 * reconciled over time, data-driven badges, curated order, gated bulk actions, variant option
 * rules, CSV import that applies the API's rules, gallery usage, catalog settings, the enquiry
 * foundation for contract work, and the whole admin -> customer flow end to end.
 *
 * Every fixture lives under trees of its own, so exact sets can be asserted.
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

/* ---------------------------------------------------------------- sessions */

interface Session {
  header: string;
  csrf: string;
  id: string;
}

async function admin(email: string, roleCode: string): Promise<Session> {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: `Catmgmt ${roleCode}`,
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
    id: user.id,
  };
}

/** A role holding exactly these permissions, for the "has update but not publish" cases. */
async function roleWith(code: string, permissions: string[]): Promise<string> {
  const rows = await prisma.permission.findMany({ where: { code: { in: permissions } } });
  expect(rows).toHaveLength(permissions.length);
  const role = await prisma.role.create({
    data: {
      code: `${code}_${TAG}`,
      name: `Catmgmt ${code}`,
      permissions: { create: rows.map((row) => ({ permissionId: row.id })) },
    },
  });
  return role.code;
}

function as(session: Session) {
  const send = (method: 'post' | 'patch' | 'put' | 'delete', url: string) =>
    request(app)
      [method](`${API}${url}`)
      .set('Cookie', session.header)
      .set('X-CSRF-Token', session.csrf);
  return {
    get: (url: string) => request(app).get(`${API}${url}`).set('Cookie', session.header),
    post: (url: string) => send('post', url),
    patch: (url: string) => send('patch', url),
    put: (url: string) => send('put', url),
    delete: (url: string) => send('delete', url),
  };
}

let catalogManager: Session;
let contentManager: Session;
let orderManager: Session;
let merchandiser: Session;
let enquiryWorker: Session;

/* ---------------------------------------------------------------- fixtures */

interface Node {
  id: string;
  slug: string;
  path: string;
  depth: number;
}

async function category(
  name: string,
  parent?: Node,
  extra: Partial<Prisma.CategoryUncheckedCreateInput> = {},
): Promise<Node> {
  const slug = `cm-${name}-${tag}`;
  return prisma.category.create({
    data: {
      name: `CM ${name} ${tag}`,
      slug,
      parentId: parent?.id ?? null,
      path: parent ? `${parent.path}/${slug}` : slug,
      depth: parent ? parent.depth + 1 : 0,
      ...extra,
    },
    select: { id: true, slug: true, path: true, depth: true },
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
      sku: `CM-${key}-${tag}`,
      slug: `cm-${key}-${tag}`,
      name: `Catmgmt ${key} ${tag}`,
      status: 'ACTIVE',
      visibility: 'PUBLIC',
      basePricePaise: 10_000_00,
      publishedAt: old,
      createdAt: old,
      ...extra,
      categories: { create: { categoryId, isPrimary: true, primaryMark: mark(true) } },
      variants: {
        create: {
          sku: `CM-${key}-${tag}-v`,
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

/** Fixtures below are written straight to MySQL, so the caches they would have dropped go too. */
async function fresh(): Promise<void> {
  await catalogCacheService.invalidateAll();
}

interface Card {
  id: string;
  slug: string;
  pricePaise: number;
  indexedMinPricePaise: number | null;
  indexedMaxPricePaise: number | null;
  isNewArrival: boolean;
  isFeatured: boolean;
  badges: { code: string; label: string; color: string | null }[];
  swatches: unknown[];
  [key: string]: unknown;
}

interface Listing {
  items: Card[];
  facets: { key: string; values: { value: string; count: number; label: string }[] }[];
  totalCount: number;
}

async function listing(params: Record<string, string | number | boolean>): Promise<Listing> {
  const response = await request(app)
    .get(`${API}/catalog/products`)
    .query({ limit: 96, includeFacets: false, ...params });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as Listing;
}

const slugsOf = (list: Listing) => list.items.map((item) => item.slug).sort();

let defaultTaxClassId: string;
let readyMediaId: string;

beforeAll(async () => {
  catalogManager = await admin(`cm.catalog.${tag}@clearwood.local`, 'CATALOG_MANAGER');
  contentManager = await admin(`cm.content.${tag}@clearwood.local`, 'CONTENT_MANAGER');
  orderManager = await admin(`cm.orders.${tag}@clearwood.local`, 'ORDER_MANAGER');
  merchandiser = await admin(
    `cm.merch.${tag}@clearwood.local`,
    await roleWith('MERCH', ['catalog.product.read', 'catalog.product.update']),
  );
  enquiryWorker = await admin(
    `cm.leads.${tag}@clearwood.local`,
    await roleWith('LEADS', ['lead.enquiry.read', 'lead.enquiry.update']),
  );

  defaultTaxClassId = (
    await prisma.taxClass.findFirstOrThrow({ where: { isDefault: true, deletedAt: null } })
  ).id;
  readyMediaId = (
    await prisma.media.findFirstOrThrow({
      where: { deletedAt: null, status: 'READY' },
      orderBy: { id: 'asc' },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await catalogEvents.settled();
  await listingReconciler.idle();
});

/* ------------------------------------------------------- category visibility */

describe('effective category visibility', () => {
  it('hides a whole subtree behind an inactive parent, everywhere, and brings it back', async () => {
    const root = await category('vis-root');
    const child = await category('vis-child', root);
    const item = await product('vis-item', child.id);
    await searchIndexerService.indexProducts([item.id]);
    await fresh();

    const inTree = async () => {
      const tree = await request(app).get(`${API}/catalog/categories/tree`);
      const flat = JSON.stringify(tree.body.data);
      return { root: flat.includes(`"${root.slug}"`), child: flat.includes(`"${child.slug}"`) };
    };

    expect(await inTree()).toEqual({ root: true, child: true });
    expect((await request(app).get(`${API}/catalog/categories/${child.slug}`)).status).toBe(200);
    expect(slugsOf(await listing({ categorySlug: child.slug }))).toEqual([item.slug]);

    const current = await prisma.category.findUniqueOrThrow({ where: { id: root.id } });
    const off = await as(catalogManager)
      .patch(`/admin/catalog/categories/${root.id}`)
      .send({ isActive: false, version: current.version });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    await catalogEvents.settled();

    // The child's own flag never changed, yet it is gone from every surface.
    expect((await prisma.category.findUniqueOrThrow({ where: { id: child.id } })).isActive).toBe(
      true,
    );
    expect(await inTree()).toEqual({ root: false, child: false });
    expect((await request(app).get(`${API}/catalog/categories/${child.slug}`)).status).toBe(404);
    expect(
      (
        await request(app)
          .get(`${API}/catalog/products`)
          .query({ categorySlug: child.slug, includeFacets: false })
      ).status,
    ).toBe(404);

    const document = await prisma.searchDocument.findFirstOrThrow({
      where: { entityType: 'PRODUCT', entityId: item.id },
    });
    expect(document.categoryText).not.toContain(`CM vis-child ${tag}`);
    expect(
      await prisma.searchDocument.count({ where: { entityType: 'CATEGORY', entityId: child.id } }),
    ).toBe(0);

    const on = await as(catalogManager)
      .patch(`/admin/catalog/categories/${root.id}`)
      .send({ isActive: true, version: current.version + 1 });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    await catalogEvents.settled();

    expect(await inTree()).toEqual({ root: true, child: true });
    expect(slugsOf(await listing({ categorySlug: child.slug }))).toEqual([item.slug]);
  });

  it('refuses to restore a category under a deleted parent', async () => {
    const parent = await category('orphan-parent');
    const child = await category('orphan-child', parent);

    expect(
      (await as(catalogManager).delete(`/admin/catalog/categories/${child.id}?strategy=SOFT`))
        .status,
    ).toBe(200);
    expect(
      (await as(catalogManager).delete(`/admin/catalog/categories/${parent.id}?strategy=SOFT`))
        .status,
    ).toBe(200);

    const restore = await as(catalogManager).post(`/admin/catalog/categories/${child.id}/restore`);
    expect(restore.status).toBe(409);
    expect(restore.body.error.code).toBe('CATEGORY_PARENT_DELETED');
  });
});

/* -------------------------------------------------------- collection windows */

describe('collection windows', () => {
  it('keeps a collection off the storefront outside its startsAt/endsAt window', async () => {
    const home = await category('coll-home');
    const item = await product('coll-item', home.id);
    const upcoming = await prisma.collection.create({
      data: {
        name: `CM upcoming ${tag}`,
        slug: `cm-upcoming-${tag}`,
        type: 'MANUAL',
        startsAt: new Date(Date.now() + 7 * DAY),
        products: { create: { productId: item.id, position: 0 } },
      },
    });
    await fresh();

    const listed = async () =>
      (await request(app).get(`${API}/catalog/collections`).query({ limit: 100 })).body.data as {
        slug: string;
      }[];

    expect((await request(app).get(`${API}/catalog/collections/${upcoming.slug}`)).status).toBe(
      404,
    );
    expect((await listed()).some((row) => row.slug === upcoming.slug)).toBe(false);

    await prisma.collection.update({
      where: { id: upcoming.id },
      data: { startsAt: new Date(Date.now() - DAY) },
    });
    await fresh();
    expect((await request(app).get(`${API}/catalog/collections/${upcoming.slug}`)).status).toBe(
      200,
    );

    await prisma.collection.update({
      where: { id: upcoming.id },
      data: { endsAt: new Date(Date.now() - 1_000) },
    });
    await fresh();
    expect((await request(app).get(`${API}/catalog/collections/${upcoming.slug}`)).status).toBe(
      404,
    );
  });
});

/* --------------------------------------------- the clock, reconciled over time */

describe('scheduled publication and featured windows', () => {
  it('lists, indexes and un-features on time, with no cache flush and no admin write', async () => {
    // Earlier category writes may have asked for a background rebuild; let it finish first, so
    // this test's two passes hold the lease and the boundary falls between them.
    await catalogEvents.settled();
    await listingReconciler.idle();
    // A rebuild request still pending is served here, not by the timed passes below.
    await listingReconciler.runOnce(`cm-drain-${tag}`);

    const boundary = new Date(Date.now() + 3_000);
    const home = await category('clock-home');
    const baseline = await product('clock-live', home.id);
    const scheduled = await product('clock-sched', home.id, { publishedAt: boundary });
    const featured = await product('clock-feat', home.id, {
      isFeatured: true,
      featuredUntil: boundary,
    });
    await searchIndexerService.indexProducts([baseline.id, scheduled.id, featured.id]);
    await fresh();
    expect((await listingReconciler.runOnce(`cm-baseline-${tag}`)).ran).toBe(true);
    expect(Date.now()).toBeLessThan(boundary.getTime());

    // Warm the caches before the boundary: the run after it must not leave them behind.
    expect(slugsOf(await listing({ categorySlug: home.slug }))).toEqual(
      [baseline.slug, featured.slug].sort(),
    );
    expect(slugsOf(await listing({ categorySlug: home.slug, isFeatured: true }))).toEqual([
      featured.slug,
    ]);
    expect(
      await prisma.searchDocument.count({
        where: { entityType: 'PRODUCT', entityId: scheduled.id },
      }),
    ).toBe(0);

    const admin = await as(catalogManager).get(
      `/admin/catalog/products?publication=SCHEDULED&q=${encodeURIComponent(scheduled.sku)}`,
    );
    expect(admin.body.data.map((row: { id: string }) => row.id)).toEqual([scheduled.id]);
    expect(admin.body.data[0].publication).toBe('SCHEDULED');

    await sleep(Math.max(0, boundary.getTime() - Date.now()) + 200);
    await catalogEvents.settled();
    await listingReconciler.idle();
    const run = await listingReconciler.runOnce(`cm-late-${tag}`);
    expect(run.ran).toBe(true);
    expect(run.schedule.published).toBeGreaterThanOrEqual(1);
    expect(run.schedule.featureEnded).toBeGreaterThanOrEqual(1);
    expect(run.cachesDropped).toBe(true);

    expect(slugsOf(await listing({ categorySlug: home.slug }))).toEqual(
      [baseline.slug, featured.slug, scheduled.slug].sort(),
    );
    expect(slugsOf(await listing({ categorySlug: home.slug, isFeatured: true }))).toEqual([]);
    const card = (await listing({ categorySlug: home.slug })).items.find(
      (item) => item.id === featured.id,
    )!;
    expect(card.isFeatured).toBe(false);

    const document = await prisma.searchDocument.findFirstOrThrow({
      where: { entityType: 'PRODUCT', entityId: featured.id },
    });
    expect(document.boostScore).toBe(0);
    expect(
      await prisma.searchDocument.count({
        where: { entityType: 'PRODUCT', entityId: scheduled.id },
      }),
    ).toBe(1);
  });
});

/* ------------------------------------------ rule categories and new arrivals */

describe('rule categories and dynamic new arrivals', () => {
  let root: Node;
  let arrivals: Node;
  const made: Record<string, Made> = {};

  beforeAll(async () => {
    root = await category('rule-root');
    const shelf = await category('rule-shelf', root);
    arrivals = await category('rule-new', root, { kind: 'NEW_ARRIVALS' });
    await category('rule-special', root, { kind: 'SPECIAL_COLLECTION' });
    await category('rule-custom', root, { kind: 'MAKE_YOUR_OWN' });
    const elsewhere = await category('rule-elsewhere');

    const recent = new Date(Date.now() - DAY);
    made.fresh = await product('rule-fresh', shelf.id, { publishedAt: recent, createdAt: recent });
    made.old = await product('rule-old', shelf.id);
    made.flagged = await product('rule-flagged', shelf.id, { isNewArrival: true });
    made.special = await product('rule-special-item', shelf.id, { isSpecialCollection: true });
    made.custom = await product('rule-custom-item', shelf.id, { allowCustomization: true });
    // Fresh, but outside the rule category's parent: it must not leak in.
    made.outside = await product('rule-outside', elsewhere.id, {
      publishedAt: recent,
      createdAt: recent,
    });
    await fresh();
  });

  it('lists each rule category from its parent subtree by the fact, without tagging', async () => {
    expect(slugsOf(await listing({ categorySlug: arrivals.slug }))).toEqual(
      [made.fresh!.slug, made.flagged!.slug].sort(),
    );
    expect(slugsOf(await listing({ categorySlug: `cm-rule-special-${tag}` }))).toEqual([
      made.special!.slug,
    ]);
    expect(slugsOf(await listing({ categorySlug: `cm-rule-custom-${tag}` }))).toEqual([
      made.custom!.slug,
    ]);

    const cards = (await listing({ categorySlug: root.slug })).items;
    const byId = new Map(cards.map((card) => [card.id, card]));
    expect(byId.get(made.fresh!.id)!.isNewArrival).toBe(true);
    expect(byId.get(made.old!.id)!.isNewArrival).toBe(false);
    expect(byId.get(made.flagged!.id)!.isNewArrival).toBe(true);
  });

  it('follows the admin-set window, and counts what each rule category lists', async () => {
    const off = await as(catalogManager).put('/admin/catalog/settings').send({ newArrivalDays: 0 });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.data.newArrivalDays).toBe(0);

    try {
      // Only the admin's override is left; nobody flushed a cache by hand.
      expect(slugsOf(await listing({ categorySlug: arrivals.slug }))).toEqual([made.flagged!.slug]);
      const counted = await prisma.category.findUniqueOrThrow({ where: { id: arrivals.id } });
      expect(counted.productCountCache).toBe(1);
    } finally {
      const on = await as(catalogManager)
        .put('/admin/catalog/settings')
        .send({ newArrivalDays: 30 });
      expect(on.status).toBe(200);
    }

    expect(slugsOf(await listing({ categorySlug: arrivals.slug }))).toEqual(
      [made.fresh!.slug, made.flagged!.slug].sort(),
    );
    expect(
      (await prisma.category.findUniqueOrThrow({ where: { id: arrivals.id } })).productCountCache,
    ).toBe(2);
  });

  it('shows the badges an admin configured, the product badge first, and drops a removed one', async () => {
    await prisma.product.update({
      where: { id: made.flagged!.id },
      data: { badgeText: 'Festive pick', badgeColor: '#B4613A', compareAtPricePaise: 12_000_00 },
    });
    const put = await as(catalogManager)
      .put('/admin/catalog/settings')
      .send({
        badges: {
          NEW_ARRIVAL: { label: `Just in ${tag}`, color: '#7E8C77' },
          SALE: { label: 'Sale', color: null },
        },
      });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    // Merged per code: a badge the request did not mention is kept.
    expect(Object.keys(put.body.data.badges)).toEqual(
      expect.arrayContaining(['NEW_ARRIVAL', 'SALE']),
    );

    const card = (await listing({ categorySlug: arrivals.slug })).items.find(
      (item) => item.id === made.flagged!.id,
    )!;
    expect(card.badges[0]).toEqual({ code: 'CUSTOM', label: 'Festive pick', color: '#B4613A' });
    expect(card.badges).toContainEqual({
      code: 'NEW_ARRIVAL',
      label: `Just in ${tag}`,
      color: '#7E8C77',
    });
    expect(card.badges).toContainEqual({ code: 'SALE', label: 'Sale', color: null });

    const pdp = await request(app).get(`${API}/catalog/products/${made.flagged!.slug}`);
    expect(pdp.status).toBe(200);
    expect(pdp.body.data.badges).toEqual(card.badges);

    const removed = await as(catalogManager)
      .put('/admin/catalog/settings')
      .send({ badges: { NEW_ARRIVAL: null } });
    expect(removed.body.data.badges.NEW_ARRIVAL).toBeUndefined();
    const after = (await listing({ categorySlug: arrivals.slug })).items.find(
      (item) => item.id === made.flagged!.id,
    )!;
    expect(after.badges.some((badge) => badge.code === 'NEW_ARRIVAL')).toBe(false);
  });
});

/* ----------------------------------------------------------- catalog settings */

describe('catalog settings', () => {
  it('is permission-gated and validated', async () => {
    const read = await as(orderManager).get('/admin/catalog/settings');
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual(
      expect.objectContaining({
        defaultPageSize: expect.any(Number),
        newArrivalDays: expect.any(Number),
        badges: expect.any(Object),
      }),
    );

    expect(
      (await as(orderManager).put('/admin/catalog/settings').send({ newArrivalDays: 5 })).status,
    ).toBe(403);

    const invalid = await as(catalogManager)
      .put('/admin/catalog/settings')
      .send({ defaultPageSize: 90, maxPageSize: 60 });
    expect(invalid.status).toBe(422);

    const unknownBadge = await as(catalogManager)
      .put('/admin/catalog/settings')
      .send({ badges: { SHOUTING: { label: 'Hey', color: null } } });
    expect(unknownBadge.status).toBe(422);
  });
});

/* -------------------------------------------------------- curated category order */

describe('curated category order', () => {
  it('lists a category in the order the admin set, and refuses products it does not hold', async () => {
    const shelf = await category('curated');
    const first = await product('curated-a', shelf.id);
    const second = await product('curated-b', shelf.id);
    const stranger = await product('curated-x', (await category('curated-other')).id);
    await prisma.productCategory.update({
      where: { productId_categoryId: { productId: second.id, categoryId: shelf.id } },
      data: { position: 1 },
    });
    await fresh();

    const before = await as(catalogManager).get(`/admin/catalog/categories/${shelf.id}/products`);
    expect(before.status).toBe(200);
    expect(before.body.data.map((row: { productId: string }) => row.productId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(before.body.meta.total).toBe(2);
    expect(before.body.data[0].publication).toBe('LIVE');

    const curated = () =>
      listing({ categorySlug: shelf.slug, sort: 'CURATED' }).then((list) =>
        list.items.map((item) => item.id),
      );
    expect(await curated()).toEqual([first.id, second.id]);

    const reorder = await as(catalogManager)
      .post(`/admin/catalog/categories/${shelf.id}/products/reorder`)
      .send({
        items: [
          { id: second.id, position: 0 },
          { id: first.id, position: 1 },
        ],
      });
    expect(reorder.status, JSON.stringify(reorder.body)).toBe(200);
    expect(await curated()).toEqual([second.id, first.id]);

    const foreign = await as(catalogManager)
      .post(`/admin/catalog/categories/${shelf.id}/products/reorder`)
      .send({ items: [{ id: stranger.id, position: 0 }] });
    expect(foreign.status).toBe(422);
  });
});

/* --------------------------------------------------------------------- bulk */

describe('bulk actions', () => {
  it('gates ACTIVATE on the publish permission and the publish gate, per id', async () => {
    const shelf = await category('bulk');
    const ready = await product('bulk-ready', shelf.id, {
      status: 'DRAFT',
      publishedAt: null,
      taxClassId: defaultTaxClassId,
    });
    await prisma.productMedia.create({
      data: { productId: ready.id, mediaId: readyMediaId, role: 'PRIMARY', primaryMark: true },
    });
    const bare = await product('bulk-bare', shelf.id, { status: 'DRAFT', publishedAt: null });

    const body = { action: 'ACTIVATE', ids: [ready.id, bare.id, `missing${tag}`] };
    expect((await as(merchandiser).post('/admin/catalog/bulk').send(body)).status).toBe(403);

    const result = await as(catalogManager).post('/admin/catalog/bulk').send(body);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data).toMatchObject({ requested: 3, succeeded: 1, failed: 2 });
    const byId = new Map(
      (result.body.data.results as { id: string; ok: boolean; code: string | null }[]).map(
        (row) => [row.id, row],
      ),
    );
    expect(byId.get(ready.id)).toMatchObject({ ok: true });
    expect(byId.get(bare.id)).toMatchObject({ ok: false, code: 'PRODUCT_NOT_PUBLISHABLE' });
    expect(byId.get(`missing${tag}`)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: bare.id } })).status).toBe(
      'DRAFT',
    );
  });

  it('sets merchandising in bulk and refuses to remove a primary category', async () => {
    const shelf = await category('bulk-merch');
    const extra = await category('bulk-extra');
    const item = await product('bulk-merch-item', shelf.id);

    const merch = await as(merchandiser)
      .post('/admin/catalog/bulk')
      .send({
        action: 'SET_MERCHANDISING',
        ids: [item.id],
        merchandising: { isFeatured: true, badgeText: 'Workshop pick' },
      });
    expect(merch.status, JSON.stringify(merch.body)).toBe(200);
    expect(merch.body.data.succeeded).toBe(1);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: item.id } });
    expect(row).toMatchObject({ isFeatured: true, badgeText: 'Workshop pick' });

    const add = await as(merchandiser)
      .post('/admin/catalog/bulk')
      .send({ action: 'ADD_CATEGORY', ids: [item.id], categoryId: extra.id });
    expect(add.body.data.succeeded).toBe(1);

    const removePrimary = await as(merchandiser)
      .post('/admin/catalog/bulk')
      .send({ action: 'REMOVE_CATEGORY', ids: [item.id], categoryId: shelf.id });
    expect(removePrimary.body.data.results[0]).toMatchObject({
      ok: false,
      code: 'CATEGORY_IS_PRIMARY',
    });
    expect(
      await prisma.productCategory.count({ where: { productId: item.id } }),
    ).toBeGreaterThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------- import */

describe('CSV import applies the admin API rules', () => {
  const run = (entity: 'PRODUCT' | 'CATEGORY' | 'PRICE_ADJUSTMENT', lines: string[]) =>
    importService.createJob(
      entity,
      { buffer: Buffer.from(lines.join('\n')), originalName: `${entity}.csv` },
      false,
      null,
    );

  it('leaves the columns a file does not carry alone', async () => {
    const item = await product('import-partial', (await category('import')).id, {
      basePricePaise: 23_456_00,
      visibility: 'CATALOG_ONLY',
    });

    const job = await run('PRODUCT', ['sku,name', `${item.sku},Renamed by CSV ${tag}`]);
    expect(job.status, JSON.stringify(job.errors)).toBe('COMPLETED');

    const row = await prisma.product.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.name).toBe(`Renamed by CSV ${tag}`);
    expect(row.basePricePaise).toBe(23_456_00);
    expect(row.visibility).toBe('CATALOG_ONLY');
  });

  it('refuses invalid enums, category cycles and price rules without a type', async () => {
    const parent = await category('import-parent');
    const child = await category('import-child', parent);

    const product = await run('PRODUCT', [
      'sku,name,visibility',
      `CM-IMP-${tag},Bad visibility,EVERYWHERE`,
    ]);
    expect(product.errors[0]).toMatchObject({ column: 'visibility' });

    const cycle = await run('CATEGORY', [
      'slug,name,parentSlug',
      `${parent.slug},Loop,${child.slug}`,
    ]);
    expect(cycle.errors[0]).toMatchObject({ column: 'parentSlug' });
    expect((await prisma.category.findUniqueOrThrow({ where: { id: parent.id } })).parentId).toBe(
      null,
    );

    const rule = await run('PRICE_ADJUSTMENT', [
      'name,scope,valueBp,categorySlug',
      `CM rule ${tag},CATEGORY,-500,${parent.slug}`,
    ]);
    expect(rule.errors[0]).toMatchObject({ column: 'adjustmentType' });
    expect(await prisma.priceAdjustment.count({ where: { name: `CM rule ${tag}` } })).toBe(0);
  });
});

/* ------------------------------------------------------------ gallery usage */

describe('gallery usage follows its owner', () => {
  it('moves the usage row when a gallery item moves between product and variant', async () => {
    const item = await product('gallery', (await category('gallery')).id);
    const attach = await as(catalogManager)
      .post(`/admin/products/${item.id}/media`)
      .send({ items: [{ mediaId: readyMediaId, role: 'GALLERY' }] });
    expect(attach.status, JSON.stringify(attach.body)).toBe(201);
    const galleryId = attach.body.data[0].id as string;

    const usage = (usageType: string, entityId: string) =>
      prisma.mediaUsage.count({ where: { mediaId: readyMediaId, usageType, entityId } });
    expect(await usage('PRODUCT', item.id)).toBe(1);

    const moved = await as(catalogManager)
      .patch(`/admin/products/${item.id}/media/${galleryId}`)
      .send({ variantId: item.variantId });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    expect(await usage('PRODUCT', item.id)).toBe(0);
    expect(await usage('PRODUCT_VARIANT', item.variantId)).toBe(1);
  });
});

/* ------------------------------------------------------- contract work leads */

describe('contract work: the enquiry foundation', () => {
  const submit = (body: Record<string, unknown>) =>
    request(app).post(`${API}/enquiries`).send(body);

  it('accepts a request for a form some live surface offers, and nothing else', async () => {
    const ok = await submit({
      formKey: 'contract-work',
      categorySlug: 'custom-hotel-furniture',
      name: 'Asha Rao',
      email: `asha.${tag}@example.com`,
      quantity: 40,
      budgetPaise: 250_000_000,
      details: { rooms: 40 },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(Object.keys(ok.body.data).sort()).toEqual(['receivedAt', 'reference']);

    const stored = await prisma.enquiry.findUniqueOrThrow({
      where: { id: ok.body.data.reference },
    });
    expect(stored).toMatchObject({ formKey: 'contract-work', status: 'NEW', quantity: 40 });
    expect(stored.categoryId).toBe(
      (await prisma.category.findUniqueOrThrow({ where: { slug: 'custom-hotel-furniture' } })).id,
    );

    expect(
      (await submit({ formKey: `nobody-${tag}`, name: 'X Y', email: 'x@example.com' })).status,
    ).toBe(422);
    expect((await submit({ formKey: 'contract-work', name: 'No Contact' })).status).toBe(422);

    // A filled honeypot is stored for review, never queued.
    const bot = await submit({
      formKey: 'bulk-order',
      name: 'Robot',
      phone: '9845000000',
      website: 'http://spam.example',
    });
    expect(bot.status).toBe(201);
    expect(
      (await prisma.enquiry.findUniqueOrThrow({ where: { id: bot.body.data.reference } })).status,
    ).toBe('SPAM');
  });

  it('stops offering the contract form while its categories are hidden', async () => {
    const roots = await prisma.category.findMany({
      where: { leadFormKey: 'contract-work', parentId: null },
      select: { id: true },
    });
    await prisma.category.updateMany({
      where: { id: { in: roots.map((row) => row.id) } },
      data: { isActive: false },
    });
    try {
      const refused = await submit({
        formKey: 'contract-work',
        name: 'Late Asker',
        email: 'late@example.com',
      });
      expect(refused.status).toBe(422);
    } finally {
      await prisma.category.updateMany({
        where: { id: { in: roots.map((row) => row.id) } },
        data: { isActive: true },
      });
    }
  });

  it('is worked by permission, with optimistic locking and no personal data in the audit', async () => {
    const sent = await submit({
      formKey: 'contract-work',
      name: 'Queue Tester',
      email: `queue.${tag}@example.com`,
      phone: '+91 98450 11111',
    });
    const id = sent.body.data.reference as string;

    expect((await as(catalogManager).get('/admin/enquiries')).status).toBe(403);
    const read = await as(orderManager).get(`/admin/enquiries/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.data.email).toBe(`queue.${tag}@example.com`);
    expect(
      (
        await as(orderManager)
          .patch(`/admin/enquiries/${id}`)
          .send({ status: 'CONTACTED', version: 0 })
      ).status,
    ).toBe(403);

    const queue = await as(enquiryWorker).get('/admin/enquiries?status=NEW&formKey=contract-work');
    expect(queue.status).toBe(200);
    expect(queue.body.data.some((row: { id: string }) => row.id === id)).toBe(true);

    const moved = await as(enquiryWorker)
      .patch(`/admin/enquiries/${id}`)
      .send({ status: 'CONTACTED', adminNote: 'Called back', version: 0 });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.data).toMatchObject({ status: 'CONTACTED', version: 1 });

    const stale = await as(enquiryWorker)
      .patch(`/admin/enquiries/${id}`)
      .send({ status: 'QUOTED', version: 0 });
    expect(stale.status).toBe(409);

    // Moving the owner needs lead.enquiry.assign, which this role lacks.
    const assign = { assignedToId: enquiryWorker.id, version: 1 };
    expect((await as(enquiryWorker).patch(`/admin/enquiries/${id}`).send(assign)).status).toBe(403);
    const assigned = await as(contentManager).patch(`/admin/enquiries/${id}`).send(assign);
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body.data.assignedToId).toBe(enquiryWorker.id);

    const audit = await eventually(
      () => prisma.auditLog.findMany({ where: { entity: 'Enquiry', entityId: id } }),
      (rows) => rows.length >= 2,
    );
    const trail = JSON.stringify(audit);
    expect(trail).toContain('CONTACTED');
    expect(trail).not.toContain(`queue.${tag}@example.com`);
    expect(trail).not.toContain('98450');
  });
});

/* ------------------------------------------- the whole flow, admin -> customer */

describe('admin -> customer, end to end (Phase 37)', () => {
  it('builds a product through the API and the storefront serves it correctly', async () => {
    const api = as(catalogManager);

    // ADMIN: category, subcategory
    const rootRes = await api.post('/admin/catalog/categories').send({ name: `CM Studio ${tag}` });
    expect(rootRes.status, JSON.stringify(rootRes.body)).toBe(201);
    const root = rootRes.body.data as { id: string; slug: string };
    const subRes = await api
      .post('/admin/catalog/categories')
      .send({ name: `CM Studio Desks ${tag}`, parentId: root.id });
    expect(subRes.status).toBe(201);
    const sub = subRes.body.data as { id: string; slug: string };

    // attribute + values, mapped to the root so the whole subtree inherits it
    const attrRes = await api.post('/admin/catalog/attributes').send({
      code: `CM_FINISH_${TAG}`,
      name: `Finish ${tag}`,
      inputType: 'SWATCH_COLOR',
      isVariantDefining: true,
      isFilterable: true,
      showInSwatch: true,
    });
    expect(attrRes.status, JSON.stringify(attrRes.body)).toBe(201);
    const attributeId = attrRes.body.data.id as string;
    const valueIds: Record<string, string> = {};
    for (const [code, label, colorHex, description] of [
      ['TEAK', 'Teak', '#B5743F', 'Warm golden grain, oiled by hand'],
      ['WALNUT', 'Walnut', '#6B4A33', 'Deep brown, satin lacquer'],
      ['ASH', 'Ash', '#D9CBB3', 'Pale and open-grained'],
    ] as const) {
      const created = await api
        .post(`/admin/catalog/attributes/${attributeId}/values`)
        .send({ code, label, colorHex, description });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const values = (created.body.data.values ?? []) as { id: string; code: string }[];
      valueIds[code] =
        values.find((row) => row.code === code)?.id ?? (created.body.data.id as string);
    }
    const link = await api
      .post(`/admin/catalog/categories/${root.id}/attributes`)
      .send({ attributeId, isVariantDefining: true, isFilterable: true });
    expect(link.status, JSON.stringify(link.body)).toBeLessThan(300);

    // a plain, non-variant-defining attribute for the invalid-combination check
    const plain = await api.post('/admin/catalog/attributes').send({
      code: `CM_NOTE_${TAG}`,
      name: `Note ${tag}`,
      inputType: 'SELECT',
    });
    const plainValue = await api
      .post(`/admin/catalog/attributes/${plain.body.data.id}/values`)
      .send({ code: 'PLAIN', label: 'Plain' });
    const plainValueId =
      ((plainValue.body.data.values ?? []) as { id: string; code: string }[]).find(
        (row) => row.code === 'PLAIN',
      )?.id ?? (plainValue.body.data.id as string);

    // products: one with variants, one simple and cheaper (for sorting and pagination)
    const token = `deskline${tag}`;
    const createProduct = async (sku: string, name: string, extra: Record<string, unknown>) => {
      const created = await api.post('/admin/catalog/products').send({
        sku,
        name,
        taxClassId: defaultTaxClassId,
        description: `${name} - built one at a time in our own workshop. `.repeat(4),
        searchKeywords: token,
        ...extra,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.data.id as string;

      const categories = await api
        .put(`/admin/catalog/products/${id}/categories`)
        .send({ primaryCategoryId: sub.id, categoryIds: [sub.id] });
      expect(categories.status, JSON.stringify(categories.body)).toBe(200);

      const media = await api
        .post(`/admin/products/${id}/media`)
        .send({ items: [{ mediaId: readyMediaId, role: 'PRIMARY' }] });
      expect(media.status, JSON.stringify(media.body)).toBe(201);
      return { id, slug: created.body.data.slug as string };
    };

    const desk = await createProduct(`CM-DESK-${tag}`, `Studio Desk ${tag}`, {
      productType: 'VARIABLE',
      basePricePaise: 40_000_00,
    });
    const stool = await createProduct(`CM-STOOL-${tag}`, `Studio Stool ${tag}`, {
      basePricePaise: 30_000_00,
    });

    // variants: valid combinations with their own prices and stock
    const variant = (sku: string, value: string, pricePaise: number, extra = {}) =>
      api.post(`/admin/catalog/products/${desk.id}/variants`).send({
        sku,
        pricePaise,
        openingStock: 4,
        attributeValues: [{ attributeId, attributeValueId: value }],
        ...extra,
      });
    const teak = await variant(`CM-DESK-${tag}-T`, valueIds.TEAK!, 45_000_00, { isDefault: true });
    expect(teak.status, JSON.stringify(teak.body)).toBe(201);
    const walnut = await variant(`CM-DESK-${tag}-W`, valueIds.WALNUT!, 52_000_00);
    expect(walnut.status, JSON.stringify(walnut.body)).toBe(201);

    // invalid combinations are refused
    const duplicate = await variant(`CM-DESK-${tag}-T2`, valueIds.TEAK!, 45_000_00);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('VARIANT_COMBINATION_EXISTS');
    const notDefining = await api.post(`/admin/catalog/products/${desk.id}/variants`).send({
      sku: `CM-DESK-${tag}-P`,
      attributeValues: [{ attributeId: plain.body.data.id, attributeValueId: plainValueId }],
    });
    expect(notDefining.status).toBe(422);
    expect(notDefining.body.error.code).toBe('ATTRIBUTE_NOT_VARIANT_DEFINING');

    // warm the storefront before publishing: the publish must invalidate what was cached
    expect((await listing({ categorySlug: sub.slug })).items).toHaveLength(0);

    for (const id of [desk.id, stool.id]) {
      const published = await api.post(`/admin/catalog/products/${id}/publish`);
      expect(published.status, JSON.stringify(published.body)).toBe(200);
    }
    await catalogEvents.settled();

    // listing index, search and caches follow the admin writes
    const indexRow = await eventually(
      () => prisma.productListingIndex.findUnique({ where: { productId: desk.id } }),
      (row) => row?.minPricePaise === 45_000_00,
    );
    expect(indexRow).toMatchObject({ minPricePaise: 45_000_00, maxPricePaise: 52_000_00 });

    const searched = await eventually(
      () => request(app).get(`${API}/search`).query({ q: token, includeFacets: false }),
      (response) => (response.body.data?.products?.items?.length ?? 0) >= 2,
    );
    expect(
      (searched.body.data.products.items as { slug: string }[]).map((item) => item.slug).sort(),
    ).toEqual([desk.slug, stool.slug].sort());

    // CUSTOMER: category tree and landing
    const tree = JSON.stringify(
      (await request(app).get(`${API}/catalog/categories/tree`)).body.data,
    );
    expect(tree).toContain(`"${root.slug}"`);
    expect(tree).toContain(`"${sub.slug}"`);
    const landing = await request(app).get(`${API}/catalog/categories/${sub.slug}/landing`);
    expect(landing.status, JSON.stringify(landing.body)).toBe(200);
    expect(landing.body.data.category.slug).toBe(sub.slug);

    // filters come from the attribute an admin configured, not from code
    const filters = await request(app)
      .get(`${API}/catalog/filters`)
      .query({ categorySlug: sub.slug });
    expect(filters.status).toBe(200);
    const finishFacet = (filters.body.data as Listing['facets']).find(
      (facet) => facet.key === `CM_FINISH_${TAG}`,
    );
    expect(finishFacet?.values.map((entry) => entry.value).sort()).toEqual(
      expect.arrayContaining([valueIds.TEAK, valueIds.WALNUT].sort()),
    );
    expect(
      slugsOf(await listing({ categorySlug: sub.slug, attributeValueIds: valueIds.WALNUT! })),
    ).toEqual([desk.slug]);
    expect(
      (await listing({ categorySlug: sub.slug, attributeValueIds: valueIds.ASH! })).items,
    ).toHaveLength(0);

    // sorting and pagination happen in MySQL
    const ascending = await listing({ categorySlug: sub.slug, sort: 'PRICE_ASC' });
    expect(ascending.items.map((item) => item.slug)).toEqual([stool.slug, desk.slug]);
    const descending = await listing({ categorySlug: sub.slug, sort: 'PRICE_DESC' });
    expect(descending.items.map((item) => item.slug)).toEqual([desk.slug, stool.slug]);
    const second = await listing({ categorySlug: sub.slug, sort: 'PRICE_ASC', limit: 1, page: 2 });
    expect(second.items.map((item) => item.slug)).toEqual([desk.slug]);
    expect(second.totalCount).toBe(2);

    // the product card
    const card = ascending.items.find((item) => item.slug === desk.slug)!;
    expect(card).toMatchObject({
      pricePaise: 45_000_00,
      indexedMinPricePaise: 45_000_00,
      indexedMaxPricePaise: 52_000_00,
    });
    expect(card.swatches).toHaveLength(2);
    expect(Array.isArray(card.badges)).toBe(true);

    // product detail: options with descriptions, valid combinations, server price, availability
    const pdp = await request(app).get(`${API}/catalog/products/${desk.slug}`);
    expect(pdp.status, JSON.stringify(pdp.body)).toBe(200);
    const detail = pdp.body.data as {
      inStock: boolean;
      price: { lines: { unitPricePaise: number }[] };
      options: {
        attributes: {
          attributeId: string;
          values: { valueId: string; description: string | null }[];
        }[];
        combinations: { variantId: string; valueIds: string[] }[];
      };
    };
    expect(detail.inStock).toBe(true);
    expect(detail.price.lines[0]!.unitPricePaise).toBe(45_000_00);
    const finishOptions = detail.options.attributes.find((row) => row.attributeId === attributeId)!;
    expect(finishOptions.values.find((row) => row.valueId === valueIds.TEAK)?.description).toBe(
      'Warm golden grain, oiled by hand',
    );
    expect(detail.options.combinations).toHaveLength(2);

    const walnutId = walnut.body.data.id as string;
    const options = await request(app)
      .get(`${API}/catalog/products/${desk.slug}/options`)
      .query({ optionValueIds: valueIds.WALNUT });
    expect(options.status).toBe(200);
    expect(options.body.data.resolvedVariantId).toBe(walnutId);

    // the price the customer pays is the server's, for the variant they chose
    const quote = await request(app)
      .post(`${API}/pricing/quote`)
      .send({ items: [{ productId: desk.id, variantId: walnutId, qty: 1 }] });
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    expect(quote.body.data.lines[0].unitPricePaise).toBe(52_000_00);
  });
});
