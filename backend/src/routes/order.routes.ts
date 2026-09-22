import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import { idParamSchema } from '@shared/schemas/common';
import {
  adminOrderListQuerySchema,
  adminOrderStatusSchema,
  checkoutInitSchema,
  checkoutPatchSchema,
  checkoutSessionParamSchema,
  myOrderListQuerySchema,
  orderCancelSchema,
  orderNumberParamSchema,
  orderTrackSchema,
  paymentSettingsSchema,
  placeOrderSchema,
  reconcileSchema,
  splitAccountCreateSchema,
  splitAccountUpdateSchema,
  splitRuleCreateSchema,
  splitRuleListQuerySchema,
  splitRuleUpdateSchema,
  splitSimulateSchema,
  verifyPaymentSchema,
  webhookListQuerySchema,
} from '@shared/schemas/order';

import {
  adminOrderController,
  adminPaymentController,
  checkoutController,
  orderController,
  webhookController,
} from '../controllers/order.controller';
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
import { csrfProtection } from '../modules/auth/csrf.service';

/**
 * Prompt 9A — checkout, orders, payments and the Route split.
 *
 * Guests check out too, so the customer-facing routes run behind `optionalAuth('CUSTOMER')`; the
 * `/me/*` routes additionally require a real session. The webhook route is signature-authenticated
 * only and is mounted on its own router so it can keep the RAW body.
 */

const ADMIN_PREFIX = `${API_PREFIX}/admin`;

const guestGuard = [optionalAuth('CUSTOMER'), csrfProtection('CUSTOMER')];
const customerGuard = [authenticate('CUSTOMER'), csrfProtection('CUSTOMER')];
const adminGuard = [authenticate('ADMIN'), csrfProtection('ADMIN')];

export const checkoutRouter: Router = Router();
export const webhookRouter: Router = Router();
export const adminOrderRouter: Router = Router();

/* ----------------------------------------------------------- OpenAPI docs */

const anyObject = z.record(z.any());

const checkoutSessionSchema = registry.register(
  'CheckoutSession',
  z
    .object({
      id: z.string(),
      step: z.string(),
      breakdown: anyObject.describe('A live quote — frozen onto the order only at placement'),
      quotedTotalPaise: z.number().int(),
      priceChanged: z
        .boolean()
        .describe('True when the live quote no longer matches the agreed one'),
      methods: z.array(anyObject),
      issues: z.array(anyObject),
      isCheckoutReady: z.boolean(),
      codAvailable: z.boolean(),
      expiresAt: z.string(),
    })
    .passthrough(),
);

