import { z } from 'zod';

import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  COUPON_TYPES,
  DISCOUNT_RULE_SCOPES,
  PRICING_CHANNELS,
  SHIPPING_CONDITION_TYPES,
  SHIPPING_METHODS,
} from '../enums';

import { versionSchema } from './catalogAdmin';
import { booleanQuerySchema, idSchema, listQuerySchema, paiseSchema } from './common';

/**
 * Pricing contracts (Prompt 6). The engine, the API and the admin simulator all validate through
 * these — there is no second definition of a price rule anywhere.
 */

/* ------------------------------------------------------------ enum schemas */

export const pricingChannelSchema = z.enum(PRICING_CHANNELS);
export const couponTypeSchema = z.enum(COUPON_TYPES);
export const discountRuleScopeSchema = z.enum(DISCOUNT_RULE_SCOPES);
export const shippingMethodSchema = z.enum(SHIPPING_METHODS);
export const shippingConditionTypeSchema = z.enum(SHIPPING_CONDITION_TYPES);
export const conditionOperatorSchema = z.enum(CONDITION_OPERATORS);
export const conditionFieldSchema = z.enum(CONDITION_FIELDS);

/* ----------------------------------------------------------- rule conditions */

/**
 * The whitelist IS the schema: a condition may only name a known field and a known operator, so a
 * stored rule can never smuggle an expression into the evaluator.
 */
export const ruleConditionSchema = z.object({
  field: conditionFieldSchema,
  operator: conditionOperatorSchema,
  value: z.union([
    z.string().max(200),
    z.number(),
    z.boolean(),
    z.array(z.string().max(200)).max(200),
    z.array(z.number()).max(200),
  ]),
});

export const ruleConditionGroupSchema = z.object({
  match: z.enum(['ALL', 'ANY']).default('ALL'),
  conditions: z.array(ruleConditionSchema).min(1).max(20),
});

export const discountActionSchema = z
  .object({
    type: z.enum(['PERCENT', 'FIXED', 'FREE_SHIPPING']),
    valueBp: z.number().int().min(0).max(10_000).optional(),
    valuePaise: paiseSchema.optional(),
    maxDiscountPaise: paiseSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'PERCENT' && value.valueBp === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valueBp'],
        message: 'PERCENT needs valueBp',
      });
    }
    if (value.type === 'FIXED' && value.valuePaise === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valuePaise'],
        message: 'FIXED needs valuePaise',
      });
    }
  });

/* --------------------------------------------------------------- quoting */

export const quoteLineSchema = z
  .object({
    productId: idSchema.optional(),
    slug: z.string().min(1).max(160).optional(),
    variantId: idSchema.nullish(),
    optionValueIds: z.array(idSchema).max(20).optional(),
    qty: z.number().int().min(1).max(999).default(1),
  })
  .superRefine((value, ctx) => {
    if (!value.productId && !value.slug) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productId'],
        message: 'Provide productId or slug',
      });
    }
  });

export const quoteRequestSchema = z.object({
  items: z.array(quoteLineSchema).min(1).max(50),
  couponCode: z.string().min(2).max(40).optional(),
  pincode: z
    .string()
    .regex(/^[1-9][0-9]{5}$/, 'An Indian pincode is six digits')
    .optional(),
  channel: pricingChannelSchema.default('WEB'),
  shippingMethod: shippingMethodSchema.optional(),
});

export const productPriceQuerySchema = z.object({
  variantId: idSchema.optional(),
  optionValueIds: z
    .string()
    .max(600)
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        : [],
    ),
  qty: z.coerce.number().int().min(1).max(999).default(1),
  pincode: z
    .string()
    .regex(/^[1-9][0-9]{6}$|^[1-9][0-9]{5}$/)
    .optional(),
  couponCode: z.string().min(2).max(40).optional(),
  channel: pricingChannelSchema.default('WEB'),
});

export const validateCouponSchema = z.object({
  code: z.string().min(2).max(40),
  items: z.array(quoteLineSchema).min(1).max(50),
  pincode: z
    .string()
    .regex(/^[1-9][0-9]{5}$/)
    .optional(),
  channel: pricingChannelSchema.default('WEB'),
});

export const pincodeParamSchema = z.object({
  pincode: z.string().regex(/^[1-9][0-9]{5}$/, 'An Indian pincode is six digits'),
});

/** The admin simulator may override the clock and the customer group. */
export const simulateSchema = quoteRequestSchema.extend({
  customerGroupId: idSchema.optional(),
  customerId: idSchema.optional(),
  now: z.coerce.date().optional(),
  includeTrace: z.boolean().default(true),
});

