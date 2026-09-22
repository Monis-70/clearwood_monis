import { Router } from 'express';
import type { RequestHandler } from 'express';

import { API_PREFIX } from '@shared/constants';
import { idParamSchema } from '@shared/schemas/common';
import {
  adminReturnListQuerySchema,
  adminShipmentListQuerySchema,
  assignAwbSchema,
  ndrActionSchema,
  ndrListQuerySchema,
  refundApproveSchema,
  refundExecuteSchema,
  refundPreviewSchema,
  refundRequestSchema,
  returnApproveSchema,
  returnCreateSchema,
  returnInspectSchema,
  returnNumberParamSchema,
  returnRejectSchema,
  schedulePickupSchema,
  serviceabilityQuerySchema,
  shipmentCancelSchema,
  shipmentCreateSchema,
  shipmentNumberParamSchema,
  shipmentStatusSchema,
} from '@shared/schemas/fulfilment';
import { orderNumberParamSchema } from '@shared/schemas/order';

import {
  adminNdrController,
  adminRefundController,
  adminReturnController,
  adminShipmentController,
  customerFulfilmentController,
} from '../controllers/fulfilment.controller';
import {
  commonErrorResponses,
  jsonContent,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';
import {
  asyncHandler,
  authenticate,
  idempotency,
  requirePermission,
  validate,
} from '../middleware';
import { csrfProtection } from '../modules/auth/csrf.service';
import { customerReturnsEnabled } from '../config/env';
import { AppError } from '../utils/AppError';

/**
 * Prompt 9B — shipments, tracking, NDR, returns and refund execution.
 *
 * Permissions are the ones Prompt 3 already defines; none were invented. Shipping is a fulfilment
 * act (`order.order.fulfil`), returns are an order change plus a refund decision, and executing a
 * refund needs `order.refund.approve` because it moves real money.
 */

const ADMIN_PREFIX = `${API_PREFIX}/admin`;

const adminGuard = [authenticate('ADMIN'), csrfProtection('ADMIN')];
const customerGuard = [authenticate('CUSTOMER'), csrfProtection('CUSTOMER')];

export const fulfilmentRouter: Router = Router();
export const adminFulfilmentRouter: Router = Router();

/* ----------------------------------------------------------- OpenAPI docs */

const anyObject = z.record(z.any());

const shipmentSchema = registry.register(
  'Shipment',
  z
    .object({
      shipmentNumber: z.string().openapi({ example: 'CWS/2026-27/000001' }),
      status: z.string(),
      direction: z.string(),
      providerCode: z.string(),
      awbNumber: z.string().nullable(),
      courierName: z.string().nullable(),
      items: z.array(anyObject),
      events: z.array(anyObject).describe('The tracking timeline, oldest first'),
    })
    .passthrough(),
);

const returnSchema = registry.register(
  'ReturnRequest',
  z
    .object({
      returnNumber: z.string().openapi({ example: 'CWR/2026-27/000001' }),
      status: z.string(),
      reason: z.string(),
      requestedAmountPaise: z.number().int(),
      approvedAmountPaise: z.number().int(),
      items: z.array(anyObject),
    })
    .passthrough(),
);

const refundPreviewResponse = registry.register(
  'RefundPreview',
  z
    .object({
      computation: anyObject.describe('Derived from the FROZEN order lines — never re-priced'),
      reversalPlan: anyObject.describe('Which linked account gives back what, to the paise'),
      canExecute: z.boolean(),
      blockedReason: z.string().nullable(),
    })
    .passthrough(),
);

const shipmentNumberParam = { params: shipmentNumberParamSchema };
const returnNumberParam = { params: returnNumberParamSchema };
const orderNumberParam = { params: orderNumberParamSchema };

/* ---------------------------------------------------------- admin: shipments */

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/shipments`,
  tags: ['Admin fulfilment'],
  summary: 'Admin: list shipments',
  security: [{ adminBearer: [] }],
  request: { query: adminShipmentListQuerySchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(shipmentSchema)), 'Shipments'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/shipments/{shipmentNumber}`,
  tags: ['Admin fulfilment'],
  summary: 'Admin: one shipment with its full timeline',
  security: [{ adminBearer: [] }],
  request: shipmentNumberParam,
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(shipmentSchema), 'Shipment'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/orders/{orderNumber}/shipments`,
  tags: ['Admin fulfilment'],
  summary: 'Admin: an order\u2019s shipments and what is still unshipped',
  security: [{ adminBearer: [] }],
  request: orderNumberParam,
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(anyObject), 'Shipments and remaining quantities'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/orders/{orderNumber}/shipments`,
  tags: ['Admin fulfilment'],
  summary: 'Admin: draft a shipment for an order',
  description:
    'Omitting `items` ships everything still unfulfilled. Over-shipping is REFUSED, not clamped: ' +
    'the remaining quantity is re-derived from the existing shipments on every call.',
  security: [{ adminBearer: [] }],
  request: {
    ...orderNumberParam,
    body: { content: { 'application/json': { schema: shipmentCreateSchema } } },
  },
  responses: {
    ...commonErrorResponses,
    201: jsonContent(successBodySchema(shipmentSchema), 'Shipment drafted'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/orders/{orderNumber}/serviceability`,
  tags: ['Admin fulfilment'],
  summary: 'Admin: courier options for an order',
  description: 'Read-only. Rates are returned in paise; the provider quotes rupees.',
  security: [{ adminBearer: [] }],
  request: { ...orderNumberParam, query: serviceabilityQuerySchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Courier options, ranked'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/shipments/{shipmentNumber}/awb`,
  tags: ['Admin fulfilment'],
  summary: 'Admin: assign an AWB',
  description:
    'Registers the shipment with the courier and books a tracking number. Supply `manualAwb` to ' +
    'record a docket arranged by hand \u2014 the only route for manual dispatch, which has no courier API.',
  security: [{ adminBearer: [] }],
  request: {
    ...shipmentNumberParam,
    body: { content: { 'application/json': { schema: assignAwbSchema } } },
  },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(shipmentSchema), 'AWB assigned'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/shipments/{shipmentNumber}/pickup`,
  tags: ['Admin fulfilment'],
  summary: 'Admin: schedule a pickup',
  security: [{ adminBearer: [] }],
  request: {
    ...shipmentNumberParam,
    body: { content: { 'application/json': { schema: schedulePickupSchema } } },
  },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(shipmentSchema), 'Pickup scheduled'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/shipments/{shipmentNumber}/status`,
  tags: ['Admin fulfilment'],
  summary: 'Admin: move a shipment by hand',
  description:
    'Goes through the same state machine as a courier update, so "by hand" does not mean ' +
    '"unchecked". Required for manual fulfilment and as an escape hatch when a feed breaks.',
  security: [{ adminBearer: [] }],
  request: {
    ...shipmentNumberParam,
    body: { content: { 'application/json': { schema: shipmentStatusSchema } } },
  },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(shipmentSchema), 'Shipment updated'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/shipments/{shipmentNumber}/sync`,
  tags: ['Admin fulfilment'],
  summary: 'Admin: pull the current state from the courier',
  security: [{ adminBearer: [] }],
  request: shipmentNumberParam,
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(shipmentSchema), 'Shipment refreshed'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/shipments/{shipmentNumber}/cancel`,
  tags: ['Admin fulfilment'],
  summary: 'Admin: cancel a shipment',
  description:
    'Before pickup this is ours to decide. After pickup the courier owns the parcel, so the ' +
    'shipment moves to CANCELLATION_REQUESTED and waits.',
  security: [{ adminBearer: [] }],
  request: {
    ...shipmentNumberParam,
    body: { content: { 'application/json': { schema: shipmentCancelSchema } } },
  },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(shipmentSchema), 'Shipment cancelled or cancellation requested'),
  },
});

