import type { CartIssueSeverity, CartItemState } from '@shared/enums';
import type { CartIssueDto, CartValidationDto } from '@shared/types/cart';

import { env } from '../../config/env';
import type { CartWithItems } from '../../repositories/cart.repository';
import { cartRepository } from '../../repositories/cart.repository';
import { pricingContextLoader } from '../pricing/pricingContext.loader';
import { pricingFacade } from '../pricing/pricing.facade';
import { shippingService } from '../pricing/shipping.service';

import { cartPricingService } from './cartPricing.service';

/**
 * Everything that can be wrong with a cart, in one pass.
 *
 * This is the gate Prompt 9 will call with `autoFix: false` before it reserves stock. It READS
 * availability (`stockQty - reservedQty`) and never reserves anything — reservation is a checkout
 * concern, not a browsing one.
 *
 * Coupon validity is delegated to `pricingFacade.validateCoupon`, which delegates to
 * `discount.service`. The coupon rules are not re-implemented here, and the rejection code the
 * shopper sees is the one the pricing engine produced.
 */

interface LineFacts {
  lineId: string;
  productId: string;
  variantId: string | null;
  qty: number;
  availableQty: number;
  allowBackorder: boolean;
  isSellable: boolean;
  isMadeToOrder: boolean;
  leadTimeDays: number | null;
  minOrderQty: number;
  maxOrderQty: number | null;
  productName: string;
}

function issue(
  code: CartIssueDto['code'],
  severity: CartIssueSeverity,
  message: string,
  extra: Partial<CartIssueDto> = {},
): CartIssueDto {
  return { lineId: null, code, severity, message, ...extra };
}