/* ------------------------------------------------------- customer groups */

export const customerGroupCreateSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Use UPPER_SNAKE_CASE'),
  name: z.string().min(2).max(120),
  description: z.string().max(500).nullish(),
  isDefault: z.boolean().default(false),
  priority: z.number().int().min(0).max(10_000).default(100),
  discountBp: z.number().int().min(0).max(10_000).nullish(),
  isActive: z.boolean().default(true),
});

export const customerGroupUpdateSchema = customerGroupCreateSchema
  .partial()
  .extend({ version: versionSchema });

export const customerGroupMembersSchema = z.object({
  customerIds: z.array(idSchema).min(1).max(500),
});

/* ------------------------------------------------------------ price lists */

export const priceListCreateSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Use UPPER_SNAKE_CASE'),
  name: z.string().min(2).max(120),
  customerGroupId: idSchema.nullish(),
  channel: pricingChannelSchema.default('WEB'),
  priority: z.number().int().min(0).max(10_000).default(100),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  isActive: z.boolean().default(true),
});

export const priceListUpdateSchema = priceListCreateSchema
  .partial()
  .extend({ version: versionSchema });

export const priceListItemsSchema = z.object({
  items: z
    .array(
      z
        .object({
          productId: idSchema.nullish(),
          variantId: idSchema.nullish(),
          minQty: z.number().int().min(1).max(10_000).default(1),
          pricePaise: paiseSchema,
        })
        .superRefine((value, ctx) => {
          if (!value.productId && !value.variantId) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['productId'],
              message: 'A price list item needs a productId or a variantId',
            });
          }
        }),
    )
    .min(1)
    .max(2_000),
});

/* ------------------------------------------------------------ tier prices */

export const tierPriceCreateSchema = z
  .object({
    productId: idSchema.nullish(),
    variantId: idSchema.nullish(),
    customerGroupId: idSchema.nullish(),
    minQty: z.number().int().min(1).max(10_000),
    pricePaise: paiseSchema.nullish(),
    discountBp: z.number().int().min(0).max(10_000).nullish(),
    isActive: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    // Exactly one of the two: a tier either replaces the price or discounts it, never both.
    const hasPrice = value.pricePaise !== null && value.pricePaise !== undefined;
    const hasDiscount = value.discountBp !== null && value.discountBp !== undefined;

    if (hasPrice === hasDiscount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pricePaise'],
        message: 'Provide exactly one of pricePaise or discountBp',
      });
    }
    if (!value.productId && !value.variantId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productId'],
        message: 'A tier needs a productId or a variantId',
      });
    }
  });

export const tierPriceUpdateSchema = z.object({
  minQty: z.number().int().min(1).max(10_000).optional(),
  pricePaise: paiseSchema.nullish(),
  discountBp: z.number().int().min(0).max(10_000).nullish(),
  customerGroupId: idSchema.nullish(),
  isActive: z.boolean().optional(),
});

export const tierPriceListQuerySchema = listQuerySchema.extend({
  productId: idSchema.optional(),
  variantId: idSchema.optional(),
  customerGroupId: idSchema.optional(),
});

/* ---------------------------------------------------------------- coupons */

export const couponAppliesToSchema = z.object({
  productIds: z.array(idSchema).max(500).optional(),
  variantIds: z.array(idSchema).max(500).optional(),
  categoryIds: z.array(idSchema).max(200).optional(),
  collectionIds: z.array(idSchema).max(100).optional(),
  excludeProductIds: z.array(idSchema).max(500).optional(),
  excludeCategoryIds: z.array(idSchema).max(200).optional(),
  customerGroupIds: z.array(idSchema).max(50).optional(),
});

export const couponBaseSchema = z.object({
  code: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only'),
  name: z.string().min(2).max(160),
  type: couponTypeSchema,
  valueBp: z.number().int().min(0).max(10_000).nullish(),
  valuePaise: paiseSchema.nullish(),
  minSubtotalPaise: paiseSchema.nullish(),
  maxDiscountPaise: paiseSchema.nullish(),
  usageLimit: z.number().int().min(1).max(1_000_000).nullish(),
  perCustomerLimit: z.number().int().min(1).max(1_000).nullish(),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  isActive: z.boolean().default(true),
  isStackable: z.boolean().default(false),
  isAutoApply: z.boolean().default(false),
  firstOrderOnly: z.boolean().default(false),
  appliesTo: couponAppliesToSchema.nullish(),
  description: z.string().max(1_000).nullish(),
  termsText: z.string().max(4_000).nullish(),
});

