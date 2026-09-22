import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { couponRedemptionService } from '../src/modules/pricing/coupon.redemption.service';
import { passwordService } from '../src/modules/auth/password.service';

import { expectNoInfrastructureFailures, runConcurrently } from './helpers/concurrency';

/**
 * Prompt 6 — the pricing API, coupon lifecycle, GST, shipping, RBAC and cache invalidation.
 * Hermetic: anything mutated here is created by the test, never a seeded fixture.
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
      name: `Pricing ${roleCode}`,
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

let superAdmin: Session;
let catalogManager: Session;
let contentManager: Session;
let demoSlug: string;
let demoProductId: string;

beforeAll(async () => {
  superAdmin = await admin('pricing.super@clearwood.local', 'SUPER_ADMIN');
  catalogManager = await admin('pricing.catalog@clearwood.local', 'CATALOG_MANAGER');
  contentManager = await admin('pricing.content@clearwood.local', 'CONTENT_MANAGER');

  const product = await prisma.product.findFirstOrThrow({
    where: { slug: 'kabir-3-seater-fabric-sofa' },
  });
  demoSlug = product.slug;
  demoProductId = product.id;
});

describe('public price endpoints', () => {
  it('prices a product and the components sum to the grand total', async () => {
    const response = await request(app).get(`/api/v1/catalog/products/${demoSlug}/price?qty=1`);

    expect(response.status).toBe(200);
    const breakdown = response.body.data;

    expect(breakdown.currency).toBe('INR');
    expect(breakdown.lines).toHaveLength(1);
    expect(breakdown.contextHash).toHaveLength(64);

    const lineTotals = breakdown.lines.reduce(
      (total: number, line: { totalPaise: number }) => total + line.totalPaise,
      0,
    );
    const cartTotal = breakdown.components.reduce(
      (total: number, component: { amountPaise: number }) => total + component.amountPaise,
      0,
    );
    expect(lineTotals + cartTotal).toBe(breakdown.grandTotalPaise);
  });

  it('applies the seeded quantity break at qty 5', async () => {
    const [single, five] = await Promise.all([
      request(app).get(`/api/v1/catalog/products/${demoSlug}/price?qty=1`),
      request(app).get(`/api/v1/catalog/products/${demoSlug}/price?qty=5`),
    ]);

    expect(five.body.data.lines[0].unitPricePaise).toBeLessThan(
      single.body.data.lines[0].unitPricePaise,
    );
  });

  it('prices a multi-line cart', async () => {
    const other = await prisma.product.findFirstOrThrow({
      where: { deletedAt: null, slug: { not: demoSlug } },
    });

    const response = await request(app)
      .post('/api/v1/pricing/quote')
      .send({
        items: [
          { slug: demoSlug, qty: 2 },
          { productId: other.id, qty: 1 },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.data.lines).toHaveLength(2);
  });

  it('rejects more items than PRICING_MAX_QUOTE_ITEMS allows', async () => {
    const items = Array.from({ length: 60 }, () => ({ slug: demoSlug, qty: 1 }));
    const response = await request(app).post('/api/v1/pricing/quote').send({ items });

    expect(response.status).toBe(422);
  });

  it('404s for an unknown product', async () => {
    const response = await request(app).get('/api/v1/catalog/products/not-a-product/price');
    expect(response.status).toBe(404);
  });
});

describe('shipping serviceability', () => {
  it('matches an exact pincode before a range or the default zone', async () => {
    const response = await request(app).get('/api/v1/shipping/serviceability/400001');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      pincode: '400001',
      isServiceable: true,
      matchedBy: 'PINCODE',
      zoneCode: 'METRO',
    });
    expect(response.body.data.etaMinDays).toBeGreaterThan(0);
  });

  it('falls back to a range, then to the default zone', async () => {
    const inRange = await request(app).get('/api/v1/shipping/serviceability/400099');
    expect(inRange.body.data.matchedBy).toBe('RANGE');

    const unknown = await request(app).get('/api/v1/shipping/serviceability/999999');
    expect(unknown.body.data.matchedBy).toBe('DEFAULT');
  });

  it('rejects a malformed pincode with 422', async () => {
    expect((await request(app).get('/api/v1/shipping/serviceability/12ab')).status).toBe(422);
  });

  it('charges more to ship to a Tier 2 pincode than to a metro one', async () => {
    const [metro, tier2] = await Promise.all([
      request(app)
        .post('/api/v1/pricing/quote')
        .send({ items: [{ slug: demoSlug, qty: 1 }], pincode: '400001' }),
      request(app)
        .post('/api/v1/pricing/quote')
        .send({ items: [{ slug: demoSlug, qty: 1 }], pincode: '785001' }),
    ]);

    expect(tier2.body.data.shippingPaise).toBeGreaterThan(metro.body.data.shippingPaise);
  });
});

describe('coupon validation', () => {
  const cart = () => ({ items: [{ slug: demoSlug, qty: 1 }] });

  it('accepts a valid coupon and reports the discount', async () => {
    const response = await request(app)
      .post('/api/v1/pricing/validate-coupon')
      .send({ ...cart(), code: 'welcome10' });

    // Codes are compared case-insensitively.
    expect(response.status).toBe(200);
    expect(response.body.data.valid).toBe(true);
    expect(response.body.data.code).toBe('WELCOME10');
    expect(response.body.data.discountPaise).toBeGreaterThan(0);
  });

  it('caps a percentage coupon at maxDiscount', async () => {
    const response = await request(app)
      .post('/api/v1/pricing/validate-coupon')
      .send({ ...cart(), code: 'WELCOME10' });

    // 10% of a ₹44k sofa would be ₹4.4k; WELCOME10 caps at ₹2,000.
    expect(response.body.data.discountPaise).toBe(200_000);
  });

  it('returns COUPON_NOT_FOUND for an unknown code', async () => {
    const response = await request(app)
      .post('/api/v1/pricing/validate-coupon')
      .send({ ...cart(), code: 'NOPE123' });

    expect(response.body.data).toMatchObject({ valid: false, rejectionCode: 'COUPON_NOT_FOUND' });
  });

  it('returns EXPIRED for a finished campaign', async () => {
    const response = await request(app)
      .post('/api/v1/pricing/validate-coupon')
      .send({ ...cart(), code: 'EXPIRED2025' });

    expect(response.body.data).toMatchObject({ valid: false, rejectionCode: 'EXPIRED' });
  });

  it('returns MIN_SUBTOTAL_NOT_MET below the threshold', async () => {
    const cheap = await prisma.product.findFirst({
      where: { deletedAt: null, basePricePaise: { lt: 2_000_000, gt: 0 } },
      orderBy: { basePricePaise: 'asc' },
    });
    if (!cheap) return;

    const response = await request(app)
      .post('/api/v1/pricing/validate-coupon')
      .send({ items: [{ slug: cheap.slug, qty: 1 }], code: 'FLAT2000' });

    expect(response.body.data).toMatchObject({
      valid: false,
      rejectionCode: 'MIN_SUBTOTAL_NOT_MET',
    });
  });

  it('returns CUSTOMER_GROUP_NOT_ELIGIBLE for a trade-only coupon', async () => {
    const response = await request(app)
      .post('/api/v1/pricing/validate-coupon')
      .send({ ...cart(), code: 'TRADE15' });

    expect(response.body.data).toMatchObject({
      valid: false,
      rejectionCode: 'CUSTOMER_GROUP_NOT_ELIGIBLE',
    });
  });

  it('returns NOT_STARTED before a campaign opens', async () => {
    const coupon = await prisma.coupon.create({
      data: {
        code: `FUTURE${Date.now()}`,
        name: 'Future sale',
        type: 'PERCENT',
        valueBp: 1000,
        startsAt: new Date(Date.now() + 86_400_000),
      },
    });

    const response = await request(app)
      .post('/api/v1/pricing/validate-coupon')
      .send({ ...cart(), code: coupon.code });

    expect(response.body.data).toMatchObject({ valid: false, rejectionCode: 'NOT_STARTED' });
  });

  it('returns USAGE_LIMIT_REACHED when the campaign is exhausted', async () => {
    const coupon = await prisma.coupon.create({
      data: {
        code: `SPENT${Date.now()}`,
        name: 'Spent',
        type: 'PERCENT',
        valueBp: 500,
        usageLimit: 1,
        usedCount: 1,
      },
    });

    const response = await request(app)
      .post('/api/v1/pricing/validate-coupon')
      .send({ ...cart(), code: coupon.code });

    expect(response.body.data).toMatchObject({
      valid: false,
      rejectionCode: 'USAGE_LIMIT_REACHED',
    });
  });

  it('returns NOT_APPLICABLE_TO_ITEMS when nothing in the cart qualifies', async () => {
    const coupon = await prisma.coupon.create({
      data: {
        code: `NARROW${Date.now()}`,
        name: 'Narrow',
        type: 'PERCENT',
        valueBp: 1000,
        appliesToJson: JSON.stringify({ productIds: ['does-not-exist'] }),
      },
    });

    const response = await request(app)
      .post('/api/v1/pricing/validate-coupon')
      .send({ ...cart(), code: coupon.code });

    expect(response.body.data).toMatchObject({
      valid: false,
      rejectionCode: 'NOT_APPLICABLE_TO_ITEMS',
    });
  });

  it('applies a free-shipping coupon to the quote', async () => {
    const withCoupon = await request(app)
      .post('/api/v1/pricing/quote')
      .send({ items: [{ slug: demoSlug, qty: 1 }], pincode: '400001', couponCode: 'FREESHIP' });

    expect(withCoupon.body.data.shippingPaise).toBe(0);
    expect(withCoupon.body.data.appliedCouponCode).toBe('FREESHIP');
  });
});

describe('coupon redemption lifecycle', () => {
  async function throwawayCoupon(overrides: Record<string, unknown> = {}) {
    return prisma.coupon.create({
      data: {
        code: `LIFECYCLE${Date.now()}${Math.floor(Math.random() * 1000)}`,
        name: 'Lifecycle',
        type: 'FIXED',
        valuePaise: 100_000,
        ...overrides,
      },
    });
  }

  it('reserve then confirm increments usedCount exactly once', async () => {
    const coupon = await throwawayCoupon();

    const reservation = await couponRedemptionService.reserve({
      couponId: coupon.id,
      amountPaise: 100_000,
    });
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(1);

    await couponRedemptionService.confirm(reservation.id);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(1);

    // Confirming again is a no-op, not a second use.
    await couponRedemptionService.confirm(reservation.id);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(1);
  });

  it('reserve then release hands the slot back, and releasing twice does not go negative', async () => {
    const coupon = await throwawayCoupon();

    const reservation = await couponRedemptionService.reserve({
      couponId: coupon.id,
      amountPaise: 100_000,
    });

    await couponRedemptionService.release(reservation.id);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(0);

    await couponRedemptionService.release(reservation.id);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(0);
  });

  it('refuses to confirm a released reservation', async () => {
    const coupon = await throwawayCoupon();
    const reservation = await couponRedemptionService.reserve({
      couponId: coupon.id,
      amountPaise: 1,
    });

    await couponRedemptionService.release(reservation.id);

    await expect(couponRedemptionService.confirm(reservation.id)).rejects.toMatchObject({
      code: 'REDEMPTION_RELEASED',
    });
  });

  it('12 parallel reservations against usageLimit 10 yield exactly 10 successes', async () => {
    const coupon = await throwawayCoupon({ usageLimit: 10 });

    const result = await runConcurrently(12, () =>
      couponRedemptionService.reserve({ couponId: coupon.id, amountPaise: 100_000 }),
    );

    expectNoInfrastructureFailures(result);
    console.log(`[concurrency] coupon 12-vs-10: ${JSON.stringify(result)}`);

    const after = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });

    expect(result.ok).toBe(10);
    expect(result.contended, 'a caller lost a race the service should have resolved').toBe(0);
    expect(result.refused).toBe(2);
    expect(result.reasons).toEqual(['AppError COUPON_EXHAUSTED']);
    expect(after.usedCount).toBe(10);
    expect(await prisma.couponRedemption.count({ where: { couponId: coupon.id } })).toBe(10);
  });

  it('lets an unlimited coupon take every caller', async () => {
    const coupon = await throwawayCoupon({ usageLimit: null });
    expect(coupon.usageLimit).toBeNull();

    const result = await runConcurrently(12, () =>
      couponRedemptionService.reserve({ couponId: coupon.id, amountPaise: 100_000 }),
    );

    expectNoInfrastructureFailures(result);

    expect(result.ok).toBe(12);
    expect(result.refused).toBe(0);
    expect(result.contended).toBe(0);

    const after = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(after.usedCount).toBe(12);
  });

  it('leaves the slot untouched when the redemption row cannot be written', async () => {
    const coupon = await throwawayCoupon({ usageLimit: 5 });
    const orderId = `crash-${Date.now()}`;

    // G1: the coupon must be genuinely usable first, or "unchanged" proves nothing.
    await couponRedemptionService.reserve({ couponId: coupon.id, amountPaise: 100_000, orderId });

    const taken = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(taken.usedCount).toBe(1);
    expect(taken.usageLimit).toBe(5);

    /*
     * `@@unique([couponId, orderId])` makes the second insert fail inside the transaction - a real
     * constraint, not a mock. The increment must roll back with it; before the two statements
     * shared a transaction, the slot was lost for good.
     */
    await expect(
      couponRedemptionService.reserve({ couponId: coupon.id, amountPaise: 100_000, orderId }),
    ).rejects.toThrow();

    const after = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(after.usedCount, 'the failed reserve leaked a slot').toBe(1);
    expect(await prisma.couponRedemption.count({ where: { couponId: coupon.id } })).toBe(1);
  });
});

