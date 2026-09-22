import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import { idParamSchema } from '@shared/schemas/common';
import {
  addressCreateSchema,
  addressDefaultQuerySchema,
  addressUpdateSchema,
  adminCartListQuerySchema,
  cartAddItemSchema,
  cartCleanupSchema,
  cartCouponSchema,
  cartMergeSchema,
  cartPincodeSchema,
  cartReorderSchema,
  cartUpdateItemSchema,
  cartValidateQuerySchema,
  lineParamSchema,
  moveToWishlistSchema,
  pincodeParamLookupSchema,
  recentlyViewedQuerySchema,
  shareTokenParamSchema,
  wishlistAddItemSchema,
  wishlistCreateSchema,
  wishlistItemParamSchema,
  wishlistMoveToCartSchema,
  wishlistUpdateItemSchema,
  wishlistUpdateSchema,
} from '@shared/schemas/cart';

import {
  addressController,
  adminCartController,
  cartController,
  recentlyViewedController,
  wishlistController,
} from '../controllers/cart.controller';
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
 * Prompt 8 — cart, wishlist, addresses and recently-viewed.
 *
 * Everything customer-facing runs behind `optionalAuth('CUSTOMER')` so guests work end to end; the
 * `/me/*` routes additionally require a real customer. Mutations carry CSRF and are rate-limited.
 */

const ADMIN_PREFIX = `${API_PREFIX}/admin`;

const guestGuard = [optionalAuth('CUSTOMER'), csrfProtection('CUSTOMER')];
const customerGuard = [authenticate('CUSTOMER'), csrfProtection('CUSTOMER')];
const adminGuard = [authenticate('ADMIN'), csrfProtection('ADMIN')];

const unauthorised = { 401: jsonContent(errorBodySchema, 'Not authenticated') };
const forbidden = { 403: jsonContent(errorBodySchema, 'Missing permission or CSRF token') };
const notFoundResponse = { 404: jsonContent(errorBodySchema, 'No such record') };

export const cartRouter: Router = Router();
export const adminCartRouter: Router = Router();

/* ----------------------------------------------------------- OpenAPI docs */

const anyObject = z.record(z.any());

const cartSchema = registry.register(
  'Cart',
  z
    .object({
      id: z.string(),
      status: z.string(),
      isGuest: z.boolean(),
      itemCount: z.number().int(),
      quantityTotal: z.number().int(),
      lines: z.array(anyObject),
      savedForLater: z.array(anyObject),
      breakdown: anyObject.describe('The Prompt 6 PriceBreakdown, verbatim — the only money truth'),
      priceChanges: z.array(anyObject),
      issues: z.array(anyObject),
      isCheckoutReady: z.boolean(),
      blockingCount: z.number().int(),
      version: z.number().int(),
    })
    .passthrough(),
);