export const couponCreateSchema = couponBaseSchema.superRefine((value, ctx) => {
  if (value.type === 'PERCENT' && (value.valueBp === null || value.valueBp === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['valueBp'],
      message: 'PERCENT needs valueBp',
    });
  }
  if (value.type === 'FIXED' && (value.valuePaise === null || value.valuePaise === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['valuePaise'],
      message: 'FIXED needs valuePaise',
    });
  }
  if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'endsAt must be after startsAt',
    });
  }
});

export const couponUpdateSchema = z.object({
  name: z.string().min(2).max(160).optional(),
  valueBp: z.number().int().min(0).max(10_000).nullish(),
  valuePaise: paiseSchema.nullish(),
  minSubtotalPaise: paiseSchema.nullish(),
  maxDiscountPaise: paiseSchema.nullish(),
  usageLimit: z.number().int().min(1).max(1_000_000).nullish(),
  perCustomerLimit: z.number().int().min(1).max(1_000).nullish(),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  isActive: z.boolean().optional(),
  isStackable: z.boolean().optional(),
  isAutoApply: z.boolean().optional(),
  firstOrderOnly: z.boolean().optional(),
  appliesTo: couponAppliesToSchema.nullish(),
  description: z.string().max(1_000).nullish(),
  termsText: z.string().max(4_000).nullish(),
  version: versionSchema,
});

export const couponListQuerySchema = listQuerySchema.extend({
  q: z.string().min(1).max(60).optional(),
  type: couponTypeSchema.optional(),
  isActive: booleanQuerySchema.optional(),
  activeOnly: booleanQuerySchema.default(false),
});

export const couponBulkGenerateSchema = z.object({
  prefix: z
    .string()
    .max(12)
    .regex(/^[A-Z0-9]*$/)
    .default(''),
  count: z.number().int().min(1).max(500),
  template: couponBaseSchema.omit({ code: true }),
});

/* --------------------------------------------------------- discount rules */

export const discountRuleCreateSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Use UPPER_SNAKE_CASE'),
  name: z.string().min(2).max(160),
  scope: discountRuleScopeSchema,
  priority: z.number().int().min(0).max(10_000).default(100),
  stopFurtherRules: z.boolean().default(false),
  conditions: ruleConditionGroupSchema,
  actions: z.array(discountActionSchema).min(1).max(5),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  isActive: z.boolean().default(true),
  usageLimit: z.number().int().min(1).max(1_000_000).nullish(),
});

export const discountRuleUpdateSchema = discountRuleCreateSchema
  .partial()
  .extend({ version: versionSchema });

/* --------------------------------------------------------------- shipping */

export const shippingZoneCreateSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Use UPPER_SNAKE_CASE'),
  name: z.string().min(2).max(120),
  priority: z.number().int().min(0).max(10_000).default(100),
  isActive: z.boolean().default(true),
});

export const shippingZoneUpdateSchema = shippingZoneCreateSchema
  .partial()
  .extend({ version: versionSchema });

export const shippingRateCreateSchema = z
  .object({
    zoneId: idSchema,
    method: shippingMethodSchema,
    name: z.string().min(2).max(120),
    conditionType: shippingConditionTypeSchema,
    minValue: z.number().int().min(0).nullish(),
    maxValue: z.number().int().min(0).nullish(),
    basePaise: paiseSchema,
    perUnitPaise: paiseSchema.nullish(),
    freeAbovePaise: paiseSchema.nullish(),
    etaMinDays: z.number().int().min(0).max(365).nullish(),
    etaMaxDays: z.number().int().min(0).max(365).nullish(),
    isActive: z.boolean().default(true),
    priority: z.number().int().min(0).max(10_000).default(100),
  })
  .superRefine((value, ctx) => {
    if (
      value.minValue !== null &&
      value.minValue !== undefined &&
      value.maxValue !== null &&
      value.maxValue !== undefined &&
      value.maxValue < value.minValue
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxValue'],
        message: 'maxValue must be greater than or equal to minValue',
      });
    }
  });