describe('admin simulate and explain', () => {
  it('returns a breakdown plus a trace of matched and unmatched rules', async () => {
    const response = await as(superAdmin)
      .post('/api/v1/admin/pricing/simulate')
      .send({ items: [{ slug: demoSlug, qty: 2 }], pincode: '400001', includeTrace: true });

    expect(response.status).toBe(200);
    expect(response.body.data.breakdown.grandTotalPaise).toBeGreaterThan(0);

    const trace = response.body.data.trace as { matched: boolean; reason?: string }[];
    expect(trace.length).toBeGreaterThan(0);
    expect(trace.some((step) => step.matched)).toBe(true);
    expect(trace.some((step) => !step.matched && step.reason)).toBe(true);
  });

  it('honours a date override so a future campaign can be previewed', async () => {
    const response = await as(superAdmin)
      .post('/api/v1/admin/pricing/simulate')
      .send({
        items: [{ slug: demoSlug, qty: 1 }],
        now: '2026-10-20T00:00:00.000Z',
        includeTrace: true,
      });

    const festive = (response.body.data.trace as { ruleName: string; matched: boolean }[]).find(
      (step) => step.ruleName.includes('Festive'),
    );
    expect(festive?.matched).toBe(true);
  });

  it('lists every rule that could touch a product', async () => {
    const response = await as(superAdmin).get(`/api/v1/admin/pricing/explain/${demoProductId}`);

    expect(response.status).toBe(200);
    expect(response.body.data.sku).toBe('CW-SOF-KABIR');
    expect(response.body.data.adjustments.length).toBeGreaterThan(0);
    expect(response.body.data.tiers.length).toBeGreaterThan(0);
  });
});

