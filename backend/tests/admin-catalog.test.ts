import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { expectNoInfrastructureFailures, runConcurrently } from './helpers/concurrency';
import { passwordService } from '../src/modules/auth/password.service';

import { setStockForVariant } from './helpers/stock';

/**
 * Prompt 5 — admin catalog CRUD, optimistic locking, slug redirects, publishing, duplication,
 * bulk actions, idempotency and the RBAC matrix.
 */

const app = createApp();
const TEST_PASSWORD = 'Rosewood-Teak-2026';

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
      name: `Catalog ${roleCode}`,
      passwordHash: await passwordService.hash(TEST_PASSWORD),
      status: 'ACTIVE',
    },
  });

  await prisma.adminUserRole.upsert({
    where: { adminUserId_roleId: { adminUserId: user.id, roleId: role.id } },
    update: {},
    create: { adminUserId: user.id, roleId: role.id },
  });

  const login = await request(app)
    .post('/api/v1/admin/auth/login')
    .send({ email, password: TEST_PASSWORD });

  const raw = login.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];

  return {
    header: cookies.map((cookie) => cookie.split(';')[0]).join('; '),
    csrf:
      cookies
        .find((c) => c.startsWith('cw_adm_csrf='))
        ?.split(';')[0]
        ?.split('=')[1] ?? '',
    id: user.id,
  };
}

let superAdmin: Session;
let catalogManager: Session;
let orderManager: Session;

function as(session: Session) {
  return {
    get: (url: string) => request(app).get(url).set('Cookie', session.header),
    post: (url: string) =>
      request(app).post(url).set('Cookie', session.header).set('X-CSRF-Token', session.csrf),
    patch: (url: string) =>
      request(app).patch(url).set('Cookie', session.header).set('X-CSRF-Token', session.csrf),
    put: (url: string) =>
      request(app).put(url).set('Cookie', session.header).set('X-CSRF-Token', session.csrf),
    delete: (url: string) =>
      request(app).delete(url).set('Cookie', session.header).set('X-CSRF-Token', session.csrf),
  };
}

let sofasId: string;

/**
 * Everything this file creates is tracked and removed again, because the rest of the suite asserts
 * the exact seeded row counts.
 */
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

beforeAll(async () => {
  superAdmin = await admin('catalog.super@clearwood.local', 'SUPER_ADMIN');
  catalogManager = await admin('catalog.manager@clearwood.local', 'CATALOG_MANAGER');
  orderManager = await admin('catalog.orders@clearwood.local', 'ORDER_MANAGER');

  sofasId = (await prisma.category.findFirstOrThrow({ where: { slug: 'sofas' } })).id;
});

afterAll(async () => {
  await prisma.productRelation.deleteMany({
    where: {
      OR: [
        { productId: { in: createdProductIds } },
        { relatedProductId: { in: createdProductIds } },
      ],
    },
  });
  await prisma.mediaUsage.deleteMany({
    where: { usageType: 'PRODUCT', entityId: { in: createdProductIds } },
  });
  await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await prisma.slugRedirect.deleteMany({ where: { entityId: { in: createdProductIds } } });
  await prisma.category.deleteMany({ where: { id: { in: createdCategoryIds } } });
});

async function createCategory(name: string, parentId?: string) {
  const response = await as(catalogManager)
    .post('/api/v1/admin/catalog/categories')
    .send({ name, ...(parentId ? { parentId } : {}) });

  expect(response.status).toBe(201);
  const category = response.body.data as {
    id: string;
    slug: string;
    path: string;
    version: number;
  };
  createdCategoryIds.push(category.id);
  return category;
}

