import { beforeAll, describe, expect, it } from 'vitest';

import { payment as paymentDriver } from '../src/container';
import type { MockPaymentDriver } from '../src/drivers/payment';
import { shipmentService } from '../src/modules/fulfilment/shipment.service';
import {
  deriveFulfilledQuantities,
  deriveFulfillmentStatus,
  isDispatched,
} from '../src/modules/fulfilment/shipmentStateMachine';
import { trackingService } from '../src/modules/fulfilment/tracking.service';
import { orderStateMachine } from '../src/modules/orders/orderStateMachine';
import { orderRepository } from '../src/repositories/order.repository';
import {
  pickupLocationRepository,
  shippingProviderRepository,
} from '../src/repositories/shipment.repository';

import { placeAndPayOrder, type PaidOrderFixture } from './helpers/paidOrder';
import { setStockForProduct } from './helpers/stock';

/**
 * Item 5 - fulfilment status wiring.
 *
 * `Order.fulfillmentStatus` and `OrderItem.fulfilledQty` were declared in Prompt 9A and read by the
 * order DTOs, but nothing ever wrote them. These tests pin the derivation down: fulfilment is about
 * goods physically leaving, it is derived rather than counted, and it is deliberately independent
 * of the order's own status.
 */

const mock = paymentDriver as MockPaymentDriver;
const SLUG = 'konark-storage-bench';
const ADMIN = { actorType: 'ADMIN' as const, actorId: null };

