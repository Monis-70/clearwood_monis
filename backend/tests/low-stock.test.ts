import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { passwordService } from '../src/modules/auth/password.service';
import { inventoryService } from '../src/modules/catalog-admin/inventory.service';

import { countQueries } from './helpers/queryCounter';
import { setStockForVariant } from './helpers/stock';

/**
 * The low-stock report lists stock RISK: an active, non-deleted variant whose stock is at or below
 * its threshold. Made-to-order products are built per order (stockStatusFor answers MADE_TO_ORDER
 * for them whatever the count), so they are never a stock risk. Filtering and paging happen in SQL.
 */

const app = createApp();
const TEST_PASSWORD = 'Rosewood-Teak-2026';
const RUN = `LS${Date.now().toString(36).toUpperCase()}`;
const productIds: string[] = [];

async function product(name: string, isMadeToOrder: boolean): Promise<string> {
  const row = await prisma.product.create({
    data: {
      sku: `${RUN}-${name}`,
      slug: `${RUN}-${name}`.toLowerCase(),
      name: `${RUN} ${name}`,
      status: 'ACTIVE',
      isMadeToOrder,
    },
    select: { id: true },
  });
  productIds.push(row.id);
  return row.id;
}

/** Variants start at zero stock; any other balance is set through the ledgered inventory path. */
async function variant(
  productId: string,
  code: string,
  { stock, ...fields }: { stock: number; lowStockThreshold: number; allowBackorder?: boolean },
  state: { isActive?: boolean; deletedAt?: Date } = {},
): Promise<void> {
  const row = await prisma.productVariant.create({
    data: { productId, sku: `${RUN}-${code}`, name: `Variant ${code}`, ...fields },
  });
  if (stock !== 0) await setStockForVariant(row.id, stock);
  if (state.isActive !== undefined || state.deletedAt) {
    await prisma.productVariant.update({ where: { id: row.id }, data: state });
  }
}

const query = (extra: Record<string, unknown> = {}) =>
  ({ page: 1, limit: 100, includeBackorder: false, ...extra }) as Parameters<
    typeof inventoryService.lowStock
  >[0];

const ours = (items: { sku: string }[]) =>
  items
    .filter((item) => item.sku.startsWith(`${RUN}-`))
    .map((item) => item.sku.slice(RUN.length + 1))
    .sort();

beforeAll(async () => {
  const stocked = await product('STOCKED', false);
  await variant(stocked, 'LOW', { stock: 1, lowStockThreshold: 3 });
  await variant(stocked, 'AT', { stock: 3, lowStockThreshold: 3 });
  await variant(stocked, 'OK', { stock: 5, lowStockThreshold: 3 });
  await variant(stocked, 'OUT', { stock: 0, lowStockThreshold: 0 });
  await variant(stocked, 'BACK', { stock: 0, lowStockThreshold: 2, allowBackorder: true });
  await variant(stocked, 'OFF', { stock: 0, lowStockThreshold: 2 }, { isActive: false });
  await variant(stocked, 'GONE', { stock: 0, lowStockThreshold: 2 }, { deletedAt: new Date() });

  const madeToOrder = await product('MTO', true);
  await variant(madeToOrder, 'MTO', { stock: 0, lowStockThreshold: 2 });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
});

describe('inventory low-stock report', () => {
  it('lists stocked variants at or below their own threshold, and nothing made to order', async () => {
    const page = await inventoryService.lowStock(query());
    expect(ours(page.items)).toEqual(['AT', 'LOW', 'OUT']);
    expect(page.items.every((item) => item.stockStatus !== 'MADE_TO_ORDER')).toBe(true);
  });

  it('includes backorderable variants only when asked', async () => {
    const page = await inventoryService.lowStock(query({ includeBackorder: true }));
    expect(ours(page.items)).toEqual(['AT', 'BACK', 'LOW', 'OUT']);
  });

  it('applies an explicit threshold instead of each variant threshold', async () => {
    const page = await inventoryService.lowStock(query({ threshold: 1 }));
    expect(ours(page.items)).toEqual(['LOW', 'OUT']);
  });

  it('names the product and variant on every row', async () => {
    const page = await inventoryService.lowStock(query());
    const low = page.items.find((item) => item.sku === `${RUN}-LOW`);
    expect(low).toMatchObject({
      productId: productIds[0],
      productName: `${RUN} STOCKED`,
      variantName: 'Variant LOW',
      stockQty: 1,
      lowStockThreshold: 3,
    });
  });

  it('pages in the database: total counts every match and pages do not overlap', async () => {
    const all = await inventoryService.lowStock(query());
    expect(all.total).toBe(all.items.length);

    const first = await inventoryService.lowStock(query({ limit: 2, page: 1 }));
    const second = await inventoryService.lowStock(query({ limit: 2, page: 2 }));
    expect(first.total).toBe(all.total);
    expect([...first.items, ...second.items].map((i) => i.variantId)).toEqual(
      all.items.slice(0, 4).map((i) => i.variantId),
    );
  });

  it('costs the same number of queries for a small and a large page (no per-row lookups)', async () => {
    const small = await countQueries(() => inventoryService.lowStock(query({ limit: 2 })));
    const large = await countQueries(() => inventoryService.lowStock(query({ limit: 100 })));
    expect(large.result.items.length).toBeGreaterThan(small.result.items.length);
    expect(large.count).toBe(small.count);
  });

  it('serves the same rows over the admin API', async () => {
    const email = `${RUN.toLowerCase()}@clearwood.local`;
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'ORDER_MANAGER' } });
    await prisma.adminUser.create({
      data: {
        email,
        name: 'Low stock reader',
        passwordHash: await passwordService.hash(TEST_PASSWORD),
        status: 'ACTIVE',
        roles: { create: { roleId: role.id } },
      },
    });
    const login = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email, password: TEST_PASSWORD });
    const raw = login.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [raw ?? '']).map((c) => c.split(';')[0]).join('; ');

    const res = await request(app)
      .get('/api/v1/admin/catalog/inventory/low-stock?limit=100')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(ours(res.body.data)).toEqual(['AT', 'LOW', 'OUT']);
    expect(res.body.data[0]).toHaveProperty('productName');
  });
});
