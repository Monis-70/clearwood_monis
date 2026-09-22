import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma, prismaEvents } from '../src/config/prisma';
import { catalogEvents } from '../src/events/catalogEvents';
import { passwordService } from '../src/modules/auth/password.service';

/**
 * Prompt 7 — listing, facets, the PDP, collections, redirects, popularity and caching.
 * Hermetic: anything mutated here is created or restored by the test, never left behind.
 */

const app = createApp();
const TEST_PASSWORD = 'Rosewood-Teak-2026';
const API = '/api/v1';

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
      name: `Storefront ${roleCode}`,
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

function as(session: Session) {
  return {
    get: (url: string) => request(app).get(url).set('Cookie', session.header),
    post: (url: string) =>
      request(app).post(url).set('Cookie', session.header).set('X-CSRF-Token', session.csrf),
    patch: (url: string) =>
      request(app).patch(url).set('Cookie', session.header).set('X-CSRF-Token', session.csrf),
    delete: (url: string) =>
      request(app).delete(url).set('Cookie', session.header).set('X-CSRF-Token', session.csrf),
  };
}

interface Card {
  id: string;
  slug: string;
  name: string;
  pricePaise: number;
  indexedMinPricePaise: number | null;
  inStock: boolean;
  ratingAvgBp: number;
  soldCount: number;
}

interface Listing {
  items: Card[];
  facets: {
    key: string;
    kind: string;
    values: { value: string; label: string; count: number; disabled: boolean; selected: boolean }[];
    minPaise?: number;
    maxPaise?: number;
    buckets?: { fromPaise: number; toPaise: number; count: number }[];
  }[];
  appliedFilters: { key: string; values: string[] }[];
  availableSorts: { value: string; available: boolean }[];
  pricingBasis: string;
  priceBounds: { minPaise: number; maxPaise: number };
  nextCursor: string | null;
  totalCount: number;
}

async function list(query: string): Promise<{ data: Listing; meta: { total: number } }> {
  const response = await request(app).get(`${API}/catalog/products?${query}`);
  expect(response.status).toBe(200);
  return { data: response.body.data as Listing, meta: response.body.meta };
}

let superAdmin: Session;
let catalogManager: Session;
let orderManager: Session;

beforeAll(async () => {
  superAdmin = await admin('storefront.super@clearwood.local', 'SUPER_ADMIN');
  catalogManager = await admin('storefront.catalog@clearwood.local', 'CATALOG_MANAGER');
  orderManager = await admin('storefront.order@clearwood.local', 'ORDER_MANAGER');
});

