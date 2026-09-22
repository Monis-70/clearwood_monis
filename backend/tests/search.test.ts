import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { search } from '../src/container';
import type {
  SearchDocumentInput,
  SearchDriver,
  SearchHealth,
  SearchQuery,
  SearchResult,
  SearchSuggestion,
} from '../src/drivers/search';
import { SqlSearchDriver } from '../src/drivers/search';
import { catalogEvents } from '../src/events/catalogEvents';
import { passwordService } from '../src/modules/auth/password.service';
import { searchIndexerService } from '../src/modules/storefront/searchIndexer.service';

/**
 * Prompt 7 — the search driver, relevance, synonyms, the index write paths and the analytics
 * that feed the synonym workflow.
 */

const app = createApp();
const API = '/api/v1';
const TEST_PASSWORD = 'Rosewood-Teak-2026';

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
      name: `Search ${roleCode}`,
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

async function searchFor(query: string): Promise<{
  slugs: string[];
  normalizedQuery: string;
  expandedTerms: string[];
  total: number;
  queryLogId: string | null;
}> {
  const response = await request(app).get(`${API}/search?q=${encodeURIComponent(query)}&limit=50`);
  expect(response.status).toBe(200);

  return {
    slugs: (response.body.data.products.items as { slug: string }[]).map((item) => item.slug),
    normalizedQuery: response.body.data.normalizedQuery,
    expandedTerms: response.body.data.expandedTerms,
    total: response.body.data.products.totalCount,
    queryLogId: response.body.data.queryLogId,
  };
}

let superAdmin: Session;

beforeAll(async () => {
  superAdmin = await admin('search.super@clearwood.local', 'SUPER_ADMIN');
});

describe('relevance', () => {
  it('ranks an exact title match above a body-only match', async () => {
    const { slugs } = await searchFor('Kabir');
    expect(slugs[0]).toBe('kabir-3-seater-fabric-sofa');
  });

  it('finds a product by its SKU', async () => {
    const { slugs } = await searchFor('CW-SOF-KABIR');
    expect(slugs[0]).toBe('kabir-3-seater-fabric-sofa');
  });

  it('finds products through the category text, ancestors included', async () => {
    const { slugs } = await searchFor('sofas');
    expect(slugs.length).toBeGreaterThan(3);
  });

  it('scores a title hit above the same word appearing only in the body', async () => {
    const result = await search.search({ q: 'recliner', entityTypes: ['PRODUCT'], limit: 20 });
    const top = result.hits[0];

    expect(top).toBeDefined();
    expect(top!.matchedFields).toContain('title');
  });
});

describe('synonyms', () => {
  it('expands a two-way entry in both directions', async () => {
    const couch = await searchFor('couch');
    const sofa = await searchFor('sofa');

    expect(couch.expandedTerms).toContain('sofa');
    expect(couch.total).toBeGreaterThan(0);
    expect(sofa.expandedTerms).toContain('couch');
  });

  it('keeps a one-way entry one-way', async () => {
    const leather = await searchFor('leather');
    expect(leather.expandedTerms).toContain('rexine');

    // `rexine` is only a synonym OF leather; it must not drag the whole leather set back in.
    const rexine = await searchFor('rexine');
    expect(rexine.expandedTerms).not.toContain('leather');
  });

  it('uses a freshly created synonym on the very next query', async () => {
    const before = await searchFor('chaarpai');
    expect(before.total).toBe(0);

    await as(superAdmin)
      .post(`${API}/admin/search/synonyms`)
      .send({ term: 'chaarpai', synonyms: ['diwan', 'daybed'], isTwoWay: true })
      .expect(201);

    const after = await searchFor('chaarpai');
    expect(after.total).toBeGreaterThan(0);

    await as(superAdmin).delete(`${API}/admin/search/synonyms/chaarpai`).expect(200);
  });

  it('rejects a duplicate term', async () => {
    const response = await as(superAdmin)
      .post(`${API}/admin/search/synonyms`)
      .send({ term: 'sofa', synonyms: ['couch'] });

    expect(response.status).toBe(409);
  });
});

