import { z } from 'zod';

import { INDIAN_PHONE_PATTERN, INDIAN_PINCODE_PATTERN, INDIAN_STATE_CODES } from '../constants';
import {
  ADDRESS_TYPES,
  ADDRESS_USAGES,
  CART_STATUSES,
  MERGE_STRATEGIES,
  WISHLIST_PRIORITIES,
} from '../enums';

import { booleanQuerySchema, idSchema, listQuerySchema, slugSchema } from './common';
import { phoneSchema } from './auth';

/** R2 — nothing reaches a cart, wishlist or address service without passing through here. */

export const pincodeSchema = z
  .string()
  .trim()
  .regex(INDIAN_PINCODE_PATTERN, 'An Indian pincode is six digits and cannot start with 0');

/** The Prompt 3 phone schema, reused so one customer can never have two spellings of a number. */
export const indianPhoneSchema = phoneSchema.refine(
  (value) => INDIAN_PHONE_PATTERN.test(value),
  'Enter a 10-digit Indian mobile number',
);

export const stateCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((value) => INDIAN_STATE_CODES.includes(value), 'Unknown Indian state code');

/* ------------------------------------------------------------------- cart */

export const cartAddItemSchema = z
  .object({
    productId: idSchema.optional(),
    slug: slugSchema.optional(),
    variantId: idSchema.nullish(),
    optionValueIds: z.array(idSchema).max(20).default([]),
    qty: z.number().int().min(1).max(999).default(1),
    note: z.string().max(500).nullish(),
    /** Reserved for Prompt 11; stored and hashed into the lineKey, never priced here. */
    customization: z.record(z.unknown()).nullish(),
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
export type CartAddItemInput = z.infer<typeof cartAddItemSchema>;

export const cartUpdateItemSchema = z
  .object({
    qty: z.number().int().min(0).max(999).optional(),
    note: z.string().max(500).nullish(),
  })
  .refine((value) => value.qty !== undefined || value.note !== undefined, 'Provide qty or note');
export type CartUpdateItemInput = z.infer<typeof cartUpdateItemSchema>;

export const cartReorderSchema = z.object({
  items: z
    .array(z.object({ lineId: idSchema, position: z.number().int().min(0).max(999) }))
    .min(1)
    .max(100),
});
export type CartReorderInput = z.infer<typeof cartReorderSchema>;

export const cartPincodeSchema = z.object({ pincode: pincodeSchema });
export type CartPincodeInput = z.infer<typeof cartPincodeSchema>;

export const cartCouponSchema = z.object({
  code: z.string().trim().min(2).max(40),
});
export type CartCouponInput = z.infer<typeof cartCouponSchema>;

export const cartValidateQuerySchema = z.object({
  autoFix: booleanQuerySchema.default(false),
});
export type CartValidateQuery = z.infer<typeof cartValidateQuerySchema>;

export const cartMergeSchema = z.object({
  strategy: z.enum(MERGE_STRATEGIES).default('SUM_QUANTITIES'),
});
export type CartMergeInput = z.infer<typeof cartMergeSchema>;

export const lineParamSchema = z.object({ lineId: idSchema });
export const moveToWishlistSchema = z.object({ wishlistId: idSchema.optional() });

/* --------------------------------------------------------------- wishlist */

export const wishlistCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  isPublic: z.boolean().default(false),
});
export type WishlistCreateInput = z.infer<typeof wishlistCreateSchema>;

export const wishlistUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  isPublic: z.boolean().optional(),
  version: z.number().int().min(0),
});
export type WishlistUpdateInput = z.infer<typeof wishlistUpdateSchema>;

export const wishlistAddItemSchema = z
  .object({
    productId: idSchema.optional(),
    slug: slugSchema.optional(),
    variantId: idSchema.nullish(),
    optionValueIds: z.array(idSchema).max(20).default([]),
    priority: z.enum(WISHLIST_PRIORITIES).default('NORMAL'),
    note: z.string().max(500).nullish(),
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
export type WishlistAddItemInput = z.infer<typeof wishlistAddItemSchema>;

export const wishlistUpdateItemSchema = z.object({
  priority: z.enum(WISHLIST_PRIORITIES).optional(),
  note: z.string().max(500).nullish(),
  position: z.number().int().min(0).max(999).optional(),
});
export type WishlistUpdateItemInput = z.infer<typeof wishlistUpdateItemSchema>;

export const wishlistMoveToCartSchema = z.object({
  qty: z.number().int().min(1).max(99).default(1),
  removeFromList: z.boolean().default(true),
});
export type WishlistMoveToCartInput = z.infer<typeof wishlistMoveToCartSchema>;

export const wishlistItemParamSchema = z.object({ id: idSchema, itemId: idSchema });
export const shareTokenParamSchema = z.object({
  token: z
    .string()
    .min(16)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'invalid share token'),
});

/* ---------------------------------------------------------------- address */

export const addressCreateSchema = z.object({
  label: z.string().trim().max(40).nullish(),
  type: z.enum(ADDRESS_TYPES).default('HOME'),
  usage: z.enum(ADDRESS_USAGES).default('BOTH'),
  fullName: z.string().trim().min(2).max(120),
  phone: indianPhoneSchema,
  altPhone: indianPhoneSchema.nullish(),
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).nullish(),
  landmark: z.string().trim().max(120).nullish(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  stateCode: stateCodeSchema,
  pincode: pincodeSchema,
  country: z.string().trim().length(2).default('IN'),
  isDefaultShipping: z.boolean().default(false),
  isDefaultBilling: z.boolean().default(false),
  deliveryInstructions: z.string().trim().max(500).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
});
export type AddressCreateInput = z.infer<typeof addressCreateSchema>;

export const addressUpdateSchema = addressCreateSchema
  .partial()
  .extend({ version: z.number().int().min(0) });
export type AddressUpdateInput = z.infer<typeof addressUpdateSchema>;

export const addressDefaultQuerySchema = z.object({
  usage: z.enum(['SHIPPING', 'BILLING', 'BOTH']).default('BOTH'),
});
export type AddressDefaultQuery = z.infer<typeof addressDefaultQuerySchema>;

export const pincodeParamLookupSchema = z.object({ pincode: pincodeSchema });

/* -------------------------------------------------------- recently viewed */

export const recentlyViewedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type RecentlyViewedQuery = z.infer<typeof recentlyViewedQuerySchema>;

/* ------------------------------------------------------------ admin carts */

export const adminCartListQuerySchema = listQuerySchema.extend({
  status: z.enum(CART_STATUSES).optional(),
  hasCustomer: booleanQuerySchema.optional(),
  abandoned: booleanQuerySchema.optional(),
  valueMin: z.coerce.number().int().min(0).optional(),
  updatedSince: z.coerce.date().optional(),
  q: z.string().trim().min(1).max(80).optional(),
});
export type AdminCartListQuery = z.infer<typeof adminCartListQuerySchema>;

export const cartCleanupSchema = z.object({
  abandonAfterHours: z.number().int().min(1).max(8_760).optional(),
  expireGuestAfterDays: z.number().int().min(1).max(3_650).optional(),
  expireCustomerAfterDays: z.number().int().min(1).max(3_650).optional(),
});
export type CartCleanupInput = z.infer<typeof cartCleanupSchema>;
