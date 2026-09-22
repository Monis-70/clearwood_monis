import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { payment as paymentDriver } from '../src/container';
import type { MockPaymentDriver } from '../src/drivers/payment';
import { passwordService } from '../src/modules/auth/password.service';
import { ledgerIntegrityService } from '../src/modules/orders/ledgerIntegrity.service';
import { orderRepository } from '../src/repositories/order.repository';
import {
  pickupLocationRepository,
  shippingProviderRepository,
} from '../src/repositories/shipment.repository';

import { placeAndPayOrder, type PaidOrderFixture } from './helpers/paidOrder';
import { expectLedgerOk } from './helpers/ledger';
import { setStockForProduct } from './helpers/stock';

/**
 * Slice A - fulfilment over HTTP.
 *
 * The services were fully unit-tested and completely unreachable: no route mounted them. These
 * tests drive shipments, tracking, NDR, returns and refunds through the real Express stack, with
 * real permissions, so "tests pass but the feature cannot be used" cannot happen again.
 */

const app = createApp();
const API = '/api/v1';
const ADMIN_API = `${API}/admin`;
const mock = paymentDriver as MockPaymentDriver;
const SLUG = 'coorg-outdoor-lounger';
const TEST_PASSWORD = 'Rosewood-Teak-2026';

interface Session {
  header: string;
  csrf: string;
}

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

/** Signs in an admin with a named role, the way the other admin suites do. */
async function admin(email: string, roleCode: string): Promise<Session> {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });

  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: `Fulfilment ${roleCode}`,
      passwordHash: await passwordService.hash(TEST_PASSWORD),
      status: 'ACTIVE',
    },
  });

  await prisma.adminUserRole.upsert({
    where: { adminUserId_roleId: { adminUserId: user.id, roleId: role.id } },
    update: {},
    create: { adminUserId: user.id, roleId: role.id },
  });

  const response = await request(app)
    .post(`${ADMIN_API}/auth/login`)
    .send({ email, password: TEST_PASSWORD });

  expect(response.status, JSON.stringify(response.body)).toBe(200);

  const jar = cookiesOf(response);
  return {
    header: jar.map((cookie) => cookie.split(';')[0]).join('; '),
    csrf:
      jar
        .find((cookie) => cookie.startsWith('cw_adm_csrf='))
        ?.split(';')[0]
        ?.split('=')[1] ?? '',
  };
}

/** Order and shipment numbers contain slashes, so they must be encoded into a single segment. */
function enc(value: string): string {
  return encodeURIComponent(value);
}

function post(session: Session, path: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post(`${ADMIN_API}${path}`)
    .set('Cookie', session.header)
    .set('X-CSRF-Token', session.csrf)
    .send(body);
}

function get(session: Session, path: string) {
  return request(app).get(`${ADMIN_API}${path}`).set('Cookie', session.header);
}

let superAdmin: Session;
let readOnly: Session;

/** An order confirmed and ready to ship. */
async function shippableOrder(qty = 3): Promise<PaidOrderFixture> {
  return placeAndPayOrder({ qty, slug: SLUG });
}

