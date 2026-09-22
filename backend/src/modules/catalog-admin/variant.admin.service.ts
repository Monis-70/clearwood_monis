import type { ProductVariant } from '@prisma/client';

import type {
  VariantCreateInput,
  VariantListQuery,
  VariantUpdateInput,
  ReorderInput,
} from '@shared/schemas/catalogAdmin';
import type { AdminVariantDto } from '@shared/types/catalogAdmin';

import { prisma } from '../../config/prisma';
import { updateVersioned } from '../../repositories/versioned';
import { AppError } from '../../utils/AppError';

import { catalogCacheService } from './catalogCache.service';
import { inventoryService, stockStatusFor } from './inventory.service';
import { nextFreeVariantSku } from './product.admin.service';

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

/** Exactly one default per product, mirroring the PRIMARY media rule. */
async function demoteOtherDefaults(productId: string, keepId: string): Promise<void> {
  await prisma.productVariant.updateMany({
    where: { productId, id: { not: keepId }, isDefault: true },
    data: { isDefault: false },
  });
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

    const created = await prisma.productVariant.create({
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
        attributeValues: {
          createMany: {
            data: input.attributeValues.map((row) => ({
              attributeId: row.attributeId,
              attributeValueId: row.attributeValueId,
            })),
          },
        },
      },
      select: { id: true },
    });

    if (input.isDefault) await demoteOtherDefaults(productId, created.id);

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
    const { version, attributeValues, sku, ...rest } = input;

    if (sku && sku !== existing.sku) {
      const clash = await prisma.productVariant.count({ where: { sku, id: { not: variantId } } });
      if (clash > 0) throw AppError.conflict('That variant SKU is already in use', { sku });
    }

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }
    if (sku) data.sku = sku;

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

    await updateVersioned(prisma.productVariant, 'Variant', variantId, version, data);

    if (attributeValues) {
      await prisma.$transaction(async (tx) => {
        await tx.variantAttributeValue.deleteMany({ where: { variantId } });
        if (attributeValues.length > 0) {
          await tx.variantAttributeValue.createMany({
            data: attributeValues.map((row) => ({
              variantId,
              attributeId: row.attributeId,
              attributeValueId: row.attributeValueId,
            })),
          });
        }
      });
    }

    if (rest.isDefault) await demoteOtherDefaults(productId, variantId);

    await catalogCacheService.invalidateProduct(productId, 'variant-update');
    return toVariantDto(await loadOrThrow(productId, variantId));
  },

  async setDefault(productId: string, variantId: string): Promise<AdminVariantDto> {
    await loadOrThrow(productId, variantId);
    await prisma.productVariant.update({ where: { id: variantId }, data: { isDefault: true } });
    await demoteOtherDefaults(productId, variantId);
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
    const variant = await loadOrThrow(productId, variantId);

    if (variant.reservedQty > 0) {
      throw new AppError(409, 'VARIANT_RESERVED', 'This variant has reserved stock', {
        variantId,
        reservedQty: variant.reservedQty,
      });
    }

    await prisma.productVariant.update({
      where: { id: variantId },
      data: { deletedAt: new Date(), isActive: false, isDefault: false },
    });
    await catalogCacheService.invalidateProduct(productId, 'variant-delete');
  },
};
