import type { WebhookStatus } from '@shared/enums';

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { payment as paymentDriver } from '../../container';
import { orderRepository } from '../../repositories/order.repository';
import {
  paymentRepository,
  paymentTransferRepository,
  refundRepository,
  settlementRepository,
  webhookEventRepository,
} from '../../repositories/payment.repository';
import { redactedJson } from '../../drivers/payment';
import { AppError } from '../../utils/AppError';

import { checkoutService } from './checkout.service';
import { orderStateMachine } from './orderStateMachine';

/**
 * L3 — THE WEBHOOK IS THE SOURCE OF TRUTH.
 *
 * The browser's verify call is a nicety: it makes the confirmation page instant. Everything it
 * does is also reachable from here, so an order confirms correctly even if the shopper closes the
 * tab the moment they pay.
 *
 * FOUR RULES:
 *
 *  1. **Verify before parsing.** The HMAC is computed over the RAW body. Anything else would mean
 *     trusting JSON we have not authenticated yet.
 *  2. **Persist before acting.** A `WebhookEvent` row is written first, so an event that crashes
 *     mid-processing is still on record and replayable.
 *  3. **Once, and only once.** `providerEventId` is unique, and a second delivery is recorded as
 *     DUPLICATE and answered 200. Processing takes a compare-and-set lock, so five simultaneous
 *     deliveries produce exactly one state change.
 *  4. **Always 200 for a validly signed event.** Razorpay retries anything non-2xx, and a bug in
 *     our handler must not turn into a retry storm. A processing failure is surfaced as
 *     `status=FAILED` with an attempt count and replayed deliberately from the admin, which is
 *     visible and controllable in a way a provider's retry schedule is not.
 */

export interface WebhookResult {
  status: WebhookStatus;
  eventId: string | null;
  handled: boolean;
  message?: string;
}

