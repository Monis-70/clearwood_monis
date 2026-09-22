import type { Address, Cart, CartItem, Prisma, RecentlyViewed } from '@prisma/client';

import type { CartStatus } from '@shared/enums';
import type { AdminCartListQuery } from '@shared/schemas/cart';

import { prisma } from '../config/prisma';

import { notDeleted, orderBy, pageResult, skipTake, type PageResult } from './helpers';

/** R1 — Prompt 8 reaches Prisma only through this file. */

const withItems = {
  items: { orderBy: [{ position: 'asc' as const }, { createdAt: 'asc' as const }] },
} satisfies Prisma.CartInclude;

export type CartWithItems = Prisma.CartGetPayload<{ include: typeof withItems }>;

const ADMIN_SORTABLE = [
  'lastActivityAt',
  'createdAt',
  'lastQuotedTotalPaise',
  'itemCount',
  'quantityTotal',
] as const;

export const cartRepository = {
  findActiveByOwnerKey(activeOwnerKey: string): Promise<CartWithItems | null> {
    return prisma.cart.findFirst({ where: { activeOwnerKey }, include: withItems });
  },

  findById(id: string): Promise<CartWithItems | null> {
    return prisma.cart.findUnique({ where: { id }, include: withItems });
  },

  /**
   * Relies on the unique index over `activeOwnerKey`: two concurrent first requests both try to
   * insert, exactly one wins, and the loser is told so via P2002 rather than creating a twin.
   */
  create(data: {
    customerId: string | null;
    sessionId: string | null;
    activeOwnerKey: string;
    channel: string;
    expiresAt: Date;
  }): Promise<CartWithItems> {
    return prisma.cart.create({
      data: { ...data, status: 'ACTIVE', lastActivityAt: new Date() },
      include: withItems,
    });
  },

  /** Compare-and-set on `version`; zero rows means somebody else moved first. */
  async updateVersioned(
    id: string,
    expectedVersion: number,
    data: Prisma.CartUpdateInput,
  ): Promise<boolean> {
    const { count } = await prisma.cart.updateMany({
      where: { id, version: expectedVersion },
      data: { ...data, version: { increment: 1 }, lastActivityAt: new Date() },
    });
    return count > 0;
  },

  async touch(id: string, data: Prisma.CartUpdateInput = {}): Promise<void> {
    await prisma.cart.update({
      where: { id },
      data: { ...data, lastActivityAt: new Date() },
    });
  },

  async setStatus(
    id: string,
    status: CartStatus,
    extra: Prisma.CartUpdateInput = {},
  ): Promise<void> {
    await prisma.cart.update({
      where: { id },
      // Releasing `activeOwnerKey` is what lets the owner start a new cart afterwards.
      data: { status, activeOwnerKey: null, ...extra },
    });
  },

  async recount(id: string): Promise<{ itemCount: number; quantityTotal: number }> {
    const items = await prisma.cartItem.findMany({
      where: { cartId: id, saveState: 'IN_CART' },
      select: { qty: true },
    });

    const counts = {
      itemCount: items.length,
      quantityTotal: items.reduce((total, item) => total + item.qty, 0),
    };

    await prisma.cart.update({ where: { id }, data: counts });
    return counts;
  },

  findItem(cartId: string, lineId: string): Promise<CartItem | null> {
    return prisma.cartItem.findFirst({ where: { id: lineId, cartId } });
  },

  findItemByKey(cartId: string, lineKey: string): Promise<CartItem | null> {
    return prisma.cartItem.findUnique({ where: { cartId_lineKey: { cartId, lineKey } } });
  },

  /**
   * The atomic add. `upsert` on `(cartId, lineKey)` plus an `increment` is what makes ten parallel
   * adds of the same configuration produce one line with qty 10 instead of ten lines.
   */
  upsertItem(
    cartId: string,
    lineKey: string,
    create: Omit<Prisma.CartItemUncheckedCreateInput, 'cartId' | 'lineKey'>,
    incrementBy: number,
    maxQty: number,
  ): Promise<CartItem> {
    return prisma.cartItem
      .upsert({
        where: { cartId_lineKey: { cartId, lineKey } },
        create: { cartId, lineKey, ...create },
        update: {
          qty: { increment: incrementBy },
          saveState: 'IN_CART',
          ...(create.note === undefined ? {} : { note: create.note }),
        },
      })
      .then(async (item) => {
        if (item.qty <= maxQty) return item;
        return prisma.cartItem.update({ where: { id: item.id }, data: { qty: maxQty } });
      });
  },

  updateItem(id: string, data: Prisma.CartItemUpdateInput): Promise<CartItem> {
    return prisma.cartItem.update({ where: { id }, data });
  },

  /** Compare-and-set on qty so two tabs cannot silently lose one another's update. */
  async updateItemQty(id: string, expectedQty: number, nextQty: number): Promise<boolean> {
    const { count } = await prisma.cartItem.updateMany({
      where: { id, qty: expectedQty },
      data: { qty: nextQty },
    });
    return count > 0;
  },

  async removeItem(id: string): Promise<void> {
    await prisma.cartItem.delete({ where: { id } });
  },

  async removeAllItems(cartId: string): Promise<number> {
    const { count } = await prisma.cartItem.deleteMany({ where: { cartId } });
    return count;
  },

  async reposition(cartId: string, items: { lineId: string; position: number }[]): Promise<number> {
    await prisma.$transaction(
      items.map((item) =>
        prisma.cartItem.updateMany({
          where: { id: item.lineId, cartId },
          data: { position: item.position },
        }),
      ),
    );
    return items.length;
  },

  async maxPosition(cartId: string): Promise<number> {
    const row = await prisma.cartItem.findFirst({
      where: { cartId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return row?.position ?? -1;
  },

  /* --------------------------------------------------------------- events */

  async recordEvent(
    cartId: string,
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await prisma.cartEvent.create({
      data: { cartId, type, payloadJson: payload ? JSON.stringify(payload) : null },
    });
  },

  findEvents(cartId: string, take = 50) {
    return prisma.cartEvent.findMany({
      where: { cartId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },

  /* ------------------------------------------------------------- lifecycle */

  findStale(status: CartStatus, olderThan: Date, take: number): Promise<Cart[]> {
    return prisma.cart.findMany({
      where: { status, lastActivityAt: { lt: olderThan } },
      take,
      orderBy: { lastActivityAt: 'asc' },
    });
  },

  async markMany(ids: string[], status: CartStatus): Promise<number> {
    if (ids.length === 0) return 0;

    const { count } = await prisma.cart.updateMany({
      where: { id: { in: ids }, status: { notIn: ['CONVERTED'] } },
      data: { status, activeOwnerKey: null },
    });
    return count;
  },

  /* ----------------------------------------------------------------- admin */

  async listForAdmin(query: AdminCartListQuery): Promise<PageResult<CartWithItems>> {
    const abandonThreshold = new Date(Date.now() - 6 * 60 * 60 * 1000);

    const where: Prisma.CartWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.hasCustomer === undefined
        ? {}
        : query.hasCustomer
          ? { customerId: { not: null } }
          : { customerId: null }),
      ...(query.abandoned ? { status: 'ACTIVE', lastActivityAt: { lt: abandonThreshold } } : {}),
      ...(query.valueMin ? { lastQuotedTotalPaise: { gte: query.valueMin } } : {}),
      ...(query.updatedSince ? { lastActivityAt: { gte: query.updatedSince } } : {}),
      ...(query.q
        ? {
            OR: [
              { id: query.q },
              { couponCode: { contains: query.q } },
              { pincode: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.cart.findMany({
        where,
        ...skipTake(query),
        include: withItems,
        orderBy: orderBy(query.sort, query.order, ADMIN_SORTABLE, [{ lastActivityAt: 'desc' }]),
      }),
      prisma.cart.count({ where }),
    ]);

    return pageResult(items, total, query);
  },

  countByStatus(): Promise<{ status: string; count: number }[]> {
    return prisma.cart
      .groupBy({ by: ['status'], _count: { _all: true } })
      .then((rows) => rows.map((row) => ({ status: row.status, count: row._count._all })));
  },

  async valueStats(): Promise<{ activeValuePaise: number; averageValuePaise: number }> {
    const aggregate = await prisma.cart.aggregate({
      where: { status: 'ACTIVE', lastQuotedTotalPaise: { not: null } },
      _sum: { lastQuotedTotalPaise: true },
      _avg: { lastQuotedTotalPaise: true },
    });

    return {
      activeValuePaise: aggregate._sum.lastQuotedTotalPaise ?? 0,
      averageValuePaise: Math.round(aggregate._avg.lastQuotedTotalPaise ?? 0),
    };
  },

  async topAbandonedProducts(take: number) {
    const rows = await prisma.cartItem.groupBy({
      by: ['productId'],
      where: { cart: { status: { in: ['ABANDONED', 'EXPIRED'] } } },
      _count: { _all: true },
      _sum: { qty: true },
      orderBy: { _count: { productId: 'desc' } },
      take,
    });

    const products = await prisma.product.findMany({
      where: { id: { in: rows.map((row) => row.productId) } },
      select: { id: true, name: true, sku: true },
    });
    const byId = new Map(products.map((product) => [product.id, product]));

    return rows.map((row) => ({
      productId: row.productId,
      name: byId.get(row.productId)?.name ?? 'Deleted product',
      sku: byId.get(row.productId)?.sku ?? '',
      carts: row._count._all,
      quantity: row._sum.qty ?? 0,
    }));
  },

  findCustomers(ids: string[]) {
    return prisma.customer.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true, phone: true },
    });
  },

  /* ------------------------------------------------------------ validation */

  findProductFacts(ids: string[]) {
    return prisma.product.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        visibility: true,
        publishedAt: true,
        deletedAt: true,
        minOrderQty: true,
        maxOrderQty: true,
        isMadeToOrder: true,
        leadTimeDays: true,
        allowCustomization: true,
      },
    });
  },

  /** Availability is READ here and nowhere reserved: reservation belongs to Prompt 9. */
  findVariantFacts(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);

    return prisma.productVariant.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        productId: true,
        sku: true,
        name: true,
        stockQty: true,
        reservedQty: true,
        allowBackorder: true,
        isActive: true,
        deletedAt: true,
        leadTimeDays: true,
      },
    });
  },

  findAttributeValues(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);

    return prisma.attributeValue.findMany({
      where: { id: { in: ids } },
      include: { attribute: { select: { id: true, code: true, name: true } } },
    });
  },
};