export const cartValidationService = {
  /** The availability read. Deliberately a read: nothing in Prompt 8 touches `reservedQty`. */
  async factsFor(cart: CartWithItems): Promise<LineFacts[]> {
    const items = cartPricingService.activeItems(cart);
    if (items.length === 0) return [];

    const products = await cartRepository.findProductFacts(items.map((item) => item.productId));
    const productById = new Map(products.map((product) => [product.id, product]));

    const variantIds = items
      .map((item) => item.variantId)
      .filter((id): id is string => id !== null);

    const variants = await cartRepository.findVariantFacts(variantIds);
    const variantById = new Map(variants.map((variant) => [variant.id, variant]));

    const now = Date.now();

    return items.map((item) => {
      const product = productById.get(item.productId);
      const variant = item.variantId ? variantById.get(item.variantId) : undefined;

      const productSellable =
        product !== undefined &&
        product.deletedAt === null &&
        product.status === 'ACTIVE' &&
        product.visibility !== 'HIDDEN' &&
        (product.publishedAt === null || product.publishedAt.getTime() <= now);

      const variantSellable =
        item.variantId === null ||
        (variant !== undefined && variant.isActive && variant.deletedAt === null);

      return {
        lineId: item.id,
        productId: item.productId,
        variantId: item.variantId,
        qty: item.qty,
        availableQty: variant ? Math.max(variant.stockQty - variant.reservedQty, 0) : 0,
        allowBackorder: variant?.allowBackorder ?? false,
        isSellable: productSellable && variantSellable,
        isMadeToOrder: product?.isMadeToOrder ?? false,
        leadTimeDays: variant?.leadTimeDays ?? product?.leadTimeDays ?? null,
        minOrderQty: product?.minOrderQty ?? 1,
        maxOrderQty: product?.maxOrderQty ?? null,
        productName: product?.name ?? item.productNameSnapshot,
      };
    });
  },

  async validate(
    cart: CartWithItems,
    options: { autoFix?: boolean; customerId?: string | null } = {},
  ): Promise<CartValidationDto> {
    const issues: CartIssueDto[] = [];
    const fixes: CartValidationDto['fixes'] = [];

    const facts = await this.factsFor(cart);

    if (facts.length > env.CART_MAX_LINES) {
      issues.push(
        issue(
          'TOO_MANY_LINES',
          'BLOCKING',
          `A cart can hold at most ${env.CART_MAX_LINES} different items`,
          { meta: { max: env.CART_MAX_LINES, actual: facts.length } },
        ),
      );
    }

    const serviceability = cart.pincode ? await shippingService.serviceability(cart.pincode) : null;

    for (const fact of facts) {
      const line = (
        code: CartItemState,
        severity: CartIssueSeverity,
        message: string,
        extra = {},
      ) => issues.push({ lineId: fact.lineId, code, severity, message, ...extra });

      if (!fact.isSellable) {
        line('UNAVAILABLE', 'BLOCKING', `${fact.productName} is no longer available`);
        if (options.autoFix) {
          await cartRepository.removeItem(fact.lineId);
          fixes.push({ lineId: fact.lineId, action: 'REMOVED' });
        }
        continue;
      }

      if (fact.isMadeToOrder) {
        line(
          'MADE_TO_ORDER',
          'INFO',
          fact.leadTimeDays
            ? `${fact.productName} is built to order — about ${fact.leadTimeDays} days`
            : `${fact.productName} is built to order`,
        );
      } else if (!fact.allowBackorder) {
        if (fact.availableQty <= 0) {
          line('OUT_OF_STOCK', 'BLOCKING', `${fact.productName} is out of stock`, {
            availableQty: 0,
          });
          if (options.autoFix) {
            await cartRepository.removeItem(fact.lineId);
            fixes.push({ lineId: fact.lineId, action: 'REMOVED' });
          }
          continue;
        }

        if (fact.qty > fact.availableQty) {
          line(
            'INSUFFICIENT_STOCK',
            'BLOCKING',
            `Only ${fact.availableQty} of ${fact.productName} left`,
            { availableQty: fact.availableQty, suggestedQty: fact.availableQty },
          );
          if (options.autoFix) {
            await cartRepository.updateItem(fact.lineId, { qty: fact.availableQty });
            fixes.push({
              lineId: fact.lineId,
              action: 'CLAMPED',
              fromQty: fact.qty,
              toQty: fact.availableQty,
            });
            continue;
          }
        }
      }

      if (fact.qty < fact.minOrderQty) {
        line(
          'BELOW_MIN_QTY',
          'BLOCKING',
          `${fact.productName} is sold in minimums of ${fact.minOrderQty}`,
          { suggestedQty: fact.minOrderQty },
        );
        if (options.autoFix) {
          await cartRepository.updateItem(fact.lineId, { qty: fact.minOrderQty });
          fixes.push({
            lineId: fact.lineId,
            action: 'CLAMPED',
            fromQty: fact.qty,
            toQty: fact.minOrderQty,
          });
        }
      }

      const ceiling = Math.min(
        fact.maxOrderQty ?? env.CART_MAX_QTY_PER_LINE,
        env.CART_MAX_QTY_PER_LINE,
      );
      if (fact.qty > ceiling) {
        line(
          'ABOVE_MAX_QTY',
          'BLOCKING',
          `You can order at most ${ceiling} of ${fact.productName}`,
          {
            suggestedQty: ceiling,
          },
        );
        if (options.autoFix) {
          await cartRepository.updateItem(fact.lineId, { qty: ceiling });
          fixes.push({ lineId: fact.lineId, action: 'CLAMPED', fromQty: fact.qty, toQty: ceiling });
        }
      }

      if (serviceability && !serviceability.isServiceable) {
        line(
          'NOT_SERVICEABLE',
          'BLOCKING',
          `We do not deliver ${fact.productName} to ${cart.pincode} yet`,
        );
      }
    }

    /* Cart-level: minimum order value, straight from the pricing settings. */
    if (facts.length > 0) {
      const settings = await pricingContextLoader.readSettings();
      const { breakdown } = await cartPricingService.quote(cart, {
        ...(options.customerId === undefined ? {} : { customerId: options.customerId }),
        persist: false,
      });

      if (
        settings.minOrderValuePaise > 0 &&
        breakdown.subtotalPaise < settings.minOrderValuePaise
      ) {
        issues.push(
          issue(
            'BELOW_MIN_ORDER_VALUE',
            'BLOCKING',
            `Orders start at ${(settings.minOrderValuePaise / 100).toFixed(0)} rupees`,
            { meta: { minOrderValuePaise: settings.minOrderValuePaise } },
          ),
        );
      }

      /* A coupon can become invalid after the cart changes; say so instead of dropping it silently. */
      if (cart.couponCode) {
        const result = await pricingFacade.validateCoupon(
          cart.couponCode,
          cartPricingService.buildQuoteRequest(cart, { includeCoupon: false }),
        );

        if (!result.valid) {
          issues.push(
            issue('COUPON_INVALID', 'WARNING', result.message ?? 'This coupon is no longer valid', {
              meta: { code: cart.couponCode, rejectionCode: result.rejectionCode },
            }),
          );

          if (options.autoFix) {
            await cartRepository.touch(cart.id, { couponCode: null });
            await cartRepository.recordEvent(cart.id, 'COUPON_DROPPED', {
              code: cart.couponCode,
              rejectionCode: result.rejectionCode,
            });
          }
        }
      }
    }

    const blockingCount = issues.filter((entry) => entry.severity === 'BLOCKING').length;

    if (options.autoFix && fixes.length > 0) {
      await cartRepository.recount(cart.id);
      await cartRepository.recordEvent(cart.id, 'AUTO_FIXED', { fixes });
    }

    return {
      issues,
      isCheckoutReady: blockingCount === 0 && facts.length > 0,
      blockingCount,
      fixes,
    };
  },
};
