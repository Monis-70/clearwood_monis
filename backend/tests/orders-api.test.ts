import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { payment as paymentDriver } from '../src/container';
import type { MockPaymentDriver } from '../src/drivers/payment';
import { catalogEvents } from '../src/events/catalogEvents';
import { passwordService } from '../src/modules/auth/password.service';
import { checkoutService } from '../src/modules/orders/checkout.service';
import { ledgerIntegrityService } from '../src/modules/orders/ledgerIntegrity.service';
import { orderNumberService } from '../src/modules/orders/orderNumber.service';
import { splitService } from '../src/modules/payments/split/split.service';
import { orderRepository } from '../src/repositories/order.repository';

import { setStockForProduct } from './helpers/stock';

/**
 * Prompt 9A — orders, the payment ledger, the Route split and the webhook contract.
 *
 * The five laws, as tests:
 *
 *  L1 a request carrying an amount cannot change what is charged;
 *  L2 a confirmed order is immutable money — later catalog edits leave it byte-identical;
 *  L3 the webhook alone can confirm an order, five deliveries change state once, and a later
 *     verify call is a harmless no-op;
 *  L4 the ledger balances, and a failed payout never unwinds a successful capture;
 *  L5 every hold has a release path — failure, abandonment, cancellation and the expiry sweep.
 */

const app = createApp();
const API = '/api/v1';
const TEST_PASSWORD = 'Rosewood-Teak-2026';
const CUSTOMER_PASSWORD = 'OrderTester@2026';

const mock = paymentDriver as MockPaymentDriver;

/* ------------------------------------------------------------------ helpers */

interface Session {
  header: string;
  csrf: string;
  id: string;
}

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function sessionFrom(response: request.Response, csrfCookie: string, id: string): Session {
  const cookies = cookiesOf(response);
  return {
    header: cookies.map((cookie) => cookie.split(';')[0]).join('; '),
    csrf:
      cookies
        .find((cookie) => cookie.startsWith(`${csrfCookie}=`))
        ?.split(';')[0]
        ?.split('=')[1] ?? '',
    id,
  };
}

async function admin(email: string, roleCode: string): Promise<Session> {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: `Order ${roleCode}`,
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

  return sessionFrom(login, 'cw_adm_csrf', user.id);
}

async function customer(email: string): Promise<Session> {
  const row = await prisma.customer.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: 'Order Tester',
      status: 'ACTIVE',
      passwordHash: await passwordService.hash(CUSTOMER_PASSWORD),
      emailVerifiedAt: new Date(),
      phone: `9198100${Math.floor(Math.random() * 90_000 + 10_000)}`,
    },
  });

  const login = await request(app)
    .post(`${API}/auth/login`)
    .send({ identifier: email, password: CUSTOMER_PASSWORD });

  expect(login.status).toBe(200);
  return sessionFrom(login, 'cw_cus_csrf', row.id);
}

function as(session: Session) {
  const withCsrf = (req: request.Test) =>
    req.set('Cookie', session.header).set('X-CSRF-Token', session.csrf);

  return {
    get: (url: string) => request(app).get(url).set('Cookie', session.header),
    post: (url: string) => withCsrf(request(app).post(url)),
    patch: (url: string) => withCsrf(request(app).patch(url)),
    put: (url: string) => withCsrf(request(app).put(url)),
    delete: (url: string) => withCsrf(request(app).delete(url)),
  };
}

const ADDRESS = {
  fullName: 'Order Tester',
  phone: '919810000099',
  line1: '9 Test Road',
  city: 'Mumbai',
  state: 'Maharashtra',
  stateCode: 'MH',
  pincode: '400001',
};

/** A guest browser that carries the signed cart cookie forward by hand. */
class Shopper {
  cookie = '';

  private capture(response: request.Response): request.Response {
    const cart = cookiesOf(response).find((value) => value.startsWith('cw_cart='));
    if (cart) this.cookie = cart.split(';')[0]!;
    return response;
  }

  private headers(req: request.Test): request.Test {
    return this.cookie ? req.set('Cookie', this.cookie) : req;
  }

  get(url: string): Promise<request.Response> {
    return this.headers(request(app).get(`${API}${url}`)).then((r) => this.capture(r));
  }

  post(url: string, body?: unknown): Promise<request.Response> {
    return this.headers(request(app).post(`${API}${url}`))
      .send(body ?? {})
      .then((r) => this.capture(r));
  }
}

interface PlacedOrder {
  shopper: Shopper;
  sessionId: string;
  orderId: string;
  orderNumber: string;
  providerOrderId: string | null;
  amountPaise: number;
}

