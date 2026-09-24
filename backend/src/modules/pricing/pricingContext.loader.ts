import type { PricingChannel } from '@shared/enums';
import type {
  PricingAdjustment,
  PricingContext,
  PricingCustomerGroup,
  PricingLineContext,
  PricingPriceListItem,
  PricingSettings,
  PricingTier,
  RuleConditionGroup,
} from '@shared/types/pricing';

import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { cache } from '../../container';
import { notDeleted } from '../../repositories/helpers';
import { reachableWhere } from '../../repositories/storefront.repository';
import { AppError } from '../../utils/AppError';
import { jsonColumn } from '../../utils/jsonColumn';
import { requestScope } from '../../utils/requestScope';
import { PRICING_CACHE_PREFIXES } from '../catalog-admin/catalogCache.service';

import { discountService } from './discount.service';
import { shippingService } from './shipping.service';
import { taxService } from './tax.service';

/**
 * Loads everything the pure engine needs, in as few queries as possible.
 *
 * This is the ONLY file in the pricing module that touches Prisma. Static, slow-changing data
 * (settings, rules, zones) is cached under the prefixes registered in catalogCache.service, so an
 * admin edit invalidates it through the existing Prompt 5 write paths.
 */

const conditionsColumn = jsonColumn<RuleConditionGroup>(
  undefined,
  'PriceAdjustment.conditionsJson',
);

export interface LoadContextInput {
  lines: {
    lineId: string;
    productId?: string;
    slug?: string;
    variantId?: string | null;
    optionValueIds?: string[];
    qty: number;
  }[];
  customerId?: string | null;
  /** The simulator can force a group; otherwise it is derived from the customer. */
  customerGroupId?: string | null;
  couponCode?: string | null;
  pincode?: string | null;
  channel?: PricingChannel;
  now: Date;
  /**
   * Simulator mode: also load rules that are out of their date window or quantity band, so the
   * matcher can report *why* they did not apply instead of them silently vanishing.
   */
  explain?: boolean;
  /**
   * Public quote endpoints: a product the storefront cannot reach (draft, archived, hidden,
   * scheduled, deleted) is "not found" rather than priced. Carts keep pricing their own lines.
   */
  reachableOnly?: boolean;
}

const SETTING_DEFAULTS: PricingSettings = {
  pricesIncludeTax: false,
  sellerStateCode: 'MH',
  defaultPlaceOfSupply: 'MH',
  shippingTaxable: true,
  shippingTaxRateBp: 1800,
  roundTotalToRupee: true,
  freeShippingThresholdPaise: 5_000_000,
  showSavingsBadge: true,
  minOrderValuePaise: 0,
};

async function readSettings(): Promise<PricingSettings> {
  return cache.wrap(
    `${PRICING_CACHE_PREFIXES.settings}v1`,
    env.PRICING_CACHE_TTL_SECONDS,
    loadSettings,
  );
}

async function loadSettings(): Promise<PricingSettings> {
  const rows = await prisma.appSetting.findMany({ where: { group: 'pricing' } });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  const bool = (key: string, fallback: boolean) => {
    const value = byKey.get(key);
    return value === undefined ? fallback : value === 'true' || value === '1';
  };
  const num = (key: string, fallback: number) => {
    const value = Number(byKey.get(key));
    return Number.isFinite(value) ? value : fallback;
  };
  const str = (key: string, fallback: string) => byKey.get(key) ?? fallback;

  const shippingTaxClass = await taxService.findByCode(
    str('pricing.shipping_tax_class_code', 'GST_18'),
  );

  const settings: PricingSettings = {
    pricesIncludeTax: bool('pricing.prices_include_tax', SETTING_DEFAULTS.pricesIncludeTax),
    sellerStateCode: str('pricing.seller_state_code', SETTING_DEFAULTS.sellerStateCode),
    defaultPlaceOfSupply: str(
      'pricing.default_place_of_supply',
      SETTING_DEFAULTS.defaultPlaceOfSupply,
    ),
    shippingTaxable: bool('pricing.shipping_taxable', SETTING_DEFAULTS.shippingTaxable),
    shippingTaxRateBp: shippingTaxClass?.rateBp ?? SETTING_DEFAULTS.shippingTaxRateBp,
    roundTotalToRupee: bool('pricing.round_total_to_rupee', SETTING_DEFAULTS.roundTotalToRupee),
    freeShippingThresholdPaise: num(
      'pricing.free_shipping_threshold_paise',
      SETTING_DEFAULTS.freeShippingThresholdPaise,
    ),
    showSavingsBadge: bool('pricing.show_savings_badge', SETTING_DEFAULTS.showSavingsBadge),
    minOrderValuePaise: num('pricing.min_order_value_paise', SETTING_DEFAULTS.minOrderValuePaise),
  };

  return settings;
}

