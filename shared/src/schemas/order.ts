import { z } from 'zod';

import {
  ORDER_STATUSES,
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
  REFUND_REASONS,
  SPLIT_BASES,
  SPLIT_MODES,
  SPLIT_SCOPES,
  WEBHOOK_STATUSES,
} from '../enums';

import { addressCreateSchema, indianPhoneSchema } from './cart';
import {
  basisPointsSchema,
  booleanQuerySchema,
  idSchema,
  listQuerySchema,
  paiseSchema,
} from './common';

/**
 * R2 — nothing reaches a checkout, order, split or webhook service without passing through here.
 *
 * L1 IS ENFORCED IN THIS FILE: not one schema below accepts an amount for an order. `.strict()` on
 * the place/init bodies means a client that tries to send `amountPaise` or `grandTotalPaise` is
 * rejected outright rather than quietly ignored, which is what makes the law testable.
 */

/* --------------------------------------------------------------- checkout */

const contactSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255).optional(),
  phone: indianPhoneSchema.optional(),
});

/** A guest has no address book, so they may pass an address inline. It is snapshotted either way. */
const inlineAddressSchema = addressCreateSchema;

export const checkoutInitSchema = z
  .object({
    contact: contactSchema.optional(),
    shippingAddressId: idSchema.optional(),
    shippingAddress: inlineAddressSchema.optional(),
    billingAddressId: idSchema.optional(),
    billingAddress: inlineAddressSchema.optional(),
    sameAsShipping: z.boolean().default(true),
    customerNote: z.string().trim().max(1000).optional(),
    giftMessage: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.shippingAddressId && !value.shippingAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shippingAddressId'],
        message: 'Provide a saved address id or a full address',
      });
    }
    if (!value.sameAsShipping && !value.billingAddressId && !value.billingAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['billingAddressId'],
        message: 'Provide a billing address or set sameAsShipping',
      });
    }
  });
export type CheckoutInitInput = z.infer<typeof checkoutInitSchema>;

export const checkoutPatchSchema = z
  .object({
    contact: contactSchema.optional(),
    shippingAddressId: idSchema.optional(),
    shippingAddress: inlineAddressSchema.optional(),
    billingAddressId: idSchema.optional(),
    billingAddress: inlineAddressSchema.optional(),
    sameAsShipping: z.boolean().optional(),
    paymentProvider: z.enum(PAYMENT_PROVIDERS).optional(),
    paymentMethodHint: z.string().trim().max(40).optional(),
    customerNote: z.string().trim().max(1000).optional(),
    giftMessage: z.string().trim().max(500).optional(),
  })
  .strict();
export type CheckoutPatchInput = z.infer<typeof checkoutPatchSchema>;

/** `.strict()` is the whole point: an amount in this body is a 422, never a silent override. */
export const placeOrderSchema = z
  .object({
    paymentProvider: z.enum(PAYMENT_PROVIDERS).default('RAZORPAY'),
    paymentMethodHint: z.string().trim().max(40).optional(),
    customerNote: z.string().trim().max(1000).optional(),
    /** Accepted only so tests and the mock driver can steer the simulator. */
    scenario: z.string().trim().max(40).optional(),
  })
  .strict();
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;

export const verifyPaymentSchema = z
  .object({
    razorpay_order_id: z.string().trim().min(1).max(120).optional(),
    razorpay_payment_id: z.string().trim().min(1).max(120).optional(),
    razorpay_signature: z.string().trim().min(1).max(256).optional(),
    providerOrderId: z.string().trim().min(1).max(120).optional(),
    providerPaymentId: z.string().trim().min(1).max(120).optional(),
    signature: z.string().trim().min(1).max(256).optional(),
  })
  .strict()
  .transform((value) => ({
    providerOrderId: value.providerOrderId ?? value.razorpay_order_id ?? '',
    providerPaymentId: value.providerPaymentId ?? value.razorpay_payment_id ?? '',
    signature: value.signature ?? value.razorpay_signature ?? '',
  }))
  .refine(
    (value) => value.providerOrderId && value.providerPaymentId && value.signature,
    'providerOrderId, providerPaymentId and signature are all required',
  );
