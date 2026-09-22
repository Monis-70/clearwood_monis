import type {
  FulfillmentStatus,
  OrderChannel,
  OrderStatus,
  PaymentMethodType,
  PaymentProvider,
  PaymentStatus,
  RefundReason,
  RefundStatus,
  ReservationStatus,
  SettlementStatus,
  SplitMode,
  TransferStatus,
} from '@shared/enums';
import type {
  AdminOrderListQuery,
  MyOrderListQuery,
  OrderCancelInput,
} from '@shared/schemas/order';
import type {
  AdminOrderDetailDto,
  AdminOrderRowDto,
  OrderAddressDto,
  OrderDto,
  OrderItemDto,
  OrderSummaryDto,
  OrderTimelineEntryDto,
  OrderTrackingDto,
  PaymentDto,
  PaymentTransferDto,
  RefundDto,
  SplitAllocationDto,
  StockReservationDto,
} from '@shared/types/order';
import type { PriceBreakdown, PriceComponent } from '@shared/types/pricing';

import { prisma } from '../../config/prisma';
import {
  orderRepository,
  stockReservationRepository,
  type OrderWithDetail,
} from '../../repositories/order.repository';
import {
  paymentRepository,
  paymentTransferRepository,
  refundRepository,
  splitAllocationRepository,
} from '../../repositories/payment.repository';
import { AppError } from '../../utils/AppError';
import { notificationService } from '../notifications/notification.service';
import { jsonColumn } from '../../utils/jsonColumn';

import { checkoutService } from './checkout.service';
import { ledgerIntegrityService } from './ledgerIntegrity.service';
import { orderStateMachine } from './orderStateMachine';

/**
 * The read side.
 *
 * L2 IN PRACTICE: everything here RENDERS THE SNAPSHOT. `breakdownJson` is parsed and returned as
 * it was written; the item rows are returned as they were written. Nothing on this path calls the
 * pricing engine, so a price change, a coupon expiry or a new tax rate cannot retroactively alter
 * what a customer sees they were charged.
 *
 * Ownership is enforced by scoping every query to the caller, and a miss answers 404 rather than
 * 403 so order ids and numbers cannot be probed.
 */

/** D3 — the frozen JSON columns, decoded once here and nowhere else. */
const breakdownColumn = jsonColumn<PriceBreakdown>(undefined, 'Order.breakdownJson');
const componentsColumn = jsonColumn<PriceComponent[]>(undefined, 'OrderItem.componentsJson');
const optionLabelsColumn = jsonColumn<{ label: string; value: string }[]>(
  undefined,
  'OrderItem.optionLabelsJson',
);

function parseBreakdown(order: OrderWithDetail): PriceBreakdown {
  return breakdownColumn.parse(order.breakdownJson, {} as PriceBreakdown);
}

function toAddressDto(row: OrderWithDetail['addresses'][number]): OrderAddressDto {
  return {
    type: row.type as 'SHIPPING' | 'BILLING',
    fullName: row.fullName,
    phone: row.phone,
    altPhone: row.altPhone,
    line1: row.line1,
    line2: row.line2,
    landmark: row.landmark,
    city: row.city,
    state: row.state,
    stateCode: row.stateCode,
    pincode: row.pincode,
    country: row.country,
    deliveryInstructions: row.deliveryInstructions,
  };
}

function toItemDto(row: OrderWithDetail['items'][number]): OrderItemDto {
  return {
    id: row.id,
    productId: row.productId,
    variantId: row.variantId,
    sku: row.sku,
    productName: row.productName,
    variantName: row.variantName,
    brandName: row.brandName,
    imageUrl: row.imageUrlSnapshot,
    optionLabels: optionLabelsColumn.parse(row.optionLabelsJson, []),
    qty: row.qty,
    unitPricePaise: row.unitPricePaise,
    baseUnitPricePaise: row.baseUnitPricePaise,
    lineSubtotalPaise: row.lineSubtotalPaise,
    lineDiscountPaise: row.lineDiscountPaise,
    taxablePaise: row.taxablePaise,
    taxPaise: row.taxPaise,
    taxRateBp: row.taxRateBp,
    cgstPaise: row.cgstPaise,
    sgstPaise: row.sgstPaise,
    igstPaise: row.igstPaise,
    hsnCode: row.hsnCode,
    lineTotalPaise: row.lineTotalPaise,
    components: componentsColumn.parse(row.componentsJson, []),
    isMadeToOrder: row.isMadeToOrder,
    leadTimeDays: row.leadTimeDays,
    fulfilledQty: row.fulfilledQty,
    cancelledQty: row.cancelledQty,
    refundedQty: row.refundedQty,
    refundedAmountPaise: row.refundedAmountPaise,
    position: row.position,
  };
}