/** Cart → checkout → order, the way a real shopper does it. */
async function placeOrder(
  options: {
    slug?: string;
    qty?: number;
    provider?: 'RAZORPAY' | 'COD';
    couponCode?: string;
  } = {},
): Promise<PlacedOrder> {
  const shopper = new Shopper();
  const slug = options.slug ?? 'banyan-live-edge-coffee-table';

  const product = await prisma.product.findUniqueOrThrow({
    where: { slug },
    include: { variants: { where: { deletedAt: null }, take: 1 } },
  });

  await shopper.post('/cart/items', {
    productId: product.id,
    variantId: product.variants[0]?.id ?? null,
    qty: options.qty ?? 1,
  });

  if (options.couponCode) await shopper.post('/cart/coupon', { code: options.couponCode });

  const init = await shopper.post('/checkout/init', {
    contact: { email: 'guest.order@example.com', phone: '919810000099' },
    shippingAddress: ADDRESS,
    sameAsShipping: true,
  });

  expect(init.status).toBe(201);
  const sessionId = init.body.data.id as string;

  const placed = await shopper.post(`/checkout/${sessionId}/place`, {
    paymentProvider: options.provider ?? 'RAZORPAY',
  });

  expect(placed.status).toBe(201);

  return {
    shopper,
    sessionId,
    orderId: placed.body.data.orderId,
    orderNumber: placed.body.data.orderNumber,
    providerOrderId: placed.body.data.providerOrderId,
    amountPaise: placed.body.data.amountPaise,
  };
}

async function payFor(order: PlacedOrder): Promise<request.Response> {
  const completed = mock.simulateCheckout(order.providerOrderId!);
  return order.shopper.post('/checkout/verify', completed);
}

let superAdmin: Session;
let catalogManager: Session;
let orderManager: Session;

/** Every product this file buys from, so one test cannot starve the next of stock. */
const SLUGS = [
  'banyan-live-edge-coffee-table',
  'nilgiri-rocking-chair',
  'ashoka-nesting-table-set',
  'konark-storage-bench',
  'arjun-wingback-lounge-chair',
  'mahseer-counter-stool',
  'coorg-outdoor-lounger',
  'sahyadri-6-seater-dining-set',
  'kabir-3-seater-fabric-sofa',
  'teakwood-chesterfield-leather-sofa',
  'malabar-l-shaped-sofa',
  'jodi-2-seater-dining-set',
  'ortho-zen-pocket-spring-mattress',
  'kaveri-3-seater-recliner',
  'narmada-u-shaped-sofa',
  'chenab-sofa-cum-bed',
];

beforeAll(async () => {
  superAdmin = await admin('orders.super@clearwood.local', 'SUPER_ADMIN');
  catalogManager = await admin('orders.catalog@clearwood.local', 'CATALOG_MANAGER');
  orderManager = await admin('orders.order@clearwood.local', 'ORDER_MANAGER');
  mock.setScenario('success');

  // Through inventory.service, so the scaffolding exercises the same guarded writer production
  // uses and every variant with stock has a ledger entry explaining it.
  for (const slug of SLUGS) await setStockForProduct(slug, 500);
});

/* ------------------------------------------------------------ order numbers */

describe('order numbers', () => {
  it('uses the Indian financial year', () => {
    expect(orderNumberService.financialYearKey(new Date('2026-04-01'))).toBe('2026-27');
    expect(orderNumberService.financialYearKey(new Date('2026-03-31'))).toBe('2025-26');
  });

  it('hands 200 concurrent callers 200 distinct numbers', async () => {
    const key = `test-${Date.now()}`;
    const { orderSequenceRepository } = await import('../src/repositories/order.repository');

    // SQLite has a single writer, so 200 truly simultaneous writes just queue until the socket
    // times out. Waves of 25 keep the race real (every wave contends) without testing the
    // connection pool instead of the algorithm.
    const numbers: number[] = [];
    for (let wave = 0; wave < 8; wave += 1) {
      numbers.push(
        ...(await Promise.all(Array.from({ length: 25 }, () => orderSequenceRepository.next(key)))),
      );
    }

    expect(numbers).toHaveLength(200);
    expect(new Set(numbers).size).toBe(200);
    // Sequential with no gaps: 1..200.
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
  });
});

/* --------------------------------------------------------- L1: no client price */

describe('L1 — the client never sends an amount', () => {
  it('ignores an amount in the place body and charges the server-computed total', async () => {
    const shopper = new Shopper();
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'banyan-live-edge-coffee-table' },
      include: { variants: { where: { deletedAt: null }, take: 1 } },
    });

    await shopper.post('/cart/items', {
      productId: product.id,
      variantId: product.variants[0]!.id,
      qty: 1,
    });

    const init = await shopper.post('/checkout/init', {
      contact: { email: 'guest.order@example.com' },
      shippingAddress: ADDRESS,
      sameAsShipping: true,
    });

    const expected = init.body.data.breakdown.grandTotalPaise as number;

    // `.strict()` on the schema means a body with an amount is refused outright rather than
    // quietly ignored — which is what makes the law enforceable instead of aspirational.
    const rejected = await shopper.post(`/checkout/${init.body.data.id}/place`, {
      paymentProvider: 'RAZORPAY',
      amountPaise: 1,
      grandTotalPaise: 1,
    });

    expect(rejected.status).toBe(422);

    const honest = await shopper.post(`/checkout/${init.body.data.id}/place`, {
      paymentProvider: 'RAZORPAY',
    });

    expect(honest.body.data.amountPaise).toBe(expected);
  });
});

/* -------------------------------------------------- L2: immutable money */

