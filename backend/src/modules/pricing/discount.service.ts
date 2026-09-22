import type { Coupon } from '@prisma/client';

import type { CouponRejectionCode, CouponType } from '@shared/enums';
import type {
  CouponAppliesTo,
  CouponValidationResult,
  PricingCoupon,
  PricingDiscountRule,
  PricingLineContext,
  RuleConditionGroup,
  DiscountAction,
} from '@shared/types/pricing';

import { prisma } from '../../config/prisma';
import { notDeleted } from '../../repositories/helpers';
import { jsonColumn } from '../../utils/jsonColumn';

import { couponDiscountFor } from './pricing.engine';

/**
 * Coupon eligibility and automatic discount rules.
 *
 * Every refusal has a specific code from the shared list so the storefront can show the right
 * message — "this coupon needs ₹20,000 in the cart" rather than "invalid coupon".
 */

const appliesToColumn = jsonColumn<CouponAppliesTo>(undefined, 'Coupon.appliesToJson');
const conditionsColumn = jsonColumn<RuleConditionGroup>(undefined, 'DiscountRule.conditionsJson');
const actionsColumn = jsonColumn<DiscountAction[]>(undefined, 'DiscountRule.actionsJson');

export function toPricingCoupon(coupon: Coupon): PricingCoupon {
  return {
    id: coupon.id,
    code: coupon.code,
    name: coupon.name,
    type: coupon.type as CouponType,
    valueBp: coupon.valueBp,
    valuePaise: coupon.valuePaise,
    minSubtotalPaise: coupon.minSubtotalPaise,
    maxDiscountPaise: coupon.maxDiscountPaise,
    isStackable: coupon.isStackable,
    isAutoApply: coupon.isAutoApply,
    firstOrderOnly: coupon.firstOrderOnly,
    appliesTo: appliesToColumn.parseOrNull(coupon.appliesToJson),
    termsText: coupon.termsText,
  };
}

export interface CouponCheckInput {
  coupon: Coupon;
  customerId: string | null;
  customerGroupId: string | null;
  isFirstOrder: boolean;
  /** Net of any automatic line discounts already applied. */
  eligibleSubtotalPaise: number;
  cartSubtotalPaise: number;
  hasEligibleItems: boolean;
  hasNonStackableAutoDiscount: boolean;
  now: Date;
}

function reject(
  code: CouponRejectionCode,
  message: string,
  coupon: Coupon,
): CouponValidationResult {
  return { valid: false, code: coupon.code, rejectionCode: code, message };
}

export const discountService = {
  toPricingCoupon,

  /** Case-insensitive by contract: codes are stored uppercase and looked up uppercase. */
  async findCouponByCode(code: string): Promise<Coupon | null> {
    return prisma.coupon.findFirst({
      where: { code: code.trim().toUpperCase(), ...notDeleted },
    });
  },

  async autoApplyCoupons(now: Date): Promise<PricingCoupon[]> {
    const rows = await prisma.coupon.findMany({
      where: {
        ...notDeleted,
        isActive: true,
        isAutoApply: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toPricingCoupon);
  },

  async activeDiscountRules(now: Date): Promise<PricingDiscountRule[]> {
    const rows = await prisma.discountRule.findMany({
      where: {
        ...notDeleted,
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });

    return rows
      .filter((rule) => rule.usageLimit === null || rule.usedCount < rule.usageLimit)
      .map((rule) => ({
        id: rule.id,
        code: rule.code,
        name: rule.name,
        scope: rule.scope,
        priority: rule.priority,
        stopFurtherRules: rule.stopFurtherRules,
        conditions: conditionsColumn.parseOrNull(rule.conditionsJson),
        actions: actionsColumn.parse(rule.actionsJson, []),
      }));
  },

  /** Does this line fall inside the coupon's applies-to rules? */
  appliesToLine(coupon: PricingCoupon, line: PricingLineContext): boolean {
    const rules = coupon.appliesTo;
    if (!rules) return true;

    if (rules.excludeProductIds?.includes(line.productId)) return false;
    if (rules.excludeCategoryIds?.some((id) => line.categoryIds.includes(id))) return false;

    const positives: boolean[] = [];
    if (rules.productIds?.length) positives.push(rules.productIds.includes(line.productId));
    if (rules.variantIds?.length) {
      positives.push(Boolean(line.variantId && rules.variantIds.includes(line.variantId)));
    }
    if (rules.categoryIds?.length) {
      positives.push(rules.categoryIds.some((id) => line.categoryIds.includes(id)));
    }
    if (rules.collectionIds?.length) {
      positives.push(rules.collectionIds.some((id) => line.collectionIds.includes(id)));
    }

    return positives.length === 0 || positives.some(Boolean);
  },

  /**
   * The full eligibility check. Order matters: existence, then window, then limits, then cart
   * conditions — so the customer gets the most actionable reason first.
   */
  async validate(input: CouponCheckInput): Promise<CouponValidationResult> {
    const { coupon, now } = input;

    if (!coupon.isActive || coupon.deletedAt) {
      return reject('INACTIVE', 'This coupon is no longer active', coupon);
    }
    if (coupon.startsAt && now < coupon.startsAt) {
      return reject('NOT_STARTED', 'This coupon is not active yet', coupon);
    }
    if (coupon.endsAt && now > coupon.endsAt) {
      return reject('EXPIRED', 'This coupon has expired', coupon);
    }
    if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
      return reject('USAGE_LIMIT_REACHED', 'This coupon has been fully claimed', coupon);
    }

    const appliesTo = appliesToColumn.parseOrNull(coupon.appliesToJson);

    if (appliesTo?.customerGroupIds?.length) {
      if (!input.customerGroupId || !appliesTo.customerGroupIds.includes(input.customerGroupId)) {
        return reject(
          'CUSTOMER_GROUP_NOT_ELIGIBLE',
          'This coupon is reserved for another customer group',
          coupon,
        );
      }
    }

    if (coupon.firstOrderOnly && !input.isFirstOrder) {
      return reject('FIRST_ORDER_ONLY', 'This coupon is for first orders only', coupon);
    }

    if (coupon.perCustomerLimit !== null && input.customerId) {
      const used = await prisma.couponRedemption.count({
        where: {
          couponId: coupon.id,
          customerId: input.customerId,
          status: { in: ['RESERVED', 'CONFIRMED'] },
        },
      });
      if (used >= coupon.perCustomerLimit) {
        return reject('CUSTOMER_LIMIT_REACHED', 'You have already used this coupon', coupon);
      }
    }

    if (!input.hasEligibleItems) {
      return reject(
        'NOT_APPLICABLE_TO_ITEMS',
        'This coupon does not apply to anything in your cart',
        coupon,
      );
    }

    if (coupon.minSubtotalPaise !== null && input.cartSubtotalPaise < coupon.minSubtotalPaise) {
      return reject(
        'MIN_SUBTOTAL_NOT_MET',
        `Spend at least ₹${(coupon.minSubtotalPaise / 100).toFixed(0)} to use this coupon`,
        coupon,
      );
    }

    if (!coupon.isStackable && input.hasNonStackableAutoDiscount) {
      return reject(
        'NOT_STACKABLE',
        'This coupon cannot be combined with the discount already applied',
        coupon,
      );
    }

    const pricing = toPricingCoupon(coupon);
    const discountPaise =
      coupon.type === 'FREE_SHIPPING' ? 0 : couponDiscountFor(pricing, input.eligibleSubtotalPaise);

    return {
      valid: true,
      code: coupon.code,
      discountPaise,
      freeShipping: coupon.type === 'FREE_SHIPPING',
    };
  },
};
