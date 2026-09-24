import type { Prisma } from '@prisma/client';

import type { PublicationState } from '@shared/enums';
import type {
  MerchandisingInput,
  ProductAttributeValuesInput,
  ProductCategoriesInput,
  ProductCreateInput,
  ProductDuplicateInput,
  ProductPublishInput,
  ProductRelationsInput,
  ProductUpdateInput,
} from '@shared/schemas/catalogAdmin';
import type {
  AdminProductDetailDto,
  AdminProductSummaryDto,
  AdminVariantDto,
  CompletenessFactorDto,
  ProductCompletenessDto,
  ProductRelationDto,
  PublishBlockerDto,
} from '@shared/types/catalogAdmin';

import { prisma } from '../../config/prisma';
import { storage } from '../../container';
import type { PageResult } from '../../repositories/helpers';
import {
  productRepository,
  type AdminProductQuery,
  type ProductAdminRow,
  type ProductForAdmin,
} from '../../repositories/product.repository';
import { updateVersioned } from '../../repositories/versioned';
import { categoryAttributeService } from '../../services/categoryAttribute.service';
import { AppError } from '../../utils/AppError';
import { jsonColumn } from '../../utils/jsonColumn';
import { ensureUniqueSlug, slugify } from '../../utils/slug';
import { mark } from '../../utils/uniqueMark';
import { mediaUsageService } from '../media/media-usage.service';

import { catalogCacheService } from './catalogCache.service';
import { slugRedirectService } from './slugRedirect.service';

/**
 * Admin product CRUD, completeness scoring and the publish gate.
 *
 * Publishing is deliberately strict: a live product with a broken image, a deleted category or a
 * zero price is worse than an unpublished one, so every blocker is reported at once and stored on
 * the row so the UI can show them without a second call.
 */

const blockersColumn = jsonColumn<PublishBlockerDto[]>(undefined, 'Product.publishBlockersJson');

/** Fields that describe *this* product instance rather than its configuration. */
const NON_COPYABLE = [
  'id',
  'sku',
  'slug',
  'status',
  'publishedAt',
  'lastPublishedAt',
  'publishBlockersJson',
  'completenessScore',
  'soldCount',
  'ratingCount',
  'ratingAvgBp',
  'version',
  'createdAt',
  'updatedAt',
  'deletedAt',
] as const;

const COMPLETENESS_FACTORS: {
  key: string;
  label: string;
  weight: number;
  test: (product: ProductForAdmin) => boolean;
}[] = [
  { key: 'name', label: 'Name', weight: 5, test: (p) => p.name.trim().length >= 3 },
  {
    key: 'description',
    label: 'Description of at least 120 characters',
    weight: 15,
    test: (p) => (p.description ?? '').trim().length >= 120,
  },
  {
    key: 'primaryCategory',
    label: 'Primary category',
    weight: 10,
    test: (p) => p.categories.some((row) => row.isPrimary),
  },
  {
    key: 'primaryMedia',
    label: 'Primary image',
    weight: 15,
    test: (p) => p.media.some((row) => row.role === 'PRIMARY'),
  },
  {
    key: 'gallery',
    label: 'At least three gallery images',
    weight: 10,
    test: (p) => p.media.length >= 3,
  },
  { key: 'price', label: 'Base price', weight: 10, test: (p) => p.basePricePaise > 0 },
  { key: 'taxClass', label: 'Tax class', weight: 5, test: (p) => p.taxClassId !== null },
  {
    key: 'variants',
    label: 'At least one active variant',
    weight: 10,
    test: (p) =>
      p.productType === 'SIMPLE' ? true : p.variants.some((variant) => variant.isActive),
  },
  {
    key: 'dimensions',
    label: 'Dimensions',
    weight: 5,
    test: (p) => p.lengthMm !== null && p.widthMm !== null && p.heightMm !== null,
  },
  { key: 'warranty', label: 'Warranty', weight: 5, test: (p) => p.warrantyMonths !== null },
  {
    key: 'seo',
    label: 'SEO title and description',
    weight: 5,
    test: (p) => Boolean(p.seoTitle) && Boolean(p.seoDescription),
  },
  {
    key: 'searchKeywords',
    label: 'Search keywords',
    weight: 5,
    test: (p) => (p.searchKeywords ?? '').trim().length > 0,
  },
];

export function computeCompleteness(product: ProductForAdmin): ProductCompletenessDto {
  const factors: CompletenessFactorDto[] = COMPLETENESS_FACTORS.map((factor) => ({
    key: factor.key,
    label: factor.label,
    weight: factor.weight,
    satisfied: factor.test(product),
  }));

  const total = factors.reduce((sum, factor) => sum + factor.weight, 0);
  const earned = factors.reduce((sum, factor) => (factor.satisfied ? sum + factor.weight : sum), 0);

  return { score: Math.round((earned / total) * 100), factors };
}