/* --------------------------------------------------------------- wishlist */

const withWishlistItems = {
  items: { orderBy: [{ position: 'asc' as const }, { addedAt: 'asc' as const }] },
} satisfies Prisma.WishlistInclude;

export type WishlistWithItems = Prisma.WishlistGetPayload<{ include: typeof withWishlistItems }>;

export const wishlistRepository = {
  findForOwner(owner: { customerId: string | null; sessionId: string | null }) {
    return prisma.wishlist.findMany({
      where: {
        ...notDeleted,
        ...(owner.customerId ? { customerId: owner.customerId } : { sessionId: owner.sessionId }),
      },
      include: withWishlistItems,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  },

  findById(id: string): Promise<WishlistWithItems | null> {
    return prisma.wishlist.findFirst({ where: { id, ...notDeleted }, include: withWishlistItems });
  },

  findByToken(shareToken: string): Promise<WishlistWithItems | null> {
    return prisma.wishlist.findFirst({
      where: { shareToken, isPublic: true, ...notDeleted },
      include: withWishlistItems,
    });
  },

  create(data: Prisma.WishlistUncheckedCreateInput): Promise<WishlistWithItems> {
    return prisma.wishlist.create({ data, include: withWishlistItems });
  },

  async update(id: string, data: Prisma.WishlistUpdateInput): Promise<void> {
    await prisma.wishlist.update({ where: { id }, data });
  },

  async softDelete(id: string): Promise<void> {
    await prisma.wishlist.update({
      where: { id },
      data: { deletedAt: new Date(), shareToken: null, isPublic: false },
    });
  },

  findItem(wishlistId: string, itemId: string) {
    return prisma.wishlistItem.findFirst({ where: { id: itemId, wishlistId } });
  },

  findItemByKey(wishlistId: string, lineKey: string) {
    return prisma.wishlistItem.findUnique({
      where: { wishlistId_lineKey: { wishlistId, lineKey } },
    });
  },

  upsertItem(
    wishlistId: string,
    lineKey: string,
    create: Omit<Prisma.WishlistItemUncheckedCreateInput, 'wishlistId' | 'lineKey'>,
  ) {
    return prisma.wishlistItem.upsert({
      where: { wishlistId_lineKey: { wishlistId, lineKey } },
      create: { wishlistId, lineKey, ...create },
      update: {
        ...(create.priority === undefined ? {} : { priority: create.priority }),
        ...(create.note === undefined ? {} : { note: create.note }),
      },
    });
  },

  updateItem(id: string, data: Prisma.WishlistItemUpdateInput) {
    return prisma.wishlistItem.update({ where: { id }, data });
  },

  async removeItem(id: string): Promise<void> {
    await prisma.wishlistItem.delete({ where: { id } });
  },

  async recount(wishlistId: string): Promise<number> {
    const itemCount = await prisma.wishlistItem.count({ where: { wishlistId } });
    await prisma.wishlist.update({ where: { id: wishlistId }, data: { itemCount } });
    return itemCount;
  },

  async countLists(customerId: string): Promise<number> {
    return prisma.wishlist.count({ where: { customerId, ...notDeleted } });
  },

  /* ----------------------------------------------------------------- admin */

  async mostWishlisted(take: number) {
    const rows = await prisma.wishlistItem.groupBy({
      by: ['productId'],
      _count: { _all: true },
      orderBy: { _count: { productId: 'desc' } },
      take,
    });

    const products = await prisma.product.findMany({
      where: { id: { in: rows.map((row) => row.productId) } },
      select: { id: true, name: true, sku: true },
    });
    const byId = new Map(products.map((product) => [product.id, product]));

    return rows.map((row) => ({
      productId: row.productId,
      name: byId.get(row.productId)?.name ?? 'Deleted product',
      sku: byId.get(row.productId)?.sku ?? '',
      count: row._count._all,
    }));
  },

  findPriceDropCandidates(take: number) {
    return prisma.wishlistItem.findMany({
      where: { lastSeenPricePaise: { not: null } },
      orderBy: { addedPricePaise: 'desc' },
      take,
    });
  },

  async totals(): Promise<{ lists: number; items: number; publicLists: number }> {
    const [lists, items, publicLists] = await Promise.all([
      prisma.wishlist.count({ where: notDeleted }),
      prisma.wishlistItem.count(),
      prisma.wishlist.count({ where: { ...notDeleted, isPublic: true } }),
    ]);
    return { lists, items, publicLists };
  },
};

/* ---------------------------------------------------------------- address */

export const addressRepository = {
  /** Always scoped by customer: an id from the client is never trusted on its own. */
  findForCustomer(customerId: string): Promise<Address[]> {
    return prisma.address.findMany({
      where: { customerId, ...notDeleted },
      orderBy: [{ isDefaultShipping: 'desc' }, { createdAt: 'desc' }],
    });
  },

  findOwned(customerId: string, id: string): Promise<Address | null> {
    return prisma.address.findFirst({ where: { id, customerId, ...notDeleted } });
  },

  count(customerId: string): Promise<number> {
    return prisma.address.count({ where: { customerId, ...notDeleted } });
  },

  create(data: Prisma.AddressUncheckedCreateInput): Promise<Address> {
    return prisma.address.create({ data });
  },

  async update(id: string, data: Prisma.AddressUpdateInput): Promise<Address> {
    return prisma.address.update({ where: { id }, data });
  },

  async softDelete(id: string): Promise<void> {
    await prisma.address.update({
      where: { id },
      data: { deletedAt: new Date(), isDefaultShipping: false, isDefaultBilling: false },
    });
  },

  /** One default per usage, demoted and promoted inside a single transaction. */
  async setDefault(
    customerId: string,
    id: string,
    usage: 'SHIPPING' | 'BILLING' | 'BOTH',
  ): Promise<void> {
    const shipping = usage === 'SHIPPING' || usage === 'BOTH';
    const billing = usage === 'BILLING' || usage === 'BOTH';

    await prisma.$transaction(async (tx) => {
      if (shipping) {
        await tx.address.updateMany({
          where: { customerId, ...notDeleted },
          data: { isDefaultShipping: false },
        });
      }
      if (billing) {
        await tx.address.updateMany({
          where: { customerId, ...notDeleted },
          data: { isDefaultBilling: false },
        });
      }

      await tx.address.update({
        where: { id },
        data: {
          ...(shipping ? { isDefaultShipping: true } : {}),
          ...(billing ? { isDefaultBilling: true } : {}),
        },
      });

      if (shipping) {
        await tx.customer.update({ where: { id: customerId }, data: { defaultAddressId: id } });
      }
    });
  },

  async clearCustomerDefault(customerId: string, addressId: string): Promise<void> {
    await prisma.customer.updateMany({
      where: { id: customerId, defaultAddressId: addressId },
      data: { defaultAddressId: null },
    });
  },

  findPincode(pincode: string) {
    return prisma.shippingPincode.findUnique({
      where: { pincode },
      include: { zone: { select: { code: true, name: true } } },
    });
  },
};

/* -------------------------------------------------------- recently viewed */

export const recentlyViewedRepository = {
  findForOwner(
    owner: { customerId: string | null; sessionId: string | null },
    take: number,
  ): Promise<RecentlyViewed[]> {
    return prisma.recentlyViewed.findMany({
      where: owner.customerId ? { customerId: owner.customerId } : { sessionId: owner.sessionId },
      orderBy: { viewedAt: 'desc' },
      take,
    });
  },

  async record(
    owner: { customerId: string | null; sessionId: string | null },
    productId: string,
    variantId: string | null,
  ): Promise<void> {
    const where = owner.customerId
      ? { customerId_productId: { customerId: owner.customerId, productId } }
      : { sessionId_productId: { sessionId: owner.sessionId!, productId } };

    await prisma.recentlyViewed.upsert({
      where,
      create: {
        customerId: owner.customerId,
        sessionId: owner.sessionId,
        productId,
        variantId,
        viewedAt: new Date(),
      },
      update: { viewCount: { increment: 1 }, viewedAt: new Date(), variantId },
    });
  },

  /** Keeps the newest N rows for an owner and drops the rest. */
  async trim(
    owner: { customerId: string | null; sessionId: string | null },
    keep: number,
  ): Promise<number> {
    const scope = owner.customerId
      ? { customerId: owner.customerId }
      : { sessionId: owner.sessionId };

    const rows = await prisma.recentlyViewed.findMany({
      where: scope,
      orderBy: { viewedAt: 'desc' },
      select: { id: true },
      skip: keep,
    });

    if (rows.length === 0) return 0;

    const { count } = await prisma.recentlyViewed.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    return count;
  },

  async clear(owner: { customerId: string | null; sessionId: string | null }): Promise<number> {
    const { count } = await prisma.recentlyViewed.deleteMany({
      where: owner.customerId ? { customerId: owner.customerId } : { sessionId: owner.sessionId },
    });
    return count;
  },

  findBySession(sessionId: string): Promise<RecentlyViewed[]> {
    return prisma.recentlyViewed.findMany({ where: { sessionId } });
  },

  async reassign(id: string, customerId: string): Promise<void> {
    await prisma.recentlyViewed.update({
      where: { id },
      data: { customerId, sessionId: null },
    });
  },

  async deleteById(id: string): Promise<void> {
    await prisma.recentlyViewed.delete({ where: { id } });
  },
};