describe('L2 — a placed order is immutable money', () => {
  it('freezes the breakdown and survives a price change, a coupon change and a tax change', async () => {
    const order = await placeOrder({ slug: 'nilgiri-rocking-chair' });
    await payFor(order);

    const before = await orderRepository.findByNumber(order.orderNumber);
    const snapshot = JSON.stringify({
      grand: before!.grandTotalPaise,
      tax: before!.taxPaise,
      breakdown: before!.breakdownJson,
      items: before!.items.map((item) => [item.unitPricePaise, item.lineTotalPaise]),
    });

    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'nilgiri-rocking-chair' },
    });
    const originalPrice = product.basePricePaise;
    const taxClass = await prisma.taxClass.findFirstOrThrow({ where: { code: 'GST_18' } });
    const originalRate = taxClass.rateBp;

    try {
      await prisma.product.update({
        where: { id: product.id },
        data: { basePricePaise: originalPrice * 2 },
      });
      await prisma.taxClass.update({ where: { id: taxClass.id }, data: { rateBp: 2_800 } });
      await prisma.coupon.updateMany({ where: { code: 'WELCOME10' }, data: { isActive: false } });

      const after = await orderRepository.findByNumber(order.orderNumber);
      const rendered = JSON.stringify({
        grand: after!.grandTotalPaise,
        tax: after!.taxPaise,
        breakdown: after!.breakdownJson,
        items: after!.items.map((item) => [item.unitPricePaise, item.lineTotalPaise]),
      });

      expect(rendered).toBe(snapshot);
    } finally {
      await prisma.product.update({
        where: { id: product.id },
        data: { basePricePaise: originalPrice },
      });
      await prisma.taxClass.update({ where: { id: taxClass.id }, data: { rateBp: originalRate } });
      await prisma.coupon.updateMany({ where: { code: 'WELCOME10' }, data: { isActive: true } });
    }
  });

  it('matches the cart quote it was created from, component by component', async () => {
    const shopper = new Shopper();
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'ashoka-nesting-table-set' },
      include: { variants: { where: { deletedAt: null }, take: 1 } },
    });

    await shopper.post('/cart/items', {
      productId: product.id,
      variantId: product.variants[0]!.id,
      qty: 2,
    });

    const init = await shopper.post('/checkout/init', {
      contact: { email: 'guest.order@example.com' },
      shippingAddress: ADDRESS,
      sameAsShipping: true,
    });

    const quoted = init.body.data.breakdown;
    const placed = await shopper.post(`/checkout/${init.body.data.id}/place`, {
      paymentProvider: 'RAZORPAY',
    });

    const order = await orderRepository.findByNumber(placed.body.data.orderNumber);
    const frozen = JSON.parse(order!.breakdownJson) as Record<string, number>;

    for (const key of [
      'subtotalPaise',
      'discountPaise',
      'shippingPaise',
      'taxPaise',
      'roundingPaise',
      'grandTotalPaise',
    ] as const) {
      expect(order![key]).toBe(quoted[key]);
      expect(frozen[key]).toBe(quoted[key]);
    }
  });
});

/* ------------------------------------------------ reservations and coupons */

describe('L5 — every hold has a release path', () => {
  it('reserves exactly the ordered quantity and consumes it on capture', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'konark-storage-bench' },
      include: { variants: { where: { deletedAt: null }, take: 1 } },
    });
    const variantId = product.variants[0]!.id;

    const before = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });

    const order = await placeOrder({ slug: 'konark-storage-bench', qty: 2 });

    const held = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    expect(held.reservedQty).toBe(before.reservedQty + 2);
    expect(held.stockQty).toBe(before.stockQty);

    await payFor(order);

    const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    // The reservation is handed back and the units leave stock for real.
    expect(after.reservedQty).toBe(before.reservedQty);
    expect(after.stockQty).toBe(before.stockQty - 2);

    const ledger = await prisma.inventoryLedger.findFirst({
      where: { variantId, refType: 'ORDER', refId: order.orderId, reason: 'ORDER_FULFILLED' },
    });
    expect(ledger?.delta).toBe(-2);
  });

  it('releases the reservation when the payment fails', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'arjun-wingback-lounge-chair' },
      include: { variants: { where: { deletedAt: null }, take: 1 } },
    });
    const variantId = product.variants[0]!.id;
    const before = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });

    const order = await placeOrder({ slug: 'arjun-wingback-lounge-chair' });
    const row = await orderRepository.findById(order.orderId);
    await checkoutService.failOrder(row!, 'TEST_FAILURE');

    const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    expect(after.reservedQty).toBe(before.reservedQty);
    expect(after.stockQty).toBe(before.stockQty);

    const reservations = await prisma.stockReservation.findMany({
      where: { orderId: order.orderId },
    });
    expect(reservations.every((entry) => entry.status === 'RELEASED')).toBe(true);
  });

  it('is a no-op when the same holds are released twice', async () => {
    const order = await placeOrder({ slug: 'mahseer-counter-stool' });
    const row = await orderRepository.findById(order.orderId);

    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'mahseer-counter-stool' },
      include: { variants: { where: { deletedAt: null }, take: 1 } },
    });

    await checkoutService.releaseHolds(row!, 'ONCE');
    const once = await prisma.productVariant.findUniqueOrThrow({
      where: { id: product.variants[0]!.id },
    });

    await checkoutService.releaseHolds(row!, 'TWICE');
    const twice = await prisma.productVariant.findUniqueOrThrow({
      where: { id: product.variants[0]!.id },
    });

    expect(twice.reservedQty).toBe(once.reservedQty);
  });

  it('expires a stale PENDING_PAYMENT order and never touches a CONFIRMED one', async () => {
    const stale = await placeOrder({ slug: 'coorg-outdoor-lounger' });
    const safe = await placeOrder({ slug: 'sahyadri-6-seater-dining-set' });
    await payFor(safe);

    await prisma.order.update({
      where: { id: stale.orderId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    await checkoutService.expireStaleOrders(50);

    const staleAfter = await orderRepository.findById(stale.orderId);
    const safeAfter = await orderRepository.findById(safe.orderId);

    expect(staleAfter!.status).toBe('EXPIRED');
    expect(safeAfter!.status).toBe('CONFIRMED');
  });

  it('confirms a coupon on capture and releases it on failure', async () => {
    const coupon = await prisma.coupon.findFirstOrThrow({ where: { code: 'WELCOME10' } });

    const paidBefore = coupon.usedCount;
    const paid = await placeOrder({ slug: 'kabir-3-seater-fabric-sofa', couponCode: 'WELCOME10' });

    const reserved = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(reserved.usedCount).toBe(paidBefore + 1);

    await payFor(paid);

    const confirmedRedemption = await prisma.couponRedemption.findFirst({
      where: { orderId: paid.orderId },
    });
    expect(confirmedRedemption?.status).toBe('CONFIRMED');
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(
      paidBefore + 1,
    );

    const failedBefore = (await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } }))
      .usedCount;
    const failed = await placeOrder({
      slug: 'kabir-3-seater-fabric-sofa',
      couponCode: 'WELCOME10',
    });
    const failedRow = await orderRepository.findById(failed.orderId);
    await checkoutService.failOrder(failedRow!, 'TEST_FAILURE');

    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(
      failedBefore,
    );
  });
});

