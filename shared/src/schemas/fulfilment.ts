import { z } from 'zod';

import {
  COURIER_STRATEGIES,
  DOCUMENT_TYPES,
  NDR_ACTIONS,
  NDR_POLICIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  PACKAGING_TYPES,
  REFUND_REASONS,
  RETURN_ITEM_CONDITIONS,
  RETURN_REASONS,
  RETURN_RESOLUTIONS,
  RETURN_STATUSES,
  SHIPMENT_STATUSES,
  SHIPPING_PROVIDER_DRIVERS,
} from '../enums';

import { indianPhoneSchema, pincodeSchema, stateCodeSchema } from './cart';
import { booleanQuerySchema, idSchema, listQuerySchema, paiseSchema } from './common';

/**
 * R2 — nothing reaches a shipment, return, document or shipping-settings service without passing
 * through here.
 *
 * NOTE WHAT IS ABSENT: no schema accepts a shipping cost, a refund amount or an order total from
 * a client. Costs come from the provider, refunds come from the frozen order lines (Prompt 9A law
 * L2), and the only number a caller may choose is a QUANTITY.
 */

/* --------------------------------------------------------------- shipments */

export const shipmentLineSchema = z.object({
  orderItemId: idSchema,
  qty: z.number().int().min(1).max(999),
});

export const shipmentPackageSchema = z.object({
  weightGrams: z.number().int().min(1).max(5_000_000).optional(),
  lengthMm: z.number().int().min(1).max(10_000).optional(),
  widthMm: z.number().int().min(1).max(10_000).optional(),
  heightMm: z.number().int().min(1).max(10_000).optional(),
  packageCount: z.number().int().min(1).max(100).optional(),
  packagingType: z.enum(PACKAGING_TYPES).optional(),
});

export const shipmentCreateSchema = z
  .object({
    /** Omitted means "everything still unfulfilled". */
    items: z.array(shipmentLineSchema).min(1).max(200).optional(),
    providerCode: z.string().trim().toUpperCase().min(2).max(40).optional(),
    pickupLocationCode: z.string().trim().toUpperCase().min(2).max(40).optional(),
    package: shipmentPackageSchema.optional(),
    /** Skip the provider entirely and record a shipment somebody arranged by hand. */
    manual: z.boolean().default(false),
    courierId: z.string().trim().max(60).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type ShipmentCreateInput = z.infer<typeof shipmentCreateSchema>;

export const serviceabilityQuerySchema = z
  .object({
    deliveryPincode: pincodeSchema.optional(),
    pickupLocationCode: z.string().trim().toUpperCase().max(40).optional(),
    weightGrams: z.coerce.number().int().min(1).max(5_000_000).optional(),
    cod: booleanQuerySchema.optional(),
    declaredValuePaise: z.coerce.number().int().min(0).optional(),
    isReturn: booleanQuerySchema.optional(),
  })
  .strict();
export type ServiceabilityQuery = z.infer<typeof serviceabilityQuerySchema>;

export const assignAwbSchema = z
  .object({
    courierId: z.string().trim().min(1).max(60).optional(),
    /** Recording an AWB that was arranged outside the system. */
    manualAwb: z.string().trim().min(3).max(60).optional(),
    manualCourierName: z.string().trim().min(2).max(80).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.manualAwb && !value.manualCourierName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manualCourierName'],
        message: 'A manually entered AWB needs the courier it belongs to',
      });
    }
  });
export type AssignAwbInput = z.infer<typeof assignAwbSchema>;

export const schedulePickupSchema = z
  .object({
    pickupDate: z.coerce.date().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type SchedulePickupInput = z.infer<typeof schedulePickupSchema>;

export const shipmentCancelSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
    /** Cancel locally even if the provider refuses — recorded as CANCELLATION_REQUESTED. */
    force: z.boolean().default(false),
  })
  .strict();
export type ShipmentCancelInput = z.infer<typeof shipmentCancelSchema>;

/** Admin-entered progress for a manual shipment; provider shipments are driven by the provider. */
export const shipmentStatusSchema = z
  .object({
    status: z.enum(SHIPMENT_STATUSES),
    description: z.string().trim().max(500).optional(),
    location: z.string().trim().max(120).optional(),
    occurredAt: z.coerce.date().optional(),
    isCustomerVisible: z.boolean().default(true),
  })
  .strict();
export type ShipmentStatusInput = z.infer<typeof shipmentStatusSchema>;