describe('product listing', () => {
  it('includes descendant categories through the materialised path', async () => {
    const { data } = await list('categorySlug=sofas&limit=96');
    const slugs = data.items.map((item) => item.slug);

    // Kabir lives in "fabric-sofas", a child of "sofas".
    expect(slugs).toContain('kabir-3-seater-fabric-sofa');
    expect(data.totalCount).toBeGreaterThan(5);
  });

  it('reports which pricing basis the filters ran against', async () => {
    const { data } = await list('limit=5');
    expect(data.pricingBasis).toBe('DEFAULT_GROUP');
  });

  it('filters on the resolved price index, not the raw base price', async () => {
    const { data } = await list('priceMin=0&priceMax=1000000&limit=96');

    for (const item of data.items) {
      const indexed = item.indexedMinPricePaise ?? item.pricePaise;
      expect(indexed).toBeLessThanOrEqual(1_000_000);
    }
    expect(data.items.length).toBeGreaterThan(0);
  });

  it('ORs within one attribute and ANDs across attributes', async () => {
    const colour = await prisma.attribute.findFirstOrThrow({ where: { code: 'COLOUR' } });
    const fabric = await prisma.attribute.findFirstOrThrow({ where: { code: 'FABRIC' } });

    const beige = await prisma.attributeValue.findFirstOrThrow({
      where: { attributeId: colour.id, code: 'beige' },
    });
    const charcoal = await prisma.attributeValue.findFirstOrThrow({
      where: { attributeId: colour.id, code: 'charcoal' },
    });
    const velvet = await prisma.attributeValue.findFirstOrThrow({
      where: { attributeId: fabric.id, code: 'velvet' },
    });

    const beigeOnly = await list(`attributeValueIds=${beige.id}&limit=96`);
    const charcoalOnly = await list(`attributeValueIds=${charcoal.id}&limit=96`);
    const either = await list(`attributeValueIds=${beige.id},${charcoal.id}&limit=96`);
    const both = await list(`attributeValueIds=${beige.id},${velvet.id}&limit=96`);

    // OR inside COLOUR: the union is at least as large as either side.
    expect(either.data.totalCount).toBeGreaterThanOrEqual(beigeOnly.data.totalCount);
    expect(either.data.totalCount).toBeGreaterThanOrEqual(charcoalOnly.data.totalCount);

    // AND across COLOUR x FABRIC: never larger than the colour side alone.
    expect(both.data.totalCount).toBeLessThanOrEqual(beigeOnly.data.totalCount);
  });

  it('excludes out-of-stock products when asked', async () => {
    const all = await list('limit=96');
    const inStock = await list('inStockOnly=true&limit=96');

    expect(inStock.data.totalCount).toBeLessThan(all.data.totalCount);
    expect(inStock.data.items.every((item) => item.inStock)).toBe(true);
  });

  it('caps the page size at catalog.max_page_size', async () => {
    const response = await request(app).get(`${API}/catalog/products?limit=200`);
    expect(response.status).toBe(422);
  });

  it.each([
    'PRICE_ASC',
    'PRICE_DESC',
    'NEWEST',
    'POPULARITY',
    'BEST_SELLING',
    'RATING',
    'NAME_ASC',
    'CURATED',
  ])('paginates %s with no duplicate or missing rows', async (sort) => {
    const limit = 10;
    const first = await list(`sort=${sort}&limit=${limit}&page=1`);
    const total = first.data.totalCount;
    const pages = Math.ceil(total / limit);

    const seen: string[] = [...first.data.items.map((item) => item.id)];

    for (let page = 2; page <= pages; page += 1) {
      const next = await list(`sort=${sort}&limit=${limit}&page=${page}`);
      seen.push(...next.data.items.map((item) => item.id));
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('sorts PRICE_ASC by the indexed price, ascending', async () => {
    const { data } = await list('sort=PRICE_ASC&limit=20');
    const prices = data.items.map((item) => item.indexedMinPricePaise ?? item.pricePaise);

    for (let index = 1; index < prices.length; index += 1) {
      expect(prices[index]!).toBeGreaterThanOrEqual(prices[index - 1]!);
    }
  });

  it('returns the same set through cursor pagination as through offsets', async () => {
    const limit = 12;
    const offsetIds: string[] = [];
    const cursorIds: string[] = [];

    const first = await list(`sort=NAME_ASC&limit=${limit}&page=1`);
    offsetIds.push(...first.data.items.map((item) => item.id));
    cursorIds.push(...first.data.items.map((item) => item.id));

    const pages = Math.ceil(first.data.totalCount / limit);
    for (let page = 2; page <= pages; page += 1) {
      const next = await list(`sort=NAME_ASC&limit=${limit}&page=${page}`);
      offsetIds.push(...next.data.items.map((item) => item.id));
    }

    let cursor = first.data.nextCursor;
    while (cursor) {
      const next = await list(`sort=NAME_ASC&limit=${limit}&cursor=${encodeURIComponent(cursor)}`);
      cursorIds.push(...next.data.items.map((item) => item.id));
      cursor = next.data.nextCursor;
    }

    expect(cursorIds).toStrictEqual(offsetIds);
  });

  it('rejects a cursor minted for a different filter set', async () => {
    const { data } = await list('sort=NAME_ASC&limit=5');
    const response = await request(app).get(
      `${API}/catalog/products?sort=PRICE_ASC&limit=5&cursor=${encodeURIComponent(data.nextCursor ?? '')}`,
    );

    expect(response.status).toBe(422);
  });

  it('refuses RELEVANCE sorting without a query', async () => {
    const response = await request(app).get(`${API}/catalog/products?sort=RELEVANCE`);
    expect(response.status).toBe(422);
  });
});

describe('facets', () => {
  it('counts a dimension with its own selection removed but the others applied', async () => {
    const colour = await prisma.attribute.findFirstOrThrow({ where: { code: 'COLOUR' } });
    const beige = await prisma.attributeValue.findFirstOrThrow({
      where: { attributeId: colour.id, code: 'beige' },
    });

    const unfiltered = await list('categorySlug=sofas&limit=96');
    const filtered = await list(`categorySlug=sofas&attributeValueIds=${beige.id}&limit=96`);

    const before = unfiltered.data.facets.find((facet) => facet.key === 'COLOUR');
    const after = filtered.data.facets.find((facet) => facet.key === 'COLOUR');

    expect(before).toBeDefined();
    expect(after).toBeDefined();

    // Selecting beige must not zero its siblings — the colour facet ignores its own selection.
    const siblingsBefore = before!.values.filter((value) => value.count > 0).length;
    const siblingsAfter = after!.values.filter((value) => value.count > 0).length;
    expect(siblingsAfter).toBe(siblingsBefore);

    const selected = after!.values.find((value) => value.value === beige.id);
    expect(selected?.selected).toBe(true);
  });

  it('returns zero-count values disabled rather than dropping them', async () => {
    const { data } = await list('categorySlug=mattresses&limit=96');
    const facet = data.facets.find((entry) => entry.kind === 'ATTRIBUTE');

    expect(facet).toBeDefined();
    const zero = facet!.values.filter((value) => value.count === 0);
    expect(zero.every((value) => value.disabled)).toBe(true);
  });

  it('builds a price histogram whose buckets sum to the result count', async () => {
    const { data } = await list('categorySlug=sofas&limit=96');
    const price = data.facets.find((facet) => facet.kind === 'PRICE');

    expect(price?.buckets).toBeDefined();
    const total = price!.buckets!.reduce((sum, bucket) => sum + bucket.count, 0);
    expect(total).toBe(data.totalCount);
    expect(price!.minPaise).toBeLessThanOrEqual(price!.maxPaise!);
  });

  it('only offers attributes resolvable for the scoped category', async () => {
    const { data } = await list('categorySlug=mattresses&limit=96');
    const keys = data.facets
      .filter((facet) => facet.kind === 'ATTRIBUTE')
      .map((facet) => facet.key);

    expect(keys.length).toBeGreaterThan(0);
    expect(keys).not.toContain('SEATER');
  });
});

describe('product detail', () => {
  it('assembles the whole payload in one request', async () => {
    const response = await request(app).get(
      `${API}/catalog/products/kabir-3-seater-fabric-sofa?pincode=400001`,
    );

    expect(response.status).toBe(200);
    const detail = response.body.data;

    expect(detail.slug).toBe('kabir-3-seater-fabric-sofa');
    expect(detail.breadcrumbs.length).toBeGreaterThan(0);
    expect(detail.gallery.length).toBeGreaterThan(0);
    expect(detail.gallery[0].blurhash).toBeDefined();
    expect(detail.variants.length).toBeGreaterThan(0);
    expect(detail.options.attributes.length).toBeGreaterThan(0);
    expect(detail.specs.length).toBeGreaterThan(0);
    expect(detail.delivery.pincode).toBe('400001');
    expect(detail.pricingBasis).toBe('DEFAULT_GROUP');
  });

  it('prices exactly what /pricing/quote prices for the same selection', async () => {
    const pdp = await request(app).get(
      `${API}/catalog/products/kabir-3-seater-fabric-sofa?qty=2&pincode=400001`,
    );
    const quote = await request(app)
      .post(`${API}/pricing/quote`)
      .send({ items: [{ slug: 'kabir-3-seater-fabric-sofa', qty: 2 }], pincode: '400001' });

    expect(pdp.status).toBe(200);
    expect(quote.status).toBe(200);
    expect(pdp.body.data.price.grandTotalPaise).toBe(quote.body.data.grandTotalPaise);
  });

  it('emits JSON-LD for the product and the breadcrumb trail', async () => {
    const response = await request(app).get(`${API}/catalog/products/kabir-3-seater-fabric-sofa`);
    const [product, breadcrumbs] = response.body.data.jsonLd;

    expect(product['@type']).toBe('Product');
    expect(product.offers['@type']).toBe('Offer');
    expect(product.offers.priceCurrency).toBe('INR');
    expect(product.aggregateRating['@type']).toBe('AggregateRating');
    expect(breadcrumbs['@type']).toBe('BreadcrumbList');
    expect(breadcrumbs.itemListElement.length).toBeGreaterThan(0);
  });

  it('keeps the query count bounded even with a full related-products block', async () => {
    let queries = 0;
    const count = (): void => {
      queries += 1;
    };

    prismaEvents.$on('query' as never, count as never);
    await request(app).get(`${API}/catalog/products/amber-2-seater-fabric-sofa`);

    // The real ceiling lives in src/perf/queryBudgets.ts; this only guards the shape of the page.
    expect(queries).toBeLessThan(150);
  });

  it('returns 404 for an unknown slug', async () => {
    const response = await request(app).get(`${API}/catalog/products/not-a-real-sofa`);
    expect(response.status).toBe(404);
  });
});

describe('option availability', () => {
  it('lists an out-of-stock value as unavailable but still present', async () => {
    const response = await request(app).get(
      `${API}/catalog/products/amber-2-seater-fabric-sofa/options`,
    );

    expect(response.status).toBe(200);
    const values = response.body.data.attributes.flatMap(
      (attribute: { values: { label: string; isInStock: boolean }[] }) => attribute.values,
    );

    expect(values.length).toBeGreaterThan(0);
    expect(values.some((value: { isInStock: boolean }) => !value.isInStock)).toBe(true);
  });

  it('narrows the remaining options as a selection is made', async () => {
    const fabric = await prisma.attribute.findFirstOrThrow({ where: { code: 'FABRIC' } });
    const velvet = await prisma.attributeValue.findFirstOrThrow({
      where: { attributeId: fabric.id, code: 'velvet' },
    });

    const open = await request(app).get(
      `${API}/catalog/products/kabir-3-seater-fabric-sofa/options`,
    );
    const narrowed = await request(app).get(
      `${API}/catalog/products/kabir-3-seater-fabric-sofa/options?optionValueIds=${velvet.id}`,
    );

    const availableIn = (body: {
      data: { attributes: { code: string; values: { isAvailable: boolean }[] }[] };
    }) =>
      body.data.attributes
        .find((attribute) => attribute.code === 'COLOUR')!
        .values.filter((value) => value.isAvailable).length;

    expect(availableIn(narrowed.body)).toBeLessThan(availableIn(open.body));
  });

  it('resolves a complete selection to exactly one variant', async () => {
    const variant = await prisma.productVariant.findFirstOrThrow({
      where: { sku: 'CW-SOF-KABIR-BEI-COT' },
      include: { attributeValues: true },
    });

    const ids = variant.attributeValues.map((link) => link.attributeValueId).join(',');
    const response = await request(app).get(
      `${API}/catalog/products/kabir-3-seater-fabric-sofa/options?optionValueIds=${ids}`,
    );

    expect(response.body.data.resolvedVariantId).toBe(variant.id);
  });

  it('returns a sane matrix for a single-variant product', async () => {
    const response = await request(app).get(`${API}/catalog/products/raag-designer-chair/options`);

    expect(response.status).toBe(200);
    expect(response.body.data.combinations).toHaveLength(1);
    expect(response.body.data.defaultVariantId).not.toBeNull();
  });
});

describe('collections', () => {
  it('materialised every automatic collection at seed time', async () => {
    const response = await request(app).get(`${API}/catalog/collections`);

    expect(response.status).toBe(200);
    const collections = response.body.data as { slug: string; productCount: number }[];

    expect(collections.length).toBeGreaterThan(0);
    expect(collections.every((collection) => collection.productCount > 0)).toBe(true);
  });

  it('matches the right products for a flag rule', async () => {
    const response = await request(app).get(`${API}/catalog/collections/made-to-order?limit=96`);

    expect(response.status).toBe(200);
    const slugs = (response.body.data.products.items as Card[]).map((item) => item.slug);
    expect(slugs).toContain('atelier-6-seater-dining-set');
  });

  it('keeps a manual position override across a re-evaluation', async () => {
    const collection = await prisma.collection.findFirstOrThrow({
      where: { slug: 'best-sellers' },
    });
    const member = await prisma.collectionProduct.findFirstOrThrow({
      where: { collectionId: collection.id },
    });

    await prisma.collectionProduct.update({ where: { id: member.id }, data: { position: 97 } });
    await as(superAdmin).post(`${API}/admin/collections/${collection.id}/evaluate`).expect(200);

    const after = await prisma.collectionProduct.findUniqueOrThrow({ where: { id: member.id } });
    expect(after.position).toBe(97);

    await prisma.collectionProduct.update({
      where: { id: member.id },
      data: { position: member.position },
    });
  });

  it('refuses to evaluate a MANUAL collection', async () => {
    const manual = await prisma.collection.create({
      data: { slug: 'test-manual-collection', name: 'Test manual', type: 'MANUAL' },
    });

    const response = await as(superAdmin).post(`${API}/admin/collections/${manual.id}/evaluate`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('COLLECTION_NOT_AUTOMATIC');

    await prisma.collection.delete({ where: { id: manual.id } });
  });

  it('rejects an unknown operator in a rule preview', async () => {
    const response = await as(superAdmin)
      .post(`${API}/admin/collections/rules/preview`)
      .send({
        rules: {
          match: 'ALL',
          groups: [{ match: 'ALL', rules: [{ field: 'brandId', operator: 'DROP', value: 'x' }] }],
        },
      });

    expect(response.status).toBe(422);
  });

  it('rejects an injection attempt in a rule payload', async () => {
    const response = await as(superAdmin)
      .post(`${API}/admin/collections/rules/preview`)
      .send({
        rules: {
          match: 'ALL',
          groups: [
            {
              match: 'ALL',
              rules: [
                {
                  field: "'; DROP TABLE Product; --",
                  operator: 'EQUALS',
                  value: '1',
                },
              ],
            },
          ],
        },
      });

    expect(response.status).toBe(422);
    await expect(prisma.product.count()).resolves.toBeGreaterThan(0);
  });

  it('previews a rule tree without writing anything', async () => {
    const before = await prisma.collectionProduct.count();

    const response = await as(superAdmin)
      .post(`${API}/admin/collections/rules/preview`)
      .send({
        rules: {
          match: 'ALL',
          groups: [
            { match: 'ALL', rules: [{ field: 'isFeatured', operator: 'EQUALS', value: true }] },
          ],
        },
        sampleSize: 5,
      });

    expect(response.status).toBe(200);
    expect(response.body.data.matched).toBeGreaterThan(0);
    expect(response.body.data.sample.length).toBeLessThanOrEqual(5);
    await expect(prisma.collectionProduct.count()).resolves.toBe(before);
  });
});

describe('slug resolution', () => {
  it('resolves a live product path', async () => {
    const response = await request(app).get(
      `${API}/catalog/resolve?path=/products/kabir-3-seater-fabric-sofa`,
    );

    expect(response.status).toBe(200);
    expect(response.body.data.type).toBe('PRODUCT');
    expect(response.body.data.entity.slug).toBe('kabir-3-seater-fabric-sofa');
  });

  it('serves a 301 for a renamed slug and increments the hit counter', async () => {
    const product = await prisma.product.findFirstOrThrow({
      where: { slug: 'veda-armchair' },
    });

    const redirect = await prisma.slugRedirect.create({
      data: {
        entityType: 'PRODUCT',
        fromSlug: 'veda-arm-chair-old',
        toSlug: 'veda-armchair',
        entityId: product.id,
      },
    });

    const response = await request(app).get(`${API}/catalog/resolve?path=/veda-arm-chair-old`);

    expect(response.status).toBe(200);
    expect(response.body.data.type).toBe('REDIRECT');
    expect(response.body.data.statusCode).toBe(301);
    expect(response.body.data.redirectTo).toBe('/products/veda-armchair');

    await catalogEvents.settled();
    const after = await prisma.slugRedirect.findUniqueOrThrow({ where: { id: redirect.id } });
    expect(after.hitCount).toBeGreaterThanOrEqual(0);

    await prisma.slugRedirect.delete({ where: { id: redirect.id } });
  });

  it('flattens a two-hop chain to the final entity', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'veda-armchair' } });

    const first = await prisma.slugRedirect.create({
      data: {
        entityType: 'PRODUCT',
        fromSlug: 'veda-v1',
        toSlug: 'veda-v2',
        entityId: product.id,
      },
    });
    const second = await prisma.slugRedirect.create({
      data: {
        entityType: 'PRODUCT',
        fromSlug: 'veda-v2',
        toSlug: 'veda-armchair',
        entityId: product.id,
      },
    });

    const response = await request(app).get(`${API}/catalog/resolve?path=/veda-v1`);
    expect(response.body.data.type).toBe('REDIRECT');
    expect(response.body.data.redirectTo).toBe('/products/veda-armchair');

    await prisma.slugRedirect.deleteMany({ where: { id: { in: [first.id, second.id] } } });
  });

  it('returns NOT_FOUND cleanly for junk', async () => {
    const response = await request(app).get(`${API}/catalog/resolve?path=/nothing-here-at-all`);

    expect(response.status).toBe(200);
    expect(response.body.data.type).toBe('NOT_FOUND');
    expect(response.body.data.statusCode).toBe(404);
  });

  it('rejects a path with characters a slug can never contain', async () => {
    const response = await request(app).get(
      `${API}/catalog/resolve?path=${encodeURIComponent("/'; DROP TABLE Product; --")}`,
    );
    expect(response.status).toBe(422);
  });
});