function toVariantDto(variant: ProductForAdmin['variants'][number]): AdminVariantDto {
  return {
    id: variant.id,
    productId: variant.productId,
    sku: variant.sku,
    name: variant.name,
    pricePaise: variant.pricePaise,
    compareAtPricePaise: variant.compareAtPricePaise,
    costPricePaise: variant.costPricePaise,
    position: variant.position,
    isDefault: variant.isDefault,
    isActive: variant.isActive,
    stockQty: variant.stockQty,
    reservedQty: variant.reservedQty,
    availableQty: Math.max(0, variant.stockQty - variant.reservedQty),
    stockStatus: variant.stockStatus,
    lowStockThreshold: variant.lowStockThreshold,
    allowBackorder: variant.allowBackorder,
    barcode: variant.barcode,
    weightGrams: variant.weightGrams,
    leadTimeDays: variant.leadTimeDays,
    lengthMm: variant.lengthMm,
    widthMm: variant.widthMm,
    heightMm: variant.heightMm,
    attributeValues: variant.attributeValues.map((row) => ({
      attributeId: row.attributeId,
      attributeValueId: row.attributeValueId,
    })),
    version: variant.version,
    createdAt: variant.createdAt.toISOString(),
    updatedAt: variant.updatedAt.toISOString(),
  };
}

function toRelationDto(relation: ProductForAdmin['relations'][number]): ProductRelationDto {
  return {
    id: relation.id,
    relatedProductId: relation.relatedProductId,
    relatedProductName: relation.relatedProduct.name,
    relatedProductSku: relation.relatedProduct.sku,
    type: relation.type as ProductRelationDto['type'],
    position: relation.position,
  };
}

export function toSummaryDto(product: ProductForAdmin): AdminProductSummaryDto {
  const primaryMedia = product.media.find((row) => row.role === 'PRIMARY');
  return {
    id: product.id,
    sku: product.sku,
    // A deleted product's own slug is a placeholder; show the one it gave up.
    slug: product.deletedSlug ?? product.slug,
    name: product.name,
    status: product.status,
    productType: product.productType,
    visibility: product.visibility,
    brandId: product.brandId,
    taxClassId: product.taxClassId,
    basePricePaise: product.basePricePaise,
    completenessScore: product.completenessScore,
    variantCount: product.variants.length,
    mediaCount: product.media.length,
    totalStock: product.variants.reduce((sum, variant) => sum + variant.stockQty, 0),
    primaryCategoryId: product.categories.find((row) => row.isPrimary)?.categoryId ?? null,
    publishedAt: product.publishedAt?.toISOString() ?? null,
    lastPublishedAt: product.lastPublishedAt?.toISOString() ?? null,
    publication: publicationOf(product),
    isFeatured: product.isFeatured,
    isNewArrival: product.isNewArrival,
    allowCustomization: product.allowCustomization,
    thumbnailUrl: primaryMedia ? storage.url(primaryMedia.media.path) : null,
    createdAt: product.createdAt.toISOString(),
    version: product.version,
    updatedAt: product.updatedAt.toISOString(),
    deletedAt: product.deletedAt?.toISOString() ?? null,
  };
}

/** Where a product stands on the storefront, from the same fields the visibility rule reads. */
export function publicationOf(
  product: { status: string; publishedAt: Date | null; deletedAt: Date | null },
  now = new Date(),
): PublicationState {
  if (product.deletedAt || product.status === 'ARCHIVED') return 'ARCHIVED';
  if (product.status !== 'ACTIVE') return 'DRAFT';
  return product.publishedAt && product.publishedAt.getTime() > now.getTime()
    ? 'SCHEDULED'
    : 'LIVE';
}