/** The customer's group, or the default one when they have none. */
async function resolveCustomerGroup(
  customerId: string | null,
  forcedGroupId: string | null,
): Promise<PricingCustomerGroup | null> {
  if (forcedGroupId) {
    const forced = await prisma.customerGroup.findFirst({
      where: { id: forcedGroupId, ...notDeleted },
    });
    return forced ? toGroupDto(forced) : null;
  }

  if (customerId) {
    const membership = await prisma.customerGroupMember.findFirst({
      where: { customerId, group: { isActive: true, deletedAt: null } },
      include: { group: true },
      orderBy: { group: { priority: 'desc' } },
    });
    if (membership) return toGroupDto(membership.group);
  }

  // Every customer-group write drops this prefix (pricingAdmin.service -> invalidatePricing).
  return cache.wrap(
    `${PRICING_CACHE_PREFIXES.settings}group-default`,
    env.PRICING_CACHE_TTL_SECONDS,
    async () => {
      const fallback = await prisma.customerGroup.findFirst({
        where: { isDefault: true, isActive: true, ...notDeleted },
      });
      return fallback ? toGroupDto(fallback) : null;
    },
  );
}

function toGroupDto(group: {
  id: string;
  code: string;
  name: string;
  priority: number;
  discountBp: number | null;
  isDefault: boolean;
}): PricingCustomerGroup {
  return {
    id: group.id,
    code: group.code,
    name: group.name,
    priority: group.priority,
    discountBp: group.discountBp,
    isDefault: group.isDefault,
  };
}

/**
 * Expands a set of category ids to include every ancestor, for ALL lines at once.
 *
 * This used to run per line, at two queries each, which made a 40-line cart cost eighty category
 * queries on its own. The expansion is the same work for every line that shares a category, so it
 * is done once and the result handed out from a Map.
 *
 * Ancestors come from the materialised `path` prefix, exactly as before — no parent walking.
 */
async function buildCategoryExpansion(
  allCategoryIds: string[],
): Promise<Map<string, string[]>> {
  const expansion = new Map<string, string[]>();
  if (allCategoryIds.length === 0) return expansion;

  const rows = await requestScope.once(
    `pricing:categories:${[...new Set(allCategoryIds)].sort().join(',')}`,
    () =>
      prisma.category.findMany({
        where: { id: { in: allCategoryIds } },
        select: { id: true, path: true },
      }),
  );

  const ancestorSlugs = new Set<string>();
  const pathById = new Map<string, string>();

  for (const row of rows) {
    pathById.set(row.id, row.path);

    const segments = row.path.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      ancestorSlugs.add(segments.slice(0, index).join('/'));
    }
  }

  const ancestors = await requestScope.once(
    `pricing:ancestors:${[...ancestorSlugs].sort().join(',')}`,
    () =>
      prisma.category.findMany({
        where: { path: { in: [...ancestorSlugs] } },
        select: { id: true, path: true },
      }),
  );

  const idByPath = new Map(ancestors.map((row) => [row.path, row.id]));

  for (const [categoryId, categoryPath] of pathById) {
    const segments = categoryPath.split('/');
    const ids: string[] = [];

    for (let index = 1; index <= segments.length; index += 1) {
      const id = idByPath.get(segments.slice(0, index).join('/'));
      if (id) ids.push(id);
    }

    expansion.set(categoryId, ids);
  }

  return expansion;
}

