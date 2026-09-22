import { ndrService } from '../../src/modules/fulfilment/ndr.service';
import { returnService } from '../../src/modules/fulfilment/return.service';
import { shipmentService } from '../../src/modules/fulfilment/shipment.service';
import { trackingService } from '../../src/modules/fulfilment/tracking.service';
import { orderStateMachine } from '../../src/modules/orders/orderStateMachine';
import { refundService } from '../../src/modules/payments/refund/refund.service';
import { orderRepository } from '../../src/repositories/order.repository';

import { log, prisma } from './context';

/**
 * Demo fulfilment, created by CALLING THE SAME SERVICES THE ROUTES CALL.
 *
 * Not a single row is hand-written. Every shipment goes through `shipment.service`, every status
 * change through `tracking.service`'s state machine, every return through `return.service`, and the
 * refund through the real reserve → provider → confirm path.
 *
 * That is the whole point of this file. A seed that INSERTs rows produces data that looks right and
 * proves nothing — it cannot catch an unmounted route, a broken state machine, or a service that
 * throws on its own happy path. This one exercises the code a human would.
 *
 * Four shapes:
 *   1. delivered in full, then a partial return, inspected and refunded;
 *   2. two parcels, one delivered and one still in transit (partial fulfilment);
 *   3. a failed delivery that raises an NDR and is sent back (RTO);
 *   4. a drafted shipment that is cancelled before it ever leaves.
 *
 * Idempotent: the whole step is skipped once any shipment exists.
 */

const ADMIN = { actorType: 'ADMIN' as const, actorId: null, actorName: 'Seed' };
const CUSTOMER = { actorType: 'CUSTOMER' as const, actorId: null, actorName: 'Seed' };

/** Walks an order to DELIVERED the way the fulfilment flow does. */
async function advanceOrder(orderId: string, to: string): Promise<void> {
  const order = await orderRepository.findById(orderId);
  if (!order || order.status === to) return;

  if (!orderStateMachine.canTransition(order.status as never, to as never)) return;

  await orderStateMachine.transition(order, to as never, {
    actorType: 'SYSTEM',
    note: 'demo fulfilment',
  });
}

async function dispatchManually(shipmentNumber: string, docket: string): Promise<void> {
  await shipmentService.assignAwb(
    shipmentNumber,
    { manualAwb: docket, manualCourierName: 'ClearWood Logistics' },
    ADMIN,
  );

  await trackingService.setStatus(
    shipmentNumber,
    { status: 'PICKED_UP', description: 'Collected from the workshop', isCustomerVisible: true },
    ADMIN,
  );
}

