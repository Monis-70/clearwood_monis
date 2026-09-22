import { savingsPercentBp } from '@shared/money';
import type { PdpQuery } from '@shared/schemas/storefront';
import type {
  BreadcrumbDto,
  DeliveryEstimateDto,
  ProductCardDto,
  ProductDetailDto,
  SpecGroupDto,
  StorefrontVariantDto,
} from '@shared/types/storefront';

import { env } from '../../config/env';
import { cache } from '../../container';
import { storefrontRepository } from '../../repositories/storefront.repository';
import { AppError } from '../../utils/AppError';
import { STOREFRONT_CACHE_PREFIXES } from '../catalog-admin/catalogCache.service';
import { galleryResolver } from '../media/gallery.resolver';
import { pricingFacade } from '../pricing/pricing.facade';
import { pricingContextLoader } from '../pricing/pricingContext.loader';
import { shippingService } from '../pricing/shipping.service';

import { toImage, toProductCard } from './card.mapper';
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

    const product = await storefrontRepository.findIndexableById(card.id);
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

    const related = await this.relatedCards(
      product.id,
      relations,
      card.categories.map((link) => link.categoryId),
      identity,
    );

    const categories = product.categories.map((link) => link.category);
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
        inStock:
          product.isMadeToOrder ||
          variant.allowBackorder ||
          Math.max(variant.stockQty - variant.reservedQty, 0) > 0,
        stockStatus: variant.stockStatus,
        stockQty: Math.max(variant.stockQty - variant.reservedQty, 0),
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
      categories: product.categories.map((link, index) => ({
        id: link.category.id,
        slug: link.category.slug,
        name: link.category.name,
        isPrimary: index === 0,
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

    const hit = await cache.get<ProductDetailDto>(key);
    if (hit) return hit;

    const detail = await this.bySlug(slug, query, identity);
    await cache.set(key, detail, env.STOREFRONT_CACHE_TTL_SECONDS);
    return detail;
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

  /** One query for the relation rows, one for every related card — never one card per relation. */
  async relatedCards(
    productId: string,
    relations: { relatedProductId: string; type: string; position: number }[],
    categoryIds: string[],
    identity: { customerId: string | null },
  ): Promise<{ related: ProductCardDto[]; frequentlyBought: ProductCardDto[] }> {
    const explicit = relations.filter((relation) => relation.type !== 'FREQUENTLY_BOUGHT');
    const bought = relations.filter((relation) => relation.type === 'FREQUENTLY_BOUGHT');

    let relatedIds = explicit.map((relation) => relation.relatedProductId);

    /* No curated relations: fall back to the same primary category. */
    if (relatedIds.length === 0 && categoryIds.length > 0) {
      const fallback = await storefrontRepository.findIds(
        {
          id: { not: productId },
          categories: { some: { categoryId: { in: categoryIds } } },
          status: 'ACTIVE',
          deletedAt: null,
          visibility: { in: ['PUBLIC', 'SEARCH_ONLY'] },
        },
        [{ soldCount: 'desc' }, { id: 'asc' }],
      );
      relatedIds = fallback.slice(0, RELATED_LIMIT).map((row) => row.id);
    }

    const wanted = [
      ...new Set([...relatedIds.slice(0, RELATED_LIMIT), ...bought.map((r) => r.relatedProductId)]),
    ];
    if (wanted.length === 0) return { related: [], frequentlyBought: [] };

    const rows = await storefrontRepository.findCards(wanted);
    const prices = await productQueryService.resolveDisplayPrices(rows, identity);
    const indexed = await productQueryService.priceIndex(wanted);

    const cards = new Map(
      rows.map((row) => [
        row.id,
        toProductCard(row, {
          pricePaise: prices.get(row.id) ?? row.basePricePaise,
          indexed: indexed.get(row.id) ?? { minPricePaise: null, maxPricePaise: null },
        }),
      ]),
    );

    return {
      related: relatedIds
        .slice(0, RELATED_LIMIT)
        .map((id) => cards.get(id))
        .filter((card): card is ProductCardDto => card !== undefined),
      frequentlyBought: bought
        .map((relation) => cards.get(relation.relatedProductId))
        .filter((card): card is ProductCardDto => card !== undefined),
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
