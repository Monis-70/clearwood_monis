import type {
  Coupon,
  CustomerGroup,
  DiscountRule,
  PriceList,
  ShippingRate,
  ShippingZone,
  TierPrice,
} from '@prisma/client';

import type {
  CouponBulkGenerateInput,
  CouponCreateInput,
  CouponListQuery,
  CouponUpdateInput,
  CustomerGroupCreateInput,
  CustomerGroupUpdateInput,
  DiscountRuleCreateInput,
  DiscountRuleUpdateInput,
  PriceListCreateInput,
  PriceListItemsInput,
  PriceListUpdateInput,
  PricingSettingsUpdateInput,
  ShippingPincodeCreateInput,
  ShippingPincodeRangeCreateInput,
  ShippingRateCreateInput,
  ShippingRateUpdateInput,
  ShippingZoneCreateInput,
  ShippingZoneUpdateInput,
  TierPriceCreateInput,
  TierPriceListQuery,
  TierPriceUpdateInput,
} from '@shared/schemas/pricing';
import type { ListQuery } from '@shared/schemas/common';
import type { PricingSettings } from '@shared/types/pricing';

import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { notDeleted, pageResult, skipTake, type PageResult } from '../../repositories/helpers';
import { updateVersioned } from '../../repositories/versioned';
import { AppError } from '../../utils/AppError';
import { jsonColumn } from '../../utils/jsonColumn';
import { catalogCacheService } from '../catalog-admin/catalogCache.service';

import { pricingContextLoader } from './pricingContext.loader';

/**
 * Admin CRUD for everything the pricing engine reads. Every write invalidates the pricing cache
 * through the existing catalogCache map, which is why an edit is visible on the very next quote.
 */

const appliesToColumn = jsonColumn<Record<string, unknown>>(undefined, 'Coupon.appliesToJson');

/** Groups, price lists and tiers feed a catalog unit price: the listing index is re-priced. */
async function touched(): Promise<void> {
  await catalogCacheService.invalidatePricing();
}

/**
 * Coupons, discount rules, shipping, pricing settings and group membership never change a
 * catalog unit price (engine steps 1-7, the listing index's basis): caches only.
 */
async function touchedCheckout(): Promise<void> {
  await catalogCacheService.invalidatePricing({ affectsCatalogPrices: false });
}

/* ------------------------------------------------------- customer groups */

export const customerGroupService = {
  async list(query: ListQuery): Promise<PageResult<CustomerGroup>> {
    const args = { where: notDeleted };
    const [items, total] = await Promise.all([
      prisma.customerGroup.findMany({
        ...args,
        ...skipTake(query),
        orderBy: [{ priority: 'desc' }, { code: 'asc' }],
      }),
      prisma.customerGroup.count(args),
    ]);
    return pageResult(items, total, query);
  },

  async get(id: string): Promise<CustomerGroup> {
    const group = await prisma.customerGroup.findFirst({ where: { id, ...notDeleted } });
    if (!group) throw AppError.notFound('Customer group not found', { id });
    return group;
  },

  async create(input: CustomerGroupCreateInput): Promise<CustomerGroup> {
    const clash = await prisma.customerGroup.count({ where: { code: input.code } });
    if (clash > 0)
      throw AppError.conflict('That group code is already in use', { code: input.code });

    const group = await prisma.customerGroup.create({
      data: {
        ...input,
        description: input.description ?? null,
        discountBp: input.discountBp ?? null,
      },
    });

    if (group.isDefault) await demoteOtherDefaultGroups(group.id);
    await touched();
    return group;
  },

  async update(id: string, input: CustomerGroupUpdateInput): Promise<CustomerGroup> {
    await this.get(id);
    const { version, ...rest } = input;

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }

    await updateVersioned(prisma.customerGroup, 'CustomerGroup', id, version, data);
    const updated = await this.get(id);
    if (updated.isDefault) await demoteOtherDefaultGroups(id);

    await touched();
    return updated;
  },

  async remove(id: string): Promise<void> {
    const group = await this.get(id);
    if (group.isDefault) {
      throw new AppError(409, 'GROUP_IS_DEFAULT', 'The default customer group cannot be removed', {
        id,
      });
    }

    await prisma.customerGroup.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await touched();
  },

  async addMembers(groupId: string, customerIds: string[]): Promise<number> {
    await this.get(groupId);

    let added = 0;
    for (const customerId of customerIds) {
      const existing = await prisma.customerGroupMember.findUnique({
        where: { customerId_groupId: { customerId, groupId } },
      });
      if (existing) continue;

      await prisma.customerGroupMember.create({ data: { customerId, groupId } });
      added += 1;
    }

    await touchedCheckout();
    return added;
  },

  async removeMembers(groupId: string, customerIds: string[]): Promise<number> {
    const { count } = await prisma.customerGroupMember.deleteMany({
      where: { groupId, customerId: { in: customerIds } },
    });
    await touchedCheckout();
    return count;
  },

  members(groupId: string) {
    return prisma.customerGroupMember.findMany({
      where: { groupId },
      orderBy: { assignedAt: 'desc' },
      take: 500,
    });
  },
};