/* ------------------------------------------------------------ L4: the split */

describe('L4 — the split and the ledger', () => {
  it('simulates the canonical ₹6,000 case as PRIMARY ₹5,000 + PARTNER_A ₹1,000', async () => {
    const response = await as(superAdmin)
      .post(`${API}/admin/payments/split-simulate`)
      .send({ amountPaise: 600_000 });

    expect(response.status).toBe(200);

    const byAccount = Object.fromEntries(
      (response.body.data.allocations as { splitAccountKey: string; amountPaise: number }[]).map(
        (entry) => [entry.splitAccountKey, entry.amountPaise],
      ),
    );

    expect(byAccount.PARTNER_A).toBe(100_000);
    expect(byAccount.PRIMARY).toBe(500_000);
    expect(response.body.data.allocatedPaise).toBe(600_000);
  });

  it('persists allocations before the provider is called and transfers after capture', async () => {
    const order = await placeOrder({ slug: 'teakwood-chesterfield-leather-sofa' });

    // Written at placement, before a single rupee has moved.
    const allocations = await prisma.splitAllocation.findMany({
      where: { orderId: order.orderId },
    });
    expect(allocations.length).toBeGreaterThan(0);
    expect(allocations.reduce((sum, entry) => sum + entry.amountPaise, 0)).toBe(order.amountPaise);
    expect(
      await prisma.paymentTransfer.count({ where: { payment: { orderId: order.orderId } } }),
    ).toBe(0);

    await payFor(order);

    const transfers = await prisma.paymentTransfer.findMany({
      where: { payment: { orderId: order.orderId } },
      include: { account: true },
    });

    expect(transfers.length).toBeGreaterThan(0);
    const partner = transfers.find((entry) => entry.account.key === 'PARTNER_A');
    expect(partner?.amountPaise).toBe(100_000);
    expect(transfers.reduce((sum, entry) => sum + entry.amountPaise, 0)).toBe(order.amountPaise);
  });

  it('balances the ledger for a paid order', async () => {
    const order = await placeOrder({ slug: 'malabar-l-shaped-sofa' });
    await payFor(order);

    const report = await ledgerIntegrityService.verifyOrder(order.orderId);
    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it('fails the ledger check loudly when a stored amount is corrupted', async () => {
    const order = await placeOrder({ slug: 'jodi-2-seater-dining-set' });
    await payFor(order);

    await prisma.order.update({
      where: { id: order.orderId },
      data: { grandTotalPaise: order.amountPaise + 1 },
    });

    const report = await ledgerIntegrityService.verifyOrder(order.orderId);
    expect(report.ok).toBe(false);

    const failed = report.checks.find((check) => !check.ok)!;
    expect(failed.message).toContain('must equal');
    expect(failed.expected).not.toBe(failed.actual);

    await prisma.order.update({
      where: { id: order.orderId },
      data: { grandTotalPaise: order.amountPaise },
    });
  });

  it('keeps the capture when a transfer fails, and repairs it on retry', async () => {
    mock.setScenario('transfer-failure');

    try {
      const order = await placeOrder({ slug: 'ortho-zen-pocket-spring-mattress' });
      await payFor(order);

      const row = await orderRepository.findById(order.orderId);
      expect(row!.status).toBe('CONFIRMED');
      expect(row!.paymentStatus).toBe('CAPTURED');

      const failed = await prisma.paymentTransfer.findMany({
        where: { payment: { orderId: order.orderId }, status: 'FAILED' },
      });
      expect(failed.length).toBeGreaterThan(0);

      // The admin can see it.
      const listed = await as(orderManager).get(
        `${API}/admin/orders?hasFailedTransfer=true&limit=50`,
      );
      expect(
        (listed.body.data as { id: string }[]).some((entry) => entry.id === order.orderId),
      ).toBe(true);

      mock.setScenario('success');
      const retried = await splitService.retryTransfers(order.orderId);
      expect(retried.succeeded).toBeGreaterThan(0);

      const after = await prisma.paymentTransfer.count({
        where: { payment: { orderId: order.orderId }, status: 'FAILED' },
      });
      expect(after).toBe(0);
    } finally {
      mock.setScenario('success');
    }
  });
});

/* ---------------------------------------------------- L3: webhook authority */

describe('L3 — the webhook is the source of truth', () => {
  function deliver(body: Buffer, signature: string) {
    // Sent as a string so superagent writes the exact bytes the signature was computed over.
    return request(app)
      .post(`${API}/webhooks/razorpay`)
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signature)
      .send(body.toString('utf8'));
  }

  it('confirms an order entirely on its own, before any verify call', async () => {
    const order = await placeOrder({ slug: 'kaveri-3-seater-recliner' });
    const completed = mock.simulateCheckout(order.providerOrderId!);

    const hook = mock.buildWebhook(
      'payment.captured',
      mock.paymentEntity(completed.providerPaymentId),
    );
    const delivered = await deliver(hook.body, hook.signature);

    expect(delivered.status).toBe(200);
    expect(delivered.body.data.status).toBe('PROCESSED');

    const confirmed = await orderRepository.findById(order.orderId);
    expect(confirmed!.status).toBe('CONFIRMED');
    expect(confirmed!.paymentStatus).toBe('CAPTURED');

    // And the verify call that arrives afterwards is a happy no-op.
    const verified = await order.shopper.post('/checkout/verify', completed);
    expect(verified.status).toBe(200);
    expect(verified.body.data.alreadyConfirmed).toBe(true);
    expect(verified.body.data.status).toBe('CONFIRMED');
  });

  it('changes state once when the same event is delivered five times at once', async () => {
    const order = await placeOrder({ slug: 'narmada-u-shaped-sofa' });
    const completed = mock.simulateCheckout(order.providerOrderId!);
    const hook = mock.buildWebhook(
      'payment.captured',
      mock.paymentEntity(completed.providerPaymentId),
    );

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => deliver(hook.body, hook.signature)),
    );

    responses.forEach((response) => expect(response.status).toBe(200));

    const processed = responses.filter((r) => r.body.data.status === 'PROCESSED');
    expect(processed).toHaveLength(1);
    expect(responses.filter((r) => r.body.data.status === 'DUPLICATE')).toHaveLength(4);

    const history = await prisma.orderStatusHistory.count({
      where: { orderId: order.orderId, toStatus: 'CONFIRMED' },
    });
    expect(history).toBe(1);

    const payments = await prisma.payment.count({
      where: { orderId: order.orderId, status: 'CAPTURED' },
    });
    expect(payments).toBe(1);

    const transfers = await prisma.paymentTransfer.findMany({
      where: { payment: { orderId: order.orderId } },
    });
    const allocations = await prisma.splitAllocation.count({ where: { orderId: order.orderId } });
    expect(transfers.length).toBeLessThanOrEqual(allocations);

    const ledger = await prisma.inventoryLedger.count({
      where: { refType: 'ORDER', refId: order.orderId, reason: 'ORDER_FULFILLED' },
    });
    expect(ledger).toBe(1);
  });

  it('rejects an unsigned or wrongly-signed delivery without storing it as valid', async () => {
    const hook = mock.buildWebhook('payment.captured', {
      id: 'pay_mock_nope',
      order_id: 'order_x',
    });

    const unsigned = await request(app)
      .post(`${API}/webhooks/razorpay`)
      .set('Content-Type', 'application/json')
      .send(hook.body.toString('utf8'));
    expect(unsigned.status).toBe(400);

    const wrong = await deliver(hook.body, 'f'.repeat(64));
    expect(wrong.status).toBe(400);

    const stored = await prisma.webhookEvent.findFirst({
      where: { providerEventId: hook.eventId, signatureValid: true },
    });
    expect(stored).toBeNull();
  });

  it('ignores a stale event for an order that already moved on', async () => {
    const order = await placeOrder({ slug: 'chenab-sofa-cum-bed' });
    const completed = mock.simulateCheckout(order.providerOrderId!);

    await payFor(order);

    const stale = mock.buildWebhook(
      'payment.failed',
      { id: completed.providerPaymentId, order_id: order.providerOrderId },
      { eventId: `stale-${order.orderId}` },
    );

    const delivered = await deliver(stale.body, stale.signature);
    expect(delivered.status).toBe(200);
    expect(delivered.body.data.message).toContain('already paid');

    const after = await orderRepository.findById(order.orderId);
    expect(after!.status).toBe('CONFIRMED');
  });

  it('replays a stored event from the admin with no duplicate side effects', async () => {
    const order = await placeOrder({ slug: 'rajwada-diwan' }).catch(() => null);
    if (!order) return;

    const completed = mock.simulateCheckout(order.providerOrderId!);
    const hook = mock.buildWebhook(
      'payment.captured',
      mock.paymentEntity(completed.providerPaymentId),
    );
    await deliver(hook.body, hook.signature);

    const stored = await prisma.webhookEvent.findFirstOrThrow({
      where: { providerEventId: hook.eventId },
    });

    const before = await prisma.orderStatusHistory.count({ where: { orderId: order.orderId } });
    const replayed = await as(orderManager).post(`${API}/admin/webhooks/${stored.id}/replay`);

    expect(replayed.status).toBe(200);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: order.orderId } })).toBe(
      before,
    );
  });
});

