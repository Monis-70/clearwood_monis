import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyBasisPoints } from '@shared/money';
import type { StorefrontListQuery } from '@shared/schemas/storefront';
import type { PriceBreakdown } from '@shared/types/pricing';
import type { ProductCardDto, ProductDetailDto, ProductListDto } from '@shared/types/storefront';

import type * as prismaModule from '../../src/config/prisma';
import type * as containerModule from '../../src/container';
import type { SqlSearchDriver } from '../../src/drivers/search/sql.search.driver';
import type * as facadeModule from '../../src/modules/storefront/storefront.facade';

/**
 * Mutation -> read consistency, shared by the memory-cache and Redis test files.
 *
 * Every mutation goes through the admin API - the real write path with its own invalidation -
 * and every assertion reads the public API with its caches warmed first, so a missed cache drop,
 * a missed index refresh or stale prepared search text shows up as a wrong answer, not as a
 * function that was or was not called. `src/` is imported inside beforeAll so the Redis file can
 * set CACHE_DRIVER before config/env is parsed.
 */

const API = '/api/v1';
const PASSWORD = 'Rosewood-Teak-2026';
const PINCODE = '560025';

/** The compact card: exactly these fields, nothing from the product record beyond them. */
const CARD_KEYS = [
  'allowCustomization',
  'badges',
  'brandId',
  'brandName',
  'compareAtPricePaise',
  'currency',
  'id',
  'image',
  'inStock',
  'indexedMaxPricePaise',
  'indexedMinPricePaise',
  'isBestSeller',
  'isFeatured',
  'isMadeToOrder',
  'isNewArrival',
  'leadTimeDays',
  'manufacturedInHouse',
  'name',
  'priceNote',
  'pricePaise',
  'primaryCategoryName',
  'primaryCategorySlug',
  'ratingAvgBp',
  'ratingCount',
  'savingsPaise',
  'savingsPercentBp',
  'shortDescription',
  'sku',
  'slug',
  'soldCount',
  'stockStatus',
  'subtitle',
  'swatches',
  'variantCount',
];

interface Made {
  id: string;
  slug: string;
  variantId: string;
}

interface Session {
  cookie: string;
  csrf: string;
}

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown as string[] | string | undefined;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function sessionFrom(response: request.Response, csrfCookie: string): Session {
  const jar = cookiesOf(response);
  return {
    cookie: jar.map((cookie) => cookie.split(';')[0]).join('; '),
    csrf:
      jar
        .find((cookie) => cookie.startsWith(`${csrfCookie}=`))
        ?.split(';')[0]
        ?.split('=')[1] ?? '',
  };
}

/** The money a shopper sees, without the per-call context hash and timestamps. */
function money(breakdown: PriceBreakdown) {
  return {
    lines: breakdown.lines.map((line) => ({
      unitPricePaise: line.unitPricePaise,
      taxPaise: line.taxPaise,
      totalPaise: line.totalPaise,
    })),
    shippingPaise: breakdown.shippingPaise,
    taxPaise: breakdown.taxPaise,
    grandTotalPaise: breakdown.grandTotalPaise,
  };
}