export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;

export const checkoutSessionParamSchema = z.object({ sessionId: idSchema });
export type CheckoutSessionParam = z.infer<typeof checkoutSessionParamSchema>;

/* ----------------------------------------------------------------- orders */

export const orderNumberParamSchema = z.object({
  orderNumber: z
    .string()
    .trim()
    .toUpperCase()
    .min(4)
    .max(40)
    .regex(/^[A-Z0-9/-]+$/, 'invalid order number'),
});
export type OrderNumberParam = z.infer<typeof orderNumberParamSchema>;

/** Public tracking. One of email or phone must match the order, and nothing else is accepted. */
export const orderTrackSchema = z
  .object({
    orderNumber: orderNumberParamSchema.shape.orderNumber,
    email: z.string().trim().toLowerCase().email().max(255).optional(),
    phone: indianPhoneSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.email ?? value.phone),
    'Provide the email or phone on the order',
  );
export type OrderTrackInput = z.infer<typeof orderTrackSchema>;

export const orderCancelSchema = z
  .object({
    reason: z.enum(REFUND_REASONS).default('CUSTOMER_REQUEST'),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type OrderCancelInput = z.infer<typeof orderCancelSchema>;

export const myOrderListQuerySchema = listQuerySchema.extend({
  status: z.enum(ORDER_STATUSES).optional(),
});
export type MyOrderListQuery = z.infer<typeof myOrderListQuerySchema>;

/* ------------------------------------------------------------ admin orders */

export const adminOrderListQuerySchema = listQuerySchema.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  channel: z.string().trim().max(20).optional(),
  customerId: idSchema.optional(),
  couponCode: z.string().trim().max(40).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  amountMin: z.coerce.number().int().min(0).optional(),
  amountMax: z.coerce.number().int().min(0).optional(),
  hasFailedTransfer: booleanQuerySchema.optional(),
  q: z.string().trim().min(1).max(80).optional(),
});
export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>;

export const adminOrderStatusSchema = z
  .object({
    status: z.enum(ORDER_STATUSES),
    note: z.string().trim().max(500).optional(),
    isCustomerVisible: z.boolean().default(true),
  })
  .strict();
export type AdminOrderStatusInput = z.infer<typeof adminOrderStatusSchema>;

/* ------------------------------------------------------------------ split */

export const splitAccountCreateSchema = z
  .object({
    key: z
      .string()
      .trim()
      .toUpperCase()
      .min(2)
      .max(40)
      .regex(/^[A-Z][A-Z0-9_]*$/, 'A-Z, digits and underscores only'),
    name: z.string().trim().min(2).max(120),
    providerAccountId: z.string().trim().min(3).max(120),
    isActive: z.boolean().default(true),
    isPrimary: z.boolean().default(false),
    notes: z.string().trim().max(500).nullish(),
  })
  .strict();
export type SplitAccountCreateInput = z.infer<typeof splitAccountCreateSchema>;

export const splitAccountUpdateSchema = splitAccountCreateSchema
  .omit({ key: true })
  .partial()
  .extend({ version: z.number().int().min(0).optional() })
  .strict();
export type SplitAccountUpdateInput = z.infer<typeof splitAccountUpdateSchema>;