export const adminShipmentListQuerySchema = listQuerySchema.extend({
  status: z.enum(SHIPMENT_STATUSES).optional(),
  providerCode: z.string().trim().max(40).optional(),
  direction: z.enum(['FORWARD', 'REVERSE']).optional(),
  courier: z.string().trim().max(80).optional(),
  orderNumber: z.string().trim().max(40).optional(),
  awb: z.string().trim().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().min(1).max(80).optional(),
});
export type AdminShipmentListQuery = z.infer<typeof adminShipmentListQuerySchema>;

export const shipmentNumberParamSchema = z.object({
  shipmentNumber: z
    .string()
    .trim()
    .toUpperCase()
    .min(4)
    .max(48)
    .regex(/^[A-Z0-9/-]+$/, 'invalid shipment number'),
});
export type ShipmentNumberParam = z.infer<typeof shipmentNumberParamSchema>;

/* --------------------------------------------------------------------- NDR */

export const ndrListQuerySchema = listQuerySchema.extend({
  status: z.enum(['OPEN', 'ACTION_REQUESTED', 'RESOLVED', 'RTO', 'CLOSED']).optional(),
});
export type NdrListQuery = z.infer<typeof ndrListQuerySchema>;

export const ndrActionSchema = z
  .object({
    action: z.enum(NDR_ACTIONS),
    note: z.string().trim().max(500).optional(),
    /** Only meaningful for REATTEMPT. */
    reattemptDate: z.coerce.date().optional(),
  })
  .strict();
export type NdrActionInput = z.infer<typeof ndrActionSchema>;

/* ----------------------------------------------------------------- returns */

export const returnCreateSchema = z
  .object({
    orderNumber: z
      .string()
      .trim()
      .toUpperCase()
      .min(4)
      .max(40)
      .regex(/^[A-Z0-9/-]+$/, 'invalid order number'),
    reason: z.enum(RETURN_REASONS),
    reasonNote: z.string().trim().max(1000).optional(),
    resolution: z.enum(RETURN_RESOLUTIONS).default('REFUND'),
    isExchange: z.boolean().default(false),
    items: z.array(shipmentLineSchema).min(1).max(200),
  })
  .strict();
export type ReturnCreateInput = z.infer<typeof returnCreateSchema>;