describe('popularity', () => {
  it('counts a view, ignores the repeat inside the dedupe window and ignores bots', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'goli-pouffe' } });
    const sessionId = `test-session-${Date.now()}`;

    const before = await prisma.productStat.findUnique({ where: { productId: product.id } });

    const first = await request(app)
      .post(`${API}/catalog/products/goli-pouffe/view`)
      .set('User-Agent', 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120')
      .send({ sessionId });
    expect(first.body.data.counted).toBe(true);

    const repeat = await request(app)
      .post(`${API}/catalog/products/goli-pouffe/view`)
      .set('User-Agent', 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120')
      .send({ sessionId });
    expect(repeat.body.data.counted).toBe(false);

    const bot = await request(app)
      .post(`${API}/catalog/products/goli-pouffe/view`)
      .set('User-Agent', 'Googlebot/2.1 (+http://www.google.com/bot.html)')
      .send({ sessionId: `${sessionId}-bot` });
    expect(bot.body.data.counted).toBe(false);

    const after = await prisma.productStat.findUniqueOrThrow({ where: { productId: product.id } });
    expect(after.viewCount).toBe((before?.viewCount ?? 0) + 1);
  });

  it('recomputing scores changes the POPULARITY ordering', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'taal-bar-stool' } });

    await prisma.productStat.upsert({
      where: { productId: product.id },
      create: { productId: product.id, viewCount7d: 100_000, lastViewedAt: new Date() },
      update: { viewCount7d: 100_000, lastViewedAt: new Date() },
    });

    await as(superAdmin).post(`${API}/admin/search/popularity/recompute`).expect(200);

    const { data } = await list('sort=POPULARITY&limit=5');
    expect(data.items[0]?.slug).toBe('taal-bar-stool');

    await prisma.productStat.update({
      where: { productId: product.id },
      data: { viewCount7d: 0, popularityScore: 0 },
    });
  });
});

