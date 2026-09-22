import { beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import { payment as paymentDriver } from '../src/container';
import type { MockPaymentDriver } from '../src/drivers/payment';
import { returnService } from '../src/modules/fulfilment/return.service';
import { ledgerIntegrityService } from '../src/modules/orders/ledgerIntegrity.service';
import { orderStateMachine } from '../src/modules/orders/orderStateMachine';
import { refundService } from '../src/modules/payments/refund/refund.service';
import { orderRepository } from '../src/repositories/order.repository';

import { placeAndPayOrder, type PaidOrderFixture } from './helpers/paidOrder';
import { expectLedgerOk } from './helpers/ledger';
import { setStockForProduct } from './helpers/stock';

/**
 * Prompt 9B - returns.
 *
 * The rules under test: only delivered goods come back, only once; the window binds customers and
 * not staff; approval and inspection are separate decisions; and ONLY resellable goods go back on
 * sale, through inventory.service so the movement is ledgered.
 */

const mock = paymentDriver as MockPaymentDriver;
const SLUG = 'mahseer-counter-stool';

const ADMIN = { actorType: 'ADMIN' as const, actorId: null };
const CUSTOMER = { actorType: 'CUSTOMER' as const, actorId: null };

type Actor = { actorType: 'ADMIN' | 'CUSTOMER' | 'SYSTEM'; actorId: string | null };

/** Takes an order all the way to DELIVERED so a return is legitimate. */
async function deliveredOrder(qty = 3): Promise<PaidOrderFixture> {
  const order = await placeAndPayOrder({ qty, slug: SLUG });

  for (const status of ['PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'] as const) {
    const current = await orderRepository.findById(order.orderId);
    await orderStateMachine.transition(current!, status, {
      actorType: 'SYSTEM',
      note: 'test fixture',
    });
  }

  return order;
}

async function raiseReturn(order: PaidOrderFixture, qty: number, actor: Actor = CUSTOMER) {
  return returnService.create(
    order.orderNumber,
    {
      items: [{ orderItemId: order.itemId, qty }],
      reason: 'DEFECTIVE',
      resolution: 'REFUND',
      isExchange: false,
    },
    actor,
  );
}

/** Approve everything requested. */
async function approveAll(returnNumber: string) {
  return returnService.approve(returnNumber, { schedulePickup: false }, ADMIN);
}

async function variantOf(orderItemId: string): Promise<string | null> {
  const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderItemId } });
  return item.variantId;
}

async function stockOf(variantId: string): Promise<number> {
  const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
  return variant.stockQty;
}

beforeAll(async () => {
  mock.setScenario('success');
  mock.setReversesTransfersWithRefund(false);

  await setStockForProduct(SLUG, 900);
});

/* ----------------------------------------------------------------- raising */

describe('raising a return', () => {
  it('copies the frozen line amounts rather than re-pricing', async () => {
    const order = await deliveredOrder(3);
    const request = await raiseReturn(order, 2);

    expect(request.status).toBe('REQUESTED');
    expect(request.items).toHaveLength(1);
    expect(request.items[0]!.qtyRequested).toBe(2);

    const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.itemId } });
    const perUnit = Math.round(line.lineTotalPaise / line.qty);

    expect(request.items[0]!.refundableAmountPaise).toBe(perUnit * 2);
    expect(request.requestedAmountPaise).toBe(perUnit * 2);
  });

  it('moves the order to RETURN_REQUESTED', async () => {
    const order = await deliveredOrder(2);
    await raiseReturn(order, 1);

    const after = await orderRepository.findById(order.orderId);
    expect(after!.status).toBe('RETURN_REQUESTED');
  });

  it('refuses more units than were bought', async () => {
    const order = await deliveredOrder(2);

    await expect(raiseReturn(order, 5)).rejects.toThrow(/can still be returned/);
  });

  it('will not let the same unit come back twice', async () => {
    const order = await deliveredOrder(2);

    await raiseReturn(order, 2);
    // Both units are already spoken for by the open request.
    await expect(raiseReturn(order, 1)).rejects.toThrow(/can still be returned/);
  });

  it('refuses an order that was never delivered', async () => {
    const order = await placeAndPayOrder({ qty: 1, slug: SLUG });

    await expect(raiseReturn(order, 1)).rejects.toThrow(/cannot be returned/);
  });

  it('closes the window for customers but not for staff', async () => {
    const order = await deliveredOrder(2);

    // Backdate the delivery well past the window.
    await prisma.orderStatusHistory.updateMany({
      where: { orderId: order.orderId, toStatus: 'DELIVERED' },
      data: { createdAt: new Date(Date.now() - 90 * 86_400_000) },
    });

    await expect(raiseReturn(order, 1, CUSTOMER)).rejects.toThrow(/Returns close/);

    // An admin may still accept it: goodwill is a business decision.
    const staffRaised = await raiseReturn(order, 1, ADMIN);
    expect(staffRaised.status).toBe('REQUESTED');
  });
});