export const pricingContextLoader = {
  readSettings,

  /** Prompt 7 needs the group a request will be priced under before it asks for a quote. */
  resolveCustomerGroup,

  /**
   * The only two customer facts a catalog unit price depends on (the group, and isFirstOrder for
   * rules conditioned on it), through the same request-scope keys `load()` uses, so asking first
   * costs nothing extra when a quote follows.
   */
  async catalogAudience(
    customerId: string | null,
  ): Promise<{ group: PricingCustomerGroup | null; isFirstOrder: boolean }> {
    const [group, isFirstOrder] = await Promise.all([
      requestScope.once(`pricing:group:${customerId}:`, () =>
        resolveCustomerGroup(customerId, null),
      ),
      requestScope.once(`pricing:firstOrder:${customerId ?? ''}`, () =>
        checkFirstOrder(customerId),
      ),
    ]);
    return { group, isFirstOrder };
  },

  async load(input: LoadContextInput): Promise<PricingContext> {
    if (input.lines.length > env.PRICING_MAX_QUOTE_ITEMS) {
      throw AppError.validation(
        `A quote may contain at most ${env.PRICING_MAX_QUOTE_ITEMS} items`,
        { items: input.lines.length, max: env.PRICING_MAX_QUOTE_ITEMS },
      );
    }

    const channel = input.channel ?? 'WEB';
    const customerId = input.customerId ?? null;

    const [settings, customerGroup, defaultTaxClass] = await Promise.all([
      readSettings(),
      /*
       * A product page asks for three quotes — the variant price deltas, the product itself and
       * the related rail — and none of them may be merged without changing a displayed price.
       * What they DO share is the half of the context that does not depend on the lines, so that
       * half is loaded once per request. The keys below are constant for the whole request: none
       * of them contains a line id, which is what separates this from caching away an N+1.
       */
      requestScope.once(`pricing:group:${customerId}:${input.customerGroupId ?? ''}`, () =>
        resolveCustomerGroup(customerId, input.customerGroupId ?? null),
      ),
      requestScope.once('pricing:defaultTaxClass', () => taxService.defaultTaxClass()),
    ]);

    // One query per collection rather than per line: batched by id/slug.
    const productIds = input.lines.map((line) => line.productId).filter(Boolean) as string[];
    const slugs = input.lines.map((line) => line.slug).filter(Boolean) as string[];

    /*
     * Keyed by the WHOLE set, never by one line: two quotes asking for the same products share one
     * read, and a quote for a different set simply misses. The count therefore cannot grow with
     * the number of lines, which is the line between deduplication and hiding an N+1. These rows
     * are read-only below, so sharing them cannot leak a mutation between quotes.
     */
    const products = await requestScope.once(
      `pricing:products:${input.reachableOnly ? 'reachable:' : ''}${[...new Set(productIds)].sort().join(',')}|${[...new Set(slugs)].sort().join(',')}`,
      () =>
        prisma.product.findMany({
          where: {
            ...notDeleted,
            OR: [{ id: { in: productIds } }, { slug: { in: slugs } }],
            ...(input.reachableOnly ? { AND: [reachableWhere(input.now)] } : {}),
          },
          // Only what a price depends on: every priced page runs this, descriptions stay in MySQL.
          select: {
            id: true,
            slug: true,
            name: true,
            brandId: true,
            basePricePaise: true,
            compareAtPricePaise: true,
            isMadeToOrder: true,
            leadTimeDays: true,
            weightGrams: true,
            taxClass: { select: { id: true, code: true, rateBp: true, hsnCode: true } },
            categories: { select: { categoryId: true } },
            collections: { select: { collectionId: true } },
            variants: {
              where: notDeleted,
              select: { id: true, sku: true, pricePaise: true, isDefault: true, isActive: true },
            },
          },
        }),
    );

    const byId = new Map(products.map((product) => [product.id, product]));
    const bySlug = new Map(products.map((product) => [product.slug, product]));

    /*
     * Resolve every product and variant FIRST, with no queries, so the two lookups that used to
     * run per line can be batched across all of them below.
     */
    const resolved = input.lines.map((requested) => {
      const product = requested.productId
        ? byId.get(requested.productId)
        : requested.slug
          ? bySlug.get(requested.slug)
          : undefined;

      if (!product) {
        throw AppError.notFound('Product not found', {
          productId: requested.productId ?? null,
          slug: requested.slug ?? null,
        });
      }

      const variant = requested.variantId
        ? product.variants.find((row) => row.id === requested.variantId)
        : product.variants.find((row) => row.isDefault && row.isActive);

      if (requested.variantId && !variant) {
        throw AppError.notFound('Variant not found', { variantId: requested.variantId });
      }

      return { requested, product, variant };
    });

    // Two batched lookups, regardless of how many lines there are.
    const [categoryExpansion, variantValueRows] = await Promise.all([
      buildCategoryExpansion([
        ...new Set(resolved.flatMap((entry) => entry.product.categories.map((row) => row.categoryId))),
      ]),
      (() => {
        const variantIds = [
          ...new Set(
            resolved
              .map((entry) => entry.variant?.id)
              .filter((id): id is string => Boolean(id)),
          ),
        ];

        return variantIds.length === 0
          ? Promise.resolve([])
          : prisma.variantAttributeValue.findMany({
              where: { variantId: { in: variantIds } },
              select: { variantId: true, attributeValueId: true },
            });
      })(),
    ]);

    const valuesByVariant = new Map<string, string[]>();
    for (const row of variantValueRows) {
      const list = valuesByVariant.get(row.variantId) ?? [];
      list.push(row.attributeValueId);
      valuesByVariant.set(row.variantId, list);
    }

    const lines: PricingLineContext[] = [];

    for (const { requested, product, variant } of resolved) {
      const ownCategoryIds = product.categories.map((row) => row.categoryId);
      const categoryIds = [
        ...new Set([
          ...ownCategoryIds,
          ...ownCategoryIds.flatMap((id) => categoryExpansion.get(id) ?? []),
        ]),
      ];

      // Variant-defining values count as selected options even when not passed explicitly.
      const variantValues = variant ? (valuesByVariant.get(variant.id) ?? []) : [];

      const optionValueIds = [...new Set([...(requested.optionValueIds ?? []), ...variantValues])];

      lines.push({
        lineId: requested.lineId,
        productId: product.id,
        productName: product.name,
        productSlug: product.slug,
        variantId: variant?.id ?? null,
        variantSku: variant?.sku ?? null,
        baseUnitPaise: variant?.pricePaise ?? product.basePricePaise,
        listPricePaise: product.compareAtPricePaise,
        categoryIds,
        collectionIds: product.collections.map((row) => row.collectionId),
        brandId: product.brandId,
        optionValueIds,
        taxClass: product.taxClass
          ? {
              id: product.taxClass.id,
              code: product.taxClass.code,
              rateBp: product.taxClass.rateBp,
              hsnCode: product.taxClass.hsnCode,
            }
          : defaultTaxClass,
        isMadeToOrder: product.isMadeToOrder,
        leadTimeDays: product.leadTimeDays,
        weightGrams: product.weightGrams,
        adjustments: [],
        tiers: [],
        priceListItems: [],
      });
    }

    const allCategoryIds = [...new Set(lines.flatMap((line) => line.categoryIds))];
    const allProductIds = [...new Set(lines.map((line) => line.productId))];
    const allVariantIds = lines.map((line) => line.variantId).filter(Boolean) as string[];
    const allOptionValueIds = [...new Set(lines.flatMap((line) => line.optionValueIds))];

    const [adjustments, tiers, priceListItems] = await Promise.all([
      loadAdjustments({
        now: input.now,
        channel,
        customerGroupId: customerGroup?.id ?? null,
        categoryIds: allCategoryIds,
        productIds: allProductIds,
        variantIds: allVariantIds,
        attributeValueIds: allOptionValueIds,
        explain: input.explain ?? false,
      }),
      loadTiers(allProductIds, allVariantIds),
      loadPriceListItems({
        now: input.now,
        channel,
        customerGroupId: customerGroup?.id ?? null,
        productIds: allProductIds,
        variantIds: allVariantIds,
      }),
    ]);

    for (const line of lines) {
      line.adjustments = adjustments.filter((adjustment) => isCandidate(adjustment, line));
      line.tiers = tiers.filter(
        (tier) =>
          (tier.productId && tier.productId === line.productId) ||
          (tier.variantId && tier.variantId === line.variantId),
      );
      line.priceListItems = priceListItems.filter(
        (item) =>
          (item.productId && item.productId === line.productId) ||
          (item.variantId && item.variantId === line.variantId),
      );
    }

    const pincode = input.pincode ?? null;
    const zone = await requestScope.once(`pricing:zone:${pincode ?? ''}`, () =>
      shippingService.resolveZone(pincode),
    );
    const shippingRates = zone
      ? await requestScope.once(`pricing:rates:${zone.zoneId}`, () =>
          shippingService.ratesForZone(zone.zoneId),
        )
      : [];

    const coupon = input.couponCode
      ? await discountService.findCouponByCode(input.couponCode)
      : null;

    const [autoCoupons, discountRules, isFirstOrder] = await Promise.all([
      /*
       * Keyed without `now`: the three quotes behind one page are milliseconds apart, and pricing
       * every line of a response against ONE rule set is more consistent than re-reading windows
       * that could straddle a boundary mid-request.
       */
      requestScope.once('pricing:autoCoupons', () => discountService.autoApplyCoupons(input.now)),
      requestScope.once('pricing:discountRules', () =>
        discountService.activeDiscountRules(input.now),
      ),
      requestScope.once(`pricing:firstOrder:${customerId ?? ''}`, () =>
        checkFirstOrder(customerId),
      ),
    ]);

    return {
      settings,
      customerGroup,
      customerId,
      isFirstOrder,
      channel,
      buyerStateCode: zone?.stateCode ?? null,
      pincode: input.pincode ?? null,
      lines,
      coupon: coupon ? discountService.toPricingCoupon(coupon) : null,
      autoCoupons,
      discountRules,
      shippingRates,
      shippingZoneCode: zone?.zoneCode ?? null,
    };
  },
};