async function demoteOtherDefaultGroups(keepId: string): Promise<void> {
  await prisma.customerGroup.updateMany({
    where: { id: { not: keepId }, isDefault: true },
    data: { isDefault: false },
  });
}

/* ------------------------------------------------------------ price lists */

export const priceListService = {
  async list(query: ListQuery): Promise<PageResult<PriceList>> {
    const args = { where: notDeleted };
    const [items, total] = await Promise.all([
      prisma.priceList.findMany({
        ...args,
        ...skipTake(query),
        orderBy: [{ priority: 'desc' }, { code: 'asc' }],
      }),
      prisma.priceList.count(args),
    ]);
    return pageResult(items, total, query);
  },

  async get(id: string): Promise<PriceList> {
    const list = await prisma.priceList.findFirst({ where: { id, ...notDeleted } });
    if (!list) throw AppError.notFound('Price list not found', { id });
    return list;
  },

  async create(input: PriceListCreateInput): Promise<PriceList> {
    const clash = await prisma.priceList.count({ where: { code: input.code } });
    if (clash > 0) throw AppError.conflict('That price list code is in use', { code: input.code });

    const list = await prisma.priceList.create({
      data: {
        ...input,
        customerGroupId: input.customerGroupId ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
      },
    });
    await touched();
    return list;
  },

  async update(id: string, input: PriceListUpdateInput): Promise<PriceList> {
    await this.get(id);
    const { version, ...rest } = input;

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }

    await updateVersioned(prisma.priceList, 'PriceList', id, version, data);
    await touched();
    return this.get(id);
  },

  async remove(id: string): Promise<void> {
    await this.get(id);
    await prisma.priceList.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await touched();
  },

  items(priceListId: string) {
    return prisma.priceListItem.findMany({ where: { priceListId }, take: 2_000 });
  },

  /** Replaces the whole item set in one transaction — a partial upload never half-applies. */
  async setItems(priceListId: string, input: PriceListItemsInput): Promise<number> {
    await this.get(priceListId);

    await prisma.$transaction(async (tx) => {
      await tx.priceListItem.deleteMany({ where: { priceListId } });
      for (const item of input.items) {
        await tx.priceListItem.create({
          data: {
            priceListId,
            productId: item.productId ?? null,
            variantId: item.variantId ?? null,
            minQty: item.minQty,
            pricePaise: item.pricePaise,
          },
        });
      }
    });

    await touched();
    return input.items.length;
  },
};

/* ------------------------------------------------------------ tier prices */

export const tierPriceService = {
  async list(query: TierPriceListQuery): Promise<PageResult<TierPrice>> {
    const args = {
      where: {
        ...notDeleted,
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.variantId ? { variantId: query.variantId } : {}),
        ...(query.customerGroupId ? { customerGroupId: query.customerGroupId } : {}),
      },
    };

    const [items, total] = await Promise.all([
      prisma.tierPrice.findMany({
        ...args,
        ...skipTake(query),
        orderBy: [{ minQty: 'asc' }, { id: 'asc' }],
      }),
      prisma.tierPrice.count(args),
    ]);
    return pageResult(items, total, query);
  },

  async create(input: TierPriceCreateInput): Promise<TierPrice> {
    const tier = await prisma.tierPrice.create({
      data: {
        productId: input.productId ?? null,
        variantId: input.variantId ?? null,
        customerGroupId: input.customerGroupId ?? null,
        minQty: input.minQty,
        pricePaise: input.pricePaise ?? null,
        discountBp: input.discountBp ?? null,
        isActive: input.isActive,
      },
    });
    await touched();
    return tier;
  },

  async update(id: string, input: TierPriceUpdateInput): Promise<TierPrice> {
    const existing = await prisma.tierPrice.findFirst({ where: { id, ...notDeleted } });
    if (!existing) throw AppError.notFound('Tier price not found', { id });

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) data[key] = value;
    }

    const updated = await prisma.tierPrice.update({ where: { id }, data });
    await touched();
    return updated;
  },

  async remove(id: string): Promise<void> {
    await prisma.tierPrice.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await touched();
  },
};