/* --------------------------------------------------------------- approval */

describe('approving a return', () => {
  it('can approve fewer units than were asked for', async () => {
    const order = await deliveredOrder(3);
    const request = await raiseReturn(order, 3);

    const approved = await returnService.approve(
      request.returnNumber,
      { schedulePickup: false, items: [{ returnItemId: request.items[0]!.id, qtyApproved: 1 }] },
      ADMIN,
    );

    expect(approved.status).toBe('APPROVED');
    expect(approved.items[0]!.qtyApproved).toBe(1);

    // The money follows the approved quantity, not the requested one.
    const perUnit = Math.round(request.items[0]!.refundableAmountPaise / 3);
    expect(approved.approvedAmountPaise).toBe(perUnit);
  });

  it('refuses to approve more than was requested', async () => {
    const order = await deliveredOrder(2);
    const request = await raiseReturn(order, 1);

    await expect(
      returnService.approve(
        request.returnNumber,
        { schedulePickup: false, items: [{ returnItemId: request.items[0]!.id, qtyApproved: 2 }] },
        ADMIN,
      ),
    ).rejects.toThrow(/more units than were requested/);
  });

  it('rejecting puts the order back to DELIVERED', async () => {
    const order = await deliveredOrder(2);
    const request = await raiseReturn(order, 1);

    await returnService.reject(request.returnNumber, { reason: 'Outside policy' }, ADMIN);

    const after = await orderRepository.findById(order.orderId);
    expect(after!.status).toBe('DELIVERED');
  });
});

/* ------------------------------------------------------------- inspection */

