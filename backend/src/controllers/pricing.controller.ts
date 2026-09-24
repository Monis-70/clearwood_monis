import type { Request, Response } from 'express';

import type {
  CouponBulkGenerateInput,
  CouponCreateInput,
  CouponListQuery,
  CouponUpdateInput,
  CustomerGroupCreateInput,
  CustomerGroupMembersInput,
  CustomerGroupUpdateInput,
  DiscountRuleCreateInput,
  DiscountRuleUpdateInput,
  PincodeParam,
  PriceListCreateInput,
  PriceListItemsInput,
  PriceListUpdateInput,
  PricingSettingsUpdateInput,
  ProductPriceQuery,
  QuoteRequestInput,
  ShippingPincodeCreateInput,
  ShippingPincodeRangeCreateInput,
  ShippingRateCreateInput,
  ShippingRateUpdateInput,
  ShippingZoneCreateInput,
  ShippingZoneUpdateInput,
  SimulateInput,
  TierPriceCreateInput,
  TierPriceListQuery,
  TierPriceUpdateInput,
  ValidateCouponInput,
} from '@shared/schemas/pricing';
import type { IdParam, ListQuery, SlugParam } from '@shared/schemas/common';

import { auditService } from '../modules/auth/audit.service';
import { couponRedemptionService } from '../modules/pricing/coupon.redemption.service';
import { pricingFacade } from '../modules/pricing/pricing.facade';
import {
  couponAdminService,
  customerGroupService,
  discountRuleService,
  explainProduct,
  priceListService,
  pricingSettingsService,
  shippingAdminService,
  tierPriceService,
} from '../modules/pricing/pricingAdmin.service';
import { shippingService } from '../modules/pricing/shipping.service';
import { ok, paginated } from '../utils/response';

/** R1 — thin controllers. All price maths happens inside the pricing module, never here. */

function customerIdOf(req: Request): string | null {
  return req.auth?.realm === 'CUSTOMER' ? req.auth.principalId : null;
}

/* ----------------------------------------------------------------- public */

export const pricingController = {
  /** PDP price for one product, with options, quantity, pincode and an optional coupon. */
  async productPrice(req: Request, res: Response): Promise<void> {
    const { slug } = req.params as unknown as SlugParam;
    const query = req.query as unknown as ProductPriceQuery;

    const breakdown = await pricingFacade.quoteProduct({
      items: [
        {
          slug,
          variantId: query.variantId ?? null,
          optionValueIds: query.optionValueIds,
          qty: query.qty,
        },
      ],
      ...(query.couponCode ? { couponCode: query.couponCode } : {}),
      ...(query.pincode ? { pincode: query.pincode } : {}),
      channel: query.channel,
      customerId: customerIdOf(req),
      reachableOnly: true,
    });

    ok(res, breakdown);
  },

  async quote(req: Request, res: Response): Promise<void> {
    const input = req.body as QuoteRequestInput;

    const breakdown = await pricingFacade.quoteCart({
      items: input.items,
      ...(input.couponCode ? { couponCode: input.couponCode } : {}),
      ...(input.pincode ? { pincode: input.pincode } : {}),
      channel: input.channel,
      ...(input.shippingMethod ? { shippingMethod: input.shippingMethod } : {}),
      customerId: customerIdOf(req),
      reachableOnly: true,
    });

    ok(res, breakdown);
  },

  async validateCoupon(req: Request, res: Response): Promise<void> {
    const input = req.body as ValidateCouponInput;

    const result = await pricingFacade.validateCoupon(input.code, {
      items: input.items,
      ...(input.pincode ? { pincode: input.pincode } : {}),
      channel: input.channel,
      customerId: customerIdOf(req),
      reachableOnly: true,
    });

    ok(res, result);
  },

  async serviceability(req: Request, res: Response): Promise<void> {
    const { pincode } = req.params as unknown as PincodeParam;
    ok(res, await shippingService.serviceability(pincode));
  },
};

/* ------------------------------------------------------------------ admin */