/** A cheap pre-filter; the matcher still decides definitively. */
function isCandidate(adjustment: PricingAdjustment, line: PricingLineContext): boolean {
  switch (adjustment.scope) {
    case 'GLOBAL':
      return true;
    case 'CATEGORY':
      return Boolean(adjustment.categoryId && line.categoryIds.includes(adjustment.categoryId));
    case 'PRODUCT':
      return adjustment.productId === line.productId;
    case 'VARIANT':
      return Boolean(line.variantId && adjustment.variantId === line.variantId);
    case 'ATTRIBUTE_VALUE':
      return Boolean(
        adjustment.attributeValueId && line.optionValueIds.includes(adjustment.attributeValueId),
      );
    default:
      return false;
  }
}

async function loadAdjustments(input: {
  now: Date;
  channel: string;
  customerGroupId: string | null;
  categoryIds: string[];
  productIds: string[];
  variantIds: string[];
  attributeValueIds: string[];
  explain?: boolean;
}): Promise<PricingAdjustment[]> {
  // The matcher re-checks the window anyway; skipping it here only widens the candidate set.
  const windowFilter = input.explain
    ? []
    : [
        { OR: [{ startsAt: null }, { startsAt: { lte: input.now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: input.now } }] },
      ];

  const rows = await prisma.priceAdjustment.findMany({
    where: {
      ...notDeleted,
      isActive: true,
      AND: [
        ...windowFilter,
        { OR: [{ channel: 'ALL' }, { channel: input.channel }] },
        {
          OR: [
            { customerGroupId: null },
            ...(input.customerGroupId ? [{ customerGroupId: input.customerGroupId }] : []),
          ],
        },
        {
          OR: [
            { scope: 'GLOBAL' },
            { categoryId: { in: input.categoryIds } },
            { productId: { in: input.productIds } },
            { variantId: { in: input.variantIds } },
            { attributeValueId: { in: input.attributeValueIds } },
          ],
        },
      ],
    },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    scope: row.scope,
    adjustmentType: row.adjustmentType,
    basis: row.basis,
    priority: row.priority,
    valuePaise: row.valuePaise,
    valueBp: row.valueBp,
    categoryId: row.categoryId,
    productId: row.productId,
    variantId: row.variantId,
    attributeId: row.attributeId,
    attributeValueId: row.attributeValueId,
    customerGroupId: row.customerGroupId,
    channel: row.channel,
    minQty: row.minQty,
    maxQty: row.maxQty,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    conditions: conditionsColumn.parseOrNull(row.conditionsJson),
  }));
}

