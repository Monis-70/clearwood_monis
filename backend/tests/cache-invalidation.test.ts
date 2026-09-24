import sharp from 'sharp';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { storefrontListQuerySchema } from '@shared/schemas/storefront';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { cache } from '../src/container';
import { passwordService } from '../src/modules/auth/password.service';
import { rbacService } from '../src/modules/auth/rbac.service';
import { facetCacheKey } from '../src/modules/storefront/facet.service';
import type { ResolvedScope } from '../src/modules/storefront/listing.filters';
import { landingCacheKey } from '../src/modules/storefront/storefront.facade';
import { roleRepository } from '../src/repositories/role.repository';

/**
 * Prompt 2 — cache keys that include every input, invalidation for writes that used to skip it,
 * and the permission cache staying out of the shared cache.
 */

const app = createApp();
const API = '/api/v1';
const TEST_PASSWORD = 'Rosewood-Teak-2026';

const scope: ResolvedScope = {
  categoryId: null,
  categoryIds: [],
  categoryPath: null,
  categoryKind: null,
  categoryRule: null,
  collectionId: null,
  brandIds: [],
};

const query = (input: Record<string, unknown> = {}) => storefrontListQuerySchema.parse(input);

describe('facet cache key', () => {
  const key = (input: Record<string, unknown>, values = new Map<string, string[]>()) =>
    facetCacheKey({ query: query(input), scope, valueIdsByAttribute: values });

  it('changes with leadTimeMax, which the listing filters on', () => {
    expect(key({ categorySlug: 'sofas', leadTimeMax: 7 })).not.toBe(key({ categorySlug: 'sofas' }));
  });

  it('keeps the whole digest, so distinct filter sets never share counts', () => {
    // A long search term used to fill the old 40-character key, hiding every filter after it.
    const q = 'solid sheesham wood dining table';
    const keys = new Set(Array.from({ length: 200 }, (_, index) => key({ q, priceMax: index })));
    expect(keys.size).toBe(200);

    // Brands are keyed as resolved into the scope (ids from brandIds and brandSlugs together).
    const withBrands = (brandIds: string[]) =>
      facetCacheKey({
        query: query({ q }),
        scope: { ...scope, brandIds },
        valueIdsByAttribute: new Map(),
      });
    expect(withBrands(['brand-a'])).not.toBe(withBrands(['brand-b']));
  });

  it('ignores the order values were selected in', () => {
    expect(key({}, new Map([['attr', ['b', 'a']]]))).toBe(key({}, new Map([['attr', ['a', 'b']]])));
  });
});

describe('category landing cache key', () => {
  it('includes every filter the landing passes through', () => {
    const plain = landingCacheKey('sofas', null, query());

    for (const filter of [
      { priceMax: 1 },
      { brandSlugs: 'clearwood' },
      { attributeValueIds: 'value-id' },
      { inStockOnly: 'true' },
      { leadTimeMax: 7 },
      { q: 'teak' },
      { pincode: '400001' },
    ]) {
      expect(landingCacheKey('sofas', null, query(filter)), JSON.stringify(filter)).not.toBe(plain);
    }
  });

  it('ignores what the landing overrides, and separates shoppers', () => {
    const plain = landingCacheKey('sofas', null, query());
    expect(landingCacheKey('sofas', null, query({ page: 3, limit: 50, sort: 'NEWEST' }))).toBe(
      plain,
    );
    expect(landingCacheKey('sofas', 'customer-1', query())).not.toBe(plain);
  });

  it("never serves one shopper's filtered landing to the next shopper", async () => {
    const filtered = await request(app).get(`${API}/catalog/categories/sofas/landing?priceMax=1`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.featured).toHaveLength(0);

    const plain = await request(app).get(`${API}/catalog/categories/sofas/landing`);
    expect(plain.status).toBe(200);
    expect(plain.body.data.featured.length).toBeGreaterThan(0);
  });
});

/* ----------------------------------------------------------------------- media */

async function catalogManager(): Promise<{ header: string; csrf: string }> {
  const email = 'cache.media@clearwood.local';
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'CATALOG_MANAGER' } });
  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: 'Cache Media',
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
    .post(`${API}/admin/auth/login`)
    .send({ email, password: TEST_PASSWORD });
  const raw = login.headers['set-cookie'];
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

  return {
    header: cookies.map((cookie) => cookie.split(';')[0]).join('; '),
    csrf:
      cookies
        .find((cookie) => cookie.startsWith('cw_adm_csrf='))
        ?.split(';')[0]
        ?.split('=')[1] ?? '',
  };
}

/**
 * Prompt 3: media writes drop only what can render the affected images - the owning product's
 * PDP payloads, listings, suggestions and CMS pages (plus banners for asset writes) - and leave
 * other products, facets, category trees and settings warm.
 */
const SHARED_RENDERS = ['sf:list:sentinel', 'sf:sugg:sentinel', 'cms:page:sentinel'];
const SPARED = [
  'sf:pdp:some-other-product:x',
  'sf:facet:sentinel',
  'cat:tree:sentinel',
  'settings:sentinel',
];