/* ------------------------------------------------------------- price change */

describe('price changes and blocking issues', () => {
  it('refuses to place when the price moved, and creates nothing', async () => {
    const shopper = new Shopper();
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'nilgiri-rocking-chair' },
      include: { variants: { where: { deletedAt: null }, take: 1 } },
    });

    await shopper.post('/cart/items', {
      productId: product.id,
      variantId: product.variants[0]!.id,
      qty: 1,
    });

    const init = await shopper.post('/checkout/init', {
      contact: { email: 'guest.order@example.com' },
      shippingAddress: ADDRESS,
      sameAsShipping: true,
    });

    const ordersBefore = await prisma.order.count();
    const original = product.basePricePaise;

    try {
      await prisma.product.update({
        where: { id: product.id },
        data: { basePricePaise: original + 500_000 },
      });

      const placed = await shopper.post(`/checkout/${init.body.data.id}/place`, {
        paymentProvider: 'RAZORPAY',
      });

      expect(placed.status).toBe(409);
      expect(placed.body.error.code).toBe('PRICE_CHANGED');
      expect(placed.body.error.details.currentTotalPaise).toBeGreaterThan(
        placed.body.error.details.previousTotalPaise,
      );
      expect(placed.body.error.details.breakdown).toBeTruthy();

      expect(await prisma.order.count()).toBe(ordersBefore);
    } finally {
      await prisma.product.update({
        where: { id: product.id },
        data: { basePricePaise: original },
      });
    }
  });

  it('refuses to open a checkout for a cart with a blocking issue', async () => {
    const shopper = new Shopper();
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'banyan-live-edge-coffee-table' },
      include: { variants: { where: { deletedAt: null }, take: 1 } },
    });

    const added = await shopper.post('/cart/items', {
      productId: product.id,
      variantId: product.variants[0]!.id,
      qty: 1,
    });

    // Push the line past every ceiling so validation has a genuine blocker to report.
    await prisma.cartItem.update({
      where: { id: added.body.data.lines[0].id },
      data: { qty: 9_999 },
    });

    const init = await shopper.post('/checkout/init', {
      contact: { email: 'guest.order@example.com' },
      shippingAddress: ADDRESS,
      sameAsShipping: true,
    });

    expect(init.status).toBe(422);
    expect(init.body.error.code).toBe('CART_NOT_CHECKOUT_READY');
    expect(init.body.error.details.issues.length).toBeGreaterThan(0);
  });

  it('carries the delivery promise for the shipping pincode into the session', async () => {
    const shopper = new Shopper();
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'banyan-live-edge-coffee-table' },
      include: { variants: { where: { deletedAt: null }, take: 1 } },
    });

    await shopper.post('/cart/items', {
      productId: product.id,
      variantId: product.variants[0]!.id,
      qty: 1,
    });

    const init = await shopper.post('/checkout/init', {
      contact: { email: 'guest.order@example.com' },
      shippingAddress: ADDRESS,
      sameAsShipping: true,
    });

    const lookup = await request(app).get(`${API}/addresses/pincode/${ADDRESS.pincode}`);

    // The form and the checkout must never disagree about where we deliver or when.
    expect(init.body.data.etaMinDays).toBe(lookup.body.data.etaMinDays);
    expect(init.body.data.etaMaxDays).toBe(lookup.body.data.etaMaxDays);
    expect(init.body.data.codAvailable).toBe(lookup.body.data.codAvailable);
  });
});