/* ---------------------------------------------------------------- admin: NDR */

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/ndr`,
  tags: ['Admin fulfilment'],
  summary: 'Admin: failed deliveries awaiting a decision',
  security: [{ adminBearer: [] }],
  request: { query: ndrListQuerySchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(anyObject)), 'NDR records'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/ndr/{id}/action`,
  tags: ['Admin fulfilment'],
  summary: 'Admin: reattempt delivery or send it back',
  security: [{ adminBearer: [] }],
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: ndrActionSchema } } },
  },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(anyObject), 'Decision recorded'),
  },
});

/* ------------------------------------------------------------ admin: returns */

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/returns`,
  tags: ['Admin returns'],
  summary: 'Admin: list return requests',
  security: [{ adminBearer: [] }],
  request: { query: adminReturnListQuerySchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(returnSchema)), 'Return requests'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/returns/{returnNumber}`,
  tags: ['Admin returns'],
  summary: 'Admin: one return request',
  security: [{ adminBearer: [] }],
  request: returnNumberParam,
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(returnSchema), 'Return request'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/returns/{returnNumber}/approve`,
  tags: ['Admin returns'],
  summary: 'Admin: approve a return, possibly for fewer units',
  security: [{ adminBearer: [] }],
  request: {
    ...returnNumberParam,
    body: { content: { 'application/json': { schema: returnApproveSchema } } },
  },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(returnSchema), 'Return approved'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/returns/{returnNumber}/reject`,
  tags: ['Admin returns'],
  summary: 'Admin: reject a return',
  security: [{ adminBearer: [] }],
  request: {
    ...returnNumberParam,
    body: { content: { 'application/json': { schema: returnRejectSchema } } },
  },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(returnSchema), 'Return rejected'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/returns/{returnNumber}/receive`,
  tags: ['Admin returns'],
  summary: 'Admin: mark the goods as physically back',
  security: [{ adminBearer: [] }],
  request: returnNumberParam,
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(returnSchema), 'Return received'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/returns/{returnNumber}/inspect`,
  tags: ['Admin returns'],
  summary: 'Admin: record what was actually in the box',
  description:
    'Condition decides whether goods may be resold; `restock` decides whether they actually go ' +
    'back. BOTH must hold \u2014 a resellable but discontinued line can come back without re-entering stock.',
  security: [{ adminBearer: [] }],
  request: {
    ...returnNumberParam,
    body: { content: { 'application/json': { schema: returnInspectSchema } } },
  },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(returnSchema), 'Inspection recorded'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/returns/{returnNumber}/complete`,
  tags: ['Admin returns'],
  summary: 'Admin: close the return, restock and raise the refund',
  security: [{ adminBearer: [] }],
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(returnSchema), 'Return completed'),
  },
  request: returnNumberParam,
});

/* ------------------------------------------------------------ admin: refunds */

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/orders/{orderNumber}/refunds/preview`,
  tags: ['Admin refunds'],
  summary: 'Admin: what this refund would cost, and who pays it',
  description:
    'NO SIDE EFFECTS, and no amount is accepted: quantities in, money out. Shows the per-line ' +
    'maths and the reversal plan for every linked account before anything is committed.',
  security: [{ adminBearer: [] }],
  request: {
    ...orderNumberParam,
    body: { content: { 'application/json': { schema: refundPreviewSchema } } },
  },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(refundPreviewResponse), 'Refund preview'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/orders/{orderNumber}/refunds`,
  tags: ['Admin refunds'],
  summary: 'Admin: raise a refund (records it; moves no money)',
  description:
    'The amount is derived from the frozen order lines and FROZEN on the refund, so the figures ' +
    'an approver sees are the figures that will be paid.',
  security: [{ adminBearer: [] }],
  request: {
    ...orderNumberParam,
    body: { content: { 'application/json': { schema: refundRequestSchema } } },
  },
  responses: {
    ...commonErrorResponses,
    201: jsonContent(successBodySchema(anyObject), 'Refund requested'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/refunds/{id}/approve`,
  tags: ['Admin refunds'],
  summary: 'Admin: approve a refund',
  security: [{ adminBearer: [] }],
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: refundApproveSchema } } },
  },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(anyObject), 'Refund approved'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/refunds/{id}/execute`,
  tags: ['Admin refunds'],
  summary: 'Admin: send the refund to the provider',
  description:
    'Reserves the capacity, then calls the provider. A timeout is held as PENDING_VERIFICATION ' +
    'and can only be resolved by reconciliation \u2014 never retried from here.',
  security: [{ adminBearer: [] }],
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: refundExecuteSchema } } },
  },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(anyObject), 'Refund executed'),
  },
});

/* --------------------------------------------------------- customer surface */

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/me/orders/{orderNumber}/shipments`,
  tags: ['My orders'],
  summary: 'The shipment timeline for one of my orders',
  security: [{ customerBearer: [] }],
  request: orderNumberParam,
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Shipments'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/me/orders/{orderNumber}/returns`,
  tags: ['My orders'],
  summary: 'My return requests for an order',
  description:
    'FEATURE-FLAGGED (FEATURE_CUSTOMER_RETURNS, default off). Returns are normally raised by an ' +
    'admin on the customer\u2019s behalf; while the flag is off this answers 404.',
  security: [{ customerBearer: [] }],
  request: orderNumberParam,
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(returnSchema)), 'Return requests'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/me/orders/{orderNumber}/returnable`,
  tags: ['My orders'],
  summary: 'What can still be returned, and whether the window is open',
  description: 'FEATURE-FLAGGED (FEATURE_CUSTOMER_RETURNS, default off).',
  security: [{ customerBearer: [] }],
  request: orderNumberParam,
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(anyObject), 'Returnable quantities'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/me/orders/{orderNumber}/returns`,
  tags: ['My orders'],
  summary: 'Request a return',
  description: 'FEATURE-FLAGGED (FEATURE_CUSTOMER_RETURNS, default off).',
  security: [{ customerBearer: [] }],
  request: {
    ...orderNumberParam,
    body: { content: { 'application/json': { schema: returnCreateSchema.omit({ orderNumber: true }) } } },
  },
  responses: {
    ...commonErrorResponses,
    201: jsonContent(successBodySchema(returnSchema), 'Return requested'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/track/shipments/{awb}`,
  tags: ['Storefront'],
  summary: 'Public tracking by AWB',
  description: 'The timeline only \u2014 no address, no total, nothing that identifies the buyer.',
  request: { params: z.object({ awb: z.string() }) },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(anyObject), 'Tracking timeline'),
  },
});

/* ------------------------------------------------------------------ routes */

adminFulfilmentRouter.get(
  '/shipments',
  authenticate('ADMIN'),
  requirePermission('order.order.read'),
  validate({ query: adminShipmentListQuerySchema }),
  asyncHandler(adminShipmentController.list),
);

adminFulfilmentRouter.get(
  '/shipments/:shipmentNumber',
  authenticate('ADMIN'),
  requirePermission('order.order.read'),
  validate({ params: shipmentNumberParamSchema }),
  asyncHandler(adminShipmentController.detail),
);

adminFulfilmentRouter.get(
  '/orders/:orderNumber/shipments',
  authenticate('ADMIN'),
  requirePermission('order.order.read'),
  validate({ params: orderNumberParamSchema }),
  asyncHandler(adminShipmentController.forOrder),
);

adminFulfilmentRouter.post(
  '/orders/:orderNumber/shipments',
  ...adminGuard,
  requirePermission('order.order.fulfil'),
  idempotency('shipment-create'),
  validate({ params: orderNumberParamSchema, body: shipmentCreateSchema }),
  asyncHandler(adminShipmentController.create),
);

adminFulfilmentRouter.get(
  '/orders/:orderNumber/serviceability',
  authenticate('ADMIN'),
  requirePermission('order.order.fulfil'),
  validate({ params: orderNumberParamSchema, query: serviceabilityQuerySchema }),
  asyncHandler(adminShipmentController.serviceability),
);

adminFulfilmentRouter.post(
  '/shipments/:shipmentNumber/awb',
  ...adminGuard,
  requirePermission('order.order.fulfil'),
  idempotency('shipment-awb'),
  validate({ params: shipmentNumberParamSchema, body: assignAwbSchema }),
  asyncHandler(adminShipmentController.assignAwb),
);

adminFulfilmentRouter.post(
  '/shipments/:shipmentNumber/pickup',
  ...adminGuard,
  requirePermission('order.order.fulfil'),
  validate({ params: shipmentNumberParamSchema, body: schedulePickupSchema }),
  asyncHandler(adminShipmentController.schedulePickup),
);

adminFulfilmentRouter.post(
  '/shipments/:shipmentNumber/status',
  ...adminGuard,
  requirePermission('order.order.fulfil'),
  validate({ params: shipmentNumberParamSchema, body: shipmentStatusSchema }),
  asyncHandler(adminShipmentController.setStatus),
);

adminFulfilmentRouter.post(
  '/shipments/:shipmentNumber/sync',
  ...adminGuard,
  requirePermission('order.order.fulfil'),
  validate({ params: shipmentNumberParamSchema }),
  asyncHandler(adminShipmentController.sync),
);

adminFulfilmentRouter.post(
  '/shipments/:shipmentNumber/cancel',
  ...adminGuard,
  requirePermission('order.order.fulfil'),
  validate({ params: shipmentNumberParamSchema, body: shipmentCancelSchema }),
  asyncHandler(adminShipmentController.cancel),
);

adminFulfilmentRouter.get(
  '/ndr',
  authenticate('ADMIN'),
  requirePermission('order.order.read'),
  validate({ query: ndrListQuerySchema }),
  asyncHandler(adminNdrController.list),
);

adminFulfilmentRouter.post(
  '/ndr/:id/action',
  ...adminGuard,
  requirePermission('order.order.fulfil'),
  validate({ params: idParamSchema, body: ndrActionSchema }),
  asyncHandler(adminNdrController.act),
);

adminFulfilmentRouter.get(
  '/returns',
  authenticate('ADMIN'),
  requirePermission('order.order.read'),
  validate({ query: adminReturnListQuerySchema }),
  asyncHandler(adminReturnController.list),
);

adminFulfilmentRouter.get(
  '/returns/:returnNumber',
  authenticate('ADMIN'),
  requirePermission('order.order.read'),
  validate({ params: returnNumberParamSchema }),
  asyncHandler(adminReturnController.detail),
);

adminFulfilmentRouter.post(
  '/returns/:returnNumber/approve',
  ...adminGuard,
  requirePermission('order.order.update'),
  validate({ params: returnNumberParamSchema, body: returnApproveSchema }),
  asyncHandler(adminReturnController.approve),
);

adminFulfilmentRouter.post(
  '/returns/:returnNumber/reject',
  ...adminGuard,
  requirePermission('order.order.update'),
  validate({ params: returnNumberParamSchema, body: returnRejectSchema }),
  asyncHandler(adminReturnController.reject),
);

adminFulfilmentRouter.post(
  '/returns/:returnNumber/receive',
  ...adminGuard,
  requirePermission('order.order.update'),
  validate({ params: returnNumberParamSchema }),
  asyncHandler(adminReturnController.receive),
);

adminFulfilmentRouter.post(
  '/returns/:returnNumber/inspect',
  ...adminGuard,
  requirePermission('order.order.update'),
  validate({ params: returnNumberParamSchema, body: returnInspectSchema }),
  asyncHandler(adminReturnController.inspect),
);

adminFulfilmentRouter.post(
  '/returns/:returnNumber/complete',
  ...adminGuard,
  requirePermission('order.refund.create'),
  validate({ params: returnNumberParamSchema }),
  asyncHandler(adminReturnController.complete),
);

adminFulfilmentRouter.post(
  '/orders/:orderNumber/refunds/preview',
  ...adminGuard,
  requirePermission('order.refund.read'),
  validate({ params: orderNumberParamSchema, body: refundPreviewSchema }),
  asyncHandler(adminRefundController.preview),
);

adminFulfilmentRouter.post(
  '/orders/:orderNumber/refunds',
  ...adminGuard,
  requirePermission('order.refund.create'),
  idempotency('refund-request'),
  validate({ params: orderNumberParamSchema, body: refundRequestSchema }),
  asyncHandler(adminRefundController.request),
);

adminFulfilmentRouter.post(
  '/refunds/:id/approve',
  ...adminGuard,
  requirePermission('order.refund.approve'),
  validate({ params: idParamSchema, body: refundApproveSchema }),
  asyncHandler(adminRefundController.approve),
);

adminFulfilmentRouter.post(
  '/refunds/:id/execute',
  ...adminGuard,
  // Executing moves real money, so it needs the approval permission, not merely create.
  requirePermission('order.refund.approve'),
  idempotency('refund-execute'),
  validate({ params: idParamSchema, body: refundExecuteSchema }),
  asyncHandler(adminRefundController.execute),
);

/* ------------------------------------------------------ customer and public */

/**
 * Customer-initiated returns are FROZEN behind a flag, default off.
 *
 * Returns are an admin-operated process: a customer asks by phone or WhatsApp and an admin raises
 * it in the console. The endpoints below are built and tested, but until the flag is on they answer
 * 404 rather than 403 — the feature does not exist for customers, it is not merely forbidden to
 * them, and a 403 would tell them otherwise.
 *
 * The ADMIN return routes above are unaffected.
 */
const customerReturnsGate: RequestHandler = (_req, _res, next) => {
  if (!customerReturnsEnabled) {
    next(AppError.notFound('Route not found'));
    return;
  }

  next();
};

fulfilmentRouter.get(
  '/me/orders/:orderNumber/shipments',
  authenticate('CUSTOMER'),
  validate({ params: orderNumberParamSchema }),
  asyncHandler(customerFulfilmentController.shipments),
);

fulfilmentRouter.get(
  '/me/orders/:orderNumber/returns',
  customerReturnsGate,
  authenticate('CUSTOMER'),
  validate({ params: orderNumberParamSchema }),
  asyncHandler(customerFulfilmentController.returns),
);

fulfilmentRouter.get(
  '/me/orders/:orderNumber/returnable',
  customerReturnsGate,
  authenticate('CUSTOMER'),
  validate({ params: orderNumberParamSchema }),
  asyncHandler(customerFulfilmentController.returnable),
);

fulfilmentRouter.post(
  '/me/orders/:orderNumber/returns',
  customerReturnsGate,
  ...customerGuard,
  idempotency('return-create'),
  validate({
    params: orderNumberParamSchema,
    body: returnCreateSchema.omit({ orderNumber: true }),
  }),
  asyncHandler(customerFulfilmentController.requestReturn),
);

fulfilmentRouter.get(
  '/track/shipments/:awb',
  validate({ params: z.object({ awb: z.string().trim().min(3).max(60) }) }),
  asyncHandler(customerFulfilmentController.trackByAwb),
);
