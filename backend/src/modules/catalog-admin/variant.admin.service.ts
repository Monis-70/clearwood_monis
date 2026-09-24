import type { Prisma, ProductVariant } from '@prisma/client';

import type {
  VariantCreateInput,
  VariantListQuery,
  VariantUpdateInput,
  ReorderInput,
} from '@shared/schemas/catalogAdmin';
import type { AdminVariantDto } from '@shared/types/catalogAdmin';

import { prisma } from '../../config/prisma';
import { productRepository } from '../../repositories/product.repository';
import { updateVersioned } from '../../repositories/versioned';
import { categoryAttributeService } from '../../services/categoryAttribute.service';
import { AppError } from '../../utils/AppError';
import { isUniqueViolation } from '../../utils/prismaErrors';
import { mark } from '../../utils/uniqueMark';

import { catalogCacheService } from './catalogCache.service';
import { inventoryService, stockStatusFor } from './inventory.service';
import { nextFreeVariantSku } from './product.admin.service';
import { combinationKeyOf, type OptionPair } from './variantOptions';

/** Variant CRUD. Stock is never written here — it goes through InventoryService. */

type VariantRow = ProductVariant & {
  attributeValues: { attributeId: string; attributeValueId: string }[];
};

export function toVariantDto(variant: VariantRow): AdminVariantDto {
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

async function loadOrThrow(productId: string, variantId: string): Promise<VariantRow> {
  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, productId, deletedAt: null },
    include: { attributeValues: true },
  });
  if (!variant) throw AppError.notFound('Variant not found', { productId, variantId });
  return variant;
}

/** At most one default per product: the old mark is cleared before a new one is set. */
async function clearDefault(
  tx: Prisma.TransactionClient,
  productId: string,
  keepId?: string,
): Promise<void> {
  await tx.productVariant.updateMany({
    where: { productId, defaultMark: true, ...(keepId ? { id: { not: keepId } } : {}) },
    data: { isDefault: false, defaultMark: null },
  });
}

/**
 * The options a variant may carry: one value per attribute; attributes that are active and
 * variant-defining for this product (globally, or through its primary category's mapping); active
 * values that belong to them; and the same attributes as every sibling variant with options, so
 * the storefront's option matrix stays a grid.
 */
export async function assertVariantOptions(
  tx: Prisma.TransactionClient,
  productId: string,
  pairs: OptionPair[],
  exceptVariantId?: string,
): Promise<void> {
  if (pairs.length === 0) return;

  const attributeIds = pairs.map((pair) => pair.attributeId);
  if (new Set(attributeIds).size !== attributeIds.length) {
    throw AppError.validation('A variant takes one value per attribute', { attributeIds });
  }

  const values = await tx.attributeValue.findMany({
    where: {
      id: { in: pairs.map((pair) => pair.attributeValueId) },
      deletedAt: null,
      isActive: true,
    },
    select: { id: true, attributeId: true },
  });
  const owner = new Map(values.map((value) => [value.id, value.attributeId]));
  const invalid = pairs.filter((pair) => owner.get(pair.attributeValueId) !== pair.attributeId);

  if (invalid.length > 0) {
    throw AppError.validation('That value does not belong to the attribute, or is inactive', {
      pairs: invalid,
    });
  }

  const attributes = await tx.attribute.findMany({
    where: { id: { in: attributeIds }, deletedAt: null, isActive: true },
    select: { id: true, name: true, isVariantDefining: true },
  });
  if (attributes.length !== attributeIds.length) {
    const known = new Set(attributes.map((attribute) => attribute.id));
    throw AppError.validation('Unknown or inactive attribute', {
      attributeIds: attributeIds.filter((id) => !known.has(id)),
    });
  }

  const notGlobal = attributes.filter((attribute) => !attribute.isVariantDefining);
  if (notGlobal.length > 0) {
    const primary = await tx.productCategory.findFirst({
      where: { productId, isPrimary: true },
      select: { categoryId: true },
    });
    const mapped = primary
      ? await categoryAttributeService.resolveForCategory(primary.categoryId)
      : [];
    const definingHere = new Set(
      mapped.filter((row) => row.isVariantDefiningForCategory).map((row) => row.id),
    );
    const refused = notGlobal.filter((attribute) => !definingHere.has(attribute.id));
    if (refused.length > 0) {
      throw new AppError(
        422,
        'ATTRIBUTE_NOT_VARIANT_DEFINING',
        `"${refused[0]!.name}" is not a variant-defining attribute for this product`,
        { attributeIds: refused.map((attribute) => attribute.id) },
      );
    }
  }

  const siblings = await tx.productVariant.findMany({
    where: {
      productId,
      deletedAt: null,
      ...(exceptVariantId ? { id: { not: exceptVariantId } } : {}),
      attributeValues: { some: {} },
    },
    select: { attributeValues: { select: { attributeId: true } } },
  });
  const shape = (ids: string[]) => [...ids].sort().join('|');
  const shapes = new Set(
    siblings.map((variant) => shape(variant.attributeValues.map((row) => row.attributeId))),
  );
  if (shapes.size > 0 && !shapes.has(shape(attributeIds))) {
    throw new AppError(
      422,
      'VARIANT_OPTIONS_INCONSISTENT',
      'Every variant of a product uses the same option attributes; use the variant matrix to change them',
      { expected: [...shapes][0]!.split('|'), received: attributeIds },
    );
  }
}