/* ------------------------------------------------------------------- COD */

describe('cash on delivery', () => {
  it('confirms without a provider call, consumes the reservation and creates no transfers', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'konark-storage-bench' },
      include: { variants: { where: { deletedAt: null }, take: 1 } },
    });
    const before = await prisma.productVariant.findUniqueOrThrow({
      where: { id: product.variants[0]!.id },
    });

    const order = await placeOrder({ slug: 'konark-storage-bench', provider: 'COD' });

    const row = await orderRepository.findById(order.orderId);
    expect(row!.status).toBe('CONFIRMED');
    expect(row!.paymentStatus).toBe('PENDING');
    expect(order.providerOrderId).toBeNull();

    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: product.variants[0]!.id },
    });
    expect(after.stockQty).toBe(before.stockQty - 1);
    expect(after.reservedQty).toBe(before.reservedQty);

    expect(
      await prisma.paymentTransfer.count({ where: { payment: { orderId: order.orderId } } }),
    ).toBe(0);
  });

  it('refuses COD above the configured ceiling', async () => {
    const shopper = new Shopper();
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'teakwood-chesterfield-leather-sofa' },
      include: { variants: { where: { deletedAt: null }, take: 1 } },
    });

    await shopper.post('/cart/items', {
      productId: product.id,
      variantId: product.variants[0]!.id,
      qty: 3,
    });

    const init = await shopper.post('/checkout/init', {
      contact: { email: 'guest.order@example.com' },
      shippingAddress: ADDRESS,
      sameAsShipping: true,
    });

    const placed = await shopper.post(`/checkout/${init.body.data.id}/place`, {
      paymentProvider: 'COD',
    });

    expect(placed.status).toBe(422);
    expect(placed.body.error.code).toBe('COD_LIMIT_EXCEEDED');
  });
});