const orderSchema = registry.register(
  'Order',
  z
    .object({
      id: z.string(),
      orderNumber: z.string().openapi({ example: 'CW/2026-27/000001' }),
      status: z.string(),
      paymentStatus: z.string(),
      grandTotalPaise: z.number().int(),
      breakdown: anyObject.describe('The frozen PriceBreakdown — replayed, never re-quoted'),
      items: z.array(anyObject),
    })
    .passthrough(),
);

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/checkout/init`,
  tags: ['Checkout'],
  summary: 'Open a checkout for the current cart',
  description:
    'Validates the cart with autoFix disabled and refuses on any BLOCKING issue, resolves and ' +
    'snapshots the addresses, checks serviceability, then quotes the cart and remembers the hash ' +
    'of that quote. NO AMOUNT IS ACCEPTED — every paise is computed server-side.',
  request: { body: { content: { 'application/json': { schema: checkoutInitSchema } } } },
  responses: {
    201: jsonContent(successBodySchema(checkoutSessionSchema), 'Checkout session'),
    ...commonErrorResponses,
    422: jsonContent(errorBodySchema, 'CART_NOT_CHECKOUT_READY or NOT_SERVICEABLE'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/checkout/{sessionId}`,
  tags: ['Checkout'],
  summary: 'The session, re-quoted (flags priceChanged)',
  request: { params: checkoutSessionParamSchema },
  responses: {
    200: jsonContent(successBodySchema(checkoutSessionSchema), 'Checkout session'),
    404: jsonContent(errorBodySchema, 'No such session'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'patch',
  path: `${API_PREFIX}/checkout/{sessionId}`,
  tags: ['Checkout'],
  summary: 'Change the address, contact or payment method and re-quote',
  request: {
    params: checkoutSessionParamSchema,
    body: { content: { 'application/json': { schema: checkoutPatchSchema } } },
  },
  responses: {
    200: jsonContent(successBodySchema(checkoutSessionSchema), 'Checkout session'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/checkout/{sessionId}/place`,
  tags: ['Checkout'],
  summary: 'Create the order and the provider order',
  description:
    'Re-quotes and compares with the agreed hash; a difference is a 409 PRICE_CHANGED carrying ' +
    'the new breakdown rather than a silent charge. On success the order, its items, its address ' +
    'snapshots, its stock reservations and its split allocations are written in one transaction.',
  request: {
    params: checkoutSessionParamSchema,
    body: { content: { 'application/json': { schema: placeOrderSchema } } },
  },
  responses: {
    201: jsonContent(successBodySchema(anyObject), 'Order created'),
    409: jsonContent(errorBodySchema, 'PRICE_CHANGED'),
    ...commonErrorResponses,
    422: jsonContent(errorBodySchema, 'CART_NOT_CHECKOUT_READY, COD_LIMIT_EXCEEDED'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/checkout/verify`,
  tags: ['Checkout'],
  summary: 'Verify a completed payment signature',
  description:
    'The optimistic path. Constant-time HMAC verification; idempotent, so it is a happy no-op if ' +
    'the webhook confirmed the order first.',
  request: { body: { content: { 'application/json': { schema: verifyPaymentSchema } } } },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Verification result'),
    400: jsonContent(errorBodySchema, 'INVALID_PAYMENT_SIGNATURE'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/checkout/{sessionId}/abandon`,
  tags: ['Checkout'],
  summary: 'Give up a checkout and release every hold',
  request: { params: checkoutSessionParamSchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Released'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/me/orders`,
  tags: ['Orders'],
  summary: 'The signed-in customer’s orders',
  request: { query: myOrderListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Orders'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/me/orders/{orderNumber}`,
  tags: ['Orders'],
  summary: 'One order, rendered from its frozen snapshot',
  request: { params: orderNumberParamSchema },
  responses: {
    200: jsonContent(successBodySchema(orderSchema), 'Order'),
    404: jsonContent(errorBodySchema, 'Not found — including somebody else’s order'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/me/orders/{orderNumber}/timeline`,
  tags: ['Orders'],
  summary: 'Customer-visible status history',
  request: { params: orderNumberParamSchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Timeline'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/me/orders/{orderNumber}/cancel`,
  tags: ['Orders'],
  summary: 'Cancel an order and release its holds',
  description:
    'Allowed only in PENDING_PAYMENT, CONFIRMED or PROCESSING. A paid order also gets a Refund ' +
    'row in REQUESTED; executing that refund is Prompt 9B.',
  request: {
    params: orderNumberParamSchema,
    body: { content: { 'application/json': { schema: orderCancelSchema } } },
  },
  responses: {
    200: jsonContent(successBodySchema(orderSchema), 'Cancelled order'),
    409: jsonContent(errorBodySchema, 'ORDER_NOT_CANCELLABLE'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/orders/track`,
  tags: ['Orders'],
  summary: 'Public order tracking',
  description:
    'An order number plus the email or phone on the order. Returns a status, an ETA and a city — ' +
    'never an address, a breakdown or a contact detail. A wrong contact answers the same 404 as a ' +
    'number that does not exist.',
  request: { body: { content: { 'application/json': { schema: orderTrackSchema } } } },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Tracking'),
    404: jsonContent(errorBodySchema, 'No order matches those details'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/webhooks/razorpay',
  tags: ['Payments'],
  summary: 'Razorpay webhook (signature-authenticated, raw body)',
  description:
    'The source of truth. The HMAC is verified over the raw body BEFORE parsing; the event is ' +
    'persisted before it is acted on; a duplicate event id is recorded and ignored. A validly ' +
    'signed event always answers 200 — processing failures are surfaced as status FAILED and ' +
    'replayed from the admin rather than by making the provider retry.',
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Accepted'),
    400: jsonContent(errorBodySchema, 'INVALID_WEBHOOK_SIGNATURE'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/orders`,
  tags: ['Orders'],
  summary: 'Admin: browse orders',
  request: { query: adminOrderListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Orders'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/orders/{id}`,
  tags: ['Orders'],
  summary: 'Admin: one order with payments, transfers, allocations and the ledger check',
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Order detail'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/orders/{id}/status`,
  tags: ['Orders'],
  summary: 'Admin: a guarded status transition',
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: adminOrderStatusSchema } } },
  },
  responses: {
    200: jsonContent(successBodySchema(orderSchema), 'Order'),
    409: jsonContent(errorBodySchema, 'INVALID_ORDER_TRANSITION'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/orders/{id}/cancel`,
  tags: ['Orders'],
  summary: 'Admin: cancel an order',
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: orderCancelSchema } } },
  },
  responses: {
    200: jsonContent(successBodySchema(orderSchema), 'Order'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/orders/{id}/split-preview`,
  tags: ['Payments'],
  summary: 'Admin: what the split would allocate for this order',
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Allocation preview'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/orders/{id}/retry-transfers`,
  tags: ['Payments'],
  summary: 'Admin: retry only the failed payout legs',
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Retry result'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/orders/{id}/ledger-check`,
  tags: ['Payments'],
  summary: 'Admin: does this order’s money balance?',
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Ledger report'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/orders/reconcile`,
  tags: ['Payments'],
  summary: 'Admin: run the reconciliation sweep',
  request: { body: { content: { 'application/json': { schema: reconcileSchema } } } },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Reconciliation report'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/payments/split-rules`,
  tags: ['Payments'],
  summary: 'Admin: split rules',
  request: { query: splitRuleListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Split rules'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/payments/split-rules`,
  tags: ['Payments'],
  summary: 'Admin: create a split rule',
  request: { body: { content: { 'application/json': { schema: splitRuleCreateSchema } } } },
  responses: {
    201: jsonContent(successBodySchema(anyObject), 'Split rule'),
    409: jsonContent(errorBodySchema, 'DUPLICATE_REMAINDER_RULE'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'patch',
  path: `${ADMIN_PREFIX}/payments/split-rules/{id}`,
  tags: ['Payments'],
  summary: 'Admin: update a split rule',
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: splitRuleUpdateSchema } } },
  },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Split rule'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'delete',
  path: `${ADMIN_PREFIX}/payments/split-rules/{id}`,
  tags: ['Payments'],
  summary: 'Admin: delete a split rule',
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Deleted'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/payments/split-accounts`,
  tags: ['Payments'],
  summary: 'Admin: payout accounts',
  responses: {
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Split accounts'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/payments/split-accounts`,
  tags: ['Payments'],
  summary: 'Admin: add a payout account',
  request: { body: { content: { 'application/json': { schema: splitAccountCreateSchema } } } },
  responses: {
    201: jsonContent(successBodySchema(anyObject), 'Split account'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'patch',
  path: `${ADMIN_PREFIX}/payments/split-accounts/{id}`,
  tags: ['Payments'],
  summary: 'Admin: update a payout account',
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: splitAccountUpdateSchema } } },
  },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Split account'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/payments/split-simulate`,
  tags: ['Payments'],
  summary: 'Admin: what would ₹x split into?',
  request: { body: { content: { 'application/json': { schema: splitSimulateSchema } } } },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Allocation preview'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/payments/attention`,
  tags: ['Admin payments'],
  summary: 'Admin: refunds and reversals that need an operator decision',
  security: [{ adminBearer: [] }],
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(anyObject), 'Needs-attention queue'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/payments/settings`,
  tags: ['Payments'],
  summary: 'Admin: payment settings',
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Payment settings'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'put',
  path: `${ADMIN_PREFIX}/payments/settings`,
  tags: ['Payments'],
  summary: 'Admin: update payment settings',
  request: { body: { content: { 'application/json': { schema: paymentSettingsSchema } } } },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Payment settings'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/webhooks`,
  tags: ['Payments'],
  summary: 'Admin: stored provider events',
  request: { query: webhookListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Webhook events'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/webhooks/{id}/replay`,
  tags: ['Payments'],
  summary: 'Admin: re-process a stored event',
  description: 'Idempotent by construction — replaying a processed event changes nothing.',
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Replay result'),
    ...commonErrorResponses,
  },
});

/* ------------------------------------------------------------ customer */

checkoutRouter.post(
  '/checkout/init',
  ...guestGuard,
  authRateLimit('checkout'),
  validate({ body: checkoutInitSchema }),
  asyncHandler(checkoutController.init),
);

checkoutRouter.get(
  '/checkout/:sessionId',
  optionalAuth('CUSTOMER'),
  validate({ params: checkoutSessionParamSchema }),
  asyncHandler(checkoutController.get),
);

checkoutRouter.patch(
  '/checkout/:sessionId',
  ...guestGuard,
  validate({ params: checkoutSessionParamSchema, body: checkoutPatchSchema }),
  asyncHandler(checkoutController.patch),
);

checkoutRouter.post(
  '/checkout/:sessionId/place',
  ...guestGuard,
  authRateLimit('checkout-place'),
  idempotency('checkout-place'),
  validate({ params: checkoutSessionParamSchema, body: placeOrderSchema }),
  asyncHandler(checkoutController.place),
);

checkoutRouter.post(
  '/checkout/verify',
  ...guestGuard,
  authRateLimit('checkout-verify'),
  validate({ body: verifyPaymentSchema }),
  asyncHandler(checkoutController.verify),
);

checkoutRouter.post(
  '/checkout/:sessionId/abandon',
  ...guestGuard,
  validate({ params: checkoutSessionParamSchema }),
  asyncHandler(checkoutController.abandon),
);

checkoutRouter.get(
  '/me/orders',
  authenticate('CUSTOMER'),
  validate({ query: myOrderListQuerySchema }),
  asyncHandler(orderController.list),
);

checkoutRouter.get(
  '/me/orders/:orderNumber',
  authenticate('CUSTOMER'),
  validate({ params: orderNumberParamSchema }),
  asyncHandler(orderController.get),
);

checkoutRouter.get(
  '/me/orders/:orderNumber/timeline',
  authenticate('CUSTOMER'),
  validate({ params: orderNumberParamSchema }),
  asyncHandler(orderController.timeline),
);

checkoutRouter.post(
  '/me/orders/:orderNumber/cancel',
  ...customerGuard,
  validate({ params: orderNumberParamSchema, body: orderCancelSchema }),
  asyncHandler(orderController.cancel),
);

// Hard rate-limited on purpose: this is the one endpoint that takes an order number from anybody.
checkoutRouter.post(
  '/orders/track',
  authRateLimit('order-track'),
  validate({ body: orderTrackSchema }),
  asyncHandler(orderController.track),
);

/* ------------------------------------------------------------- webhook */

webhookRouter.post('/razorpay', asyncHandler(webhookController.razorpay));

/* --------------------------------------------------------------- admin */

adminOrderRouter.get(
  '/orders',
  authenticate('ADMIN'),
  requirePermission('order.order.read'),
  validate({ query: adminOrderListQuerySchema }),
  asyncHandler(adminOrderController.list),
);

adminOrderRouter.post(
  '/orders/reconcile',
  ...adminGuard,
  requirePermission('order.order.update'),
  validate({ body: reconcileSchema }),
  asyncHandler(adminOrderController.reconcile),
);

adminOrderRouter.get(
  '/orders/:id',
  authenticate('ADMIN'),
  requirePermission('order.order.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminOrderController.detail),
);

adminOrderRouter.post(
  '/orders/:id/status',
  ...adminGuard,
  requirePermission('order.order.update'),
  validate({ params: idParamSchema, body: adminOrderStatusSchema }),
  asyncHandler(adminOrderController.setStatus),
);

adminOrderRouter.post(
  '/orders/:id/cancel',
  ...adminGuard,
  requirePermission('order.order.cancel'),
  validate({ params: idParamSchema, body: orderCancelSchema }),
  asyncHandler(adminOrderController.cancel),
);

adminOrderRouter.get(
  '/orders/:id/split-preview',
  authenticate('ADMIN'),
  requirePermission('payment.split.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminOrderController.splitPreview),
);

adminOrderRouter.post(
  '/orders/:id/retry-transfers',
  ...adminGuard,
  requirePermission('payment.split.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminOrderController.retryTransfers),
);

adminOrderRouter.get(
  '/orders/:id/ledger-check',
  authenticate('ADMIN'),
  requirePermission('order.order.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminOrderController.ledgerCheck),
);

adminOrderRouter.get(
  '/payments/split-rules',
  authenticate('ADMIN'),
  requirePermission('payment.split.read'),
  validate({ query: splitRuleListQuerySchema }),
  asyncHandler(adminPaymentController.listRules),
);

adminOrderRouter.post(
  '/payments/split-rules',
  ...adminGuard,
  requirePermission('payment.split.update'),
  validate({ body: splitRuleCreateSchema }),
  asyncHandler(adminPaymentController.createRule),
);

adminOrderRouter.patch(
  '/payments/split-rules/:id',
  ...adminGuard,
  requirePermission('payment.split.update'),
  validate({ params: idParamSchema, body: splitRuleUpdateSchema }),
  asyncHandler(adminPaymentController.updateRule),
);

adminOrderRouter.delete(
  '/payments/split-rules/:id',
  ...adminGuard,
  requirePermission('payment.split.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminPaymentController.deleteRule),
);

adminOrderRouter.get(
  '/payments/split-accounts',
  authenticate('ADMIN'),
  requirePermission('payment.settings.read'),
  asyncHandler(adminPaymentController.listAccounts),
);

adminOrderRouter.post(
  '/payments/split-accounts',
  ...adminGuard,
  requirePermission('payment.settings.update'),
  validate({ body: splitAccountCreateSchema }),
  asyncHandler(adminPaymentController.createAccount),
);

adminOrderRouter.patch(
  '/payments/split-accounts/:id',
  ...adminGuard,
  requirePermission('payment.settings.update'),
  validate({ params: idParamSchema, body: splitAccountUpdateSchema }),
  asyncHandler(adminPaymentController.updateAccount),
);

adminOrderRouter.post(
  '/payments/split-simulate',
  ...adminGuard,
  requirePermission('payment.split.read'),
  validate({ body: splitSimulateSchema }),
  asyncHandler(adminPaymentController.simulate),
);

adminOrderRouter.get(
  '/payments/settings',
  authenticate('ADMIN'),
  requirePermission('payment.settings.read'),
  asyncHandler(adminPaymentController.readSettings),
);

adminOrderRouter.get(
  '/payments/attention',
  authenticate('ADMIN'),
  requirePermission('order.refund.read'),
  asyncHandler(adminPaymentController.attention),
);

adminOrderRouter.put(
  '/payments/settings',
  ...adminGuard,
  requirePermission('payment.settings.update'),
  validate({ body: paymentSettingsSchema }),
  asyncHandler(adminPaymentController.updateSettings),
);

adminOrderRouter.get(
  '/webhooks',
  authenticate('ADMIN'),
  requirePermission('order.order.read'),
  validate({ query: webhookListQuerySchema }),
  asyncHandler(adminPaymentController.listWebhooks),
);

adminOrderRouter.post(
  '/webhooks/:id/replay',
  ...adminGuard,
  requirePermission('order.order.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminPaymentController.replayWebhook),
);
