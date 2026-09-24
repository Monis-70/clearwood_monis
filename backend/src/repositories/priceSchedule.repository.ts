import { Prisma } from '@prisma/client';

import { prisma } from '../config/prisma';

/**
 * R1 - what the listing reconciler asks about price rules: which windows opened or closed in a
 * span of time, and which products a rule can reach.
 *
 * Window semantics mirror the engine (adjustment.matcher / pricingContext.loader): a rule applies
 * while startsAt <= now <= endsAt. So a start at S has taken effect for every refresh at or after
 * S, and an end at E for every refresh strictly after E - hence (from, to] for starts and
 * [from, to) for ends, which lets consecutive spans tile time with nothing counted twice or missed.
 */

export interface RuleTarget {
  scope: string;
  categoryId: string | null;
  productId: string | null;
  variantId: string | null;
  attributeValueId: string | null;
}

export interface WindowedAdjustment extends RuleTarget {
  id: string;
  customerGroupId: string | null;
  channel: string;
}

export interface WindowedPriceList {
  id: string;
  customerGroupId: string | null;
  channel: string;
}

const adjustmentSelect = {
  id: true,
  scope: true,
  categoryId: true,
  productId: true,
  variantId: true,
  attributeValueId: true,
  customerGroupId: true,
  channel: true,
} as const;

function crossing(from: Date, to: Date) {
  return {
    OR: [{ startsAt: { gt: from, lte: to } }, { endsAt: { gte: from, lt: to } }],
  };
}

export const priceScheduleRepository = {
  adjustmentsCrossing(from: Date, to: Date): Promise<WindowedAdjustment[]> {
    return prisma.priceAdjustment.findMany({
      where: { deletedAt: null, isActive: true, ...crossing(from, to) },
      select: adjustmentSelect,
    });
  },

  /** Rules whose conditions read `weekday`: their result changes at every UTC midnight. */
  weekdayAdjustments(): Promise<WindowedAdjustment[]> {
    return prisma.priceAdjustment.findMany({
      where: { deletedAt: null, isActive: true, conditionsJson: { contains: '"weekday"' } },
      select: adjustmentSelect,
    });
  },

  priceListsCrossing(from: Date, to: Date): Promise<WindowedPriceList[]> {
    return prisma.priceList.findMany({
      where: { deletedAt: null, isActive: true, ...crossing(from, to) },
      select: { id: true, customerGroupId: true, channel: true },
    });
  },

  /**
   * Discount rules and auto-applied coupons change no catalog unit price, but a product page shows
   * them in its breakdown; a window crossing them only has to empty the page caches.
   */
  async checkoutRulesCrossing(from: Date, to: Date, dayChanged: boolean): Promise<number> {
    const [rules, coupons, weekday] = await Promise.all([
      prisma.discountRule.count({
        where: { deletedAt: null, isActive: true, ...crossing(from, to) },
      }),
      prisma.coupon.count({
        where: { deletedAt: null, isActive: true, isAutoApply: true, ...crossing(from, to) },
      }),
      dayChanged
        ? prisma.discountRule.count({
            where: { deletedAt: null, isActive: true, conditionsJson: { contains: '"weekday"' } },
          })
        : Promise.resolve(0),
    ]);
    return rules + coupons + weekday;
  },

  async defaultGroupId(): Promise<string | null> {
    const group = await prisma.customerGroup.findFirst({
      where: { isDefault: true, isActive: true, deletedAt: null },
      select: { id: true },
    });
    return group?.id ?? null;
  },

  /**
   * Live rules whose outcome depends on a fact that a category, collection or attribute write can
   * move without touching any product row: a CATEGORY/ATTRIBUTE_VALUE scope, or a condition on it.
   */
  countRulesReading(fact: 'categoryId' | 'collectionId' | 'attributeValueId'): Promise<number> {
    const scope =
      fact === 'categoryId' ? 'CATEGORY' : fact === 'attributeValueId' ? 'ATTRIBUTE_VALUE' : null;
    return prisma.priceAdjustment.count({
      where: {
        deletedAt: null,
        isActive: true,
        OR: [...(scope ? [{ scope }] : []), { conditionsJson: { contains: `"${fact}"` } }],
      },
    });
  },

  /** Every product a rule can reach: 'ALL', or their ids. Conditions only ever narrow the set. */
  async productsForRule(rule: RuleTarget): Promise<'ALL' | string[]> {
    switch (rule.scope) {
      case 'GLOBAL':
        return 'ALL';
      case 'PRODUCT':
        return rule.productId ? [rule.productId] : [];
      case 'VARIANT': {
        if (!rule.variantId) return [];
        const variant = await prisma.productVariant.findUnique({
          where: { id: rule.variantId },
          select: { productId: true },
        });
        return variant ? [variant.productId] : [];
      }
      case 'CATEGORY': {
        if (!rule.categoryId) return [];
        // The engine expands a product's categories to every ancestor, so a rule on a category
        // reaches everything linked anywhere in its subtree.
        const rows = await prisma.$queryRaw<{ productId: string }[]>`
          SELECT DISTINCT pc.productId AS productId
          FROM Category r
          JOIN Category c ON c.path = r.path
            OR LEFT(c.path, CHAR_LENGTH(r.path) + 1) = CONCAT(r.path, '/')
          JOIN ProductCategory pc ON pc.categoryId = c.id
          WHERE r.id = ${rule.categoryId}`;
        return rows.map((row) => row.productId);
      }
      case 'ATTRIBUTE_VALUE': {
        if (!rule.attributeValueId) return [];
        // Unrequested options are the variant's own values (pricingContext.loader), never specs.
        const rows = await prisma.$queryRaw<{ productId: string }[]>`
          SELECT DISTINCT v.productId AS productId
          FROM VariantAttributeValue vav JOIN ProductVariant v ON v.id = vav.variantId
          WHERE vav.attributeValueId = ${rule.attributeValueId}`;
        return rows.map((row) => row.productId);
      }
      default:
        // CUSTOMIZATION rules are applied by the configurator and never match in the engine.
        return [];
    }
  },

  async productsForPriceLists(priceListIds: string[]): Promise<string[]> {
    if (priceListIds.length === 0) return [];
    const rows = await prisma.$queryRaw<{ productId: string }[]>`
      SELECT DISTINCT COALESCE(i.productId, v.productId) AS productId
      FROM PriceListItem i LEFT JOIN ProductVariant v ON v.id = i.variantId
      WHERE i.priceListId IN (${Prisma.join(priceListIds)})
        AND COALESCE(i.productId, v.productId) IS NOT NULL`;
    return rows.map((row) => row.productId);
  },
};