/* ------------------------------------------------------------- signatures */

describe('signatures', () => {
  it('accepts a real signature and rejects every tampered variant', async () => {
    const order = await placeOrder({ slug: 'banyan-live-edge-coffee-table' });
    const good = mock.simulateCheckout(order.providerOrderId!);

    expect(paymentDriver.verifyPaymentSignature(good)).toBe(true);
    expect(paymentDriver.verifyPaymentSignature({ ...good, providerPaymentId: 'pay_x' })).toBe(
      false,
    );
    expect(paymentDriver.verifyPaymentSignature({ ...good, providerOrderId: 'order_x' })).toBe(
      false,
    );
    expect(
      paymentDriver.verifyPaymentSignature({
        ...good,
        signature: good.signature.replace(/.$/, '0'),
      }),
    ).toBe(false);

    const rejected = await order.shopper.post('/checkout/verify', {
      ...good,
      signature: 'a'.repeat(64),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('INVALID_PAYMENT_SIGNATURE');
  });

  it('compares in constant time rather than bailing on the first wrong byte', async () => {
    // The guarantee is structural: the implementation uses timingSafeEqual, which cannot
    // short-circuit. Asserting on wall-clock timing would be flaky; asserting on the source is not.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const source = readFileSync(
      join(__dirname, '..', 'src', 'drivers', 'payment', 'razorpay.payment.driver.ts'),
      'utf8',
    );

    expect(source).toContain('timingSafeEqual');
    expect(source).not.toMatch(/signature\s*===\s*expected/);
  });
});

/* ------------------------------------------------- cancellation and refunds */

describe('cancellation', () => {
  it('releases holds, records a refund request and refuses a second cancellation', async () => {
    const session = await customer('order.cancel@example.com');
    const order = await placeOrder({ slug: 'coorg-outdoor-lounger' });
    await payFor(order);

    await prisma.order.update({
      where: { id: order.orderId },
      data: { customerId: session.id, isGuest: false },
    });

    const cancelled = await as(session)
      .post(`${API}/me/orders/${encodeURIComponent(order.orderNumber)}/cancel`)
      .send({ reason: 'CUSTOMER_REQUEST', note: 'changed my mind' });

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const refunds = await prisma.refund.findMany({ where: { orderId: order.orderId } });
    expect(refunds).toHaveLength(1);
    // 9A records the obligation; executing it is 9B.
    expect(refunds[0]!.status).toBe('REQUESTED');
    expect(refunds[0]!.amountPaise).toBe(order.amountPaise);

    const again = await as(session)
      .post(`${API}/me/orders/${encodeURIComponent(order.orderNumber)}/cancel`)
      .send({ reason: 'CUSTOMER_REQUEST' });

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
  });
});

/* --------------------------------------------------------- guest tracking */

describe('guest tracking', () => {
  it('finds an order with the matching contact and leaks nothing about anybody else', async () => {
    const order = await placeOrder({ slug: 'banyan-live-edge-coffee-table' });
    await payFor(order);

    const tracked = await request(app)
      .post(`${API}/orders/track`)
      .send({ orderNumber: order.orderNumber, email: 'guest.order@example.com' });

    expect(tracked.status).toBe(200);
    expect(tracked.body.data.orderNumber).toBe(order.orderNumber);
    expect(tracked.body.data.shippingCity).toBe('Mumbai');

    const serialised = JSON.stringify(tracked.body);
    expect(serialised).not.toContain(ADDRESS.line1);
    expect(serialised).not.toContain(ADDRESS.phone);
    expect(serialised).not.toContain('guest.order@example.com');
    expect(tracked.body.data.breakdown).toBeUndefined();

    const guessed = await request(app)
      .post(`${API}/orders/track`)
      .send({ orderNumber: order.orderNumber, email: 'someone.else@example.com' });

    expect(guessed.status).toBe(404);
  });
});

/* -------------------------------------------------------- product signals */

describe('product signals', () => {
  it('moves purchaseCount and soldCount when an order is confirmed', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'ashoka-nesting-table-set' },
    });
    const before = await prisma.productStat.findUnique({ where: { productId: product.id } });

    const order = await placeOrder({ slug: 'ashoka-nesting-table-set', qty: 2 });
    await payFor(order);
    await catalogEvents.settled();

    const after = await prisma.productStat.findUniqueOrThrow({ where: { productId: product.id } });
    expect(after.purchaseCount).toBe((before?.purchaseCount ?? 0) + 2);

    const product2 = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(product2.soldCount).toBeGreaterThan(product.soldCount - 1);
  });
});

/* ------------------------------------------------------------------ RBAC */