function combinationTaken(existing?: { id: string; sku: string }): AppError {
  return new AppError(
    409,
    'VARIANT_COMBINATION_EXISTS',
    'Another variant of this product already has exactly these options',
    existing ? { variantId: existing.id, sku: existing.sku } : null,
  );
}

export async function assertCombinationFree(
  tx: Prisma.TransactionClient,
  productId: string,
  combinationKey: string | null,
  exceptId?: string,
): Promise<void> {
  if (!combinationKey) return;

  const clash = await tx.productVariant.findFirst({
    where: { productId, combinationKey, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, sku: true },
  });
  if (clash) throw combinationTaken(clash);
}

/** A write that raced past the checks still hits the unique index; report it the same way. */
function asCombinationConflict(error: unknown): unknown {
  return isUniqueViolation(error, 'combinationKey') ? combinationTaken() : error;
}

export const variantAdminService = {
  toVariantDto,

  async list(productId: string, query: VariantListQuery): Promise<AdminVariantDto[]> {
    const variants = await prisma.productVariant.findMany({
      where: {
        productId,
        deletedAt: null,
        ...(query.includeInactive ? {} : { isActive: true }),
      },
      include: { attributeValues: true },
      orderBy: [{ position: 'asc' }, { sku: 'asc' }],
    });
    return variants.map(toVariantDto);
  },

  async create(productId: string, input: VariantCreateInput): Promise<AdminVariantDto> {
    const product = await prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, sku: true, isMadeToOrder: true },
    });
    if (!product) throw AppError.notFound('Product not found', { productId });

    const sku = await nextFreeVariantSku(input.sku ?? `${product.sku}-V`);
    const pairs: OptionPair[] = input.attributeValues.map((row) => ({
      attributeId: row.attributeId,
      attributeValueId: row.attributeValueId,
    }));
    const combinationKey = combinationKeyOf(pairs);

    const created = await productRepository
      .withProductLock(productId, async (tx) => {
        await assertVariantOptions(tx, productId, pairs);
        await assertCombinationFree(tx, productId, combinationKey);
        if (input.isDefault) await clearDefault(tx, productId);

        return tx.productVariant.create({
          data: {
            productId,
            sku,
            name: input.name ?? null,
            pricePaise: input.pricePaise ?? null,
            compareAtPricePaise: input.compareAtPricePaise ?? null,
            costPricePaise: input.costPricePaise ?? null,
            weightGrams: input.weightGrams ?? null,
            barcode: input.barcode ?? null,
            position: input.position,
            isDefault: input.isDefault,
            defaultMark: mark(input.isDefault),
            combinationKey,
            isActive: input.isActive,
            lowStockThreshold: input.lowStockThreshold,
            allowBackorder: input.allowBackorder,
            leadTimeDays: input.leadTimeDays ?? null,
            lengthMm: input.lengthMm ?? null,
            widthMm: input.widthMm ?? null,
            heightMm: input.heightMm ?? null,
            stockStatus: stockStatusFor({
              stockQty: 0,
              lowStockThreshold: input.lowStockThreshold,
              allowBackorder: input.allowBackorder,
              isMadeToOrder: product.isMadeToOrder,
            }),
            attributeValues: { createMany: { data: pairs } },
          },
          select: { id: true },
        });
      })
      .catch((error: unknown) => {
        throw asCombinationConflict(error);
      });

    if (input.openingStock) {
      await inventoryService.adjust(created.id, {
        delta: input.openingStock,
        reason: 'INITIAL_STOCK',
      });
    }

    await catalogCacheService.invalidateProduct(productId, 'variant-create');
    return toVariantDto(await loadOrThrow(productId, created.id));
  },

  async update(
    productId: string,
    variantId: string,
    input: VariantUpdateInput,
  ): Promise<AdminVariantDto> {
    const existing = await loadOrThrow(productId, variantId);
    const { version, attributeValues, sku, isDefault, ...rest } = input;

    if (sku && sku !== existing.sku) {
      const clash = await prisma.productVariant.count({ where: { sku, id: { not: variantId } } });
      if (clash > 0) throw AppError.conflict('That variant SKU is already in use', { sku });
    }

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }
    if (sku) data.sku = sku;
    if (isDefault !== undefined) {
      data.isDefault = isDefault;
      data.defaultMark = mark(isDefault);
    }

    const pairs: OptionPair[] | undefined = attributeValues?.map((row) => ({
      attributeId: row.attributeId,
      attributeValueId: row.attributeValueId,
    }));
    if (pairs) data.combinationKey = combinationKeyOf(pairs);

    if (rest.lowStockThreshold !== undefined || rest.allowBackorder !== undefined) {
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
        select: { isMadeToOrder: true },
      });
      data.stockStatus = stockStatusFor({
        stockQty: existing.stockQty,
        lowStockThreshold: rest.lowStockThreshold ?? existing.lowStockThreshold,
        allowBackorder: rest.allowBackorder ?? existing.allowBackorder,
        isMadeToOrder: product.isMadeToOrder,
      });
    }

    await productRepository
      .withProductLock(productId, async (tx) => {
        if (pairs) {
          await assertVariantOptions(tx, productId, pairs, variantId);
          await assertCombinationFree(tx, productId, combinationKeyOf(pairs), variantId);
        }
        if (isDefault) await clearDefault(tx, productId, variantId);

        // Inside the transaction, so a stale version also rolls back the default change above.
        await updateVersioned(tx.productVariant, 'Variant', variantId, version, data);

        if (pairs) {
          await tx.variantAttributeValue.deleteMany({ where: { variantId } });
          if (pairs.length > 0) {
            await tx.variantAttributeValue.createMany({
              data: pairs.map((pair) => ({ variantId, ...pair })),
            });
          }
        }
      })
      .catch((error: unknown) => {
        throw asCombinationConflict(error);
      });

    await catalogCacheService.invalidateProduct(productId, 'variant-update');
    return toVariantDto(await loadOrThrow(productId, variantId));
  },

  async setDefault(productId: string, variantId: string): Promise<AdminVariantDto> {
    await productRepository.withProductLock(productId, async (tx) => {
      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, productId, deletedAt: null },
        select: { id: true },
      });
      if (!variant) throw AppError.notFound('Variant not found', { productId, variantId });

      await clearDefault(tx, productId, variantId);
      await tx.productVariant.update({
        where: { id: variantId },
        data: { isDefault: true, defaultMark: true },
      });
    });

    await catalogCacheService.invalidateProduct(productId, 'variant-default');
    return toVariantDto(await loadOrThrow(productId, variantId));
  },

  async reorder(productId: string, input: ReorderInput): Promise<number> {
    await prisma.$transaction(
      input.items.map((item) =>
        prisma.productVariant.updateMany({
          where: { id: item.id, productId },
          data: { position: item.position },
        }),
      ),
    );
    await catalogCacheService.invalidateProduct(productId, 'variant-reorder');
    return input.items.length;
  },

  async remove(productId: string, variantId: string): Promise<void> {
    await productRepository.withProductLock(productId, async (tx) => {
      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, productId, deletedAt: null },
        select: { id: true, reservedQty: true },
      });
      if (!variant) throw AppError.notFound('Variant not found', { productId, variantId });

      if (variant.reservedQty > 0) {
        throw new AppError(409, 'VARIANT_RESERVED', 'This variant has reserved stock', {
          variantId,
          reservedQty: variant.reservedQty,
        });
      }

      // A deleted variant gives up its default mark and its options, so both can be reused.
      await tx.productVariant.update({
        where: { id: variantId },
        data: {
          deletedAt: new Date(),
          isActive: false,
          isDefault: false,
          defaultMark: null,
          combinationKey: null,
        },
      });
    });
    await catalogCacheService.invalidateProduct(productId, 'variant-delete');
  },
};