export const returnApproveSchema = z
  .object({
    /** Per-line approval: an admin may accept two of the three units a customer sent back. */
    items: z
      .array(z.object({ returnItemId: idSchema, qtyApproved: z.number().int().min(0).max(999) }))
      .min(1)
      .max(200)
      .optional(),
    schedulePickup: z.boolean().default(true),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type ReturnApproveInput = z.infer<typeof returnApproveSchema>;

export const returnRejectSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();
export type ReturnRejectInput = z.infer<typeof returnRejectSchema>;

export const returnInspectSchema = z
  .object({
    items: z
      .array(
        z.object({
          returnItemId: idSchema,
          qtyReceived: z.number().int().min(0).max(999),
          condition: z.enum(RETURN_ITEM_CONDITIONS),
          restock: z.boolean().default(false),
          note: z.string().trim().max(500).optional(),
        }),
      )
      .min(1)
      .max(200),
    /** Refund the inspected amount immediately, or leave it for a separate approval. */
    refundNow: z.boolean().default(false),
  })
  .strict();
export type ReturnInspectInput = z.infer<typeof returnInspectSchema>;

export const adminReturnListQuerySchema = listQuerySchema.extend({
  status: z.enum(RETURN_STATUSES).optional(),
  reason: z.enum(RETURN_REASONS).optional(),
  orderNumber: z.string().trim().max(40).optional(),
  q: z.string().trim().min(1).max(80).optional(),
});
export type AdminReturnListQuery = z.infer<typeof adminReturnListQuerySchema>;

export const returnNumberParamSchema = z.object({
  returnNumber: z
    .string()
    .trim()
    .toUpperCase()
    .min(4)
    .max(48)
    .regex(/^[A-Z0-9/-]+$/, 'invalid return number'),
});
export type ReturnNumberParam = z.infer<typeof returnNumberParamSchema>;

/* ----------------------------------------------------------------- refunds */

/**
 * A refund request, and the live preview that shows what it will cost.
 *
 * NOTE WHAT IS ABSENT: there is no `amountPaise`. The only number a human chooses is a QUANTITY;
 * the money is derived from the frozen order lines by `refundCalculator`. That is what makes
 * "an order is immutable money" survive a refund.
 */
export const refundLineSchema = z.object({
  orderItemId: idSchema,
  qty: z.number().int().min(1).max(999),
});

export const refundRequestSchema = z
  .object({
    lines: z.array(refundLineSchema).min(1).max(200),
    reason: z.enum(REFUND_REASONS).default('CUSTOMER_REQUEST'),
    note: z.string().trim().max(500).optional(),
    /** Whether the delivery charge goes back. Defaults to "only if the order closes out". */
    includeShipping: z.boolean().optional(),
    /** Put the units back on sale. Only ever true for goods inspected as RESELLABLE. */
    restock: z.boolean().default(false),
    reversalPolicy: z.enum(['PROPORTIONAL', 'PRIMARY_FIRST']).default('PROPORTIONAL'),
  })
  .strict();
export type RefundRequestInput = z.infer<typeof refundRequestSchema>;

/** Identical shape, no side effects — drives the admin's live refund preview. */
export const refundPreviewSchema = refundRequestSchema;
export type RefundPreviewInput = RefundRequestInput;

/**
 * The ONLY refund execution input. There is no `amountPaise` — the amount was already derived and
 * frozen when the refund was requested.
 */
export const refundExecuteSchema = z
  .object({
    note: z.string().trim().max(500).optional(),
    /** Reverse the Route transfers alongside the refund. Default matches the split policy. */
    reverseTransfers: z.boolean().optional(),
    speed: z.enum(['NORMAL', 'OPTIMUM']).default('NORMAL'),
  })
  .strict();
export type RefundExecuteInput = z.infer<typeof refundExecuteSchema>;

export const refundApproveSchema = z
  .object({ note: z.string().trim().max(500).optional() })
  .strict();
export type RefundApproveInput = z.infer<typeof refundApproveSchema>;

/* --------------------------------------------------------------- documents */

export const documentTypeParamSchema = z.object({ type: z.enum(DOCUMENT_TYPES) });
export type DocumentTypeParam = z.infer<typeof documentTypeParamSchema>;

export const documentListQuerySchema = z
  .object({ type: z.enum(DOCUMENT_TYPES).optional() })
  .strict();
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

/* ----------------------------------------------------- shipping settings */

export const shippingSettingsSchema = z
  .object({
    defaultProviderCode: z.string().trim().toUpperCase().min(2).max(40).optional(),
    manualFallbackEnabled: z.boolean().optional(),
    autoAssignCourier: z.boolean().optional(),
    courierStrategy: z.enum(COURIER_STRATEGIES).optional(),
    courierPriority: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    defaultPickupLocationCode: z.string().trim().toUpperCase().max(40).nullish(),
    codEnabled: z.boolean().optional(),
    codMinOrderPaise: paiseSchema.optional(),
    codMaxOrderPaise: paiseSchema.optional(),
    returnPickupEnabled: z.boolean().optional(),
    returnWindowDays: z.number().int().min(0).max(365).optional(),
    ndrPolicy: z.enum(NDR_POLICIES).optional(),
    autoGenerateLabel: z.boolean().optional(),
    autoGenerateManifest: z.boolean().optional(),
    autoInvoiceOnShip: z.boolean().optional(),
    trackingSyncMinutes: z.number().int().min(5).max(1440).optional(),
    providerMaxRetries: z.number().int().min(0).max(10).optional(),
    providerRetryBackoffMs: z.number().int().min(100).max(60_000).optional(),
    allowShipmentCancellation: z.boolean().optional(),
    rtoRestockEnabled: z.boolean().optional(),
  })
  .strict();
export type ShippingSettingsInput = z.infer<typeof shippingSettingsSchema>;

export const providerUpsertSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(2)
      .max(40)
      .regex(/^[A-Z][A-Z0-9_]*$/, 'A-Z, digits and underscores only'),
    name: z.string().trim().min(2).max(80),
    driver: z.enum(SHIPPING_PROVIDER_DRIVERS),
    isActive: z.boolean().default(false),
    isDefault: z.boolean().default(false),
    notes: z.string().trim().max(500).nullish(),
  })
  .strict();
export type ProviderUpsertInput = z.infer<typeof providerUpsertSchema>;

export const providerUpdateSchema = providerUpsertSchema
  .omit({ code: true, driver: true })
  .partial()
  .extend({ version: z.number().int().min(0).optional() })
  .strict();
export type ProviderUpdateInput = z.infer<typeof providerUpdateSchema>;

