import type { Request, Response } from 'express';

import type { IdParam } from '@shared/schemas/common';
import type {
  AddressCreateInput,
  AddressDefaultQuery,
  AddressUpdateInput,
  AdminCartListQuery,
  CartAddItemInput,
  CartCouponInput,
  CartCleanupInput,
  CartMergeInput,
  CartPincodeInput,
  CartReorderInput,
  CartUpdateItemInput,
  CartValidateQuery,
  RecentlyViewedQuery,
  WishlistAddItemInput,
  WishlistCreateInput,
  WishlistMoveToCartInput,
  WishlistUpdateInput,
  WishlistUpdateItemInput,
} from '@shared/schemas/cart';

import { addressService } from '../modules/address/address.service';
import { cartAdminService } from '../modules/cart/cartAdmin.service';
import { cartExpiryService } from '../modules/cart/cartExpiry.service';
import { cartIdentity, type CartOwner } from '../modules/cart/cartIdentity';
import { cartMergeService } from '../modules/cart/cartMerge.service';
import { cartService } from '../modules/cart/cart.service';
import { cartValidationService } from '../modules/cart/cartValidation.service';
import { recentlyViewedService } from '../modules/cart/recentlyViewed.service';
import { wishlistService } from '../modules/wishlist/wishlist.service';
import type { CartWithItems } from '../repositories/cart.repository';
import { AppError } from '../utils/AppError';
import { ok, paginated } from '../utils/response';

/** R1 — thin: resolve the owner, call a service, answer through the one envelope. */

function customerIdOf(req: Request): string | null {
  return req.auth?.realm === 'CUSTOMER' ? req.auth.principalId : null;
}

function requireCustomer(req: Request): string {
  const customerId = customerIdOf(req);
  if (!customerId) throw new AppError(401, 'NOT_AUTHENTICATED', 'Sign in to continue');
  return customerId;
}

/** A write path may mint a guest session; the cookie is only persisted once something was stored. */
function ownerForWrite(req: Request, res: Response): CartOwner {
  const owner = cartIdentity.resolve(req);
  if (!owner.customerId) cartIdentity.persist(res, owner);
  return owner;
}

