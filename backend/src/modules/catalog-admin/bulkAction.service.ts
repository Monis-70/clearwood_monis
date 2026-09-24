import type { BulkActionType, Permission } from '@shared/enums';
import type { BulkActionInput } from '@shared/schemas/catalogAdmin';
import type { BulkActionItemResultDto, BulkActionResultDto } from '@shared/types/catalogAdmin';

import { prisma } from '../../config/prisma';
import { catalogEvents } from '../../events/catalogEvents';
import { AppError } from '../../utils/AppError';

import { catalogCacheService } from './catalogCache.service';
import { inventoryService } from './inventory.service';
import { assertPurchasableCategories, productAdminService } from './product.admin.service';

/**
 * One endpoint for "do this to these 40 products".
 *
 * Deliberately not all-or-nothing: each id is attempted independently and reported on, because a
 * single unpublishable product should not stop the other 39 from being deactivated.
 */

const ACTION_PERMISSIONS: Record<BulkActionType, Permission> = {
  ACTIVATE: 'catalog.product.publish',
  DEACTIVATE: 'catalog.product.update',
  PUBLISH: 'catalog.product.publish',
  UNPUBLISH: 'catalog.product.publish',
  DELETE: 'catalog.product.delete',
  RESTORE: 'catalog.product.update',
  MOVE_CATEGORY: 'catalog.product.update',
  ADD_CATEGORY: 'catalog.product.update',
  REMOVE_CATEGORY: 'catalog.product.update',
  ASSIGN_COLLECTION: 'catalog.collection.update',
  SET_TAX_CLASS: 'pricing.tax.update',
  SET_BRAND: 'catalog.product.update',
  SET_MERCHANDISING: 'catalog.product.update',
  ADJUST_STOCK: 'catalog.inventory.update',
};

export function permissionFor(action: BulkActionType): Permission {
  return ACTION_PERMISSIONS[action];
}

/**
 * Actions written here without announcing each product; the batch announces the ones that
 * succeeded. PUBLISH, UNPUBLISH, DELETE and RESTORE go through services that announce themselves.
 */
const DIRECT_PRODUCT_WRITES = new Set<BulkActionType>([
  'ACTIVATE',
  'DEACTIVATE',
  'MOVE_CATEGORY',
  'ADD_CATEGORY',
  'REMOVE_CATEGORY',
  'ASSIGN_COLLECTION',
  'SET_TAX_CLASS',
  'SET_BRAND',
  'SET_MERCHANDISING',
]);