export const shippingRateUpdateSchema = z.object({
  method: shippingMethodSchema.optional(),
  name: z.string().min(2).max(120).optional(),
  conditionType: shippingConditionTypeSchema.optional(),
  minValue: z.number().int().min(0).nullish(),
  maxValue: z.number().int().min(0).nullish(),
  basePaise: paiseSchema.optional(),
  perUnitPaise: paiseSchema.nullish(),
  freeAbovePaise: paiseSchema.nullish(),
  etaMinDays: z.number().int().min(0).max(365).nullish(),
  etaMaxDays: z.number().int().min(0).max(365).nullish(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  version: versionSchema,
});

export const shippingPincodeCreateSchema = z.object({
  zoneId: idSchema,
  pincode: z.string().regex(/^[1-9][0-9]{5}$/),
  city: z.string().max(120).nullish(),
  state: z.string().max(120).nullish(),
  stateCode: z.string().length(2).nullish(),
  isServiceable: z.boolean().default(true),
  codAvailable: z.boolean().default(false),
  etaMinDays: z.number().int().min(0).max(365).nullish(),
  etaMaxDays: z.number().int().min(0).max(365).nullish(),
});

export const shippingPincodeRangeCreateSchema = z
  .object({
    zoneId: idSchema,
    fromPincode: z.string().regex(/^[1-9][0-9]{5}$/),
    toPincode: z.string().regex(/^[1-9][0-9]{5}$/),
    stateCode: z.string().length(2).nullish(),
  })
  .superRefine((value, ctx) => {
    if (Number(value.toPincode) < Number(value.fromPincode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toPincode'],
        message: 'toPincode must not be lower than fromPincode',
      });
    }
  });

/* --------------------------------------------------------- pricing settings */

export const pricingSettingsSchema = z.object({
  pricesIncludeTax: z.boolean(),
  sellerStateCode: z.string().length(2),
  defaultPlaceOfSupply: z.string().length(2),
  shippingTaxable: z.boolean(),
  shippingTaxClassCode: z.string().min(2).max(32),
  roundTotalToRupee: z.boolean(),
  freeShippingThresholdPaise: paiseSchema,
  showSavingsBadge: z.boolean(),
  minOrderValuePaise: paiseSchema,
});

export const pricingSettingsUpdateSchema = pricingSettingsSchema.partial();

/* -------------------------------------------------------------------- types */

export type QuoteRequestInput = z.infer<typeof quoteRequestSchema>;
export type QuoteLineInput = z.infer<typeof quoteLineSchema>;
export type ProductPriceQuery = z.infer<typeof productPriceQuerySchema>;
export type ValidateCouponInput = z.infer<typeof validateCouponSchema>;
export type SimulateInput = z.infer<typeof simulateSchema>;
export type PincodeParam = z.infer<typeof pincodeParamSchema>;

export type CustomerGroupCreateInput = z.infer<typeof customerGroupCreateSchema>;
export type CustomerGroupUpdateInput = z.infer<typeof customerGroupUpdateSchema>;
export type CustomerGroupMembersInput = z.infer<typeof customerGroupMembersSchema>;

export type PriceListCreateInput = z.infer<typeof priceListCreateSchema>;
export type PriceListUpdateInput = z.infer<typeof priceListUpdateSchema>;
export type PriceListItemsInput = z.infer<typeof priceListItemsSchema>;

export type TierPriceCreateInput = z.infer<typeof tierPriceCreateSchema>;
export type TierPriceUpdateInput = z.infer<typeof tierPriceUpdateSchema>;
export type TierPriceListQuery = z.infer<typeof tierPriceListQuerySchema>;

export type CouponCreateInput = z.infer<typeof couponCreateSchema>;
export type CouponUpdateInput = z.infer<typeof couponUpdateSchema>;
export type CouponListQuery = z.infer<typeof couponListQuerySchema>;
export type CouponBulkGenerateInput = z.infer<typeof couponBulkGenerateSchema>;

export type DiscountRuleCreateInput = z.infer<typeof discountRuleCreateSchema>;
export type DiscountRuleUpdateInput = z.infer<typeof discountRuleUpdateSchema>;

export type ShippingZoneCreateInput = z.infer<typeof shippingZoneCreateSchema>;
export type ShippingZoneUpdateInput = z.infer<typeof shippingZoneUpdateSchema>;
export type ShippingRateCreateInput = z.infer<typeof shippingRateCreateSchema>;
export type ShippingRateUpdateInput = z.infer<typeof shippingRateUpdateSchema>;
export type ShippingPincodeCreateInput = z.infer<typeof shippingPincodeCreateSchema>;
export type ShippingPincodeRangeCreateInput = z.infer<typeof shippingPincodeRangeCreateSchema>;

export type PricingSettingsInput = z.infer<typeof pricingSettingsSchema>;
export type PricingSettingsUpdateInput = z.infer<typeof pricingSettingsUpdateSchema>;