export const cartController = {
  /** A read never mints a cookie: a first-time visitor browsing away leaves no trace. */
  async get(req: Request, res: Response): Promise<void> {
    const owner = cartIdentity.resolveExisting(req);
    const cart = await cartService.find(owner);

    ok(res, await cartService.toDto(cart ?? emptyCart(owner), { customerId: owner.customerId }));
  },

  async summary(req: Request, res: Response): Promise<void> {
    const owner = cartIdentity.resolveExisting(req);
    ok(res, await cartService.summary(await cartService.find(owner)));
  },

  async addItem(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const cart = await cartService.getOrCreate(owner);
    const updated = await cartService.addItem(cart, req.body as CartAddItemInput);

    ok(res, await cartService.toDto(updated, { customerId: owner.customerId }), null, 201);
  },

  async updateItem(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const cart = await cartService.getOrCreate(owner);
    const { lineId } = req.params as { lineId: string };

    const updated = await cartService.updateItem(cart, lineId, req.body as CartUpdateItemInput);
    ok(res, await cartService.toDto(updated, { customerId: owner.customerId }));
  },

  async removeItem(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const cart = await cartService.getOrCreate(owner);
    const { lineId } = req.params as { lineId: string };

    const updated = await cartService.removeItem(cart, lineId);
    ok(res, await cartService.toDto(updated, { customerId: owner.customerId }));
  },

  saveState(saveState: 'IN_CART' | 'SAVED_FOR_LATER') {
    return async (req: Request, res: Response): Promise<void> => {
      const owner = ownerForWrite(req, res);
      const cart = await cartService.getOrCreate(owner);
      const { lineId } = req.params as { lineId: string };

      const updated = await cartService.setSaveState(cart, lineId, saveState);
      ok(res, await cartService.toDto(updated, { customerId: owner.customerId }));
    };
  },

  async moveToWishlist(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const cart = await cartService.getOrCreate(owner);
    const { lineId } = req.params as { lineId: string };

    const item = cart.items.find((line) => line.id === lineId);
    if (!item) throw AppError.notFound('That item is not in your cart', { lineId });

    const { wishlistId } = (req.body ?? {}) as { wishlistId?: string };

    await wishlistService.addItem(owner, wishlistId ?? null, {
      productId: item.productId,
      variantId: item.variantId,
      optionValueIds: [],
      priority: 'NORMAL',
    });

    const updated = await cartService.removeItem(cart, lineId);
    await cartService.reload(cart.id);

    ok(res, await cartService.toDto(updated, { customerId: owner.customerId }));
  },

  async reorder(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const cart = await cartService.getOrCreate(owner);

    const updated = await cartService.reorder(cart, (req.body as CartReorderInput).items);
    ok(res, await cartService.toDto(updated, { customerId: owner.customerId }));
  },

  async clear(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const cart = await cartService.getOrCreate(owner);

    const updated = await cartService.clear(cart);
    ok(res, await cartService.toDto(updated, { customerId: owner.customerId }));
  },

  async setPincode(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const cart = await cartService.getOrCreate(owner);

    const updated = await cartService.setPincode(cart, (req.body as CartPincodeInput).pincode);
    ok(res, await cartService.toDto(updated, { customerId: owner.customerId }));
  },

  async applyCoupon(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const cart = await cartService.getOrCreate(owner);

    const outcome = await cartService.applyCoupon(cart, (req.body as CartCouponInput).code);
    const updated = await cartService.reload(cart.id);

    // One envelope everywhere: a rejection rides on the cart's own `coupon` field.
    ok(res, await cartService.toDto(updated, { customerId: owner.customerId, coupon: outcome }));
  },

  async removeCoupon(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const cart = await cartService.getOrCreate(owner);

    const updated = await cartService.removeCoupon(cart);
    ok(res, await cartService.toDto(updated, { customerId: owner.customerId }));
  },

  async validate(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const cart = await cartService.getOrCreate(owner);
    const { autoFix } = req.query as unknown as CartValidateQuery;

    const result = await cartValidationService.validate(cart, {
      autoFix,
      customerId: owner.customerId,
    });

    ok(res, result);
  },

  /** Explicit merge. The login flow calls the same service automatically. */
  async merge(req: Request, res: Response): Promise<void> {
    const customerId = requireCustomer(req);
    const guest = cartIdentity.resolveExisting({ ...req, auth: undefined } as Request);
    const { strategy } = req.body as CartMergeInput;

    const report = await cartMergeService.mergeGuestIntoCustomer(
      guest.sessionId,
      customerId,
      strategy,
    );

    // The guest cookie has served its purpose; keeping it would resurrect an empty guest cart.
    if (report.merged) cartIdentity.clear(res);

    ok(res, report);
  },
};