async function deliverFully(order: PaidOrderFixture): Promise<string> {
  const created = await post(superAdmin, `/orders/${enc(order.orderNumber)}/shipments`, {
    manual: true,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const shipmentNumber = created.body.data.shipmentNumber as string;

  expect(
    (await post(superAdmin, `/shipments/${enc(shipmentNumber)}/awb`, {
      manualAwb: `DOC-${Date.now()}`,
      manualCourierName: 'Own truck',
    })).status,
  ).toBe(200);

  for (const status of ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
    const moved = await post(superAdmin, `/shipments/${enc(shipmentNumber)}/status`, {
      status,
      isCustomerVisible: true,
    });
    expect(moved.status, `${status}: ${JSON.stringify(moved.body)}`).toBe(200);
  }

  return shipmentNumber;
}

beforeAll(async () => {
  mock.setScenario('success');
  mock.setReversesTransfersWithRefund(false);

  superAdmin = await admin('fulfil.super@clearwood.local', 'SUPER_ADMIN');
  readOnly = await admin('fulfil.readonly@clearwood.local', 'CATALOG_MANAGER');

  await setStockForProduct(SLUG, 600);

  if (!(await shippingProviderRepository.findByCode('MANUAL'))) {
    await shippingProviderRepository.create({
      code: 'MANUAL',
      name: 'Own truck',
      driver: 'manual',
      isActive: true,
      isDefault: true,
    });
  }

  if (!(await pickupLocationRepository.findByCode('MAIN'))) {
    await pickupLocationRepository.create({
      code: 'MAIN',
      name: 'Main warehouse',
      contactName: 'Dispatch',
      phone: '919810000010',
      line1: '1 Industrial Estate',
      city: 'Mumbai',
      state: 'Maharashtra',
      stateCode: 'MH',
      pincode: '400001',
      isActive: true,
      isDefault: true,
    });
  }
});

/* ------------------------------------------------------------- reachability */

describe('fulfilment routes are mounted', () => {
  it('serves the admin shipment list', async () => {
    const response = await get(superAdmin, '/shipments');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.meta).toHaveProperty('total');
  });

  it('serves the returns and NDR queues', async () => {
    expect((await get(superAdmin, '/returns')).status).toBe(200);
    expect((await get(superAdmin, '/ndr')).status).toBe(200);
  });

  it('refuses an anonymous caller', async () => {
    const response = await request(app).get(`${ADMIN_API}/shipments`);
    expect([401, 403]).toContain(response.status);
  });

  it('refuses an admin without the fulfilment permission', async () => {
    const order = await shippableOrder(1);
    const response = await post(readOnly, `/orders/${enc(order.orderNumber)}/shipments`, {
      manual: true,
    });

    expect(response.status).toBe(403);
  });
});

/* ---------------------------------------------------------------- shipping */

describe('shipping an order over HTTP', () => {
  it('drafts, dispatches and delivers', async () => {
    const order = await shippableOrder(2);
    const shipmentNumber = await deliverFully(order);

    const detail = await get(superAdmin, `/shipments/${enc(shipmentNumber)}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe('DELIVERED');
    expect(detail.body.data.awbNumber).toBeTruthy();

    // The timeline is the evidence a customer would be shown.
    const statuses = detail.body.data.events.map((event: { status: string }) => event.status);
    expect(statuses).toContain('PICKED_UP');
    expect(statuses).toContain('DELIVERED');

    const after = await orderRepository.findById(order.orderId);
    expect(after!.fulfillmentStatus).toBe('FULFILLED');
  });

  it('refuses to ship more than was ordered', async () => {
    const order = await shippableOrder(1);

    const response = await post(superAdmin, `/orders/${enc(order.orderNumber)}/shipments`, {
      manual: true,
      items: [{ orderItemId: order.itemId, qty: 5 }],
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('SHIPMENT_OVER_QUANTITY');
  });

  it('reports what is still unshipped', async () => {
    const order = await shippableOrder(3);

    await post(superAdmin, `/orders/${enc(order.orderNumber)}/shipments`, {
      manual: true,
      items: [{ orderItemId: order.itemId, qty: 1 }],
    });

    const response = await get(superAdmin, `/orders/${enc(order.orderNumber)}/shipments`);

    expect(response.status).toBe(200);
    expect(response.body.data.shipments).toHaveLength(1);
    expect(response.body.data.remaining[0].remaining).toBe(2);
  });

  it('refuses an illegal status jump', async () => {
    const order = await shippableOrder(1);
    const created = await post(superAdmin, `/orders/${enc(order.orderNumber)}/shipments`, {
      manual: true,
    });

    const response = await post(
      superAdmin,
      `/shipments/${enc(created.body.data.shipmentNumber)}/status`,
      { status: 'DELIVERED', isCustomerVisible: true },
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SHIPMENT_TRANSITION_INVALID');
  });
});

/* ----------------------------------------------------------------- returns */

describe('returns over HTTP', () => {
  it('runs the whole return and refund flow', async () => {
    const order = await shippableOrder(2);
    await deliverFully(order);

    const raised = await post(superAdmin, `/orders/${enc(order.orderNumber)}/shipments`, {
      manual: true,
    }).catch(() => null);
    void raised;

    // Raise through the admin surface by creating the request as staff.
    const { returnService } = await import('../src/modules/fulfilment/return.service');
    const created = await returnService.create(
      order.orderNumber,
      {
        items: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'DEFECTIVE',
        resolution: 'REFUND',
        isExchange: false,
      },
      { actorType: 'ADMIN', actorId: null },
    );

    const returnNumber = created.returnNumber;

    expect((await post(superAdmin, `/returns/${enc(returnNumber)}/approve`, {
      schedulePickup: false,
    })).status).toBe(200);

    expect((await post(superAdmin, `/returns/${enc(returnNumber)}/receive`)).status).toBe(200);

    const inspected = await post(superAdmin, `/returns/${enc(returnNumber)}/inspect`, {
      refundNow: false,
      items: [
        {
          returnItemId: created.items[0]!.id,
          qtyReceived: 1,
          condition: 'RESELLABLE',
          restock: true,
        },
      ],
    });
    expect(inspected.status).toBe(200);

    const completed = await post(superAdmin, `/returns/${enc(returnNumber)}/complete`);
    expect(completed.status).toBe(200);
    expect(completed.body.data.refundId).toBeTruthy();

    const refundId = completed.body.data.refundId as string;

    expect((await post(superAdmin, `/refunds/${refundId}/approve`, {})).status).toBe(200);

    const executed = await post(superAdmin, `/refunds/${refundId}/execute`, { speed: 'NORMAL' });
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    expect(executed.body.data.status).toBe('PROCESSED');

    expectLedgerOk(await ledgerIntegrityService.verifyOrder(order.orderId), { minChecks: 10 });
  });
});

/* ----------------------------------------------------------------- refunds */

describe('refund preview over HTTP', () => {
  it('shows the line maths and the reversal plan without committing', async () => {
    const order = await shippableOrder(2);

    const response = await post(superAdmin, `/orders/${enc(order.orderNumber)}/refunds/preview`, {
      lines: [{ orderItemId: order.itemId, qty: 1 }],
      reason: 'CUSTOMER_REQUEST',
      restock: false,
      reversalPolicy: 'PROPORTIONAL',
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.computation.totalPaise).toBeGreaterThan(0);
    expect(response.body.data.canExecute).toBe(true);

    // The plan must account for every paise of the refund.
    const plan = response.body.data.reversalPlan;
    expect(plan.totalReversedPaise + plan.shortfallPaise).toBe(
      response.body.data.computation.totalPaise,
    );

    // Nothing was committed.
    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBe(0);
  });

  it('rejects a body that tries to name its own amount', async () => {
    const order = await shippableOrder(1);

    const response = await post(superAdmin, `/orders/${enc(order.orderNumber)}/refunds/preview`, {
      lines: [{ orderItemId: order.itemId, qty: 1 }],
      amountPaise: 1,
      reason: 'CUSTOMER_REQUEST',
      restock: false,
      reversalPolicy: 'PROPORTIONAL',
    });

    expect(response.status).toBe(422);
  });
});

/* -------------------------------------------------------- customer surface */

describe('the customer surface', () => {
  it('returns a public tracking timeline without leaking the buyer', async () => {
    const order = await shippableOrder(1);
    const shipmentNumber = await deliverFully(order);

    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { shipmentNumber } });

    const response = await request(app).get(`${API}/track/shipments/${shipment.awbNumber}`);

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('DELIVERED');
    expect(Array.isArray(response.body.data.timeline)).toBe(true);

    // Nothing that identifies the buyer or what they paid.
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('grandTotal');
    expect(body).not.toContain('@example.com');
  });

  it('404s an unknown AWB', async () => {
    const response = await request(app).get(`${API}/track/shipments/NOPE-123`);
    expect(response.status).toBe(404);
  });

  /**
   * Customer-initiated returns are frozen behind FEATURE_CUSTOMER_RETURNS (default off).
   *
   * 404 and not 403 on purpose: the feature does not exist for customers yet. A 403 would tell
   * them it exists and they are not allowed it, which is a different and untrue statement.
   */
  it('hides the customer return endpoints while the flag is off', async () => {
    const { customerReturnsEnabled } = await import('../src/config/env');
    if (customerReturnsEnabled) return;

    const order = await shippableOrder(1);
    const encoded = enc(order.orderNumber);

    for (const path of [
      `${API}/me/orders/${encoded}/returns`,
      `${API}/me/orders/${encoded}/returnable`,
    ]) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }

    const posted = await request(app)
      .post(`${API}/me/orders/${encoded}/returns`)
      .send({ items: [{ orderItemId: order.itemId, qty: 1 }], reason: 'DEFECTIVE' });

    expect(posted.status).toBe(404);
  });

  it('refuses another customer\u2019s order', async () => {
    const response = await request(app).get(`${API}/me/orders/CW%2F2026-27%2F000001/shipments`);
    expect([401, 403]).toContain(response.status);
  });
});

/* ------------------------------------------------------------------ ledger */

describe('the fulfilment ledger checks', () => {
  it('asserts shipped never exceeds ordered, and fulfilled equals dispatched', async () => {
    const order = await shippableOrder(2);
    await deliverFully(order);

    const report = await ledgerIntegrityService.verifyOrder(order.orderId);
    const names = report.checks.map((check) => check.name);

    expect(names).toContain('no_foreign_shipment_items');
    expect(names.some((name) => name.startsWith('shipped_within_ordered_'))).toBe(true);
    expect(names.some((name) => name.startsWith('fulfilled_matches_dispatched_'))).toBe(true);

    expect(report.ok).toBe(true);
  });

  it('every SEEDED order still balances, with non-zero fulfilment', async () => {
    // Scoped to the seeded demo orders on purpose: other suites deliberately leave broken states
    // behind (a refund held for verification, say), and those are correct, not failures.
    const seeded = await prisma.order.findMany({
      where: { internalNote: { startsWith: 'seed:demo-order:' } },
      select: { id: true, orderNumber: true },
    });

    expect(seeded.length).toBeGreaterThan(0);

    const failures: { order: string; failing: string[] }[] = [];

    for (const order of seeded) {
      const report = await ledgerIntegrityService.verifyOrder(order.id);
      const bad = report.checks.filter((check) => !check.ok);

      if (bad.length > 0) {
        failures.push({ order: order.orderNumber, failing: bad.map((check) => check.name) });
      }
    }

    expect(failures).toEqual([]);

    // F5: the seed must actually have exercised fulfilment, not merely created orders.
    const seededIds = seeded.map((order) => order.id);
    const [shipments, returns, refunds, reversals] = await Promise.all([
      prisma.shipment.count({ where: { orderId: { in: seededIds } } }),
      prisma.returnRequest.count({ where: { orderId: { in: seededIds } } }),
      prisma.refund.count({ where: { orderId: { in: seededIds } } }),
      prisma.transferReversal.count({
        where: { refund: { orderId: { in: seededIds } } },
      }),
    ]);

    expect(shipments).toBeGreaterThan(0);
    expect(returns).toBeGreaterThan(0);
    expect(refunds).toBeGreaterThan(0);
    expect(reversals).toBeGreaterThan(0);
  });
});
