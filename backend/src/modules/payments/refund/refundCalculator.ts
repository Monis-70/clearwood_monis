import { allocateProportionally } from '@shared/money';

/**
 * What a refund is worth.
 *
 * PURE: no Prisma, no clock, no I/O. Everything arrives as fixtures, which is what makes the
 * awkward cases — a coupon spread across three lines, a partial return of one of two chairs —
 * unit tests rather than things discovered in production.
 *
 * THE LAW IT ENFORCES (Prompt 9A, L2): a refund is computed from the FROZEN order lines. It never
 * re-prices anything and never accepts an amount from a caller. The only number a human chooses is
 * a QUANTITY; the money follows from the snapshot.
 *
 * THE INVARIANT: refunding every remaining unit of every line must return exactly what is still
 * refundable — not a paise more, not a paise less. Per-unit values are therefore never computed by
 * dividing and rounding independently; they are allocated with `allocateProportionally`, which is
 * lossless, so the parts always re-sum to the whole.
 */

export class RefundCalculationError extends Error {
  readonly code = 'REFUND_CALCULATION_INVALID';

  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RefundCalculationError';
  }
}

/** A frozen order line, exactly as `OrderItem` stores it. */
export interface RefundableLine {
  orderItemId: string;
  sku: string;
  qty: number;
  /** Units already cancelled before dispatch — they were never charged for in the first place. */
  cancelledQty: number;
  /** Units already refunded by an earlier refund. */
  refundedQty: number;
  refundedAmountPaise: number;
  unitPricePaise: number;
  lineSubtotalPaise: number;
  lineDiscountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxRateBp: number;
  lineTotalPaise: number;
}

export interface RefundOrderContext {
  orderId: string;
  grandTotalPaise: number;
  paidPaise: number;
  refundedPaise: number;
  /** H7 - capacity already claimed by refunds in flight. Part of the ceiling, not outside it. */
  refundReservedPaise?: number;
  shippingPaise: number;
  /** Rounding applied to the order total at checkout, which has to be given back with the last unit. */
  roundingPaise: number;
  lines: RefundableLine[];
}

export interface RefundRequestLine {
  orderItemId: string;
  qty: number;
}

export interface RefundLineComputation {
  orderItemId: string;
  sku: string;
  qty: number;
  /** Goods value before tax, net of this line's share of any discount. */
  taxablePaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  amountPaise: number;
  unitRefundPaise: number;
  /** True when this refund takes the line's last unshipped unit — the rounding lands here. */
  isFinalUnit: boolean;
}

export interface RefundComputation {
  lines: RefundLineComputation[];
  goodsPaise: number;
  taxPaise: number;
  shippingPaise: number;
  roundingPaise: number;
  totalPaise: number;
  /** True when this refund closes out the entire order. */
  isFullRefund: boolean;
  maxRefundablePaise: number;
}

/** How much of a line is still refundable, in units. */
export function remainingQty(line: RefundableLine): number {
  return Math.max(line.qty - line.cancelledQty - line.refundedQty, 0);
}

/**
 * Everything a line is still worth, in paise.
 *
 * Derived from the frozen totals minus what has already gone back, rather than from
 * `unitPrice × qty` — because the line total already carries its share of the cart-level discount
 * and its tax, and multiplying the unit price would quietly refund the discount too.
 */
export function remainingLineValuePaise(line: RefundableLine): number {
  return Math.max(line.lineTotalPaise - line.refundedAmountPaise, 0);
}

/**
 * Splits a line's frozen totals across its units without losing a paise.
 *
 * Three units of a ₹1,000 line that carries a ₹100 discount are worth 300, 300 and 300 — and the
 * leftover paise has to go somewhere deterministic rather than being rounded away three times.
 */
function perUnit(totalPaise: number, units: number): number[] {
  if (units <= 0) return [];
  return allocateProportionally(totalPaise, new Array(units).fill(1));
}

/**
 * Computes what a refund of the requested quantities is worth.
 *
 * `shipping: true` adds the shipping charge back. That is a business decision, not a calculation —
 * a customer returning one of four chairs does not get the delivery refunded, but a customer whose
 * entire order is cancelled does — so the caller must say, and the caller is an admin.
 */