export const adminPricingController = {
  async simulate(req: Request, res: Response): Promise<void> {
    const input = req.body as SimulateInput;

    const simulation = await pricingFacade.simulate({
      items: input.items,
      ...(input.couponCode ? { couponCode: input.couponCode } : {}),
      ...(input.pincode ? { pincode: input.pincode } : {}),
      channel: input.channel,
      ...(input.shippingMethod ? { shippingMethod: input.shippingMethod } : {}),
      customerId: input.customerId ?? null,
      customerGroupId: input.customerGroupId ?? null,
      ...(input.now ? { now: input.now } : {}),
      includeTrace: input.includeTrace,
    });

    ok(res, simulation);
  },

  async explain(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await explainProduct(id));
  },

  async readSettings(_req: Request, res: Response): Promise<void> {
    ok(res, await pricingSettingsService.read());
  },

  async updateSettings(req: Request, res: Response): Promise<void> {
    const settings = await pricingSettingsService.update(req.body as PricingSettingsUpdateInput);

    void auditService.recordFromRequest(req, {
      action: 'SETTING_CHANGED',
      entity: 'PricingSettings',
      entityId: null,
      severity: 'NOTICE',
      meta: { keys: Object.keys(req.body as Record<string, unknown>) },
    });

    ok(res, settings);
  },
};

/* -------------------------------------------------------- customer groups */

export const adminCustomerGroupController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await customerGroupService.list(req.query as unknown as ListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async create(req: Request, res: Response): Promise<void> {
    const group = await customerGroupService.create(req.body as CustomerGroupCreateInput);
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'CustomerGroup',
      entityId: group.id,
    });
    ok(res, group, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const group = await customerGroupService.update(id, req.body as CustomerGroupUpdateInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'CustomerGroup',
      entityId: id,
    });
    ok(res, group);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await customerGroupService.remove(id);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'CustomerGroup',
      entityId: id,
      severity: 'WARNING',
    });
    ok(res, { deleted: true });
  },

  async members(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await customerGroupService.members(id));
  },

  async addMembers(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const { customerIds } = req.body as CustomerGroupMembersInput;
    const added = await customerGroupService.addMembers(id, customerIds);

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'CustomerGroup',
      entityId: id,
      meta: { addedMembers: added },
    });

    ok(res, { added });
  },

  async removeMembers(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const { customerIds } = req.body as CustomerGroupMembersInput;
    ok(res, { removed: await customerGroupService.removeMembers(id, customerIds) });
  },
};

/* ------------------------------------------------------------ price lists */

export const adminPriceListController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await priceListService.list(req.query as unknown as ListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async create(req: Request, res: Response): Promise<void> {
    const list = await priceListService.create(req.body as PriceListCreateInput);
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'PriceList',
      entityId: list.id,
    });
    ok(res, list, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const list = await priceListService.update(id, req.body as PriceListUpdateInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'PriceList',
      entityId: id,
    });
    ok(res, list);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await priceListService.remove(id);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'PriceList',
      entityId: id,
      severity: 'WARNING',
    });
    ok(res, { deleted: true });
  },

  async items(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await priceListService.items(id));
  },

  async setItems(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const count = await priceListService.setItems(id, req.body as PriceListItemsInput);

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'PriceList',
      entityId: id,
      severity: 'NOTICE',
      meta: { items: count },
    });

    ok(res, { items: count });
  },
};

/* ------------------------------------------------------------ tier prices */

export const adminTierPriceController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await tierPriceService.list(req.query as unknown as TierPriceListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async create(req: Request, res: Response): Promise<void> {
    const tier = await tierPriceService.create(req.body as TierPriceCreateInput);
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'TierPrice',
      entityId: tier.id,
    });
    ok(res, tier, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const tier = await tierPriceService.update(id, req.body as TierPriceUpdateInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'TierPrice',
      entityId: id,
    });
    ok(res, tier);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await tierPriceService.remove(id);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'TierPrice',
      entityId: id,
    });
    ok(res, { deleted: true });
  },
};

/* ---------------------------------------------------------------- coupons */

export const adminCouponController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await couponAdminService.list(req.query as unknown as CouponListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async get(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const [coupon, counts] = await Promise.all([
      couponAdminService.get(id),
      couponRedemptionService.countFor(id),
    ]);
    ok(res, { ...coupon, redemptions: counts });
  },

  async create(req: Request, res: Response): Promise<void> {
    const coupon = await couponAdminService.create(req.body as CouponCreateInput);
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Coupon',
      entityId: coupon.id,
      severity: 'NOTICE',
      meta: { code: coupon.code },
    });
    ok(res, coupon, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const coupon = await couponAdminService.update(id, req.body as CouponUpdateInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Coupon',
      entityId: id,
      severity: 'NOTICE',
    });
    ok(res, coupon);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await couponAdminService.remove(id);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'Coupon',
      entityId: id,
      severity: 'WARNING',
    });
    ok(res, { deleted: true });
  },

  async redemptions(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await couponRedemptionService.list(id));
  },

  async bulkGenerate(req: Request, res: Response): Promise<void> {
    const codes = await couponAdminService.bulkGenerate(req.body as CouponBulkGenerateInput);

    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Coupon',
      entityId: null,
      severity: 'WARNING',
      meta: { generated: codes.length },
    });

    ok(res, { codes }, { count: codes.length }, 201);
  },
};

