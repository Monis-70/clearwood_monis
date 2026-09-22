import type { MergeStrategy } from '@shared/enums';
import type { CartMergeReportDto } from '@shared/types/cart';

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import {
  cartRepository,
  recentlyViewedRepository,
  wishlistRepository,
  type CartWithItems,
} from '../../repositories/cart.repository';
import { pricingFacade } from '../pricing/pricing.facade';

import { cartIdentity } from './cartIdentity';
import { cartPricingService } from './cartPricing.service';
import { cartService } from './cart.service';
import { cartValidationService } from './cartValidation.service';

/**
 * Folding a guest's cart into their account at login.
 *
 * Rules, in the order they are applied:
 *  - lines are matched by `lineKey`, so the same sofa in the same fabric is one line, not two;
 *  - SUM_QUANTITIES adds them and then clamps to maxOrderQty and to what is actually in stock,
 *    recording every clamp so the UI can say what happened;
 *  - the customer's coupon wins if it is still valid; otherwise the guest's is tried; otherwise the
 *    cart ends up with no coupon and a reason;
 *  - the most recently set pincode survives;
 *  - the guest cart is marked MERGED with `mergedIntoCartId` and is NEVER deleted.
 *
 * Idempotent: running it twice produces the same cart, because the second run finds a guest cart
 * that is no longer ACTIVE and returns a no-op report.
 */

const EMPTY_REPORT = (cartId: string): CartMergeReportDto => ({
  merged: false,
  cartId,
  guestCartId: null,
  added: 0,
  incremented: 0,
  clamped: [],
  skipped: [],
  couponOutcome: 'NONE',
  couponReason: null,
  wishlistItemsMoved: 0,
  recentlyViewedMerged: 0,
});