describe('admin pricing CRUD and RBAC', () => {
  it('rejects anonymous and customer-realm callers with 401', async () => {
    expect((await request(app).get('/api/v1/admin/pricing/coupons')).status).toBe(401);
    expect(
      (await request(app).post('/api/v1/admin/pricing/simulate').send({ items: [] })).status,
    ).toBe(401);
  });

  it('rejects a CONTENT_MANAGER with 403', async () => {
    expect((await as(contentManager).get('/api/v1/admin/pricing/coupons')).status).toBe(403);
    expect((await as(contentManager).get('/api/v1/admin/pricing/tier-prices')).status).toBe(403);
  });

  it('lets a CATALOG_MANAGER work with adjustments but not change tax settings', async () => {
    expect((await as(catalogManager).get('/api/v1/admin/pricing/tier-prices')).status).toBe(200);

    const settings = await as(catalogManager)
      .put('/api/v1/admin/pricing/settings')
      .send({ roundTotalToRupee: true });

    expect(settings.status).toBe(403);
  });

  it('creates, updates and deletes a coupon', async () => {
    const code = `TESTCRUD${Date.now()}`;

    const created = await as(superAdmin)
      .post('/api/v1/admin/pricing/coupons')
      .send({ code, name: 'CRUD test', type: 'FIXED', valuePaise: 50_000 });

    expect(created.status).toBe(201);
    expect(created.body.data.code).toBe(code.toUpperCase());

    const updated = await as(superAdmin)
      .patch(`/api/v1/admin/pricing/coupons/${created.body.data.id}`)
      .send({ name: 'CRUD test renamed', version: created.body.data.version });

    expect(updated.status).toBe(200);
    expect(updated.body.data.name).toBe('CRUD test renamed');

    const stale = await as(superAdmin)
      .patch(`/api/v1/admin/pricing/coupons/${created.body.data.id}`)
      .send({ name: 'Too late', version: created.body.data.version });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_RESOURCE');

    const removed = await as(superAdmin).delete(
      `/api/v1/admin/pricing/coupons/${created.body.data.id}`,
    );
    expect(removed.status).toBe(200);
  });

  it('bulk-generates unique codes', async () => {
    const response = await as(superAdmin)
      .post('/api/v1/admin/pricing/coupons/bulk-generate')
      .send({
        prefix: 'GEN',
        count: 5,
        template: { name: 'Generated', type: 'PERCENT', valueBp: 500 },
      });

    expect(response.status).toBe(201);
    const codes = response.body.data.codes as string[];
    expect(codes).toHaveLength(5);
    expect(new Set(codes).size).toBe(5);
    expect(codes.every((code) => code.startsWith('GEN'))).toBe(true);
  });

  it('reads and writes the pricing settings', async () => {
    const read = await as(superAdmin).get('/api/v1/admin/pricing/settings');
    expect(read.status).toBe(200);
    expect(read.body.data.sellerStateCode).toBe('MH');

    const updated = await as(superAdmin)
      .put('/api/v1/admin/pricing/settings')
      .send({ minOrderValuePaise: 100_000 });

    expect(updated.status).toBe(200);
    expect(updated.body.data.minOrderValuePaise).toBe(100_000);

    await as(superAdmin).put('/api/v1/admin/pricing/settings').send({ minOrderValuePaise: 0 });
  });
});

describe('cache invalidation', () => {
  it('reflects a new price rule on the very next public quote', async () => {
    const before = await request(app).get(`/api/v1/catalog/products/${demoSlug}/price?qty=1`);
    const beforeTotal = before.body.data.grandTotalPaise;

    const created = await as(superAdmin)
      .post('/api/v1/admin/catalog/price-adjustments')
      .send({
        name: `Cache probe ${Date.now()}`,
        scope: 'PRODUCT',
        adjustmentType: 'FIXED_AMOUNT',
        basis: 'RUNNING_SUBTOTAL',
        priority: 90,
        valuePaise: -100_000,
        productId: demoProductId,
      });

    expect(created.status).toBe(201);

    const after = await request(app).get(`/api/v1/catalog/products/${demoSlug}/price?qty=1`);
    expect(after.body.data.grandTotalPaise).toBeLessThan(beforeTotal);

    await as(superAdmin).delete(`/api/v1/admin/catalog/price-adjustments/${created.body.data.id}`);
  });
});
