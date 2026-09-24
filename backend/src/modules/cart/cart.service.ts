import type { Prisma } from '@prisma/client';

import type { SaveState } from '@shared/enums';
import type { CartAddItemInput, CartUpdateItemInput } from '@shared/schemas/cart';
import type {
  CartCouponDto,
  CartDeliveryDto,
  CartDto,
  CartLineDto,
  CartLineOptionDto,
  CartSummaryDto,
} from '@shared/types/cart';
import type { LineBreakdown } from '@shared/types/pricing';

import { env } from '../../config/env';
import { catalogEvents } from '../../events/catalogEvents';
import { cartRepository, type CartWithItems } from '../../repositories/cart.repository';
import { storefrontRepository } from '../../repositories/storefront.repository';
import { AppError } from '../../utils/AppError';
import { galleryResolver } from '../media/gallery.resolver';
import { pricingContextLoader } from '../pricing/pricingContext.loader';
import { pricingFacade } from '../pricing/pricing.facade';
import { shippingService } from '../pricing/shipping.service';
import { optionAvailabilityService } from '../storefront/optionAvailability.service';

import type { CartOwner } from './cartIdentity';
import { cartIdentity } from './cartIdentity';
import { cartPricingService, parseOptions } from './cartPricing.service';
import { cartValidationService, type LineFacts } from './cartValidation.service';
import { buildLineKey, hashCustomization } from './lineKey';

/**
 * The cart.
 *
 * Two invariants this file exists to hold:
 *  - RULE 1: nothing here computes money. Every read re-quotes through the Prompt 6 engine and
 *    returns that breakdown verbatim.
 *  - one ACTIVE cart per owner, guaranteed by the unique index on `Cart.activeOwnerKey`. Concurrent
 *    first requests race at the database and exactly one insert wins; the losers re-read.
 */

const CONFLICT_RETRIES = 5;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  );
}

