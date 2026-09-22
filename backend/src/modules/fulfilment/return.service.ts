import type { ReturnStatus } from '@shared/enums';
import type {
  AdminReturnListQuery,
  ReturnApproveInput,
  ReturnCreateInput,
  ReturnInspectInput,
  ReturnRejectInput,
} from '@shared/schemas/fulfilment';

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import { orderRepository, type OrderWithDetail } from '../../repositories/order.repository';
import { returnRepository, type ReturnWithDetail } from '../../repositories/return.repository';
import { AppError } from '../../utils/AppError';
import { inventoryService } from '../catalog-admin/inventory.service';
import { orderStateMachine } from '../orders/orderStateMachine';
import { refundService } from '../payments/refund/refund.service';

import { fulfilmentNumberService } from './fulfilmentNumber.service';

/**
 * Returns: goods coming back, and the money that follows them.
 *
 * FOUR RULES:
 *
 *  1. **Only what was delivered can come back.** A return is checked against the frozen order lines
 *     minus anything already returned, so the same chair cannot be returned twice.
 *  2. **The window is real.** Outside `RETURN_WINDOW_DAYS` a customer cannot raise one; an admin
 *     still can, because goodwill is a business decision and the system should not forbid it.
 *  3. **Approval decides quantities, inspection decides condition.** They are separate steps
 *     because they happen at different times and by different people — approving is a promise,
 *     inspecting is what we found in the box.
 *  4. **Only RESELLABLE goods go back on sale**, and only through `inventory.service`. A scratched
 *     sofa put back into stock is a scratched sofa sold to somebody else.
 */

interface Actor {
  actorType: 'ADMIN' | 'CUSTOMER' | 'SYSTEM';
  actorId?: string | null;
  actorName?: string | null;
}

/** Statuses from which goods can legitimately be sent back. */
const RETURNABLE_ORDER_STATUSES = ['DELIVERED', 'RETURN_REQUESTED', 'PARTIALLY_REFUNDED'];

export const RETURN_TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['PICKUP_SCHEDULED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'],
  PICKUP_SCHEDULED: ['IN_TRANSIT', 'RECEIVED', 'CANCELLED'],
  IN_TRANSIT: ['RECEIVED', 'CANCELLED'],
  RECEIVED: ['INSPECTED'],
  INSPECTED: ['COMPLETED', 'REJECTED'],
  // Terminal.
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};

function assertTransition(returnNumber: string, from: ReturnStatus, to: ReturnStatus): void {
  if (from === to) return;

  if (!RETURN_TRANSITIONS[from]?.includes(to)) {
    throw new AppError(
      409,
      'RETURN_TRANSITION_INVALID',
      `Return ${returnNumber} cannot go from ${from} to ${to}`,
      { from, to, allowed: RETURN_TRANSITIONS[from] ?? [] },
    );
  }
}

