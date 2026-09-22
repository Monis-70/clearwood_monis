import type { FulfillmentStatus, ShipmentStatus } from '@shared/enums';

import { AppError } from '../../utils/AppError';

/**
 * The shipment lifecycle, as data — the same declarative approach the order state machine uses.
 *
 * A shipment has its own life because it is not the order: one order can have three parcels, one of
 * which is delivered while another is stuck in transit and a third has gone RTO. Collapsing that
 * into a single order status is how fulfilment systems start lying to customers.
 *
 * The order status is DERIVED from its shipments (see `deriveOrderStatus`), never the other way
 * round.
 */

export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['AWB_ASSIGNED', 'CANCELLED'],
  AWB_ASSIGNED: ['PICKUP_SCHEDULED', 'PICKED_UP', 'CANCELLATION_REQUESTED', 'CANCELLED'],
  PICKUP_SCHEDULED: ['PICKED_UP', 'CANCELLATION_REQUESTED', 'CANCELLED'],
  // Once a courier physically has the parcel, cancelling is a request, not a decision.
  PICKED_UP: ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'UNDELIVERED', 'LOST', 'CANCELLATION_REQUESTED'],
  IN_TRANSIT: ['OUT_FOR_DELIVERY', 'DELIVERED', 'UNDELIVERED', 'RTO_INITIATED', 'LOST', 'CANCELLATION_REQUESTED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'UNDELIVERED', 'IN_TRANSIT', 'LOST'],
  // A failed attempt is not the end: couriers reattempt, usually twice.
  UNDELIVERED: ['OUT_FOR_DELIVERY', 'IN_TRANSIT', 'DELIVERED', 'RTO_INITIATED', 'LOST'],
  RTO_INITIATED: ['RTO_DELIVERED', 'IN_TRANSIT', 'LOST'],
  CANCELLATION_REQUESTED: ['CANCELLED', 'IN_TRANSIT', 'DELIVERED', 'RTO_INITIATED'],
  // Terminal.
  DELIVERED: [],
  RTO_DELIVERED: [],
  CANCELLED: [],
  LOST: [],
};

/** Statuses that mean the courier physically holds the goods. */
export const IN_FLIGHT_STATUSES: ShipmentStatus[] = [
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'UNDELIVERED',
  'RTO_INITIATED',
  'CANCELLATION_REQUESTED',
];

/**
 * Statuses that mean a unit has actually left us and has not come back.
 *
 * Fulfilment is about physical dispatch, so a packed-but-uncollected parcel does not count: the
 * handover to the courier is `PICKED_UP`. Anything returning to origin (RTO) or written off (LOST)
 * is excluded, because an order whose goods are on their way back to the warehouse has not been
 * fulfilled however far the parcel once travelled.
 */
export const DISPATCHED_STATUSES: ShipmentStatus[] = [
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'UNDELIVERED',
  'DELIVERED',
  'CANCELLATION_REQUESTED',
];

export function isDispatched(status: string): boolean {
  return DISPATCHED_STATUSES.includes(status as ShipmentStatus);
}

/** Statuses whose quantities no longer count against the order (see over-ship checks). */
export const VOID_STATUSES: ShipmentStatus[] = ['CANCELLED'];

export function isTerminal(status: ShipmentStatus): boolean {
  return SHIPMENT_TRANSITIONS[status].length === 0;
}

export function canTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return SHIPMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(
  shipmentNumber: string,
  from: ShipmentStatus,
  to: ShipmentStatus,
): void {
  if (from === to) return;

  if (!canTransition(from, to)) {
    throw new AppError(
      409,
      'SHIPMENT_TRANSITION_INVALID',
      `Shipment ${shipmentNumber} cannot go from ${from} to ${to}`,
      { from, to },
    );
  }
}

/**
 * Maps a courier's own status vocabulary onto ours.
 *
 * Providers describe the same physical event a dozen ways ("RTO INITIATED", "rto_initiated",
 * "Return To Origin"), and Shiprocket additionally sends a numeric `sr-status`. Both are checked:
 * the numeric code first because it is unambiguous, then a normalised text match.
 *
 * An unrecognised status returns null — which is deliberate. An unknown courier status must record
 * an event and leave the shipment where it is, never guess it forward.
 */

/** Shiprocket `sr-status` codes confirmed from its published webhook documentation. */
const CODE_MAP: Record<string, ShipmentStatus> = {
  '5': 'READY', // MANIFEST GENERATED
  '6': 'IN_TRANSIT', // SHIPPED
  '7': 'DELIVERED',
  '8': 'CANCELLED',
  '9': 'RTO_INITIATED',
  '10': 'RTO_DELIVERED',
  '15': 'UNDELIVERED',
  '17': 'OUT_FOR_DELIVERY',
  '18': 'IN_TRANSIT',
  '19': 'OUT_FOR_DELIVERY',
  '38': 'IN_TRANSIT',
  '42': 'PICKED_UP',
  '4': 'PICKUP_SCHEDULED',
};