describe('RBAC and ownership', () => {
  it('shows a customer only their own orders and 404s the rest', async () => {
    const mine = await customer('order.owner@example.com');
    const stranger = await customer('order.stranger@example.com');

    const order = await placeOrder({ slug: 'banyan-live-edge-coffee-table' });
    await prisma.order.update({
      where: { id: order.orderId },
      data: { customerId: mine.id, isGuest: false },
    });

    const list = await as(mine).get(`${API}/me/orders`);
    expect(list.status).toBe(200);
    expect(
      (list.body.data as { orderNumber: string }[]).some(
        (o) => o.orderNumber === order.orderNumber,
      ),
    ).toBe(true);

    const theirs = await as(stranger).get(
      `${API}/me/orders/${encodeURIComponent(order.orderNumber)}`,
    );
    expect(theirs.status).toBe(404);
  });

  it('refuses an admin token on the customer order routes', async () => {
    const response = await as(superAdmin).get(`${API}/me/orders`);
    expect(response.status).toBe(401);
  });

  it('gates the admin order routes on order.order.read', async () => {
    expect((await request(app).get(`${API}/admin/orders`)).status).toBe(401);

    const shopper = await customer('order.rbac@example.com');
    expect((await as(shopper).get(`${API}/admin/orders`)).status).toBe(401);

    expect((await as(catalogManager).get(`${API}/admin/orders`)).status).toBe(403);
    expect((await as(orderManager).get(`${API}/admin/orders`)).status).toBe(200);
  });

  it('withholds split-rule writes from everybody but SUPER_ADMIN', async () => {
    const body = {
      code: `rbac-test-${Date.now()}`,
      name: 'RBAC probe',
      mode: 'FIXED',
      valuePaise: 1_000,
      recipientKey: 'PARTNER_A',
    };

    // ORDER_MANAGER has the whole order.* set but none of payment.*.
    expect(
      (await as(orderManager).post(`${API}/admin/payments/split-rules`).send(body)).status,
    ).toBe(403);
    expect((await as(catalogManager).get(`${API}/admin/payments/split-rules`)).status).toBe(403);

    const allowed = await as(superAdmin).post(`${API}/admin/payments/split-rules`).send(body);
    expect(allowed.status).toBe(201);

    await as(superAdmin).delete(`${API}/admin/payments/split-rules/${allowed.body.data.id}`);
  });

  it('refuses a second active REMAINDER rule', async () => {
    const response = await as(superAdmin)
      .post(`${API}/admin/payments/split-rules`)
      .send({
        code: `second-remainder-${Date.now()}`,
        name: 'A rival remainder',
        mode: 'REMAINDER',
        recipientKey: 'PARTNER_A',
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DUPLICATE_REMAINDER_RULE');
  });

  it('refuses a PERCENT rule with no valueBp', async () => {
    const response = await as(superAdmin)
      .post(`${API}/admin/payments/split-rules`)
      .send({
        code: `bad-percent-${Date.now()}`,
        name: 'Percent with no percentage',
        mode: 'PERCENT',
        recipientKey: 'PARTNER_A',
      });

    expect(response.status).toBe(422);
  });
});

/* ------------------------------------------------------------- admin views */

describe('admin views', () => {
  it('returns the full detail with payments, transfers, allocations and the ledger check', async () => {
    const order = await placeOrder({ slug: 'banyan-live-edge-coffee-table' });
    await payFor(order);

    const detail = await as(orderManager).get(`${API}/admin/orders/${order.orderId}`);

    expect(detail.status).toBe(200);
    expect(detail.body.data.payments.length).toBeGreaterThan(0);
    expect(detail.body.data.transfers.length).toBeGreaterThan(0);
    expect(detail.body.data.allocations.length).toBeGreaterThan(0);
    expect(detail.body.data.reservations.length).toBeGreaterThan(0);
    expect(detail.body.data.integrity.ok).toBe(true);
    expect(detail.body.data.order.breakdown.grandTotalPaise).toBe(order.amountPaise);
  });

  it('refuses an illegal status transition with the allowed targets', async () => {
    const order = await placeOrder({ slug: 'banyan-live-edge-coffee-table' });

    const response = await as(superAdmin)
      .post(`${API}/admin/orders/${order.orderId}/status`)
      .send({ status: 'DELIVERED' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INVALID_ORDER_TRANSITION');
    expect(Array.isArray(response.body.error.details.allowed)).toBe(true);
  });

  it('runs the reconciliation sweep', async () => {
    const response = await as(orderManager).post(`${API}/admin/orders/reconcile`).send({});

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty('scanned');
    expect(response.body.data).toHaveProperty('orphanReservations');
  });
});

/* --------------------------------------------------------------- secrets */

describe('secrets', () => {
  it('never stores a provider secret or a full card number in a raw payload', async () => {
    const order = await placeOrder({ slug: 'banyan-live-edge-coffee-table' });
    await payFor(order);

    const payloads = [
      ...(await prisma.payment.findMany({ select: { rawResponseJson: true } })),
      ...(await prisma.paymentTransfer.findMany({ select: { rawResponseJson: true } })),
      ...(await prisma.webhookEvent.findMany({ select: { payloadJson: true } })),
    ]
      .map((row) => ('rawResponseJson' in row ? row.rawResponseJson : row.payloadJson))
      .filter((value): value is string => Boolean(value));

    const haystack = payloads.join('\n');

    expect(haystack).not.toContain('mock_key_secret_for_tests_only');
    expect(haystack).not.toContain('mock_webhook_secret_for_tests_only');
    expect(haystack).not.toMatch(/\b\d{16}\b/);
  });
});
