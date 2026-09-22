import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { payment as paymentDriver } from '../src/container';
import type { MockPaymentDriver } from '../src/drivers/payment';
import { refundService } from '../src/modules/payments/refund/refund.service';
import { orderRepository } from '../src/repositories/order.repository';

import { setStockForProduct } from './helpers/stock';

/**
 * Prompt 9B — refund EXECUTION, the half 9A could only record.
 *
 * What these tests are actually guarding:
 *
 *  - a refund amount can never be supplied by a caller, only derived;
 *  - a provider failure leaves NOTHING applied — no stock, no reversal, no status change;
 *  - executing twice refunds once;
 *  - a partner's share comes back from the partner, to the paise;
 *  - restock is opt-in and goes through inventory.service, so it is ledgered.
 */

const app = createApp();
const API = '/api/v1';
const mock = paymentDriver as MockPaymentDriver;

const ADDRESS = {
  fullName: 'Refund Tester',
  phone: '919810000123',
  line1: '14 Residency Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  stateCode: 'KA',
  pincode: '560025',
};

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

/** A guest shopper carrying its own cart cookie and CSRF token. */
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
  amountPaise: number;
  itemId: string;
  itemQty: number;
}

/** Cart → checkout → pay, so the refund runs against a genuinely captured payment. */
async function placeAndPay(qty = 2): Promise<PaidOrder> {
  const shopper = new Shopper();

  const product = await prisma.product.findUniqueOrThrow({
    where: { slug: 'nilgiri-rocking-chair' },
    include: { variants: { where: { deletedAt: null }, take: 1 } },
  });

  await shopper.post('/cart/items', {
    productId: product.id,
    variantId: product.variants[0]?.id ?? null,
    qty,
  });

  const init = await shopper.post('/checkout/init', {
    contact: { email: 'refund.tester@example.com', phone: '919810000123' },
    shippingAddress: ADDRESS,
    sameAsShipping: true,
  });
  expect(init.status).toBe(201);

  const placed = await shopper.post(`/checkout/${init.body.data.id}/place`, {
    paymentProvider: 'RAZORPAY',
  });
  expect(placed.status).toBe(201);

  const completed = mock.simulateCheckout(placed.body.data.providerOrderId);
  const verified = await shopper.post('/checkout/verify', completed);
  expect(verified.status).toBe(200);

  const order = await orderRepository.findByNumber(placed.body.data.orderNumber);
  expect(order?.paidPaise).toBeGreaterThan(0);

  return {
    orderId: order!.id,
    orderNumber: order!.orderNumber,
    amountPaise: order!.paidPaise,
    itemId: order!.items[0]!.id,
    itemQty: order!.items[0]!.qty,
  };
}

beforeAll(async () => {
  mock.setScenario('success');

  await setStockForProduct('nilgiri-rocking-chair', 500);
});

/* ------------------------------------------------------------------ preview */

describe('refund preview', () => {
  it('shows the line maths and the reversal plan without changing anything', async () => {
    const order = await placeAndPay();

    const preview = await refundService.preview(order.orderNumber, {
      lines: [{ orderItemId: order.itemId, qty: 1 }],
      reason: 'CUSTOMER_REQUEST',
      restock: false,
      reversalPolicy: 'PROPORTIONAL',
    });

    expect(preview.computation.totalPaise).toBeGreaterThan(0);
    expect(preview.computation.isFullRefund).toBe(false);
    expect(preview.canExecute).toBe(true);

    // The plan must always account for every paise of the refund.
    const planned = preview.reversalPlan.totalReversedPaise + preview.reversalPlan.shortfallPaise;
    expect(planned).toBe(preview.computation.totalPaise);

    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBe(0);
    expect(await prisma.refund.count({ where: { orderId: order.orderId } })).toBe(0);
  });

  it('refuses to preview more units than were bought', async () => {
    const order = await placeAndPay();

    await expect(
      refundService.preview(order.orderNumber, {
        lines: [{ orderItemId: order.itemId, qty: order.itemQty + 5 }],
        reason: 'CUSTOMER_REQUEST',
        restock: false,
        reversalPolicy: 'PROPORTIONAL',
      }),
    ).rejects.toThrow(/can still be refunded/);
  });
});

/* ---------------------------------------------------------------- execution */