/** The admin table row, from the compact list select - no variant or media graph is loaded. */
export function toAdminRowDto(row: ProductAdminRow): AdminProductSummaryDto {
  const thumb = row.media[0]?.media;
  const rendition =
    thumb?.variants.find((variant) => variant.format === 'WEBP') ?? thumb?.variants[0];
  return {
    id: row.id,
    sku: row.sku,
    slug: row.deletedSlug ?? row.slug,
    name: row.name,
    status: row.status,
    productType: row.productType,
    visibility: row.visibility,
    brandId: row.brandId,
    taxClassId: row.taxClassId,
    basePricePaise: row.basePricePaise,
    completenessScore: row.completenessScore,
    variantCount: row.variants.length,
    mediaCount: row._count.media,
    totalStock: row.variants.reduce((sum, variant) => sum + variant.stockQty, 0),
    primaryCategoryId: row.categories[0]?.categoryId ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    lastPublishedAt: row.lastPublishedAt?.toISOString() ?? null,
    publication: publicationOf(row),
    isFeatured: row.isFeatured,
    isNewArrival: row.isNewArrival,
    allowCustomization: row.allowCustomization,
    thumbnailUrl: rendition ? storage.url(rendition.path) : thumb ? storage.url(thumb.path) : null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export function toDetailDto(product: ProductForAdmin): AdminProductDetailDto {
  return {
    ...toSummaryDto(product),
    subtitle: product.subtitle,
    shortDescription: product.shortDescription,
    description: product.description,
    compareAtPricePaise: product.compareAtPricePaise,
    costPricePaise: product.costPricePaise,
    isMadeToOrder: product.isMadeToOrder,
    leadTimeDays: product.leadTimeDays,
    allowCustomization: product.allowCustomization,
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
    isFeatured: product.isFeatured,
    featuredUntil: product.featuredUntil?.toISOString() ?? null,
    isNewArrival: product.isNewArrival,
    isSpecialCollection: product.isSpecialCollection,
    isBestSeller: product.isBestSeller,
    badgeText: product.badgeText,
    badgeColor: product.badgeColor,
    minOrderQty: product.minOrderQty,
    maxOrderQty: product.maxOrderQty,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    seoKeywords: product.seoKeywords,
    searchKeywords: product.searchKeywords,
    categories: product.categories.map((row) => ({
      categoryId: row.categoryId,
      isPrimary: row.isPrimary,
      position: row.position,
    })),
    attributeValues: product.attributeValues.map((row) => ({
      attributeId: row.attributeId,
      attributeValueId: row.attributeValueId,
      valueText: row.valueText,
      valueNumber: row.valueNumber,
      valueBoolean: row.valueBoolean,
      position: row.position,
    })),
    variants: product.variants.map(toVariantDto),
    media: product.media.map((row) => ({
      id: row.id,
      mediaId: row.mediaId,
      role: row.role,
      position: row.position,
      deviceTarget: row.deviceTarget,
      attributeValueId: row.attributeValueId,
      variantId: row.variantId,
      url: storage.url(row.media.path),
      status: row.media.status,
    })),
    relations: product.relations.map(toRelationDto),
    priceAdjustmentIds: [],
    completeness: computeCompleteness(product),
    publishBlockers: blockersColumn.parse(product.publishBlockersJson, []),
  };
}

async function loadOrThrow(id: string): Promise<ProductForAdmin> {
  const product = await productRepository.findForAdmin(id);
  if (!product) throw AppError.notFound('Product not found', { id });
  return product;
}

/**
 * A product filed under a specific child ("Fabric Sofas") also belongs to its parent "All Sofas"
 * bucket. Exposed so the admin UI can preview the categories it is about to add.
 */
export async function expandCategorySelection(categoryIds: string[]): Promise<string[]> {
  if (categoryIds.length === 0) return [];

  const selected = await prisma.category.findMany({
    where: { id: { in: categoryIds }, deletedAt: null },
    select: { id: true, path: true },
  });

  const ancestorPaths = new Set<string>();
  for (const category of selected) {
    const segments = category.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      ancestorPaths.add(segments.slice(0, index).join('/'));
    }
  }

  const allBuckets =
    ancestorPaths.size === 0
      ? []
      : await prisma.category.findMany({
          where: { deletedAt: null, kind: 'ALL', parentId: { not: null } },
          select: { id: true, path: true },
        });

  const extra = allBuckets
    .filter((bucket) => {
      const parentPath = bucket.path.split('/').slice(0, -1).join('/');
      return ancestorPaths.has(parentPath) || ancestorPaths.has(bucket.path);
    })
    .map((bucket) => bucket.id);

  return [...new Set([...categoryIds, ...extra])];
}

/**
 * Contract work stays out of the purchasable catalog: a SERVICE category is a service line whose
 * page opens an enquiry form (its leadFormKey), so no product may be filed under one. Shared by
 * the admin API, bulk actions and CSV import.
 */
export function assertPurchasableCategories(categories: { id: string; kind: string }[]): void {
  const services = categories.filter((category) => category.kind === 'SERVICE');
  if (services.length > 0) {
    throw new AppError(
      422,
      'CATEGORY_NOT_PURCHASABLE',
      'A service category takes enquiries, not products',
      { categoryIds: services.map((category) => category.id) },
    );
  }
}

/**
 * Rewrites a product's category links inside the caller's transaction. `position` is the
 * product's place in each category's curated order: a category the product already had keeps
 * its position, a new one appends the product at the end. Used by the admin API and CSV import.
 */
export async function writeCategoryLinks(
  tx: Prisma.TransactionClient,
  productId: string,
  requested: string[],
  primaryCategoryId: string,
): Promise<void> {
  const current = await tx.productCategory.findMany({
    where: { productId },
    select: { categoryId: true, position: true },
  });
  const kept = new Map(current.map((row) => [row.categoryId, row.position]));
  const fresh = requested.filter((categoryId) => !kept.has(categoryId));
  const tails =
    fresh.length === 0
      ? []
      : await tx.productCategory.groupBy({
          by: ['categoryId'],
          where: { categoryId: { in: fresh } },
          _max: { position: true },
        });
  const appendAt = new Map(tails.map((row) => [row.categoryId, (row._max.position ?? -1) + 1]));

  await tx.productCategory.deleteMany({ where: { productId } });
  if (requested.length > 0) {
    await tx.productCategory.createMany({
      data: requested.map((categoryId) => ({
        productId,
        categoryId,
        isPrimary: categoryId === primaryCategoryId,
        primaryMark: mark(categoryId === primaryCategoryId),
        position: kept.get(categoryId) ?? appendAt.get(categoryId) ?? 0,
      })),
    });
  }
}

export const productAdminService = {
  computeCompleteness,
  expandCategorySelection,
  toDetailDto,

  async list(query: AdminProductQuery): Promise<PageResult<AdminProductSummaryDto>> {
    const page = await productRepository.listForAdmin(query);
    return { ...page, items: page.items.map(toAdminRowDto) };
  },

  async get(id: string): Promise<AdminProductDetailDto> {
    return toDetailDto(await loadOrThrow(id));
  },

  async create(input: ProductCreateInput): Promise<AdminProductDetailDto> {
    if (await productRepository.skuExists(input.sku)) {
      throw AppError.conflict('That SKU is already in use', { sku: input.sku });
    }

    const slug = await ensureUniqueSlug(productRepository, slugify(input.slug ?? input.name));
    await slugRedirectService.assertSlugFree('PRODUCT', slug, null);

    const { categoryIds, primaryCategoryId, ...fields } = input;

    const created = await productRepository.create({
      ...fields,
      slug,
      status: 'DRAFT',
      subtitle: fields.subtitle ?? null,
      shortDescription: fields.shortDescription ?? null,
      description: fields.description ?? null,
      brandId: fields.brandId ?? null,
      taxClassId: fields.taxClassId ?? null,
      compareAtPricePaise: fields.compareAtPricePaise ?? null,
      costPricePaise: fields.costPricePaise ?? null,
      leadTimeDays: fields.leadTimeDays ?? null,
      manufacturingNote: fields.manufacturingNote ?? null,
      featuredUntil: fields.featuredUntil ?? null,
      badgeText: fields.badgeText ?? null,
      badgeColor: fields.badgeColor ?? null,
      warrantyMonths: fields.warrantyMonths ?? null,
      careInstructions: fields.careInstructions ?? null,
      weightGrams: fields.weightGrams ?? null,
      lengthMm: fields.lengthMm ?? null,
      widthMm: fields.widthMm ?? null,
      heightMm: fields.heightMm ?? null,
      seatHeightMm: fields.seatHeightMm ?? null,
      maxOrderQty: fields.maxOrderQty ?? null,
      seoTitle: fields.seoTitle ?? null,
      seoDescription: fields.seoDescription ?? null,
      seoKeywords: fields.seoKeywords ?? null,
      searchKeywords: fields.searchKeywords ?? null,
    });

    if (primaryCategoryId) {
      await this.setCategories(created.id, {
        primaryCategoryId,
        categoryIds: categoryIds ?? [],
      });
    }

    await this.refreshCompleteness(created.id);
    await catalogCacheService.invalidateProduct(created.id, 'create');

    return this.get(created.id);
  },

  async update(id: string, input: ProductUpdateInput): Promise<AdminProductDetailDto> {
    const existing = await loadOrThrow(id);
    const { version, slug: requestedSlug, sku, ...rest } = input;

    if (sku && sku !== existing.sku && (await productRepository.skuExists(sku, id))) {
      throw AppError.conflict('That SKU is already in use', { sku });
    }

    let slug = existing.slug;
    if (requestedSlug && slugify(requestedSlug) !== existing.slug) {
      slug = await ensureUniqueSlug(productRepository, slugify(requestedSlug), id);
      await slugRedirectService.assertSlugFree('PRODUCT', slug, id);
    }

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }
    if (sku) data.sku = sku;
    if (slug !== existing.slug) data.slug = slug;

    await updateVersioned(prisma.product, 'Product', id, version, data);

    if (slug !== existing.slug) {
      await slugRedirectService.recordSlugChange('PRODUCT', id, existing.slug, slug);
    }

    await this.refreshCompleteness(id);
    await catalogCacheService.invalidateProduct(id, 'update');

    return this.get(id);
  },

  /** Exactly one primary category; "All X" buckets are added automatically. */
  async setCategories(
    productId: string,
    input: ProductCategoriesInput,
  ): Promise<AdminProductDetailDto> {
    await this.applyCategories(productId, input);

    await this.refreshCompleteness(productId);
    await catalogCacheService.invalidateProduct(productId, 'categories');

    return this.get(productId);
  },

  /**
   * Writes the category links without announcing them (bulk actions announce once per batch).
   * `position` is the product's place in that category's curated order, so a category the
   * product already had keeps its position and a new one appends it at the end.
   */
  async applyCategories(productId: string, input: ProductCategoriesInput): Promise<void> {
    const product = await prisma.product.findFirst({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw AppError.notFound('Product not found', { id: productId });

    const requested = await expandCategorySelection([
      input.primaryCategoryId,
      ...input.categoryIds,
    ]);

    const found = await prisma.category.findMany({
      where: { id: { in: requested }, deletedAt: null },
      select: { id: true, kind: true },
    });
    const valid = new Set(found.map((row) => row.id));

    const missing = requested.filter((categoryId) => !valid.has(categoryId));
    if (missing.length > 0) {
      throw AppError.validation('Unknown category', { categoryIds: missing });
    }
    assertPurchasableCategories(found);

    await productRepository.withProductLock(productId, (tx) =>
      writeCategoryLinks(tx, productId, requested, input.primaryCategoryId),
    );
  },

  /** The product's current links, primary first - what an additive bulk change starts from. */
  async currentCategories(
    productId: string,
  ): Promise<{ primaryCategoryId: string | null; categoryIds: string[] }> {
    const links = await prisma.productCategory.findMany({
      where: { productId },
      select: { categoryId: true, isPrimary: true },
      orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
    });
    return {
      primaryCategoryId: links.find((link) => link.isPrimary)?.categoryId ?? null,
      categoryIds: links.map((link) => link.categoryId),
    };
  },

  /** Merchandising flags and badge; no announcement (callers announce). */
  async applyMerchandising(productId: string, input: MerchandisingInput): Promise<void> {
    const data: Prisma.ProductUpdateManyMutationInput = { version: { increment: 1 } };
    if (input.isFeatured !== undefined) data.isFeatured = input.isFeatured;
    if (input.featuredUntil !== undefined) data.featuredUntil = input.featuredUntil;
    if (input.isNewArrival !== undefined) data.isNewArrival = input.isNewArrival;
    if (input.isBestSeller !== undefined) data.isBestSeller = input.isBestSeller;
    if (input.isSpecialCollection !== undefined) {
      data.isSpecialCollection = input.isSpecialCollection;
    }
    if (input.badgeText !== undefined) data.badgeText = input.badgeText;
    if (input.badgeColor !== undefined) data.badgeColor = input.badgeColor;

    const { count } = await prisma.product.updateMany({
      where: { id: productId, deletedAt: null },
      data,
    });
    if (count === 0) throw AppError.notFound('Product not found', { id: productId });
  },

  async setAttributeValues(
    productId: string,
    input: ProductAttributeValuesInput,
  ): Promise<AdminProductDetailDto> {
    await loadOrThrow(productId);

    await prisma.$transaction(async (tx) => {
      await tx.productAttributeValue.deleteMany({ where: { productId } });
      for (const value of input.values) {
        await tx.productAttributeValue.create({
          data: {
            productId,
            attributeId: value.attributeId,
            attributeValueId: value.attributeValueId ?? null,
            valueText: value.valueText ?? null,
            valueNumber: value.valueNumber ?? null,
            valueBoolean: value.valueBoolean ?? null,
            position: value.position,
          },
        });
      }
    });

    await this.refreshCompleteness(productId);
    await catalogCacheService.invalidateProduct(productId, 'attribute-values');

    return this.get(productId);
  },

  async setRelations(
    productId: string,
    input: ProductRelationsInput,
  ): Promise<AdminProductDetailDto> {
    await loadOrThrow(productId);

    if (input.relations.some((relation) => relation.relatedProductId === productId)) {
      throw AppError.validation('A product cannot relate to itself', { productId });
    }

    // The same product twice under one type is one relation, not two (and not a 500).
    const seen = new Set<string>();
    const repeated = input.relations.filter((relation) => {
      const key = `${relation.type}|${relation.relatedProductId}`;
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
    if (repeated.length > 0) {
      throw AppError.validation('A product is listed twice under the same relation type', {
        repeated: repeated.map(({ type, relatedProductId }) => ({ type, relatedProductId })),
      });
    }

    // A deleted product cannot be curated; a draft or hidden one may be (the storefront skips it).
    const targets = await prisma.product.findMany({
      where: {
        id: { in: input.relations.map((relation) => relation.relatedProductId) },
        deletedAt: null,
      },
      select: { id: true },
    });
    const known = new Set(targets.map((row) => row.id));
    const missing = input.relations
      .map((relation) => relation.relatedProductId)
      .filter((relatedId) => !known.has(relatedId));

    if (missing.length > 0) {
      throw AppError.validation('Unknown related product', { productIds: missing });
    }

    await prisma.$transaction(async (tx) => {
      await tx.productRelation.deleteMany({ where: { productId } });
      if (input.relations.length > 0) {
        await tx.productRelation.createMany({
          data: input.relations.map((relation) => ({
            productId,
            relatedProductId: relation.relatedProductId,
            type: relation.type,
            position: relation.position,
          })),
        });
      }

      // SIMILAR reads naturally in both directions, so it is mirrored automatically.
      for (const relation of input.relations.filter((row) => row.type === 'SIMILAR')) {
        await tx.productRelation.upsert({
          where: {
            productId_relatedProductId_type: {
              productId: relation.relatedProductId,
              relatedProductId: productId,
              type: 'SIMILAR',
            },
          },
          update: {},
          create: {
            productId: relation.relatedProductId,
            relatedProductId: productId,
            type: 'SIMILAR',
            position: relation.position,
          },
        });
      }
    });

    await catalogCacheService.invalidateProduct(productId, 'relations');
    return this.get(productId);
  },

  /**
   * Everything that must be true before a product may go live. All blockers are collected in one
   * pass so the editor can fix them together rather than one 422 at a time.
   */
  async publishBlockers(productId: string): Promise<PublishBlockerDto[]> {
    const product = await loadOrThrow(productId);
    const blockers: PublishBlockerDto[] = [];

    const add = (
      code: string,
      message: string,
      field?: string,
      details?: Record<string, unknown>,
    ) =>
      blockers.push({
        code,
        message,
        ...(field ? { field } : {}),
        ...(details ? { details } : {}),
      });

    if (await productRepository.skuExists(product.sku, product.id)) {
      add('DUPLICATE_SKU', `SKU "${product.sku}" is already used by another product`, 'sku');
    }
    if (await productRepository.slugExists(product.slug, product.id)) {
      add('DUPLICATE_SLUG', `Slug "${product.slug}" is already used by another product`, 'slug');
    }

    if (product.basePricePaise <= 0) {
      const anyVariantPriced = product.variants.some(
        (variant) => variant.isActive && (variant.pricePaise ?? 0) > 0,
      );
      if (!anyVariantPriced) {
        add(
          'INVALID_PRICE',
          'The effective base price must be greater than zero',
          'basePricePaise',
        );
      }
    }

    const primary = product.categories.find((row) => row.isPrimary);
    if (!primary) {
      add('NO_PRIMARY_CATEGORY', 'Choose a primary category', 'categories');
    } else {
      const category = await prisma.category.findUnique({ where: { id: primary.categoryId } });
      if (!category || category.deletedAt || !category.isActive) {
        add(
          'PRIMARY_CATEGORY_UNAVAILABLE',
          'The primary category is inactive or deleted',
          'categories',
          { categoryId: primary.categoryId },
        );
      }
    }

    if (!product.taxClassId) {
      add('NO_TAX_CLASS', 'Assign a tax class', 'taxClassId');
    } else if (product.taxClass && (!product.taxClass.isActive || product.taxClass.deletedAt)) {
      add('TAX_CLASS_INACTIVE', 'The assigned tax class is inactive', 'taxClassId', {
        taxClassId: product.taxClassId,
      });
    }

    if (product.brandId && product.brand && (!product.brand.isActive || product.brand.deletedAt)) {
      add('BRAND_INACTIVE', 'The assigned brand is inactive', 'brandId', {
        brandId: product.brandId,
      });
    }

    if (product.productType !== 'SIMPLE') {
      const active = product.variants.filter((variant) => variant.isActive);
      if (active.length === 0) {
        add(
          'NO_ACTIVE_VARIANT',
          product.variants.length === 0
            ? 'Add at least one variant'
            : 'Every variant is inactive — activate at least one',
          'variants',
          { variantCount: product.variants.length },
        );
      }
    }

    // Media must exist AND have finished processing, or the storefront would render a broken image.
    if (!product.media.some((row) => row.role === 'PRIMARY')) {
      add('NO_PRIMARY_MEDIA', 'Set a primary image', 'media');
    }
    const brokenMedia = product.media.filter(
      (row) => !row.media || row.media.deletedAt !== null || row.media.status !== 'READY',
    );
    if (brokenMedia.length > 0) {
      add('MEDIA_NOT_READY', 'Some images are missing or still processing', 'media', {
        mediaIds: brokenMedia.map((row) => row.mediaId),
      });
    }

    // Specs must belong to attributes the primary category actually resolves.
    if (primary && product.attributeValues.length > 0) {
      const resolved = await categoryAttributeService.resolveForCategory(primary.categoryId);
      const allowed = new Set(resolved.map((row) => row.id));
      const foreign = product.attributeValues.filter((row) => !allowed.has(row.attributeId));
      if (foreign.length > 0) {
        add(
          'INVALID_CATEGORY_ATTRIBUTES',
          'Some specifications do not belong to the primary category',
          'attributeValues',
          { attributeIds: [...new Set(foreign.map((row) => row.attributeId))] },
        );
      }
    }

    return blockers;
  },

  async publish(id: string, input: ProductPublishInput = {}): Promise<AdminProductDetailDto> {
    const blockers = await this.publishBlockers(id);

    await prisma.product.update({
      where: { id },
      data: { publishBlockersJson: blockersColumn.serialize(blockers) },
    });

    if (blockers.length > 0) {
      throw new AppError(422, 'PRODUCT_NOT_PUBLISHABLE', 'This product cannot be published yet', {
        productId: id,
        blockers,
      });
    }

    // A future publishAt schedules it: ACTIVE now, visible from then (the one visibility rule).
    const now = new Date();
    const goLive =
      input.publishAt && input.publishAt.getTime() > now.getTime() ? input.publishAt : now;
    await prisma.product.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        publishedAt: goLive,
        lastPublishedAt: now,
        publishBlockersJson: null,
        version: { increment: 1 },
      },
    });

    await this.refreshCompleteness(id);
    await catalogCacheService.invalidateProduct(id, 'publish');

    return this.get(id);
  },

  /**
   * Bulk ACTIVATE: the publish gate applies exactly as it does to a single publish - a draft that
   * was never published would otherwise go live with no image or no price. A product that was
   * published before keeps its publishedAt (a scheduled one stays scheduled).
   */
  async activate(id: string): Promise<void> {
    const product = await prisma.product.findUnique({
      where: { id },
      select: { deletedAt: true, publishedAt: true },
    });
    if (!product) throw AppError.notFound('Product not found', { id });
    if (product.deletedAt) {
      throw new AppError(409, 'PRODUCT_DELETED', 'Restore this product before activating it', {
        id,
      });
    }

    const blockers = await this.publishBlockers(id);
    if (blockers.length > 0) {
      await prisma.product.update({
        where: { id },
        data: { publishBlockersJson: blockersColumn.serialize(blockers) },
      });
      throw new AppError(422, 'PRODUCT_NOT_PUBLISHABLE', 'This product cannot be published yet', {
        productId: id,
        blockers,
      });
    }

    const now = new Date();
    await prisma.product.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        publishedAt: product.publishedAt ?? now,
        ...(product.publishedAt ? {} : { lastPublishedAt: now }),
        publishBlockersJson: null,
        version: { increment: 1 },
      },
    });
  },

  async unpublish(id: string): Promise<AdminProductDetailDto> {
    await loadOrThrow(id);
    await prisma.product.update({
      where: { id },
      data: { status: 'DRAFT', publishedAt: null, version: { increment: 1 } },
    });
    await catalogCacheService.invalidateProduct(id, 'unpublish');
    return this.get(id);
  },

  /**
   * Deep copy for "make another one like this".
   *
   * Copies the business configuration (pricing setup, dimensions, specs, variants, media links,
   * relations, price rules) and nothing that belongs to the original's life in the shop: the copy
   * starts as DRAFT with no publish history, no stock, no reservations and no sales or rating
   * counters. Every SKU and slug is regenerated collision-safely.
   */
  async duplicate(id: string, input: ProductDuplicateInput): Promise<AdminProductDetailDto> {
    const source = await loadOrThrow(id);

    const sku = await nextFreeSku(input.sku ?? `${source.sku}-COPY`);
    const name = input.name ?? `${source.name} (copy)`;
    const slug = await ensureUniqueSlug(productRepository, slugify(input.slug ?? name));

    // Read the row without relations: a relation key (even a null one) would turn the create into
    // a checked write and reject the scalar foreign keys we want to copy verbatim.
    const scalars = await prisma.product.findUniqueOrThrow({ where: { id } });

    const copyable: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(scalars)) {
      if ((NON_COPYABLE as readonly string[]).includes(key)) continue;
      copyable[key] = value;
    }

    const created = await prisma.product.create({
      data: {
        ...(copyable as Prisma.ProductUncheckedCreateInput),
        sku,
        slug,
        name,
        status: 'DRAFT',
        publishedAt: null,
        lastPublishedAt: null,
        publishBlockersJson: null,
        completenessScore: 0,
        soldCount: 0,
        ratingCount: 0,
        ratingAvgBp: 0,
        version: 0,
      },
      select: { id: true },
    });

    if (source.categories.length > 0) {
      await prisma.productCategory.createMany({
        data: source.categories.map((row) => ({
          productId: created.id,
          categoryId: row.categoryId,
          isPrimary: row.isPrimary,
          primaryMark: mark(row.isPrimary),
          position: row.position,
        })),
      });
    }

    for (const row of source.attributeValues) {
      await prisma.productAttributeValue.create({
        data: {
          productId: created.id,
          attributeId: row.attributeId,
          attributeValueId: row.attributeValueId,
          valueText: row.valueText,
          valueNumber: row.valueNumber,
          valueBoolean: row.valueBoolean,
          position: row.position,
        },
      });
    }

    const variantIdMap = new Map<string, string>();

    if (input.includeVariants) {
      for (const variant of source.variants) {
        const variantSku = await nextFreeVariantSku(`${variant.sku}-COPY`);
        const copy = await prisma.productVariant.create({
          data: {
            productId: created.id,
            sku: variantSku,
            name: variant.name,
            pricePaise: variant.pricePaise,
            compareAtPricePaise: variant.compareAtPricePaise,
            costPricePaise: variant.costPricePaise,
            weightGrams: variant.weightGrams,
            barcode: null,
            position: variant.position,
            isDefault: variant.isDefault,
            defaultMark: mark(variant.isDefault),
            // Keys depend only on the options, so the copy's are as unique as the source's.
            combinationKey: variant.combinationKey,
            isActive: variant.isActive,
            // Stock belongs to the original: the copy starts empty and gets its own ledger.
            stockQty: 0,
            reservedQty: 0,
            stockStatus: variant.allowBackorder ? 'PREORDER' : 'OUT_OF_STOCK',
            lowStockThreshold: variant.lowStockThreshold,
            allowBackorder: variant.allowBackorder,
            leadTimeDays: variant.leadTimeDays,
            lengthMm: variant.lengthMm,
            widthMm: variant.widthMm,
            heightMm: variant.heightMm,
          },
          select: { id: true },
        });

        variantIdMap.set(variant.id, copy.id);

        if (variant.attributeValues.length > 0) {
          await prisma.variantAttributeValue.createMany({
            data: variant.attributeValues.map((row) => ({
              variantId: copy.id,
              attributeId: row.attributeId,
              attributeValueId: row.attributeValueId,
            })),
          });
        }
      }
    }

    if (input.includeMedia) {
      for (const row of source.media) {
        await prisma.productMedia.create({
          data: {
            productId: created.id,
            mediaId: row.mediaId,
            role: row.role,
            primaryMark: mark(row.role === 'PRIMARY'),
            position: row.position,
            altText: row.altText,
            deviceTarget: row.deviceTarget,
            attributeValueId: row.attributeValueId,
            variantId: row.variantId ? (variantIdMap.get(row.variantId) ?? null) : null,
          },
        });
        await mediaUsageService.attach({
          mediaId: row.mediaId,
          usageType: 'PRODUCT',
          entityId: created.id,
        });
      }
    }

    if (input.includeRelations && source.relations.length > 0) {
      await prisma.productRelation.createMany({
        data: source.relations.map((row) => ({
          productId: created.id,
          relatedProductId: row.relatedProductId,
          type: row.type,
          position: row.position,
        })),
      });
    }

    if (input.includePriceAdjustments) {
      const adjustments = await prisma.priceAdjustment.findMany({
        where: { productId: id, deletedAt: null },
      });
      for (const adjustment of adjustments) {
        const {
          id: _id,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          version: _version,
          ...rest
        } = adjustment;
        await prisma.priceAdjustment.create({
          data: {
            ...rest,
            productId: created.id,
            variantId: rest.variantId ? (variantIdMap.get(rest.variantId) ?? null) : null,
          },
        });
      }
    }

    await this.refreshCompleteness(created.id);
    await catalogCacheService.invalidateProduct(created.id, 'duplicate');

    return this.get(created.id);
  },

  async refreshCompleteness(id: string): Promise<number> {
    const product = await productRepository.findForAdmin(id);
    if (!product) return 0;

    const { score } = computeCompleteness(product);
    await prisma.product.update({ where: { id }, data: { completenessScore: score } });
    return score;
  },

  async softDelete(id: string): Promise<void> {
    const product = await loadOrThrow(id);
    if (product.deletedAt) return;

    await productRepository.softDelete(id, product.slug);
    await mediaUsageService.detachEntity('PRODUCT', id);
    await catalogCacheService.invalidateProductRemoved(id);
  },

  /** Takes its old slug back when that is still free, otherwise the next free variant of it. */
  async restore(id: string): Promise<AdminProductDetailDto> {
    const product = await loadOrThrow(id);
    if (!product.deletedAt) return this.get(id);

    const slug = await ensureUniqueSlug(productRepository, product.deletedSlug ?? product.slug, id);
    await slugRedirectService.assertSlugFree('PRODUCT', slug, id);

    await productRepository.restore(id, slug);
    await catalogCacheService.invalidateProduct(id, 'restore');
    return this.get(id);
  },

  async hardDelete(id: string): Promise<void> {
    await loadOrThrow(id);
    await mediaUsageService.detachEntity('PRODUCT', id);

    // Price rules reference the product by plain id (no FK), so they must be cleared explicitly
    // or they linger as orphans the pricing engine would still load.
    const variantIds = (
      await prisma.productVariant.findMany({ where: { productId: id }, select: { id: true } })
    ).map((row) => row.id);

    await prisma.priceAdjustment.deleteMany({
      where: { OR: [{ productId: id }, { variantId: { in: variantIds } }] },
    });
    await prisma.tierPrice.deleteMany({
      where: { OR: [{ productId: id }, { variantId: { in: variantIds } }] },
    });
    await prisma.priceListItem.deleteMany({
      where: { OR: [{ productId: id }, { variantId: { in: variantIds } }] },
    });

    await productRepository.hardDelete(id);
    await catalogCacheService.invalidateProductRemoved(id);
  },
};

/** Appends -2, -3 … until the SKU is free, mirroring ensureUniqueSlug. */
async function nextFreeSku(base: string): Promise<string> {
  let candidate = base;
  let suffix = 2;

  while (await productRepository.skuExists(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function nextFreeVariantSku(base: string): Promise<string> {
  let candidate = base;
  let suffix = 2;

  while ((await prisma.productVariant.count({ where: { sku: candidate } })) > 0) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export { nextFreeSku, nextFreeVariantSku };