describe('media writes invalidate what renders media, and nothing else', () => {
  let session: { header: string; csrf: string };
  let mediaId: string;
  let productId: string;
  let galleryRenders: string[];
  let assetRenders: string[];

  const admin = {
    patch: (url: string) =>
      request(app).patch(url).set('Cookie', session.header).set('X-CSRF-Token', session.csrf),
    post: (url: string) =>
      request(app).post(url).set('Cookie', session.header).set('X-CSRF-Token', session.csrf),
    delete: (url: string) =>
      request(app).delete(url).set('Cookie', session.header).set('X-CSRF-Token', session.csrf),
  };

  const png = (hex: string) =>
    sharp({ create: { width: 320, height: 240, channels: 3, background: hex } })
      .png()
      .toBuffer();

  const upload = async (hex: string, name: string): Promise<string> => {
    const response = await admin
      .post(`${API}/admin/media/upload`)
      .attach('files', await png(hex), name);
    expect(response.status).toBe(201);
    return response.body.data.uploaded[0].media.id;
  };

  async function plant(keys: string[]): Promise<void> {
    for (const key of [...keys, ...SPARED]) await cache.set(key, { stale: true }, 300);
  }

  /** Planted keys still present - must be none of `dropped` and all of SPARED. */
  async function expectDropped(dropped: string[]): Promise<void> {
    const left: string[] = [];
    for (const key of [...dropped, ...SPARED]) if (await cache.get(key)) left.push(key);
    expect(left).toEqual(SPARED);
  }

  beforeAll(async () => {
    session = await catalogManager();
    mediaId = await upload('#7E8C77', 'cache-sentinel.png');
    const product = await prisma.product.findFirstOrThrow({
      where: { deletedAt: null },
      orderBy: { id: 'asc' },
    });
    productId = product.id;
    galleryRenders = [`sf:pdp:${product.slug}:x`, ...SHARED_RENDERS];
    assetRenders = [...galleryRenders, 'cms:banner:sentinel'];
  });

  it('attaching, editing, reordering and detaching gallery items', async () => {
    await plant(galleryRenders);
    const attached = await admin
      .post(`${API}/admin/products/${productId}/media`)
      .send({ items: [{ mediaId, role: 'GALLERY' }] });
    expect(attached.status).toBe(201);
    await expectDropped(galleryRenders);

    const itemId = attached.body.data.find(
      (item: { mediaId: string }) => item.mediaId === mediaId,
    ).id;

    await plant(galleryRenders);
    await admin
      .patch(`${API}/admin/products/${productId}/media/${itemId}`)
      .send({ altText: 'Sage swatch' })
      .expect(200);
    await expectDropped(galleryRenders);

    await plant(galleryRenders);
    await admin
      .patch(`${API}/admin/products/${productId}/media/reorder`)
      .send({ items: [{ id: itemId, position: 1 }] })
      .expect(200);
    await expectDropped(galleryRenders);

    await plant(galleryRenders);
    const detached = await admin.delete(`${API}/admin/products/${productId}/media/${itemId}`);
    expect(detached.status).toBeLessThan(300);
    await expectDropped(galleryRenders);
  });

  it('editing, replacing, reprocessing, deleting and restoring an attached asset', async () => {
    await admin
      .post(`${API}/admin/products/${productId}/media`)
      .send({ items: [{ mediaId, role: 'GALLERY' }] })
      .expect(201);

    await plant(assetRenders);
    await admin.patch(`${API}/admin/media/${mediaId}`).send({ altText: 'Sage' }).expect(200);
    await expectDropped(assetRenders);

    await plant(assetRenders);
    const replaced = await admin
      .post(`${API}/admin/media/${mediaId}/replace`)
      .attach('files', await png('#B4613A'), 'cache-sentinel-v2.png');
    expect(replaced.status).toBe(200);
    await expectDropped(assetRenders);

    // Regenerating renditions changes the URLs a product page embeds.
    await plant(assetRenders);
    const reprocessed = await admin.post(`${API}/admin/media/${mediaId}/reprocess`);
    expect(reprocessed.status).toBeLessThan(300);
    await expectDropped(assetRenders);

    await plant(assetRenders);
    const removed = await admin.delete(`${API}/admin/media/${mediaId}`);
    expect(removed.status).toBeLessThan(300);
    await expectDropped(assetRenders);

    await plant(assetRenders);
    await admin.post(`${API}/admin/media/${mediaId}/restore`).expect(200);
    await expectDropped(assetRenders);

    // A forced permanent delete still knows which product showed the asset.
    await plant(assetRenders);
    const purged = await admin.delete(`${API}/admin/media/${mediaId}/permanent?force=true`);
    expect(purged.status).toBeLessThan(300);
    await expectDropped(assetRenders);
  });

  it('an asset no product uses drops only CMS renders', async () => {
    const loose = await upload('#E3DACE', 'cache-loose.png');
    const productKeys = [...galleryRenders.filter((key) => !key.startsWith('cms:'))];

    await plant([...assetRenders]);
    await admin.patch(`${API}/admin/media/${loose}`).send({ altText: 'Loose' }).expect(200);

    const left: string[] = [];
    for (const key of assetRenders) if (await cache.get(key)) left.push(key);
    expect(left).toEqual(productKeys);
  });
});

/* ------------------------------------------------------------------------ RBAC */

describe('permission cache', () => {
  it('is keyed on permissionVersion and never written to the shared cache', async () => {
    const user = await prisma.adminUser.findFirstOrThrow({ where: { deletedAt: null } });
    const lookup = vi.spyOn(roleRepository, 'permissionCodesFor');
    const shared = vi.spyOn(cache, 'set');

    await rbacService.resolvePermissions({ id: user.id, permissionVersion: 9_001 });
    await rbacService.resolvePermissions({ id: user.id, permissionVersion: 9_001 });
    expect(lookup).toHaveBeenCalledTimes(1);

    // A bumped version is a different key: the change is read from MySQL at once.
    await rbacService.resolvePermissions({ id: user.id, permissionVersion: 9_002 });
    expect(lookup).toHaveBeenCalledTimes(2);

    expect(shared.mock.calls.some(([key]) => String(key).startsWith('rbac:'))).toBe(false);
    lookup.mockRestore();
    shared.mockRestore();
  });
});
