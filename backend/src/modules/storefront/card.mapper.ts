import { savingsPercentBp } from '@shared/money';
import type { GalleryItemDto } from '@shared/types/media';
import type { ProductCardDto, ProductImageDto, ProductSwatchDto } from '@shared/types/storefront';

import { storage } from '../../container';
import type { ProductCardRow } from '../../repositories/storefront.repository';
import { isVariantAvailable } from '../catalog-admin/availability';

import {
  badgesFor,
  isFeaturedAt,
  isNewArrivalAt,
  type MerchandisingContext,
} from './merchandising';
import type { PriceIndexEntry } from './productQuery.service';

/** Shapes a listing row. The price is passed in — nothing here calculates money. */

export function toImage(item: GalleryItemDto): ProductImageDto {
  return {
    mediaId: item.mediaId,
    url: item.url,
    alt: item.alt ?? '',
    width: item.width,
    height: item.height,
    blurhash: item.blurhash,
    lqip: item.lqip,
    dominantColorHex: null,
    focalPoint: item.focalPoint,
    sources: item.sources.map((source) => ({
      label: source.label,
      format: source.format,
      url: source.url,
      width: source.width,
      height: source.height,
    })),
  };
}

function primaryImage(row: ProductCardRow): ProductImageDto | null {
  const link = row.media[0];
  if (!link) return null;

  return {
    mediaId: link.mediaId,
    url: storage.url(link.media.path),
    alt: link.altText ?? link.media.altText ?? row.name,
    width: link.media.width,
    height: link.media.height,
    blurhash: link.media.blurhash,
    lqip: link.media.lqipDataUri,
    dominantColorHex: link.media.dominantColorHex,
    focalPoint:
      link.media.focalPointX === null || link.media.focalPointY === null
        ? null
        : { x: link.media.focalPointX, y: link.media.focalPointY },
    sources: link.media.variants
      .map((variant) => ({
        label: variant.label,
        format: variant.format,
        url: storage.url(variant.path),
        width: variant.width,
        height: variant.height,
      }))
      .sort((a, b) => a.width - b.width || a.format.localeCompare(b.format)),
  };
}

/** One chip per colour-ish variant-defining value, with its own stock state. */
function swatches(row: ProductCardRow): ProductSwatchDto[] {
  const byValue = new Map<string, ProductSwatchDto>();

  for (const variant of row.variants) {
    const available = isVariantAvailable(variant, row);

    for (const link of variant.attributeValues) {
      if (!link.attribute.showInSwatch) continue;

      const existing = byValue.get(link.attributeValueId);
      if (existing) {
        existing.isInStock = existing.isInStock || available;
        continue;
      }

      byValue.set(link.attributeValueId, {
        attributeValueId: link.attributeValueId,
        label: link.attributeValue.label,
        colorHex: link.attributeValue.colorHex,
        swatchMediaId: link.attributeValue.swatchMediaId,
        isInStock: available,
      });
    }
  }

  return [...byValue.values()];
}

function stockOf(row: ProductCardRow): { inStock: boolean; stockStatus: string } {
  if (row.isMadeToOrder) return { inStock: true, stockStatus: 'MADE_TO_ORDER' };

  const sellable = row.variants.filter((variant) => isVariantAvailable(variant, row));

  if (sellable.length === 0) return { inStock: false, stockStatus: 'OUT_OF_STOCK' };
  return { inStock: true, stockStatus: sellable[0]!.stockStatus };
}

export interface CardPricing {
  pricePaise: number;
  indexed: PriceIndexEntry;
  relevanceScore?: number;
}

export function toProductCard(
  row: ProductCardRow,
  pricing: CardPricing,
  merchandising: MerchandisingContext,
): ProductCardDto {
  const primary = row.categories[0]?.category ?? null;
  const { inStock, stockStatus } = stockOf(row);

  const compareAt =
    row.compareAtPricePaise !== null && row.compareAtPricePaise > pricing.pricePaise
      ? row.compareAtPricePaise
      : null;
  const savingsPaise = compareAt === null ? 0 : compareAt - pricing.pricePaise;
  const isNewArrival = isNewArrivalAt(row, merchandising);
  const isFeatured = isFeaturedAt(row, merchandising.now);

  return {
    id: row.id,
    slug: row.slug,
    sku: row.sku,
    name: row.name,
    subtitle: row.subtitle,
    shortDescription: row.shortDescription,
    brandId: row.brandId,
    brandName: row.brand?.name ?? null,
    primaryCategorySlug: primary?.slug ?? null,
    primaryCategoryName: primary?.name ?? null,
    image: primaryImage(row),
    currency: 'INR',
    pricePaise: pricing.pricePaise,
    indexedMinPricePaise: pricing.indexed.minPricePaise,
    indexedMaxPricePaise: pricing.indexed.maxPricePaise,
    compareAtPricePaise: compareAt,
    savingsPaise,
    savingsPercentBp: compareAt === null ? 0 : savingsPercentBp(compareAt, pricing.pricePaise),
    priceNote: row.priceNote,
    inStock,
    stockStatus,
    isMadeToOrder: row.isMadeToOrder,
    leadTimeDays: row.leadTimeDays,
    allowCustomization: row.allowCustomization,
    manufacturedInHouse: row.manufacturedInHouse,
    ratingAvgBp: row.ratingAvgBp,
    ratingCount: row.ratingCount,
    soldCount: row.soldCount,
    isNewArrival,
    isFeatured,
    isBestSeller: row.isBestSeller,
    badges: badgesFor(
      {
        customText: row.badgeText,
        customColor: row.badgeColor,
        newArrival: isNewArrival,
        sale: savingsPaise > 0,
        bestSeller: row.isBestSeller,
        featured: isFeatured,
        specialCollection: row.isSpecialCollection,
        madeToOrder: row.isMadeToOrder,
        customizable: row.allowCustomization,
        inHouse: row.manufacturedInHouse,
      },
      merchandising,
    ),
    variantCount: row.variants.length,
    swatches: swatches(row),
    ...(pricing.relevanceScore === undefined ? {} : { relevanceScore: pricing.relevanceScore }),
  };
}