/* --------------------------------------------------------- discount rules */

export const adminDiscountRuleController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await discountRuleService.list(req.query as unknown as ListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async create(req: Request, res: Response): Promise<void> {
    const rule = await discountRuleService.create(req.body as DiscountRuleCreateInput);
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'DiscountRule',
      entityId: rule.id,
      severity: 'NOTICE',
    });
    ok(res, rule, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const rule = await discountRuleService.update(id, req.body as DiscountRuleUpdateInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'DiscountRule',
      entityId: id,
      severity: 'NOTICE',
    });
    ok(res, rule);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await discountRuleService.remove(id);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'DiscountRule',
      entityId: id,
      severity: 'WARNING',
    });
    ok(res, { deleted: true });
  },

  /** Dry run: prices the given cart and reports which rules fired. */
  async evaluate(req: Request, res: Response): Promise<void> {
    const input = req.body as SimulateInput;

    const simulation = await pricingFacade.simulate({
      items: input.items,
      ...(input.pincode ? { pincode: input.pincode } : {}),
      channel: input.channel,
      customerGroupId: input.customerGroupId ?? null,
      ...(input.now ? { now: input.now } : {}),
      includeTrace: true,
    });

    ok(res, {
      appliedRuleIds: simulation.breakdown.appliedRuleIds,
      discountPaise: simulation.breakdown.discountPaise,
      trace: simulation.trace.filter((step) => step.step.includes('discountRule')),
    });
  },
};

/* --------------------------------------------------------------- shipping */

export const adminShippingController = {
  async zones(_req: Request, res: Response): Promise<void> {
    ok(res, await shippingAdminService.zones());
  },

  async createZone(req: Request, res: Response): Promise<void> {
    const zone = await shippingAdminService.createZone(req.body as ShippingZoneCreateInput);
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'ShippingZone',
      entityId: zone.id,
    });
    ok(res, zone, null, 201);
  },

  async updateZone(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const zone = await shippingAdminService.updateZone(id, req.body as ShippingZoneUpdateInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'ShippingZone',
      entityId: id,
    });
    ok(res, zone);
  },

  async removeZone(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await shippingAdminService.removeZone(id);
    ok(res, { deleted: true });
  },

  async rates(req: Request, res: Response): Promise<void> {
    const { zoneId } = req.query as { zoneId?: string };
    ok(res, await shippingAdminService.rates(zoneId));
  },

  async createRate(req: Request, res: Response): Promise<void> {
    const rate = await shippingAdminService.createRate(req.body as ShippingRateCreateInput);
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'ShippingRate',
      entityId: rate.id,
    });
    ok(res, rate, null, 201);
  },

  async updateRate(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const rate = await shippingAdminService.updateRate(id, req.body as ShippingRateUpdateInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'ShippingRate',
      entityId: id,
    });
    ok(res, rate);
  },

  async removeRate(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await shippingAdminService.removeRate(id);
    ok(res, { deleted: true });
  },

  async pincodes(req: Request, res: Response): Promise<void> {
    const { zoneId } = req.query as { zoneId?: string };
    ok(res, await shippingAdminService.pincodes(zoneId));
  },

  async createPincode(req: Request, res: Response): Promise<void> {
    ok(
      res,
      await shippingAdminService.createPincode(req.body as ShippingPincodeCreateInput),
      null,
      201,
    );
  },

  async removePincode(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await shippingAdminService.removePincode(id);
    ok(res, { deleted: true });
  },

  async createRange(req: Request, res: Response): Promise<void> {
    ok(
      res,
      await shippingAdminService.createRange(req.body as ShippingPincodeRangeCreateInput),
      null,
      201,
    );
  },

  async importPincodes(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const file = (req.files as Express.Multer.File[] | undefined)?.[0];
    const csv = file
      ? file.buffer.toString('utf8')
      : String((req.body as { csv?: string }).csv ?? '');

    const result = await shippingAdminService.importPincodes(id, csv);

    void auditService.recordFromRequest(req, {
      action: 'IMPORT',
      entity: 'ShippingPincode',
      entityId: id,
      severity: 'WARNING',
      meta: result,
    });

    ok(res, result);
  },
};
