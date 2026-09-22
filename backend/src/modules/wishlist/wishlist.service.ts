import { randomBytes } from 'node:crypto';

import type {
  WishlistAddItemInput,
  WishlistCreateInput,
  WishlistMoveToCartInput,
  WishlistUpdateInput,
  WishlistUpdateItemInput,
} from '@shared/schemas/cart';
import type { CartDto, SharedWishlistDto, WishlistDto, WishlistItemDto } from '@shared/types/cart';
import type { WishlistPriority } from '@shared/enums';

import { env } from '../../config/env';
import { catalogEvents } from '../../events/catalogEvents';
import { wishlistRepository, type WishlistWithItems } from '../../repositories/cart.repository';
import { storefrontRepository } from '../../repositories/storefront.repository';
import { AppError } from '../../utils/AppError';
import type { CartOwner } from '../cart/cartIdentity';
import { cartService } from '../cart/cart.service';
import { parseOptions } from '../cart/cartPricing.service';
import { toProductCard } from '../storefront/card.mapper';
import { productQueryService } from '../storefront/productQuery.service';

/**
 * Wishlists, including the guest case.
 *
 * The price-drop flag compares the price the item was saved at with a live quote — it is never a
 * stored "current price", because that would be a second source of money truth.
 */

export const wishlistService = {
  async defaultList(owner: CartOwner): Promise<WishlistWithItems> {
    const lists = await wishlistRepository.findForOwner(owner);
    const existing = lists.find((list) => list.isDefault) ?? lists[0];
    if (existing) return existing;

    return wishlistRepository.create({
      customerId: owner.customerId,
      sessionId: owner.sessionId,
      name: 'My Wishlist',
      isDefault: true,
    });
  },

  async list(owner: CartOwner): Promise<WishlistDto[]> {
    const lists = await wishlistRepository.findForOwner(owner);
    if (lists.length === 0) return [await this.toDto(await this.defaultList(owner))];

    return Promise.all(lists.map((list) => this.toDto(list)));
  },

  async create(owner: CartOwner, input: WishlistCreateInput): Promise<WishlistDto> {
    if (owner.customerId) {
      const count = await wishlistRepository.countLists(owner.customerId);
      if (count >= env.WISHLIST_MAX_LISTS) {
        throw new AppError(
          422,
          'WISHLIST_LIMIT_REACHED',
          `You can keep at most ${env.WISHLIST_MAX_LISTS} lists`,
          { max: env.WISHLIST_MAX_LISTS },
        );
      }
    }

    const created = await wishlistRepository.create({
      customerId: owner.customerId,
      sessionId: owner.sessionId,
      name: input.name,
      isPublic: input.isPublic,
      isDefault: false,
    });

    return this.toDto(created);
  },

  /** Ownership is checked here, never assumed from the id the client sent. */
  async owned(owner: CartOwner, id: string): Promise<WishlistWithItems> {
    const list = await wishlistRepository.findById(id);

    const isOwner =
      list !== null &&
      (owner.customerId
        ? list.customerId === owner.customerId
        : Boolean(owner.sessionId) && list.sessionId === owner.sessionId);

    // 404 rather than 403: a wrong id must not confirm that the list exists.
    if (!isOwner) throw AppError.notFound('Wishlist not found', { id });
    return list;
  },

  async update(owner: CartOwner, id: string, input: WishlistUpdateInput): Promise<WishlistDto> {
    const list = await this.owned(owner, id);

    if (list.version !== input.version) {
      throw new AppError(409, 'STALE_RESOURCE', 'This list changed elsewhere — reload', {
        yourVersion: input.version,
        currentVersion: list.version,
      });
    }

    await wishlistRepository.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.isPublic === undefined ? {} : { isPublic: input.isPublic }),
      version: { increment: 1 },
    });

    return this.toDto(await this.owned(owner, id));
  },

  async remove(owner: CartOwner, id: string): Promise<void> {
    const list = await this.owned(owner, id);
    if (list.isDefault) {
      throw new AppError(422, 'WISHLIST_DEFAULT', 'The default list cannot be deleted');
    }
    await wishlistRepository.softDelete(id);
  },

  async addItem(
    owner: CartOwner,
    id: string | null,
    input: WishlistAddItemInput,
  ): Promise<WishlistDto> {
    const list = id ? await this.owned(owner, id) : await this.defaultList(owner);

    if (list.itemCount >= env.WISHLIST_MAX_ITEMS) {
      throw new AppError(
        422,
        'WISHLIST_FULL',
        `A list can hold at most ${env.WISHLIST_MAX_ITEMS} items`,
        { max: env.WISHLIST_MAX_ITEMS },
      );
    }

    const resolved = await cartService.resolveLine({
      ...(input.productId ? { productId: input.productId } : {}),
      ...(input.slug ? { slug: input.slug } : {}),
      variantId: input.variantId ?? null,
      optionValueIds: input.optionValueIds,
      qty: 1,
    });

    const position = list.items.length;

    await wishlistRepository.upsertItem(list.id, resolved.lineKey, {
      productId: resolved.productId,
      variantId: resolved.variantId,
      selectedOptionsJson: JSON.stringify(resolved.optionValueIds),
      priority: input.priority,
      note: input.note ?? null,
      addedPricePaise: resolved.unitPricePaise,
      lastSeenPricePaise: resolved.unitPricePaise,
      position,
    });

    await wishlistRepository.recount(list.id);
    catalogEvents.emit('wishlist.item.added', { productId: resolved.productId });

    return this.toDto(await this.owned(owner, list.id));
  },

  async updateItem(
    owner: CartOwner,
    id: string,
    itemId: string,
    input: WishlistUpdateItemInput,
  ): Promise<WishlistDto> {
    const list = await this.owned(owner, id);
    const item = await wishlistRepository.findItem(list.id, itemId);
    if (!item) throw AppError.notFound('That item is not on this list', { itemId });

    await wishlistRepository.updateItem(item.id, {
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.note === undefined ? {} : { note: input.note ?? null }),
      ...(input.position === undefined ? {} : { position: input.position }),
    });

    return this.toDto(await this.owned(owner, list.id));
  },

  async removeItem(owner: CartOwner, id: string, itemId: string): Promise<WishlistDto> {
    const list = await this.owned(owner, id);
    const item = await wishlistRepository.findItem(list.id, itemId);
    if (!item) throw AppError.notFound('That item is not on this list', { itemId });

    await wishlistRepository.removeItem(item.id);
    await wishlistRepository.recount(list.id);
    catalogEvents.emit('wishlist.item.removed', { productId: item.productId });

    return this.toDto(await this.owned(owner, list.id));
  },

  async moveToCart(
    owner: CartOwner,
    id: string,
    itemId: string,
    input: WishlistMoveToCartInput,
  ): Promise<{ wishlist: WishlistDto; cart: CartDto }> {
    const list = await this.owned(owner, id);
    const item = await wishlistRepository.findItem(list.id, itemId);
    if (!item) throw AppError.notFound('That item is not on this list', { itemId });

    const cart = await cartService.getOrCreate(owner);
    await cartService.addItem(cart, {
      productId: item.productId,
      variantId: item.variantId,
      optionValueIds: parseOptions(item.selectedOptionsJson),
      qty: input.qty,
    });

    if (input.removeFromList) {
      await wishlistRepository.removeItem(item.id);
      await wishlistRepository.recount(list.id);
    }

    // Both sides changed, so both are returned: the UI must not have to re-fetch to stay honest.
    return {
      wishlist: await this.toDto(await this.owned(owner, list.id)),
      cart: await cartService.toDto(await cartService.reload(cart.id), {
        customerId: owner.customerId,
      }),
    };
  },

  /* ------------------------------------------------------------- sharing */

  async share(owner: CartOwner, id: string): Promise<{ shareToken: string }> {
    const list = await this.owned(owner, id);
    const shareToken = list.shareToken ?? randomBytes(16).toString('base64url');

    await wishlistRepository.update(id, { shareToken, isPublic: true, version: { increment: 1 } });
    return { shareToken };
  },

  async revokeShare(owner: CartOwner, id: string): Promise<void> {
    await this.owned(owner, id);
    await wishlistRepository.update(id, {
      shareToken: null,
      isPublic: false,
      version: { increment: 1 },
    });
  },

  /** Public read. Deliberately narrower than the owner view: no ids, no owner, no PII. */
  async bySharedToken(token: string): Promise<SharedWishlistDto> {
    const list = await wishlistRepository.findByToken(token);
    if (!list) throw AppError.notFound('That wishlist is not shared');

    const cards = await this.cardsFor(list);

    return {
      name: list.name,
      itemCount: list.items.length,
      items: list.items.map((item) => ({
        productId: item.productId,
        priority: item.priority as WishlistPriority,
        note: item.note,
        product: cards.get(item.productId) ?? null,
      })),
    };
  },

  /* ---------------------------------------------------------- projection */

  async cardsFor(list: WishlistWithItems) {
    const ids = [...new Set(list.items.map((item) => item.productId))];
    if (ids.length === 0) return new Map<string, ReturnType<typeof toProductCard>>();

    const rows = await storefrontRepository.findCards(ids);
    const [prices, indexed] = await Promise.all([
      productQueryService.resolveDisplayPrices(rows, { customerId: null }),
      productQueryService.priceIndex(ids),
    ]);

    return new Map(
      rows.map((row) => [
        row.id,
        toProductCard(row, {
          pricePaise: prices.get(row.id) ?? row.basePricePaise,
          indexed: indexed.get(row.id) ?? { minPricePaise: null, maxPricePaise: null },
        }),
      ]),
    );
  },

  async toDto(list: WishlistWithItems): Promise<WishlistDto> {
    const cards = await this.cardsFor(list);

    const items: WishlistItemDto[] = list.items.map((item) => {
      const card = cards.get(item.productId) ?? null;
      const current = card?.pricePaise ?? item.lastSeenPricePaise ?? null;
      const drop =
        current !== null && current < item.addedPricePaise ? item.addedPricePaise - current : 0;

      return {
        id: item.id,
        lineKey: item.lineKey,
        productId: item.productId,
        variantId: item.variantId,
        priority: item.priority as WishlistPriority,
        note: item.note,
        position: item.position,
        addedAt: item.addedAt.toISOString(),
        addedPricePaise: item.addedPricePaise,
        currentPricePaise: current,
        hasPriceDrop: drop > 0,
        priceDropPaise: drop,
        product: card,
      };
    });

    return {
      id: list.id,
      name: list.name,
      isDefault: list.isDefault,
      isPublic: list.isPublic,
      shareToken: list.shareToken,
      itemCount: items.length,
      items,
      version: list.version,
    };
  },
};
