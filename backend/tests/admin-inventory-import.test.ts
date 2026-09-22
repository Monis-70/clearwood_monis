import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import {
  csvToPaise,
  escapeCsvValue,
  paiseToCsv,
} from '../src/modules/catalog-admin/import-export/csv';
import { inventoryService } from '../src/modules/catalog-admin/inventory.service';
import { passwordService } from '../src/modules/auth/password.service';

import { expectNoInfrastructureFailures, runConcurrently } from './helpers/concurrency';

/**
 * Prompt 5 — the stock ledger (including concurrency and reservation invariants) and CSV
 * import/export (including formula-injection escaping and money parsing).
 */

const app = createApp();
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
      name: `Inventory ${roleCode}`,
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
  };
}

let superAdmin: Session;
let contentManager: Session;

/** Every fixture this file creates lives under here and is removed again afterwards. */
let hostProductId: string;
const createdCategorySlugs: string[] = [];
const createdProductSkus: string[] = [];

beforeAll(async () => {
  superAdmin = await admin('inventory.super@clearwood.local', 'SUPER_ADMIN');
  contentManager = await admin('inventory.content@clearwood.local', 'CONTENT_MANAGER');

  const host = await prisma.product.create({
    data: {
      sku: `TEST-HOST-${Date.now()}`,
      slug: `test-host-${Date.now()}`,
      name: 'Inventory Test Host',
      status: 'DRAFT',
    },
    select: { id: true },
  });
  hostProductId = host.id;
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { id: hostProductId } });
  await prisma.product.deleteMany({ where: { sku: { in: createdProductSkus } } });
  await prisma.category.deleteMany({ where: { slug: { in: createdCategorySlugs } } });
  await prisma.importJob.deleteMany({ where: { fileName: { contains: '.csv' } } });
});