const cartSummarySchema = registry.register(
  'CartSummary',
  z.object({
    itemCount: z.number().int(),
    quantityTotal: z.number().int(),
    grandTotalPaise: z.number().int(),
    currency: z.literal('INR'),
  }),
);

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/cart`,
  tags: ['Cart'],
  summary: 'The cart, re-priced on every read',
  description:
    'The response always carries a freshly computed PriceBreakdown, the validation issues and a ' +
    '`priceChanges[]` array describing anything that moved since the line was added. The stored ' +
    'snapshots on a line are never displayed.',
  responses: {
    200: jsonContent(successBodySchema(cartSchema), 'Cart'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/cart/summary`,
  tags: ['Cart'],
  summary: 'Header badge counts',
  responses: {
    200: jsonContent(successBodySchema(cartSummarySchema), 'Summary'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/cart/items`,
  tags: ['Cart'],
  summary: 'Add a configured product to the cart',
  description:
    'Lines are keyed by a deterministic lineKey, so re-adding the same configuration increments ' +
    'the quantity. Supports `Idempotency-Key`. Adding NEVER reserves stock — that is Prompt 9.',
  request: { body: jsonContent(cartAddItemSchema, 'Item') },
  responses: {
    201: jsonContent(successBodySchema(cartSchema), 'Cart'),
    ...commonErrorResponses,
    422: jsonContent(errorBodySchema, 'VARIANT_NOT_RESOLVABLE or a cart limit'),
  },
});

registry.registerPath({
  method: 'patch',
  path: `${API_PREFIX}/cart/items/{lineId}`,
  tags: ['Cart'],
  summary: 'Change a line quantity or note',
  request: { params: lineParamSchema, body: jsonContent(cartUpdateItemSchema, 'Change') },
  responses: {
    200: jsonContent(successBodySchema(cartSchema), 'Cart'),
    409: jsonContent(errorBodySchema, 'CART_CONFLICT — the line changed in another tab'),
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'delete',
  path: `${API_PREFIX}/cart/items/{lineId}`,
  tags: ['Cart'],
  summary: 'Remove a line',
  request: { params: lineParamSchema },
  responses: {
    200: jsonContent(successBodySchema(cartSchema), 'Cart'),
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'put',
  path: `${API_PREFIX}/cart/pincode`,
  tags: ['Cart'],
  summary: 'Set the delivery pincode and get per-line ETA and COD',
  request: { body: jsonContent(cartPincodeSchema, 'Pincode') },
  responses: {
    200: jsonContent(successBodySchema(cartSchema), 'Cart'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/cart/coupon`,
  tags: ['Cart'],
  summary: 'Apply a coupon',
  description:
    'Delegates to the Prompt 6 discount service; an invalid code is returned with its specific ' +
    'rejection code and is never stored on the cart.',
  request: { body: jsonContent(cartCouponSchema, 'Code') },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Coupon outcome and the re-priced cart'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/cart/validate`,
  tags: ['Cart'],
  summary: 'Check the cart against stock, limits, serviceability and the coupon',
  request: { query: cartValidateQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Issues, checkout readiness and any auto-fixes'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/cart/merge`,
  tags: ['Cart'],
  summary: 'Fold the guest cart into the signed-in customer cart',
  description: 'Idempotent. The login and OTP-verify flows call the same service automatically.',
  request: { body: jsonContent(cartMergeSchema, 'Strategy') },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Merge report'),
    ...unauthorised,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/wishlists`,
  tags: ['Wishlist'],
  summary: 'Every list the caller owns (a default one is created on first use)',
  responses: {
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Wishlists'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/wishlists/shared/{token}`,
  tags: ['Wishlist'],
  summary: 'A publicly shared wishlist',
  description: 'Carries no customer identity — just the list name and its products.',
  request: { params: shareTokenParamSchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Shared wishlist'),
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/me/addresses`,
  tags: ['Address'],
  summary: 'The signed-in customer address book',
  security: [{ customerCookie: [] }],
  responses: {
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Addresses'),
    ...unauthorised,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/addresses/pincode/{pincode}`,
  tags: ['Address'],
  summary: 'Pincode autofill and serviceability',
  request: { params: pincodeParamLookupSchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'City, state and the delivery promise'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/me/recently-viewed`,
  tags: ['Cart'],
  summary: 'Recently viewed products, hydrated as product cards',
  request: { query: recentlyViewedQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Recently viewed'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/carts`,
  tags: ['Cart'],
  summary: 'Admin: browse carts, including abandoned ones',
  security: [{ adminCookie: [] }],
  request: { query: adminCartListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Carts (paginated)'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/carts/stats`,
  tags: ['Cart'],
  summary: 'Admin: abandonment rate, average value and the top abandoned products',
  security: [{ adminCookie: [] }],
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Stats'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/carts/{id}`,
  tags: ['Cart'],
  summary: 'Admin: one cart with its event timeline and a live re-quote',
  security: [{ adminCookie: [] }],
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Cart detail'),
    ...unauthorised,
    ...forbidden,
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/carts/cleanup`,
  tags: ['Cart'],
  summary: 'Admin: mark abandoned and expire stale carts',
  security: [{ adminCookie: [] }],
  request: { body: jsonContent(cartCleanupSchema, 'Thresholds') },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'How many moved'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/wishlists/stats`,
  tags: ['Wishlist'],
  summary: 'Admin: most-wishlisted products and price-drop candidates',
  security: [{ adminCookie: [] }],
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Stats'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

/* --------------------------------------------------------- public routes */

cartRouter.get('/cart', optionalAuth('CUSTOMER'), asyncHandler(cartController.get));
cartRouter.get('/cart/summary', optionalAuth('CUSTOMER'), asyncHandler(cartController.summary));

cartRouter.post(
  '/cart/items',
  ...guestGuard,
  authRateLimit('cart-write'),
  idempotency('cart-add-item'),
  validate({ body: cartAddItemSchema }),
  asyncHandler(cartController.addItem),
);

cartRouter.patch(
  '/cart/items/:lineId',
  ...guestGuard,
  validate({ params: lineParamSchema, body: cartUpdateItemSchema }),
  asyncHandler(cartController.updateItem),
);

cartRouter.delete(
  '/cart/items/:lineId',
  ...guestGuard,
  validate({ params: lineParamSchema }),
  asyncHandler(cartController.removeItem),
);

cartRouter.post(
  '/cart/items/:lineId/save-for-later',
  ...guestGuard,
  validate({ params: lineParamSchema }),
  asyncHandler(cartController.saveState('SAVED_FOR_LATER')),
);

cartRouter.post(
  '/cart/items/:lineId/move-to-cart',
  ...guestGuard,
  validate({ params: lineParamSchema }),
  asyncHandler(cartController.saveState('IN_CART')),
);

cartRouter.post(
  '/cart/items/:lineId/move-to-wishlist',
  ...guestGuard,
  validate({ params: lineParamSchema, body: moveToWishlistSchema }),
  asyncHandler(cartController.moveToWishlist),
);

cartRouter.post(
  '/cart/reorder',
  ...guestGuard,
  validate({ body: cartReorderSchema }),
  asyncHandler(cartController.reorder),
);

cartRouter.delete('/cart', ...guestGuard, asyncHandler(cartController.clear));

cartRouter.put(
  '/cart/pincode',
  ...guestGuard,
  validate({ body: cartPincodeSchema }),
  asyncHandler(cartController.setPincode),
);

cartRouter.post(
  '/cart/coupon',
  ...guestGuard,
  authRateLimit('cart-coupon'),
  validate({ body: cartCouponSchema }),
  asyncHandler(cartController.applyCoupon),
);

cartRouter.delete('/cart/coupon', ...guestGuard, asyncHandler(cartController.removeCoupon));

cartRouter.post(
  '/cart/validate',
  ...guestGuard,
  validate({ query: cartValidateQuerySchema }),
  asyncHandler(cartController.validate),
);

cartRouter.post(
  '/cart/merge',
  ...customerGuard,
  validate({ body: cartMergeSchema }),
  asyncHandler(cartController.merge),
);

/* wishlists */
cartRouter.get('/wishlists', optionalAuth('CUSTOMER'), asyncHandler(wishlistController.list));

cartRouter.get(
  '/wishlists/shared/:token',
  validate({ params: shareTokenParamSchema }),
  asyncHandler(wishlistController.shared),
);

cartRouter.post(
  '/wishlists',
  ...guestGuard,
  validate({ body: wishlistCreateSchema }),
  asyncHandler(wishlistController.create),
);

cartRouter.patch(
  '/wishlists/:id',
  ...guestGuard,
  validate({ params: idParamSchema, body: wishlistUpdateSchema }),
  asyncHandler(wishlistController.update),
);

cartRouter.delete(
  '/wishlists/:id',
  ...guestGuard,
  validate({ params: idParamSchema }),
  asyncHandler(wishlistController.remove),
);

cartRouter.post(
  '/wishlists/:id/items',
  ...guestGuard,
  validate({ params: idParamSchema, body: wishlistAddItemSchema }),
  asyncHandler(wishlistController.addItem),
);

cartRouter.patch(
  '/wishlists/:id/items/:itemId',
  ...guestGuard,
  validate({ params: wishlistItemParamSchema, body: wishlistUpdateItemSchema }),
  asyncHandler(wishlistController.updateItem),
);

cartRouter.delete(
  '/wishlists/:id/items/:itemId',
  ...guestGuard,
  validate({ params: wishlistItemParamSchema }),
  asyncHandler(wishlistController.removeItem),
);

cartRouter.post(
  '/wishlists/:id/items/:itemId/move-to-cart',
  ...guestGuard,
  validate({ params: wishlistItemParamSchema, body: wishlistMoveToCartSchema }),
  asyncHandler(wishlistController.moveToCart),
);

cartRouter.post(
  '/wishlists/:id/share',
  ...guestGuard,
  validate({ params: idParamSchema }),
  asyncHandler(wishlistController.share),
);

cartRouter.delete(
  '/wishlists/:id/share',
  ...guestGuard,
  validate({ params: idParamSchema }),
  asyncHandler(wishlistController.revokeShare),
);

/* addresses */
cartRouter.get('/me/addresses', authenticate('CUSTOMER'), asyncHandler(addressController.list));

cartRouter.get(
  '/me/addresses/:id',
  authenticate('CUSTOMER'),
  validate({ params: idParamSchema }),
  asyncHandler(addressController.get),
);

cartRouter.post(
  '/me/addresses',
  ...customerGuard,
  idempotency('address-create'),
  validate({ body: addressCreateSchema }),
  asyncHandler(addressController.create),
);

cartRouter.patch(
  '/me/addresses/:id',
  ...customerGuard,
  validate({ params: idParamSchema, body: addressUpdateSchema }),
  asyncHandler(addressController.update),
);

cartRouter.delete(
  '/me/addresses/:id',
  ...customerGuard,
  validate({ params: idParamSchema }),
  asyncHandler(addressController.remove),
);

cartRouter.post(
  '/me/addresses/:id/default',
  ...customerGuard,
  validate({ params: idParamSchema, query: addressDefaultQuerySchema }),
  asyncHandler(addressController.setDefault),
);

cartRouter.get(
  '/addresses/pincode/:pincode',
  authRateLimit('pincode-lookup'),
  validate({ params: pincodeParamLookupSchema }),
  asyncHandler(addressController.lookupPincode),
);

/* recently viewed */
cartRouter.get(
  '/me/recently-viewed',
  optionalAuth('CUSTOMER'),
  validate({ query: recentlyViewedQuerySchema }),
  asyncHandler(recentlyViewedController.list),
);

cartRouter.delete(
  '/me/recently-viewed',
  ...guestGuard,
  asyncHandler(recentlyViewedController.clear),
);

/* ---------------------------------------------------------- admin routes */

adminCartRouter.get(
  '/carts/stats',
  authenticate('ADMIN'),
  requirePermission('order.customer.read'),
  asyncHandler(adminCartController.stats),
);

adminCartRouter.get(
  '/carts',
  authenticate('ADMIN'),
  requirePermission('order.customer.read'),
  validate({ query: adminCartListQuerySchema }),
  asyncHandler(adminCartController.list),
);

adminCartRouter.post(
  '/carts/cleanup',
  ...adminGuard,
  requirePermission('order.customer.update'),
  validate({ body: cartCleanupSchema }),
  asyncHandler(adminCartController.cleanup),
);

adminCartRouter.get(
  '/carts/:id',
  authenticate('ADMIN'),
  requirePermission('order.customer.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminCartController.detail),
);

adminCartRouter.get(
  '/wishlists/stats',
  authenticate('ADMIN'),
  requirePermission('order.customer.read'),
  asyncHandler(adminCartController.wishlistStats),
);

adminCartRouter.get(
  '/customers/:id/cart',
  authenticate('ADMIN'),
  requirePermission('order.customer.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminCartController.customerCart),
);