export const cartService = {
  /**
   * Returns the owner's ACTIVE cart, creating one if needed.
   *
   * The unique index does the arbitration: two simultaneous first requests both attempt an insert,
   * one succeeds, the other catches P2002 and reads the winner. Exactly one ACTIVE cart exists
   * afterwards, with no advisory lock and no read-then-write window.
   */
  async getOrCreate(owner: CartOwner): Promise<CartWithItems> {
    const activeOwnerKey = cartIdentity.ownerKey(owner);

    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt += 1) {
      const existing = await cartRepository.findActiveByOwnerKey(activeOwnerKey);
      if (existing) return existing;

      try {
        const cart = await cartRepository.create({
          customerId: owner.customerId,
          sessionId: owner.sessionId,
          activeOwnerKey,
          channel: 'WEB',
          expiresAt: this.expiryFor(owner),
        });
        await cartRepository.recordEvent(cart.id, 'CREATED', {
          owner: owner.customerId ? 'CUSTOMER' : 'GUEST',
        });
        return cart;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Somebody else created it a microsecond earlier; loop and read theirs.
      }
    }

    const winner = await cartRepository.findActiveByOwnerKey(activeOwnerKey);
    if (winner) return winner;

    throw new AppError(409, 'CART_CONFLICT', 'Could not open a cart — try again');
  },

  /** Read-only: never creates a cart, so a GET by a first-time visitor sets no cookie. */
  async find(owner: CartOwner): Promise<CartWithItems | null> {
    if (!owner.customerId && !owner.sessionId) return null;
    return cartRepository.findActiveByOwnerKey(cartIdentity.ownerKey(owner));
  },

  expiryFor(owner: { customerId: string | null }): Date {
    const days = owner.customerId ? env.CART_CUSTOMER_TTL_DAYS : env.CART_GUEST_TTL_DAYS;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  },

  /* ------------------------------------------------------------- mutations */

  async addItem(cart: CartWithItems, input: CartAddItemInput): Promise<CartWithItems> {
    const resolved = await this.resolveLine(input);

    const existingLines = cart.items.filter((item) => item.saveState === 'IN_CART').length;
    const known = await cartRepository.findItemByKey(cart.id, resolved.lineKey);

    if (!known && existingLines >= env.CART_MAX_LINES) {
      throw new AppError(
        422,
        'CART_TOO_MANY_LINES',
        `A cart can hold at most ${env.CART_MAX_LINES} different items`,
        { max: env.CART_MAX_LINES },
      );
    }

    const ceiling = Math.min(
      resolved.maxOrderQty ?? env.CART_MAX_QTY_PER_LINE,
      env.CART_MAX_QTY_PER_LINE,
    );
    const requested = Math.max(input.qty, resolved.minOrderQty);

    const position = known?.position ?? (await cartRepository.maxPosition(cart.id)) + 1;

    const item = await cartRepository.upsertItem(
      cart.id,
      resolved.lineKey,
      {
        productId: resolved.productId,
        variantId: resolved.variantId,
        qty: Math.min(requested, ceiling),
        selectedOptionsJson: JSON.stringify(resolved.optionValueIds),
        customizationJson: input.customization ? JSON.stringify(input.customization) : null,
        customizationHash: resolved.customizationHash,
        saveState: 'IN_CART',
        addedUnitPricePaise: resolved.unitPricePaise,
        addedTotalPaise: resolved.unitPricePaise * Math.min(requested, ceiling),
        productNameSnapshot: resolved.productName,
        variantNameSnapshot: resolved.variantName,
        skuSnapshot: resolved.sku,
        imageMediaIdSnapshot: resolved.imageMediaId,
        note: input.note ?? null,
        position,
      } satisfies Omit<Prisma.CartItemUncheckedCreateInput, 'cartId' | 'lineKey'>,
      Math.min(requested, ceiling),
      ceiling,
    );

    await cartRepository.recount(cart.id);
    await cartRepository.recordEvent(cart.id, known ? 'ITEM_UPDATED' : 'ITEM_ADDED', {
      lineKey: resolved.lineKey,
      productId: resolved.productId,
      qty: item.qty,
    });

    // Prompt 7 left ProductStat.cartAddCount at zero on purpose; this is where it starts moving.
    catalogEvents.emit('cart.item.added', {
      productId: resolved.productId,
      variantId: resolved.variantId,
      qty: input.qty,
    });

    return this.reload(cart.id);
  },

  async updateItem(
    cart: CartWithItems,
    lineId: string,
    input: CartUpdateItemInput,
  ): Promise<CartWithItems> {
    const item = await cartRepository.findItem(cart.id, lineId);
    if (!item) throw AppError.notFound('That item is not in your cart', { lineId });

    if (input.qty !== undefined && input.qty === 0) {
      return this.removeItem(cart, lineId);
    }

    if (input.qty !== undefined) {
      const facts = await cartRepository.findProductFacts([item.productId]);
      const ceiling = Math.min(
        facts[0]?.maxOrderQty ?? env.CART_MAX_QTY_PER_LINE,
        env.CART_MAX_QTY_PER_LINE,
      );
      const next = Math.min(Math.max(input.qty, facts[0]?.minOrderQty ?? 1), ceiling);

      /*
       * Compare-and-set on the quantity we read: two tabs racing on the same line cannot lose an
       * update, because the loser's WHERE matches zero rows and it is told to reload.
       */
      const won = await cartRepository.updateItemQty(item.id, item.qty, next);
      if (!won) {
        throw new AppError(409, 'CART_CONFLICT', 'This item changed in another tab — reload', {
          lineId,
        });
      }
    }

    if (input.note !== undefined) {
      await cartRepository.updateItem(item.id, { note: input.note ?? null });
    }

    await cartRepository.recount(cart.id);
    await cartRepository.recordEvent(cart.id, 'ITEM_UPDATED', { lineId, qty: input.qty });

    return this.reload(cart.id);
  },

  async removeItem(cart: CartWithItems, lineId: string): Promise<CartWithItems> {
    const item = await cartRepository.findItem(cart.id, lineId);
    if (!item) throw AppError.notFound('That item is not in your cart', { lineId });

    await cartRepository.removeItem(item.id);
    await cartRepository.recount(cart.id);
    await cartRepository.recordEvent(cart.id, 'ITEM_REMOVED', {
      lineKey: item.lineKey,
      productId: item.productId,
    });

    return this.reload(cart.id);
  },

  async setSaveState(
    cart: CartWithItems,
    lineId: string,
    saveState: SaveState,
  ): Promise<CartWithItems> {
    const item = await cartRepository.findItem(cart.id, lineId);
    if (!item) throw AppError.notFound('That item is not in your cart', { lineId });

    await cartRepository.updateItem(item.id, { saveState });
    await cartRepository.recount(cart.id);
    await cartRepository.recordEvent(
      cart.id,
      saveState === 'SAVED_FOR_LATER' ? 'SAVED_FOR_LATER' : 'MOVED_TO_CART',
      { lineId },
    );

    return this.reload(cart.id);
  },

  async clear(cart: CartWithItems): Promise<CartWithItems> {
    const removed = await cartRepository.removeAllItems(cart.id);
    await cartRepository.recount(cart.id);
    await cartRepository.touch(cart.id, { couponCode: null });
    await cartRepository.recordEvent(cart.id, 'CLEARED', { removed });

    return this.reload(cart.id);
  },

  async reorder(
    cart: CartWithItems,
    items: { lineId: string; position: number }[],
  ): Promise<CartWithItems> {
    await cartRepository.reposition(cart.id, items);
    return this.reload(cart.id);
  },

  async setPincode(cart: CartWithItems, pincode: string): Promise<CartWithItems> {
    await cartRepository.touch(cart.id, { pincode });
    await cartRepository.recordEvent(cart.id, 'PINCODE_SET', { pincode });
    return this.reload(cart.id);
  },

  /**
   * Applying a coupon runs the real validator first, so the shopper gets the specific reason
   * (`EXPIRED`, `MIN_SUBTOTAL_NOT_MET`, …) rather than a generic failure — and an invalid code is
   * never stored on the cart.
   */
  async applyCoupon(cart: CartWithItems, code: string): Promise<CartCouponDto> {
    if (cartPricingService.activeItems(cart).length === 0) {
      throw new AppError(422, 'CART_EMPTY', 'Add something to your cart before using a coupon');
    }

    const result = await pricingFacade.validateCoupon(
      code,
      cartPricingService.buildQuoteRequest(cart, { includeCoupon: false }),
    );

    if (!result.valid) {
      return {
        code: result.code,
        applied: false,
        discountPaise: 0,
        rejectionCode: result.rejectionCode ?? null,
        message: result.message ?? null,
      };
    }

    await cartRepository.touch(cart.id, { couponCode: result.code });
    await cartRepository.recordEvent(cart.id, 'COUPON_APPLIED', { code: result.code });

    return {
      code: result.code,
      applied: true,
      discountPaise: result.discountPaise ?? 0,
      rejectionCode: null,
      message: result.message ?? null,
    };
  },

  async removeCoupon(cart: CartWithItems): Promise<CartWithItems> {
    if (cart.couponCode) {
      await cartRepository.touch(cart.id, { couponCode: null });
      await cartRepository.recordEvent(cart.id, 'COUPON_REMOVED', { code: cart.couponCode });
    }
    return this.reload(cart.id);
  },

  async reload(cartId: string): Promise<CartWithItems> {
    const cart = await cartRepository.findById(cartId);
    if (!cart) throw AppError.notFound('Cart not found', { cartId });
    return cart;
  },

  /* ------------------------------------------------------------- resolution */

  /**
   * Turns an add request into a concrete line.
   *
   * When only option values are given, the variant is resolved by Prompt 7's availability matrix —
   * this prompt does not re-derive variants from attribute values.
   */
  async resolveLine(input: CartAddItemInput) {
    const product = input.productId
      ? await storefrontRepository.findIndexableById(input.productId)
      : await this.findBySlug(input.slug!);

    if (!product) {
      throw AppError.notFound('That product is not available', {
        productId: input.productId ?? null,
        slug: input.slug ?? null,
      });
    }

    let variantId = input.variantId ?? null;

    if (!variantId && input.optionValueIds.length > 0) {
      const matrix = await optionAvailabilityService.build(product, {
        optionValueIds: input.optionValueIds,
      });

      if (!matrix.resolvedVariantId) {
        const chosen = new Set(input.optionValueIds);
        const missing = matrix.attributes
          .filter((attribute) => !attribute.values.some((value) => chosen.has(value.valueId)))
          .map((attribute) => ({ attributeId: attribute.attributeId, name: attribute.name }));

        throw new AppError(
          422,
          'VARIANT_NOT_RESOLVABLE',
          missing.length > 0
            ? 'Choose every option before adding this to your cart'
            : 'That combination is not available',
          { missing, chosen: input.optionValueIds },
        );
      }
      variantId = matrix.resolvedVariantId;
    }

    if (!variantId) {
      variantId = product.variants.find((variant) => variant.isDefault)?.id ?? null;
    }

    const variant = variantId
      ? product.variants.find((candidate) => candidate.id === variantId)
      : undefined;

    if (variantId && !variant) {
      throw AppError.notFound('That option is not available', { variantId });
    }

    const optionValueIds =
      input.optionValueIds.length > 0
        ? input.optionValueIds
        : (variant?.attributeValues.map((link) => link.attributeValueId) ?? []);

    /* The price is the engine's, even at add time — the snapshot must never be a local guess. */
    const breakdown = await pricingFacade.quoteProduct({
      items: [{ productId: product.id, variantId, optionValueIds, qty: 1 }],
      channel: 'WEB',
    });

    const gallery = await galleryResolver.resolveProductGallery(product.id, {
      ...(variantId ? { variantId } : {}),
    });

    const customizationHash = hashCustomization(input.customization ?? null);

    return {
      productId: product.id,
      productName: product.name,
      productSlug: product.slug,
      variantId,
      variantName: variant?.name ?? null,
      sku: variant?.sku ?? product.sku,
      imageMediaId: gallery[0]?.mediaId ?? null,
      optionValueIds,
      customizationHash,
      minOrderQty: product.minOrderQty,
      maxOrderQty: product.maxOrderQty,
      unitPricePaise: breakdown.lines[0]?.unitPricePaise ?? product.basePricePaise,
      lineKey: buildLineKey({
        productId: product.id,
        variantId,
        optionValueIds,
        customizationHash,
      }),
    };
  },

  async findBySlug(slug: string) {
    const card = await storefrontRepository.findCardBySlug(slug);
    return card ? storefrontRepository.findIndexableById(card.id) : null;
  },

  /* ------------------------------------------------------------ projection */

  /**
   * The wire shape.
   *
   * Every money field on a line comes from `breakdown`; the `added*`/`last*` columns are carried
   * through untouched purely so the UI can say "this changed since you added it".
   */
  async toDto(
    cart: CartWithItems,
    options: { customerId?: string | null; coupon?: CartDto['coupon'] } = {},
  ): Promise<CartDto> {
    const facts = cartValidationService.factsFor(cart);
    const quoted = cartPricingService.quote(cart, options);
    const [{ breakdown, byLineId, priceChanges }, validation, settings] = await Promise.all([
      quoted,
      // The same cart, the same quote: validation reads the one already in flight.
      cartValidationService.validate(cart, { ...options, facts, quoted }),
      pricingContextLoader.readSettings(),
    ]);

    const [lines, saved, delivery] = await Promise.all([
      this.linesToDto(cart, 'IN_CART', byLineId, facts),
      this.linesToDto(cart, 'SAVED_FOR_LATER', byLineId, facts),
      this.deliveryFor(cart, facts),
    ]);

    return {
      id: cart.id,
      status: cart.status as CartDto['status'],
      currency: 'INR',
      isGuest: cart.customerId === null,
      itemCount: cart.itemCount,
      quantityTotal: cart.quantityTotal,
      lines,
      savedForLater: saved,
      breakdown,
      coupon:
        // A rejected coupon is never stored on the cart, so the outcome is passed in instead.
        options.coupon ??
        (cart.couponCode
          ? {
              code: cart.couponCode,
              applied: breakdown.appliedCouponCode === cart.couponCode,
              discountPaise: breakdown.discountPaise,
              rejectionCode: null,
              message: null,
            }
          : null),
      delivery,
      priceChanges,
      issues: validation.issues,
      isCheckoutReady: validation.isCheckoutReady,
      blockingCount: validation.blockingCount,
      minOrderValuePaise: settings.minOrderValuePaise,
      updatedAt: cart.updatedAt.toISOString(),
      version: cart.version,
    };
  },

  async linesToDto(
    cart: CartWithItems,
    saveState: SaveState,
    byLineId: Map<string, LineBreakdown>,
    preloadedFacts?: Promise<LineFacts[]>,
  ): Promise<CartLineDto[]> {
    const items = cart.items
      .filter((item) => item.saveState === saveState)
      .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime());

    if (items.length === 0) return [];

    const [products, variants, values, facts] = await Promise.all([
      cartRepository.findProductFacts(items.map((item) => item.productId)),
      cartRepository.findVariantFacts(
        items.map((item) => item.variantId).filter((id): id is string => id !== null),
      ),
      cartRepository.findAttributeValues([
        ...new Set(items.flatMap((item) => parseOptions(item.selectedOptionsJson))),
      ]),
      preloadedFacts ?? cartValidationService.factsFor(cart),
    ]);

    const productById = new Map(products.map((product) => [product.id, product]));
    const variantById = new Map(variants.map((variant) => [variant.id, variant]));
    const valueById = new Map(values.map((value) => [value.id, value]));
    const factsByLine = new Map(facts.map((fact) => [fact.lineId, fact]));

    const galleries = await galleryResolver.resolveManyProductGalleries(
      items.map((item) => ({
        productId: item.productId,
        query: item.variantId ? { variantId: item.variantId } : {},
      })),
    );

    const images = items.map(
      (item) => galleries.get(`${item.productId}:${item.variantId ?? ''}`)?.[0] ?? null,
    );

    return items.map((item, index) => {
      const product = productById.get(item.productId);
      const variant = item.variantId ? variantById.get(item.variantId) : undefined;
      const priced = byLineId.get(item.id);
      const fact = factsByLine.get(item.id);
      const media = images[index];

      const options: CartLineOptionDto[] = parseOptions(item.selectedOptionsJson)
        .map((valueId) => valueById.get(valueId))
        .filter((value): value is NonNullable<typeof value> => value !== undefined)
        .map((value) => ({
          attributeId: value.attribute.id,
          attributeCode: value.attribute.code,
          attributeName: value.attribute.name,
          valueId: value.id,
          label: value.label,
          colorHex: value.colorHex,
        }));

      return {
        id: item.id,
        lineKey: item.lineKey,
        productId: item.productId,
        productSlug: product?.slug ?? '',
        variantId: item.variantId,
        sku: variant?.sku ?? item.skuSnapshot,
        name: product?.name ?? item.productNameSnapshot,
        variantName: variant?.name ?? item.variantNameSnapshot,
        qty: item.qty,
        saveState: item.saveState as SaveState,
        position: item.position,
        note: item.note,
        image: media
          ? {
              mediaId: media.mediaId,
              url: media.url,
              alt: media.alt ?? '',
              width: media.width,
              height: media.height,
              blurhash: media.blurhash,
              lqip: media.lqip,
              dominantColorHex: null,
              focalPoint: media.focalPoint,
              sources: media.sources.map((source) => ({
                label: source.label,
                format: source.format,
                url: source.url,
                width: source.width,
                height: source.height,
              })),
            }
          : null,
        options,

        unitPricePaise: priced?.unitPricePaise ?? 0,
        listPricePaise: priced?.listPricePaise ?? null,
        subtotalPaise: priced?.subtotalPaise ?? 0,
        discountPaise: priced?.discountPaise ?? 0,
        taxPaise: priced?.taxPaise ?? 0,
        totalPaise: priced?.totalPaise ?? 0,
        savingsPaise: priced?.savingsPaise ?? 0,

        addedUnitPricePaise: item.addedUnitPricePaise,
        lastUnitPricePaise: item.lastUnitPricePaise,
        addedAt: item.addedAt.toISOString(),

        availableQty: fact?.availableQty ?? 0,
        inStock: fact ? fact.isMadeToOrder || fact.allowBackorder || fact.availableQty > 0 : false,
        isMadeToOrder: fact?.isMadeToOrder ?? false,
        leadTimeDays: fact?.leadTimeDays ?? null,
        minOrderQty: fact?.minOrderQty ?? 1,
        maxOrderQty: fact?.maxOrderQty ?? null,
        allowCustomization: product?.allowCustomization ?? false,
      };
    });
  },

  async deliveryFor(
    cart: CartWithItems,
    preloadedFacts?: Promise<LineFacts[]>,
  ): Promise<CartDeliveryDto | null> {
    if (!cart.pincode) return null;

    const result = await shippingService.serviceability(cart.pincode);
    const facts = await (preloadedFacts ?? cartValidationService.factsFor(cart));

    return {
      pincode: cart.pincode,
      isServiceable: result.isServiceable,
      codAvailable: result.codAvailable,
      zoneName: result.zoneName,
      city: result.city,
      state: result.state,
      stateCode: result.stateCode,
      etaMinDays: result.etaMinDays,
      etaMaxDays: result.etaMaxDays,
      lines: facts.map((fact) => ({
        lineId: fact.lineId,
        isServiceable: result.isServiceable,
        etaMinDays: result.etaMinDays,
        etaMaxDays: result.etaMaxDays,
        leadTimeDays: fact.leadTimeDays,
      })),
    };
  },

  async summary(cart: CartWithItems | null): Promise<CartSummaryDto> {
    if (!cart || cart.itemCount === 0) {
      return { itemCount: 0, quantityTotal: 0, grandTotalPaise: 0, currency: 'INR' };
    }

    const { breakdown } = await cartPricingService.quote(cart, { persist: false });

    return {
      itemCount: cart.itemCount,
      quantityTotal: cart.quantityTotal,
      grandTotalPaise: breakdown.grandTotalPaise,
      currency: 'INR',
    };
  },
};
