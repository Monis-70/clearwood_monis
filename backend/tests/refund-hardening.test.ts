import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { payment as paymentDriver } from '../src/container';
import type { MockPaymentDriver } from '../src/drivers/payment';
import { ledgerIntegrityService } from '../src/modules/orders/ledgerIntegrity.service';
import { reconciliationService } from '../src/modules/orders/reconciliation.service';
import { paymentAdminService } from '../src/modules/payments/paymentAdmin.service';
import { refundService } from '../src/modules/payments/refund/refund.service';
import { orderRepository } from '../src/repositories/order.repository';

import { expectNoInfrastructureFailures, runConcurrently } from './helpers/concurrency';

import { expectLedgerOk } from './helpers/ledger';
import { setStockForProduct } from './helpers/stock';

/**
 * The 9B hardening addendum, H1 to H6.
 *
 * These are the failure modes that only appear under concurrency or when a provider answers
 * ambiguously - which is to say, the ones that never show up in development and cost real money in
 * production.
 */

const app = createApp();
const API = '/api/v1';
const mock = paymentDriver as MockPaymentDriver;

const ADDRESS = {
  fullName: 'Hardening Tester',
  phone: '919810000456',
  line1: '22 Brigade Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  stateCode: 'KA',
  pincode: '560025',
};

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

class Shopper {
  private cookies = '';
  private csrf = '';

  private remember(response: request.Response): void {
    const jar = cookiesOf(response);
    if (jar.length === 0) return;

    this.cookies = jar.map((cookie) => cookie.split(';')[0]).join('; ');
    const token = jar
      .find((cookie) => cookie.startsWith('cw_csrf='))
      ?.split(';')[0]
      ?.split('=')[1];
    if (token) this.csrf = token;
  }

  async get(path: string): Promise<request.Response> {
    const response = await request(app).get(`${API}${path}`).set('Cookie', this.cookies);
    this.remember(response);
    return response;
  }

  async post(path: string, body: Record<string, unknown>): Promise<request.Response> {
    if (!this.csrf) await this.get('/cart');

    const response = await request(app)
      .post(`${API}${path}`)
      .set('Cookie', this.cookies)
      .set('x-csrf-token', this.csrf)
      .send(body);

    this.remember(response);
    return response;
  }
}

interface PaidOrder {
  orderId: string;
  orderNumber: string;
  paidPaise: number;
  itemId: string;
  itemQty: number;
}

async function placeAndPay(qty = 5): Promise<PaidOrder> {
  const shopper = new Shopper();

  const product = await prisma.product.findUniqueOrThrow({
    where: { slug: 'konark-storage-bench' },
    include: { variants: { where: { deletedAt: null }, take: 1 } },
  });

  await shopper.post('/cart/items', {
    productId: product.id,
    variantId: product.variants[0]?.id ?? null,
    qty,
  });

  const init = await shopper.post('/checkout/init', {
    contact: { email: 'hardening@example.com', phone: '919810000456' },
    shippingAddress: ADDRESS,
    sameAsShipping: true,
  });
  expect(init.status).toBe(201);

  const placed = await shopper.post(`/checkout/${init.body.data.id}/place`, {
    paymentProvider: 'RAZORPAY',
  });
  expect(placed.status).toBe(201);

  const completed = mock.simulateCheckout(placed.body.data.providerOrderId);
  expect((await shopper.post('/checkout/verify', completed)).status).toBe(200);

  const order = await orderRepository.findByNumber(placed.body.data.orderNumber);

  return {
    orderId: order!.id,
    orderNumber: order!.orderNumber,
    paidPaise: order!.paidPaise,
    itemId: order!.items[0]!.id,
    itemQty: order!.items[0]!.qty,
  };
}

async function requestRefund(order: PaidOrder, qty: number) {
  return refundService.request(
    order.orderNumber,
    {
      lines: [{ orderItemId: order.itemId, qty }],
      reason: 'CUSTOMER_REQUEST',
      restock: false,
      reversalPolicy: 'PROPORTIONAL',
    },
    { actorType: 'ADMIN' },
  );
}

beforeAll(async () => {
  mock.setScenario('success');
  mock.setReversesTransfersWithRefund(false);

  await setStockForProduct('konark-storage-bench', 900);
});

/* ------------------------------------------------------------------ H1 */

