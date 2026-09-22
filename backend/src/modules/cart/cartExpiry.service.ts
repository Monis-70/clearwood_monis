import type { CartCleanupReportDto } from '@shared/types/cart';

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { cartRepository } from '../../repositories/cart.repository';

/**
 * Cart lifecycle.
 *
 * ACTIVE -> ABANDONED after `CART_ABANDON_AFTER_HOURS` of silence, then EXPIRED once it is past its
 * TTL. A CONVERTED cart is never touched: it is the history behind an order.
 *
 * Invoked from the admin cleanup route today; Prompt 17 can schedule the same entry point.
 */

const BATCH = 500;

export const cartExpiryService = {
  async markAbandoned(olderThan: Date): Promise<number> {
    const stale = await cartRepository.findStale('ACTIVE', olderThan, BATCH);
    const ids = stale.filter((cart) => cart.itemCount > 0).map((cart) => cart.id);

    const count = await cartRepository.markMany(ids, 'ABANDONED');
    for (const id of ids) {
      await cartRepository.recordEvent(id, 'ABANDONED', { since: olderThan.toISOString() });
    }
    return count;
  },

  async expire(guestOlderThan: Date, customerOlderThan: Date): Promise<number> {
    const stale = [
      ...(await cartRepository.findStale('ABANDONED', guestOlderThan, BATCH)),
      ...(await cartRepository.findStale('ACTIVE', guestOlderThan, BATCH)),
    ];

    const ids = stale
      .filter((cart) =>
        cart.customerId
          ? cart.lastActivityAt < customerOlderThan
          : cart.lastActivityAt < guestOlderThan,
      )
      .map((cart) => cart.id);

    const count = await cartRepository.markMany([...new Set(ids)], 'EXPIRED');
    for (const id of new Set(ids)) {
      await cartRepository.recordEvent(id, 'EXPIRED', {});
    }
    return count;
  },

  async cleanup(
    options: {
      abandonAfterHours?: number;
      expireGuestAfterDays?: number;
      expireCustomerAfterDays?: number;
    } = {},
  ): Promise<CartCleanupReportDto> {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;

    const abandoned = await this.markAbandoned(
      new Date(now - (options.abandonAfterHours ?? env.CART_ABANDON_AFTER_HOURS) * hour),
    );

    const expired = await this.expire(
      new Date(now - (options.expireGuestAfterDays ?? env.CART_GUEST_TTL_DAYS) * day),
      new Date(now - (options.expireCustomerAfterDays ?? env.CART_CUSTOMER_TTL_DAYS) * day),
    );

    logger.debug({ abandoned, expired }, 'cart cleanup finished');
    return { abandoned, expired };
  },
};
