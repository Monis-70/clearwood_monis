import { PRODUCT_RELATION_TYPES } from '@shared/enums';
import { savingsPercentBp } from '@shared/money';
import type { PdpQuery } from '@shared/schemas/storefront';
import type {
  BreadcrumbDto,
  DeliveryEstimateDto,
  ProductCardDto,
  ProductDetailDto,
  ProductRelationGroupDto,
  SpecGroupDto,
  StorefrontVariantDto,
} from '@shared/types/storefront';

import { env } from '../../config/env';
import { cache } from '../../container';
import { browsableWhere, storefrontRepository } from '../../repositories/storefront.repository';
import { categoryService } from '../../services/category.service';
import { AppError } from '../../utils/AppError';
import { isVariantAvailable, unreservedUnits } from '../catalog-admin/availability';
import { STOREFRONT_CACHE_PREFIXES } from '../catalog-admin/catalogCache.service';
import { galleryResolver } from '../media/gallery.resolver';
import { pricingFacade } from '../pricing/pricing.facade';
import { pricingContextLoader } from '../pricing/pricingContext.loader';
import { shippingService } from '../pricing/shipping.service';

import { toImage, toProductCard } from './card.mapper';
import {
  badgesFor,
  isFeaturedAt,
  isNewArrivalAt,
  loadMerchandising,
  type MerchandisingContext,
} from './merchandising';
import { optionAvailabilityService } from './optionAvailability.service';
import { productQueryService } from './productQuery.service';

/**
 * Assembles the whole product page in one call.
 *
 * Everything it needs is fetched in a fixed number of queries regardless of how many variants,
 * related products or collections the product has — the related block is one `findCards` call, not
 * one per relation. The price is the Prompt 6 `PriceBreakdown` verbatim, so a PDP and
 * `/pricing/quote` can never disagree.
 */

const RELATED_LIMIT = 8;

function breadcrumbsFor(
  path: string,
  categories: { id: string; slug: string; name: string; path: string }[],
): BreadcrumbDto[] {
  const bySlug = new Map(categories.map((category) => [category.slug, category]));
  const crumbs: BreadcrumbDto[] = [];
  const parts = path.split('/').filter(Boolean);

  for (let index = 0; index < parts.length; index += 1) {
    const slug = parts[index]!;
    const known = bySlug.get(slug);
    crumbs.push({
      slug,
      name: known?.name ?? slug.replace(/-/g, ' '),
      path: `/${parts.slice(0, index + 1).join('/')}`,
    });
  }
  return crumbs;
}