export function calculateRefund(
  order: RefundOrderContext,
  requested: RefundRequestLine[],
  options: { includeShipping?: boolean } = {},
): RefundComputation {
  if (requested.length === 0) {
    throw new RefundCalculationError('A refund must include at least one line', {
      orderId: order.orderId,
    });
  }

  const byId = new Map(order.lines.map((line) => [line.orderItemId, line]));
  const seen = new Set<string>();
  const lines: RefundLineComputation[] = [];

  for (const request of requested) {
    if (seen.has(request.orderItemId)) {
      throw new RefundCalculationError('The same line was listed twice', {
        orderItemId: request.orderItemId,
      });
    }
    seen.add(request.orderItemId);

    const line = byId.get(request.orderItemId);
    if (!line) {
      throw new RefundCalculationError('That line is not on this order', {
        orderItemId: request.orderItemId,
      });
    }

    if (request.qty <= 0) {
      throw new RefundCalculationError('A refund quantity must be at least one', {
        orderItemId: request.orderItemId,
        qty: request.qty,
      });
    }

    const available = remainingQty(line);
    if (request.qty > available) {
      throw new RefundCalculationError(
        `Only ${available} unit(s) of ${line.sku} can still be refunded`,
        { orderItemId: request.orderItemId, requested: request.qty, available },
      );
    }

    // Units are valued against what is LEFT on the line, so a second partial refund cannot
    // re-refund value the first one already returned.
    const units = perUnit(remainingLineValuePaise(line), available);
    const taxUnits = perUnit(
      Math.max(line.taxPaise - proportionOf(line.taxPaise, line.lineTotalPaise, line.refundedAmountPaise), 0),
      available,
    );
    const cgstUnits = perUnit(shareOf(line.cgstPaise, line, available), available);
    const sgstUnits = perUnit(shareOf(line.sgstPaise, line, available), available);
    const igstUnits = perUnit(shareOf(line.igstPaise, line, available), available);

    const take = <T>(values: T[]): T[] => values.slice(0, request.qty);

    const amountPaise = sum(take(units));
    const taxPaise = sum(take(taxUnits));

    lines.push({
      orderItemId: line.orderItemId,
      sku: line.sku,
      qty: request.qty,
      taxablePaise: amountPaise - taxPaise,
      taxPaise,
      cgstPaise: sum(take(cgstUnits)),
      sgstPaise: sum(take(sgstUnits)),
      igstPaise: sum(take(igstUnits)),
      amountPaise,
      unitRefundPaise: request.qty > 0 ? Math.round(amountPaise / request.qty) : 0,
      isFinalUnit: request.qty === available,
    });
  }

  // Every remaining unit of every line is going back: this closes the order out.
  const closesOrder = order.lines.every((line) => {
    const requestedQty = requested.find((entry) => entry.orderItemId === line.orderItemId)?.qty ?? 0;
    return requestedQty >= remainingQty(line);
  });

  const includeShipping = options.includeShipping ?? closesOrder;
  const shippingPaise = includeShipping ? Math.max(order.shippingPaise, 0) : 0;

  // The checkout rounding belongs to the order, not to a line, so it only comes back when the
  // whole order does. Otherwise two partial refunds would each try to return it.
  const roundingPaise = closesOrder ? order.roundingPaise : 0;

  const goodsPaise = sum(lines.map((line) => line.taxablePaise));
  const taxPaise = sum(lines.map((line) => line.taxPaise));
  const totalPaise = goodsPaise + taxPaise + shippingPaise + roundingPaise;

  // Money held by a refund that has not landed yet is NOT available: if it did land, offering it
  // again would refund the same money twice.
  const maxRefundablePaise = Math.max(
    order.paidPaise - order.refundedPaise - (order.refundReservedPaise ?? 0),
    0,
  );

  if (totalPaise <= 0) {
    throw new RefundCalculationError('That refund works out to nothing', {
      orderId: order.orderId,
      totalPaise,
    });
  }

  // The hard ceiling: we cannot return money we never took.
  if (totalPaise > maxRefundablePaise) {
    throw new RefundCalculationError(
      `That refund comes to ${totalPaise} paise but only ${maxRefundablePaise} paise is still refundable`,
      { orderId: order.orderId, totalPaise, maxRefundablePaise },
    );
  }

  return {
    lines,
    goodsPaise,
    taxPaise,
    shippingPaise,
    roundingPaise,
    totalPaise,
    isFullRefund: closesOrder && totalPaise === maxRefundablePaise,
    maxRefundablePaise,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** The part of `component` corresponding to `part` of `whole`. Used to net off earlier refunds. */
function proportionOf(component: number, whole: number, part: number): number {
  if (whole <= 0 || part <= 0) return 0;
  return Math.round((component * part) / whole);
}

function shareOf(component: number, line: RefundableLine, availableUnits: number): number {
  if (availableUnits <= 0) return 0;
  return Math.max(
    component - proportionOf(component, line.lineTotalPaise, line.refundedAmountPaise),
    0,
  );
}