export const wishlistController = {
  async list(req: Request, res: Response): Promise<void> {
    ok(res, await wishlistService.list(ownerForWrite(req, res)));
  },

  async create(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    ok(res, await wishlistService.create(owner, req.body as WishlistCreateInput), null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const { id } = req.params as unknown as IdParam;
    ok(res, await wishlistService.update(owner, id, req.body as WishlistUpdateInput));
  },

  async remove(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const { id } = req.params as unknown as IdParam;
    await wishlistService.remove(owner, id);
    ok(res, { deleted: true });
  },

  async addItem(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const { id } = req.params as unknown as IdParam;
    ok(res, await wishlistService.addItem(owner, id, req.body as WishlistAddItemInput), null, 201);
  },

  async updateItem(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const { id, itemId } = req.params as { id: string; itemId: string };
    ok(
      res,
      await wishlistService.updateItem(owner, id, itemId, req.body as WishlistUpdateItemInput),
    );
  },

  async removeItem(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const { id, itemId } = req.params as { id: string; itemId: string };
    ok(res, await wishlistService.removeItem(owner, id, itemId));
  },

  async moveToCart(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const { id, itemId } = req.params as { id: string; itemId: string };
    ok(
      res,
      await wishlistService.moveToCart(owner, id, itemId, req.body as WishlistMoveToCartInput),
    );
  },

  async share(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const { id } = req.params as unknown as IdParam;
    ok(res, await wishlistService.share(owner, id));
  },

  async revokeShare(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const { id } = req.params as unknown as IdParam;
    await wishlistService.revokeShare(owner, id);
    ok(res, { revoked: true });
  },

  async shared(req: Request, res: Response): Promise<void> {
    const { token } = req.params as { token: string };
    ok(res, await wishlistService.bySharedToken(token));
  },
};

export const addressController = {
  async list(req: Request, res: Response): Promise<void> {
    ok(res, await addressService.list(requireCustomer(req)));
  },

  async get(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await addressService.get(requireCustomer(req), id));
  },

  async create(req: Request, res: Response): Promise<void> {
    ok(
      res,
      await addressService.create(requireCustomer(req), req.body as AddressCreateInput),
      null,
      201,
    );
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await addressService.update(requireCustomer(req), id, req.body as AddressUpdateInput));
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await addressService.remove(requireCustomer(req), id);
    ok(res, { deleted: true });
  },

  async setDefault(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const { usage } = req.query as unknown as AddressDefaultQuery;
    ok(res, await addressService.setDefault(requireCustomer(req), id, usage));
  },

  async lookupPincode(req: Request, res: Response): Promise<void> {
    const { pincode } = req.params as { pincode: string };
    ok(res, await addressService.lookupPincode(pincode));
  },
};

export const recentlyViewedController = {
  async list(req: Request, res: Response): Promise<void> {
    const owner = cartIdentity.resolveExisting(req);
    const { limit } = req.query as unknown as RecentlyViewedQuery;
    ok(res, await recentlyViewedService.list(owner, limit));
  },

  async clear(req: Request, res: Response): Promise<void> {
    const owner = cartIdentity.resolveExisting(req);
    ok(res, { cleared: await recentlyViewedService.clear(owner) });
  },

  /** Called by the PDP beacon; records against whoever is browsing, guest or customer. */
  async record(req: Request, res: Response): Promise<void> {
    const owner = ownerForWrite(req, res);
    const { productId, variantId } = req.body as { productId: string; variantId?: string | null };

    await recentlyViewedService.record(owner, productId, variantId ?? null);
    ok(res, { recorded: true }, null, 202);
  },
};

export const adminCartController = {
  async list(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as AdminCartListQuery;
    const page = await cartAdminService.list(query);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async stats(_req: Request, res: Response): Promise<void> {
    ok(res, await cartAdminService.stats());
  },

  async detail(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await cartAdminService.detail(id));
  },

  async cleanup(req: Request, res: Response): Promise<void> {
    ok(res, await cartExpiryService.cleanup(req.body as CartCleanupInput));
  },

  async wishlistStats(_req: Request, res: Response): Promise<void> {
    ok(res, await cartAdminService.wishlistStats());
  },

  async customerCart(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await cartAdminService.forCustomer(id));
  },
};

/** The shape a visitor who has never written anything sees. Nothing is persisted for them. */
function emptyCart(owner: CartOwner): CartWithItems {
  const now = new Date();

  return {
    id: 'anonymous',
    customerId: owner.customerId,
    sessionId: owner.sessionId,
    status: 'ACTIVE',
    activeOwnerKey: null,
    channel: 'WEB',
    currency: 'INR',
    couponCode: null,
    pincode: null,
    customerGroupIdSnapshot: null,
    itemCount: 0,
    quantityTotal: 0,
    lastQuotedTotalPaise: null,
    lastQuoteContextHash: null,
    lastQuotedAt: null,
    lastActivityAt: now,
    expiresAt: null,
    mergedIntoCartId: null,
    convertedOrderId: null,
    notesJson: null,
    version: 0,
    createdAt: now,
    updatedAt: now,
    items: [],
  };
}