async function loadTiers(productIds: string[], variantIds: string[]): Promise<PricingTier[]> {
  const rows = await prisma.tierPrice.findMany({
    where: {
      ...notDeleted,
      isActive: true,
      OR: [{ productId: { in: productIds } }, { variantId: { in: variantIds } }],
    },
    orderBy: { minQty: 'asc' },
  });

  return rows.map((row) => ({
    id: row.id,
    productId: row.productId,
    variantId: row.variantId,
    customerGroupId: row.customerGroupId,
    minQty: row.minQty,
    pricePaise: row.pricePaise,
    discountBp: row.discountBp,
  }));
}

async function loadPriceListItems(input: {
  now: Date;
  channel: string;
  customerGroupId: string | null;
  productIds: string[];
  variantIds: string[];
}): Promise<PricingPriceListItem[]> {
  const rows = await prisma.priceListItem.findMany({
    where: {
      OR: [{ productId: { in: input.productIds } }, { variantId: { in: input.variantIds } }],
      priceList: {
        deletedAt: null,
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: input.now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: input.now } }] },
          { OR: [{ channel: 'ALL' }, { channel: input.channel }] },
          {
            OR: [
              { customerGroupId: null },
              ...(input.customerGroupId ? [{ customerGroupId: input.customerGroupId }] : []),
            ],
          },
        ],
      },
    },
    include: { priceList: { select: { code: true, priority: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    priceListId: row.priceListId,
    priceListCode: row.priceList.code,
    priceListPriority: row.priceList.priority,
    productId: row.productId,
    variantId: row.variantId,
    minQty: row.minQty,
    pricePaise: row.pricePaise,
  }));
}

/** Orders arrive in Prompt 9; until then every customer is on their first order. */
async function checkFirstOrder(customerId: string | null): Promise<boolean> {
  if (!customerId) return true;
  const confirmed = await prisma.couponRedemption.count({
    where: { customerId, status: 'CONFIRMED' },
  });
  return confirmed === 0;
}
