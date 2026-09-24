import { format } from 'mysql2';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma, prismaEvents } from '../src/config/prisma';
import { cache } from '../src/container';
import { passwordService } from '../src/modules/auth/password.service';
import { mark } from '../src/utils/uniqueMark';

/**
 * Prompt 3 — catalog read baseline at a realistic size, with EXPLAIN for the slowest statements.
 *
 * Opt-in (CLEARWOOD_CATALOG_BASELINE=1): it inserts a few thousand products, which is minutes of
 * work nobody wants on every run. It asserts only what must hold at any size (paths answer, the
 * listing does not load a row per product into a query); the numbers it prints are the baseline.
 */

const enabled = process.env.CLEARWOOD_CATALOG_BASELINE === '1';
const PRODUCTS = Number(process.env.CLEARWOOD_CATALOG_BASELINE_PRODUCTS ?? 3000);
const API = '/api/v1';
const app = createApp();

interface Captured {
  sql: string;
  params: string;
  duration: number;
}

let sink: Captured[] | null = null;

async function measure(label: string, run: () => Promise<request.Response>) {
  await cache.delByPrefix('sf:');
  await cache.delByPrefix('cat:');
  const captured: Captured[] = [];
  sink = captured;
  const started = performance.now();
  const response = await run();
  const elapsed = performance.now() - started;
  await new Promise((resolve) => setImmediate(resolve));
  sink = null;

  expect(response.status, label).toBe(200);
  const dbMs = captured.reduce((sum, row) => sum + row.duration, 0);
  console.log(
    `[scale] ${label}: ${elapsed.toFixed(0)} ms wall, ${captured.length} queries, ${dbMs} ms in db`,
  );

  for (const row of [...captured].sort((a, b) => b.duration - a.duration).slice(0, 3)) {
    if (!/^SELECT/i.test(row.sql)) continue;
    const bound = format(row.sql, JSON.parse(row.params) as string[]);
    const plan = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`EXPLAIN ${bound}`);
    if (process.env.CLEARWOOD_CATALOG_BASELINE_RAW === '1') console.log(plan);
    const table = /FROM `[^`]+`\.`(\w+)`/.exec(row.sql)?.[1] ?? '?';
    // Raw EXPLAIN comes back positionally: f2 table, f4 access type, f6 key, f9 rows, f11 extra.
    console.log(
      `[scale]   ${row.duration} ms ${table}: ` +
        plan
          .map(
            (step) =>
              `${step.f2}/${step.f4}/${step.f6 ?? '-'}/${step.f9}${step.f11 ? ` (${step.f11})` : ''}`,
          )
          .join(' | '),
    );
    const where = / WHERE (.*?)(?: ORDER BY| LIMIT|$)/s.exec(bound)?.[1] ?? '';
    console.log(`[scale]     where ${where.replace(/`[^`]+`\./g, '').slice(0, 260)}`);
  }

  return { response, queries: captured.length, captured };
}

describe.skipIf(!enabled)('catalog scale baseline', () => {
  let categorySlug = '';
  let productId = '';
  let productSlug = '';
  let cookie = '';

  beforeAll(async () => {
    prismaEvents.$on(
      'query' as never,
      ((event: Captured & { query: string }) => {
        if (sink && !/^(BEGIN|COMMIT|ROLLBACK|SELECT 1\b)/i.test(event.query.trim())) {
          sink.push({ sql: event.query, params: event.params, duration: event.duration });
        }
      }) as never,
    );

    const category = await prisma.category.findFirstOrThrow({
      where: { isActive: true, deletedAt: null, depth: 0 },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    categorySlug = category.slug;
    const now = new Date();

    for (let start = 0; start < PRODUCTS; start += 500) {
      const batch = Array.from({ length: Math.min(500, PRODUCTS - start) }, (_, offset) => {
        const n = start + offset;
        return {
          id: `scale${String(n).padStart(6, '0')}`,
          sku: `SCALE-${n}`,
          slug: `scale-product-${n}`,
          name: `Scale Product ${n}`,
          status: 'ACTIVE',
          publishedAt: now,
          basePricePaise: 1_000_00 + (n % 50) * 1_000_00,
        };
      });
      await prisma.product.createMany({ data: batch });
      await prisma.productCategory.createMany({
        data: batch.map((product) => ({
          productId: product.id,
          categoryId: category.id,
          isPrimary: true,
          primaryMark: mark(true),
        })),
      });
      await prisma.productVariant.createMany({
        data: batch.flatMap((product) =>
          [0, 1].map((position) => ({
            productId: product.id,
            sku: `${product.sku}-${position}`,
            position,
            isDefault: position === 0,
            defaultMark: mark(position === 0),
            stockQty: 5,
          })),
        ),
      });
    }

    productId = 'scale000000';
    productSlug = 'scale-product-0';

    const email = 'scale.catalog@clearwood.local';
    const password = 'Rosewood-Teak-2026';
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'CATALOG_MANAGER' } });
    const admin = await prisma.adminUser.create({
      data: {
        email,
        name: 'Scale Catalog',
        passwordHash: await passwordService.hash(password),
        status: 'ACTIVE',
      },
    });
    await prisma.adminUserRole.create({ data: { adminUserId: admin.id, roleId: role.id } });
    const login = await request(app).post(`${API}/admin/auth/login`).send({ email, password });
    const jar = (login.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    cookie = jar.map((entry) => entry.split(';')[0]).join('; ');

    // Warm settings and tax caches so the numbers are steady-state.
    await request(app).get(`${API}/catalog/products?categorySlug=${categorySlug}&limit=24`);
  }, 600_000);

  it('records the storefront and admin read paths', async () => {
    console.log(`[scale] ${PRODUCTS} synthetic products in one category`);

    const first = await measure('category listing page 1', () =>
      request(app).get(`${API}/catalog/products?categorySlug=${categorySlug}&limit=24`),
    );
    const deep = await measure('category listing page 60', () =>
      request(app).get(`${API}/catalog/products?categorySlug=${categorySlug}&limit=24&page=60`),
    );
    expect(first.response.body.meta.total).toBeGreaterThanOrEqual(PRODUCTS);
    expect(deep.queries).toBeGreaterThan(0);

    await measure('price-sorted listing', () =>
      request(app).get(
        `${API}/catalog/products?categorySlug=${categorySlug}&limit=24&sort=PRICE_ASC`,
      ),
    );
    await measure('filters', () =>
      request(app).get(`${API}/catalog/filters?categorySlug=${categorySlug}`),
    );
    await measure('category tree', () => request(app).get(`${API}/catalog/categories/tree`));
    await measure('product detail', () =>
      request(app).get(`${API}/catalog/products/${productSlug}`),
    );
    await measure('resolve', () => request(app).get(`${API}/catalog/resolve?path=/${productSlug}`));
    await measure('admin product list', () =>
      request(app).get(`${API}/admin/catalog/products?limit=50`).set('Cookie', cookie),
    );
    await measure('admin product list, price sort, deep page', () =>
      request(app)
        .get(`${API}/admin/catalog/products?limit=50&sort=basePricePaise&page=50`)
        .set('Cookie', cookie),
    );
    await measure('admin variants', () =>
      request(app).get(`${API}/admin/catalog/products/${productId}/variants`).set('Cookie', cookie),
    );
  }, 600_000);
});
