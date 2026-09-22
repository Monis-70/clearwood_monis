import type { Media } from '@prisma/client';

import type {
  DeviceTarget,
  MediaKind,
  MediaRole,
  ProductStatus,
  ProductType,
  StockStatus,
  Visibility,
} from '@shared/enums';
import { resolveVariantBasePricePaise } from '@shared/money';
import type {
  MediaDto,
  ProductDetail,
  ProductMediaDto,
  ProductSummary,
  VariantDto,
} from '@shared/types/catalog';

import { storage } from '../container';
import {
  productRepository,
  type ProductWithDetail,
  type ProductWithSummary,
} from '../repositories/product.repository';
import { AppError } from '../utils/AppError';

/** Media URLs always come from the active StorageDriver — never hardcoded, never stored twice. */
export function toMediaDto(media: Media): MediaDto {
  return {
    id: media.id,
    kind: media.kind as MediaKind,
    url: media.url ?? storage.url(media.path),
    mimeType: media.mimeType,
    altText: media.altText,
    title: media.title,
    width: media.width,
    height: media.height,
    blurhash: media.blurhash,
  };
}

export function toProductSummary(product: ProductWithSummary | ProductWithDetail): ProductSummary {
  const primary = product.media.find((row) => row.role === 'PRIMARY') ?? product.media[0];

  return {
    id: product.id,
    sku: product.sku,
    slug: product.slug,
    name: product.name,
    subtitle: product.subtitle,
    shortDescription: product.shortDescription,
    productType: product.productType as ProductType,
    status: product.status as ProductStatus,
    visibility: product.visibility as Visibility,
    basePricePaise: product.basePricePaise,
    compareAtPricePaise: product.compareAtPricePaise,
    isMadeToOrder: product.isMadeToOrder,
    allowCustomization: product.allowCustomization,
    isFeatured: product.isFeatured,
    isNewArrival: product.isNewArrival,
    isSpecialCollection: product.isSpecialCollection,
    isBestSeller: product.isBestSeller,
    ratingAvgBp: product.ratingAvgBp,
    ratingCount: product.ratingCount,
    primaryMedia: primary ? toMediaDto(primary.media) : null,
  };
}

function toVariantDto(
  variant: ProductWithDetail['variants'][number],
  basePricePaise: number,
): VariantDto {
  return {
    id: variant.id,
    sku: variant.sku,
    name: variant.name,
    pricePaise: variant.pricePaise,
    compareAtPricePaise: variant.compareAtPricePaise,
    effectiveBasePricePaise: resolveVariantBasePricePaise(variant.pricePaise, basePricePaise),
    position: variant.position,
    isDefault: variant.isDefault,
    isActive: variant.isActive,
    stockQty: variant.stockQty,
    stockStatus: variant.stockStatus as StockStatus,
    leadTimeDays: variant.leadTimeDays,
    attributes: variant.attributeValues.map((row) => ({
      attributeId: row.attributeId,
      attributeCode: row.attribute.code,
      attributeValueId: row.attributeValueId,
      valueCode: row.attributeValue.code,
      valueLabel: row.attributeValue.label,
    })),
  };
}

function toProductMediaDto(row: ProductWithDetail['media'][number]): ProductMediaDto {
  return {
    ...toMediaDto(row.media),
    altText: row.altText ?? row.media.altText,
    role: row.role as MediaRole,
    position: row.position,
    deviceTarget: row.deviceTarget as DeviceTarget,
    attributeValueId: row.attributeValueId,
    variantId: row.variantId,
  };
}

function specValue(row: ProductWithDetail['attributeValues'][number]): string {
  if (row.attributeValue) return row.attributeValue.label;
  if (row.valueText !== null) return row.valueText;
  if (row.valueNumber !== null) return String(row.valueNumber);
  if (row.valueBoolean !== null) return row.valueBoolean ? 'Yes' : 'No';
  return '';
}

export function toProductDetail(product: ProductWithDetail): ProductDetail {
  return {
    ...toProductSummary(product),
    primaryMedia: (() => {
      const primary = product.media.find((row) => row.role === 'PRIMARY') ?? product.media[0];
      return primary ? toMediaDto(primary.media) : null;
    })(),
    description: product.description,
    brandId: product.brandId,
    taxClassId: product.taxClassId,
    leadTimeDays: product.leadTimeDays,
    manufacturedInHouse: product.manufacturedInHouse,
    manufacturingNote: product.manufacturingNote,
    warrantyMonths: product.warrantyMonths,
    careInstructions: product.careInstructions,
    assemblyRequired: product.assemblyRequired,
    weightGrams: product.weightGrams,
    lengthMm: product.lengthMm,
    widthMm: product.widthMm,
    heightMm: product.heightMm,
    seatHeightMm: product.seatHeightMm,
    minOrderQty: product.minOrderQty,
    maxOrderQty: product.maxOrderQty,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    seoKeywords: product.seoKeywords,
    categories: product.categories.map((row) => ({
      id: row.category.id,
      name: row.category.name,
      slug: row.category.slug,
      depth: row.category.depth,
    })),
    specs: product.attributeValues.map((row) => ({
      attributeCode: row.attribute.code,
      label: row.attribute.name,
      value: specValue(row),
    })),
    variants: product.variants.map((variant) => toVariantDto(variant, product.basePricePaise)),
    media: product.media.map(toProductMediaDto),
  };
}

export const productService = {
  /** TODO(Prompt 7): the storefront PDP endpoint will call this; Prompt 2 only proves the mapping. */
  async getBySlug(slug: string, includeUnpublished = false): Promise<ProductDetail> {
    const product = await productRepository.findBySlug(slug, includeUnpublished);
    if (!product) throw AppError.notFound(`Product "${slug}" not found`, { slug });
    return toProductDetail(product);
  },
};