async function freshVariant(overrides: { allowBackorder?: boolean } = {}) {
  return prisma.productVariant.create({
    data: {
      productId: hostProductId,
      sku: `TEST-VAR-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
      stockQty: 0,
      stockStatus: 'OUT_OF_STOCK',
      allowBackorder: overrides.allowBackorder ?? false,
    },
  });
}

describe('inventory ledger', () => {
  it('writes the ledger and the balance in one transaction', async () => {
    const variant = await freshVariant();

    const { snapshot, entry } = await inventoryService.adjust(variant.id, {
      delta: 10,
      reason: 'PURCHASE',
    });

    expect(snapshot.stockQty).toBe(10);
    expect(entry.delta).toBe(10);
    expect(entry.balanceAfter).toBe(10);
    expect(
      (await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } })).stockQty,
    ).toBe(10);
  });

  it('keeps balanceAfter equal to the running sum of deltas', async () => {
    const variant = await freshVariant();

    for (const delta of [5, 3, -2, 7, -1]) {
      await inventoryService.adjust(variant.id, { delta, reason: 'CORRECTION' });
    }

    const entries = await prisma.inventoryLedger.findMany({
      where: { variantId: variant.id },
      orderBy: { createdAt: 'asc' },
    });

    let running = 0;
    for (const entry of entries) {
      running += entry.delta;
      expect(entry.balanceAfter).toBe(running);
    }
    expect(running).toBe(12);
  });

  it('blocks negative stock unless the variant allows backorders', async () => {
    const strict = await freshVariant();
    await inventoryService.adjust(strict.id, { delta: 2, reason: 'PURCHASE' });

    await expect(
      inventoryService.adjust(strict.id, { delta: -5, reason: 'DAMAGE' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    const relaxed = await freshVariant({ allowBackorder: true });
    const { snapshot } = await inventoryService.adjust(relaxed.id, {
      delta: -3,
      reason: 'CORRECTION',
    });
    expect(snapshot.stockQty).toBe(-3);
  });

  it('refuses a write whose expected balance no longer matches', async () => {
    const variant = await freshVariant();
    await inventoryService.adjust(variant.id, { delta: 4, reason: 'PURCHASE' });

    await expect(
      inventoryService.adjust(variant.id, { delta: 1, expectedBalance: 99 }),
    ).rejects.toMatchObject({ code: 'INVENTORY_CONFLICT' });
  });

  it('never loses an update when two adjustments run at the same time', async () => {
    const variant = await freshVariant();
    await inventoryService.adjust(variant.id, { delta: 100, reason: 'INITIAL_STOCK' });

    // Ten concurrent -1 adjustments: with a read-then-write this would lose several.
    const result = await runConcurrently(10, () =>
      inventoryService.adjust(variant.id, { delta: -1, reason: 'CORRECTION' }),
    );

    expectNoInfrastructureFailures(result);
    console.log(`[concurrency] inventory 10x-1: ${JSON.stringify(result.outcomes)}`);

    expect(result.ok, 'an adjustment was rejected; stock writes must queue, not race').toBe(10);
    expect(result.contended).toBe(0);

    const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(after.stockQty).toBe(90);

    const entries = await prisma.inventoryLedger.findMany({ where: { variantId: variant.id } });
    expect(entries).toHaveLength(11);
    expect(entries.reduce((sum, entry) => sum + entry.delta, 0)).toBe(90);

    // Every balanceAfter is distinct, which is only possible if the writes serialised.
    const balances = entries.map((entry) => entry.balanceAfter).sort((a, b) => a - b);
    expect(new Set(balances).size).toBe(balances.length);
  });

  it('recomputes the stock status from the threshold', async () => {
    const variant = await prisma.productVariant.update({
      where: { id: (await freshVariant()).id },
      data: { lowStockThreshold: 3 },
    });

    await inventoryService.adjust(variant.id, { delta: 2, reason: 'PURCHASE' });
    expect(
      (await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } })).stockStatus,
    ).toBe('LOW_STOCK');

    await inventoryService.adjust(variant.id, { delta: 20, reason: 'PURCHASE' });
    expect(
      (await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } })).stockStatus,
    ).toBe('IN_STOCK');
  });
});

describe('reservations', () => {
  it('reserves only what is available and never exceeds stock', async () => {
    const variant = await freshVariant();
    await inventoryService.adjust(variant.id, { delta: 5, reason: 'PURCHASE' });

    expect(await inventoryService.reserve(variant.id, 3)).toBe(3);

    await expect(inventoryService.reserve(variant.id, 3)).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });

    const snapshot = await inventoryService.snapshot(variant.id);
    expect(snapshot.reservedQty).toBe(3);
    expect(snapshot.availableQty).toBe(2);
    expect(snapshot.reservedQty).toBeLessThanOrEqual(snapshot.stockQty);
  });

  it('allows reserving beyond stock only when backorders are enabled', async () => {
    const variant = await freshVariant({ allowBackorder: true });
    await inventoryService.adjust(variant.id, { delta: 1, reason: 'PURCHASE' });

    expect(await inventoryService.reserve(variant.id, 4)).toBe(4);
    expect((await inventoryService.snapshot(variant.id)).reservedQty).toBe(4);
  });

  it('release is idempotent and can never release more than is reserved', async () => {
    const variant = await freshVariant();
    await inventoryService.adjust(variant.id, { delta: 10, reason: 'PURCHASE' });
    await inventoryService.reserve(variant.id, 4);

    expect(await inventoryService.release(variant.id, 10)).toBe(4);
    expect((await inventoryService.snapshot(variant.id)).reservedQty).toBe(0);

    // Repeating it is a harmless no-op rather than a negative reservation.
    expect(await inventoryService.release(variant.id, 4)).toBe(0);
    expect((await inventoryService.snapshot(variant.id)).reservedQty).toBe(0);
  });

  it('refuses to drop stock below what is reserved', async () => {
    const variant = await freshVariant();
    await inventoryService.adjust(variant.id, { delta: 6, reason: 'PURCHASE' });
    await inventoryService.reserve(variant.id, 5);

    await expect(
      inventoryService.adjust(variant.id, { absolute: 2, reason: 'CORRECTION' }),
    ).rejects.toMatchObject({ code: 'STOCK_BELOW_RESERVED' });
  });

  it('adjusts through the API and audits it', async () => {
    const variant = await freshVariant();

    const response = await request(app)
      .post(`/api/v1/admin/catalog/variants/${variant.id}/inventory/adjust`)
      .set('Cookie', superAdmin.header)
      .set('X-CSRF-Token', superAdmin.csrf)
      .send({ delta: 12, reason: 'PURCHASE', note: 'Container arrived' });

    expect(response.status).toBe(200);
    expect(response.body.data.snapshot.stockQty).toBe(12);
    expect(response.body.data.entry.balanceAfter).toBe(12);

    const history = await request(app)
      .get(`/api/v1/admin/catalog/variants/${variant.id}/inventory`)
      .set('Cookie', superAdmin.header);

    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(1);
  });
});

describe('CSV safety', () => {
  it('neutralises formula injection', () => {
    expect(escapeCsvValue('=HYPERLINK("http://evil","click")')).toBe(
      `"'=HYPERLINK(""http://evil"",""click"")"`,
    );
    expect(escapeCsvValue('+1-800-SCAM')).toBe("'+1-800-SCAM");
    expect(escapeCsvValue('-2+3')).toBe("'-2+3");
    expect(escapeCsvValue('@SUM(A1)')).toBe("'@SUM(A1)");

    // Ordinary values are untouched.
    expect(escapeCsvValue('Teak Sideboard')).toBe('Teak Sideboard');
    expect(escapeCsvValue('Sofa, 3 seater')).toBe('"Sofa, 3 seater"');
  });

  it('round-trips money and rejects more than two decimals', () => {
    expect(paiseToCsv(1_299_950)).toBe('12999.50');
    expect(csvToPaise('12,999.50')).toBe(1_299_950);
    expect(csvToPaise('₹ 1200')).toBe(120_000);
    expect(csvToPaise('')).toBeNull();
    expect(() => csvToPaise('12.345')).toThrow(/two decimal places/);
    expect(() => csvToPaise('abc')).toThrow();
  });
});

describe('import / export', () => {
  function post(session: Session, url: string) {
    return request(app).post(url).set('Cookie', session.header).set('X-CSRF-Token', session.csrf);
  }

  it('exports products as CSV with a stable header', async () => {
    const response = await request(app)
      .get('/api/v1/admin/catalog/export/PRODUCT?limit=5')
      .set('Cookie', superAdmin.header);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');

    const [header] = response.text.replace('\uFEFF', '').split('\r\n');
    expect(header).toContain('sku');
    expect(header).toContain('basePriceRupees');
  });

  it('a dry run reports errors and writes nothing', async () => {
    const before = await prisma.category.count();

    const csv = [
      'slug,name,parentSlug,kind,position,isActive,showInMenu,shortDescription,seoTitle,seoDescription',
      'import-test-one,Import Test One,,STANDARD,0,true,true,,,',
      'import-test-two,Import Test Two,does-not-exist,STANDARD,0,true,true,,,',
    ].join('\n');

    const response = await post(superAdmin, '/api/v1/admin/catalog/import/CATEGORY')
      .field('dryRun', 'true')
      .attach('files', Buffer.from(csv), 'categories.csv');

    expect(response.status).toBe(201);
    expect(response.body.data.dryRun).toBe(true);
    expect(response.body.data.status).toBe('FAILED_VALIDATION');

    const errors = response.body.data.errors as {
      row: number;
      column: string | null;
      message: string;
    }[];

    expect(errors).toContainEqual(expect.objectContaining({ row: 3, column: 'parentSlug' }));
    // The valid row in the same chunk is reported as rolled back rather than silently applied.
    expect(errors).toContainEqual(expect.objectContaining({ row: 2, column: null }));

    expect(await prisma.category.count()).toBe(before);
  });

  it('commits a valid file and is idempotent on re-run', async () => {
    const slug = `import-ok-${Date.now()}`;
    createdCategorySlugs.push(slug);
    const csv = [
      'slug,name,parentSlug,kind,position,isActive,showInMenu,shortDescription,seoTitle,seoDescription',
      `${slug},Imported Category,,STANDARD,0,true,true,,,`,
    ].join('\n');

    const dryRun = await post(superAdmin, '/api/v1/admin/catalog/import/CATEGORY')
      .field('dryRun', 'true')
      .attach('files', Buffer.from(csv), 'categories.csv');

    expect(dryRun.body.data.status).toBe('VALIDATED');
    expect(await prisma.category.count({ where: { slug } })).toBe(0);

    const commit = await post(
      superAdmin,
      `/api/v1/admin/catalog/import/jobs/${dryRun.body.data.id}/commit`,
    ).attach('files', Buffer.from(csv), 'categories.csv');

    expect(commit.status).toBe(200);
    expect(commit.body.data.status).toBe('COMPLETED');
    expect(await prisma.category.count({ where: { slug } })).toBe(1);

    const again = await post(
      superAdmin,
      `/api/v1/admin/catalog/import/jobs/${dryRun.body.data.id}/commit`,
    ).attach('files', Buffer.from(csv), 'categories.csv');

    expect(again.status).toBe(200);
    expect(await prisma.category.count({ where: { slug } })).toBe(1);
  });

  it('parses rupee amounts into paise on import', async () => {
    const sku = `IMP-${Date.now()}`;
    createdProductSkus.push(sku);
    const csv = [
      'sku,slug,name,productType,status,visibility,brandSlug,taxClassCode,basePriceRupees,compareAtPriceRupees,primaryCategorySlug,categorySlugs,shortDescription,description,warrantyMonths,weightGrams,lengthMm,widthMm,heightMm,seoTitle,seoDescription,searchKeywords',
      `${sku},,Imported Money Test,SIMPLE,DRAFT,PUBLIC,,,"12,999.50",,,,,,,,,,,,,`,
    ].join('\n');

    const dryRun = await post(superAdmin, '/api/v1/admin/catalog/import/PRODUCT')
      .field('dryRun', 'true')
      .attach('files', Buffer.from(csv), 'products.csv');

    expect(dryRun.body.data.status).toBe('VALIDATED');

    await post(superAdmin, `/api/v1/admin/catalog/import/jobs/${dryRun.body.data.id}/commit`)
      .attach('files', Buffer.from(csv), 'products.csv')
      .expect(200);

    const imported = await prisma.product.findFirstOrThrow({ where: { sku } });
    expect(imported.basePricePaise).toBe(1_299_950);
    // Imports never publish.
    expect(imported.status).toBe('DRAFT');
  });

  it('requires the entity-specific permission', async () => {
    const csv = [
      'variantSku,stockQty,reservedQty,lowStockThreshold,allowBackorder',
      'X,1,0,0,false',
    ].join('\n');

    // CONTENT_MANAGER can manage media and pages but owns no inventory permission.
    const response = await post(contentManager, '/api/v1/admin/catalog/import/INVENTORY')
      .field('dryRun', 'true')
      .attach('files', Buffer.from(csv), 'inventory.csv');

    expect(response.status).toBe(403);
  });

  it('moves imported stock through the ledger', async () => {
    const variant = await freshVariant();
    const csv = [
      'variantSku,stockQty,reservedQty,lowStockThreshold,allowBackorder',
      `${variant.sku},25,0,0,false`,
    ].join('\n');

    const dryRun = await post(superAdmin, '/api/v1/admin/catalog/import/INVENTORY')
      .field('dryRun', 'true')
      .attach('files', Buffer.from(csv), 'inventory.csv');

    expect(dryRun.body.data.status).toBe('VALIDATED');
    expect(
      (await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } })).stockQty,
    ).toBe(0);

    await post(superAdmin, `/api/v1/admin/catalog/import/jobs/${dryRun.body.data.id}/commit`)
      .attach('files', Buffer.from(csv), 'inventory.csv')
      .expect(200);

    expect(
      (await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } })).stockQty,
    ).toBe(25);
    expect(await prisma.inventoryLedger.count({ where: { variantId: variant.id } })).toBe(1);
  });
});