export const returnService = {
  /* ------------------------------------------------------------ mapping */

  toDto(request: ReturnWithDetail) {
    return {
      id: request.id,
      returnNumber: request.returnNumber,
      orderId: request.orderId,
      status: request.status,
      reason: request.reason,
      reasonNote: request.reasonNote,
      resolution: request.resolution,
      isExchange: request.isExchange,
      requestedAmountPaise: request.requestedAmountPaise,
      approvedAmountPaise: request.approvedAmountPaise,
      refundedAmountPaise: request.refundedAmountPaise,
      refundId: request.refundId,
      rejectedReason: request.rejectedReason,
      requestedAt: request.createdAt.toISOString(),
      approvedAt: request.approvedAt?.toISOString() ?? null,
      receivedAt: request.receivedAt?.toISOString() ?? null,
      inspectedAt: request.inspectedAt?.toISOString() ?? null,
      completedAt: request.completedAt?.toISOString() ?? null,
      items: request.items.map((item) => ({
        id: item.id,
        orderItemId: item.orderItemId,
        sku: item.sku,
        productName: item.productName,
        variantName: item.variantName,
        qtyRequested: item.qtyRequested,
        qtyApproved: item.qtyApproved,
        qtyReceived: item.qtyReceived,
        qtyRestocked: item.qtyRestocked,
        condition: item.condition,
        inspectionNote: item.inspectionNote,
        refundableAmountPaise: item.refundableAmountPaise,
      })),
      shipments: request.shipments.map((shipment) => ({
        shipmentNumber: shipment.shipmentNumber,
        status: shipment.status,
        awbNumber: shipment.awbNumber,
      })),
    };
  },

  /* ------------------------------------------------------------ reading */

  async getByNumber(returnNumber: string): Promise<ReturnWithDetail> {
    const found = await returnRepository.findByNumber(returnNumber);
    if (!found) throw AppError.notFound('Return not found');
    return found;
  },

  listForAdmin(query: AdminReturnListQuery) {
    return returnRepository.listForAdmin(query);
  },

  listForOrder(orderId: string) {
    return returnRepository.listForOrder(orderId);
  },

  /**
   * What is still eligible to come back on this order.
   *
   * Derived every time rather than tracked in a column, because a counter that drifts eventually
   * lets somebody return four chairs out of three.
   */
  async returnableQuantities(order: OrderWithDetail) {
    const returned = await returnRepository.returnedQtyByOrderItem(order.id);

    return order.items.map((item) => {
      const already = returned.get(item.id) ?? 0;
      // Cancelled units never shipped, and refunded units are already settled.
      const eligible = Math.max(item.qty - item.cancelledQty - item.refundedQty, 0);

      return {
        orderItemId: item.id,
        sku: item.sku,
        productName: item.productName,
        variantName: item.variantName,
        ordered: item.qty,
        returned: already,
        remaining: Math.max(eligible - already, 0),
        unitPricePaise: item.unitPricePaise,
        lineTotalPaise: item.lineTotalPaise,
        taxPaise: item.taxPaise,
      };
    });
  },

  /** Whether the customer-facing window is still open. */
  isWithinWindow(order: OrderWithDetail, now = new Date()): boolean {
    const delivered = order.history
      .filter((entry) => entry.toStatus === 'DELIVERED')
      .map((entry) => entry.createdAt)
      .at(-1);

    // Not delivered yet means the window has not started, not that it has closed.
    if (!delivered) return true;

    const deadline = delivered.getTime() + env.RETURN_WINDOW_DAYS * 86_400_000;
    return now.getTime() <= deadline;
  },

  /* ----------------------------------------------------------- creation */

  /**
   * Raises a return request.
   *
   * Amounts are copied from the FROZEN order lines here and never recomputed — the same law that
   * governs refunds (L2). A customer returning a chair bought in a sale gets the sale price back,
   * not today's price.
   */
  async create(
    orderNumber: string,
    input: Omit<ReturnCreateInput, 'orderNumber'>,
    actor: Actor,
  ): Promise<ReturnWithDetail> {
    const order = await orderRepository.findByNumber(orderNumber);
    if (!order) throw AppError.notFound('Order not found');

    if (!RETURNABLE_ORDER_STATUSES.includes(order.status)) {
      throw new AppError(
        422,
        'ORDER_NOT_RETURNABLE',
        `An order in ${order.status} cannot be returned`,
        { status: order.status },
      );
    }

    // The window binds customers, not staff: an admin accepting a late return is a business call.
    if (actor.actorType === 'CUSTOMER' && !this.isWithinWindow(order)) {
      throw new AppError(
        422,
        'RETURN_WINDOW_CLOSED',
        `Returns close ${env.RETURN_WINDOW_DAYS} days after delivery`,
        { windowDays: env.RETURN_WINDOW_DAYS },
      );
    }

    const returnable = await this.returnableQuantities(order);
    const byItem = new Map(returnable.map((entry) => [entry.orderItemId, entry]));
    const itemsById = new Map(order.items.map((item) => [item.id, item]));

    // Validate everything before writing: a half-accepted return is worse than a rejected one.
    const lines = input.items.map((line) => {
      const entry = byItem.get(line.orderItemId);
      const source = itemsById.get(line.orderItemId);

      if (!entry || !source) {
        throw new AppError(422, 'RETURN_ITEM_INVALID', 'That line is not on this order', {
          orderItemId: line.orderItemId,
        });
      }

      if (line.qty > entry.remaining) {
        throw new AppError(
          422,
          'RETURN_OVER_QUANTITY',
          `Only ${entry.remaining} of ${entry.sku} can still be returned`,
          { orderItemId: line.orderItemId, requested: line.qty, remaining: entry.remaining },
        );
      }

      // Per-unit share of the frozen line total, so the refund maths later has nothing to invent.
      const perUnit = source.qty > 0 ? Math.round(source.lineTotalPaise / source.qty) : 0;
      const perUnitTax = source.qty > 0 ? Math.round(source.taxPaise / source.qty) : 0;

      return {
        orderItemId: line.orderItemId,
        qtyRequested: line.qty,
        unitPricePaise: source.unitPricePaise,
        refundableAmountPaise: perUnit * line.qty,
        refundableTaxPaise: perUnitTax * line.qty,
        sku: source.sku,
        productName: source.productName,
        variantName: source.variantName,
      };
    });

    if (lines.length === 0) {
      throw new AppError(422, 'RETURN_EMPTY', 'A return must include at least one line');
    }

    const requestedAmountPaise = lines.reduce(
      (total, line) => total + line.refundableAmountPaise,
      0,
    );

    const { number: returnNumber } = await fulfilmentNumberService.return();

    const created = await returnRepository.create({
      returnNumber,
      order: { connect: { id: order.id } },
      customerId: order.customerId,
      status: 'REQUESTED',
      reason: input.reason,
      reasonNote: input.reasonNote ?? null,
      resolution: input.resolution,
      isExchange: input.resolution === 'EXCHANGE',
      requestedAmountPaise,
      requestedByType: actor.actorType,
      requestedById: actor.actorId ?? null,
      items: { create: lines },
    });

    // The order reflects that something is coming back, so nobody ships against it meanwhile.
    if (orderStateMachine.canTransition(order.status as never, 'RETURN_REQUESTED' as never)) {
      await orderStateMachine.transition(order, 'RETURN_REQUESTED' as never, {
        note: `${returnNumber} raised`,
        actorType: actor.actorType,
        actorId: actor.actorId ?? null,
        isCustomerVisible: true,
      });
    }

    logger.info({ returnNumber, orderNumber, requestedAmountPaise }, 'return requested');

    return created;
  },

  /* ---------------------------------------------------------- approval */

  /**
   * Approves a return, possibly for fewer units than were asked for.
   *
   * Partial approval matters: a customer returns three chairs claiming all are damaged, we agree
   * about one. Approving quantities per line rather than the whole request is what makes that
   * expressible without rejecting the lot.
   */
  async approve(
    returnNumber: string,
    input: ReturnApproveInput,
    actor: Actor,
  ): Promise<ReturnWithDetail> {
    const request = await this.getByNumber(returnNumber);
    assertTransition(returnNumber, request.status as ReturnStatus, 'APPROVED');

    const byId = new Map(request.items.map((item) => [item.id, item]));
    const approvals = input.items ?? [];

    let approvedAmountPaise = 0;

    await prisma.$transaction(async (tx) => {
      for (const item of request.items) {
        const override = approvals.find((entry) => entry.returnItemId === item.id);
        const qtyApproved = override ? override.qtyApproved : item.qtyRequested;

        if (qtyApproved > item.qtyRequested) {
          throw new AppError(
            422,
            'RETURN_APPROVAL_INVALID',
            'Cannot approve more units than were requested',
            { returnItemId: item.id, requested: item.qtyRequested, approved: qtyApproved },
          );
        }

        const perUnit =
          item.qtyRequested > 0
            ? Math.round(item.refundableAmountPaise / item.qtyRequested)
            : 0;

        approvedAmountPaise += perUnit * qtyApproved;

        await tx.returnItem.update({ where: { id: item.id }, data: { qtyApproved } });
      }

      await tx.returnRequest.update({
        where: { id: request.id },
        data: {
          status: 'APPROVED',
          approvedAmountPaise,
          approvedById: actor.actorId ?? null,
          approvedAt: new Date(),
          internalNote: input.note ?? request.internalNote,
          version: { increment: 1 },
        },
      });
    });

    void byId;

    logger.info({ returnNumber, approvedAmountPaise }, 'return approved');

    return this.getByNumber(returnNumber);
  },

  async reject(
    returnNumber: string,
    input: ReturnRejectInput,
    actor: Actor,
  ): Promise<ReturnWithDetail> {
    const request = await this.getByNumber(returnNumber);
    assertTransition(returnNumber, request.status as ReturnStatus, 'REJECTED');

    await returnRepository.update(request.id, {
      status: 'REJECTED',
      rejectedReason: input.reason,
      approvedById: actor.actorId ?? null,
    });

    await this.restoreOrderStatus(request.orderId, actor);

    return this.getByNumber(returnNumber);
  },

  /** The goods are physically back with us. */
  async markReceived(returnNumber: string, actor: Actor): Promise<ReturnWithDetail> {
    const request = await this.getByNumber(returnNumber);
    assertTransition(returnNumber, request.status as ReturnStatus, 'RECEIVED');

    await returnRepository.update(request.id, {
      status: 'RECEIVED',
      receivedAt: new Date(),
    });

    void actor;

    return this.getByNumber(returnNumber);
  },

  /* -------------------------------------------------------- inspection */

  /**
   * Records what was actually in the box, per line.
   *
   * This is where condition is decided, and condition is what decides restock. Approving a return
   * is a promise about money; inspecting it is a statement about goods, and the two genuinely can
   * disagree — we may refund a customer for a sofa we cannot resell.
   */
  async inspect(
    returnNumber: string,
    input: ReturnInspectInput,
    actor: Actor,
  ): Promise<ReturnWithDetail> {
    const request = await this.getByNumber(returnNumber);
    assertTransition(returnNumber, request.status as ReturnStatus, 'INSPECTED');

    await prisma.$transaction(async (tx) => {
      for (const entry of input.items) {
        const item = request.items.find((candidate) => candidate.id === entry.returnItemId);

        if (!item) {
          throw new AppError(422, 'RETURN_ITEM_INVALID', 'That line is not on this return', {
            returnItemId: entry.returnItemId,
          });
        }

        if (entry.qtyReceived > item.qtyApproved) {
          throw new AppError(
            422,
            'RETURN_INSPECTION_INVALID',
            'More units arrived than were approved',
            { returnItemId: item.id, approved: item.qtyApproved, received: entry.qtyReceived },
          );
        }

        await tx.returnItem.update({
          where: { id: item.id },
          data: {
            qtyReceived: entry.qtyReceived,
            condition: entry.condition,
            inspectionNote: entry.note ?? null,
            restockRequested: entry.restock,
          },
        });
      }

      await tx.returnRequest.update({
        where: { id: request.id },
        data: {
          status: 'INSPECTED',
          inspectedAt: new Date(),
          version: { increment: 1 },
        },
      });
    });

    void actor;

    logger.info({ returnNumber }, 'return inspected');

    return this.getByNumber(returnNumber);
  },

  /* ------------------------------------------------------- completion */

  /**
   * Closes the return: restocks what is resellable, then raises the refund.
   *
   * Restock comes first because it cannot fail the customer — if it goes wrong, the money still
   * needs to go back, and stock can be corrected by hand. The refund is the part that must not be
   * skipped.
   */
  async complete(
    returnNumber: string,
    actor: Actor,
    options: { refund?: boolean } = {},
  ): Promise<ReturnWithDetail> {
    const request = await this.getByNumber(returnNumber);
    assertTransition(returnNumber, request.status as ReturnStatus, 'COMPLETED');

    const order = await orderRepository.findById(request.orderId);
    if (!order) throw AppError.notFound('Order not found');

    await this.restock(request, actor);

    let refundId: string | null = null;

    // An exchange sends a replacement rather than money back, so there is nothing to refund.
    const wantsRefund = options.refund ?? request.resolution === 'REFUND';

    if (wantsRefund) {
      const lines = request.items
        .filter((item) => item.qtyReceived > 0)
        .map((item) => ({ orderItemId: item.orderItemId, qty: item.qtyReceived }));

      if (lines.length > 0) {
        const refund = await refundService.request(
          order.orderNumber,
          {
            lines,
            reason: 'CUSTOMER_REQUEST',
            note: `Return ${returnNumber}`,
            // A return refunds the goods, not the delivery we already paid a courier for.
            includeShipping: false,
            // Restock is decided by inspection, above, not by the refund.
            restock: false,
            reversalPolicy: 'PROPORTIONAL',
          },
          actor,
        );

        refundId = refund.id;
      }
    }

    await returnRepository.update(request.id, {
      status: 'COMPLETED',
      completedAt: new Date(),
      ...(refundId ? { refundId } : {}),
    });

    logger.info({ returnNumber, refundId }, 'return completed');

    return this.getByNumber(returnNumber);
  },

  /**
   * Puts resellable units back on sale.
   *
   * ONLY `RESELLABLE` condition, and ONLY through `inventory.service` — so the movement is
   * ledgered and auditable rather than a quiet `stockQty` bump. Damaged goods are written off by a
   * human who can look at them.
   */
  async restock(request: ReturnWithDetail, actor: Actor): Promise<void> {
    const order = await orderRepository.findById(request.orderId);
    if (!order) return;

    const variantByItem = new Map(order.items.map((item) => [item.id, item.variantId]));

    for (const item of request.items) {
      // BOTH must hold: the goods are fit to sell, and the inspector asked for them back in stock.
      if (item.condition !== 'RESELLABLE') continue;
      if (!item.restockRequested) continue;
      if (item.qtyReceived <= 0) continue;
      if (item.qtyRestocked >= item.qtyReceived) continue;

      const variantId = variantByItem.get(item.orderItemId);
      // A made-to-order piece has no variant stock to return.
      if (!variantId) continue;

      const qty = item.qtyReceived - item.qtyRestocked;

      try {
        await inventoryService.adjust(
          variantId,
          {
            delta: qty,
            reason: 'RETURN',
            note: `Restocked from return ${request.returnNumber}`,
            refType: 'ReturnRequest',
            refId: request.id,
          },
          { actorType: actor.actorType, actorId: actor.actorId ?? null },
        );

        await returnRepository.updateItem(item.id, { qtyRestocked: item.qtyReceived });
      } catch (error) {
        // A restock failure must never block the refund the customer is owed.
        logger.error(
          { returnNumber: request.returnNumber, variantId, err: error },
          'restock failed — return continues, stock left for manual correction',
        );
      }
    }
  },

  async cancel(returnNumber: string, actor: Actor): Promise<ReturnWithDetail> {
    const request = await this.getByNumber(returnNumber);
    assertTransition(returnNumber, request.status as ReturnStatus, 'CANCELLED');

    await returnRepository.update(request.id, { status: 'CANCELLED' });
    await this.restoreOrderStatus(request.orderId, actor);

    return this.getByNumber(returnNumber);
  },

  /** When no return is outstanding any more, the order goes back to being delivered. */
  async restoreOrderStatus(orderId: string, actor: Actor): Promise<void> {
    const order = await orderRepository.findById(orderId);
    if (!order || order.status !== 'RETURN_REQUESTED') return;

    const open = await prisma.returnRequest.count({
      where: {
        orderId,
        status: { notIn: ['REJECTED', 'CANCELLED', 'COMPLETED'] },
      },
    });

    if (open > 0) return;

    if (!orderStateMachine.canTransition('RETURN_REQUESTED' as never, 'DELIVERED' as never)) return;

    await orderStateMachine.transition(order, 'DELIVERED' as never, {
      note: 'No returns outstanding',
      actorType: actor.actorType,
      actorId: actor.actorId ?? null,
      isCustomerVisible: false,
    });
  },
};