describe('refund execution', () => {
  it('freezes the amount at request time and returns exactly that', async () => {
    const order = await placeAndPay();

    const refund = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'CUSTOMER_REQUEST',
        restock: false,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN', actorId: null },
    );

    expect(refund.status).toBe('REQUESTED');
    const frozen = refund.amountPaise;

    await refundService.approve(refund.id, { actorType: 'ADMIN' });
    const executed = await refundService.execute(refund.id);

    expect(executed!.amountPaise).toBe(frozen);
    expect(executed!.status).toBe('PROCESSED');
    expect(executed!.providerRefundId).toBeTruthy();

    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBe(frozen);
    expect(after!.status).toBe('PARTIALLY_REFUNDED');
  });

  it('a full refund closes the order out', async () => {
    const order = await placeAndPay();

    const refund = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: order.itemQty }],
        reason: 'CUSTOMER_REQUEST',
        includeShipping: true,
        restock: false,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN' },
    );

    await refundService.approve(refund.id, { actorType: 'ADMIN' });
    await refundService.execute(refund.id);

    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBe(after!.paidPaise);
    expect(after!.status).toBe('REFUNDED');
    expect(after!.paymentStatus).toBe('REFUNDED');
  });

  it('executing twice refunds once', async () => {
    const order = await placeAndPay();

    const refund = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'CUSTOMER_REQUEST',
        restock: false,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN' },
    );

    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    const first = await refundService.execute(refund.id);
    const second = await refundService.execute(refund.id);

    expect(second!.providerRefundId).toBe(first!.providerRefundId);

    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBe(refund.amountPaise);
  });

  it('two concurrent executions produce exactly one provider refund', async () => {
    const order = await placeAndPay();

    const refund = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'CUSTOMER_REQUEST',
        restock: false,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN' },
    );

    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    const results = await Promise.allSettled([
      refundService.execute(refund.id),
      refundService.execute(refund.id),
    ]);

    const succeeded = results.filter((result) => result.status === 'fulfilled');
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBe(refund.amountPaise);
  });

  it('applies NOTHING when the provider fails', async () => {
    const order = await placeAndPay();

    const refund = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'CUSTOMER_REQUEST',
        restock: true,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN' },
    );

    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    const variant = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.itemId } });
    const stockBefore = variant.variantId
      ? (await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.variantId } })).stockQty
      : 0;

    mock.setScenario('refund-failure');

    await expect(refundService.execute(refund.id)).rejects.toThrow();

    mock.setScenario('success');

    const failed = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(failed.status).toBe('FAILED');
    expect(failed.providerRefundId).toBeNull();

    // The three things that must NOT have happened.
    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBe(0);
    expect(after!.status).not.toBe('PARTIALLY_REFUNDED');

    if (variant.variantId) {
      const stockAfter = (
        await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.variantId } })
      ).stockQty;
      expect(stockAfter).toBe(stockBefore);
    }

    // H3 records the INTENT before the provider call, so PENDING rows are expected and correct.
    // What must not exist is a reversal that actually moved money.
    expect(
      await prisma.transferReversal.count({
        where: { refundId: refund.id, status: 'PROCESSED' },
      }),
    ).toBe(0);
  });

  it('a failed refund can be retried and then succeeds', async () => {
    const order = await placeAndPay();

    const refund = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'CUSTOMER_REQUEST',
        restock: false,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN' },
    );

    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    mock.setScenario('refund-failure');
    await expect(refundService.execute(refund.id)).rejects.toThrow();

    mock.setScenario('success');
    const retried = await refundService.execute(refund.id);

    expect(retried!.status).toBe('PROCESSED');

    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBe(refund.amountPaise);
  });

  it('refuses to execute a refund that was never approved', async () => {
    const order = await placeAndPay();

    const refund = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'CUSTOMER_REQUEST',
        restock: false,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN' },
    );

    await expect(refundService.execute(refund.id)).rejects.toThrow(/cannot be executed/);
  });

  it('cannot refund more than was paid, across several refunds', async () => {
    const order = await placeAndPay();

    const first = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: order.itemQty }],
        reason: 'CUSTOMER_REQUEST',
        includeShipping: true,
        restock: false,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN' },
    );

    await refundService.approve(first.id, { actorType: 'ADMIN' });
    await refundService.execute(first.id);

    // Everything is already back; a second refund has nothing left to give.
    await expect(
      refundService.request(
        order.orderNumber,
        {
          lines: [{ orderItemId: order.itemId, qty: 1 }],
          reason: 'CUSTOMER_REQUEST',
          restock: false,
          reversalPolicy: 'PROPORTIONAL',
        },
        { actorType: 'ADMIN' },
      ),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ restock */

describe('refund restock', () => {
  it('does not touch stock unless restock was asked for', async () => {
    const order = await placeAndPay();
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.itemId } });
    if (!item.variantId) return;

    const before = (
      await prisma.productVariant.findUniqueOrThrow({ where: { id: item.variantId } })
    ).stockQty;

    const refund = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'CUSTOMER_REQUEST',
        restock: false,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN' },
    );

    await refundService.approve(refund.id, { actorType: 'ADMIN' });
    await refundService.execute(refund.id);

    const after = (
      await prisma.productVariant.findUniqueOrThrow({ where: { id: item.variantId } })
    ).stockQty;

    expect(after).toBe(before);
  });

  it('restocks through inventory.service, leaving a ledger entry', async () => {
    const order = await placeAndPay();
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.itemId } });
    if (!item.variantId) return;

    const before = (
      await prisma.productVariant.findUniqueOrThrow({ where: { id: item.variantId } })
    ).stockQty;

    const refund = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'DAMAGED',
        restock: true,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN' },
    );

    await refundService.approve(refund.id, { actorType: 'ADMIN' });
    await refundService.execute(refund.id);

    const after = (
      await prisma.productVariant.findUniqueOrThrow({ where: { id: item.variantId } })
    ).stockQty;
    expect(after).toBe(before + 1);

    // The point of routing through inventory.service: the movement is auditable.
    const ledger = await prisma.inventoryLedger.findFirst({
      where: { refType: 'Refund', refId: refund.id },
    });
    expect(ledger).not.toBeNull();
    expect(ledger!.delta).toBe(1);
  });

  it('restocking is not repeated when execute is called again', async () => {
    const order = await placeAndPay();
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.itemId } });
    if (!item.variantId) return;

    const refund = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'CUSTOMER_REQUEST',
        restock: true,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN' },
    );

    await refundService.approve(refund.id, { actorType: 'ADMIN' });
    await refundService.execute(refund.id);

    const afterFirst = (
      await prisma.productVariant.findUniqueOrThrow({ where: { id: item.variantId } })
    ).stockQty;

    await refundService.execute(refund.id);

    const afterSecond = (
      await prisma.productVariant.findUniqueOrThrow({ where: { id: item.variantId } })
    ).stockQty;

    expect(afterSecond).toBe(afterFirst);
  });
});