describe('query hygiene', () => {
  it('refuses a query shorter than SEARCH_MIN_QUERY_LENGTH', async () => {
    const response = await request(app).get(`${API}/search?q=a`);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('SEARCH_QUERY_TOO_SHORT');
  });

  it('is inert against SQL injection in q', async () => {
    const before = await prisma.product.count();

    const response = await request(app).get(
      `${API}/search?q=${encodeURIComponent("'; DROP TABLE Product; --")}`,
    );

    expect(response.status).toBe(200);
    // Punctuation is stripped, so what reaches the parameterised query is just words.
    expect(response.body.data.normalizedQuery).toBe('drop table product');
    await expect(prisma.product.count()).resolves.toBe(before);
  });

  it('logs a zero-result query with hasResults false', async () => {
    const term = `zxqvw${Date.now()}`;
    await searchFor(term);

    const log = await prisma.searchQueryLog.findFirstOrThrow({
      where: { rawQuery: term },
      orderBy: { createdAt: 'desc' },
    });

    expect(log.hasResults).toBe(false);
    expect(log.resultCount).toBe(0);
  });

  it('records a click against the query that produced it', async () => {
    const { queryLogId } = await searchFor('sofa');
    expect(queryLogId).not.toBeNull();

    const product = await prisma.product.findFirstOrThrow({
      where: { slug: 'kabir-3-seater-fabric-sofa' },
    });

    const response = await request(app)
      .post(`${API}/search/click`)
      .send({ queryLogId, entityType: 'PRODUCT', entityId: product.id, position: 0 });

    expect(response.status).toBe(202);
    expect(response.body.data.recorded).toBe(true);

    const log = await prisma.searchQueryLog.findUniqueOrThrow({ where: { id: queryLogId! } });
    expect(log.clickedEntityId).toBe(product.id);
  });
});

describe('autocomplete', () => {
  it('suggests products for a prefix', async () => {
    const response = await request(app).get(`${API}/search/suggest?q=sof`);

    expect(response.status).toBe(200);
    const suggestions = response.body.data as { type: string; label: string }[];
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it('returns nothing below the minimum length', async () => {
    const response = await request(app).get(`${API}/search/suggest?q=s`);

    expect(response.status).toBe(200);
    expect(response.body.data).toStrictEqual([]);
  });
});

describe('the driver interface is what the API depends on', () => {
  it('serves /search through a completely fake driver', async () => {
    const fake: SearchDriver = {
      name: 'sql',
      indexOne: async (_doc: SearchDocumentInput) => true,
      indexMany: async () => 0,
      remove: async () => undefined,
      clear: async () => undefined,
      search: async (query: SearchQuery): Promise<SearchResult> => ({
        hits: [],
        total: 0,
        normalizedQuery: `fake:${query.q}`,
        expandedTerms: ['fake'],
        tookMs: 0,
      }),
      suggest: async (): Promise<SearchSuggestion[]> => [],
      health: async (): Promise<SearchHealth> => ({
        name: 'sql',
        healthy: true,
        documentCount: 0,
      }),
    };

    const container = await import('../src/container');
    const original = container.search;

    Object.defineProperty(container, 'search', { value: fake, configurable: true });

    try {
      const response = await request(app).get(`${API}/search?q=anything`);
      expect(response.status).toBe(200);
      expect(response.body.data.products.totalCount).toBe(0);
    } finally {
      Object.defineProperty(container, 'search', { value: original, configurable: true });
    }
  });

  it('reports health through the interface', async () => {
    const health = await search.health();

    expect(health.name).toBe('sql');
    expect(health.healthy).toBe(true);
    expect(health.documentCount).toBeGreaterThan(0);
  });

  it('is the SQL driver in this configuration', () => {
    expect(search).toBeInstanceOf(SqlSearchDriver);
  });
});

describe('indexing', () => {
  it('skips an unchanged document via its checksum', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'goli-pouffe' } });

    const first = await searchIndexerService.indexProduct(product.id);
    const second = await searchIndexerService.indexProduct(product.id);

    expect(second).toBe(false);
    expect(typeof first).toBe('boolean');
  });

  it('re-indexes a rename and drops the document when the product is unpublished', async () => {
    const product = await prisma.product.findFirstOrThrow({
      where: { slug: 'trikon-nesting-tables' },
    });

    const rename = await as(superAdmin)
      .patch(`${API}/admin/catalog/products/${product.id}`)
      .send({ name: 'Trikon Nesting Tables Renamed', version: product.version });
    expect(rename.status, JSON.stringify(rename.body)).toBe(200);

    await catalogEvents.settled();

    const renamed = await prisma.searchDocument.findFirstOrThrow({
      where: { entityType: 'PRODUCT', entityId: product.id },
    });
    expect(renamed.title).toBe('Trikon Nesting Tables Renamed');

    await as(superAdmin).post(`${API}/admin/catalog/products/${product.id}/unpublish`).expect(200);
    await catalogEvents.settled();

    const gone = await prisma.searchDocument.findFirst({
      where: { entityType: 'PRODUCT', entityId: product.id },
    });
    expect(gone).toBeNull();

    /*
     * Put it back the way we found it. The publish endpoint runs Prompt 5's completeness gate,
     * which seeded fixtures were never asked to satisfy, so the restore is a direct write.
     */
    await prisma.product.update({
      where: { id: product.id },
      data: { name: product.name, status: 'ACTIVE', publishedAt: product.publishedAt },
    });
    await searchIndexerService.indexProduct(product.id);
  });

  it('flips inStock when the last unit leaves', async () => {
    const variant = await prisma.productVariant.findFirstOrThrow({
      where: { product: { slug: 'jugal-loveseat' }, stockQty: { gt: 0 } },
      include: { product: true },
    });

    const before = await prisma.searchDocument.findFirstOrThrow({
      where: { entityType: 'PRODUCT', entityId: variant.productId },
    });
    expect(before.inStock).toBe(true);

    await as(superAdmin)
      .post(`${API}/admin/catalog/variants/${variant.id}/inventory/adjust`)
      .send({ absolute: 0, reason: 'CORRECTION' })
      .expect(200);

    await catalogEvents.settled();

    const after = await prisma.searchDocument.findFirstOrThrow({
      where: { entityType: 'PRODUCT', entityId: variant.productId },
    });
    expect(after.inStock).toBe(false);

    await as(superAdmin)
      .post(`${API}/admin/catalog/variants/${variant.id}/inventory/adjust`)
      .send({ absolute: variant.stockQty, reason: 'CORRECTION' })
      .expect(200);
    await catalogEvents.settled();
  });

  it('updates the indexed price range when a price adjustment changes', async () => {
    const product = await prisma.product.findFirstOrThrow({
      where: { slug: 'veda-armchair' },
    });

    const before = await prisma.searchDocument.findFirstOrThrow({
      where: { entityType: 'PRODUCT', entityId: product.id },
    });

    const adjustment = await prisma.priceAdjustment.create({
      data: {
        name: 'Test index discount',
        scope: 'PRODUCT',
        adjustmentType: 'FIXED_AMOUNT',
        basis: 'BASE',
        priority: 5,
        valuePaise: -100_000,
        productId: product.id,
      },
    });

    await searchIndexerService.indexProduct(product.id);

    const after = await prisma.searchDocument.findFirstOrThrow({
      where: { entityType: 'PRODUCT', entityId: product.id },
    });
    expect(after.minPricePaise).toBe((before.minPricePaise ?? 0) - 100_000);

    await prisma.priceAdjustment.delete({ where: { id: adjustment.id } });
    await searchIndexerService.indexProduct(product.id);
  });

  it('indexes a price range that agrees with the pricing engine', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'goli-pouffe' } });

    const document = await prisma.searchDocument.findFirstOrThrow({
      where: { entityType: 'PRODUCT', entityId: product.id },
    });

    const variants = await prisma.productVariant.findMany({
      where: { productId: product.id, deletedAt: null, isActive: true },
    });

    const quote = await request(app)
      .post(`${API}/pricing/quote`)
      .send({
        items: variants.map((variant) => ({
          productId: product.id,
          variantId: variant.id,
          qty: 1,
        })),
      })
      .expect(200);

    const unitPrices = (quote.body.data.lines as { unitPricePaise: number }[]).map(
      (line) => line.unitPricePaise,
    );

    expect(document.minPricePaise).toBe(Math.min(...unitPrices));
    expect(document.maxPricePaise).toBe(Math.max(...unitPrices));
  });

  it('reindexes idempotently', async () => {
    const first = await searchIndexerService.reindexAll('PRODUCT');
    const second = await searchIndexerService.reindexAll('PRODUCT');

    expect(first.processed).toBe(second.processed);
    expect(second.written).toBe(0);
    expect(second.failed).toBe(0);
  });
});

