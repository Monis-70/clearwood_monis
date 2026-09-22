import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import {
  couponBulkGenerateSchema,
  couponCreateSchema,
  couponListQuerySchema,
  couponUpdateSchema,
  customerGroupCreateSchema,
  customerGroupMembersSchema,
  customerGroupUpdateSchema,
  discountRuleCreateSchema,
  discountRuleUpdateSchema,
  pincodeParamSchema,
  priceListCreateSchema,
  priceListItemsSchema,
  priceListUpdateSchema,
  pricingSettingsUpdateSchema,
  productPriceQuerySchema,
  quoteRequestSchema,
  shippingPincodeCreateSchema,
  shippingPincodeRangeCreateSchema,
  shippingRateCreateSchema,
  shippingRateUpdateSchema,
  shippingZoneCreateSchema,
  shippingZoneUpdateSchema,
  simulateSchema,
  tierPriceCreateSchema,
  tierPriceListQuerySchema,
  tierPriceUpdateSchema,
  validateCouponSchema,
} from '@shared/schemas/pricing';
import { idParamSchema, listQuerySchema, slugParamSchema } from '@shared/schemas/common';

import {
  adminCouponController,
  adminCustomerGroupController,
  adminDiscountRuleController,
  adminPriceListController,
  adminPricingController,
  adminShippingController,
  adminTierPriceController,
  pricingController,
} from '../controllers/pricing.controller';
import {
  commonErrorResponses,
  errorBodySchema,
  jsonContent,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';
import {
  asyncHandler,
  authRateLimit,
  authenticate,
  idempotency,
  optionalAuth,
  requirePermission,
  validate,
} from '../middleware';
import { uploadMiddleware } from '../middleware/upload';
import { csrfProtection } from '../modules/auth/csrf.service';

const ADMIN_PREFIX = `${API_PREFIX}/admin`;
const guard = [authenticate('ADMIN'), csrfProtection('ADMIN')];

const unauthorised = { 401: jsonContent(errorBodySchema, 'Not authenticated') };
const forbidden = { 403: jsonContent(errorBodySchema, 'Missing permission or CSRF token') };
const notFound = { 404: jsonContent(errorBodySchema, 'No such record') };

export const pricingRouter: Router = Router();
export const adminPricingRouter: Router = Router();

/* ----------------------------------------------------------- OpenAPI docs */

const priceComponentSchema = registry.register(
  'PriceComponent',
  z.object({
    code: z.string(),
    label: z.string(),
    kind: z.enum(['BASE', 'ADJUSTMENT', 'DISCOUNT', 'COUPON', 'SHIPPING', 'TAX', 'ROUNDING']),
    amountPaise: z.number().int(),
    sourceType: z.string(),
    sourceId: z.string().optional(),
    meta: z.record(z.any()).optional(),
  }),
);

const priceBreakdownSchema = registry.register(
  'PriceBreakdown',
  z.object({
    currency: z.literal('INR'),
    lines: z.array(
      z.object({
        lineId: z.string(),
        productId: z.string(),
        variantId: z.string().nullable(),
        qty: z.number().int(),
        baseUnitPaise: z.number().int(),
        unitPricePaise: z.number().int(),
        components: z.array(priceComponentSchema),
        subtotalPaise: z.number().int(),
        discountPaise: z.number().int(),
        taxablePaise: z.number().int(),
        taxPaise: z.number().int(),
        taxRateBp: z.number().int(),
        taxSplit: z.object({
          cgstPaise: z.number().int(),
          sgstPaise: z.number().int(),
          igstPaise: z.number().int(),
        }),
        totalPaise: z.number().int(),
        savingsPaise: z.number().int(),
      }),
    ),
    components: z.array(priceComponentSchema),
    subtotalPaise: z.number().int(),
    discountPaise: z.number().int(),
    shippingPaise: z.number().int(),
    taxPaise: z.number().int(),
    roundingPaise: z.number().int(),
    grandTotalPaise: z.number().int(),
    appliedCouponCode: z.string().optional(),
    engineVersion: z.number().int(),
    contextHash: z.string(),
  }),
);

const serviceabilitySchema = registry.register(
  'Serviceability',
  z.object({
    pincode: z.string(),
    isServiceable: z.boolean(),
    codAvailable: z.boolean(),
    zoneCode: z.string().nullable(),
    etaMinDays: z.number().int().nullable(),
    etaMaxDays: z.number().int().nullable(),
    matchedBy: z.enum(['PINCODE', 'RANGE', 'DEFAULT', 'NONE']),
  }),
);

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/products/{slug}/price`,
  tags: ['Pricing'],
  summary: 'Resolved price for one product, with options, quantity, pincode and coupon',
  description:
    'Runs the single pricing engine. Every component in the response sums exactly to ' +
    '`grandTotalPaise`; `contextHash` identifies the inputs that produced it.',
  request: { params: slugParamSchema, query: productPriceQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(priceBreakdownSchema), 'Price breakdown'),
    ...notFound,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/pricing/quote`,
  tags: ['Pricing'],
  summary: 'Price a whole cart',
  request: { body: { content: { 'application/json': { schema: quoteRequestSchema } } } },
  responses: {
    200: jsonContent(successBodySchema(priceBreakdownSchema), 'Price breakdown'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/pricing/validate-coupon`,
  tags: ['Pricing'],
  summary: 'Check a coupon against a cart; returns the discount or a specific rejection code',
  request: { body: { content: { 'application/json': { schema: validateCouponSchema } } } },
  responses: {
    200: jsonContent(
      successBodySchema(
        z.object({
          valid: z.boolean(),
          code: z.string(),
          rejectionCode: z.string().optional(),
          message: z.string().optional(),
          discountPaise: z.number().int().optional(),
          freeShipping: z.boolean().optional(),
        }),
      ),
      'Coupon verdict',
    ),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/shipping/serviceability/{pincode}`,
  tags: ['Pricing'],
  summary: 'Is this pincode serviceable, and how fast?',
  request: { params: pincodeParamSchema },
  responses: {
    200: jsonContent(successBodySchema(serviceabilitySchema), 'Serviceability'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/pricing/simulate`,
  tags: ['Pricing'],
  summary: 'Price a hypothetical cart and return the full rule trace',
  description:
    'The testing endpoint: every candidate rule, whether it matched, why it did not, and the ' +
    'running total after each step. Supports a date override and a forced customer group.',
  request: { body: { content: { 'application/json': { schema: simulateSchema } } } },
  responses: {
    200: jsonContent(
      successBodySchema(
        z.object({ breakdown: priceBreakdownSchema, trace: z.array(z.record(z.any())) }),
      ),
      'Breakdown plus trace',
    ),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/pricing/explain/{id}`,
  tags: ['Pricing'],
  summary: 'Every rule that could ever touch this product',
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(z.record(z.any())), 'Applicable rules'),
    ...unauthorised,
    ...forbidden,
    ...notFound,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/pricing/settings`,
  tags: ['Pricing'],
  summary: 'Read the pricing and GST settings',
  responses: {
    200: jsonContent(successBodySchema(z.record(z.any())), 'Pricing settings'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/pricing/coupons`,
  tags: ['Pricing'],
  summary: 'Create a coupon',
  request: { body: { content: { 'application/json': { schema: couponCreateSchema } } } },
  responses: {
    201: jsonContent(successBodySchema(z.record(z.any())), 'Created'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

/* --------------------------------------------------------- public routes */

pricingRouter.get(
  '/catalog/products/:slug/price',
  optionalAuth('CUSTOMER'),
  validate({ params: slugParamSchema, query: productPriceQuerySchema }),
  asyncHandler(pricingController.productPrice),
);

pricingRouter.post(
  '/pricing/quote',
  optionalAuth('CUSTOMER'),
  validate({ body: quoteRequestSchema }),
  asyncHandler(pricingController.quote),
);

pricingRouter.post(
  '/pricing/validate-coupon',
  optionalAuth('CUSTOMER'),
  authRateLimit('coupon-validate'),
  validate({ body: validateCouponSchema }),
  asyncHandler(pricingController.validateCoupon),
);

pricingRouter.get(
  '/shipping/serviceability/:pincode',
  validate({ params: pincodeParamSchema }),
  asyncHandler(pricingController.serviceability),
);

/* ---------------------------------------------------------- admin routes */

adminPricingRouter.post(
  '/pricing/simulate',
  ...guard,
  requirePermission('pricing.adjustment.read'),
  validate({ body: simulateSchema }),
  asyncHandler(adminPricingController.simulate),
);

adminPricingRouter.get(
  '/pricing/explain/:id',
  authenticate('ADMIN'),
  requirePermission('pricing.adjustment.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminPricingController.explain),
);

adminPricingRouter.get(
  '/pricing/settings',
  authenticate('ADMIN'),
  requirePermission('pricing.tax.read'),
  asyncHandler(adminPricingController.readSettings),
);

adminPricingRouter.put(
  '/pricing/settings',
  ...guard,
  requirePermission('pricing.tax.update'),
  validate({ body: pricingSettingsUpdateSchema }),
  asyncHandler(adminPricingController.updateSettings),
);

/* customer groups */
adminPricingRouter.get(
  '/pricing/customer-groups',
  authenticate('ADMIN'),
  requirePermission('order.customer.read'),
  validate({ query: listQuerySchema }),
  asyncHandler(adminCustomerGroupController.list),
);

adminPricingRouter.post(
  '/pricing/customer-groups',
  ...guard,
  requirePermission('order.customer.update'),
  idempotency('customer-group-create'),
  validate({ body: customerGroupCreateSchema }),
  asyncHandler(adminCustomerGroupController.create),
);

adminPricingRouter.patch(
  '/pricing/customer-groups/:id',
  ...guard,
  requirePermission('order.customer.update'),
  validate({ params: idParamSchema, body: customerGroupUpdateSchema }),
  asyncHandler(adminCustomerGroupController.update),
);

adminPricingRouter.delete(
  '/pricing/customer-groups/:id',
  ...guard,
  requirePermission('order.customer.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminCustomerGroupController.remove),
);

adminPricingRouter.get(
  '/pricing/customer-groups/:id/members',
  authenticate('ADMIN'),
  requirePermission('order.customer.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminCustomerGroupController.members),
);

adminPricingRouter.post(
  '/pricing/customer-groups/:id/members',
  ...guard,
  requirePermission('order.customer.update'),
  validate({ params: idParamSchema, body: customerGroupMembersSchema }),
  asyncHandler(adminCustomerGroupController.addMembers),
);

adminPricingRouter.delete(
  '/pricing/customer-groups/:id/members',
  ...guard,
  requirePermission('order.customer.update'),
  validate({ params: idParamSchema, body: customerGroupMembersSchema }),
  asyncHandler(adminCustomerGroupController.removeMembers),
);

/* price lists */
adminPricingRouter.get(
  '/pricing/price-lists',
  authenticate('ADMIN'),
  requirePermission('pricing.adjustment.read'),
  validate({ query: listQuerySchema }),
  asyncHandler(adminPriceListController.list),
);

adminPricingRouter.post(
  '/pricing/price-lists',
  ...guard,
  requirePermission('pricing.adjustment.create'),
  idempotency('price-list-create'),
  validate({ body: priceListCreateSchema }),
  asyncHandler(adminPriceListController.create),
);

adminPricingRouter.patch(
  '/pricing/price-lists/:id',
  ...guard,
  requirePermission('pricing.adjustment.update'),
  validate({ params: idParamSchema, body: priceListUpdateSchema }),
  asyncHandler(adminPriceListController.update),
);

adminPricingRouter.delete(
  '/pricing/price-lists/:id',
  ...guard,
  requirePermission('pricing.adjustment.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminPriceListController.remove),
);

adminPricingRouter.get(
  '/pricing/price-lists/:id/items',
  authenticate('ADMIN'),
  requirePermission('pricing.adjustment.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminPriceListController.items),
);

adminPricingRouter.put(
  '/pricing/price-lists/:id/items',
  ...guard,
  requirePermission('pricing.adjustment.update'),
  validate({ params: idParamSchema, body: priceListItemsSchema }),
  asyncHandler(adminPriceListController.setItems),
);

/* tier prices */
adminPricingRouter.get(
  '/pricing/tier-prices',
  authenticate('ADMIN'),
  requirePermission('pricing.adjustment.read'),
  validate({ query: tierPriceListQuerySchema }),
  asyncHandler(adminTierPriceController.list),
);

adminPricingRouter.post(
  '/pricing/tier-prices',
  ...guard,
  requirePermission('pricing.adjustment.create'),
  validate({ body: tierPriceCreateSchema }),
  asyncHandler(adminTierPriceController.create),
);

adminPricingRouter.patch(
  '/pricing/tier-prices/:id',
  ...guard,
  requirePermission('pricing.adjustment.update'),
  validate({ params: idParamSchema, body: tierPriceUpdateSchema }),
  asyncHandler(adminTierPriceController.update),
);

adminPricingRouter.delete(
  '/pricing/tier-prices/:id',
  ...guard,
  requirePermission('pricing.adjustment.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminTierPriceController.remove),
);

/* coupons */
adminPricingRouter.get(
  '/pricing/coupons',
  authenticate('ADMIN'),
  requirePermission('pricing.coupon.read'),
  validate({ query: couponListQuerySchema }),
  asyncHandler(adminCouponController.list),
);

adminPricingRouter.post(
  '/pricing/coupons/bulk-generate',
  ...guard,
  requirePermission('pricing.coupon.create'),
  authRateLimit('coupon-bulk'),
  idempotency('coupon-bulk-generate'),
  validate({ body: couponBulkGenerateSchema }),
  asyncHandler(adminCouponController.bulkGenerate),
);

adminPricingRouter.post(
  '/pricing/coupons',
  ...guard,
  requirePermission('pricing.coupon.create'),
  idempotency('coupon-create'),
  validate({ body: couponCreateSchema }),
  asyncHandler(adminCouponController.create),
);

adminPricingRouter.get(
  '/pricing/coupons/:id',
  authenticate('ADMIN'),
  requirePermission('pricing.coupon.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminCouponController.get),
);

adminPricingRouter.get(
  '/pricing/coupons/:id/redemptions',
  authenticate('ADMIN'),
  requirePermission('pricing.coupon.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminCouponController.redemptions),
);

adminPricingRouter.patch(
  '/pricing/coupons/:id',
  ...guard,
  requirePermission('pricing.coupon.update'),
  validate({ params: idParamSchema, body: couponUpdateSchema }),
  asyncHandler(adminCouponController.update),
);

adminPricingRouter.delete(
  '/pricing/coupons/:id',
  ...guard,
  requirePermission('pricing.coupon.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminCouponController.remove),
);

/* discount rules */
adminPricingRouter.get(
  '/pricing/discount-rules',
  authenticate('ADMIN'),
  requirePermission('pricing.adjustment.read'),
  validate({ query: listQuerySchema }),
  asyncHandler(adminDiscountRuleController.list),
);

adminPricingRouter.post(
  '/pricing/discount-rules/evaluate',
  ...guard,
  requirePermission('pricing.adjustment.read'),
  validate({ body: simulateSchema }),
  asyncHandler(adminDiscountRuleController.evaluate),
);

adminPricingRouter.post(
  '/pricing/discount-rules',
  ...guard,
  requirePermission('pricing.adjustment.create'),
  validate({ body: discountRuleCreateSchema }),
  asyncHandler(adminDiscountRuleController.create),
);

adminPricingRouter.patch(
  '/pricing/discount-rules/:id',
  ...guard,
  requirePermission('pricing.adjustment.update'),
  validate({ params: idParamSchema, body: discountRuleUpdateSchema }),
  asyncHandler(adminDiscountRuleController.update),
);

adminPricingRouter.delete(
  '/pricing/discount-rules/:id',
  ...guard,
  requirePermission('pricing.adjustment.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminDiscountRuleController.remove),
);

/* shipping */
adminPricingRouter.get(
  '/pricing/shipping-zones',
  authenticate('ADMIN'),
  requirePermission('pricing.tax.read'),
  asyncHandler(adminShippingController.zones),
);

adminPricingRouter.post(
  '/pricing/shipping-zones',
  ...guard,
  requirePermission('pricing.tax.update'),
  validate({ body: shippingZoneCreateSchema }),
  asyncHandler(adminShippingController.createZone),
);

adminPricingRouter.patch(
  '/pricing/shipping-zones/:id',
  ...guard,
  requirePermission('pricing.tax.update'),
  validate({ params: idParamSchema, body: shippingZoneUpdateSchema }),
  asyncHandler(adminShippingController.updateZone),
);

adminPricingRouter.delete(
  '/pricing/shipping-zones/:id',
  ...guard,
  requirePermission('pricing.tax.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminShippingController.removeZone),
);

adminPricingRouter.post(
  '/pricing/shipping-zones/:id/pincodes/import',
  ...guard,
  requirePermission('pricing.tax.update'),
  authRateLimit('pincode-import'),
  uploadMiddleware.array('files'),
  validate({ params: idParamSchema }),
  asyncHandler(adminShippingController.importPincodes),
);

adminPricingRouter.get(
  '/pricing/shipping-rates',
  authenticate('ADMIN'),
  requirePermission('pricing.tax.read'),
  asyncHandler(adminShippingController.rates),
);

adminPricingRouter.post(
  '/pricing/shipping-rates',
  ...guard,
  requirePermission('pricing.tax.update'),
  validate({ body: shippingRateCreateSchema }),
  asyncHandler(adminShippingController.createRate),
);

adminPricingRouter.patch(
  '/pricing/shipping-rates/:id',
  ...guard,
  requirePermission('pricing.tax.update'),
  validate({ params: idParamSchema, body: shippingRateUpdateSchema }),
  asyncHandler(adminShippingController.updateRate),
);

adminPricingRouter.delete(
  '/pricing/shipping-rates/:id',
  ...guard,
  requirePermission('pricing.tax.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminShippingController.removeRate),
);

adminPricingRouter.get(
  '/pricing/shipping-pincodes',
  authenticate('ADMIN'),
  requirePermission('pricing.tax.read'),
  asyncHandler(adminShippingController.pincodes),
);

adminPricingRouter.post(
  '/pricing/shipping-pincodes',
  ...guard,
  requirePermission('pricing.tax.update'),
  validate({ body: shippingPincodeCreateSchema }),
  asyncHandler(adminShippingController.createPincode),
);

adminPricingRouter.delete(
  '/pricing/shipping-pincodes/:id',
  ...guard,
  requirePermission('pricing.tax.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminShippingController.removePincode),
);

adminPricingRouter.post(
  '/pricing/shipping-pincode-ranges',
  ...guard,
  requirePermission('pricing.tax.update'),
  validate({ body: shippingPincodeRangeCreateSchema }),
  asyncHandler(adminShippingController.createRange),
);