describe('inspecting and completing', () => {
  it('restocks ONLY resellable goods, through inventory.service', async () => {
    const order = await deliveredOrder(2);
    const variantId = await variantOf(order.itemId);
    if (!variantId) return;

    const request = await raiseReturn(order, 2);
    await approveAll(request.returnNumber);
    await returnService.markReceived(request.returnNumber, ADMIN);

    const before = await stockOf(variantId);

    const inspected = await returnService.inspect(
      request.returnNumber,
      {
        refundNow: false,
        items: [
          {
            returnItemId: request.items[0]!.id,
            qtyReceived: 2,
            condition: 'RESELLABLE',
            restock: true,
          },
        ],
      },
      ADMIN,
    );

    expect(inspected.status).toBe('INSPECTED');

    await returnService.complete(request.returnNumber, ADMIN);

    expect(await stockOf(variantId)).toBe(before + 2);

    // The point of routing through inventory.service: the movement is auditable.
    const ledger = await prisma.inventoryLedger.findFirst({
      where: { refType: 'ReturnRequest', refId: request.id },
    });
    expect(ledger).not.toBeNull();
    expect(ledger!.delta).toBe(2);
  });

  it('does NOT restock damaged goods', async () => {
    const order = await deliveredOrder(2);
    const variantId = await variantOf(order.itemId);
    if (!variantId) return;

    const request = await raiseReturn(order, 2);
    await approveAll(request.returnNumber);
    await returnService.markReceived(request.returnNumber, ADMIN);

    const before = await stockOf(variantId);

    await returnService.inspect(
      request.returnNumber,
      {
        refundNow: false,
        items: [
          { returnItemId: request.items[0]!.id, qtyReceived: 2, condition: 'DAMAGED', restock: true },
        ],
      },
      ADMIN,
    );

    await returnService.complete(request.returnNumber, ADMIN);

    // A scratched stool put back on the shelf is a scratched stool sold to somebody else.
    expect(await stockOf(variantId)).toBe(before);
  });

  it('does NOT restock resellable goods the inspector did not ask back', async () => {
    const order = await deliveredOrder(2);
    const variantId = await variantOf(order.itemId);
    if (!variantId) return;

    const request = await raiseReturn(order, 2);
    await approveAll(request.returnNumber);
    await returnService.markReceived(request.returnNumber, ADMIN);

    const before = await stockOf(variantId);

    await returnService.inspect(
      request.returnNumber,
      {
        refundNow: false,
        items: [
          // Fit to sell, but a discontinued line we do not want back on the shelf.
          { returnItemId: request.items[0]!.id, qtyReceived: 2, condition: 'RESELLABLE', restock: false },
        ],
      },
      ADMIN,
    );

    await returnService.complete(request.returnNumber, ADMIN);

    expect(await stockOf(variantId)).toBe(before);
  });

  it('refuses an inspection claiming more arrived than was approved', async () => {
    const order = await deliveredOrder(3);
    const request = await raiseReturn(order, 3);

    await returnService.approve(
      request.returnNumber,
      { schedulePickup: false, items: [{ returnItemId: request.items[0]!.id, qtyApproved: 1 }] },
      ADMIN,
    );
    await returnService.markReceived(request.returnNumber, ADMIN);

    await expect(
      returnService.inspect(
        request.returnNumber,
        {
          refundNow: false,
          items: [
            { returnItemId: request.items[0]!.id, qtyReceived: 3, condition: 'RESELLABLE', restock: true },
          ],
        },
        ADMIN,
      ),
    ).rejects.toThrow(/More units arrived than were approved/);
  });

  it('completing raises a refund for what actually came back', async () => {
    const order = await deliveredOrder(3);
    const request = await raiseReturn(order, 3);

    await approveAll(request.returnNumber);
    await returnService.markReceived(request.returnNumber, ADMIN);
    await returnService.inspect(
      request.returnNumber,
      {
        refundNow: false,
        items: [
          // Only two of the three actually arrived.
          { returnItemId: request.items[0]!.id, qtyReceived: 2, condition: 'RESELLABLE', restock: true },
        ],
      },
      ADMIN,
    );

    const completed = await returnService.complete(request.returnNumber, ADMIN);

    expect(completed.status).toBe('COMPLETED');
    expect(completed.refundId).toBeTruthy();

    const refund = await prisma.refund.findUniqueOrThrow({
      where: { id: completed.refundId! },
      include: { items: true },
    });

    expect(refund.items[0]!.qty).toBe(2);
    expect(refund.status).toBe('REQUESTED');
  });

  it('an exchange completes without refunding', async () => {
    const order = await deliveredOrder(2);

    const request = await returnService.create(
      order.orderNumber,
      {
        items: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'SIZE_OR_FIT',
        resolution: 'EXCHANGE',
        isExchange: true,
      },
      CUSTOMER,
    );

    await approveAll(request.returnNumber);
    await returnService.markReceived(request.returnNumber, ADMIN);
    await returnService.inspect(
      request.returnNumber,
      {
        refundNow: false,
        items: [
          { returnItemId: request.items[0]!.id, qtyReceived: 1, condition: 'RESELLABLE', restock: true },
        ],
      },
      ADMIN,
    );

    const completed = await returnService.complete(request.returnNumber, ADMIN);

    expect(completed.status).toBe('COMPLETED');
    expect(completed.refundId).toBeNull();
  });

  it('the ledger still balances after a returned-and-refunded order', async () => {
    const order = await deliveredOrder(2);
    const request = await raiseReturn(order, 2);

    await approveAll(request.returnNumber);
    await returnService.markReceived(request.returnNumber, ADMIN);
    await returnService.inspect(
      request.returnNumber,
      {
        refundNow: false,
        items: [
          { returnItemId: request.items[0]!.id, qtyReceived: 2, condition: 'RESELLABLE', restock: true },
        ],
      },
      ADMIN,
    );

    const completed = await returnService.complete(request.returnNumber, ADMIN);

    await refundService.approve(completed.refundId!, ADMIN);
    await refundService.execute(completed.refundId!);

    expectLedgerOk(await ledgerIntegrityService.verifyOrder(order.orderId), { minChecks: 10 });
  });
});
