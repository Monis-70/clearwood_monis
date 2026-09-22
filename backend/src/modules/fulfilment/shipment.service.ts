import type { ShipmentStatus } from '@shared/enums';
import type {
  AssignAwbInput as AssignAwbBody,
  SchedulePickupInput,
  ServiceabilityQuery,
  ShipmentCancelInput,
  ShipmentCreateInput,
} from '@shared/schemas/fulfilment';
import type { CourierOptionDto } from '@shared/types/fulfilment';

import { logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import type { CreateShipmentOrderInput, ProviderAddress } from '../../drivers/shipping';
import { orderRepository, type OrderWithDetail } from '../../repositories/order.repository';
import { paymentRepository } from '../../repositories/payment.repository';
import {
  pickupLocationRepository,
  shipmentEventRepository,
  shipmentRepository,
  type ShipmentWithDetail,
} from '../../repositories/shipment.repository';
import { AppError } from '../../utils/AppError';
import { notificationService } from '../notifications/notification.service';
import { orderStateMachine } from '../orders/orderStateMachine';

import { fulfilmentNumberService } from './fulfilmentNumber.service';
import { providerGateway } from './providerGateway.service';
import { assertTransition, deriveFulfilledQuantities, deriveFulfillmentStatus, deriveOrderStatus } from './shipmentStateMachine';

/** Derived order statuses the customer is emailed about. Anything absent is an internal move. */
const SHIPMENT_NOTIFICATIONS: Record<string, 'ORDER_SHIPPED' | 'OUT_FOR_DELIVERY' | 'ORDER_DELIVERED' | undefined> = {
  SHIPPED: 'ORDER_SHIPPED',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'ORDER_DELIVERED',
};

/**
 * Shipments: the bridge between a paid order and a parcel that physically moves.
 *
 * THE RULES THIS SERVICE EXISTS TO ENFORCE:
 *
 *  - **You cannot ship what you have not got.** Every create re-derives the remaining quantity per
 *    order line from the shipments that already exist. Over-shipping is rejected, not clamped.
 *  - **Partial shipment is normal.** A bed frame ships today and the mattress on Friday; both are
 *    real shipments with their own AWB, their own timeline and their own delivery date.
 *  - **The order status is derived, never set by hand.** `syncOrderStatus` recomputes it from the
 *    shipments, so an order cannot claim to be delivered while a parcel is still in transit.
 *  - **Stock left when the order was confirmed.** Shipping does not touch inventory — 9A already
 *    committed it. Only a RESTOCK on return puts anything back, and only via inventory.service.
 */

interface Actor {
  actorType: 'ADMIN' | 'SYSTEM' | 'CUSTOMER';
  actorId?: string | null;
  actorName?: string | null;
}

/** Order statuses from which it is legitimate to create a forward shipment. */
const SHIPPABLE_ORDER_STATUSES = [
  'CONFIRMED',
  'PROCESSING',
  'READY_TO_SHIP',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
];

function toProviderAddress(address: {
  fullName: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  country: string;
}, email: string | null): ProviderAddress {
  return {
    name: address.fullName,
    phone: address.phone,
    email,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    stateCode: address.stateCode,
    pincode: address.pincode,
    country: address.country,
  };
}

export const shipmentService = {
  /* ------------------------------------------------------------ mapping */

  /** The admin view: everything we know, including what the courier charged us. */
  toDto(shipment: ShipmentWithDetail) {
    return {
      id: shipment.id,
      shipmentNumber: shipment.shipmentNumber,
      orderId: shipment.orderId,
      direction: shipment.direction,
      status: shipment.status,
      providerCode: shipment.providerCode,
      awbNumber: shipment.awbNumber,
      courierName: shipment.providerCourierName,
      providerStatus: shipment.providerStatus,
      isCod: shipment.isCod,
      codAmountPaise: shipment.codAmountPaise,
      shippingCostPaise: shipment.shippingCostPaise,
      weightGrams: shipment.weightGrams,
      packageCount: shipment.packageCount,
      packagingType: shipment.packagingType,
      pickupScheduledAt: shipment.pickupScheduledAt?.toISOString() ?? null,
      estimatedDeliveryAt: shipment.estimatedDeliveryAt?.toISOString() ?? null,
      shippedAt: shipment.shippedAt?.toISOString() ?? null,
      deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
      cancelledAt: shipment.cancelledAt?.toISOString() ?? null,
      cancelReason: shipment.cancelReason,
      internalNote: shipment.internalNote,
      items: shipment.items.map((item) => ({
        orderItemId: item.orderItemId,
        qty: item.qty,
        sku: item.sku,
        productName: item.productName,
        variantName: item.variantName,
      })),
      events: shipment.events.map((event) => ({
        status: event.status,
        description: event.description,
        location: event.location,
        source: event.source,
        occurredAt: event.occurredAt.toISOString(),
        isCustomerVisible: event.isCustomerVisible,
      })),
      openNdrs: shipment.ndrs.filter((ndr) => ndr.status === 'OPEN' || ndr.status === 'ACTION_REQUESTED')
        .length,
      createdAt: shipment.createdAt.toISOString(),
    };
  },

  /**
   * The customer view.
   *
   * What it leaves out is the point: our cost, the COD float, internal notes, and any event an
   * admin marked not-customer-visible.
   */
  toCustomerDto(shipment: ShipmentWithDetail) {
    return {
      shipmentNumber: shipment.shipmentNumber,
      status: shipment.status,
      courierName: shipment.providerCourierName,
      awbNumber: shipment.awbNumber,
      estimatedDeliveryAt: shipment.estimatedDeliveryAt?.toISOString() ?? null,
      shippedAt: shipment.shippedAt?.toISOString() ?? null,
      deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
      items: shipment.items.map((item) => ({
        qty: item.qty,
        sku: item.sku,
        productName: item.productName,
        variantName: item.variantName,
      })),
      timeline: shipment.events
        .filter((event) => event.isCustomerVisible)
        .map((event) => ({
          status: event.status,
          description: event.description,
          location: event.location,
          occurredAt: event.occurredAt.toISOString(),
        })),
    };
  },

  /** Public AWB lookup: the timeline and nothing that identifies the buyer. */
  toPublicTrackingDto(shipment: ShipmentWithDetail) {
    return {
      awbNumber: shipment.awbNumber,
      status: shipment.status,
      courierName: shipment.providerCourierName,
      estimatedDeliveryAt: shipment.estimatedDeliveryAt?.toISOString() ?? null,
      deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
      timeline: shipment.events
        .filter((event) => event.isCustomerVisible)
        .map((event) => ({
          status: event.status,
          description: event.description,
          location: event.location,
          occurredAt: event.occurredAt.toISOString(),
        })),
    };
  },

  /* ------------------------------------------------------------ reading */

  async getByNumber(shipmentNumber: string): Promise<ShipmentWithDetail> {
    const shipment = await shipmentRepository.findByNumber(shipmentNumber);
    if (!shipment) throw AppError.notFound('Shipment not found');
    return shipment;
  },

  listForOrder(orderId: string) {
    return shipmentRepository.listForOrder(orderId);
  },

  listForAdmin(query: Parameters<typeof shipmentRepository.listForAdmin>[0]) {
    return shipmentRepository.listForAdmin(query);
  },

  /**
   * What is still waiting to be shipped on this order.
   *
   * Derived every time rather than tracked in a column, because a counter that drifts is a counter
   * that eventually lets a customer be sent two of something.
   */
  async remainingQuantities(order: OrderWithDetail) {
    const shipped = await shipmentRepository.shippedQtyByOrderItem(order.id);

    return order.items.map((item) => {
      const already = shipped.get(item.id) ?? 0;
      // Cancelled units were never going to move.
      const shippable = Math.max(item.qty - item.cancelledQty, 0);

      return {
        orderItemId: item.id,
        sku: item.sku,
        productName: item.productName,
        variantName: item.variantName,
        ordered: item.qty,
        cancelled: item.cancelledQty,
        shipped: already,
        remaining: Math.max(shippable - already, 0),
        weightGrams: item.weightGrams ?? 0,
        unitPricePaise: item.unitPricePaise,
        lineTotalPaise: item.lineTotalPaise,
        hsnCode: item.hsnCode,
        taxRateBp: item.taxRateBp,
        lineDiscountPaise: item.lineDiscountPaise,
      };
    });
  },

  /* ----------------------------------------------------------- creation */

  /**
   * Creates a DRAFT shipment against an order.
   *
   * Nothing is sent to the courier here. A draft is a packing decision — which lines, which boxes,
   * which pickup point — and it stays entirely ours until somebody asks for an AWB. That separation
   * is what makes the provider call idempotent later: by then the shipment already has an identity.
   */
  async create(
    orderNumber: string,
    input: ShipmentCreateInput,
    actor: Actor,
  ): Promise<ShipmentWithDetail> {
    const order = await orderRepository.findByNumber(orderNumber);
    if (!order) throw AppError.notFound('Order not found');

    if (!SHIPPABLE_ORDER_STATUSES.includes(order.status)) {
      throw new AppError(
        422,
        'ORDER_NOT_SHIPPABLE',
        `An order in ${order.status} cannot be shipped`,
        { status: order.status },
      );
    }

    const remaining = await this.remainingQuantities(order);
    const byItem = new Map(remaining.map((entry) => [entry.orderItemId, entry]));

    // Omitting `items` means "everything still unfulfilled", which is the common case: one parcel,
    // the whole order, no line-picking.
    const requested =
      input.items ??
      remaining
        .filter((entry) => entry.remaining > 0)
        .map((entry) => ({ orderItemId: entry.orderItemId, qty: entry.remaining }));

    // Validate the whole request before writing anything: a half-accepted shipment is worse than a
    // rejected one.
    const lines = requested.map((line) => {
      const entry = byItem.get(line.orderItemId);

      if (!entry) {
        throw new AppError(422, 'SHIPMENT_ITEM_INVALID', 'That line is not on this order', {
          orderItemId: line.orderItemId,
        });
      }

      if (line.qty > entry.remaining) {
        throw new AppError(
          422,
          'SHIPMENT_OVER_QUANTITY',
          `Only ${entry.remaining} of ${entry.sku} is left to ship`,
          { orderItemId: line.orderItemId, requested: line.qty, remaining: entry.remaining },
        );
      }

      return { line, entry };
    });

    if (lines.length === 0) {
      throw new AppError(
        422,
        'SHIPMENT_EMPTY',
        'There is nothing left on this order to ship',
      );
    }

    // `manual: true` records a shipment somebody arranged by hand, so it must not be pushed to a
    // courier API even when one is configured.
    const provider = await providerGateway.resolve(
      input.manual ? 'MANUAL' : (input.providerCode ?? null),
    );

    const pickup = input.pickupLocationCode
      ? await pickupLocationRepository.findByCode(input.pickupLocationCode)
      : await pickupLocationRepository.findDefault();

    if (!pickup) {
      throw new AppError(
        422,
        'PICKUP_LOCATION_MISSING',
        'No pickup location is configured to ship from',
      );
    }

    // Weight defaults to the sum of the line weights; an admin override wins because they are the
    // one holding the box.
    const derivedWeight = lines.reduce(
      (total: number, { line, entry }) => total + entry.weightGrams * line.qty,
      0,
    );

    const declaredValuePaise = lines.reduce(
      (total: number, { line, entry }) => total + entry.unitPricePaise * line.qty,
      0,
    );

    // COD is a payment attempt with provider 'COD', not a column on the order.
    const payments = await paymentRepository.forOrder(order.id);
    const isCod = payments.some((payment) => payment.provider === 'COD');
    const existingShipmentCount = (await shipmentRepository.listForOrder(order.id)).filter(
      (entry) => entry.status !== 'CANCELLED',
    ).length;

    const { number: shipmentNumber } = await fulfilmentNumberService.shipment();

    const shipment = await prisma.$transaction(async (tx) =>
      shipmentRepository.create(
        {
          shipmentNumber,
          order: { connect: { id: order.id } },
          direction: 'FORWARD',
          status: 'DRAFT',
          provider: { connect: { id: provider.row.id } },
          providerCode: provider.row.code,
          pickupLocation: { connect: { id: pickup.id } },
          isCod,
          // COD is collected once, on the FIRST parcel — never once per box.
          codAmountPaise: isCod && existingShipmentCount === 0 ? order.duePaise : 0,
          weightGrams: input.package?.weightGrams ?? derivedWeight,
          lengthMm: input.package?.lengthMm ?? 0,
          widthMm: input.package?.widthMm ?? 0,
          heightMm: input.package?.heightMm ?? 0,
          packageCount: input.package?.packageCount ?? 1,
          packagingType: input.package?.packagingType ?? 'BOX',
          declaredValuePaise,
          internalNote: input.note ?? null,
          items: {
            create: lines.map(({ line, entry }) => ({
              orderItem: { connect: { id: line.orderItemId } },
              qty: line.qty,
              sku: entry.sku,
              productName: entry.productName,
              variantName: entry.variantName,
            })),
          },
        },
        tx,
      ),
    );

    await shipmentEventRepository.append({
      shipmentId: shipment.id,
      status: 'DRAFT',
      description: `Shipment ${shipmentNumber} created with ${lines.length} line(s)`,
      source: actor.actorType === 'ADMIN' ? 'ADMIN' : 'SYSTEM',
      isCustomerVisible: false,
    });

    await this.syncOrderStatus(order.id, actor);

    logger.info(
      { shipmentNumber, orderNumber, provider: provider.row.code },
      'shipment drafted',
    );

    return (await shipmentRepository.findByNumber(shipmentNumber))!;
  },

  /* ------------------------------------------------------ serviceability */

  /**
   * Which couriers will carry this, how fast and for how much.
   *
   * Read-only and uncommitted, so an admin can compare before choosing. The returned options are
   * ranked by the requested strategy rather than by whatever order the provider happened to use.
   */
  async serviceability(
    query: ServiceabilityQuery,
    context: { strategy?: string; orderNumber?: string } = {},
  ): Promise<CourierOptionDto[]> {
    const { row } = await providerGateway.assertCapability(null, 'supportsServiceability');

    const pickup = query.pickupLocationCode
      ? await pickupLocationRepository.findByCode(query.pickupLocationCode)
      : await pickupLocationRepository.findDefault();

    if (!pickup) {
      throw new AppError(
        422,
        'PICKUP_LOCATION_MISSING',
        'No pickup location is configured to quote from',
      );
    }

    // Either the caller supplies the destination, or it is taken from the order being fulfilled.
    let deliveryPincode = query.deliveryPincode ?? null;
    let weightGrams = query.weightGrams ?? null;
    let declaredValuePaise = query.declaredValuePaise ?? null;

    if (context.orderNumber) {
      const order = await orderRepository.findByNumber(context.orderNumber);
      if (!order) throw AppError.notFound('Order not found');

      const address =
        order.addresses.find((entry) => entry.type === 'SHIPPING') ??
        order.addresses.find((entry) => entry.type === 'BILLING');

      deliveryPincode ??= address?.pincode ?? null;
      declaredValuePaise ??= order.grandTotalPaise;

      if (weightGrams === null) {
        const remaining = await this.remainingQuantities(order);
        weightGrams = remaining.reduce(
          (total, entry) => total + entry.weightGrams * entry.remaining,
          0,
        );
      }
    }

    if (!deliveryPincode) {
      throw new AppError(
        422,
        'SERVICEABILITY_DESTINATION_MISSING',
        'A delivery pincode is required to quote a courier',
      );
    }

    const { driver } = await providerGateway.resolve(row.code);

    const options = await driver
      .serviceability({
        pickupPincode: pickup.pincode,
        deliveryPincode,
        // A courier will not quote for a zero-weight parcel; 500g is the minimum we book.
        weightGrams: Math.max(weightGrams ?? 0, 500),
        isCod: query.cod ?? false,
        declaredValuePaise: declaredValuePaise ?? 0,
        ...(query.isReturn === undefined ? {} : { isReturn: query.isReturn }),
      })
      .catch((error: unknown) => {
        // A quote failing must not look like a server bug: it is a courier being unhelpful.
        logger.warn({ provider: row.code }, 'serviceability lookup failed');
        throw error;
      });

    return rankCouriers(options, context.strategy ?? 'LOWEST_COST');
  },

  /* ----------------------------------------------- pushing to the courier */

  /**
   * Registers the shipment with the courier and gets an AWB.
   *
   * This is the first externally visible act, so it goes through the operation journal. If the
   * courier times out we do NOT retry into a second parcel — the shipment is left for
   * reconciliation, which can ask the courier what actually happened.
   */
  async assignAwb(
    shipmentNumber: string,
    input: AssignAwbBody,
    actor: Actor,
  ): Promise<ShipmentWithDetail> {
    const shipment = await this.getByNumber(shipmentNumber);

    if (shipment.awbNumber) {
      // Already done. Returning the shipment is the correct idempotent answer.
      return shipment;
    }

    /**
     * Asking for an AWB says the parcel is packed, so a DRAFT is promoted to READY first.
     *
     * Without this `assertTransition` refuses DRAFT -> AWB_ASSIGNED and no shipment, on any
     * provider, can ever leave the building.
     */
    if (shipment.status === 'DRAFT') {
      assertTransition(shipmentNumber, 'DRAFT', 'READY');
      await shipmentRepository.update(shipment.id, { status: 'READY' });
    }

    const readied = await this.getByNumber(shipmentNumber);
    assertTransition(shipmentNumber, readied.status as ShipmentStatus, 'AWB_ASSIGNED');

    /**
     * A docket number somebody wrote down.
     *
     * Furniture often moves on our own truck or with a local transporter booked by phone, and
     * `ManualShippingDriver` has no `assignAwb` to call. Without this branch a manual shipment
     * reaches READY and can then only be CANCELLED — it could never be dispatched at all.
     */
    if (input.manualAwb) {
      await shipmentRepository.update(shipment.id, {
        status: 'AWB_ASSIGNED',
        awbNumber: input.manualAwb,
        providerCourierName: input.manualCourierName ?? null,
        providerUpdatedAt: new Date(),
      });

      await shipmentEventRepository.append({
        shipmentId: shipment.id,
        status: 'AWB_ASSIGNED',
        description: `AWB ${input.manualAwb} recorded for ${input.manualCourierName ?? 'manual dispatch'}`,
        source: actor.actorType === 'ADMIN' ? 'ADMIN' : 'SYSTEM',
        isCustomerVisible: true,
      });

      await this.syncOrderStatus(shipment.orderId, actor);

      return this.getByNumber(shipmentNumber);
    }

    const order = await orderRepository.findById(shipment.orderId);
    if (!order) throw AppError.notFound('Order not found');

    const { row } = await providerGateway.assertCapability(
      shipment.providerCode,
      'supportsForwardShipment',
    );

    // Step one: make sure the courier knows about the order at all.
    let providerOrderId = shipment.providerOrderId;
    let providerShipmentId = shipment.providerShipmentId;

    if (!providerShipmentId) {
      const payload = await this.buildProviderOrder(shipment, order);

      const created = await providerGateway.run(
        {
          providerCode: row.code,
          providerId: row.id,
          operation: 'createOrder',
          entityType: 'Shipment',
          entityId: shipment.id,
        },
        (driver) => driver.createOrder(payload),
      );

      providerOrderId = created.providerOrderId;
      providerShipmentId = created.providerShipmentId;

      await shipmentRepository.update(shipment.id, {
        providerOrderId,
        providerShipmentId,
        providerCreatedAt: new Date(),
        status: 'READY',
      });

      await shipmentEventRepository.append({
        shipmentId: shipment.id,
        status: 'READY',
        description: `Registered with ${row.name}`,
        source: 'SYSTEM',
        isCustomerVisible: false,
      });
    }

    if (!providerShipmentId) {
      throw new AppError(
        502,
        'SHIPPING_PROVIDER_ERROR',
        'The courier accepted the order but returned no shipment id',
      );
    }

    // Step two: the AWB itself.
    const awb = await providerGateway.run(
      {
        providerCode: row.code,
        providerId: row.id,
        operation: 'assignAwb',
        entityType: 'Shipment',
        entityId: shipment.id,
        ...(input.courierId ? { salt: input.courierId } : {}),
      },
      (driver) =>
        driver.assignAwb({
          providerShipmentId,
          providerOrderId: providerOrderId ?? shipment.shipmentNumber,
          courierId: input.courierId ?? null,
          isReturn: shipment.direction === 'REVERSE',
        }),
    );

    await shipmentRepository.update(shipment.id, {
      status: 'AWB_ASSIGNED',
      awbNumber: awb.awbNumber,
      providerCourierId: awb.courierId,
      providerCourierName: awb.courierName,
      shippingCostPaise: awb.chargePaise,
      estimatedDeliveryAt: awb.estimatedDeliveryAt ? new Date(awb.estimatedDeliveryAt) : null,
      providerUpdatedAt: new Date(),
    });

    await shipmentEventRepository.append({
      shipmentId: shipment.id,
      status: 'AWB_ASSIGNED',
      description: `AWB ${awb.awbNumber} assigned to ${awb.courierName ?? 'courier'}`,
      source: actor.actorType === 'ADMIN' ? 'ADMIN' : 'SYSTEM',
      isCustomerVisible: true,
    });

    await this.syncOrderStatus(shipment.orderId, actor);

    return this.getByNumber(shipmentNumber);
  },

  async schedulePickup(
    shipmentNumber: string,
    input: SchedulePickupInput,
    actor: Actor,
  ): Promise<ShipmentWithDetail> {
    const shipment = await this.getByNumber(shipmentNumber);
    assertTransition(shipmentNumber, shipment.status as ShipmentStatus, 'PICKUP_SCHEDULED');

    if (!shipment.providerShipmentId) {
      throw new AppError(
        422,
        'SHIPMENT_NOT_REGISTERED',
        'Assign an AWB before scheduling a pickup',
      );
    }

    const { row } = await providerGateway.resolve(shipment.providerCode);

    const pickup = await providerGateway.run(
      {
        providerCode: row.code,
        providerId: row.id,
        operation: 'schedulePickup',
        entityType: 'Shipment',
        entityId: shipment.id,
        ...(input.pickupDate ? { salt: input.pickupDate.toISOString().slice(0, 10) } : {}),
      },
      (driver) =>
        driver.schedulePickup(
          shipment.providerShipmentId!,
          input.pickupDate ?? undefined,
        ),
    );

    await shipmentRepository.update(shipment.id, {
      status: 'PICKUP_SCHEDULED',
      pickupScheduledAt: pickup.scheduledAt ? new Date(pickup.scheduledAt) : new Date(),
      pickupTokenNumber: pickup.tokenNumber,
    });

    await shipmentEventRepository.append({
      shipmentId: shipment.id,
      status: 'PICKUP_SCHEDULED',
      description: pickup.tokenNumber
        ? `Pickup scheduled (token ${pickup.tokenNumber})`
        : 'Pickup scheduled',
      source: actor.actorType === 'ADMIN' ? 'ADMIN' : 'SYSTEM',
      isCustomerVisible: true,
    });

    await this.syncOrderStatus(shipment.orderId, actor);

    return this.getByNumber(shipmentNumber);
  },

  /* ------------------------------------------------------- cancellation */

  /**
   * Cancels a shipment.
   *
   * Before pickup this is ours to decide. After pickup the courier owns the parcel, so the best we
   * can do is ASK — the shipment goes to CANCELLATION_REQUESTED and waits for the courier to agree
   * or for the parcel to come back as an RTO. Pretending otherwise would tell a customer their
   * order is cancelled while a lorry is still carrying it to them.
   */
  async cancel(
    shipmentNumber: string,
    input: ShipmentCancelInput,
    actor: Actor,
  ): Promise<ShipmentWithDetail> {
    const shipment = await this.getByNumber(shipmentNumber);
    const status = shipment.status as ShipmentStatus;

    if (status === 'CANCELLED') return shipment;

    if (status === 'DELIVERED' || status === 'RTO_DELIVERED') {
      throw new AppError(
        422,
        'SHIPMENT_NOT_CANCELLABLE',
        'A delivered shipment cannot be cancelled — raise a return instead',
      );
    }

    const alreadyCollected = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'UNDELIVERED'].includes(
      status,
    );
    const target: ShipmentStatus = alreadyCollected ? 'CANCELLATION_REQUESTED' : 'CANCELLED';

    assertTransition(shipmentNumber, status, target);

    let providerMessage: string | null = null;

    if (shipment.providerShipmentId || shipment.awbNumber) {
      const { row } = await providerGateway.resolve(shipment.providerCode);

      if ((await providerGateway.capabilities(row.code)).supportsCancellation) {
        const result = await providerGateway.run(
          {
            providerCode: row.code,
            providerId: row.id,
            operation: 'cancelShipment',
            entityType: 'Shipment',
            entityId: shipment.id,
          },
          (driver) =>
            driver.cancelShipment({
              providerOrderId: shipment.providerOrderId,
              providerShipmentId: shipment.providerShipmentId,
              awbNumber: shipment.awbNumber,
            }),
          // Cancelling twice is harmless, unlike creating twice.
          { onDuplicate: 'proceed' },
        );

        providerMessage = result.message;
        if (!result.cancelled && !alreadyCollected) {
          throw new AppError(
            422,
            'SHIPMENT_NOT_CANCELLABLE',
            result.message ?? 'The courier refused to cancel this shipment',
          );
        }
      }
    }

    await shipmentRepository.update(shipment.id, {
      status: target,
      ...(target === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
      cancelReason: input.reason,
    });

    await shipmentEventRepository.append({
      shipmentId: shipment.id,
      status: target,
      description:
        target === 'CANCELLED'
          ? `Shipment cancelled: ${input.reason}`
          : `Cancellation requested with the courier: ${input.reason}${providerMessage ? ` (${providerMessage})` : ''}`,
      source: actor.actorType === 'ADMIN' ? 'ADMIN' : 'SYSTEM',
      isCustomerVisible: true,
    });

    await this.syncOrderStatus(shipment.orderId, actor);

    return this.getByNumber(shipmentNumber);
  },

  /* -------------------------------------------------- derived order state */

  /**
   * Recomputes the ORDER's status from its shipments.
   *
   * Called after every shipment change. The order is a summary of its parcels, so it is always
   * derived and never set directly — which is what keeps "delivered" honest when one of three boxes
   * is still in transit.
   */
  async syncOrderStatus(orderId: string, actor: Actor): Promise<void> {
    const order = await orderRepository.findById(orderId);
    if (!order) return;

    const shipments = await shipmentRepository.listForOrder(orderId);
    if (shipments.length === 0) return;

    // Fulfilment is written first: it is a fact about goods, independent of whether the order's
    // own status is allowed to move.
    await this.syncFulfillment(orderId);

    const remaining = await this.remainingQuantities(order);
    const allItemsShipped = remaining.every((entry) => entry.remaining === 0);

    const derived = deriveOrderStatus(
      shipments.map((shipment) => ({ status: shipment.status, direction: shipment.direction })),
      allItemsShipped,
    );

    if (!derived || derived === order.status) return;

    // A REVERSE-only situation, or a refund already in flight, must not drag the order backwards.
    if (!orderStateMachine.canTransition(order.status as never, derived as never)) return;

    await orderStateMachine.transition(order, derived as never, {
      note: 'Derived from shipment progress',
      actorType: actor.actorType,
      actorId: actor.actorId ?? null,
      actorName: actor.actorName ?? null,
      isCustomerVisible: true,
    });

    /**
     * Telling the customer is the last thing that happens, after the status is committed, and it
     * cannot fail the sync. Driven off the DERIVED status rather than the individual shipment so
     * a three-parcel order gets one "delivered" email when the last box lands, not three.
     */
    const event = SHIPMENT_NOTIFICATIONS[derived];
    if (event) {
      const forward = shipments.find((shipment) => shipment.direction === 'FORWARD');
      await notificationService.dispatch(event, { orderId, shipmentId: forward?.id }, {
        trackingNumber: forward?.awbNumber ?? 'not yet allocated',
        courierName: forward?.providerCourierName ?? 'our courier',
      });
    }
  },

  /**
   * Recomputes `Order.fulfillmentStatus` and each line's `fulfilledQty` from the shipments.
   *
   * Both were declared in Prompt 9A and read by the order DTOs, but nothing ever wrote them. They
   * are derived here for the same reason the order status is: a counter that is incremented as
   * events arrive drifts the first time an event is replayed or a shipment is cancelled.
   */
  async syncFulfillment(orderId: string): Promise<void> {
    const order = await orderRepository.findById(orderId);
    if (!order) return;

    const shipments = await shipmentRepository.listForOrder(orderId);

    const fulfilledByItem = deriveFulfilledQuantities(shipments);

    const shippableByItem = new Map(
      order.items.map((item) => [item.id, Math.max(item.qty - item.cancelledQty, 0)]),
    );

    const fulfillmentStatus = deriveFulfillmentStatus(
      shippableByItem,
      fulfilledByItem,
      order.status,
    );

    await prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        const shippable = shippableByItem.get(item.id) ?? 0;
        const qty = Math.min(fulfilledByItem.get(item.id) ?? 0, shippable);

        if (qty === item.fulfilledQty) continue;

        await tx.orderItem.update({ where: { id: item.id }, data: { fulfilledQty: qty } });
      }

      if (fulfillmentStatus !== order.fulfillmentStatus) {
        await tx.order.update({
          where: { id: orderId },
          data: { fulfillmentStatus, version: { increment: 1 } },
        });
      }
    });
  },

  /* ---------------------------------------------------------- internals */

  /** Translates our frozen order snapshot into the provider's create-order shape. */
  async buildProviderOrder(
    shipment: ShipmentWithDetail,
    order: OrderWithDetail,
  ): Promise<CreateShipmentOrderInput> {
    const billing = order.addresses.find((address) => address.type === 'BILLING');
    const shippingAddress = order.addresses.find((address) => address.type === 'SHIPPING');
    const primary = shippingAddress ?? billing;

    if (!primary) {
      throw new AppError(422, 'ORDER_ADDRESS_MISSING', 'This order has no address to ship to');
    }

    const pickup = shipment.pickupLocationId
      ? await pickupLocationRepository.findById(shipment.pickupLocationId)
      : null;

    const itemsById = new Map(order.items.map((item) => [item.id, item]));

    const lines = shipment.items.map((line) => {
      const source = itemsById.get(line.orderItemId);

      return {
        sku: line.sku,
        name: line.productName,
        qty: line.qty,
        unitPricePaise: source?.unitPricePaise ?? 0,
        hsnCode: source?.hsnCode ?? null,
        taxRateBp: source?.taxRateBp ?? 0,
        // Per-unit share of the line discount, so the provider's subtotal reconciles.
        discountPaise:
          source && source.qty > 0
            ? Math.round((source.lineDiscountPaise / source.qty) * line.qty)
            : 0,
      };
    });

    const subTotalPaise = lines.reduce(
      (total, line) => total + line.unitPricePaise * line.qty - (line.discountPaise ?? 0),
      0,
    );

    const email = order.guestEmail ?? null;

    return {
      // OUR reference. The provider's own id comes back on the response.
      referenceNumber: shipment.shipmentNumber,
      orderedAt: order.placedAt ?? order.createdAt,
      pickupLocationName: pickup?.providerLocationId ?? pickup?.name ?? null,
      billing: toProviderAddress(billing ?? primary, email),
      shipping: shippingAddress ? toProviderAddress(shippingAddress, email) : null,
      lines,
      parcel: {
        weightGrams: shipment.weightGrams,
        lengthMm: shipment.lengthMm,
        widthMm: shipment.widthMm,
        heightMm: shipment.heightMm,
        packageCount: shipment.packageCount,
        declaredValuePaise: shipment.declaredValuePaise,
      },
      isCod: shipment.isCod,
      codAmountPaise: shipment.codAmountPaise,
      subTotalPaise,
      isReturn: shipment.direction === 'REVERSE',
    };
  },
};