function toTimelineDto(row: OrderWithDetail['history'][number]): OrderTimelineEntryDto {
  return {
    id: row.id,
    fromStatus: row.fromStatus as OrderStatus | null,
    toStatus: row.toStatus as OrderStatus,
    note: row.note,
    actorType: row.actorType,
    actorName: row.actorName,
    isCustomerVisible: row.isCustomerVisible,
    createdAt: row.createdAt.toISOString(),
  };
}

export const orderService = {
  toDto(order: OrderWithDetail): OrderDto {
    const shipping = order.addresses.find((row) => row.type === 'SHIPPING');
    const billing = order.addresses.find((row) => row.type === 'BILLING');

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status as OrderStatus,
      paymentStatus: order.paymentStatus as PaymentStatus,
      fulfillmentStatus: order.fulfillmentStatus as FulfillmentStatus,
      channel: order.channel as OrderChannel,
      currency: 'INR',
      isGuest: order.isGuest,
      customerId: order.customerId,
      contactEmail: order.guestEmail,
      contactPhone: order.guestPhone,
      items: order.items.map(toItemDto),
      shippingAddress: shipping ? toAddressDto(shipping) : null,
      billingAddress: billing ? toAddressDto(billing) : null,
      subtotalPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      shippingPaise: order.shippingPaise,
      taxPaise: order.taxPaise,
      cgstPaise: order.cgstPaise,
      sgstPaise: order.sgstPaise,
      igstPaise: order.igstPaise,
      roundingPaise: order.roundingPaise,
      grandTotalPaise: order.grandTotalPaise,
      totalSavingsPaise: order.totalSavingsPaise,
      paidPaise: order.paidPaise,
      refundedPaise: order.refundedPaise,
      duePaise: order.duePaise,
      couponCode: order.couponCode,
      placeOfSupply: order.placeOfSupply,
      breakdown: parseBreakdown(order),
      pricingEngineVersion: order.pricingEngineVersion,
      customerNote: order.customerNote,
      giftMessage: order.giftMessage,
      estimatedDeliveryMinDays: order.estimatedDeliveryMinDays,
      estimatedDeliveryMaxDays: order.estimatedDeliveryMaxDays,
      placedAt: order.placedAt?.toISOString() ?? null,
      confirmedAt: order.confirmedAt?.toISOString() ?? null,
      cancelledAt: order.cancelledAt?.toISOString() ?? null,
      cancelReason: order.cancelReason,
      expiresAt: order.expiresAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
      version: order.version,
    };
  },

  toSummary(order: OrderWithDetail): OrderSummaryDto {
    const first = order.items[0];
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status as OrderStatus,
      paymentStatus: order.paymentStatus as PaymentStatus,
      itemCount: order.items.length,
      grandTotalPaise: order.grandTotalPaise,
      placedAt: order.placedAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
      firstItemName: first?.productName ?? null,
      firstItemImageUrl: first?.imageUrlSnapshot ?? null,
    };
  },

  /* --------------------------------------------------------- customer */

  async listForCustomer(customerId: string, query: MyOrderListQuery) {
    const page = await orderRepository.listForCustomer(customerId, query);
    return { ...page, items: page.items.map((order) => this.toSummary(order)) };
  },

  /** 404 rather than 403 for somebody else's order, so numbers cannot be probed. */
  async getForCustomer(customerId: string, orderNumber: string): Promise<OrderDto> {
    const order = await orderRepository.findByNumber(orderNumber);
    if (!order || order.customerId !== customerId) {
      throw AppError.notFound('Order not found', { orderNumber });
    }
    return this.toDto(order);
  },

  async timelineForCustomer(
    customerId: string,
    orderNumber: string,
  ): Promise<OrderTimelineEntryDto[]> {
    const order = await orderRepository.findByNumber(orderNumber);
    if (!order || order.customerId !== customerId) {
      throw AppError.notFound('Order not found', { orderNumber });
    }
    return order.history.filter((row) => row.isCustomerVisible).map(toTimelineDto);
  },

  /**
   * Public tracking.
   *
   * Deliberately narrow: an order number plus a matching email or phone gets a status and a city,
   * never an address, a price breakdown or another person's contact details. Guessing a number
   * without the matching contact answers exactly the same 404 as a number that does not exist.
   */
  async track(input: {
    orderNumber: string;
    email?: string;
    phone?: string;
  }): Promise<OrderTrackingDto> {
    const order = await orderRepository.findForTracking(input.orderNumber);

    const matches = order
      ? [order.guestEmail, order.guestPhone].some((value) => {
          if (!value) return false;
          if (input.email && value.toLowerCase() === input.email.toLowerCase()) return true;
          return Boolean(input.phone && value === input.phone);
        }) ||
        (order.customerId !== null && (await this.customerContactMatches(order.customerId, input)))
      : false;

    if (!order || !matches) {
      throw AppError.notFound('We could not find an order with those details');
    }

    const shipping = order.addresses.find((row) => row.type === 'SHIPPING');

    return {
      orderNumber: order.orderNumber,
      status: order.status as OrderStatus,
      fulfillmentStatus: order.fulfillmentStatus as FulfillmentStatus,
      placedAt: order.placedAt?.toISOString() ?? null,
      estimatedDeliveryMinDays: order.estimatedDeliveryMinDays,
      estimatedDeliveryMaxDays: order.estimatedDeliveryMaxDays,
      itemCount: order.items.length,
      grandTotalPaise: order.grandTotalPaise,
      timeline: order.history.filter((row) => row.isCustomerVisible).map(toTimelineDto),
      shippingCity: shipping?.city ?? null,
    };
  },

  async customerContactMatches(
    customerId: string,
    input: { email?: string; phone?: string },
  ): Promise<boolean> {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { email: true, phone: true },
    });
    if (!customer) return false;

    if (input.email && customer.email?.toLowerCase() === input.email.toLowerCase()) return true;
    return Boolean(input.phone && customer.phone === input.phone);
  },

  /**
   * Customer cancellation.
   *
   * 9A stops at the Refund ROW: the money is recorded as owed and the holds are released, but the
   * provider refund is executed in 9B. Creating the row now means nothing is lost in between.
   */
  async cancelForCustomer(
    customerId: string | null,
    orderNumber: string,
    input: OrderCancelInput,
  ): Promise<OrderDto> {
    const order = await orderRepository.findByNumber(orderNumber);
    if (!order || (customerId !== null && order.customerId !== customerId)) {
      throw AppError.notFound('Order not found', { orderNumber });
    }

    const cancellable: OrderStatus[] = ['PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING'];
    if (!cancellable.includes(order.status as OrderStatus)) {
      throw new AppError(
        409,
        'ORDER_NOT_CANCELLABLE',
        `An order that is ${order.status} can no longer be cancelled here`,
        { status: order.status, cancellable },
      );
    }

    await checkoutService.releaseHolds(order, 'CANCELLED');

    const cancelled = await orderStateMachine.transition(order, 'CANCELLED', {
      note: input.note ?? input.reason,
      actorType: customerId ? 'CUSTOMER' : 'SYSTEM',
      actorId: customerId,
      data: { cancelledAt: new Date(), cancelReason: input.reason },
    });

    if (cancelled.paidPaise > 0) await this.requestRefundFor(cancelled, input);

    await notificationService.dispatch('ORDER_CANCELLED', { orderId: cancelled.id });

    return this.toDto(cancelled);
  },

  /** Creates the REQUESTED refund row. Execution belongs to 9B. */
  async requestRefundFor(order: OrderWithDetail, input: OrderCancelInput): Promise<void> {
    const captured = await paymentRepository.capturedFor(order.id);
    if (!captured) return;

    const count = await refundRepository.countForOrder(order.id);

    await refundRepository.create({
      orderId: order.id,
      paymentId: captured.id,
      refundNumber: `${order.orderNumber}/R${count + 1}`,
      amountPaise: order.paidPaise,
      status: 'REQUESTED',
      reason: input.reason,
      reasonNote: input.note ?? null,
      isFullRefund: true,
      requestedByType: order.customerId ? 'CUSTOMER' : 'SYSTEM',
      requestedById: order.customerId,
    });
  },

  /* ------------------------------------------------------------ admin */

  async listForAdmin(query: AdminOrderListQuery) {
    const page = await orderRepository.listForAdmin(query);

    const rows = await Promise.all(page.items.map((order) => this.toAdminRow(order)));
    return { ...page, items: rows };
  },

  async toAdminRow(order: OrderWithDetail): Promise<AdminOrderRowDto> {
    const [customer, failedTransfers] = await Promise.all([
      order.customerId
        ? prisma.customer.findUnique({
            where: { id: order.customerId },
            select: { name: true, email: true },
          })
        : Promise.resolve(null),
      paymentTransferRepository.failedForOrder(order.id),
    ]);

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status as OrderStatus,
      paymentStatus: order.paymentStatus as PaymentStatus,
      fulfillmentStatus: order.fulfillmentStatus as FulfillmentStatus,
      customerName: customer?.name ?? order.guestName,
      customerEmail: customer?.email ?? order.guestEmail,
      isGuest: order.isGuest,
      itemCount: order.items.length,
      grandTotalPaise: order.grandTotalPaise,
      paidPaise: order.paidPaise,
      refundedPaise: order.refundedPaise,
      couponCode: order.couponCode,
      channel: order.channel as OrderChannel,
      hasFailedTransfer: failedTransfers > 0,
      placedAt: order.placedAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
    };
  },

  async detailForAdmin(id: string): Promise<AdminOrderDetailDto> {
    const order = await orderRepository.findById(id);
    if (!order) throw AppError.notFound('Order not found', { id });

    const [row, payments, transfers, allocations, reservations, refunds, integrity] =
      await Promise.all([
        this.toAdminRow(order),
        paymentRepository.forOrder(order.id),
        paymentTransferRepository.forOrder(order.id),
        splitAllocationRepository.forOrder(order.id),
        stockReservationRepository.forOrder(order.id),
        refundRepository.forOrder(order.id),
        ledgerIntegrityService.verifyOrder(order.id),
      ]);

    const skus = new Map(order.items.map((item) => [item.variantId ?? '', item.sku]));

    return {
      ...row,
      order: this.toDto(order),
      payments: payments.map((payment): PaymentDto => ({
        id: payment.id,
        provider: payment.provider as PaymentProvider,
        method: payment.method as PaymentMethodType | null,
        methodDetail: payment.methodDetail,
        status: payment.status as PaymentStatus,
        attemptNumber: payment.attemptNumber,
        amountPaise: payment.amountPaise,
        capturedPaise: payment.capturedPaise,
        refundedPaise: payment.refundedPaise,
        feePaise: payment.feePaise,
        providerOrderId: payment.providerOrderId,
        providerPaymentId: payment.providerPaymentId,
        authorizedAt: payment.authorizedAt?.toISOString() ?? null,
        capturedAt: payment.capturedAt?.toISOString() ?? null,
        failedAt: payment.failedAt?.toISOString() ?? null,
        errorCode: payment.errorCode,
        errorDescription: payment.errorDescription,
        createdAt: payment.createdAt.toISOString(),
      })),
      transfers: transfers.map((transfer): PaymentTransferDto => ({
        id: transfer.id,
        paymentId: transfer.paymentId,
        splitAccountKey: transfer.account.key,
        splitAccountName: transfer.account.name,
        providerTransferId: transfer.providerTransferId,
        providerRecipientId: transfer.providerRecipientId,
        amountPaise: transfer.amountPaise,
        feePaise: transfer.feePaise,
        status: transfer.status as TransferStatus,
        onHold: transfer.onHold,
        reversedPaise: transfer.reversedPaise,
        settlementStatus: transfer.settlementStatus as SettlementStatus | null,
        processedAt: transfer.processedAt?.toISOString() ?? null,
        errorCode: transfer.errorCode,
        errorDescription: transfer.errorDescription,
      })),
      allocations: allocations.map((allocation): SplitAllocationDto => ({
        id: allocation.id,
        splitAccountKey: allocation.account.key,
        splitAccountName: allocation.account.name,
        providerAccountId: allocation.account.providerAccountId,
        splitRuleCode: allocation.rule?.code ?? null,
        orderItemId: allocation.orderItemId,
        amountPaise: allocation.amountPaise,
        basisAmountPaise: allocation.basisAmountPaise,
        mode: allocation.mode as SplitMode,
        sequence: allocation.sequence,
        isRemainder: allocation.isRemainder,
        note: allocation.note,
      })),
      reservations: reservations.map((reservation): StockReservationDto => ({
        id: reservation.id,
        variantId: reservation.variantId,
        sku: skus.get(reservation.variantId) ?? null,
        qty: reservation.qty,
        status: reservation.status as ReservationStatus,
        reservedAt: reservation.reservedAt.toISOString(),
        expiresAt: reservation.expiresAt.toISOString(),
        consumedAt: reservation.consumedAt?.toISOString() ?? null,
        releasedAt: reservation.releasedAt?.toISOString() ?? null,
        releaseReason: reservation.releaseReason,
      })),
      refunds: refunds.map((refund): RefundDto => ({
        id: refund.id,
        refundNumber: refund.refundNumber,
        orderId: refund.orderId,
        paymentId: refund.paymentId,
        amountPaise: refund.amountPaise,
        status: refund.status as RefundStatus,
        reason: refund.reason as RefundReason,
        reasonNote: refund.reasonNote,
        isFullRefund: refund.isFullRefund,
        providerRefundId: refund.providerRefundId,
        requestedByType: refund.requestedByType,
        approvedAt: refund.approvedAt?.toISOString() ?? null,
        processedAt: refund.processedAt?.toISOString() ?? null,
        errorCode: refund.errorCode,
        errorDescription: refund.errorDescription,
        createdAt: refund.createdAt.toISOString(),
      })),
      timeline: order.history.map(toTimelineDto),
      integrity,
    };
  },

  async timeline(orderId: string): Promise<OrderTimelineEntryDto[]> {
    const rows = await orderRepository.history(orderId);
    return rows.map(toTimelineDto);
  },
};