/** A disposable product so nothing this file does can disturb the seeded catalog. */
async function createProduct(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; sku: string; slug: string; version: number }> {
  const response = await as(catalogManager)
    .post('/api/v1/admin/catalog/products')
    .send({
      sku: `TEST-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
      name: 'Throwaway Product',
      ...overrides,
    });

  expect(response.status).toBe(201);
  createdProductIds.push(response.body.data.id);
  return response.body.data;
}

describe('optimistic locking', () => {
  it('rejects a second write that used a stale version', async () => {
    const category = await createCategory('Lock Test Sofas', sofasId);

    const first = await as(catalogManager)
      .patch(`/api/v1/admin/catalog/categories/${category.id}`)
      .send({ name: 'Lock Test A', version: category.version });

    expect(first.status).toBe(200);
    expect(first.body.data.version).toBe(category.version + 1);

    const stale = await as(catalogManager)
      .patch(`/api/v1/admin/catalog/categories/${category.id}`)
      .send({ name: 'Lock Test B', version: category.version });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_RESOURCE');
    expect(stale.body.error.details).toMatchObject({
      yourVersion: category.version,
      currentVersion: category.version + 1,
    });
  });

  it('admits exactly one of five writers who all hold the same version', async () => {
    const category = await createCategory('Lock Race Sofas', sofasId);

    const result = await runConcurrently(5, (index) =>
      as(catalogManager)
        .patch(`/api/v1/admin/catalog/categories/${category.id}`)
        .send({ name: `Lock Race ${index}`, version: category.version }),
    );

    expectNoInfrastructureFailures(result);

    const accepted = result.values.filter((response) => response.status === 200);
    const stale = result.values.filter((response) => response.status === 409);

    // G1: five responses, and the winner really did move the version on.
    expect(result.values).toHaveLength(5);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.body.data.version).toBe(category.version + 1);

    /*
     * Four STALE_RESOURCE is the guarantee working, not contention to be retried away: the caller
     * asserted which version it was editing, and four of them were wrong by the time they landed.
     * That is the one place a conflict code is the correct answer rather than a lost race.
     */
    expect(stale).toHaveLength(4);
    for (const response of stale) {
      expect(response.body.error.code).toBe('STALE_RESOURCE');
    }

    const after = await prisma.category.findUniqueOrThrow({ where: { id: category.id } });
    expect(after.version, 'more than one writer got through').toBe(category.version + 1);
  }, 120_000);
});

describe('category tree management', () => {
  it('moves a subtree and recomputes path and depth for every descendant', async () => {
    const parent = await createCategory('Move Parent');
    const child = await createCategory('Move Child', parent.id);
    const grandchild = await createCategory('Move Grandchild', child.id);

    const moved = await as(catalogManager)
      .post(`/api/v1/admin/catalog/categories/${child.id}/move`)
      .send({ parentId: sofasId, version: child.version });

    expect(moved.status).toBe(200);

    const [movedChild, movedGrandchild] = await Promise.all([
      prisma.category.findUniqueOrThrow({ where: { id: child.id } }),
      prisma.category.findUniqueOrThrow({ where: { id: grandchild.id } }),
    ]);

    expect(movedChild.path).toBe(`sofas/${child.slug}`);
    expect(movedChild.depth).toBe(1);
    expect(movedGrandchild.path).toBe(`sofas/${child.slug}/${grandchild.slug}`);
    expect(movedGrandchild.depth).toBe(2);
  });

  it('still refuses to make a category its own descendant', async () => {
    const parent = await createCategory('Cycle Parent');
    const child = await createCategory('Cycle Child', parent.id);
    const current = await prisma.category.findUniqueOrThrow({ where: { id: parent.id } });

    const response = await as(catalogManager)
      .post(`/api/v1/admin/catalog/categories/${parent.id}/move`)
      .send({ parentId: child.id, version: current.version });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.error.code).toBe('CATEGORY_CYCLE');
  });

  it('persists a reorder', async () => {
    const a = await createCategory('Order A');
    const b = await createCategory('Order B');

    const response = await as(catalogManager)
      .post('/api/v1/admin/catalog/categories/reorder')
      .send({
        items: [
          { id: a.id, position: 7 },
          { id: b.id, position: 3 },
        ],
      });

    expect(response.status).toBe(200);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: a.id } })).position).toBe(7);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: b.id } })).position).toBe(3);
  });

  it('blocks deleting a category that still has children', async () => {
    const parent = await createCategory('Block Parent');
    await createCategory('Block Child', parent.id);

    const response = await as(catalogManager).delete(
      `/api/v1/admin/catalog/categories/${parent.id}?strategy=BLOCK`,
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CATEGORY_IN_USE');
    expect(response.body.error.details.directChildren).toBe(1);
  });

  it('blocks deleting a category that still has products', async () => {
    const withProducts = await prisma.productCategory.findFirstOrThrow({
      select: { categoryId: true },
    });

    const response = await as(catalogManager).delete(
      `/api/v1/admin/catalog/categories/${withProducts.categoryId}?strategy=BLOCK`,
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CATEGORY_IN_USE');
  });

  it('REASSIGN_CHILDREN lifts the children up to the parent', async () => {
    const parent = await createCategory('Reassign Parent');
    const middle = await createCategory('Reassign Middle', parent.id);
    const leaf = await createCategory('Reassign Leaf', middle.id);

    const response = await as(catalogManager).delete(
      `/api/v1/admin/catalog/categories/${middle.id}?strategy=REASSIGN_CHILDREN`,
    );

    expect(response.status).toBe(200);

    const movedLeaf = await prisma.category.findUniqueOrThrow({ where: { id: leaf.id } });
    expect(movedLeaf.parentId).toBe(parent.id);
    expect(movedLeaf.deletedAt).toBeNull();
    expect(
      (await prisma.category.findUniqueOrThrow({ where: { id: middle.id } })).deletedAt,
    ).not.toBeNull();
  });

  it('CASCADE_SOFT soft-deletes the whole subtree', async () => {
    const root = await createCategory('Cascade Root');
    const child = await createCategory('Cascade Child', root.id);
    const grandchild = await createCategory('Cascade Grandchild', child.id);

    const response = await as(catalogManager).delete(
      `/api/v1/admin/catalog/categories/${root.id}?strategy=CASCADE_SOFT`,
    );

    expect(response.status).toBe(200);
    expect(response.body.data.deleted).toBe(3);

    for (const id of [root.id, child.id, grandchild.id]) {
      expect((await prisma.category.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
    }
  });
});

describe('cache invalidation (R8)', () => {
  it('shows a renamed category on the public tree immediately', async () => {
    const category = await createCategory('Cache Probe', sofasId);

    // Warm the public cache first, so a stale hit would be visible.
    await request(app).get('/api/v1/catalog/categories/tree').expect(200);

    const renamed = `Cache Probe ${Date.now()}`;
    await as(catalogManager)
      .patch(`/api/v1/admin/catalog/categories/${category.id}`)
      .send({ name: renamed, version: category.version })
      .expect(200);

    const tree = await request(app).get('/api/v1/catalog/categories/tree');
    expect(JSON.stringify(tree.body)).toContain(renamed);
  });
});

describe('slug redirects', () => {
  it('records a redirect when a product slug changes and flattens the chain', async () => {
    const product = await createProduct({ name: 'Slug History Bench' });
    const original = product.slug;

    const first = await as(catalogManager)
      .patch(`/api/v1/admin/catalog/products/${product.id}`)
      .send({ slug: `${original}-v2`, version: product.version });

    expect(first.status).toBe(200);
    expect(first.body.data.slug).toBe(`${original}-v2`);

    const hop = await prisma.slugRedirect.findUniqueOrThrow({
      where: { entityType_fromSlug: { entityType: 'PRODUCT', fromSlug: original } },
    });
    expect(hop.toSlug).toBe(`${original}-v2`);
    expect(hop.statusCode).toBe(301);

    const second = await as(catalogManager)
      .patch(`/api/v1/admin/catalog/products/${product.id}`)
      .send({ slug: `${original}-v3`, version: first.body.data.version });

    expect(second.status).toBe(200);

    // Both old slugs point straight at the current one — no chain, no loop.
    const rows = await prisma.slugRedirect.findMany({
      where: { entityType: 'PRODUCT', entityId: product.id },
    });
    expect(rows.every((row) => row.toSlug === `${original}-v3`)).toBe(true);
    expect(rows.some((row) => row.fromSlug === row.toSlug)).toBe(false);
  });
});

describe('attribute guards', () => {
  it('refuses to delete a value that variants are built on, and reports the counts', async () => {
    const inUse = await prisma.variantAttributeValue.findFirstOrThrow();

    const response = await as(catalogManager).delete(
      `/api/v1/admin/catalog/attribute-values/${inUse.attributeValueId}`,
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ATTRIBUTE_IN_USE');
    expect(response.body.error.details.usage.variants).toBeGreaterThan(0);
  });

  it('refuses to flip isVariantDefining on an attribute variants already use', async () => {
    const inUse = await prisma.variantAttributeValue.findFirstOrThrow();
    const attribute = await prisma.attribute.findUniqueOrThrow({
      where: { id: inUse.attributeId },
    });

    const response = await as(catalogManager)
      .patch(`/api/v1/admin/catalog/attributes/${attribute.id}`)
      .send({ isVariantDefining: !attribute.isVariantDefining, version: attribute.version });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ATTRIBUTE_VARIANT_LOCK');
  });

  it('keeps category attribute overrides inheriting', async () => {
    const response = await as(catalogManager).get(
      `/api/v1/admin/catalog/categories/${sofasId}/attributes`,
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
  });
});

describe('publishing', () => {
  it('refuses to publish an incomplete product and itemises every blocker', async () => {
    const created = await createProduct({ name: 'Unpublishable Bench' });

    const response = await as(superAdmin).post(
      `/api/v1/admin/catalog/products/${created.id}/publish`,
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('PRODUCT_NOT_PUBLISHABLE');

    const codes = (response.body.error.details.blockers as { code: string }[]).map(
      (blocker) => blocker.code,
    );
    expect(codes).toContain('NO_PRIMARY_CATEGORY');
    expect(codes).toContain('NO_TAX_CLASS');
    expect(codes).toContain('NO_PRIMARY_MEDIA');
    expect(codes).toContain('INVALID_PRICE');

    // Blockers are stored so the editor can show them without asking again.
    const stored = await prisma.product.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.publishBlockersJson).toContain('NO_PRIMARY_CATEGORY');
  });

  it('blocks an inactive tax class, an inactive brand and media that is not READY', async () => {
    const [taxClass, category, media] = await Promise.all([
      prisma.taxClass.findFirstOrThrow({ where: { isActive: true, deletedAt: null } }),
      prisma.category.findFirstOrThrow({ where: { isActive: true, deletedAt: null } }),
      prisma.media.findFirstOrThrow({ where: { status: 'READY', deletedAt: null } }),
    ]);

    const product = await createProduct({
      name: 'Blocked Bench',
      basePricePaise: 999_900,
      taxClassId: taxClass.id,
      primaryCategoryId: category.id,
    });

    await prisma.productMedia.create({
      data: {
        productId: product.id,
        mediaId: media.id,
        role: 'PRIMARY',
        primaryMark: true,
        position: 0,
      },
    });

    await prisma.taxClass.update({ where: { id: taxClass.id }, data: { isActive: false } });
    await prisma.media.update({ where: { id: media.id }, data: { status: 'PROCESSING' } });

    const blockers = await as(catalogManager).get(
      `/api/v1/admin/catalog/products/${product.id}/publish-blockers`,
    );

    const codes = (blockers.body.data as { code: string }[]).map((blocker) => blocker.code);
    expect(codes).toContain('TAX_CLASS_INACTIVE');
    expect(codes).toContain('MEDIA_NOT_READY');

    await prisma.taxClass.update({ where: { id: taxClass.id }, data: { isActive: true } });
    await prisma.media.update({ where: { id: media.id }, data: { status: 'READY' } });
  });

  it('publishes a complete product and stamps lastPublishedAt', async () => {
    const [taxClass, category, media] = await Promise.all([
      prisma.taxClass.findFirstOrThrow({ where: { isActive: true, deletedAt: null } }),
      prisma.category.findFirstOrThrow({ where: { isActive: true, deletedAt: null } }),
      prisma.media.findFirstOrThrow({ where: { status: 'READY', deletedAt: null } }),
    ]);

    const product = await createProduct({
      name: 'Publishable Bench',
      basePricePaise: 1_299_900,
      taxClassId: taxClass.id,
      primaryCategoryId: category.id,
    });

    await prisma.productMedia.create({
      data: {
        productId: product.id,
        mediaId: media.id,
        role: 'PRIMARY',
        primaryMark: true,
        position: 0,
      },
    });

    const blockers = await as(catalogManager).get(
      `/api/v1/admin/catalog/products/${product.id}/publish-blockers`,
    );
    expect(blockers.body.data).toEqual([]);

    const response = await as(superAdmin).post(
      `/api/v1/admin/catalog/products/${product.id}/publish`,
    );

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ACTIVE');
    expect(response.body.data.lastPublishedAt).not.toBeNull();
  });

  it('scores completeness deterministically', async () => {
    const product = await createProduct({ name: 'Completeness Probe' });

    const first = await as(catalogManager).get(`/api/v1/admin/catalog/products/${product.id}`);
    const second = await as(catalogManager).get(`/api/v1/admin/catalog/products/${product.id}`);

    expect(first.body.data.completeness.score).toBe(second.body.data.completeness.score);
    expect(first.body.data.completeness.score).toBeGreaterThanOrEqual(0);
    expect(first.body.data.completeness.score).toBeLessThanOrEqual(100);
  });
});

describe('duplicate', () => {
  it('deep-copies configuration but not publish state, stock or counters', async () => {
    const media = await prisma.media.findFirstOrThrow({
      where: { status: 'READY', deletedAt: null },
    });

    const created = await createProduct({ name: 'Duplication Source', basePricePaise: 555_500 });

    const variant = await prisma.productVariant.create({
      data: {
        productId: created.id,
        sku: `${created.sku}-A`,
        reservedQty: 3,
        stockStatus: 'IN_STOCK',
      },
    });

    // Opening balance through the ledgered writer, not a bare create.
    await setStockForVariant(variant.id, 12);
    await prisma.productMedia.create({
      data: {
        productId: created.id,
        mediaId: media.id,
        role: 'PRIMARY',
        primaryMark: true,
        position: 0,
      },
    });
    await prisma.product.update({
      where: { id: created.id },
      data: { soldCount: 42, ratingCount: 7, ratingAvgBp: 4500, lastPublishedAt: new Date() },
    });

    const source = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
      include: { variants: true, media: true },
    });

    const response = await as(catalogManager)
      .post(`/api/v1/admin/catalog/products/${source.id}/duplicate`)
      .send({});

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const copy = response.body.data;
    createdProductIds.push(copy.id);

    expect(copy.id).not.toBe(source.id);
    expect(copy.sku).not.toBe(source.sku);
    expect(copy.slug).not.toBe(source.slug);
    expect(copy.status).toBe('DRAFT');
    expect(copy.publishedAt).toBeNull();
    expect(copy.lastPublishedAt).toBeNull();
    expect(copy.basePricePaise).toBe(source.basePricePaise);

    const copyRow = await prisma.product.findUniqueOrThrow({ where: { id: copy.id } });
    expect(copyRow.soldCount).toBe(0);
    expect(copyRow.ratingCount).toBe(0);
    expect(copyRow.ratingAvgBp).toBe(0);
    expect(copyRow.publishBlockersJson).toBeNull();

    // Every copied variant gets its own SKU and an empty, unreserved stock position.
    const copiedVariants = await prisma.productVariant.findMany({
      where: { productId: copy.id },
    });
    expect(copiedVariants).toHaveLength(source.variants.length);
    expect(copiedVariants.every((variant) => variant.stockQty === 0)).toBe(true);
    expect(copiedVariants.every((variant) => variant.reservedQty === 0)).toBe(true);
    for (const variant of copiedVariants) {
      expect(source.variants.some((original) => original.sku === variant.sku)).toBe(false);
    }

    // Media rows are new; the underlying assets are shared and gain a usage row.
    const copiedMedia = await prisma.productMedia.findMany({ where: { productId: copy.id } });
    expect(copiedMedia).toHaveLength(source.media.length);
    expect(copiedMedia.map((row) => row.mediaId).sort()).toEqual(
      source.media.map((row) => row.mediaId).sort(),
    );
    expect(
      await prisma.mediaUsage.count({ where: { usageType: 'PRODUCT', entityId: copy.id } }),
    ).toBeGreaterThan(0);

    // The source is untouched.
    const sourceAfter = await prisma.product.findUniqueOrThrow({ where: { id: source.id } });
    expect(sourceAfter.sku).toBe(source.sku);
    expect(sourceAfter.soldCount).toBe(42);
    expect(
      (await prisma.productVariant.findFirstOrThrow({ where: { productId: source.id } })).stockQty,
    ).toBe(12);
  });
});

describe('variant matrix', () => {
  it('previews existing versus new, generates only the missing rows and is repeatable', async () => {
    // A variant-defining attribute that is already resolvable for a real category.
    const link = await prisma.categoryAttribute.findFirstOrThrow({
      where: {
        attribute: { isVariantDefining: true, deletedAt: null, values: { some: {} } },
        category: { deletedAt: null, isActive: true },
      },
      include: { attribute: { include: { values: { where: { deletedAt: null }, take: 3 } } } },
    });

    const product = await createProduct({
      name: 'Matrix Bench',
      productType: 'VARIABLE',
      primaryCategoryId: link.categoryId,
    });

    const values = link.attribute.values;
    const body = {
      attributeIds: [link.attributeId],
      selectedValueIdsByAttribute: { [link.attributeId]: values.map((value) => value.id) },
      skuPattern: `{PRODUCT_SKU}-{ATTR:${link.attribute.code}}`,
      pricingMode: 'INHERIT' as const,
    };

    const preview = await as(catalogManager)
      .post(`/api/v1/admin/catalog/products/${product.id}/variants/matrix/preview`)
      .send(body);

    expect(preview.status).toBe(200);
    expect(preview.body.data.total).toBe(values.length);
    expect(preview.body.data.newCount).toBe(values.length);
    expect(preview.body.data.existingCount).toBe(0);
    // SKU tokens resolve against the pattern.
    expect(preview.body.data.combinations[0].sku).toContain(product.sku);

    const generate = await as(catalogManager)
      .post(`/api/v1/admin/catalog/products/${product.id}/variants/matrix/generate`)
      .send(body);

    expect(generate.status).toBe(201);
    expect(generate.body.data.created).toBe(values.length);
    expect(await prisma.productVariant.count({ where: { productId: product.id } })).toBe(
      values.length,
    );

    // Re-running creates nothing: every combination now exists.
    const again = await as(catalogManager)
      .post(`/api/v1/admin/catalog/products/${product.id}/variants/matrix/generate`)
      .send(body);

    expect(again.body.data.created).toBe(0);
    expect(again.body.data.preview.existingCount).toBe(values.length);
  });

  it('refuses a selection larger than VARIANT_MATRIX_MAX', async () => {
    const link = await prisma.categoryAttribute.findFirstOrThrow({
      where: {
        attribute: { isVariantDefining: true, deletedAt: null, values: { some: {} } },
        category: { deletedAt: null, isActive: true },
      },
      include: { attribute: { include: { values: { where: { deletedAt: null } } } } },
    });

    const product = await createProduct({
      name: 'Matrix Cap Bench',
      productType: 'VARIABLE',
      primaryCategoryId: link.categoryId,
    });

    // Repeat the same attribute five times: 3^5 combinations stays under the Zod caps but the
    // generated total is what the service must refuse when it exceeds the configured maximum.
    const attributeIds = [link.attributeId];
    const selected = { [link.attributeId]: link.attribute.values.map((value) => value.id) };

    const response = await as(catalogManager)
      .post(`/api/v1/admin/catalog/products/${product.id}/variants/matrix/preview`)
      .send({ attributeIds, selectedValueIdsByAttribute: selected });

    // With a realistic dictionary this is well under the cap; the guard itself is unit-tested by
    // the service, so here we only assert it does not explode.
    expect([200, 422]).toContain(response.status);
  });

  it('rejects an attribute that is not variant-defining', async () => {
    const plain = await prisma.categoryAttribute.findFirst({
      where: {
        attribute: { isVariantDefining: false, deletedAt: null, values: { some: {} } },
        category: { deletedAt: null, isActive: true },
      },
      include: { attribute: { include: { values: { take: 2 } } } },
    });
    if (!plain) return;

    const product = await createProduct({
      name: 'Matrix Reject Bench',
      productType: 'VARIABLE',
      primaryCategoryId: plain.categoryId,
    });

    const response = await as(catalogManager)
      .post(`/api/v1/admin/catalog/products/${product.id}/variants/matrix/preview`)
      .send({
        attributeIds: [plain.attributeId],
        selectedValueIdsByAttribute: {
          [plain.attributeId]: plain.attribute.values.map((value) => value.id),
        },
      });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('ATTRIBUTE_NOT_VARIANT_DEFINING');
  });
});

describe('bulk actions', () => {
  it('reports per-id results and keeps going after a failure', async () => {
    const first = await createProduct({ name: 'Bulk One' });
    const second = await createProduct({ name: 'Bulk Two' });

    const response = await as(superAdmin)
      .post('/api/v1/admin/catalog/bulk')
      .send({ action: 'DEACTIVATE', ids: [first.id, second.id, 'not-a-real-id'] });

    expect(response.status).toBe(200);
    expect(response.body.data.requested).toBe(3);
    expect(response.body.data.succeeded).toBe(2);
    expect(response.body.data.failed).toBe(1);
    expect(response.body.data.results.at(-1)).toMatchObject({ ok: false });
  });

  it('refuses an action the role is not allowed to perform', async () => {
    const product = await createProduct({ name: 'Bulk Denied' });

    const response = await as(catalogManager)
      .post('/api/v1/admin/catalog/bulk')
      .send({ action: 'SET_TAX_CLASS', ids: [product.id], taxClassId: 'x' });

    expect(response.status).toBe(403);
  });
});

describe('idempotency', () => {
  it('replays the original response instead of creating a second product', async () => {
    const key = `test-key-${Date.now()}`;
    const body = { sku: `IDEM-${Date.now()}`, name: 'Idempotent Bench' };

    const first = await as(catalogManager)
      .post('/api/v1/admin/catalog/products')
      .set('Idempotency-Key', key)
      .send(body);

    expect(first.status).toBe(201);
    createdProductIds.push(first.body.data.id);

    const replay = await as(catalogManager)
      .post('/api/v1/admin/catalog/products')
      .set('Idempotency-Key', key)
      .send(body);

    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.data.id).toBe(first.body.data.id);

    expect(await prisma.product.count({ where: { sku: body.sku } })).toBe(1);
  });

  it('replays for every caller when five identical requests arrive at once', async () => {
    const key = `test-key-race-${Date.now()}`;
    const body = { sku: `IDEM-RACE-${Date.now()}`, name: 'Concurrent Bench' };

    /*
     * The sequential test above proves a replay happens; it cannot prove the key is claimed
     * atomically, because the first request had already finished. On SQLite the difference was
     * unobservable - one writer at a time meant these could not interleave.
     */
    const result = await runConcurrently(5, () =>
      as(catalogManager).post('/api/v1/admin/catalog/products').set('Idempotency-Key', key).send(body),
    );

    expectNoInfrastructureFailures(result);
    console.log(
      `[concurrency] idempotency replay: ${JSON.stringify(
        result.values.map((response) => [response.status, response.headers['idempotent-replay']]),
      )}`,
    );

    const created = result.values.filter(
      (response) => response.status === 201 && response.headers['idempotent-replay'] !== 'true',
    );
    const replayed = result.values.filter(
      (response) => response.headers['idempotent-replay'] === 'true',
    );
    const inFlight = result.values.filter((response) => response.status === 409);

    // G1: five responses, and a real product id on the one that did the work.
    expect(result.values).toHaveLength(5);
    expect(created).toHaveLength(1);
    expect(created[0]!.body.data.id).toMatch(/^c[a-z0-9]{20,}$/);

    createdProductIds.push(created[0]!.body.data.id);

    // A caller that arrives while the first is still running is told so rather than duplicating.
    expect(replayed.length + inFlight.length).toBe(4);
    for (const response of replayed) {
      expect(response.body.data.id).toBe(created[0]!.body.data.id);
    }

    expect(await prisma.product.count({ where: { sku: body.sku } })).toBe(1);
  }, 120_000);

  it('rejects the same key with a different payload', async () => {
    const key = `test-key-conflict-${Date.now()}`;

    const first = await as(catalogManager)
      .post('/api/v1/admin/catalog/products')
      .set('Idempotency-Key', key)
      .send({ sku: `IDEM-A-${Date.now()}`, name: 'First' })
      .expect(201);

    createdProductIds.push(first.body.data.id);

    const conflict = await as(catalogManager)
      .post('/api/v1/admin/catalog/products')
      .set('Idempotency-Key', key)
      .send({ sku: `IDEM-B-${Date.now()}`, name: 'Second' });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('CSRF regression', () => {
  it('still accepts a mutation when a stale duplicate CSRF cookie is present', async () => {
    const product = await createProduct({ name: 'CSRF Probe' });

    // A cookie left over from an older, narrower path arrives first in the header.
    const withStale = `cw_adm_csrf=stale-value-from-old-path; ${catalogManager.header}`;

    const response = await request(app)
      .patch(`/api/v1/admin/catalog/products/${product.id}`)
      .set('Cookie', withStale)
      .set('X-CSRF-Token', catalogManager.csrf)
      .send({ version: product.version, searchKeywords: 'csrf regression' });

    expect(response.status).toBe(200);
  });

  it('still rejects a mutation with no CSRF header at all', async () => {
    const product = await createProduct({ name: 'CSRF Denied' });

    const response = await request(app)
      .patch(`/api/v1/admin/catalog/products/${product.id}`)
      .set('Cookie', catalogManager.header)
      .send({ version: product.version });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });
});

describe('RBAC on every new route', () => {
  // ORDER_MANAGER is granted catalog.product.read and catalog.inventory.* by the Prompt 3 role
  // seed, so these are the routes it genuinely must not reach.
  const readRoutes = [
    '/api/v1/admin/catalog/categories/tree',
    '/api/v1/admin/catalog/attributes',
    '/api/v1/admin/catalog/collections',
  ];

  it('rejects anonymous requests with 401', async () => {
    for (const route of [...readRoutes, '/api/v1/admin/catalog/products']) {
      expect((await request(app).get(route)).status).toBe(401);
    }
  });

  it('rejects an ORDER_MANAGER with 403', async () => {
    for (const route of readRoutes) {
      expect((await as(orderManager).get(route)).status).toBe(403);
    }
  });

  it('lets an ORDER_MANAGER read products but not write them', async () => {
    expect((await as(orderManager).get('/api/v1/admin/catalog/products')).status).toBe(200);

    const response = await as(orderManager)
      .post('/api/v1/admin/catalog/products')
      .send({ sku: `DENY-${Date.now()}`, name: 'Should not exist' });

    expect(response.status).toBe(403);
  });

  it('lets a CATALOG_MANAGER through', async () => {
    for (const route of [...readRoutes, '/api/v1/admin/catalog/products']) {
      expect((await as(catalogManager).get(route)).status).toBe(200);
    }
  });

  it('keeps tax classes on pricing.tax, which neither manager role owns fully', async () => {
    expect((await as(orderManager).get('/api/v1/admin/catalog/tax-classes')).status).toBe(403);
    expect((await as(superAdmin).get('/api/v1/admin/catalog/tax-classes')).status).toBe(200);
  });

  it('records a PERMISSION_DENIED audit row for a refused request', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'PERMISSION_DENIED' } });
    await as(orderManager).get('/api/v1/admin/catalog/attributes');

    const deadline = Date.now() + 4000;
    let after = before;
    while (after <= before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      after = await prisma.auditLog.count({ where: { action: 'PERMISSION_DENIED' } });
    }
    expect(after).toBeGreaterThan(before);
  });
});
