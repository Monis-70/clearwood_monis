import type { NdrActionInput, NdrListQuery } from '@shared/schemas/fulfilment';

import { logger } from '../../config/logger';
import { ndrRepository, shipmentRepository } from '../../repositories/shipment.repository';
import { AppError } from '../../utils/AppError';

import { providerGateway } from './providerGateway.service';
import { trackingService } from './tracking.service';

/**
 * NDR — a delivery that failed and now needs a decision.
 *
 * An undelivered parcel is not a system error, it is a customer who was out. Somebody has to
 * choose: try again, or send it back. This is the queue that choice is made from.
 *
 * Only what the manual and mock drivers exercise is implemented; a provider that cannot act on an
 * NDR still records the decision locally, so the queue never silently swallows one.
 */

interface Actor {
  actorType: 'ADMIN' | 'SYSTEM';
  actorId: string | null;
  actorName?: string | null;
}

export const ndrService = {
  list(query: NdrListQuery) {
    return ndrRepository.list(query);
  },

  async get(id: string) {
    const record = await ndrRepository.findById(id);
    if (!record) throw AppError.notFound('NDR record not found');
    return record;
  },

  /**
   * Records the decision, and asks the courier to carry it out when it can.
   *
   * The local record is written even when the provider cannot act, because the decision itself is
   * the thing that must not be lost — a reattempt nobody booked is recoverable, a reattempt nobody
   * remembers deciding is not.
   */
  async act(id: string, input: NdrActionInput, actor: Actor) {
    const record = await this.get(id);

    if (record.status === 'RESOLVED' || record.status === 'CLOSED') {
      throw new AppError(409, 'NDR_ALREADY_RESOLVED', 'This NDR has already been dealt with');
    }

    const shipment = await shipmentRepository.findById(record.shipmentId);
    if (!shipment) throw AppError.notFound('Shipment not found');

    let providerAccepted = false;

    if (shipment.awbNumber) {
      const { row, driver } = await providerGateway.resolve(shipment.providerCode);

      if (driver.capabilities().supportsNdr) {
        try {
          const result = await providerGateway.run(
            {
              providerCode: row.code,
              providerId: row.id,
              operation: 'actOnNdr',
              entityType: 'NdrRecord',
              entityId: record.id,
              salt: input.action,
            },
            (candidate) =>
              candidate.actOnNdr({
                awbNumber: shipment.awbNumber!,
                action: input.action,
                ...(input.note === undefined ? {} : { note: input.note }),
                ...(input.reattemptDate === undefined
                  ? {}
                  : { reattemptDate: input.reattemptDate }),
              }),
          );

          providerAccepted = result.accepted;
        } catch (error) {
          // The decision stands; the courier can be chased separately.
          logger.error(
            { ndrId: record.id, err: error },
            'courier refused the NDR action — decision recorded locally',
          );
        }
      }
    }

    const updated = await ndrRepository.update(record.id, {
      // RETURN is the decision to send it back; everything else keeps the NDR open for an outcome.
      status: input.action === 'RETURN' ? 'RTO' : 'ACTION_REQUESTED',
      actionTaken: input.action,
      actionNote: input.note ?? null,
      actedById: actor.actorId,
      actedAt: new Date(),
    });

    // RTO is a real movement of goods, so the shipment follows the decision.
    if (input.action === 'RETURN' && shipment.status !== 'RTO_INITIATED') {
      await trackingService
        .setStatus(
          shipment.shipmentNumber,
          {
            status: 'RTO_INITIATED',
            description: input.note ?? 'Return to origin requested',
            isCustomerVisible: true,
          },
          actor,
        )
        .catch((error: unknown) => {
          logger.warn({ ndrId: record.id, err: error }, 'could not move the shipment to RTO');
        });
    }

    logger.info(
      { ndrId: record.id, action: input.action, providerAccepted },
      'NDR action recorded',
    );

    return { ...updated, providerAccepted };
  },

  /** Closes an NDR that the courier resolved on its own (a later attempt succeeded). */
  async resolve(shipmentId: string): Promise<void> {
    const open = await ndrRepository.openFor(shipmentId);
    if (!open) return;

    await ndrRepository.update(open.id, { status: 'RESOLVED' });
  },
};