beforeAll(async () => {
  mock.setScenario('success');

  await setStockForProduct(SLUG, 900);

  // Manual fulfilment needs a provider row and somewhere to ship from.
  const existing = await shippingProviderRepository.findByCode('MANUAL');
  if (!existing) {
    await shippingProviderRepository.create({
      code: 'MANUAL',
      name: 'Manual dispatch',
      driver: 'manual',
      isActive: true,
      isDefault: true,
    });
  }

  const pickup = await pickupLocationRepository.findByCode('MAIN');
  if (!pickup) {
    await pickupLocationRepository.create({
      code: 'MAIN',
      name: 'Main warehouse',
      contactName: 'Warehouse',
      phone: '919810000000',
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

/** Takes an order to a state from which shipments are legitimate. */
async function confirmedOrder(qty = 3): Promise<PaidOrderFixture> {
  const order = await placeAndPayOrder({ qty, slug: SLUG });
  return order;
}

/**
 * Dispatches a manual shipment the way an admin does: record the transporter's docket, then mark
 * it collected. Manual fulfilment has no courier API, so the AWB is typed in.
 */
async function dispatch(shipmentNumber: string): Promise<void> {
  await shipmentService.assignAwb(
    shipmentNumber,
    { manualAwb: `DOCKET-${shipmentNumber.slice(-6)}`, manualCourierName: 'Own truck' },
    ADMIN,
  );

  await trackingService.setStatus(
    shipmentNumber,
    { status: 'PICKED_UP', isCustomerVisible: true },
    ADMIN,
  );
}

async function readOrder(orderId: string) {
  const order = await orderRepository.findById(orderId);
  return {
    fulfillmentStatus: order!.fulfillmentStatus,
    status: order!.status,
    fulfilledQty: order!.items[0]!.fulfilledQty,
  };
}

/* ------------------------------------------------------------ pure derivation */

describe('deriveFulfillmentStatus (pure)', () => {
  const shippable = new Map([['a', 2], ['b', 3]]);

  it('is UNFULFILLED when nothing has gone out', () => {
    expect(deriveFulfillmentStatus(shippable, new Map(), 'CONFIRMED')).toBe('UNFULFILLED');
  });

  it('is PARTIALLY_FULFILLED when some has', () => {
    expect(
      deriveFulfillmentStatus(shippable, new Map([['a', 2]]), 'SHIPPED'),
    ).toBe('PARTIALLY_FULFILLED');
  });

  it('is FULFILLED only when every shippable unit has gone', () => {
    expect(
      deriveFulfillmentStatus(shippable, new Map([['a', 2], ['b', 3]]), 'DELIVERED'),
    ).toBe('FULFILLED');
  });

  it('never counts a line beyond what it owes', () => {
    // A duplicate shipment row must not push the order past FULFILLED or fake completeness.
    expect(
      deriveFulfillmentStatus(shippable, new Map([['a', 99]]), 'SHIPPED'),
    ).toBe('PARTIALLY_FULFILLED');
  });

  it('is CANCELLED when the order is', () => {
    expect(deriveFulfillmentStatus(shippable, new Map([['a', 2]]), 'CANCELLED')).toBe('CANCELLED');
    expect(deriveFulfillmentStatus(shippable, new Map(), 'EXPIRED')).toBe('CANCELLED');
  });

  it('does not call an order with nothing to ship FULFILLED', () => {
    // Every line cancelled: "all fulfilled" would be vacuously true and a lie.
    expect(deriveFulfillmentStatus(new Map(), new Map(), 'CONFIRMED')).toBe('UNFULFILLED');
  });

  it('stays FULFILLED once the goods went out, even if a return is raised', () => {
    expect(
      deriveFulfillmentStatus(shippable, new Map([['a', 2], ['b', 3]]), 'RETURN_REQUESTED'),
    ).toBe('FULFILLED');
  });
});

describe('deriveFulfilledQuantities (pure)', () => {
  const items = [{ orderItemId: 'a', qty: 2 }];

  it('counts only dispatched forward shipments', () => {
    expect(isDispatched('PICKED_UP')).toBe(true);
    expect(isDispatched('DELIVERED')).toBe(true);
    // Packed but not collected is not dispatched.
    expect(isDispatched('AWB_ASSIGNED')).toBe(false);
    expect(isDispatched('READY')).toBe(false);
  });

  it('ignores a cancelled shipment', () => {
    const result = deriveFulfilledQuantities([
      { status: 'CANCELLED', direction: 'FORWARD', items },
    ]);
    expect(result.get('a')).toBeUndefined();
  });

  it('ignores goods coming back', () => {
    const result = deriveFulfilledQuantities([
      { status: 'DELIVERED', direction: 'REVERSE', items },
    ]);
    expect(result.get('a')).toBeUndefined();
  });

  it('does not count a parcel returning to origin', () => {
    const result = deriveFulfilledQuantities([
      { status: 'RTO_INITIATED', direction: 'FORWARD', items },
    ]);
    expect(result.get('a')).toBeUndefined();
  });

  it('sums across several parcels', () => {
    const result = deriveFulfilledQuantities([
      { status: 'PICKED_UP', direction: 'FORWARD', items: [{ orderItemId: 'a', qty: 1 }] },
      { status: 'DELIVERED', direction: 'FORWARD', items: [{ orderItemId: 'a', qty: 2 }] },
    ]);
    expect(result.get('a')).toBe(3);
  });
});

/* ------------------------------------------------------------- persistence */

describe('fulfilment status is persisted and read back', () => {
  it('starts UNFULFILLED with no fulfilled units', async () => {
    const order = await confirmedOrder(3);
    const state = await readOrder(order.orderId);

    expect(state.fulfillmentStatus).toBe('UNFULFILLED');
    expect(state.fulfilledQty).toBe(0);
  });

  it('stays UNFULFILLED while the parcel is only packed', async () => {
    const order = await confirmedOrder(2);

    await shipmentService.create(order.orderNumber, { manual: true }, ADMIN);

    // A draft shipment is a packing decision, not a dispatch.
    const state = await readOrder(order.orderId);
    expect(state.fulfillmentStatus).toBe('UNFULFILLED');
    expect(state.fulfilledQty).toBe(0);
  });

  it('becomes PARTIALLY_FULFILLED when one of two parcels is collected', async () => {
    const order = await confirmedOrder(4);

    const first = await shipmentService.create(
      order.orderNumber,
      { manual: true, items: [{ orderItemId: order.itemId, qty: 1 }] },
      ADMIN,
    );

    await dispatch(first.shipmentNumber);

    const state = await readOrder(order.orderId);
    expect(state.fulfillmentStatus).toBe('PARTIALLY_FULFILLED');
    expect(state.fulfilledQty).toBe(1);
  });

  it('becomes FULFILLED once every unit has gone out', async () => {
    const order = await confirmedOrder(2);

    const shipment = await shipmentService.create(order.orderNumber, { manual: true }, ADMIN);

    await dispatch(shipment.shipmentNumber);

    const state = await readOrder(order.orderId);
    expect(state.fulfillmentStatus).toBe('FULFILLED');
    expect(state.fulfilledQty).toBe(2);
  });

  it('is exposed on the order DTO', async () => {
    const order = await confirmedOrder(2);
    const shipment = await shipmentService.create(order.orderNumber, { manual: true }, ADMIN);

    await dispatch(shipment.shipmentNumber);

    const { orderService } = await import('../src/modules/orders/order.service');
    const dto = await orderService.detailForAdmin(order.orderId);

    expect(dto.fulfillmentStatus).toBe('FULFILLED');
    expect(dto.order.items[0]!.fulfilledQty).toBe(2);
  });
});

/* --------------------------------------------------------------- idempotence */

describe('fulfilment sync is idempotent', () => {
  it('syncing repeatedly does not inflate the counts', async () => {
    const order = await confirmedOrder(2);
    const shipment = await shipmentService.create(order.orderNumber, { manual: true }, ADMIN);

    await dispatch(shipment.shipmentNumber);

    const first = await readOrder(order.orderId);

    // Derived, not incremented: running it again must land on exactly the same numbers.
    await shipmentService.syncFulfillment(order.orderId);
    await shipmentService.syncFulfillment(order.orderId);

    const second = await readOrder(order.orderId);

    expect(second.fulfilledQty).toBe(first.fulfilledQty);
    expect(second.fulfillmentStatus).toBe(first.fulfillmentStatus);
  });

  it('a repeated identical shipment status leaves fulfilment unchanged', async () => {
    const order = await confirmedOrder(2);
    const shipment = await shipmentService.create(order.orderNumber, { manual: true }, ADMIN);

    await dispatch(shipment.shipmentNumber);
    const before = await readOrder(order.orderId);

    // The state machine treats a no-op transition as a no-op.
    await trackingService.setStatus(
      shipment.shipmentNumber,
      { status: 'PICKED_UP', isCustomerVisible: true },
      ADMIN,
    );

    const after = await readOrder(order.orderId);
    expect(after.fulfilledQty).toBe(before.fulfilledQty);
    expect(after.fulfillmentStatus).toBe(before.fulfillmentStatus);
  });
});

/* ------------------------------------------------------ invalid and failure paths */

describe('invalid transitions and consistency', () => {
  it('rejects an illegal shipment transition and leaves fulfilment untouched', async () => {
    const order = await confirmedOrder(2);
    const shipment = await shipmentService.create(order.orderNumber, { manual: true }, ADMIN);

    const before = await readOrder(order.orderId);

    // DRAFT cannot jump straight to DELIVERED.
    await expect(
      trackingService.setStatus(
        shipment.shipmentNumber,
        { status: 'DELIVERED', isCustomerVisible: true },
        ADMIN,
      ),
    ).rejects.toThrow(/cannot go from DRAFT to DELIVERED/);

    const after = await readOrder(order.orderId);
    expect(after.fulfillmentStatus).toBe(before.fulfillmentStatus);
    expect(after.fulfilledQty).toBe(before.fulfilledQty);
  });

  it('cancelling a dispatched shipment takes its units back out of fulfilment', async () => {
    const order = await confirmedOrder(2);
    const shipment = await shipmentService.create(order.orderNumber, { manual: true }, ADMIN);

    await dispatch(shipment.shipmentNumber);
    expect((await readOrder(order.orderId)).fulfillmentStatus).toBe('FULFILLED');

    await trackingService.setStatus(
      shipment.shipmentNumber,
      { status: 'CANCELLATION_REQUESTED', isCustomerVisible: false },
      ADMIN,
    );
    await trackingService.setStatus(
      shipment.shipmentNumber,
      { status: 'CANCELLED', isCustomerVisible: true },
      ADMIN,
    );

    // The goods never went anywhere after all, so the order is unfulfilled again.
    const after = await readOrder(order.orderId);
    expect(after.fulfillmentStatus).toBe('UNFULFILLED');
    expect(after.fulfilledQty).toBe(0);
  });

  it('an RTO parcel is not counted as fulfilled', async () => {
    const order = await confirmedOrder(2);
    const shipment = await shipmentService.create(order.orderNumber, { manual: true }, ADMIN);

    await dispatch(shipment.shipmentNumber);

    for (const status of ['IN_TRANSIT', 'UNDELIVERED', 'RTO_INITIATED'] as const) {
      await trackingService.setStatus(
        shipment.shipmentNumber,
        { status, isCustomerVisible: false },
        ADMIN,
      );
    }

    const after = await readOrder(order.orderId);
    expect(after.fulfillmentStatus).toBe('UNFULFILLED');
    expect(after.fulfilledQty).toBe(0);
  });

  it('fulfilment survives the order moving on to RETURN_REQUESTED', async () => {
    const order = await confirmedOrder(2);
    const shipment = await shipmentService.create(order.orderNumber, { manual: true }, ADMIN);

    await dispatch(shipment.shipmentNumber);
    await trackingService.setStatus(
      shipment.shipmentNumber,
      { status: 'DELIVERED', isCustomerVisible: true },
      ADMIN,
    );

    const delivered = await orderRepository.findById(order.orderId);
    await orderStateMachine.transition(delivered!, 'RETURN_REQUESTED', {
      actorType: 'SYSTEM',
      note: 'test',
    });

    await shipmentService.syncFulfillment(order.orderId);

    // The goods did go out. A return does not undo that.
    const after = await readOrder(order.orderId);
    expect(after.status).toBe('RETURN_REQUESTED');
    expect(after.fulfillmentStatus).toBe('FULFILLED');
  });

  it('syncing an order that does not exist is a no-op, not a crash', async () => {
    await expect(shipmentService.syncFulfillment('does-not-exist')).resolves.toBeUndefined();
  });
});