export const cartMergeService = {
  async mergeGuestIntoCustomer(
    sessionId: string | null,
    customerId: string,
    strategy: MergeStrategy = 'SUM_QUANTITIES',
  ): Promise<CartMergeReportDto> {
    const customerCart = await cartService.getOrCreate({
      customerId,
      sessionId: null,
      isNewSession: false,
    });

    if (!sessionId) return EMPTY_REPORT(customerCart.id);

    const guestCart = await cartRepository.findActiveByOwnerKey(
      cartIdentity.ownerKey({ sessionId }),
    );

    const report: CartMergeReportDto = {
      ...EMPTY_REPORT(customerCart.id),
      guestCartId: guestCart?.id ?? null,
    };

    if (guestCart) {
      await this.mergeLines(guestCart, customerCart, strategy, report);
      await this.mergeCoupon(guestCart, customerCart, report);

      if (guestCart.pincode && guestCart.lastActivityAt >= customerCart.lastActivityAt) {
        await cartRepository.touch(customerCart.id, { pincode: guestCart.pincode });
      }

      await cartRepository.setStatus(guestCart.id, 'MERGED', {
        mergedIntoCartId: customerCart.id,
      });
      await cartRepository.recordEvent(guestCart.id, 'MERGED_OUT', { into: customerCart.id });
      await cartRepository.recordEvent(customerCart.id, 'MERGED_IN', {
        from: guestCart.id,
        added: report.added,
        incremented: report.incremented,
      });

      await cartRepository.recount(customerCart.id);
      report.merged = true;
    }

    report.wishlistItemsMoved = await this.mergeWishlists(sessionId, customerId);
    report.recentlyViewedMerged = await this.mergeRecentlyViewed(sessionId, customerId);

    return report;
  },

  async mergeLines(
    guestCart: CartWithItems,
    customerCart: CartWithItems,
    strategy: MergeStrategy,
    report: CartMergeReportDto,
  ): Promise<void> {
    const existing = new Map(customerCart.items.map((item) => [item.lineKey, item]));

    const facts = await cartValidationService.factsFor(guestCart);
    const productFacts = await cartRepository.findProductFacts(
      guestCart.items.map((item) => item.productId),
    );
    const productById = new Map(productFacts.map((product) => [product.id, product]));

    const availability = new Map(
      facts.map((fact) => [
        fact.lineId,
        { available: fact.availableQty, backorder: fact.allowBackorder, mto: fact.isMadeToOrder },
      ]),
    );

    for (const guestItem of guestCart.items) {
      const product = productById.get(guestItem.productId);

      if (!product || product.deletedAt !== null || product.status !== 'ACTIVE') {
        report.skipped.push({ lineKey: guestItem.lineKey, reason: 'PRODUCT_UNAVAILABLE' });
        continue;
      }

      const match = existing.get(guestItem.lineKey);
      const requested = this.combine(strategy, match?.qty ?? 0, guestItem.qty);

      const ceiling = Math.min(
        product.maxOrderQty ?? env.CART_MAX_QTY_PER_LINE,
        env.CART_MAX_QTY_PER_LINE,
      );
      const stock = availability.get(guestItem.id);
      const stockCeiling =
        stock && !stock.mto && !stock.backorder ? Math.max(stock.available, 0) : ceiling;

      const finalQty = Math.max(1, Math.min(requested, ceiling, stockCeiling));

      if (finalQty < requested) {
        report.clamped.push({
          lineKey: guestItem.lineKey,
          requestedQty: requested,
          finalQty,
          reason: finalQty === stockCeiling ? 'STOCK' : 'MAX_ORDER_QTY',
        });
      }

      if (match) {
        await cartRepository.updateItem(match.id, { qty: finalQty });
        report.incremented += 1;
        continue;
      }

      const position = (await cartRepository.maxPosition(customerCart.id)) + 1;

      await cartRepository.upsertItem(
        customerCart.id,
        guestItem.lineKey,
        {
          productId: guestItem.productId,
          variantId: guestItem.variantId,
          qty: finalQty,
          selectedOptionsJson: guestItem.selectedOptionsJson,
          customizationJson: guestItem.customizationJson,
          customizationHash: guestItem.customizationHash,
          saveState: guestItem.saveState,
          addedUnitPricePaise: guestItem.addedUnitPricePaise,
          addedTotalPaise: guestItem.addedTotalPaise,
          productNameSnapshot: guestItem.productNameSnapshot,
          variantNameSnapshot: guestItem.variantNameSnapshot,
          skuSnapshot: guestItem.skuSnapshot,
          imageMediaIdSnapshot: guestItem.imageMediaIdSnapshot,
          note: guestItem.note,
          position,
        },
        0,
        ceiling,
      );

      // `upsertItem` increments by 0 on a fresh row, so set the merged quantity explicitly.
      const created = await cartRepository.findItemByKey(customerCart.id, guestItem.lineKey);
      if (created && created.qty !== finalQty) {
        await cartRepository.updateItem(created.id, { qty: finalQty });
      }

      report.added += 1;
    }
  },

  combine(strategy: MergeStrategy, customerQty: number, guestQty: number): number {
    switch (strategy) {
      case 'KEEP_HIGHEST':
        return Math.max(customerQty, guestQty);
      case 'GUEST_WINS':
        return guestQty;
      case 'CUSTOMER_WINS':
        return customerQty > 0 ? customerQty : guestQty;
      case 'SUM_QUANTITIES':
      default:
        return customerQty + guestQty;
    }
  },

  /** The customer's coupon is tried first; the guest's is the fallback; neither survives invalid. */
  async mergeCoupon(
    guestCart: CartWithItems,
    customerCart: CartWithItems,
    report: CartMergeReportDto,
  ): Promise<void> {
    const merged = await cartService.reload(customerCart.id);
    const candidates = [customerCart.couponCode, guestCart.couponCode].filter(
      (code): code is string => Boolean(code),
    );

    if (candidates.length === 0) {
      report.couponOutcome = 'NONE';
      return;
    }

    for (const [index, code] of candidates.entries()) {
      const result = await pricingFacade
        .validateCoupon(
          code,
          cartPricingService.buildQuoteRequest(merged, { includeCoupon: false }),
        )
        .catch((error: unknown) => {
          logger.warn({ err: error, code }, 'coupon revalidation failed during merge');
          return null;
        });

      if (result?.valid) {
        await cartRepository.touch(customerCart.id, { couponCode: result.code });
        report.couponOutcome = index === 0 ? 'KEPT_CUSTOMER' : 'TOOK_GUEST';
        report.couponReason = null;
        return;
      }

      if (index === candidates.length - 1) {
        report.couponOutcome = 'DROPPED';
        report.couponReason = result?.rejectionCode ?? 'COUPON_NOT_FOUND';
      }
    }

    if (report.couponOutcome === 'DROPPED') {
      await cartRepository.touch(customerCart.id, { couponCode: null });
      await cartRepository.recordEvent(customerCart.id, 'COUPON_DROPPED', {
        reason: report.couponReason,
      });
    }
  },

  /** Guest wishlist items land in the customer's default list, deduped by lineKey. */
  async mergeWishlists(sessionId: string, customerId: string): Promise<number> {
    const guestLists = await wishlistRepository.findForOwner({ customerId: null, sessionId });
    if (guestLists.length === 0) return 0;

    const { wishlistService } = await import('../wishlist/wishlist.service');
    const target = await wishlistService.defaultList({
      customerId,
      sessionId: null,
      isNewSession: false,
    });

    let moved = 0;
    for (const list of guestLists) {
      for (const item of list.items) {
        await wishlistRepository.upsertItem(target.id, item.lineKey, {
          productId: item.productId,
          variantId: item.variantId,
          selectedOptionsJson: item.selectedOptionsJson,
          priority: item.priority,
          note: item.note,
          addedPricePaise: item.addedPricePaise,
          position: item.position,
        });
        moved += 1;
      }

      await wishlistRepository.softDelete(list.id);
    }

    await wishlistRepository.recount(target.id);
    return moved;
  },

  async mergeRecentlyViewed(sessionId: string, customerId: string): Promise<number> {
    const rows = await recentlyViewedRepository.findBySession(sessionId);
    let merged = 0;

    for (const row of rows) {
      try {
        await recentlyViewedRepository.reassign(row.id, customerId);
        merged += 1;
      } catch {
        // The customer already viewed it; the newer row wins and the guest one is dropped.
        await recentlyViewedRepository.deleteById(row.id).catch(() => undefined);
      }
    }

    if (merged > 0) {
      await recentlyViewedRepository.trim({ customerId, sessionId: null }, env.RECENTLY_VIEWED_MAX);
    }
    return merged;
  },
};
