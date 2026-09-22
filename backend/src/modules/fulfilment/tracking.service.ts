import type { ShipmentStatus, WebhookStatus } from '@shared/enums';

import { logger } from '../../config/logger';
import { redactedShippingJson, type ParsedShippingWebhook } from '../../drivers/shipping';
import { webhookEventRepository } from '../../repositories/payment.repository';
import {
  ndrRepository,
  shipmentEventRepository,
  shipmentRepository,
  type ShipmentWithDetail,
} from '../../repositories/shipment.repository';
import { AppError } from '../../utils/AppError';

import { providerGateway } from './providerGateway.service';
import { shipmentService } from './shipment.service';
import { assertTransition, canTransition, mapProviderStatus } from './shipmentStateMachine';

/**
 * Tracking: turning what a courier says into what a customer sees.
 *
 * THE COURIER IS THE SOURCE OF TRUTH FOR WHERE A PARCEL IS — but not for what our system does about
 * it. So every inbound update is subjected to the same three rules the payment webhook already
 * follows, and this service deliberately REUSES `WebhookEvent` rather than inventing a second
 * webhook table: one inbox, one replay mechanism, one place an admin looks when something is wrong.
 *
 *  1. **Verify before parsing.** The provider's token is checked against the RAW body first.
 *  2. **Persist before acting.** The event is stored, so a crash mid-processing is still on record.
 *  3. **Once, and only once.** `providerEventId` is unique and scans carry a `dedupeKey`, so a
 *     replayed delivery cannot double a timeline or re-run a side effect.
 *
 * And one rule of its own: **an unrecognised courier status records an event and changes nothing.**
 * Guessing a parcel forward is how a customer gets told their sofa was delivered to an empty house.
 */

export interface ShippingWebhookResult {
  status: WebhookStatus;
  eventId: string | null;
  handled: boolean;
  shipmentNumber?: string;
  message?: string;
}

const SYSTEM_ACTOR = { actorType: 'SYSTEM' as const, actorId: null, actorName: 'Courier webhook' };