export function defineConsistencySuite(label: string, options: { enabled: boolean }): void {
  describe.skipIf(!options.enabled)(label, () => {
    const tag = randomUUID().slice(0, 6);
    const token = `mutok${tag}`;

    let app: Express;
    let prisma: typeof prismaModule.prisma;
    let cache: typeof containerModule.cache;
    let search: typeof containerModule.search;
    let settle: () => Promise<void>;
    let listingCacheKey: typeof facadeModule.listingCacheKey;
    let parseListQuery: (input: Record<string, string>) => StorefrontListQuery;
    let freshDriver: SqlSearchDriver;

    let admin: Session;
    let shopper: Session;
    let root: { id: string; slug: string };
    let catA: { id: string; slug: string };
    let catB: { id: string; slug: string };
    let groupId: string;
    const made: Record<string, Made> = {};

    /* ------------------------------------------------------------- reads */

    const list = async (query: string, session?: Session): Promise<ProductListDto> => {
      const call = request(app).get(
        `${API}/catalog/products?${query}&includeFacets=false&limit=48`,
      );
      const response = session ? await call.set('Cookie', session.cookie) : await call;
      expect(response.status, response.text.slice(0, 200)).toBe(200);
      return response.body.data as ProductListDto;
    };
    const slugs = (listing: ProductListDto) => listing.items.map((item) => item.slug);
    const card = (listing: ProductListDto, product: Made): ProductCardDto => {
      const found = listing.items.find((item) => item.slug === product.slug);
      expect(found, `${product.slug} is not in the listing`).toBeDefined();
      return found!;
    };
    const order = (listing: ProductListDto, products: Made[]) =>
      slugs(listing).filter((slug) => products.some((product) => product.slug === slug));
    const pdp = async (product: Made) =>
      request(app).get(`${API}/catalog/products/${product.slug}`);
    const pdpBody = async (product: Made): Promise<ProductDetailDto> => {
      const response = await pdp(product);
      expect(response.status).toBe(200);
      return response.body.data as ProductDetailDto;
    };
    const searchSlugs = async (q: string): Promise<string[]> => {
      const response = await request(app).get(`${API}/search?q=${encodeURIComponent(q)}&limit=48`);
      expect(response.status).toBe(200);
      return (response.body.data.products.items as ProductCardDto[]).map((item) => item.slug);
    };
    const quote = async (product: Made, extra: { pincode?: string } = {}, session?: Session) => {
      const call = request(app)
        .post(`${API}/pricing/quote`)
        .send({ items: [{ slug: product.slug, qty: 1 }], ...extra });
      const response = session ? await call.set('Cookie', session.cookie) : await call;
      expect(response.status, response.text.slice(0, 200)).toBe(200);
      return response.body.data as PriceBreakdown;
    };
    /** The same read after every cache is dropped: what the database says right now. */
    const truth = async <T>(read: () => Promise<T>): Promise<T> => {
      await cache.delByPrefix('');
      return read();
    };

    /* ------------------------------------------------------------ writes */

    const write = (method: 'patch' | 'put' | 'post', url: string, body: object = {}) =>
      request(app)
        [method](`${API}/admin${url}`)
        .set('Cookie', admin.cookie)
        .set('X-CSRF-Token', admin.csrf)
        .send(body);
    const expectOk = (response: request.Response) =>
      expect(response.status, response.text.slice(0, 300)).toBeLessThan(300);

    const patchProduct = async (product: Made, data: object) => {
      const { version } = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
        select: { version: true },
      });
      expectOk(await write('patch', `/catalog/products/${product.id}`, { ...data, version }));
    };

    /* ----------------------------------------------------------- fixture */

    beforeAll(async () => {
      // One at a time: parallel dynamic imports of modules in an import cycle can deadlock vite-node.
      const { createApp } = await import('../../src/app');
      ({ prisma } = await import('../../src/config/prisma'));
      ({ cache, search } = await import('../../src/container'));
      ({ listingCacheKey } = await import('../../src/modules/storefront/storefront.facade'));
      const events = await import('../../src/events/catalogEvents');
      const indexer = await import('../../src/modules/storefront/searchIndexer.service');
      const passwords = await import('../../src/modules/auth/password.service');
      const schemas = await import('@shared/schemas/storefront');
      const driver = await import('../../src/drivers/search/sql.search.driver');
      const marks = await import('../../src/utils/uniqueMark');
      app = createApp();
      settle = () => events.catalogEvents.settled();
      parseListQuery = (input) => schemas.storefrontListQuerySchema.parse(input);
      freshDriver = new driver.SqlSearchDriver(0);

      // The Redis driver connects asynchronously; wait for it rather than race it.
      const deadline = Date.now() + 10_000;
      while (!(await cache.ping()) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const category = (name: string, parent?: { id: string; slug: string; path: string }) =>
        prisma.category.create({
          data: {
            name: `MC ${name} ${tag}`,
            slug: `mc-${name}-${tag}`,
            parentId: parent?.id ?? null,
            path: parent ? `${parent.path}/mc-${name}-${tag}` : `mc-${name}-${tag}`,
            depth: parent ? 1 : 0,
          },
        });
      const top = await category('root');
      root = top;
      catA = await category('a', top);
      catB = await category('b', top);

      const product = async (key: string, basePricePaise: number, name?: string) => {
        const row = await prisma.product.create({
          data: {
            sku: `MC-${key}-${tag}`,
            slug: `mc-${key}-${tag}`,
            name: name ?? `Mutok ${key} ${token}`,
            status: 'ACTIVE',
            visibility: 'PUBLIC',
            basePricePaise,
            publishedAt: new Date(Date.now() - 86_400_000),
            categories: {
              create: { categoryId: catA.id, isPrimary: true, primaryMark: marks.mark(true) },
            },
            variants: {
              create: {
                sku: `MC-${key}-${tag}-0`,
                position: 0,
                isDefault: true,
                defaultMark: marks.mark(true),
                stockQty: 5,
              },
            },
          },
          include: { variants: true },
        });
        made[key] = { id: row.id, slug: row.slug, variantId: row.variants[0]!.id };
      };

      await product('price', 10_000_00);
      await product('peer', 20_000_00);
      await product('stock', 13_000_00);
      await product('move', 15_000_00);
      await product('hide', 12_000_00);
      await product('variant', 14_000_00);
      await product('cheap', 1_000_00);
      await product('rename', 16_000_00, `Mutok rename zephyr${tag}`);
      for (const entry of Object.values(made))
        await indexer.searchIndexerService.indexProduct(entry.id);

      const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
      const adminEmail = `mc.admin.${tag}@clearwood.local`;
      const adminUser = await prisma.adminUser.create({
        data: {
          email: adminEmail,
          name: 'Consistency Admin',
          passwordHash: await passwords.passwordService.hash(PASSWORD),
          status: 'ACTIVE',
        },
      });
      await prisma.adminUserRole.create({ data: { adminUserId: adminUser.id, roleId: role.id } });
      const adminLogin = await request(app)
        .post(`${API}/admin/auth/login`)
        .send({ email: adminEmail, password: PASSWORD });
      expect(adminLogin.status).toBe(200);
      admin = sessionFrom(adminLogin, 'cw_adm_csrf');

      const customerEmail = `mc.shopper.${tag}@clearwood.local`;
      const customer = await prisma.customer.create({
        data: {
          email: customerEmail,
          name: 'Consistency Shopper',
          status: 'ACTIVE',
          passwordHash: await passwords.passwordService.hash(PASSWORD),
          emailVerifiedAt: new Date(),
        },
      });
      const group = await prisma.customerGroup.create({
        data: { code: `MC-${tag}`, name: 'Consistency trade', priority: 900, discountBp: 1000 },
      });
      groupId = group.id;
      await prisma.customerGroupMember.create({ data: { customerId: customer.id, groupId } });
      const shopperLogin = await request(app)
        .post(`${API}/auth/login`)
        .send({ identifier: customerEmail, password: PASSWORD });
      expect(shopperLogin.status).toBe(200);
      shopper = sessionFrom(shopperLogin, 'cw_cus_csrf');

      await settle();
    }, 120_000);

    afterAll(async () => {
      if (cache) await cache.delByPrefix('');
    });

    /* ------------------------------------------------------------- tests */

    it('A. a product price change reaches the card, the product page, the filter and the sort', async () => {
      const sorted = () => list(`categorySlug=${catA.slug}&sort=PRICE_ASC`);
      const above = () => list(`categorySlug=${catA.slug}&priceMin=2500000`);
      const [price, peer] = [made.price!, made.peer!];

      expect(order(await sorted(), [price, peer])).toEqual([price.slug, peer.slug]);
      expect(slugs(await above())).not.toContain(price.slug);
      expect((await pdpBody(price)).price.lines[0]!.unitPricePaise).toBe(10_000_00);

      await patchProduct(price, { basePricePaise: 30_000_00 });

      // Displayed prices are live, and the write drops their caches before it answers.
      expect(card(await sorted(), price).pricePaise).toBe(30_000_00);
      expect((await pdpBody(price)).price.lines[0]!.unitPricePaise).toBe(30_000_00);
      expect((await quote(price)).lines[0]!.unitPricePaise).toBe(30_000_00);

      // Filter and sort read the listing index, which the write's product event refreshes.
      await settle();
      expect(order(await sorted(), [price, peer])).toEqual([peer.slug, price.slug]);
      expect(slugs(await above())).toContain(price.slug);
      expect(card(await sorted(), price).indexedMinPricePaise).toBe(30_000_00);
    });

    it('B. an inventory change moves the product in and out of the in-stock grid', async () => {
      const stock = made.stock!;
      const inStock = () => list(`categorySlug=${catA.slug}&inStockOnly=true`);
      expect(slugs(await inStock())).toContain(stock.slug);
      expect((await pdpBody(stock)).inStock).toBe(true);

      expectOk(
        await write('post', `/catalog/variants/${stock.variantId}/inventory/adjust`, {
          absolute: 0,
        }),
      );
      await settle();
      expect(slugs(await inStock())).not.toContain(stock.slug);
      expect(card(await list(`categorySlug=${catA.slug}`), stock).inStock).toBe(false);
      expect((await pdpBody(stock)).inStock).toBe(false);

      expectOk(
        await write('post', `/catalog/variants/${stock.variantId}/inventory/adjust`, {
          absolute: 3,
        }),
      );
      await settle();
      expect(slugs(await inStock())).toContain(stock.slug);
      expect((await pdpBody(stock)).inStock).toBe(true);
    });

    it('C. a category change moves the product between category listings', async () => {
      const moving = made.move!;
      expect(slugs(await list(`categorySlug=${catA.slug}`))).toContain(moving.slug);
      expect(slugs(await list(`categorySlug=${catB.slug}`))).not.toContain(moving.slug);
      expect(slugs(await list(`categorySlug=${root.slug}`))).toContain(moving.slug);

      expectOk(
        await write('put', `/catalog/products/${moving.id}/categories`, {
          primaryCategoryId: catB.id,
          categoryIds: [catB.id],
        }),
      );
      await settle();
      expect(slugs(await list(`categorySlug=${catA.slug}`))).not.toContain(moving.slug);
      expect(slugs(await list(`categorySlug=${catB.slug}`))).toContain(moving.slug);
      // Nested: the parent category still lists its child's product.
      expect(slugs(await list(`categorySlug=${root.slug}`))).toContain(moving.slug);
    });

    it('D. hiding or unpublishing a product removes it from every public read', async () => {
      const hidden = made.hide!;
      const inA = async () => slugs(await list(`categorySlug=${catA.slug}`));
      expect(await inA()).toContain(hidden.slug);
      expect(await searchSlugs(token)).toContain(hidden.slug);
      expect((await pdp(hidden)).status).toBe(200);

      await patchProduct(hidden, { visibility: 'HIDDEN' });
      expect(await inA()).not.toContain(hidden.slug);
      expect((await pdp(hidden)).status).toBe(404);
      await settle();
      expect(await searchSlugs(token)).not.toContain(hidden.slug);

      await patchProduct(hidden, { visibility: 'PUBLIC' });
      await settle();
      expect(await inA()).toContain(hidden.slug);
      expect(await searchSlugs(token)).toContain(hidden.slug);

      expectOk(await write('post', `/catalog/products/${hidden.id}/unpublish`));
      expect(await inA()).not.toContain(hidden.slug);
      expect((await pdp(hidden)).status).toBe(404);
      await settle();
      expect(await searchSlugs(token)).not.toContain(hidden.slug);
    });

    it('E. a variant change is never served from a cached grid', async () => {
      const changed = made.variant!;
      const query = { categorySlug: catA.slug, includeFacets: 'false', limit: '48' };
      const key = listingCacheKey(parseListQuery(query), 'anon');

      expect(card(await list(`categorySlug=${catA.slug}`), changed).pricePaise).toBe(14_000_00);
      // The grid really is cached now, so what follows proves the write removed it.
      expect(await cache.get(key)).not.toBeNull();

      const { version } = await prisma.productVariant.findUniqueOrThrow({
        where: { id: changed.variantId },
        select: { version: true },
      });
      expectOk(
        await write('patch', `/catalog/products/${changed.id}/variants/${changed.variantId}`, {
          pricePaise: 9_000_00,
          version,
        }),
      );
      expect(card(await list(`categorySlug=${catA.slug}`), changed).pricePaise).toBe(9_000_00);

      await settle();
      expect(slugs(await list(`categorySlug=${catA.slug}&priceMax=950000`))).toContain(
        changed.slug,
      );
    });

    it("F1. a customer-group discount change reaches that group's cards and quotes at once", async () => {
      const cheap = made.cheap!;
      const at = (bp: number) => 1_000_00 - applyBasisPoints(1_000_00, bp);
      expect(card(await list(`categorySlug=${catA.slug}`, shopper), cheap).pricePaise).toBe(
        at(1000),
      );
      expect((await quote(cheap, {}, shopper)).lines[0]!.unitPricePaise).toBe(at(1000));

      const { version } = await prisma.customerGroup.findUniqueOrThrow({ where: { id: groupId } });
      expectOk(
        await write('patch', `/pricing/customer-groups/${groupId}`, { discountBp: 2500, version }),
      );

      expect(card(await list(`categorySlug=${catA.slug}`, shopper), cheap).pricePaise).toBe(
        at(2500),
      );
      expect((await quote(cheap, {}, shopper)).lines[0]!.unitPricePaise).toBe(at(2500));
      // Anonymous shoppers never saw the group's price.
      expect(card(await list(`categorySlug=${catA.slug}`), cheap).pricePaise).toBe(1_000_00);
    });

    it('F2. a discount on the default group reaches anonymous prices at once', async () => {
      const cheap = made.cheap!;
      const group = await prisma.customerGroup.findFirstOrThrow({
        where: { isDefault: true, isActive: true, deletedAt: null },
      });
      const setDiscount = async (discountBp: number | null) => {
        const { version } = await prisma.customerGroup.findUniqueOrThrow({
          where: { id: group.id },
        });
        expectOk(
          await write('patch', `/pricing/customer-groups/${group.id}`, { discountBp, version }),
        );
      };

      const before = (await quote(cheap)).lines[0]!.unitPricePaise;
      try {
        await setDiscount(1500);
        const expected = before - applyBasisPoints(before, 1500);
        expect((await quote(cheap)).lines[0]!.unitPricePaise).toBe(expected);
        expect(card(await list(`categorySlug=${catA.slug}`), cheap).pricePaise).toBe(expected);
      } finally {
        await setDiscount(group.discountBp);
      }
      expect((await quote(cheap)).lines[0]!.unitPricePaise).toBe(before);
    });

    it('F3. a tax-rate change reaches the next quote', async () => {
      const cheap = made.cheap!;
      const taxClass = await prisma.taxClass.findFirstOrThrow({
        where: { isDefault: true, deletedAt: null },
      });
      const nextRate = taxClass.rateBp === 1200 ? 500 : 1200;

      const before = money(await quote(cheap));
      try {
        expectOk(await write('patch', `/catalog/tax-classes/${taxClass.id}`, { rateBp: nextRate }));
        const after = money(await quote(cheap));
        expect(after.lines[0]!.taxPaise).not.toBe(before.lines[0]!.taxPaise);
        expect(after).toEqual(money(await truth(() => quote(cheap))));
      } finally {
        expectOk(
          await write('patch', `/catalog/tax-classes/${taxClass.id}`, { rateBp: taxClass.rateBp }),
        );
      }
      expect(money(await quote(cheap))).toEqual(before);
    });

    it('F4. a shipping-rate change reaches the next quote for that pincode', async () => {
      const cheap = made.cheap!;
      const before = money(await quote(cheap, { pincode: PINCODE }));
      expect(before.shippingPaise, 'the fixture must actually charge shipping').toBeGreaterThan(0);

      const zone = await prisma.shippingPincode.findUnique({ where: { pincode: PINCODE } });
      const rates = await prisma.shippingRate.findMany({
        where: {
          isActive: true,
          deletedAt: null,
          ...(zone ? { zoneId: zone.zoneId } : {}),
        },
      });
      expect(rates.length).toBeGreaterThan(0);

      const setBase = async (delta: number) => {
        for (const rate of rates) {
          const { version, basePaise } = await prisma.shippingRate.findUniqueOrThrow({
            where: { id: rate.id },
          });
          expectOk(
            await write('patch', `/pricing/shipping-rates/${rate.id}`, {
              basePaise: basePaise + delta,
              version,
            }),
          );
        }
      };

      try {
        await setBase(111_00);
        const after = money(await quote(cheap, { pincode: PINCODE }));
        expect(after.shippingPaise).not.toBe(before.shippingPaise);
        expect(after).toEqual(money(await truth(() => quote(cheap, { pincode: PINCODE }))));
      } finally {
        await setBase(-111_00);
      }
      expect(money(await quote(cheap, { pincode: PINCODE }))).toEqual(before);
    });

    it('search never scores text an edit replaced', async () => {
      const renamed = made.rename!;
      const before = `zephyr${tag}`;
      const after = `quasar${tag}`;
      expect(await searchSlugs(before)).toContain(renamed.slug);

      await patchProduct(renamed, { name: `Mutok rename ${after}` });
      await settle();

      expect(await searchSlugs(before)).not.toContain(renamed.slug);
      expect(await searchSlugs(after)).toContain(renamed.slug);
    });

    it('search ranks identically with and without the prepared-text memo', async () => {
      for (const q of [token, 'sofa', 'teak sofa', `mc-cheap-${tag}`, 'sofaa', `quasar${tag}`]) {
        const cold = await search.search({ q, entityTypes: ['PRODUCT'], limit: 100 });
        const warm = await search.search({ q, entityTypes: ['PRODUCT'], limit: 100 });
        const unmemoised = await freshDriver.search({ q, entityTypes: ['PRODUCT'], limit: 100 });
        expect(warm.hits, q).toEqual(cold.hits);
        expect(unmemoised.hits, q).toEqual(warm.hits);
      }
    });

    it('keeps the compact card shape', async () => {
      const listing = await list(`categorySlug=${catA.slug}`);
      for (const item of listing.items) {
        expect(Object.keys(item).sort()).toEqual(CARD_KEYS);
      }
    });
  });
}
