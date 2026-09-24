import type {
  AdminCartDetailDto,
  AdminCartRowDto,
  AdminCartStatsDto,
  AdminWishlistStatsDto,
} from '@shared/types/cart';
import type { AdminCartListQuery } from '@shared/schemas/cart';
import type { CartEventType, CartStatus } from '@shared/enums';

import { logger } from '../../config/logger';
import {
  cartRepository,
  wishlistRepository,
  type CartWithItems,
} from '../../repositories/cart.repository';
import { storefrontRepository } from '../../repositories/storefront.repository';
import type { PageResult } from '../../repositories/helpers';
import { AppError } from '../../utils/AppError';
import { productQueryService } from '../storefront/productQuery.service';

import { cartPricingService } from './cartPricing.service';
import { cartService } from './cart.service';
import { cartValidationService } from './cartValidation.service';

/** The support view: who has what in their cart, what it is worth, and what went wrong. */

const BP = 10_000;

function ageHours(from: Date): number {
  return Math.round((Date.now() - from.getTime()) / (60 * 60 * 1000));
}

export const cartAdminService = {
  async list(query: AdminCartListQuery): Promise<PageResult<AdminCartRowDto>> {
    const page = await cartRepository.listForAdmin(query);

    const customerIds = page.items
      .map((cart) => cart.customerId)
      .filter((id): id is string => id !== null);
    const customers = await cartRepository.findCustomers([...new Set(customerIds)]);
    const byId = new Map(customers.map((customer) => [customer.id, customer]));

    return {
      ...page,
      items: page.items.map((cart) => this.toRow(cart, byId.get(cart.customerId ?? ''))),
    };
  },

  toRow(
    cart: CartWithItems,
    customer?: { name: string | null; email: string | null; phone: string | null },
  ): AdminCartRowDto {
    return {
      id: cart.id,
      status: cart.status as CartStatus,
      customerId: cart.customerId,
      customerName: customer?.name ?? null,
      customerEmail: customer?.email ?? customer?.phone ?? null,
      isGuest: cart.customerId === null,
      itemCount: cart.itemCount,
      quantityTotal: cart.quantityTotal,
      lastQuotedTotalPaise: cart.lastQuotedTotalPaise,
      couponCode: cart.couponCode,
      pincode: cart.pincode,
      lastActivityAt: cart.lastActivityAt.toISOString(),
      ageHours: ageHours(cart.lastActivityAt),
      createdAt: cart.createdAt.toISOString(),
    };
  },

  async detail(id: string): Promise<AdminCartDetailDto> {
    const cart = await cartRepository.findById(id);
    if (!cart) throw AppError.notFound('Cart not found', { id });

    const [customer] = cart.customerId
      ? await cartRepository.findCustomers([cart.customerId])
      : [undefined];

    const events = await cartRepository.findEvents(cart.id);

    /* A live re-quote, so support sees exactly what the customer sees right now. */
    let breakdown: AdminCartDetailDto['breakdown'] = null;
    let lines: AdminCartDetailDto['lines'] = [];
    let issues: AdminCartDetailDto['issues'] = [];

    try {
      const quoted = await cartPricingService.quote(cart, { persist: false });
      breakdown = quoted.breakdown;
      lines = await cartService.linesToDto(cart, 'IN_CART', quoted.byLineId);
      issues = (await cartValidationService.validate(cart)).issues;
    } catch (error) {
      logger.warn({ err: error, cartId: id }, 'admin cart re-quote failed');
    }

    return {
      ...this.toRow(cart, customer),
      lines,
      breakdown,
      issues,
      events: events.map((event) => ({
        id: event.id,
        type: event.type as CartEventType,
        payload: event.payloadJson
          ? (JSON.parse(event.payloadJson) as Record<string, unknown>)
          : null,
        createdAt: event.createdAt.toISOString(),
      })),
      mergedIntoCartId: cart.mergedIntoCartId,
      convertedOrderId: cart.convertedOrderId,
    };
  },

  async stats(): Promise<AdminCartStatsDto> {
    const [counts, value, topAbandoned] = await Promise.all([
      cartRepository.countByStatus(),
      cartRepository.valueStats(),
      cartRepository.topAbandonedProducts(10),
    ]);

    const byStatus = new Map(counts.map((row) => [row.status, row.count]));
    const totals = {
      active: byStatus.get('ACTIVE') ?? 0,
      abandoned: byStatus.get('ABANDONED') ?? 0,
      converted: byStatus.get('CONVERTED') ?? 0,
      merged: byStatus.get('MERGED') ?? 0,
      expired: byStatus.get('EXPIRED') ?? 0,
    };

    const finished = totals.abandoned + totals.converted + totals.expired;

    return {
      totals,
      abandonmentRateBp:
        finished === 0 ? 0 : Math.round(((totals.abandoned + totals.expired) / finished) * BP),
      averageValuePaise: value.averageValuePaise,
      activeValuePaise: value.activeValuePaise,
      topAbandonedProducts: topAbandoned,
    };
  },

  async wishlistStats(): Promise<AdminWishlistStatsDto> {
    const [mostWishlisted, candidates, totals] = await Promise.all([
      wishlistRepository.mostWishlisted(10),
      wishlistRepository.findPriceDropCandidates(100),
      wishlistRepository.totals(),
    ]);

    const productIds = [...new Set(candidates.map((item) => item.productId))];
    const cards = productIds.length ? await storefrontRepository.findCardsAnyState(productIds) : [];
    const prices = await productQueryService.resolveDisplayPrices(cards, { customerId: null });
    const nameById = new Map(cards.map((card) => [card.id, card.name]));

    const watchers = new Map<string, number>();
    for (const item of candidates) {
      watchers.set(item.productId, (watchers.get(item.productId) ?? 0) + 1);
    }

    const drops = new Map<string, AdminWishlistStatsDto['priceDropCandidates'][number]>();
    for (const item of candidates) {
      const current = prices.get(item.productId);
      if (current === undefined || current >= item.addedPricePaise) continue;

      const existing = drops.get(item.productId);
      const dropPaise = item.addedPricePaise - current;
      if (existing && existing.dropPaise >= dropPaise) continue;

      drops.set(item.productId, {
        productId: item.productId,
        name: nameById.get(item.productId) ?? 'Deleted product',
        addedPricePaise: item.addedPricePaise,
        currentPricePaise: current,
        dropPaise,
        watchers: watchers.get(item.productId) ?? 1,
      });
    }

    return {
      mostWishlisted,
      priceDropCandidates: [...drops.values()].sort((a, b) => b.dropPaise - a.dropPaise),
      totals,
    };
  },

  /** Support view of a live customer cart, without impersonating them. */
  async forCustomer(customerId: string): Promise<AdminCartDetailDto | null> {
    const cart = await cartRepository.findActiveByOwnerKey(`c:${customerId}`);
    return cart ? this.detail(cart.id) : null;
  },
};