const HANDLED_EVENTS = new Set([
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'order.paid',
  'refund.created',
  'refund.processed',
  'refund.failed',
  'transfer.processed',
  'transfer.failed',
  'settlement.processed',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

export const webhookService = {
  /**
   * Entry point for `POST /webhooks/razorpay`.
   *
   * @param rawBody the untouched request body — this route uses `express.raw`, not the JSON parser.
   */
  async receive(
    provider: string,
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<WebhookResult> {
    if (!signature || !paymentDriver.verifyWebhookSignature(rawBody, signature)) {
      // Not persisted: an unauthenticated body is not evidence of anything and storing it would
      // hand an attacker a free write to our database.
      logger.warn({ provider, bytes: rawBody.length }, 'webhook rejected: bad signature');
      throw new AppError(400, 'INVALID_WEBHOOK_SIGNATURE', 'Signature verification failed');
    }

    let parsed;
    try {
      parsed = paymentDriver.parseWebhook(rawBody);
    } catch (error) {
      logger.warn({ err: error }, 'webhook rejected: unparseable body');
      throw new AppError(400, 'INVALID_WEBHOOK_PAYLOAD', 'The webhook body could not be read');
    }

    const existing = await webhookEventRepository.findByProviderEventId(
      provider,
      parsed.providerEventId,
    );

    if (existing) {
      // A duplicate is normal — providers retry. It is recorded, not acted on.
      await webhookEventRepository
        .create({
          provider,
          providerEventId: `${parsed.providerEventId}:dup:${Date.now()}`,
          eventType: parsed.eventType,
          signatureValid: true,
          status: 'DUPLICATE',
          payloadJson: redactedJson(parsed.payload),
          relatedEntityType: existing.relatedEntityType,
          relatedEntityId: existing.relatedEntityId,
        })
        .catch(() => undefined);

      return { status: 'DUPLICATE', eventId: existing.id, handled: false };
    }

    const event = await webhookEventRepository
      .create({
        provider,
        providerEventId: parsed.providerEventId,
        eventType: parsed.eventType,
        signatureValid: true,
        status: 'RECEIVED',
        payloadJson: redactedJson(parsed.payload),
      })
      .catch(async () => {
        // Lost the insert race: somebody else persisted this exact event first.
        const row = await webhookEventRepository.findByProviderEventId(
          provider,
          parsed.providerEventId,
        );
        return row;
      });

    if (!event) return { status: 'DUPLICATE', eventId: null, handled: false };

    return this.process(event.id, parsed.eventType, parsed.entity);
  },

  /** Replays a stored event. Used by the admin route and by the tests. */
  async replay(eventId: string): Promise<WebhookResult> {
    const event = await webhookEventRepository.findById(eventId);
    if (!event) throw AppError.notFound('No such webhook event', { eventId });

    const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
    const container = asRecord(payload.payload);
    const entity =
      ['payment', 'refund', 'transfer', 'settlement', 'order']
        .map((key) => asRecord(asRecord(container[key]).entity))
        .find((candidate) => Object.keys(candidate).length > 0) ?? null;

    // Replay clears the terminal status so `claim` can take the lock again.
    await webhookEventRepository.update(eventId, { status: 'RECEIVED', processingLockedAt: null });

    return this.process(eventId, event.eventType, entity);
  },

  async process(
    eventId: string,
    eventType: string,
    entity: Record<string, unknown> | null,
  ): Promise<WebhookResult> {
    if (!HANDLED_EVENTS.has(eventType)) {
      await webhookEventRepository.release(eventId, 'IGNORED', `unhandled event ${eventType}`);
      return { status: 'IGNORED', eventId, handled: false, message: 'event not handled' };
    }

    // Exactly one caller gets the lock; concurrent deliveries stop here.
    const claimed = await webhookEventRepository.claim(eventId);
    if (!claimed) {
      return { status: 'DUPLICATE', eventId, handled: false, message: 'already being processed' };
    }

    try {
      const outcome = await this.dispatch(eventType, entity ?? {});

      await webhookEventRepository.update(eventId, {
        relatedEntityType: outcome.entityType,
        relatedEntityId: outcome.entityId,
      });
      await webhookEventRepository.release(eventId, outcome.handled ? 'PROCESSED' : 'IGNORED');

      return {
        status: outcome.handled ? 'PROCESSED' : 'IGNORED',
        eventId,
        handled: outcome.handled,
        ...(outcome.message ? { message: outcome.message } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      logger.error({ err: error, eventId, eventType }, 'webhook processing failed');

      const event = await webhookEventRepository.findById(eventId);
      const exhausted = (event?.attempts ?? 0) >= env.WEBHOOK_MAX_ATTEMPTS;

      await webhookEventRepository.release(eventId, 'FAILED', message);

      // Still a 200 to the provider: see rule 4 above.
      return {
        status: 'FAILED',
        eventId,
        handled: false,
        message: exhausted ? `${message} (retry limit reached)` : message,
      };
    }
  },

  async dispatch(
    eventType: string,
    entity: Record<string, unknown>,
  ): Promise<{
    handled: boolean;
    entityType: string | null;
    entityId: string | null;
    message?: string;
  }> {
    switch (eventType) {
      case 'payment.captured':
      case 'order.paid':
        return this.onPaymentCaptured(entity);
      case 'payment.authorized':
        return this.onPaymentAuthorized(entity);
      case 'payment.failed':
        return this.onPaymentFailed(entity);
      case 'refund.created':
      case 'refund.processed':
      case 'refund.failed':
        return this.onRefund(eventType, entity);
      case 'transfer.processed':
      case 'transfer.failed':
        return this.onTransfer(eventType, entity);
      case 'settlement.processed':
        return this.onSettlement(entity);
      default:
        return { handled: false, entityType: null, entityId: null };
    }
  },

  /* ----------------------------------------------------------- handlers */

  /**
   * The important one. A capture arriving BEFORE the browser's verify call must confirm the order
   * entirely on its own — and a capture arriving after it must change nothing.
   */
  async onPaymentCaptured(entity: Record<string, unknown>) {
    const providerPaymentId = String(entity.id ?? '');
    const providerOrderId = String(entity.order_id ?? '');

    const paymentRow =
      (await paymentRepository.findByProviderPaymentId('RAZORPAY', providerPaymentId)) ??
      (providerOrderId ? await paymentRepository.findByProviderOrderId(providerOrderId) : null);

    if (!paymentRow) {
      return {
        handled: false,
        entityType: 'Payment',
        entityId: providerPaymentId,
        message: 'no matching payment — ignored',
      };
    }

    const order = await orderRepository.findById(paymentRow.orderId);
    if (!order) {
      return { handled: false, entityType: 'Order', entityId: paymentRow.orderId };
    }

    // A stale event for an order that has already moved on is ignored, not an error.
    if (order.paymentStatus === 'CAPTURED') {
      return {
        handled: true,
        entityType: 'Order',
        entityId: order.id,
        message: 'already captured — no change',
      };
    }

    await checkoutService.confirmPayment({
      orderId: order.id,
      paymentId: paymentRow.id,
      providerPaymentId,
      method: typeof entity.method === 'string' ? entity.method : null,
      capturedPaise:
        typeof entity.amount_captured === 'number'
          ? entity.amount_captured
          : typeof entity.amount === 'number'
            ? entity.amount
            : undefined,
      feePaise: typeof entity.fee === 'number' ? entity.fee : null,
      source: 'WEBHOOK',
    });

    return { handled: true, entityType: 'Order', entityId: order.id };
  },

  async onPaymentAuthorized(entity: Record<string, unknown>) {
    const providerPaymentId = String(entity.id ?? '');
    const providerOrderId = String(entity.order_id ?? '');

    const paymentRow = providerOrderId
      ? await paymentRepository.findByProviderOrderId(providerOrderId)
      : null;

    if (!paymentRow) {
      return { handled: false, entityType: 'Payment', entityId: providerPaymentId };
    }
    if (paymentRow.status === 'CAPTURED') {
      return { handled: true, entityType: 'Payment', entityId: paymentRow.id };
    }

    await paymentRepository.update(paymentRow.id, {
      status: 'AUTHORIZED',
      providerPaymentId,
      authorizedAt: new Date(),
    });

    return { handled: true, entityType: 'Payment', entityId: paymentRow.id };
  },

  async onPaymentFailed(entity: Record<string, unknown>) {
    const providerOrderId = String(entity.order_id ?? '');
    const paymentRow = providerOrderId
      ? await paymentRepository.findByProviderOrderId(providerOrderId)
      : null;

    if (!paymentRow) return { handled: false, entityType: 'Payment', entityId: null };

    const order = await orderRepository.findById(paymentRow.orderId);
    if (!order) return { handled: false, entityType: 'Order', entityId: paymentRow.orderId };

    // Never unwind a confirmed order because a later attempt failed.
    if (order.paymentStatus === 'CAPTURED') {
      return {
        handled: true,
        entityType: 'Order',
        entityId: order.id,
        message: 'order already paid — failure ignored',
      };
    }

    await paymentRepository.update(paymentRow.id, {
      status: 'FAILED',
      failedAt: new Date(),
      errorCode: typeof entity.error_code === 'string' ? entity.error_code : null,
      errorDescription:
        typeof entity.error_description === 'string' ? entity.error_description : null,
    });

    await checkoutService.failOrder(order, 'PAYMENT_FAILED_WEBHOOK');
    return { handled: true, entityType: 'Order', entityId: order.id };
  },

  async onRefund(eventType: string, entity: Record<string, unknown>) {
    const providerRefundId = String(entity.id ?? '');

    // Refund EXECUTION is 9B; 9A records what the provider says so nothing is lost in the meantime.
    const status =
      eventType === 'refund.processed'
        ? 'PROCESSED'
        : eventType === 'refund.failed'
          ? 'FAILED'
          : 'PROCESSING';

    const row = await refundRepository.findByProviderRefundId(providerRefundId);

    if (!row) {
      return {
        handled: false,
        entityType: 'Refund',
        entityId: providerRefundId,
        message: 'no matching refund row — recorded only',
      };
    }

    await refundRepository.update(row.id, {
      status,
      ...(status === 'PROCESSED' ? { processedAt: new Date() } : {}),
      ...(status === 'FAILED' ? { failedAt: new Date() } : {}),
    });

    return { handled: true, entityType: 'Refund', entityId: row.id };
  },

  async onTransfer(eventType: string, entity: Record<string, unknown>) {
    const providerTransferId = String(entity.id ?? '');
    const transfer = await paymentTransferRepository.findByProviderTransferId(providerTransferId);

    if (!transfer) {
      return { handled: false, entityType: 'PaymentTransfer', entityId: providerTransferId };
    }

    const failed = eventType === 'transfer.failed';
    await paymentTransferRepository.update(transfer.id, {
      status: failed ? 'FAILED' : 'PROCESSED',
      ...(failed ? { failedAt: new Date() } : { processedAt: new Date() }),
      settlementStatus:
        typeof entity.settlement_status === 'string' ? entity.settlement_status : null,
    });

    return { handled: true, entityType: 'PaymentTransfer', entityId: transfer.id };
  },

  async onSettlement(entity: Record<string, unknown>) {
    const providerSettlementId = String(entity.id ?? '');

    const settlement = await settlementRepository.upsert({
      provider: 'RAZORPAY',
      providerSettlementId,
      amountPaise: Number(entity.amount ?? 0),
      feePaise: Number(entity.fees ?? 0),
      taxPaise: Number(entity.tax ?? 0),
      utr: typeof entity.utr === 'string' ? entity.utr : null,
      status: 'SETTLED',
      settledAt: new Date(),
      rawResponseJson: redactedJson(entity),
    });

    return { handled: true, entityType: 'Settlement', entityId: settlement.id };
  },

  /** Exposed so the state machine stays the only writer of order status. */
  stateMachine: orderStateMachine,
};