const TEXT_MAP: Record<string, ShipmentStatus> = {
  'awb assigned': 'AWB_ASSIGNED',
  'manifest generated': 'READY',
  'pickup scheduled': 'PICKUP_SCHEDULED',
  'pickup generated': 'PICKUP_SCHEDULED',
  'pickup queued': 'PICKUP_SCHEDULED',
  'picked up': 'PICKED_UP',
  shipped: 'IN_TRANSIT',
  'in transit': 'IN_TRANSIT',
  'out for delivery': 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  undelivered: 'UNDELIVERED',
  'delivery failed': 'UNDELIVERED',
  'rto initiated': 'RTO_INITIATED',
  'rto in transit': 'RTO_INITIATED',
  'rto delivered': 'RTO_DELIVERED',
  'rto acknowledged': 'RTO_DELIVERED',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  lost: 'LOST',
  damaged: 'LOST',
};

export function mapProviderStatus(
  providerStatus: string | null | undefined,
  providerStatusCode: string | null | undefined,
): ShipmentStatus | null {
  if (providerStatusCode && CODE_MAP[providerStatusCode]) return CODE_MAP[providerStatusCode]!;

  if (!providerStatus) return null;

  const normalised = providerStatus.trim().toLowerCase().replace(/[_-]+/g, ' ');
  return TEXT_MAP[normalised] ?? null;
}

/**
 * What the ORDER should say, given every shipment on it.
 *
 * The rule is "the least-advanced parcel wins", because an order is only delivered when the
 * customer has everything. Cancelled shipments are ignored. Returns null when the shipments imply
 * nothing (all cancelled, or none yet), leaving the order status untouched.
 */
export function deriveOrderStatus(
  shipments: { status: string; direction: string }[],
  allItemsShipped: boolean,
):
  | 'PROCESSING'
  | 'READY_TO_SHIP'
  | 'SHIPPED'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | null {
  const forward = shipments.filter(
    (shipment) => shipment.direction === 'FORWARD' && shipment.status !== 'CANCELLED',
  );

  if (forward.length === 0) return null;

  const statuses = new Set(forward.map((shipment) => shipment.status));

  // Everything arrived — but only if there is nothing left unshipped in the order.
  if (allItemsShipped && [...statuses].every((status) => status === 'DELIVERED')) return 'DELIVERED';

  if (statuses.has('OUT_FOR_DELIVERY')) return 'OUT_FOR_DELIVERY';

  if (
    statuses.has('PICKED_UP') ||
    statuses.has('IN_TRANSIT') ||
    statuses.has('UNDELIVERED') ||
    statuses.has('RTO_INITIATED') ||
    statuses.has('DELIVERED')
  ) {
    return 'SHIPPED';
  }

  if (statuses.has('AWB_ASSIGNED') || statuses.has('PICKUP_SCHEDULED') || statuses.has('READY')) {
    return 'READY_TO_SHIP';
  }

  return 'PROCESSING';
}

/**
 * How much of each order line has actually been dispatched.
 *
 * PURE, and derived rather than counted incrementally: a stored counter drifts, and a drifted
 * fulfilment counter is how an order gets marked complete while a wardrobe is still on the floor.
 */
export function deriveFulfilledQuantities(
  shipments: { status: string; direction: string; items: { orderItemId: string; qty: number }[] }[],
): Map<string, number> {
  const fulfilled = new Map<string, number>();

  for (const shipment of shipments) {
    // Reverse shipments are goods coming BACK; they never count towards fulfilment.
    if (shipment.direction !== 'FORWARD') continue;
    if (!isDispatched(shipment.status)) continue;

    for (const item of shipment.items) {
      fulfilled.set(item.orderItemId, (fulfilled.get(item.orderItemId) ?? 0) + item.qty);
    }
  }

  return fulfilled;
}

/**
 * The order's fulfilment status, given what has been dispatched.
 *
 * Separate from `Order.status` on purpose. Status answers "where is this order in its life";
 * fulfilment answers the narrower question "have the goods gone out", and the two legitimately
 * disagree — a DELIVERED order that is now RETURN_REQUESTED is still FULFILLED, because the goods
 * did go out.
 *
 * `shippableByItem` is the quantity each line SHOULD dispatch: ordered minus cancelled.
 */
export function deriveFulfillmentStatus(
  shippableByItem: Map<string, number>,
  fulfilledByItem: Map<string, number>,
  orderStatus: string,
): FulfillmentStatus {
  if (orderStatus === 'CANCELLED' || orderStatus === 'EXPIRED') return 'CANCELLED';

  const totalShippable = [...shippableByItem.values()].reduce((sum, qty) => sum + qty, 0);

  // Nothing was ever going to ship. Vacuously "all fulfilled" would be a lie, so it is not.
  if (totalShippable === 0) return 'UNFULFILLED';

  let totalFulfilled = 0;
  for (const [orderItemId, shippable] of shippableByItem) {
    // A line can never be more than fully fulfilled, however many shipments touched it.
    totalFulfilled += Math.min(fulfilledByItem.get(orderItemId) ?? 0, shippable);
  }

  if (totalFulfilled === 0) return 'UNFULFILLED';
  if (totalFulfilled >= totalShippable) return 'FULFILLED';

  return 'PARTIALLY_FULFILLED';
}