describe('H1 - execution is mutually exclusive at the database', () => {
  it('takes a lock that a second caller cannot take', async () => {
    const order = await placeAndPay();
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    const { refundRepository } = await import('../src/repositories/payment.repository');

    expect(await refundRepository.claimForExecution(refund.id, 'APPROVED')).toBe(true);
    // The lock is held, so the same claim must now fail even though the row still exists.
    expect(await refundRepository.claimForExecution(refund.id, 'PROCESSING')).toBe(false);

    const locked = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(locked.executionLockedAt).not.toBeNull();
    expect(locked.executionAttempt).toBe(1);
  });

  it('a stale lock is reclaimable only through reconciliation', async () => {
    const order = await placeAndPay();
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    // Simulate a worker that died holding the lock an hour ago.
    await prisma.refund.update({
      where: { id: refund.id },
      data: { status: 'PROCESSING', executionLockedAt: new Date(Date.now() - 3_600_000) },
    });

    // A user action must still refuse.
    await expect(refundService.execute(refund.id)).rejects.toThrow(/cannot be executed/);

    const { refundRepository } = await import('../src/repositories/payment.repository');
    const stale = await refundRepository.reclaimStaleLocks(new Date(Date.now() - 60_000));

    expect(stale.some((row) => row.id === refund.id)).toBe(true);
  });
});

/* ------------------------------------------------------------------ H2 */