/**
 * Ranks courier quotes by the chosen policy.
 *
 * The provider's own ordering is not trustworthy as a business decision — it reflects their
 * commercial preferences, not ours. `isRecommended` is set here so the admin UI can explain WHY a
 * courier is suggested rather than just presenting a list.
 */
export function rankCouriers(
  options: CourierOptionDto[],
  strategy: string,
): CourierOptionDto[] {
  if (options.length === 0) return options;

  const sorted = [...options];

  // A courier that will not commit to a date is not "instant" — it sorts last on speed.
  const days = (option: CourierOptionDto): number => option.estimatedDeliveryDays ?? 9_999;

  switch (strategy) {
    case 'FASTEST':
      sorted.sort((a, b) => days(a) - days(b) || a.chargePaise - b.chargePaise);
      break;
    case 'COD_COMPATIBLE':
      sorted.sort(
        (a, b) =>
          Number(b.codAvailable) - Number(a.codAvailable) || a.chargePaise - b.chargePaise,
      );
      break;
    case 'RETURN_COMPATIBLE':
      sorted.sort(
        (a, b) =>
          Number(b.reversePickupAvailable) - Number(a.reversePickupAvailable) ||
          a.chargePaise - b.chargePaise,
      );
      break;
    case 'ADMIN_PRIORITY':
      sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.chargePaise - b.chargePaise);
      break;
    case 'LOWEST_COST':
    default:
      sorted.sort((a, b) => a.chargePaise - b.chargePaise || days(a) - days(b));
  }

  const reason: Record<string, string> = {
    FASTEST: 'Quickest promised delivery',
    LOWEST_COST: 'Cheapest available rate',
    COD_COMPATIBLE: 'Cheapest courier that accepts cash on delivery',
    RETURN_COMPATIBLE: 'Cheapest courier that supports reverse pickup',
    ADMIN_PRIORITY: 'Best performance rating',
    MANUAL: 'Chosen manually',
  };

  return sorted.map((option, index) => ({
    ...option,
    isRecommended: index === 0,
    recommendationReason: index === 0 ? (reason[strategy] ?? null) : null,
  }));
}