describe('admin search management', () => {
  it('runs a reindex job and reports its progress', async () => {
    const response = await as(superAdmin).post(`${API}/admin/search/reindex?entityType=BRAND`);

    expect(response.status).toBe(202);
    expect(response.body.data.status).toBe('COMPLETED');

    const job = await as(superAdmin).get(`${API}/admin/search/jobs/${response.body.data.id}`);
    expect(job.status).toBe(200);
    expect(job.body.data.entityType).toBe('BRAND');
  });

  it('reports top queries, zero-result queries and a CTR', async () => {
    await searchFor('sofa');
    await searchFor(`nothinglikethis${Date.now()}`);

    const response = await as(superAdmin).get(`${API}/admin/search/analytics?days=30&limit=10`);

    expect(response.status).toBe(200);
    expect(response.body.data.topQueries.length).toBeGreaterThan(0);
    expect(response.body.data.zeroResultQueries.length).toBeGreaterThan(0);
    expect(response.body.data.totals.searches).toBeGreaterThan(0);
    expect(response.body.data.trend.length).toBeGreaterThan(0);
  });

  it('shows what was indexed for one product', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'goli-pouffe' } });
    const response = await as(superAdmin).get(
      `${API}/admin/catalog/products/${product.id}/search-document`,
    );

    expect(response.status).toBe(200);
    expect(response.body.data.stored.title).toBe(product.name);

    // G1: two null/empty checksums also match, which would prove nothing about the rebuild.
    expect(response.body.data.stored.checksum).toMatch(/^[0-9a-f]{16,}$/);
    expect(response.body.data.rebuilt.checksum).toBe(response.body.data.stored.checksum);
  });
});