describe('H2 - the over-refund guard is part of the write', () => {
  it('5 parallel refunds of 40% each yield exactly 2 successes', async () => {
    const order = await placeAndPay(5);

    // 2 of 5 units is 40% of the order, so three of these cannot all fit inside what was paid.
    const refunds: { id: string }[] = [];
    for (let i = 0; i < 5; i += 1) {
      const refund = await requestRefund(order, 2);
      await refundService.approve(refund.id, { actorType: 'ADMIN' });
      refunds.push(refund);
    }

    const result = await runConcurrently(refunds.length, (index) =>
      refundService.execute(refunds[index]!.id),
    );

    expectNoInfrastructureFailures(result);
    console.log(`[concurrency] refund H2 5x40%: ${JSON.stringify(result)}`);

    expect(result.ok).toBe(2);
    expect(result.contended, 'a refund lost a race instead of being refused').toBe(0);
    expect(result.refused).toBe(3);

    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBeLessThanOrEqual(after!.paidPaise);

    const ledger = await ledgerIntegrityService.verifyOrder(order.orderId);
    expect(
      ledger.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.expected} vs ${c.actual}`),
    ).toEqual([]);
  });

  it('a transfer is never reversed beyond what it holds', async () => {
    const order = await placeAndPay(2);
    const refund = await requestRefund(order, 2);

    await refundService.approve(refund.id, { actorType: 'ADMIN' });
    await refundService.execute(refund.id);

    const transfers = await prisma.paymentTransfer.findMany({
      where: { payment: { orderId: order.orderId } },
    });

    for (const transfer of transfers) {
      expect(transfer.reversedPaise).toBeLessThanOrEqual(transfer.amountPaise);
    }
  });
});

/* ------------------------------------------------------------------ H3 */

describe('H3 - a deterministic reference makes a retry adopt, not duplicate', () => {
  it('a crash after the provider call converges to exactly one refund', async () => {
    const order = await placeAndPay(2);
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    // The provider accepts it, then the answer is lost on the way back.
    mock.setScenario('refund-timeout');
    await expect(refundService.execute(refund.id)).rejects.toThrow(/did not confirm/);
    mock.setScenario('success');

    const held = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(held.status).toBe('PENDING_VERIFICATION');

    // Reconciliation is the only thing allowed to resolve it, and it must find the original.
    await reconciliationService.verifyPendingRefunds();

    const resolved = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(resolved.status).toBe('PROCESSED');
    expect(resolved.providerRefundId).toBeTruthy();

    // Exactly one provider refund exists for this reference.
    const payment = await prisma.payment.findFirstOrThrow({
      where: { orderId: order.orderId, status: 'CAPTURED' },
    });
    const atProvider = await paymentDriver.fetchRefundsForPayment(payment.providerPaymentId!);
    const matching = atProvider.filter(
      (entry) => entry.clientReference === (resolved.clientReference ?? resolved.refundNumber),
    );

    expect(matching).toHaveLength(1);

    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBe(refund.amountPaise);
  });
});

/* ------------------------------------------------------------------ H4 */

describe('H4 - a timeout is UNKNOWN, not FAILED', () => {
  it('TERMINAL rejection becomes FAILED', async () => {
    const order = await placeAndPay(2);
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    mock.setScenario('refund-failure');
    await expect(refundService.execute(refund.id)).rejects.toThrow(/rejected/);
    mock.setScenario('success');

    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(row.status).toBe('FAILED');
  });

  it('RETRYABLE network failure becomes FAILED with nothing charged', async () => {
    const order = await placeAndPay(2);
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    mock.setScenario('refund-unreachable');
    await expect(refundService.execute(refund.id)).rejects.toThrow(/could not be reached/);
    mock.setScenario('success');

    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(row.status).toBe('FAILED');

    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBe(0);
  });

  it('UNKNOWN timeout becomes PENDING_VERIFICATION', async () => {
    const order = await placeAndPay(2);
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    mock.setScenario('refund-timeout');
    await expect(refundService.execute(refund.id)).rejects.toThrow(/did not confirm/);
    mock.setScenario('success');

    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(row.status).toBe('PENDING_VERIFICATION');

    // Nothing may be applied while we do not know.
    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBe(0);
  });

  it('a PENDING_VERIFICATION refund cannot be re-executed by any route', async () => {
    const order = await placeAndPay(2);
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    mock.setScenario('refund-timeout');
    await expect(refundService.execute(refund.id)).rejects.toThrow();
    mock.setScenario('success');

    // The service refuses...
    await expect(refundService.execute(refund.id)).rejects.toThrow(/awaiting verification/);

    // ...and so does approval, so no route can walk it back into an executable state.
    await expect(refundService.approve(refund.id, { actorType: 'ADMIN' })).rejects.toThrow();
  });

  it('surfaces unverified refunds in the needs-attention queue, marked not-retryable', async () => {
    const order = await placeAndPay(2);
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    mock.setScenario('refund-timeout');
    await expect(refundService.execute(refund.id)).rejects.toThrow();
    mock.setScenario('success');

    const queue = await paymentAdminService.needsAttention();
    const entry = queue.refunds.find((row) => row.id === refund.id);

    expect(entry).toBeDefined();
    expect(entry!.status).toBe('PENDING_VERIFICATION');
    expect(entry!.canRetry).toBe(false);
    expect(entry!.reason).toMatch(/never confirmed/i);
  });
});

/* ------------------------------------------------------------------ H5 */

describe('H5 - reversals happen exactly once, under either driver shape', () => {
  it('EXPLICIT: we reverse, and the total equals the refund exactly once', async () => {
    mock.setReversesTransfersWithRefund(false);

    const order = await placeAndPay(2);
    const refund = await requestRefund(order, 2);

    await refundService.approve(refund.id, { actorType: 'ADMIN' });
    await refundService.execute(refund.id);

    const reversals = await prisma.transferReversal.findMany({
      where: { refundId: refund.id, status: 'PROCESSED' },
    });

    const total = reversals.reduce((sum, row) => sum + row.amountPaise, 0);
    expect(total).toBe(refund.amountPaise);

    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(row.reversalStrategy).toBe('EXPLICIT');
  });

  it('PROVIDER: the provider reverses, we record and do not reverse again', async () => {
    mock.setReversesTransfersWithRefund(true);

    const order = await placeAndPay(2);
    const refund = await requestRefund(order, 2);

    await refundService.approve(refund.id, { actorType: 'ADMIN' });
    await refundService.execute(refund.id);

    const reversals = await prisma.transferReversal.findMany({
      where: { refundId: refund.id, status: 'PROCESSED' },
    });

    const total = reversals.reduce((sum, row) => sum + row.amountPaise, 0);

    // The crucial assertion: once, not twice.
    expect(total).toBe(refund.amountPaise);

    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(row.reversalStrategy).toBe('PROVIDER');

    const transfers = await prisma.paymentTransfer.findMany({
      where: { payment: { orderId: order.orderId } },
    });
    for (const transfer of transfers) {
      expect(transfer.reversedPaise).toBeLessThanOrEqual(transfer.amountPaise);
    }

    mock.setReversesTransfersWithRefund(false);
  });
});

/* ------------------------------------------------------------------ H6 */

describe('H6 - the ledger accounts for every refund path', () => {
  it('balances after a partial refund with reversals', async () => {
    const order = await placeAndPay(4);
    const refund = await requestRefund(order, 2);

    await refundService.approve(refund.id, { actorType: 'ADMIN' });
    await refundService.execute(refund.id);

    expectLedgerOk(await ledgerIntegrityService.verifyOrder(order.orderId), { minChecks: 10 });
  });

  it('notices a refund stuck past the lock timeout', async () => {
    const order = await placeAndPay(2);
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    await prisma.refund.update({
      where: { id: refund.id },
      data: { status: 'PROCESSING', executionLockedAt: new Date(Date.now() - 3_600_000) },
    });

    const report = await ledgerIntegrityService.verifyOrder(order.orderId);
    const stuck = report.checks.find((entry) => entry.name === 'no_silently_stuck_refunds');

    expect(stuck).toBeDefined();
    expect(stuck!.ok).toBe(false);
  });

  it('exposes the needs-attention set over the API', async () => {
    const response = await request(app).get(`${API}/admin/payments/attention`);

    // Unauthenticated, so it must be refused rather than leak money state.
    expect([401, 403]).toContain(response.status);
  });
});