/** The action's target is checked once, so 500 ids cannot produce 500 identical errors. */
async function assertTarget(input: BulkActionInput): Promise<void> {
  if (input.categoryId) {
    const category = await prisma.category.findFirst({
      where: { id: input.categoryId, deletedAt: null },
      select: { id: true, kind: true },
    });
    if (!category) throw AppError.validation('Unknown category', { categoryId: input.categoryId });
    // Refused once for the batch, not once per id (removing a stray link stays possible).
    if (input.action === 'ADD_CATEGORY' || input.action === 'MOVE_CATEGORY') {
      assertPurchasableCategories([category]);
    }
  }
  if (input.action === 'ASSIGN_COLLECTION' && input.collectionId) {
    const collection = await prisma.collection.findFirst({
      where: { id: input.collectionId, deletedAt: null },
      select: { type: true },
    });
    if (!collection) {
      throw AppError.validation('Unknown collection', { collectionId: input.collectionId });
    }
    if (collection.type !== 'MANUAL') {
      throw new AppError(
        409,
        'COLLECTION_NOT_MANUAL',
        'An automatic collection is defined by its rules, not by a product list',
        { collectionId: input.collectionId, type: collection.type },
      );
    }
  }
  if (input.action === 'SET_BRAND' && input.brandId) {
    const brand = await prisma.brand.findFirst({
      where: { id: input.brandId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw AppError.validation('Unknown brand', { brandId: input.brandId });
  }
  if (input.action === 'SET_TAX_CLASS' && input.taxClassId) {
    const taxClass = await prisma.taxClass.findFirst({
      where: { id: input.taxClassId, deletedAt: null },
      select: { id: true },
    });
    if (!taxClass) throw AppError.validation('Unknown tax class', { taxClassId: input.taxClassId });
  }
}

export const bulkActionService = {
  permissionFor,

  async run(input: BulkActionInput, actorId: string | null): Promise<BulkActionResultDto> {
    await assertTarget(input);
    const results: BulkActionItemResultDto[] = [];

    for (const id of input.ids) {
      try {
        await applyOne(input, id, actorId);
        results.push({ id, ok: true, code: null, message: null });
      } catch (error) {
        results.push({
          id,
          ok: false,
          code: error instanceof AppError ? error.code : 'UNEXPECTED_ERROR',
          // Never echo a driver's message (it can carry SQL); AppErrors are written for people.
          message: error instanceof AppError ? error.message : 'The change could not be applied',
        });
      }
    }

    // One targeted drop for the batch: product and storefront payloads, not every cache.
    await catalogCacheService.invalidateProduct();
    if (input.action === 'ASSIGN_COLLECTION') await catalogCacheService.invalidateCollection();

    if (DIRECT_PRODUCT_WRITES.has(input.action)) {
      for (const result of results) {
        if (result.ok) {
          catalogEvents.emit('product.changed', {
            productId: result.id,
            reason: `bulk-${input.action.toLowerCase()}`,
          });
        }
      }
    }

    const succeeded = results.filter((result) => result.ok).length;

    return {
      action: input.action,
      requested: input.ids.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    };
  },
};

async function applyOne(input: BulkActionInput, id: string, actorId: string | null): Promise<void> {
  switch (input.action) {
    case 'ACTIVATE': {
      await productAdminService.activate(id);
      return;
    }

    case 'DEACTIVATE': {
      const { count } = await prisma.product.updateMany({
        where: { id, deletedAt: null },
        data: { status: 'DRAFT', version: { increment: 1 } },
      });
      if (count === 0) throw AppError.notFound('Product not found', { id });
      return;
    }

    case 'PUBLISH': {
      await productAdminService.publish(id);
      return;
    }

    case 'UNPUBLISH': {
      await productAdminService.unpublish(id);
      return;
    }

    case 'DELETE': {
      await productAdminService.softDelete(id);
      return;
    }

    case 'RESTORE': {
      await productAdminService.restore(id);
      return;
    }

    case 'MOVE_CATEGORY': {
      await productAdminService.applyCategories(id, {
        primaryCategoryId: input.categoryId!,
        categoryIds: [],
      });
      await productAdminService.refreshCompleteness(id);
      return;
    }

    case 'ADD_CATEGORY': {
      const current = await productAdminService.currentCategories(id);
      await productAdminService.applyCategories(id, {
        primaryCategoryId: current.primaryCategoryId ?? input.categoryId!,
        categoryIds: [...current.categoryIds, input.categoryId!],
      });
      await productAdminService.refreshCompleteness(id);
      return;
    }

    case 'REMOVE_CATEGORY': {
      const current = await productAdminService.currentCategories(id);
      if (!current.categoryIds.includes(input.categoryId!)) return;
      if (current.primaryCategoryId === input.categoryId || !current.primaryCategoryId) {
        throw new AppError(
          409,
          'CATEGORY_IS_PRIMARY',
          'Choose another primary category before removing this one',
          { productId: id, categoryId: input.categoryId },
        );
      }
      await productAdminService.applyCategories(id, {
        primaryCategoryId: current.primaryCategoryId,
        categoryIds: current.categoryIds.filter((categoryId) => categoryId !== input.categoryId),
      });
      return;
    }

    case 'ASSIGN_COLLECTION': {
      const product = await prisma.product.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!product) throw AppError.notFound('Product not found', { id });
      await prisma.collectionProduct.upsert({
        where: {
          collectionId_productId: { collectionId: input.collectionId!, productId: id },
        },
        update: {},
        create: { collectionId: input.collectionId!, productId: id },
      });
      return;
    }

    case 'SET_TAX_CLASS': {
      const { count } = await prisma.product.updateMany({
        where: { id, deletedAt: null },
        data: { taxClassId: input.taxClassId!, version: { increment: 1 } },
      });
      if (count === 0) throw AppError.notFound('Product not found', { id });
      return;
    }

    case 'SET_BRAND': {
      const { count } = await prisma.product.updateMany({
        where: { id, deletedAt: null },
        data: { brandId: input.brandId!, version: { increment: 1 } },
      });
      if (count === 0) throw AppError.notFound('Product not found', { id });
      return;
    }

    case 'SET_MERCHANDISING': {
      await productAdminService.applyMerchandising(id, input.merchandising!);
      return;
    }

    case 'ADJUST_STOCK': {
      // Here `id` is a variant id — stock does not exist at product level.
      await inventoryService.adjust(
        id,
        { delta: input.delta!, reason: input.reason ?? 'MANUAL_ADJUSTMENT', note: 'Bulk action' },
        { actorType: 'ADMIN', actorId },
      );
      return;
    }
  }
}