export const pickupLocationSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(2)
      .max(40)
      .regex(/^[A-Z][A-Z0-9_]*$/, 'A-Z, digits and underscores only'),
    name: z.string().trim().min(2).max(80),
    providerCode: z.string().trim().toUpperCase().max(40).nullish(),
    providerLocationId: z.string().trim().max(80).nullish(),
    contactName: z.string().trim().min(2).max(80),
    phone: indianPhoneSchema,
    email: z.string().trim().toLowerCase().email().max(255).nullish(),
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).nullish(),
    city: z.string().trim().min(2).max(80),
    state: z.string().trim().min(2).max(80),
    stateCode: stateCodeSchema,
    pincode: pincodeSchema,
    isActive: z.boolean().default(true),
    isDefault: z.boolean().default(false),
  })
  .strict();
export type PickupLocationInput = z.infer<typeof pickupLocationSchema>;

export const pickupLocationUpdateSchema = pickupLocationSchema
  .omit({ code: true })
  .partial()
  .extend({ version: z.number().int().min(0).optional() })
  .strict();
export type PickupLocationUpdateInput = z.infer<typeof pickupLocationUpdateSchema>;

/**
 * Secrets are write-only. They are accepted here, never returned by any read endpoint, and the
 * admin UI shows only whether something is configured.
 */
export const providerCredentialsSchema = z
  .object({
    email: z.string().trim().email().max(255).optional(),
    password: z.string().min(6).max(200).optional(),
    apiKey: z.string().min(6).max(400).optional(),
    webhookToken: z.string().min(6).max(400).optional(),
    baseUrl: z.string().url().max(300).optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((entry) => entry !== undefined),
    'Provide at least one credential field',
  );
export type ProviderCredentialsInput = z.infer<typeof providerCredentialsSchema>;

/* ----------------------------------------------------------- notifications */

export const notificationTemplateSchema = z
  .object({
    event: z.enum(NOTIFICATION_EVENTS),
    channel: z.enum(NOTIFICATION_CHANNELS),
    subject: z.string().trim().max(200).nullish(),
    body: z.string().trim().min(1).max(20_000),
    isActive: z.boolean().default(true),
  })
  .strict();
export type NotificationTemplateInput = z.infer<typeof notificationTemplateSchema>;

export const notificationLogQuerySchema = listQuerySchema.extend({
  event: z.enum(NOTIFICATION_EVENTS).optional(),
  channel: z.enum(NOTIFICATION_CHANNELS).optional(),
  status: z.enum(['QUEUED', 'SENT', 'FAILED', 'SKIPPED']).optional(),
});
export type NotificationLogQuery = z.infer<typeof notificationLogQuerySchema>;

/* ---------------------------------------------------------------- reports */

export const REPORT_KINDS = [
  'SALES_SUMMARY',
  'GST_HSN_SUMMARY',
  'SPLIT_PAYOUT',
  'REFUND_SUMMARY',
  'TOP_PRODUCTS',
  'INVENTORY_MOVEMENT',
] as const;

/**
 * The range is REQUIRED and capped. An unbounded aggregate over every order ever placed is a
 * denial of service the operator inflicts on themselves, usually by accident, usually at
 * month end.
 */
export const reportQuerySchema = z
  .object({
    kind: z.enum(REPORT_KINDS),
    from: z.coerce.date(),
    to: z.coerce.date(),
    format: z.enum(['csv', 'json']).default('csv'),
  })
  .strict()
  .refine((query) => query.from <= query.to, {
    message: 'from must not be after to',
    path: ['from'],
  })
  .refine(
    (query) => query.to.getTime() - query.from.getTime() <= 366 * 24 * 60 * 60 * 1000,
    { message: 'a report may not span more than 366 days', path: ['to'] },
  );
export type ReportQuery = z.infer<typeof reportQuerySchema>;

/* ---------------------------------------------------------- reconciliation */

export const shipmentReconcileSchema = z
  .object({
    limit: z.number().int().min(1).max(500).optional(),
    providerCode: z.string().trim().toUpperCase().max(40).optional(),
    /** Apply the safe repairs rather than only reporting them. */
    repair: z.boolean().default(false),
  })
  .strict();
export type ShipmentReconcileInput = z.infer<typeof shipmentReconcileSchema>;

export const shippingReportQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict();
export type ShippingReportQuery = z.infer<typeof shippingReportQuerySchema>;