export const trackingService = {
  /**
   * Entry point for `POST /api/v1/webhooks/shipping/:providerCode`.
   *
   * @param rawBody the untouched body — this route uses `express.raw`, not the JSON parser.
   */
  async receive(
    providerCode: string,
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<ShippingWebhookResult> {
    const { driver } = await providerGateway.resolve(providerCode).catch(() => {
      // An unknown provider posting to us is not an outage, it is noise.
      throw new AppError(404, 'SHIPPING_PROVIDER_UNKNOWN', 'No such shipping provider');
    });

    if (!driver.verifyWebhook(rawBody, headers)) {
      // Not persisted: an unauthenticated body is not evidence and storing it would hand an
      // attacker a free write to our database.
      logger.warn({ providerCode, bytes: rawBody.length }, 'shipping webhook rejected: bad token');
      throw new AppError(401, 'INVALID_WEBHOOK_SIGNATURE', 'Webhook verification failed');
    }

    let parsed: ParsedShippingWebhook;
    try {
      parsed = driver.parseWebhook(rawBody);
    } catch {
      throw new AppError(400, 'INVALID_WEBHOOK_PAYLOAD', 'The webhook body could not be read');
    }

    const provider = `shipping:${providerCode}`;

    const existing = await webhookEventRepository.findByProviderEventId(
      provider,
      parsed.providerEventId,
    );

    if (existing) {
      // Duplicates are normal — couriers retry. Recorded, not acted on.
      await webhookEventRepository
        .create({
          provider,
          providerEventId: `${parsed.providerEventId}:dup:${Date.now()}`,
          eventType: parsed.eventType,
          signatureValid: true,
          status: 'DUPLICATE',
          payloadJson: redactedShippingJson(parsed.payload),
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
        payloadJson: redactedShippingJson(parsed.payload),
      })
      .catch(async () =>
        // Lost the insert race: somebody persisted this exact event first.
        webhookEventRepository.findByProviderEventId(provider, parsed.providerEventId),
      );

    if (!event) return { status: 'DUPLICATE', eventId: null, handled: false };

    return this.process(event.id, providerCode, parsed);
  },

  /** Replays a stored courier event. Used by the admin route and by the tests. */
  async replay(eventId: string): Promise<ShippingWebhookResult> {
    const event = await webhookEventRepository.findById(eventId);
    if (!event) throw AppError.notFound('No such webhook event', { eventId });

    if (!event.provider.startsWith('shipping:')) {
      throw new AppError(422, 'WEBHOOK_NOT_SHIPPING', 'That event is not a shipping event');
    }

    const providerCode = event.provider.slice('shipping:'.length);
    const { driver } = await providerGateway.resolve(providerCode);

    const parsed = driver.parseWebhook(Buffer.from(event.payloadJson, 'utf8'));

    // Replay clears the terminal status so `claim` can take the lock again.
    await webhookEventRepository.update(eventId, { status: 'RECEIVED', processingLockedAt: null });

    return this.process(eventId, providerCode, parsed);
  },

  async process(
    eventId: string,
    providerCode: string,
    parsed: ParsedShippingWebhook,
  ): Promise<ShippingWebhookResult> {
    // Exactly one caller gets the lock; concurrent deliveries stop here.
    const claimed = await webhookEventRepository.claim(eventId);
    if (!claimed) {
      return { status: 'DUPLICATE', eventId, handled: false, message: 'already being processed' };
    }

    try {
      const shipment = await shipmentRepository.findByProviderRef(providerCode, {
        providerShipmentId: parsed.providerShipmentId,
        awbNumber: parsed.awbNumber,
        referenceNumber: parsed.referenceNumber,
      });

      if (!shipment) {
        // Kept, not discarded: an event we cannot place is exactly the evidence reconciliation
        // needs, and the shipment may simply not have been created yet.
        await webhookEventRepository.release(
          eventId,
          'IGNORED',
          `no shipment matched awb=${parsed.awbNumber ?? '-'}`,
        );
        return { status: 'IGNORED', eventId, handled: false, message: 'no matching shipment' };
      }

      const outcome = await this.applyUpdate(shipment, parsed, 'PROVIDER_WEBHOOK');

      await webhookEventRepository.update(eventId, {
        relatedEntityType: 'Shipment',
        relatedEntityId: shipment.id,
      });
      await webhookEventRepository.release(eventId, 'PROCESSED');

      return {
        status: 'PROCESSED',
        eventId,
        handled: true,
        shipmentNumber: shipment.shipmentNumber,
        ...(outcome.message ? { message: outcome.message } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      logger.error({ err: error, eventId, providerCode }, 'shipping webhook processing failed');

      await webhookEventRepository.release(eventId, 'FAILED', message);

      // Still answered 200 by the controller: a bug here must not become a courier retry storm,
      // and Shiprocket in particular documents that it expects 200 and nothing else.
      return { status: 'FAILED', eventId, handled: false, message };
    }
  },

  /**
   * The one place a courier update changes a shipment.
   *
   * Shared by the webhook and the poller, so both paths behave identically — which is what makes a
   * missed webhook a latency problem rather than a correctness problem.
   */
  async applyUpdate(
    shipment: ShipmentWithDetail,
    update: {
      providerStatus: string | null;
      providerStatusCode: string | null;
      courierName?: string | null;
      estimatedDeliveryAt?: string | null;
      scans: { occurredAt: string; description: string; location: string | null; providerStatus: string | null; providerStatusCode: string | null; dedupeKey: string }[];
    },
    source: 'PROVIDER_WEBHOOK' | 'PROVIDER_POLL',
  ): Promise<{ changed: boolean; message?: string }> {
    let appended = 0;

    // Scans first: the timeline is a record of what the courier said, independent of whether we
    // recognise the status it implies.
    for (const scan of update.scans) {
      const mapped = mapProviderStatus(scan.providerStatus, scan.providerStatusCode);

      const { created } = await shipmentEventRepository.append({
        shipmentId: shipment.id,
        status: mapped,
        providerStatus: scan.providerStatus,
        providerStatusCode: scan.providerStatusCode,
        description: scan.description || (scan.providerStatus ?? 'Courier update'),
        location: scan.location,
        source,
        dedupeKey: scan.dedupeKey,
        occurredAt: new Date(scan.occurredAt),
        isCustomerVisible: true,
      });

      if (created) appended += 1;
    }

    const target = mapProviderStatus(update.providerStatus, update.providerStatusCode);
    const current = shipment.status as ShipmentStatus;

    const baseUpdate = {
      providerStatus: update.providerStatus,
      providerStatusCode: update.providerStatusCode,
      providerUpdatedAt: new Date(),
      lastSyncedAt: new Date(),
      ...(update.courierName ? { providerCourierName: update.courierName } : {}),
      ...(update.estimatedDeliveryAt
        ? { estimatedDeliveryAt: new Date(update.estimatedDeliveryAt) }
        : {}),
    };

    if (!target) {
      // Recorded and left alone. See the note at the top of this file.
      await shipmentRepository.update(shipment.id, baseUpdate);
      logger.info(
        { shipmentNumber: shipment.shipmentNumber, providerStatus: update.providerStatus },
        'unrecognised courier status recorded without changing the shipment',
      );
      return { changed: appended > 0, message: 'status not recognised' };
    }

    if (target === current) {
      await shipmentRepository.update(shipment.id, baseUpdate);
      return { changed: appended > 0 };
    }

    if (!canTransition(current, target)) {
      // Couriers do send events out of order. Refusing a backwards move is correct; failing the
      // webhook over it is not.
      await shipmentRepository.update(shipment.id, baseUpdate);
      logger.warn(
        { shipmentNumber: shipment.shipmentNumber, from: current, to: target },
        'courier status ignored: illegal transition',
      );
      return { changed: appended > 0, message: `ignored ${current} -> ${target}` };
    }

    await shipmentRepository.update(shipment.id, {
      ...baseUpdate,
      status: target,
      ...(target === 'PICKED_UP' && !shipment.shippedAt ? { shippedAt: new Date() } : {}),
      ...(target === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
      ...(target === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
    });

    await shipmentEventRepository.append({
      shipmentId: shipment.id,
      status: target,
      providerStatus: update.providerStatus,
      providerStatusCode: update.providerStatusCode,
      description: describe(target),
      source,
      isCustomerVisible: true,
    });

    // An undelivered parcel is a customer problem that needs a decision, so it opens an NDR.
    if (target === 'UNDELIVERED') await this.openNdr(shipment, update.providerStatus);

    await shipmentService.syncOrderStatus(shipment.orderId, SYSTEM_ACTOR);

    logger.info(
      { shipmentNumber: shipment.shipmentNumber, from: current, to: target, source },
      'shipment status updated from courier',
    );

    return { changed: true };
  },

  /** Raises an NDR unless one is already open, so three failed attempts do not become three NDRs. */
  async openNdr(shipment: ShipmentWithDetail, reason: string | null): Promise<void> {
    const open = await ndrRepository.openFor(shipment.id);

    if (open) {
      await ndrRepository.update(open.id, { attemptCount: { increment: 1 } });
      return;
    }

    await ndrRepository.create({
      shipmentId: shipment.id,
      reason: reason ?? 'Delivery attempt failed',
      status: 'OPEN',
      attemptCount: 1,
    });
  },

  /* -------------------------------------------------------------- polling */

  /**
   * Pulls the current state from the courier.
   *
   * Webhooks are the fast path, not the reliable one — they get lost, and a customer staring at a
   * stale timeline has no idea that is why. This is the safety net, and it shares `applyUpdate`
   * with the webhook so the two can never disagree.
   */
  async sync(shipmentNumber: string): Promise<ShipmentWithDetail> {
    const shipment = await shipmentService.getByNumber(shipmentNumber);

    if (!shipment.awbNumber && !shipment.providerShipmentId) {
      throw new AppError(
        422,
        'SHIPMENT_NOT_TRACKABLE',
        'This shipment has no AWB to track yet',
      );
    }

    const { row, driver } = await providerGateway.resolve(shipment.providerCode);

    if (!driver.capabilities().supportsTracking) {
      throw new AppError(
        422,
        'SHIPPING_CAPABILITY_UNSUPPORTED',
        `${row.code} shipments are tracked manually`,
      );
    }

    const tracking = shipment.awbNumber
      ? await driver.trackByAwb(shipment.awbNumber)
      : await driver.trackByShipment(shipment.providerShipmentId!);

    await this.applyUpdate(
      shipment,
      {
        providerStatus: tracking.providerStatus,
        providerStatusCode: tracking.providerStatusCode,
        courierName: tracking.courierName,
        estimatedDeliveryAt: tracking.estimatedDeliveryAt,
        scans: tracking.scans,
      },
      'PROVIDER_POLL',
    );

    return shipmentService.getByNumber(shipmentNumber);
  },

  /** The sweep: refreshes in-flight shipments that have not been heard from recently. */
  async syncStale(olderThanMinutes = 60, limit = 50): Promise<{ checked: number; updated: number }> {
    const before = new Date(Date.now() - olderThanMinutes * 60_000);
    const stale = await shipmentRepository.findStale(before, limit);

    let updated = 0;

    for (const shipment of stale) {
      try {
        await this.sync(shipment.shipmentNumber);
        updated += 1;
      } catch (error) {
        // One unreachable courier must not stop the sweep for every other shipment.
        logger.warn(
          { shipmentNumber: shipment.shipmentNumber, err: error },
          'tracking sync failed for shipment',
        );
      }
    }

    return { checked: stale.length, updated };
  },

  /* --------------------------------------------------------- manual moves */

  /**
   * An admin moving a shipment by hand.
   *
   * Necessary for manual fulfilment (our own truck has no API) and as an escape hatch when a
   * courier's feed is broken. It goes through the same state machine, so "by hand" does not mean
   * "unchecked".
   */
  async setStatus(
    shipmentNumber: string,
    input: {
      status: ShipmentStatus;
      description?: string;
      location?: string;
      occurredAt?: Date;
      isCustomerVisible: boolean;
    },
    actor: { actorType: 'ADMIN' | 'SYSTEM'; actorId?: string | null; actorName?: string | null },
  ): Promise<ShipmentWithDetail> {
    const shipment = await shipmentService.getByNumber(shipmentNumber);
    const current = shipment.status as ShipmentStatus;

    assertTransition(shipmentNumber, current, input.status);

    await shipmentRepository.update(shipment.id, {
      status: input.status,
      ...(input.status === 'PICKED_UP' && !shipment.shippedAt ? { shippedAt: new Date() } : {}),
      ...(input.status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
      ...(input.status === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
    });

    await shipmentEventRepository.append({
      shipmentId: shipment.id,
      status: input.status,
      description: input.description ?? describe(input.status),
      location: input.location ?? null,
      source: actor.actorType === 'ADMIN' ? 'ADMIN' : 'SYSTEM',
      occurredAt: input.occurredAt ?? new Date(),
      isCustomerVisible: input.isCustomerVisible,
    });

    if (input.status === 'UNDELIVERED') await this.openNdr(shipment, input.description ?? null);

    await shipmentService.syncOrderStatus(shipment.orderId, {
      actorType: actor.actorType,
      actorId: actor.actorId ?? null,
      actorName: actor.actorName ?? null,
    });

    return shipmentService.getByNumber(shipmentNumber);
  },
};

/** Customer-facing wording for a status change. The courier's own phrasing is kept on the scan. */
function describe(status: ShipmentStatus): string {
  const text: Record<ShipmentStatus, string> = {
    DRAFT: 'Shipment created',
    READY: 'Packed and ready for the courier',
    AWB_ASSIGNED: 'Courier assigned',
    PICKUP_SCHEDULED: 'Pickup scheduled',
    PICKED_UP: 'Collected by the courier',
    IN_TRANSIT: 'In transit',
    OUT_FOR_DELIVERY: 'Out for delivery',
    DELIVERED: 'Delivered',
    UNDELIVERED: 'Delivery attempt unsuccessful',
    RTO_INITIATED: 'Being returned to us',
    RTO_DELIVERED: 'Returned to us',
    CANCELLATION_REQUESTED: 'Cancellation requested with the courier',
    CANCELLED: 'Shipment cancelled',
    LOST: 'Shipment reported lost',
  };

  return text[status];
}