/* ---------------------------------------------------------------- coupons */

export const couponAdminService = {
  async list(query: CouponListQuery): Promise<PageResult<Coupon>> {
    const now = new Date();
    const args = {
      where: {
        ...notDeleted,
        ...(query.type ? { type: query.type } : {}),
        ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
        ...(query.q
          ? { OR: [{ code: { contains: query.q.toUpperCase() } }, { name: { contains: query.q } }] }
          : {}),
        ...(query.activeOnly
          ? {
              isActive: true,
              AND: [
                { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
                { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
              ],
            }
          : {}),
      },
    };

    const [items, total] = await Promise.all([
      prisma.coupon.findMany({
        ...args,
        ...skipTake(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.coupon.count(args),
    ]);
    return pageResult(items, total, query);
  },

  async get(id: string): Promise<Coupon> {
    const coupon = await prisma.coupon.findFirst({ where: { id, ...notDeleted } });
    if (!coupon) throw AppError.notFound('Coupon not found', { id });
    return coupon;
  },

  async create(input: CouponCreateInput): Promise<Coupon> {
    const code = input.code.trim().toUpperCase();
    const clash = await prisma.coupon.count({ where: { code } });
    if (clash > 0) throw AppError.conflict('That coupon code already exists', { code });

    const { appliesTo, ...rest } = input;
    const coupon = await prisma.coupon.create({
      data: {
        ...rest,
        code,
        valueBp: input.valueBp ?? null,
        valuePaise: input.valuePaise ?? null,
        minSubtotalPaise: input.minSubtotalPaise ?? null,
        maxDiscountPaise: input.maxDiscountPaise ?? null,
        usageLimit: input.usageLimit ?? null,
        perCustomerLimit: input.perCustomerLimit ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        appliesToJson: appliesToColumn.serialize(appliesTo ?? null),
        description: input.description ?? null,
        termsText: input.termsText ?? null,
      },
    });

    await touchedCheckout();
    return coupon;
  },

  async update(id: string, input: CouponUpdateInput): Promise<Coupon> {
    await this.get(id);
    const { version, appliesTo, ...rest } = input;

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }
    if (appliesTo !== undefined) data.appliesToJson = appliesToColumn.serialize(appliesTo ?? null);

    await updateVersioned(prisma.coupon, 'Coupon', id, version, data);
    await touchedCheckout();
    return this.get(id);
  },

  async remove(id: string): Promise<void> {
    await this.get(id);
    await prisma.coupon.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    await touchedCheckout();
  },

  /** Generates unique single-use style codes from a template, e.g. DIWALI-7F3K9QX2. */
  async bulkGenerate(input: CouponBulkGenerateInput): Promise<string[]> {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const codes: string[] = [];

    while (codes.length < input.count) {
      let suffix = '';
      for (let i = 0; i < env.COUPON_CODE_LENGTH; i += 1) {
        suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      const code = `${input.prefix}${suffix}`.toUpperCase();

      if (codes.includes(code)) continue;
      if ((await prisma.coupon.count({ where: { code } })) > 0) continue;

      const { appliesTo, ...template } = input.template;
      await prisma.coupon.create({
        data: {
          ...template,
          code,
          valueBp: input.template.valueBp ?? null,
          valuePaise: input.template.valuePaise ?? null,
          minSubtotalPaise: input.template.minSubtotalPaise ?? null,
          maxDiscountPaise: input.template.maxDiscountPaise ?? null,
          usageLimit: input.template.usageLimit ?? null,
          perCustomerLimit: input.template.perCustomerLimit ?? null,
          startsAt: input.template.startsAt ?? null,
          endsAt: input.template.endsAt ?? null,
          appliesToJson: appliesToColumn.serialize(appliesTo ?? null),
          description: input.template.description ?? null,
          termsText: input.template.termsText ?? null,
        },
      });
      codes.push(code);
    }

    await touchedCheckout();
    return codes;
  },
};

/* --------------------------------------------------------- discount rules */

export const discountRuleService = {
  async list(query: ListQuery): Promise<PageResult<DiscountRule>> {
    const args = { where: notDeleted };
    const [items, total] = await Promise.all([
      prisma.discountRule.findMany({
        ...args,
        ...skipTake(query),
        orderBy: [{ priority: 'asc' }, { code: 'asc' }],
      }),
      prisma.discountRule.count(args),
    ]);
    return pageResult(items, total, query);
  },

  async get(id: string): Promise<DiscountRule> {
    const rule = await prisma.discountRule.findFirst({ where: { id, ...notDeleted } });
    if (!rule) throw AppError.notFound('Discount rule not found', { id });
    return rule;
  },

  async create(input: DiscountRuleCreateInput): Promise<DiscountRule> {
    const clash = await prisma.discountRule.count({ where: { code: input.code } });
    if (clash > 0)
      throw AppError.conflict('That rule code is already in use', { code: input.code });

    const rule = await prisma.discountRule.create({
      data: {
        code: input.code,
        name: input.name,
        scope: input.scope,
        priority: input.priority,
        stopFurtherRules: input.stopFurtherRules,
        conditionsJson: JSON.stringify(input.conditions),
        actionsJson: JSON.stringify(input.actions),
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        isActive: input.isActive,
        usageLimit: input.usageLimit ?? null,
      },
    });

    await touchedCheckout();
    return rule;
  },

  async update(id: string, input: DiscountRuleUpdateInput): Promise<DiscountRule> {
    await this.get(id);
    const { version, conditions, actions, ...rest } = input;

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }
    if (conditions !== undefined) data.conditionsJson = JSON.stringify(conditions);
    if (actions !== undefined) data.actionsJson = JSON.stringify(actions);

    await updateVersioned(prisma.discountRule, 'DiscountRule', id, version, data);
    await touchedCheckout();
    return this.get(id);
  },

  async remove(id: string): Promise<void> {
    await this.get(id);
    await prisma.discountRule.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await touchedCheckout();
  },
};

/* --------------------------------------------------------------- shipping */

export const shippingAdminService = {
  zones(): Promise<ShippingZone[]> {
    return prisma.shippingZone.findMany({ where: notDeleted, orderBy: { priority: 'asc' } });
  },

  async createZone(input: ShippingZoneCreateInput): Promise<ShippingZone> {
    const clash = await prisma.shippingZone.count({ where: { code: input.code } });
    if (clash > 0)
      throw AppError.conflict('That zone code is already in use', { code: input.code });

    const zone = await prisma.shippingZone.create({ data: input });
    await touchedCheckout();
    return zone;
  },

  async updateZone(id: string, input: ShippingZoneUpdateInput): Promise<ShippingZone> {
    const { version, ...rest } = input;

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }

    await updateVersioned(prisma.shippingZone, 'ShippingZone', id, version, data);
    await touchedCheckout();
    return prisma.shippingZone.findUniqueOrThrow({ where: { id } });
  },

  async removeZone(id: string): Promise<void> {
    await prisma.shippingZone.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await touchedCheckout();
  },

  rates(zoneId?: string): Promise<ShippingRate[]> {
    return prisma.shippingRate.findMany({
      where: { ...notDeleted, ...(zoneId ? { zoneId } : {}) },
      orderBy: [{ zoneId: 'asc' }, { priority: 'asc' }],
    });
  },

  async createRate(input: ShippingRateCreateInput): Promise<ShippingRate> {
    const rate = await prisma.shippingRate.create({
      data: {
        ...input,
        minValue: input.minValue ?? null,
        maxValue: input.maxValue ?? null,
        perUnitPaise: input.perUnitPaise ?? null,
        freeAbovePaise: input.freeAbovePaise ?? null,
        etaMinDays: input.etaMinDays ?? null,
        etaMaxDays: input.etaMaxDays ?? null,
      },
    });
    await touchedCheckout();
    return rate;
  },

  async updateRate(id: string, input: ShippingRateUpdateInput): Promise<ShippingRate> {
    const { version, ...rest } = input;

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }

    await updateVersioned(prisma.shippingRate, 'ShippingRate', id, version, data);
    await touchedCheckout();
    return prisma.shippingRate.findUniqueOrThrow({ where: { id } });
  },

  async removeRate(id: string): Promise<void> {
    await prisma.shippingRate.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await touchedCheckout();
  },

  pincodes(zoneId?: string) {
    return prisma.shippingPincode.findMany({
      where: zoneId ? { zoneId } : {},
      orderBy: { pincode: 'asc' },
      take: 1_000,
    });
  },

  async createPincode(input: ShippingPincodeCreateInput) {
    const row = await prisma.shippingPincode.upsert({
      where: { pincode: input.pincode },
      update: {
        zoneId: input.zoneId,
        city: input.city ?? null,
        state: input.state ?? null,
        stateCode: input.stateCode ?? null,
        isServiceable: input.isServiceable,
        codAvailable: input.codAvailable,
        etaMinDays: input.etaMinDays ?? null,
        etaMaxDays: input.etaMaxDays ?? null,
      },
      create: {
        ...input,
        city: input.city ?? null,
        state: input.state ?? null,
        stateCode: input.stateCode ?? null,
        etaMinDays: input.etaMinDays ?? null,
        etaMaxDays: input.etaMaxDays ?? null,
      },
    });
    await touchedCheckout();
    return row;
  },

  async removePincode(id: string): Promise<void> {
    await prisma.shippingPincode.delete({ where: { id } });
    await touchedCheckout();
  },

  async createRange(input: ShippingPincodeRangeCreateInput) {
    const row = await prisma.shippingPincodeRange.create({
      data: { ...input, stateCode: input.stateCode ?? null },
    });
    await touchedCheckout();
    return row;
  },

  /** CSV import: `pincode,city,state,stateCode,isServiceable,codAvailable,etaMinDays,etaMaxDays`. */
  async importPincodes(
    zoneId: string,
    csv: string,
  ): Promise<{ imported: number; skipped: number }> {
    const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const header =
      lines
        .shift()
        ?.split(',')
        .map((column) => column.trim()) ?? [];
    const index = (name: string) => header.indexOf(name);

    let imported = 0;
    let skipped = 0;

    for (const line of lines) {
      const cells = line.split(',').map((cell) => cell.trim());
      const pincode = cells[index('pincode')] ?? '';

      if (!/^[1-9][0-9]{5}$/.test(pincode)) {
        skipped += 1;
        continue;
      }

      await prisma.shippingPincode.upsert({
        where: { pincode },
        update: { zoneId },
        create: {
          zoneId,
          pincode,
          city: cells[index('city')] || null,
          state: cells[index('state')] || null,
          stateCode: cells[index('stateCode')] || null,
          isServiceable: cells[index('isServiceable')] !== 'false',
          codAvailable: cells[index('codAvailable')] === 'true',
          etaMinDays: Number(cells[index('etaMinDays')]) || null,
          etaMaxDays: Number(cells[index('etaMaxDays')]) || null,
        },
      });
      imported += 1;
    }

    await touchedCheckout();
    return { imported, skipped };
  },
};

/* --------------------------------------------------------------- settings */

const SETTING_KEYS: Record<keyof PricingSettingsUpdateInput, { key: string; type: string }> = {
  pricesIncludeTax: { key: 'pricing.prices_include_tax', type: 'boolean' },
  sellerStateCode: { key: 'pricing.seller_state_code', type: 'string' },
  defaultPlaceOfSupply: { key: 'pricing.default_place_of_supply', type: 'string' },
  shippingTaxable: { key: 'pricing.shipping_taxable', type: 'boolean' },
  shippingTaxClassCode: { key: 'pricing.shipping_tax_class_code', type: 'string' },
  roundTotalToRupee: { key: 'pricing.round_total_to_rupee', type: 'boolean' },
  freeShippingThresholdPaise: { key: 'pricing.free_shipping_threshold_paise', type: 'number' },
  showSavingsBadge: { key: 'pricing.show_savings_badge', type: 'boolean' },
  minOrderValuePaise: { key: 'pricing.min_order_value_paise', type: 'number' },
};

export const pricingSettingsService = {
  read(): Promise<PricingSettings> {
    return pricingContextLoader.readSettings();
  },

  async update(input: PricingSettingsUpdateInput): Promise<PricingSettings> {
    for (const [field, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const mapping = SETTING_KEYS[field as keyof PricingSettingsUpdateInput];
      if (!mapping) continue;

      await prisma.appSetting.upsert({
        where: { key: mapping.key },
        update: { value: String(value) },
        create: {
          key: mapping.key,
          value: String(value),
          group: 'pricing',
          valueType: mapping.type,
          isPublic: PUBLIC_SETTING_KEYS.has(mapping.key),
        },
      });
    }

    await touchedCheckout();
    return this.read();
  },
};

const PUBLIC_SETTING_KEYS = new Set([
  'pricing.prices_include_tax',
  'pricing.round_total_to_rupee',
  'pricing.free_shipping_threshold_paise',
  'pricing.show_savings_badge',
  'pricing.min_order_value_paise',
]);

/* ---------------------------------------------------------------- explain */

export interface ProductPricingExplanation {
  productId: string;
  sku: string;
  name: string;
  basePricePaise: number;
  taxClassCode: string | null;
  categoryIds: string[];
  adjustments: { id: string; name: string; scope: string; type: string; active: boolean }[];
  tiers: { id: string; minQty: number; pricePaise: number | null; discountBp: number | null }[];
  priceListItems: { id: string; priceListCode: string; pricePaise: number; minQty: number }[];
  coupons: { id: string; code: string; type: string; scopeNote: string }[];
  discountRules: { id: string; code: string; scope: string; priority: number }[];
}

/** Every rule that could ever touch this product — the "why is it this price?" answer. */
export async function explainProduct(productId: string): Promise<ProductPricingExplanation> {
  const product = await prisma.product.findFirst({
    where: { id: productId, ...notDeleted },
    include: {
      taxClass: true,
      categories: { select: { categoryId: true } },
      variants: { where: notDeleted, select: { id: true } },
    },
  });
  if (!product) throw AppError.notFound('Product not found', { productId });

  const categoryIds = product.categories.map((row) => row.categoryId);
  const variantIds = product.variants.map((row) => row.id);

  const [adjustments, tiers, priceListItems, coupons, discountRules] = await Promise.all([
    prisma.priceAdjustment.findMany({
      where: {
        ...notDeleted,
        OR: [
          { scope: 'GLOBAL' },
          { productId },
          { variantId: { in: variantIds } },
          { categoryId: { in: categoryIds } },
        ],
      },
      orderBy: [{ priority: 'asc' }],
    }),
    prisma.tierPrice.findMany({
      where: { ...notDeleted, OR: [{ productId }, { variantId: { in: variantIds } }] },
      orderBy: { minQty: 'asc' },
    }),
    prisma.priceListItem.findMany({
      where: { OR: [{ productId }, { variantId: { in: variantIds } }] },
      include: { priceList: { select: { code: true } } },
    }),
    prisma.coupon.findMany({ where: { ...notDeleted, isActive: true }, take: 200 }),
    prisma.discountRule.findMany({ where: { ...notDeleted, isActive: true }, take: 200 }),
  ]);

  return {
    productId,
    sku: product.sku,
    name: product.name,
    basePricePaise: product.basePricePaise,
    taxClassCode: product.taxClass?.code ?? null,
    categoryIds,
    adjustments: adjustments.map((row) => ({
      id: row.id,
      name: row.name,
      scope: row.scope,
      type: row.adjustmentType,
      active: row.isActive,
    })),
    tiers: tiers.map((row) => ({
      id: row.id,
      minQty: row.minQty,
      pricePaise: row.pricePaise,
      discountBp: row.discountBp,
    })),
    priceListItems: priceListItems.map((row) => ({
      id: row.id,
      priceListCode: row.priceList.code,
      pricePaise: row.pricePaise,
      minQty: row.minQty,
    })),
    coupons: coupons
      .map((coupon) => {
        const appliesTo = appliesToColumn.parseOrNull(coupon.appliesToJson) as {
          productIds?: string[];
          categoryIds?: string[];
          excludeProductIds?: string[];
        } | null;

        if (appliesTo?.excludeProductIds?.includes(productId)) return null;

        const targeted =
          !appliesTo ||
          (!appliesTo.productIds?.length && !appliesTo.categoryIds?.length) ||
          appliesTo.productIds?.includes(productId) ||
          appliesTo.categoryIds?.some((id) => categoryIds.includes(id));

        return targeted
          ? {
              id: coupon.id,
              code: coupon.code,
              type: coupon.type,
              scopeNote: appliesTo ? 'targeted' : 'applies to everything',
            }
          : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null),
    discountRules: discountRules.map((rule) => ({
      id: rule.id,
      code: rule.code,
      scope: rule.scope,
      priority: rule.priority,
    })),
  };
}