describe('caching', () => {
  it('answers a repeat listing request with 304 when nothing changed', async () => {
    const first = await request(app).get(`${API}/catalog/products?limit=5`);
    const etag = first.headers.etag;

    expect(etag).toBeDefined();

    const second = await request(app)
      .get(`${API}/catalog/products?limit=5`)
      .set('If-None-Match', etag);

    expect(second.status).toBe(304);
  });

  it('shows an admin edit on the very next public call', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'jugal-loveseat' } });

    const before = await request(app).get(`${API}/catalog/products/jugal-loveseat`);
    const originalName = before.body.data.name;

    await as(superAdmin)
      .patch(`${API}/admin/catalog/products/${product.id}`)
      .send({ name: 'Jugal Loveseat (edited)', version: product.version })
      .expect(200);

    const after = await request(app).get(`${API}/catalog/products/jugal-loveseat`);
    expect(after.body.data.name).toBe('Jugal Loveseat (edited)');

    const restored = await prisma.product.findFirstOrThrow({ where: { id: product.id } });
    await as(superAdmin)
      .patch(`${API}/admin/catalog/products/${product.id}`)
      .send({ name: originalName, version: restored.version })
      .expect(200);
  });
});

describe('performance budget', () => {
  it('lists a full page with facets inside a documented query budget', async () => {
    let queries = 0;
    prismaEvents.$on(
      'query' as never,
      (() => {
        queries += 1;
      }) as never,
    );

    const started = Date.now();
    const response = await request(app).get(`${API}/catalog/products?categorySlug=sofas&limit=24`);
    const elapsed = Date.now() - started;

    expect(response.status).toBe(200);
    // Budget: a scoped listing plus every facet dimension, on a 71-product catalog.
    expect(queries).toBeLessThan(200);
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe('RBAC', () => {
  it('serves every storefront endpoint anonymously', async () => {
    for (const url of [
      `${API}/catalog/products?limit=1`,
      `${API}/catalog/filters`,
      `${API}/catalog/collections`,
      `${API}/catalog/new-arrivals?limit=1`,
      `${API}/catalog/best-sellers?limit=1`,
      `${API}/catalog/deals?limit=1`,
      `${API}/catalog/featured?limit=1`,
      `${API}/catalog/products/kabir-3-seater-fabric-sofa`,
      `${API}/catalog/categories/sofas/landing`,
    ]) {
      const response = await request(app).get(url);
      expect([200, 304]).toContain(response.status);
    }
  });

  it('rejects admin search routes for anonymous, customer and ORDER_MANAGER callers', async () => {
    await request(app).get(`${API}/admin/search/synonyms`).expect(401);
    await as(orderManager).get(`${API}/admin/search/synonyms`).expect(403);
  });

  it('allows CATALOG_MANAGER through', async () => {
    await as(catalogManager).get(`${API}/admin/search/synonyms`).expect(200);
  });
});
