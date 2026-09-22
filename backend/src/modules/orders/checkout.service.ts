import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import type { OrderChannel, PaymentProvider } from '@shared/enums';
import type { AddressCreateInput } from '@shared/schemas/cart';
import type { CheckoutInitInput, CheckoutPatchInput, PlaceOrderInput } from '@shared/schemas/order';
import type { CartIssueDto } from '@shared/types/cart';
import type {
  CheckoutPaymentMethodDto,
  CheckoutSessionDto,
  OrderAddressDto,
  PlaceOrderResultDto,
  VerifyPaymentResultDto,
} from '@shared/types/order';
import type { PriceBreakdown } from '@shared/types/pricing';

import { codEnabled, env } from '../../config/env';
import { logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import { payment as paymentDriver } from '../../container';
import { cartService } from '../cart/cart.service';
import { cartPricingService } from '../cart/cartPricing.service';
import { cartValidationService } from '../cart/cartValidation.service';
import { inventoryService } from '../catalog-admin/inventory.service';
import { couponRedemptionService } from '../pricing/coupon.redemption.service';
import { discountService } from '../pricing/discount.service';
import { shippingService } from '../pricing/shipping.service';
import { splitService } from '../payments/split/split.service';
import { addressRepository, type CartWithItems } from '../../repositories/cart.repository';
import {
  checkoutSessionRepository,
  orderRepository,
  stockReservationRepository,
  type OrderWithDetail,
} from '../../repositories/order.repository';
import { paymentRepository } from '../../repositories/payment.repository';
import { AppError } from '../../utils/AppError';
import { notificationService } from '../notifications/notification.service';

import { orderNumberService } from './orderNumber.service';
import { orderStateMachine } from './orderStateMachine';

/**
 * Checkout.
 *
 * THE FIVE LAWS LIVE HERE:
 *
 *  L1 the client never sends an amount. `placeOrder` takes a provider and nothing else that could
 *     influence money; the total is recomputed from the cart by the Prompt 6 engine at the instant
 *     the order is created.
 *  L2 the order freezes that breakdown. Every amount written to Order/OrderItem is copied out of
 *     the engine's output, and `breakdownJson` keeps the whole thing verbatim for replay.
 *  L3 the webhook is the source of truth. `verifyPayment` and the webhook handler funnel into the
 *     same `confirmPayment`, which is idempotent, so whichever arrives first wins and the other is
 *     a happy no-op.
 *  L4 money movement is double-entry. Allocations are persisted with the order; transfers are
 *     created from them after capture; the ledger check must balance.
 *  L5 nothing is held without a release path. Every reservation made here is released by payment
 *     failure, abandonment, cancellation or the expiry sweep — `releaseHolds` is the single exit.
 *
 * STOCK IS RESERVED HERE, NOT IN THE CART. The cart deliberately never touches `reservedQty`; this
 * is the first moment the shopper has committed enough for a hold to be fair to other shoppers.
 */

type SessionRow = Awaited<ReturnType<typeof checkoutSessionRepository.findById>>;

export interface CheckoutOwner {
  customerId: string | null;
  sessionId: string | null;
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  referrer?: string | null;
  channel?: OrderChannel;
}

interface ResolvedAddresses {
  shipping: OrderAddressDto;
  billing: OrderAddressDto;
  shippingAddressId: string | null;
  billingAddressId: string | null;
}

/** The quote the shopper agreed to, reduced to one comparable string. */
function hashQuote(breakdown: PriceBreakdown): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        grand: breakdown.grandTotalPaise,
        sub: breakdown.subtotalPaise,
        discount: breakdown.discountPaise,
        shipping: breakdown.shippingPaise,
        tax: breakdown.taxPaise,
        rounding: breakdown.roundingPaise,
        coupon: breakdown.appliedCouponCode ?? null,
        lines: breakdown.lines.map((line) => [line.lineId, line.qty, line.totalPaise]),
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

function toOrderAddress(
  input: AddressCreateInput | Record<string, unknown>,
  type: 'SHIPPING' | 'BILLING',
): OrderAddressDto {
  const source = input as Record<string, unknown>;
  const text = (key: string): string => String(source[key] ?? '');
  const nullable = (key: string): string | null =>
    source[key] === undefined || source[key] === null || source[key] === ''
      ? null
      : String(source[key]);

  return {
    type,
    fullName: text('fullName'),
    phone: text('phone'),
    altPhone: nullable('altPhone'),
    line1: text('line1'),
    line2: nullable('line2'),
    landmark: nullable('landmark'),
    city: text('city'),
    state: text('state'),
    stateCode: text('stateCode'),
    pincode: text('pincode'),
    country: String(source.country ?? 'IN'),
    deliveryInstructions: nullable('deliveryInstructions'),
  };
}

export const checkoutService = {
  /* -------------------------------------------------------------- init */

  /**
   * Opens a checkout for a cart.
   *
   * Refuses on ANY blocking cart issue — `autoFix` is deliberately false, because silently
   * changing what somebody is about to pay for is worse than making them look at it.
   */
  async init(
    cart: CartWithItems,
    input: CheckoutInitInput,
    owner: CheckoutOwner,
  ): Promise<CheckoutSessionDto> {
    if (cartPricingService.activeItems(cart).length === 0) {
      throw new AppError(422, 'CART_EMPTY', 'There is nothing in your cart to check out');
    }

    const validation = await cartValidationService.validate(cart, {
      autoFix: false,
      customerId: owner.customerId,
    });

    if (!validation.isCheckoutReady) {
      throw new AppError(
        422,
        'CART_NOT_CHECKOUT_READY',
        'Some items need attention before you can check out',
        { issues: validation.issues },
      );
    }

    const addresses = await this.resolveAddresses(input, owner);

    // The shipping pincode decides both the delivery promise and whether COD is on the table.
    const serviceability = await shippingService.serviceability(addresses.shipping.pincode);
    if (!serviceability.isServiceable) {
      throw new AppError(422, 'NOT_SERVICEABLE', 'We do not deliver to that pincode yet', {
        pincode: addresses.shipping.pincode,
      });
    }

    if (cart.pincode !== addresses.shipping.pincode) {
      await cartService.setPincode(cart, addresses.shipping.pincode);
      cart = await cartService.reload(cart.id);
    }

    const breakdown = await this.quote(cart, owner.customerId);

    const existing = await checkoutSessionRepository.findActiveForCart(cart.id);
    const payload = {
      cartId: cart.id,
      customerId: owner.customerId,
      sessionId: owner.sessionId,
      step: 'REVIEW',
      shippingAddressId: addresses.shippingAddressId,
      billingAddressId: addresses.billingAddressId,
      sameAsShipping: input.sameAsShipping,
      addressesJson: JSON.stringify({
        shipping: addresses.shipping,
        billing: addresses.billing,
      }),
      contactEmail: input.contact?.email ?? null,
      contactPhone: input.contact?.phone ?? null,
      customerNote: input.customerNote ?? null,
      giftMessage: input.giftMessage ?? null,
      quoteHash: hashQuote(breakdown),
      quotedTotalPaise: breakdown.grandTotalPaise,
      quotedAt: new Date(),
      expiresAt: new Date(Date.now() + env.CHECKOUT_HOLD_MINUTES * 60_000),
      status: 'ACTIVE',
    };

    const session = existing
      ? await checkoutSessionRepository.update(existing.id, payload)
      : await checkoutSessionRepository.create(payload);

    return this.toDto(session, cart, breakdown, validation.issues, serviceability);
  },

  /** Re-quotes on every read, so "the price changed while you were away" is always detectable. */
  async get(sessionId: string, owner: CheckoutOwner): Promise<CheckoutSessionDto> {
    const session = await this.owned(sessionId, owner);
    const cart = await cartService.reload(session.cartId);

    const [breakdown, validation] = await Promise.all([
      this.quote(cart, owner.customerId),
      cartValidationService.validate(cart, { autoFix: false, customerId: owner.customerId }),
    ]);

    const addresses = this.addressesOf(session);
    const serviceability = addresses.shipping
      ? await shippingService.serviceability(addresses.shipping.pincode)
      : null;

    return this.toDto(session, cart, breakdown, validation.issues, serviceability);
  },

  async patch(
    sessionId: string,
    input: CheckoutPatchInput,
    owner: CheckoutOwner,
  ): Promise<CheckoutSessionDto> {
    const session = await this.owned(sessionId, owner);
    if (session.orderId) {
      throw new AppError(409, 'CHECKOUT_ALREADY_PLACED', 'This checkout already created an order');
    }

    const current = this.addressesOf(session);
    const resolved =
      input.shippingAddressId ||
      input.shippingAddress ||
      input.billingAddressId ||
      input.billingAddress
        ? await this.resolveAddresses(
            {
              ...input,
              sameAsShipping: input.sameAsShipping ?? session.sameAsShipping,
            } as CheckoutInitInput,
            owner,
            current,
          )
        : null;

    const data: Prisma.CheckoutSessionUpdateInput = {
      ...(input.contact?.email !== undefined ? { contactEmail: input.contact.email } : {}),
      ...(input.contact?.phone !== undefined ? { contactPhone: input.contact.phone } : {}),
      ...(input.paymentProvider ? { paymentProvider: input.paymentProvider } : {}),
      ...(input.paymentMethodHint ? { paymentMethodHint: input.paymentMethodHint } : {}),
      ...(input.customerNote !== undefined ? { customerNote: input.customerNote } : {}),
      ...(input.giftMessage !== undefined ? { giftMessage: input.giftMessage } : {}),
      ...(input.sameAsShipping !== undefined ? { sameAsShipping: input.sameAsShipping } : {}),
      ...(resolved
        ? {
            shippingAddressId: resolved.shippingAddressId,
            billingAddressId: resolved.billingAddressId,
            addressesJson: JSON.stringify({
              shipping: resolved.shipping,
              billing: resolved.billing,
            }),
          }
        : {}),
    };

    await checkoutSessionRepository.update(sessionId, data);

    // A changed address can change shipping and tax, so the agreed quote is re-established here.
    const refreshed = await this.owned(sessionId, owner);
    const cart = await cartService.reload(refreshed.cartId);

    if (resolved && cart.pincode !== resolved.shipping.pincode) {
      await cartService.setPincode(cart, resolved.shipping.pincode);
    }

    const reloaded = await cartService.reload(refreshed.cartId);
    const breakdown = await this.quote(reloaded, owner.customerId);

    await checkoutSessionRepository.update(sessionId, {
      quoteHash: hashQuote(breakdown),
      quotedTotalPaise: breakdown.grandTotalPaise,
      quotedAt: new Date(),
    });

    return this.get(sessionId, owner);
  },

  /* ------------------------------------------------------------- place */

  /**
   * Creates the order.
   *
   * Local state is written in ONE transaction: number, order, items, addresses, reservations and
   * split allocations. The provider call happens AFTER it commits, because an external call inside
   * a transaction holds a database lock for as long as the internet takes — and if that call fails
   * we still want the order row to exist so its holds can be released deliberately.
   */
  async place(
    sessionId: string,
    input: PlaceOrderInput,
    owner: CheckoutOwner,
    meta: RequestMeta = {},
  ): Promise<PlaceOrderResultDto> {
    const session = await this.owned(sessionId, owner);

    if (session.orderId) {
      // Idempotent by nature: the same session must never create two orders.
      const existing = await orderRepository.findById(session.orderId);
      if (existing) return this.toPlaceResult(existing, owner);
    }

    const cart = await cartService.reload(session.cartId);

    const validation = await cartValidationService.validate(cart, {
      autoFix: false,
      customerId: owner.customerId,
    });
    if (!validation.isCheckoutReady) {
      throw new AppError(422, 'CART_NOT_CHECKOUT_READY', 'Some items need attention', {
        issues: validation.issues,
      });
    }

    const breakdown = await this.quote(cart, owner.customerId);

    // L1/L2: what the shopper agreed to is compared with what the engine says NOW, and a difference
    // stops the order rather than quietly charging a different number.
    if (hashQuote(breakdown) !== session.quoteHash) {
      throw new AppError(409, 'PRICE_CHANGED', 'The price changed while you were checking out', {
        previousTotalPaise: session.quotedTotalPaise,
        currentTotalPaise: breakdown.grandTotalPaise,
        breakdown,
      });
    }

    const provider = (input.paymentProvider ?? 'RAZORPAY') as PaymentProvider;
    await this.assertProviderAllowed(provider, breakdown.grandTotalPaise, cart);

    const addresses = this.addressesOf(session);
    if (!addresses.shipping) {
      throw new AppError(422, 'ADDRESS_REQUIRED', 'A shipping address is needed to place an order');
    }

    const order = await this.createOrder({
      cart,
      session,
      breakdown,
      addresses: addresses as { shipping: OrderAddressDto; billing: OrderAddressDto },
      owner,
      provider,
      meta,
    });

    if (provider === 'COD') return this.confirmCod(order, owner);

    // Everything above is committed; only now do we talk to the outside world.
    try {
      const providerOrder = await paymentDriver.createOrder({
        amountPaise: order.grandTotalPaise,
        currency: 'INR',
        receipt: order.orderNumber,
        notes: { orderId: order.id, orderNumber: order.orderNumber },
      });

      const paymentRow = await paymentRepository.create({
        orderId: order.id,
        provider: 'RAZORPAY',
        status: 'PENDING',
        attemptNumber: (await paymentRepository.countAttempts(order.id)) + 1,
        amountPaise: order.grandTotalPaise,
        providerOrderId: providerOrder.providerOrderId,
        idempotencyKey: order.orderNumber,
      });

      await checkoutSessionRepository.update(session.id, {
        step: 'PAYMENT',
        paymentProvider: provider,
      });

      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status as PlaceOrderResultDto['status'],
        paymentStatus: 'PENDING',
        provider,
        providerOrderId: providerOrder.providerOrderId,
        amountPaise: order.grandTotalPaise,
        currency: 'INR',
        keyId: env.RAZORPAY_KEY_ID ?? 'rzp_test_mock0000000000',
        prefill: {
          name: addresses.shipping.fullName,
          email: session.contactEmail,
          contact: addresses.shipping.phone,
        },
        requiresPayment: true,
        ...(paymentRow ? {} : {}),
      };
    } catch (error) {
      // L5: the provider refused, so nothing may stay held.
      logger.error({ err: error, orderId: order.id }, 'provider order creation failed');
      await this.failOrder(order, 'PROVIDER_ORDER_FAILED');
      throw error;
    }
  },

  /* ------------------------------------------------------------ verify */

  /**
   * The browser's optimistic confirmation. Everything it does is also reachable from the webhook,
   * so this is a convenience, never the only path (L3).
   */
  async verifyPayment(input: {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  }): Promise<VerifyPaymentResultDto> {
    const valid = paymentDriver.verifyPaymentSignature(input);

    if (!valid) {
      // Logged as a security event: a bad signature is either a bug or an attack, never routine.
      logger.warn(
        { providerOrderId: input.providerOrderId, providerPaymentId: input.providerPaymentId },
        'payment signature verification failed',
      );
      throw new AppError(400, 'INVALID_PAYMENT_SIGNATURE', 'That payment could not be verified');
    }

    const paymentRow = await paymentRepository.findByProviderOrderId(input.providerOrderId);
    if (!paymentRow) {
      throw AppError.notFound('No payment is waiting for that provider order', {
        providerOrderId: input.providerOrderId,
      });
    }

    const order = await orderRepository.findById(paymentRow.orderId);
    if (!order) throw AppError.notFound('Order not found', { orderId: paymentRow.orderId });

    const alreadyConfirmed = order.paymentStatus === 'CAPTURED';

    const confirmed = await this.confirmPayment({
      orderId: order.id,
      paymentId: paymentRow.id,
      providerPaymentId: input.providerPaymentId,
      signature: input.signature,
      source: 'VERIFY',
    });

    return {
      orderId: confirmed.id,
      orderNumber: confirmed.orderNumber,
      status: confirmed.status as VerifyPaymentResultDto['status'],
      paymentStatus: confirmed.paymentStatus as VerifyPaymentResultDto['paymentStatus'],
      alreadyConfirmed,
    };
  },

  /**
   * The one place an order becomes CONFIRMED. Called by the verify route AND by the webhook, and
   * safe to call any number of times: the compare-and-set on the payment decides who does the work.
   */
  async confirmPayment(input: {
    orderId: string;
    paymentId: string;
    providerPaymentId: string;
    signature?: string;
    method?: string | null;
    methodDetail?: string | null;
    capturedPaise?: number;
    feePaise?: number | null;
    source: 'VERIFY' | 'WEBHOOK';
  }): Promise<OrderWithDetail> {
    const order = await orderRepository.findById(input.orderId);
    if (!order) throw AppError.notFound('Order not found', { orderId: input.orderId });

    const won = await paymentRepository.markCaptured(input.paymentId, {
      providerPaymentId: input.providerPaymentId,
      ...(input.signature ? { providerSignature: input.signature } : {}),
      ...(input.method ? { method: input.method } : {}),
      ...(input.methodDetail ? { methodDetail: input.methodDetail } : {}),
      capturedPaise: input.capturedPaise ?? order.grandTotalPaise,
      ...(input.feePaise !== undefined && input.feePaise !== null
        ? { feePaise: input.feePaise }
        : {}),
    });

    if (!won) {
      // Somebody already captured this payment — the other side of the L3 race. Not an error.
      logger.debug(
        { orderId: order.id, source: input.source },
        'payment was already captured; confirmation is a no-op',
      );
      return (await orderRepository.findById(order.id))!;
    }

    const capturedPaise = input.capturedPaise ?? order.grandTotalPaise;

    await orderRepository.update(order.id, {
      paymentStatus: 'CAPTURED',
      paidPaise: capturedPaise,
      duePaise: Math.max(order.grandTotalPaise - capturedPaise, 0),
      confirmedAt: new Date(),
      expiresAt: null,
    });

    const reloaded = (await orderRepository.findById(order.id))!;

    await this.commitHolds(reloaded);

    const confirmed = await orderStateMachine.transition(reloaded, 'CONFIRMED', {
      note: `payment captured via ${input.source.toLowerCase()}`,
      actorType: 'SYSTEM',
    });

    // Transfers come last: a payout failure must never unwind a successful capture (L4).
    await splitService
      .createTransfers(order.id, input.paymentId, input.providerPaymentId)
      .catch((error: unknown) =>
        logger.error({ err: error, orderId: order.id }, 'split transfers failed after capture'),
      );

    await notificationService.dispatch('ORDER_CONFIRMED', { orderId: confirmed.id });

    return confirmed;
  },

  /* -------------------------------------------------------------- COD */

  async confirmCod(order: OrderWithDetail, owner: CheckoutOwner): Promise<PlaceOrderResultDto> {
    await paymentRepository.create({
      orderId: order.id,
      provider: 'COD',
      method: 'COD',
      status: 'PENDING',
      attemptNumber: 1,
      amountPaise: order.grandTotalPaise,
      // Cash never passes through the provider, so there is nothing to transfer.
      isTransferable: false,
    });

    await this.commitHolds(order);

    const confirmed = await orderStateMachine.transition(order, 'CONFIRMED', {
      note: 'cash on delivery — confirmed without a payment',
      actorType: 'SYSTEM',
      unpaidConfirmation: true,
    });

    await this.completeSessionFor(confirmed, owner);

    return {
      orderId: confirmed.id,
      orderNumber: confirmed.orderNumber,
      status: confirmed.status as PlaceOrderResultDto['status'],
      paymentStatus: 'PENDING',
      provider: 'COD',
      providerOrderId: null,
      amountPaise: confirmed.grandTotalPaise,
      currency: 'INR',
      keyId: null,
      prefill: { name: null, email: null, contact: null },
      requiresPayment: false,
    };
  },

  /* ------------------------------------------------------------- holds */

  /**
   * Turns reservations into a real stock movement and spends the coupon.
   *
   * `inventory.service.adjust` is the ONLY thing that writes stock — this records the sale through
   * it with reason ORDER_FULFILLED, which also hands the reserved units back so `reservedQty`
   * returns to where it was before the order.
   */
  async commitHolds(order: OrderWithDetail): Promise<void> {
    const reservations = await stockReservationRepository.active(order.id);

    for (const reservation of reservations) {
      const settled = await stockReservationRepository.settle(reservation.id, 'CONSUMED');
      if (!settled) continue;

      try {
        await inventoryService.release(reservation.variantId, reservation.qty, {
          type: 'ORDER',
          id: order.id,
        });

        const { entry } = await inventoryService.adjust(
          reservation.variantId,
          {
            delta: -reservation.qty,
            reason: 'ORDER_FULFILLED',
            note: `order ${order.orderNumber}`,
            refType: 'ORDER',
            refId: order.id,
          },
          { actorType: 'SYSTEM', actorId: null },
        );

        await prisma.stockReservation.update({
          where: { id: reservation.id },
          data: { inventoryLedgerIdOnConsume: entry.id },
        });
      } catch (error) {
        // The money already moved; a stock write failing is an operations problem, not a rollback.
        logger.error(
          { err: error, orderId: order.id, variantId: reservation.variantId },
          'could not consume a stock reservation for a paid order',
        );
      }
    }

    await this.settleCoupon(order, 'CONFIRM');
    await this.markCartConverted(order);
  },

  /** L5's single exit: everything this order is holding goes back. Safe to call twice. */
  async releaseHolds(order: OrderWithDetail, reason: string): Promise<void> {
    const reservations = await stockReservationRepository.active(order.id);

    for (const reservation of reservations) {
      const settled = await stockReservationRepository.settle(
        reservation.id,
        reason === 'EXPIRED' ? 'EXPIRED' : 'RELEASED',
        { releaseReason: reason },
      );
      // A reservation that was already settled must not release the same units a second time.
      if (!settled) continue;

      await inventoryService
        .release(reservation.variantId, reservation.qty, { type: 'ORDER', id: order.id })
        .catch((error: unknown) =>
          logger.error(
            { err: error, orderId: order.id, variantId: reservation.variantId },
            'could not release a stock reservation',
          ),
        );
    }

    await this.settleCoupon(order, 'RELEASE');
  },

  async settleCoupon(order: OrderWithDetail, action: 'CONFIRM' | 'RELEASE'): Promise<void> {
    if (!order.couponCode) return;

    const redemption = await prisma.couponRedemption.findFirst({
      where: { orderId: order.id, status: 'RESERVED' },
    });
    if (!redemption) return;

    try {
      if (action === 'CONFIRM') await couponRedemptionService.confirm(redemption.id, order.id);
      else await couponRedemptionService.release(redemption.id);
    } catch (error) {
      logger.error({ err: error, orderId: order.id, action }, 'coupon redemption could not settle');
    }
  },

  async markCartConverted(order: OrderWithDetail): Promise<void> {
    if (!order.cartId) return;

    await prisma.cart
      .updateMany({
        where: { id: order.cartId, status: 'ACTIVE' },
        data: { status: 'CONVERTED', convertedOrderId: order.id, activeOwnerKey: null },
      })
      .catch((error: unknown) =>
        logger.warn({ err: error, cartId: order.cartId }, 'cart could not be marked converted'),
      );
  },

  /* ----------------------------------------------------- failure paths */

  async failOrder(order: OrderWithDetail, reason: string): Promise<OrderWithDetail> {
    await this.releaseHolds(order, reason);

    await orderRepository.update(order.id, { paymentStatus: 'FAILED' });
    const reloaded = (await orderRepository.findById(order.id))!;

    const failed = await orderStateMachine.transition(reloaded, 'PAYMENT_FAILED', {
      note: reason,
      actorType: 'SYSTEM',
    });

    await notificationService.dispatch('PAYMENT_FAILED', { orderId: failed.id });

    return failed;
  },

  async abandon(sessionId: string, owner: CheckoutOwner): Promise<{ released: boolean }> {
    const session = await this.owned(sessionId, owner);

    await checkoutSessionRepository.update(sessionId, { status: 'ABANDONED' });

    if (!session.orderId) return { released: false };

    const order = await orderRepository.findById(session.orderId);
    // A confirmed order is never unwound by somebody closing a tab.
    if (!order || order.status !== 'PENDING_PAYMENT') return { released: false };

    await this.failOrder(order, 'ABANDONED');
    return { released: true };
  },

  /** The sweep. Anything still PENDING_PAYMENT past its expiry gives its holds back. */
  async expireStaleOrders(limit = 100, now = new Date()): Promise<number> {
    const stale = await orderRepository.findExpired(now, limit);
    let expired = 0;

    for (const order of stale) {
      await this.releaseHolds(order, 'EXPIRED');
      await orderRepository.update(order.id, { paymentStatus: 'EXPIRED' });

      const reloaded = (await orderRepository.findById(order.id))!;
      await orderStateMachine.transition(reloaded, 'EXPIRED', {
        note: 'payment window lapsed',
        actorType: 'SYSTEM',
      });
      expired += 1;
    }

    await checkoutSessionRepository.expireStale(now);
    return expired;
  },

  /* ------------------------------------------------------------ helpers */

  async quote(cart: CartWithItems, customerId: string | null): Promise<PriceBreakdown> {
    const { breakdown } = await cartPricingService.quote(cart, { customerId, persist: false });
    return breakdown;
  },

  async owned(sessionId: string, owner: CheckoutOwner): Promise<NonNullable<SessionRow>> {
    const session = await checkoutSessionRepository.findById(sessionId);

    // A miss and a mismatch answer the same way, so session ids cannot be enumerated.
    const mine = session
      ? owner.customerId
        ? session.customerId === owner.customerId
        : session.sessionId === owner.sessionId
      : false;

    if (!session || !mine) throw AppError.notFound('Checkout session not found', { sessionId });
    return session;
  },

  addressesOf(session: NonNullable<SessionRow>): {
    shipping: OrderAddressDto | null;
    billing: OrderAddressDto | null;
  } {
    if (!session.addressesJson) return { shipping: null, billing: null };

    try {
      const parsed = JSON.parse(session.addressesJson) as {
        shipping?: OrderAddressDto;
        billing?: OrderAddressDto;
      };
      return { shipping: parsed.shipping ?? null, billing: parsed.billing ?? null };
    } catch {
      return { shipping: null, billing: null };
    }
  },

  /**
   * Saved addresses are re-read from the book (and ownership enforced); guests may pass one inline.
   * Either way the result is a SNAPSHOT — the order never points at a mutable address row.
   */
  async resolveAddresses(
    input: CheckoutInitInput,
    owner: CheckoutOwner,
    fallback?: { shipping: OrderAddressDto | null; billing: OrderAddressDto | null },
  ): Promise<ResolvedAddresses> {
    let shipping: OrderAddressDto | null = fallback?.shipping ?? null;
    let shippingAddressId: string | null = null;

    if (input.shippingAddressId) {
      if (!owner.customerId) {
        throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to use a saved address');
      }
      const row = await addressRepository.findOwned(owner.customerId, input.shippingAddressId);
      if (!row) throw AppError.notFound('That address is not in your address book');

      shipping = toOrderAddress(row, 'SHIPPING');
      shippingAddressId = row.id;
    } else if (input.shippingAddress) {
      shipping = toOrderAddress(input.shippingAddress, 'SHIPPING');
    }

    if (!shipping) {
      throw new AppError(422, 'ADDRESS_REQUIRED', 'A shipping address is needed to check out');
    }

    let billing: OrderAddressDto = { ...shipping, type: 'BILLING' };
    let billingAddressId: string | null = shippingAddressId;

    if (!input.sameAsShipping) {
      if (input.billingAddressId) {
        if (!owner.customerId) {
          throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to use a saved address');
        }
        const row = await addressRepository.findOwned(owner.customerId, input.billingAddressId);
        if (!row) throw AppError.notFound('That address is not in your address book');

        billing = toOrderAddress(row, 'BILLING');
        billingAddressId = row.id;
      } else if (input.billingAddress) {
        billing = toOrderAddress(input.billingAddress, 'BILLING');
        billingAddressId = null;
      }
    }

    return { shipping, billing, shippingAddressId, billingAddressId };
  },

  async assertProviderAllowed(
    provider: PaymentProvider,
    amountPaise: number,
    cart: CartWithItems,
  ): Promise<void> {
    if (provider !== 'COD') return;

    if (!codEnabled) {
      throw new AppError(422, 'COD_UNAVAILABLE', 'Cash on delivery is switched off');
    }
    if (amountPaise > env.COD_MAX_ORDER_PAISE) {
      throw new AppError(
        422,
        'COD_LIMIT_EXCEEDED',
        'This order is too large for cash on delivery',
        {
          maxPaise: env.COD_MAX_ORDER_PAISE,
          amountPaise,
        },
      );
    }

    if (cart.pincode) {
      const serviceability = await shippingService.serviceability(cart.pincode);
      if (!serviceability.codAvailable) {
        throw new AppError(
          422,
          'COD_UNAVAILABLE',
          'Cash on delivery is not offered at that pincode',
        );
      }
    }
  },

  async methodsFor(
    amountPaise: number,
    codAvailable: boolean,
  ): Promise<CheckoutPaymentMethodDto[]> {
    const codReason = !codEnabled
      ? 'Cash on delivery is switched off'
      : !codAvailable
        ? 'Not offered at this pincode'
        : amountPaise > env.COD_MAX_ORDER_PAISE
          ? 'This order is too large for cash on delivery'
          : null;

    return [
      {
        provider: 'RAZORPAY',
        label: 'Card, UPI, netbanking or wallet',
        isAvailable: true,
        unavailableReason: null,
      },
      {
        provider: 'COD',
        label: 'Cash on delivery',
        isAvailable: codReason === null,
        unavailableReason: codReason,
      },
    ];
  },

  async toDto(
    session: NonNullable<SessionRow>,
    cart: CartWithItems,
    breakdown: PriceBreakdown,
    issues: CartIssueDto[],
    serviceability: Awaited<ReturnType<typeof shippingService.serviceability>> | null,
  ): Promise<CheckoutSessionDto> {
    const addresses = this.addressesOf(session);

    return {
      id: session.id,
      step: session.step as CheckoutSessionDto['step'],
      cartId: session.cartId,
      orderId: session.orderId,
      contactEmail: session.contactEmail,
      contactPhone: session.contactPhone,
      shippingAddress: addresses.shipping,
      billingAddress: addresses.billing,
      sameAsShipping: session.sameAsShipping,
      breakdown,
      quotedTotalPaise: session.quotedTotalPaise,
      quoteHash: session.quoteHash,
      priceChanged: hashQuote(breakdown) !== session.quoteHash,
      methods: await this.methodsFor(
        breakdown.grandTotalPaise,
        serviceability?.codAvailable ?? false,
      ),
      issues,
      isCheckoutReady: issues.every((issue) => issue.severity !== 'BLOCKING'),
      etaMinDays: serviceability?.etaMinDays ?? null,
      etaMaxDays: serviceability?.etaMaxDays ?? null,
      codAvailable: (serviceability?.codAvailable ?? false) && codEnabled,
      expiresAt: session.expiresAt.toISOString(),
      status: session.status,
      version: session.version,
    };
  },

  toPlaceResult(order: OrderWithDetail, _owner: CheckoutOwner): PlaceOrderResultDto {
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status as PlaceOrderResultDto['status'],
      paymentStatus: order.paymentStatus as PlaceOrderResultDto['paymentStatus'],
      provider: 'RAZORPAY',
      providerOrderId: null,
      amountPaise: order.grandTotalPaise,
      currency: 'INR',
      keyId: env.RAZORPAY_KEY_ID ?? null,
      prefill: { name: null, email: null, contact: null },
      requiresPayment: order.paymentStatus !== 'CAPTURED',
    };
  },

  async completeSessionFor(order: OrderWithDetail, _owner: CheckoutOwner): Promise<void> {
    await prisma.checkoutSession.updateMany({
      where: { orderId: order.id },
      data: { step: 'COMPLETE', status: 'COMPLETED' },
    });
  },

  /* --------------------------------------------------- order creation */

  /** The single transaction. Everything in here commits together or not at all. */
  async createOrder(args: {
    cart: CartWithItems;
    session: NonNullable<SessionRow>;
    breakdown: PriceBreakdown;
    addresses: { shipping: OrderAddressDto; billing: OrderAddressDto };
    owner: CheckoutOwner;
    provider: PaymentProvider;
    meta: RequestMeta;
  }): Promise<OrderWithDetail> {
    const { cart, session, breakdown, addresses, owner, meta } = args;

    const items = cartPricingService.activeItems(cart);
    const byLineId = new Map(breakdown.lines.map((line, index) => [items[index]!.id, line]));

    const [snapshots, coupon, serviceability] = await Promise.all([
      orderRepository.productSnapshotFacts(items.map((item) => item.productId)),
      cart.couponCode ? discountService.findCouponByCode(cart.couponCode) : Promise.resolve(null),
      shippingService.serviceability(addresses.shipping.pincode),
    ]);

    const snapshotById = new Map(snapshots.map((row) => [row.id, row]));
    const lineDtos = await cartService.linesToDto(cart, 'IN_CART', byLineId);
    const lineDtoById = new Map(lineDtos.map((line) => [line.id, line]));

    const { orderNumber } = await orderNumberService.allocate();

    const orderItems: Prisma.OrderItemUncheckedCreateWithoutOrderInput[] = items.map(
      (item, index) => {
        const line = byLineId.get(item.id)!;
        const snapshot = snapshotById.get(item.productId);
        const dto = lineDtoById.get(item.id);

        return {
          productId: item.productId,
          variantId: item.variantId,
          sku: dto?.sku ?? item.skuSnapshot,
          productName: dto?.name ?? item.productNameSnapshot,
          variantName: dto?.variantName ?? item.variantNameSnapshot,
          brandName: snapshot?.brand?.name ?? null,
          primaryCategoryPath: snapshot?.categories[0]?.category.path ?? null,
          imageMediaId: dto?.image?.mediaId ?? item.imageMediaIdSnapshot,
          imageUrlSnapshot: dto?.image?.url ?? null,
          selectedOptionsJson: item.selectedOptionsJson,
          optionLabelsJson: JSON.stringify(
            (dto?.options ?? []).map((option) => ({
              label: option.attributeName,
              value: option.label,
            })),
          ),
          customizationJson: item.customizationJson,
          customizationHash: item.customizationHash,
          qty: item.qty,
          unitPricePaise: line.unitPricePaise,
          baseUnitPricePaise: line.baseUnitPaise,
          lineSubtotalPaise: line.subtotalPaise,
          lineDiscountPaise: line.discountPaise,
          taxablePaise: line.taxablePaise,
          taxPaise: line.taxPaise,
          taxRateBp: line.taxRateBp,
          cgstPaise: line.taxSplit.cgstPaise,
          sgstPaise: line.taxSplit.sgstPaise,
          igstPaise: line.taxSplit.igstPaise,
          hsnCode: line.hsnCode ?? null,
          lineTotalPaise: line.totalPaise,
          // L2 — the engine's own components, frozen.
          componentsJson: JSON.stringify(line.components),
          isMadeToOrder: line.isMadeToOrder,
          leadTimeDays: line.leadTimeDays ?? null,
          weightGrams: snapshot?.weightGrams ?? null,
          position: index,
        };
      },
    );

    const expiresAt = new Date(Date.now() + env.CHECKOUT_HOLD_MINUTES * 60_000);

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderNumber,
          customerId: owner.customerId,
          cartId: cart.id,
          isGuest: owner.customerId === null,
          guestEmail: owner.customerId ? null : session.contactEmail,
          guestPhone: owner.customerId ? null : session.contactPhone,
          guestName: owner.customerId ? null : addresses.shipping.fullName,
          status: 'DRAFT',
          paymentStatus: 'PENDING',
          fulfillmentStatus: 'UNFULFILLED',
          channel: meta.channel ?? 'WEB',
          currency: 'INR',
          customerGroupCode: cart.customerGroupIdSnapshot,
          placeOfSupply: breakdown.placeOfSupply.buyerStateCode,
          sellerStateCode: breakdown.placeOfSupply.sellerStateCode,
          subtotalPaise: breakdown.subtotalPaise,
          discountPaise: breakdown.discountPaise,
          shippingPaise: breakdown.shippingPaise,
          taxPaise: breakdown.taxPaise,
          cgstPaise: breakdown.taxSplit.cgstPaise,
          sgstPaise: breakdown.taxSplit.sgstPaise,
          igstPaise: breakdown.taxSplit.igstPaise,
          roundingPaise: breakdown.roundingPaise,
          grandTotalPaise: breakdown.grandTotalPaise,
          totalSavingsPaise: breakdown.totalSavingsPaise,
          duePaise: breakdown.grandTotalPaise,
          couponCode: breakdown.appliedCouponCode ?? null,
          appliedRuleIdsJson: JSON.stringify(breakdown.appliedRuleIds),
          breakdownJson: JSON.stringify(breakdown),
          pricingEngineVersion: String(breakdown.engineVersion),
          pricingContextHash: breakdown.contextHash,
          customerNote: session.customerNote,
          giftMessage: session.giftMessage,
          ipAddress: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          referrer: meta.referrer ?? null,
          placedAt: new Date(),
          expiresAt,
          estimatedDeliveryMinDays: serviceability.etaMinDays,
          estimatedDeliveryMaxDays: serviceability.etaMaxDays,
          items: { create: orderItems },
          addresses: {
            create: [
              { ...addresses.shipping, sourceAddressId: session.shippingAddressId },
              { ...addresses.billing, sourceAddressId: session.billingAddressId },
            ],
          },
          history: {
            create: {
              toStatus: 'DRAFT',
              note: 'order created',
              actorType: owner.customerId ? 'CUSTOMER' : 'GUEST',
              actorId: owner.customerId,
              isCustomerVisible: false,
            },
          },
        },
        include: {
          items: { orderBy: { position: 'asc' } },
          addresses: true,
          history: { orderBy: { createdAt: 'asc' } },
        },
      });

      return created as OrderWithDetail;
    });

    // Holds are taken outside the create so `inventory.service` keeps owning every stock write.
    await this.takeHolds(order, coupon?.id ?? null, owner, expiresAt);

    const transferable = order.grandTotalPaise;
    await prisma.$transaction(async (tx) => {
      await splitService.persistForOrder(order, transferable, tx);
    });

    await checkoutSessionRepository.update(session.id, { orderId: order.id, step: 'PAYMENT' });

    const pending = await orderStateMachine.transition(order, 'PENDING_PAYMENT', {
      note: 'awaiting payment',
      actorType: 'SYSTEM',
      isCustomerVisible: false,
      data: { expiresAt },
    });

    // After the commit, and unable to fail the placement. See notification.service.
    await notificationService.dispatch('ORDER_PLACED', { orderId: pending.id });

    return pending;
  },

  /**
   * Reserves stock and the coupon slot. If any of it fails, everything taken so far is given back
   * before the error propagates — a half-held order would strand somebody else's stock (L5).
   */
  async takeHolds(
    order: OrderWithDetail,
    couponId: string | null,
    owner: CheckoutOwner,
    expiresAt: Date,
  ): Promise<void> {
    const reserved: { variantId: string; qty: number }[] = [];

    try {
      for (const item of order.items) {
        if (!item.variantId) continue;

        await inventoryService.reserve(item.variantId, item.qty, { type: 'ORDER', id: order.id });
        reserved.push({ variantId: item.variantId, qty: item.qty });

        await stockReservationRepository.createMany([
          {
            orderId: order.id,
            orderItemId: item.id,
            variantId: item.variantId,
            qty: item.qty,
            status: 'RESERVED',
            expiresAt,
          },
        ]);
      }

      if (couponId) {
        await couponRedemptionService.reserve({
          couponId,
          customerId: owner.customerId,
          orderId: order.id,
          amountPaise: order.discountPaise,
        });
      }
    } catch (error) {
      for (const hold of reserved) {
        await inventoryService
          .release(hold.variantId, hold.qty, { type: 'ORDER', id: order.id })
          .catch(() => undefined);
      }
      await prisma.stockReservation.updateMany({
        where: { orderId: order.id, status: 'RESERVED' },
        data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: 'HOLD_FAILED' },
      });

      throw error;
    }
  },
};