const splitRuleShape = {
  code: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase words separated by hyphens'),
  name: z.string().trim().min(2).max(120),
  scope: z.enum(SPLIT_SCOPES).default('GLOBAL'),
  scopeEntityId: idSchema.nullish(),
  basis: z.enum(SPLIT_BASES).default('ORDER_TOTAL'),
  mode: z.enum(SPLIT_MODES),
  valuePaise: paiseSchema.nullish(),
  valueBp: basisPointsSchema.max(10_000).nullish(),
  recipientKey: z.string().trim().toUpperCase().min(2).max(40),
  priority: z.number().int().min(0).max(10_000).default(100),
  isActive: z.boolean().default(true),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  minOrderPaise: paiseSchema.nullish(),
  maxTransferPaise: paiseSchema.nullish(),
  onHold: z.boolean().default(false),
  onHoldUntil: z.coerce.date().nullish(),
  notes: z.string().trim().max(500).nullish(),
};

/** Exactly one of valuePaise / valueBp, matching the mode — a REMAINDER rule carries neither. */
function refineSplitRule(
  value: {
    mode?: string;
    valuePaise?: number | null;
    valueBp?: number | null;
    scope?: string;
    scopeEntityId?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.mode === 'FIXED' && (value.valuePaise === undefined || value.valuePaise === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['valuePaise'],
      message: 'A FIXED rule needs valuePaise',
    });
  }
  if (value.mode === 'PERCENT' && (value.valueBp === undefined || value.valueBp === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['valueBp'],
      message: 'A PERCENT rule needs valueBp',
    });
  }
  if (value.mode === 'REMAINDER' && (value.valuePaise ?? value.valueBp) != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mode'],
      message: 'A REMAINDER rule takes whatever is left and carries no value',
    });
  }
  if (value.scope && value.scope !== 'GLOBAL' && !value.scopeEntityId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopeEntityId'],
      message: `A ${value.scope}-scoped rule needs the entity it applies to`,
    });
  }
}

export const splitRuleCreateSchema = z.object(splitRuleShape).strict().superRefine(refineSplitRule);
export type SplitRuleCreateInput = z.infer<typeof splitRuleCreateSchema>;

export const splitRuleUpdateSchema = z
  .object(splitRuleShape)
  .omit({ code: true })
  .partial()
  .extend({ version: z.number().int().min(0).optional() })
  .strict()
  .superRefine(refineSplitRule);
export type SplitRuleUpdateInput = z.infer<typeof splitRuleUpdateSchema>;

export const splitSimulateSchema = z
  .object({
    amountPaise: z.number().int().min(1),
    sampleOrderId: idSchema.optional(),
  })
  .strict();
export type SplitSimulateInput = z.infer<typeof splitSimulateSchema>;

export const splitRuleListQuerySchema = listQuerySchema.extend({
  scope: z.enum(SPLIT_SCOPES).optional(),
  isActive: booleanQuerySchema.optional(),
});
export type SplitRuleListQuery = z.infer<typeof splitRuleListQuerySchema>;

/* --------------------------------------------------------------- webhooks */

export const webhookListQuerySchema = listQuerySchema.extend({
  status: z.enum(WEBHOOK_STATUSES).optional(),
  eventType: z.string().trim().max(60).optional(),
});
export type WebhookListQuery = z.infer<typeof webhookListQuerySchema>;

/* ------------------------------------------------------- payment settings */

export const paymentSettingsSchema = z
  .object({
    splitEnabled: z.boolean().optional(),
    codEnabled: z.boolean().optional(),
    codMaxOrderPaise: paiseSchema.optional(),
    codFeePaise: paiseSchema.optional(),
    methodsEnabled: z.array(z.enum(PAYMENT_PROVIDERS)).min(1).optional(),
    captureMode: z.enum(['AUTOMATIC', 'MANUAL']).optional(),
    holdMinutes: z.number().int().min(1).max(1440).optional(),
    cancellationWindowHours: z.number().int().min(0).max(720).optional(),
    autoConfirmCod: z.boolean().optional(),
  })
  .strict();
export type PaymentSettingsInput = z.infer<typeof paymentSettingsSchema>;

export const reconcileSchema = z
  .object({
    olderThanMinutes: z.number().int().min(0).max(10_080).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export type ReconcileInput = z.infer<typeof reconcileSchema>;