export async function seedDemoFulfilment(): Promise<void> {
  if ((await prisma.shipment.count()) > 0) {
    log('demo-fulfilment', 'skipped (shipments already exist)');
    return;
  }

  // CONFIRMED regardless of payment status: a COD order ships before it is paid, which is the
  // whole point of cash on delivery.
  const paidOrders = await prisma.order.findMany({
    where: { status: 'CONFIRMED' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, orderNumber: true },
  });

  if (paidOrders.length < 2) {
    log('demo-fulfilment', 'skipped (not enough paid orders)');
    return;
  }

  /* ---- 1. delivered in full, then a partial return that is refunded ---- */

  const first = paidOrders[0]!;
  await advanceOrder(first.id, 'PROCESSING');

  const shipment = await shipmentService.create(first.orderNumber, { manual: true }, ADMIN);
  await dispatchManually(shipment.shipmentNumber, 'CW-DOCKET-0001');

  for (const status of ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const) {
    await trackingService.setStatus(
      shipment.shipmentNumber,
      { status, isCustomerVisible: true },
      ADMIN,
    );
  }

  const order = await orderRepository.findById(first.id);
  const returnable = await returnService.returnableQuantities(order!);
  const line = returnable.find((entry) => entry.remaining > 0);

  if (line) {
    const request = await returnService.create(
      first.orderNumber,
      {
        items: [{ orderItemId: line.orderItemId, qty: 1 }],
        reason: 'DAMAGED_IN_TRANSIT',
        reasonNote: 'Corner scuffed in transit',
        resolution: 'REFUND',
        isExchange: false,
      },
      CUSTOMER,
    );

    await returnService.approve(request.returnNumber, { schedulePickup: false }, ADMIN);
    await returnService.markReceived(request.returnNumber, ADMIN);
    await returnService.inspect(
      request.returnNumber,
      {
        refundNow: false,
        items: [
          {
            returnItemId: request.items[0]!.id,
            qtyReceived: 1,
            condition: 'DAMAGED',
            // Damaged goods do not go back on the shelf.
            restock: false,
            note: 'Visible damage; written off',
          },
        ],
      },
      ADMIN,
    );

    const completed = await returnService.complete(request.returnNumber, ADMIN);

    // The refund runs the real path: reserve, provider, confirm, reverse the split.
    if (completed.refundId) {
      await refundService.approve(completed.refundId, ADMIN);
      await refundService.execute(completed.refundId, {}, ADMIN);
    }
  }

  /* ---- 2. two parcels, one delivered and one still moving ---- */

  const second = paidOrders[1]!;
  await advanceOrder(second.id, 'PROCESSING');

  const secondOrder = await orderRepository.findById(second.id);
  const remaining = await shipmentService.remainingQuantities(secondOrder!);
  const splittable = remaining.find((entry) => entry.remaining >= 2);

  if (splittable) {
    const parcelA = await shipmentService.create(
      second.orderNumber,
      { manual: true, items: [{ orderItemId: splittable.orderItemId, qty: 1 }] },
      ADMIN,
    );
    await dispatchManually(parcelA.shipmentNumber, 'CW-DOCKET-0002');
    await trackingService.setStatus(
      parcelA.shipmentNumber,
      { status: 'DELIVERED', isCustomerVisible: true },
      ADMIN,
    );

    const parcelB = await shipmentService.create(
      second.orderNumber,
      { manual: true, items: [{ orderItemId: splittable.orderItemId, qty: 1 }] },
      ADMIN,
    );
    await dispatchManually(parcelB.shipmentNumber, 'CW-DOCKET-0003');
    await trackingService.setStatus(
      parcelB.shipmentNumber,
      { status: 'IN_TRANSIT', isCustomerVisible: true },
      ADMIN,
    );
  } else {
    // Only one unit to give: a single parcel still in transit is the partial-fulfilment shape.
    const parcel = await shipmentService.create(second.orderNumber, { manual: true }, ADMIN);
    await dispatchManually(parcel.shipmentNumber, 'CW-DOCKET-0002');
    await trackingService.setStatus(
      parcel.shipmentNumber,
      { status: 'IN_TRANSIT', isCustomerVisible: true },
      ADMIN,
    );
  }

  /* ---- 3. a failed delivery, an NDR, and a return to origin ---- */

  const third = paidOrders[2];

  if (third) {
    await advanceOrder(third.id, 'PROCESSING');

    const rto = await shipmentService.create(third.orderNumber, { manual: true }, ADMIN);
    await dispatchManually(rto.shipmentNumber, 'CW-DOCKET-0004');

    await trackingService.setStatus(
      rto.shipmentNumber,
      { status: 'OUT_FOR_DELIVERY', isCustomerVisible: true },
      ADMIN,
    );

    // This raises the NDR through the tracking service, exactly as a courier update would.
    await trackingService.setStatus(
      rto.shipmentNumber,
      {
        status: 'UNDELIVERED',
        description: 'Customer unavailable; premises locked',
        isCustomerVisible: true,
      },
      ADMIN,
    );

    const open = await prisma.ndrRecord.findFirst({
      where: { shipment: { shipmentNumber: rto.shipmentNumber }, status: 'OPEN' },
    });

    if (open) {
      await ndrService.act(
        open.id,
        { action: 'RETURN', note: 'Two attempts failed; returning to origin' },
        ADMIN,
      );
    }
  }

  /* ---- 4. a parcel cancelled before it ever left ---- */

  const fourth = paidOrders[3] ?? paidOrders[0]!;
  const fourthOrder = await orderRepository.findById(fourth.id);
  const spare = (await shipmentService.remainingQuantities(fourthOrder!)).find(
    (entry) => entry.remaining > 0,
  );

  if (spare) {
    const cancelled = await shipmentService.create(
      fourth.orderNumber,
      { manual: true, items: [{ orderItemId: spare.orderItemId, qty: 1 }] },
      ADMIN,
    );

    await shipmentService.cancel(
      cancelled.shipmentNumber,
      { reason: 'Packed in error', force: false },
      ADMIN,
    );
  }

  const [shipments, returns, refunds, reversals] = await Promise.all([
    prisma.shipment.count(),
    prisma.returnRequest.count(),
    prisma.refund.count(),
    prisma.transferReversal.count(),
  ]);

  log(
    'demo-fulfilment',
    `${shipments} shipments, ${returns} returns, ${refunds} refunds, ${reversals} reversals`,
  );
}
