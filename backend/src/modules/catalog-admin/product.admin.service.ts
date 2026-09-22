import type { Prisma } from '@prisma/client';

import type {
  ProductAttributeValuesInput,
  ProductCategoriesInput,
  ProductCreateInput,
  ProductDuplicateInput,
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
  type ProductForAdmin,
} from '../../repositories/product.repository';
import { updateVersioned } from '../../repositories/versioned';
import { categoryAttributeService } from '../../services/categoryAttribute.service';
import { AppError } from '../../utils/AppError';
import { jsonColumn } from '../../utils/jsonColumn';
import { ensureUniqueSlug, slugify } from '../../utils/slug';
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
  return {
    id: product.id,
    sku: product.sku,
    slug: product.slug,
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
    version: product.version,
    updatedAt: product.updatedAt.toISOString(),
    deletedAt: product.deletedAt?.toISOString() ?? null,
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
    isNewArrival: product.isNewArrival,
    isSpecialCollection: product.isSpecialCollection,
    isBestSeller: product.isBestSeller,
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

export const productAdminService = {
  computeCompleteness,
  expandCategorySelection,
  toDetailDto,

  async list(query: AdminProductQuery): Promise<PageResult<AdminProductSummaryDto>> {
    const page = await productRepository.listForAdmin(query);
    return { ...page, items: page.items.map(toSummaryDto) };
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
    await loadOrThrow(productId);

    const requested = await expandCategorySelection([
      input.primaryCategoryId,
      ...input.categoryIds,
    ]);

    const found = await prisma.category.findMany({
      where: { id: { in: requested }, deletedAt: null },
      select: { id: true },
    });
    const valid = new Set(found.map((row) => row.id));

    const missing = requested.filter((categoryId) => !valid.has(categoryId));
    if (missing.length > 0) {
      throw AppError.validation('Unknown category', { categoryIds: missing });
    }

    await prisma.$transaction(async (tx) => {
      await tx.productCategory.deleteMany({ where: { productId } });
      if (requested.length > 0) {
        await tx.productCategory.createMany({
          data: requested.map((categoryId, index) => ({
            productId,
            categoryId,
            isPrimary: categoryId === input.primaryCategoryId,
            position: index,
          })),
        });
      }
    });

    await this.refreshCompleteness(productId);
    await catalogCacheService.invalidateProduct(productId, 'categories');

    return this.get(productId);
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

    const targets = await prisma.product.findMany({
      where: { id: { in: input.relations.map((relation) => relation.relatedProductId) } },
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

  async publish(id: string): Promise<AdminProductDetailDto> {
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

    const now = new Date();
    await prisma.product.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        publishedAt: now,
        lastPublishedAt: now,
        publishBlockersJson: null,
        version: { increment: 1 },
      },
    });

    await this.refreshCompleteness(id);
    await catalogCacheService.invalidateProduct(id, 'publish');

    return this.get(id);
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
    await loadOrThrow(id);
    await productRepository.softDelete(id);
    await mediaUsageService.detachEntity('PRODUCT', id);
    await catalogCacheService.invalidateProductRemoved(id);
  },

  async restore(id: string): Promise<AdminProductDetailDto> {
    await productRepository.restore(id);
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