export const pdpService = {
  async bySlug(
    slug: string,
    query: PdpQuery,
    identity: { customerId: string | null },
  ): Promise<ProductDetailDto> {
    const card = await storefrontRepository.findCardBySlug(slug);
    if (!card) throw AppError.notFound(`Product "${slug}" not found`, { slug });

    const product = await storefrontRepository.findDetailById(card.id);
    if (!product) throw AppError.notFound(`Product "${slug}" not found`, { slug });

    const options = await optionAvailabilityService.build(product, {
      ...(query.variantId ? { variantId: query.variantId } : {}),
      optionValueIds: query.optionValueIds,
    });

    const variantId = options.resolvedVariantId ?? options.defaultVariantId;

    const [price, gallery, specs, collections, relations, settings, basis] = await Promise.all([
      pricingFacade.quoteProduct({
        items: [
          {
            productId: product.id,
            variantId,
            optionValueIds: query.optionValueIds,
            qty: query.qty,
          },
        ],
        ...(query.couponCode ? { couponCode: query.couponCode } : {}),
        ...(query.pincode ? { pincode: query.pincode } : {}),
        channel: 'WEB',
        customerId: identity.customerId,
      }),
      galleryResolver.resolveProductGallery(product.id, {
        ...(variantId ? { variantId } : {}),
      }),
      storefrontRepository.findProductSpecs(product.id),
      storefrontRepository.findCollectionsForProduct(product.id),
      storefrontRepository.findRelations(product.id),
      pricingContextLoader.readSettings(),
      productQueryService.pricingBasis(identity.customerId),
    ]);

    const line = price.lines[0];
    if (!line) throw AppError.internal('The pricing engine returned no line for this product');

    const merchandising = await loadMerchandising();
    const related = await this.relatedCards(
      product.id,
      relations,
      card.categories.map((link) => link.categoryId),
      identity,
      merchandising,
    );

    const liveCategories = await categoryService.liveIds();
    const links = product.categories.filter((link) => liveCategories.has(link.categoryId));
    const categories = links.map((link) => link.category);
    const primary = categories[0] ?? null;

    const compareAt =
      product.compareAtPricePaise !== null && product.compareAtPricePaise > line.unitPricePaise
        ? product.compareAtPricePaise
        : null;

    const variants: StorefrontVariantDto[] = product.variants
      .filter((variant) => variant.isActive)
      .map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        name: variant.name,
        isDefault: variant.isDefault,
        isActive: variant.isActive,
        inStock: isVariantAvailable(variant, product),
        stockStatus: variant.stockStatus,
        stockQty: unreservedUnits(variant),
        leadTimeDays: variant.leadTimeDays,
        optionValueIds: variant.attributeValues.map((link) => link.attributeValueId),
      }));

    const inStock = variants.some((variant) => variant.inStock);
    const delivery = query.pincode ? await this.delivery(query.pincode, price) : null;

    const detail: ProductDetailDto = {
      id: product.id,
      slug: product.slug,
      sku: product.sku,
      name: product.name,
      subtitle: product.subtitle,
      shortDescription: product.shortDescription,
      description: product.description,
      productType: product.productType,
      brand: product.brand
        ? { id: product.brand.id, slug: product.brand.slug, name: product.brand.name }
        : null,
      breadcrumbs: primary ? breadcrumbsFor(primary.path, categories) : [],
      categories: links.map((link) => ({
        id: link.category.id,
        slug: link.category.slug,
        name: link.category.name,
        isPrimary: link.isPrimary,
      })),
      collections: collections.map((link) => link.collection),
      gallery: gallery.map(toImage),
      variants,
      options,
      price,
      pricingBasis: basis,
      compareAtPricePaise: compareAt,
      savingsPaise: compareAt === null ? 0 : compareAt - line.unitPricePaise,
      savingsPercentBp: compareAt === null ? 0 : savingsPercentBp(compareAt, line.unitPricePaise),
      priceNote: product.priceNote,
      showSavingsBadge: settings.showSavingsBadge,
      inStock: product.isMadeToOrder || inStock,
      stockStatus: product.isMadeToOrder
        ? 'MADE_TO_ORDER'
        : (variants.find((variant) => variant.inStock)?.stockStatus ?? 'OUT_OF_STOCK'),
      isMadeToOrder: product.isMadeToOrder,
      leadTimeDays: product.leadTimeDays,
      minOrderQty: product.minOrderQty,
      maxOrderQty: product.maxOrderQty,
      allowCustomization: product.allowCustomization,
      manufacturedInHouse: product.manufacturedInHouse,
      manufacturingNote: product.manufacturingNote,
      badges: badgesFor(
        {
          customText: product.badgeText,
          customColor: product.badgeColor,
          newArrival: isNewArrivalAt(product, merchandising),
          sale: compareAt !== null,
          bestSeller: product.isBestSeller,
          featured: isFeaturedAt(product, merchandising.now),
          specialCollection: product.isSpecialCollection,
          madeToOrder: product.isMadeToOrder,
          customizable: product.allowCustomization,
          inHouse: product.manufacturedInHouse,
        },
        merchandising,
      ),
      warrantyMonths: product.warrantyMonths,
      careInstructions: product.careInstructions,
      assemblyRequired: product.assemblyRequired,
      dimensions: {
        lengthMm: product.lengthMm,
        widthMm: product.widthMm,
        heightMm: product.heightMm,
        seatHeightMm: product.seatHeightMm,
        weightGrams: product.weightGrams,
      },
      specs: this.groupSpecs(specs),
      delivery,
      related: related.related,
      frequentlyBoughtTogether: related.frequentlyBought,
      relationGroups: related.groups,
      ratingAvgBp: product.ratingAvgBp,
      ratingCount: product.ratingCount,
      seo: {
        title: product.seoTitle ?? `${product.name} | ClearWood Furnitures`,
        description: product.seoDescription ?? product.shortDescription ?? product.name,
        keywords: product.seoKeywords,
        canonicalPath: `/products/${product.slug}`,
      },
      jsonLd: [],
    };

    detail.jsonLd = this.jsonLd(detail, line.unitPricePaise);
    return detail;
  },

  /** Cached per (slug + selection + group) because a PDP is the hottest read on the site. */
  async cached(
    slug: string,
    query: PdpQuery,
    identity: { customerId: string | null },
  ): Promise<ProductDetailDto> {
    const key = `${STOREFRONT_CACHE_PREFIXES.pdp}${slug}:${query.variantId ?? ''}:${query.optionValueIds.join('.')}:${query.qty}:${query.pincode ?? ''}:${query.couponCode ?? ''}:${identity.customerId ?? 'anon'}`;

    return cache.wrap(key, env.STOREFRONT_CACHE_TTL_SECONDS, () =>
      this.bySlug(slug, query, identity),
    );
  },

  groupSpecs(
    rows: Awaited<ReturnType<typeof storefrontRepository.findProductSpecs>>,
  ): SpecGroupDto[] {
    const groups = new Map<string, SpecGroupDto>();

    for (const row of rows) {
      const groupId = row.attribute.group?.id ?? null;
      const groupName = row.attribute.group?.name ?? 'Specifications';
      const key = groupId ?? 'ungrouped';

      const group = groups.get(key) ?? { groupId, groupName, items: [] };
      groups.set(key, group);

      const value =
        row.attributeValue?.label ??
        row.valueText ??
        (row.valueNumber !== null ? String(row.valueNumber) : null) ??
        (row.valueBoolean === null ? null : row.valueBoolean ? 'Yes' : 'No');

      if (value === null) continue;

      group.items.push({
        attributeId: row.attributeId,
        label: row.attribute.name,
        value,
        unit: row.attribute.unit,
      });
    }

    return [...groups.values()].filter((group) => group.items.length > 0);
  },

  /**
   * One query for the relation rows, one for every related card — never one card per relation.
   * `groups` holds every type (PRODUCT_RELATION_TYPES order, admin positions within a type);
   * `related` merges the curated types other than FREQUENTLY_BOUGHT, or falls back to the primary
   * category when nothing is curated. Cards come from `findCards`, so a product a shopper cannot
   * open (hidden, draft, scheduled, deleted) is simply absent from every list.
   */
  async relatedCards(
    productId: string,
    relations: { relatedProductId: string; type: string; position: number }[],
    categoryIds: string[],
    identity: { customerId: string | null },
    context?: MerchandisingContext,
  ): Promise<{
    related: ProductCardDto[];
    frequentlyBought: ProductCardDto[];
    groups: ProductRelationGroupDto[];
  }> {
    // A row pointing back at the product itself (written around the API) is never shown.
    const curated = relations.filter((relation) => relation.relatedProductId !== productId);
    const idsOf = (rows: typeof curated) => [...new Set(rows.map((row) => row.relatedProductId))];

    const explicit = curated.filter((relation) => relation.type !== 'FREQUENTLY_BOUGHT');
    const boughtIds = idsOf(curated.filter((relation) => relation.type === 'FREQUENTLY_BOUGHT'));
    const typed = PRODUCT_RELATION_TYPES.map((type) => ({
      type,
      ids: idsOf(curated.filter((relation) => relation.type === type)).slice(0, RELATED_LIMIT),
    })).filter((group) => group.ids.length > 0);

    let relatedIds = idsOf(explicit);

    /* No curated relations: fall back to the same primary category, as a browse listing would. */
    if (relatedIds.length === 0 && categoryIds.length > 0) {
      const fallback = await storefrontRepository.findIds(
        {
          ...browsableWhere(),
          id: { not: productId },
          categories: { some: { categoryId: { in: categoryIds } } },
        },
        [{ soldCount: 'desc' }, { id: 'asc' }],
      );
      relatedIds = fallback.slice(0, RELATED_LIMIT).map((row) => row.id);
    }
    relatedIds = relatedIds.slice(0, RELATED_LIMIT);

    const wanted = [
      ...new Set([...relatedIds, ...boughtIds, ...typed.flatMap((group) => group.ids)]),
    ];
    if (wanted.length === 0) return { related: [], frequentlyBought: [], groups: [] };

    const rows = await storefrontRepository.findCards(wanted);
    const prices = await productQueryService.resolveDisplayPrices(rows, identity);
    const indexed = await productQueryService.priceIndex(wanted);
    const merchandising = context ?? (await loadMerchandising());

    const cards = new Map(
      rows.map((row) => [
        row.id,
        toProductCard(
          row,
          {
            pricePaise: prices.get(row.id) ?? row.basePricePaise,
            indexed: indexed.get(row.id) ?? { minPricePaise: null, maxPricePaise: null },
          },
          merchandising,
        ),
      ]),
    );
    const pick = (ids: string[]): ProductCardDto[] =>
      ids.map((id) => cards.get(id)).filter((card): card is ProductCardDto => card !== undefined);

    return {
      related: pick(relatedIds),
      frequentlyBought: pick(boughtIds),
      groups: typed
        .map((group) => ({ type: group.type, items: pick(group.ids) }))
        .filter((group) => group.items.length > 0),
    };
  },

  async delivery(
    pincode: string,
    price: Awaited<ReturnType<typeof pricingFacade.quoteProduct>>,
  ): Promise<DeliveryEstimateDto> {
    const serviceability = await shippingService.serviceability(pincode);
    const shippingComponent = price.components.find((component) => component.kind === 'SHIPPING');

    return {
      pincode,
      isServiceable: serviceability.isServiceable,
      zoneName: serviceability.zoneName,
      etaMinDays: serviceability.etaMinDays,
      etaMaxDays: serviceability.etaMaxDays,
      chargePaise: shippingComponent?.amountPaise ?? price.shippingPaise,
      message: serviceability.isServiceable
        ? `Delivers to ${pincode}`
        : `We do not deliver to ${pincode} yet`,
    };
  },

  /** Product + Offer + AggregateRating + BreadcrumbList, ready to inject verbatim. */
  jsonLd(detail: ProductDetailDto, unitPricePaise: number): Record<string, unknown>[] {
    const offer: Record<string, unknown> = {
      '@type': 'Offer',
      priceCurrency: 'INR',
      price: (unitPricePaise / 100).toFixed(2),
      availability: detail.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url: detail.seo.canonicalPath,
      itemCondition: 'https://schema.org/NewCondition',
    };

    const product: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: detail.name,
      sku: detail.sku,
      description: detail.seo.description,
      image: detail.gallery.map((image) => image.url),
      offers: offer,
      ...(detail.brand ? { brand: { '@type': 'Brand', name: detail.brand.name } } : {}),
      ...(detail.ratingCount > 0
        ? {
            aggregateRating: {
              '@type': 'AggregateRating',
              ratingValue: (detail.ratingAvgBp / 10_000).toFixed(1),
              reviewCount: detail.ratingCount,
            },
          }
        : {}),
    };

    const breadcrumbs: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: detail.breadcrumbs.map((crumb, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: crumb.name,
        item: crumb.path,
      })),
    };

    return [product, breadcrumbs];
  },
};
