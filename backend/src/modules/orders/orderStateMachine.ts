import type { OrderStatus, PaymentStatus } from '@shared/enums';

import { logger } from '../../config/logger';
import { catalogEvents } from '../../events/catalogEvents';
import { orderRepository, type OrderWithDetail } from '../../repositories/order.repository';
import { AppError } from '../../utils/AppError';

/**
 * The order lifecycle, as data.
 *
 * One declarative table plus a handful of guards. Every status change in the system goes through
 * `transition()`, which means there is exactly one place that decides whether a move is legal, one
 * place that writes history, and no way for a service to quietly set `status` to something the
 * business does not allow.
 *
 * 9A drives DRAFT → PENDING_PAYMENT → CONFIRMED / PAYMENT_FAILED / EXPIRED / CANCELLED. The
 * fulfilment edges are declared here now so 9B only has to call the same function.
 */

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED'],
  PENDING_PAYMENT: ['CONFIRMED', 'PAYMENT_FAILED', 'CANCELLED', 'EXPIRED'],
  // A failed attempt is not the end: the shopper can pay again from the same order.
  PAYMENT_FAILED: ['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED'],
  CONFIRMED: ['PROCESSING', 'READY_TO_SHIP', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  PROCESSING: ['READY_TO_SHIP', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  READY_TO_SHIP: ['SHIPPED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  SHIPPED: ['OUT_FOR_DELIVERY', 'DELIVERED', 'RETURN_REQUESTED', 'PARTIALLY_REFUNDED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'RETURN_REQUESTED'],
  DELIVERED: ['RETURN_REQUESTED', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  RETURN_REQUESTED: ['RETURNED', 'DELIVERED'],
  RETURNED: ['REFUNDED', 'PARTIALLY_REFUNDED'],
  PARTIALLY_REFUNDED: ['REFUNDED'],
  // Terminal.
  CANCELLED: [],
  REFUNDED: [],
  EXPIRED: [],
};

/** Statuses after which stock and coupon holds must no longer exist (L5). */
export const RELEASING_STATUSES: OrderStatus[] = ['PAYMENT_FAILED', 'CANCELLED', 'EXPIRED'];

/** Statuses that mean the order is real and must never be swept. */
export const COMMITTED_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'PROCESSING',
  'READY_TO_SHIP',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'RETURN_REQUESTED',
  'RETURNED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
];

export function isTerminal(status: OrderStatus): boolean {
  return ORDER_TRANSITIONS[status].length === 0;
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface TransitionContext {
  note?: string | null;
  actorType?: string;
  actorId?: string | null;
  actorName?: string | null;
  isCustomerVisible?: boolean;
  meta?: Record<string, unknown> | null;
  /** Extra columns to write in the same update — cancelledAt, confirmedAt and friends. */
  data?: Record<string, unknown>;
  /** Set only by the COD path: confirming an order that is legitimately still unpaid. */
  unpaidConfirmation?: boolean;
}

/**
 * A guard is a rule that a legal edge still has to satisfy. Keeping them here rather than inside
 * the services is what stops "confirm an unpaid order" from becoming possible via a new caller.
 */
const GUARDS: Partial<
  Record<OrderStatus, (order: OrderWithDetail, context: TransitionContext) => string | null>
> = {
  CONFIRMED: (order, context) => {
    const paymentStatus = order.paymentStatus as PaymentStatus;

    if (paymentStatus === 'CAPTURED') return null;
    if (order.grandTotalPaise === 0) return null;
    // COD is confirmed while still unpaid — that is the whole point of cash on delivery, and only
    // the checkout service is in a position to say so.
    if (context.unpaidConfirmation && paymentStatus === 'PENDING') return null;

    return `an order can only be confirmed once payment is captured (payment is ${paymentStatus})`;
  },
  REFUNDED: (order) =>
    order.paidPaise > 0 ? null : 'an order with nothing paid cannot be refunded',
};

export const orderStateMachine = {
  transitions: ORDER_TRANSITIONS,
  canTransition,
  isTerminal,

  /**
   * The only legal way to change an order's status.
   *
   * The write is a compare-and-set on the CURRENT status, so two concurrent confirmations (a
   * webhook and a verify call, say) cannot both succeed — the loser is told the order already
   * moved, which is exactly the no-op L3 requires.
   */
  async transition(
    order: OrderWithDetail,
    to: OrderStatus,
    context: TransitionContext = {},
  ): Promise<OrderWithDetail> {
    const from = order.status as OrderStatus;

    if (from === to) return order;

    if (!canTransition(from, to)) {
      throw new AppError(
        409,
        'INVALID_ORDER_TRANSITION',
        `An order cannot go from ${from} to ${to}`,
        { from, to, allowed: ORDER_TRANSITIONS[from] ?? [] },
      );
    }

    const guard = GUARDS[to]?.(order, context);
    if (guard) {
      throw new AppError(409, 'INVALID_ORDER_TRANSITION', guard, {
        from,
        to,
        allowed: ORDER_TRANSITIONS[from],
      });
    }

    const won = await orderRepository.transitionStatus(order.id, from, {
      status: to,
      ...(context.data ?? {}),
    });

    if (!won) {
      const current = await orderRepository.findById(order.id);
      // Somebody else already made this exact move; that is success, not a conflict.
      if (current?.status === to) return current;

      throw new AppError(
        409,
        'ORDER_CHANGED',
        'This order changed while you were working on it — reload and try again',
        { from, to, actual: current?.status ?? null },
      );
    }

    await orderRepository.recordHistory({
      orderId: order.id,
      fromStatus: from,
      toStatus: to,
      note: context.note ?? null,
      actorType: context.actorType ?? 'SYSTEM',
      actorId: context.actorId ?? null,
      actorName: context.actorName ?? null,
      isCustomerVisible: context.isCustomerVisible ?? true,
      metaJson: context.meta ? JSON.stringify(context.meta) : null,
    });

    logger.info({ orderId: order.id, from, to }, 'order status changed');

    if (to === 'CONFIRMED') {
      for (const item of order.items) {
        // Prompt 7 left ProductStat.purchaseCount at zero on purpose; this is where it starts moving.
        catalogEvents.emit('order.confirmed', {
          productId: item.productId,
          variantId: item.variantId,
          qty: item.qty,
        });
      }
    }

    return (await orderRepository.findById(order.id))!;
  },
};
