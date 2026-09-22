import type { BulkActionType, Permission } from '@shared/enums';
import type { BulkActionInput } from '@shared/schemas/catalogAdmin';
import type { BulkActionItemResultDto, BulkActionResultDto } from '@shared/types/catalogAdmin';

import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/AppError';

import { catalogCacheService } from './catalogCache.service';
import { inventoryService } from './inventory.service';
import { productAdminService } from './product.admin.service';

/**
 * One endpoint for "do this to these 40 products".
 *
 * Deliberately not all-or-nothing: each id is attempted independently and reported on, because a
 * single unpublishable product should not stop the other 39 from being deactivated.
 */

const ACTION_PERMISSIONS: Record<BulkActionType, Permission> = {
  ACTIVATE: 'catalog.product.update',
  DEACTIVATE: 'catalog.product.update',
  PUBLISH: 'catalog.product.publish',
  UNPUBLISH: 'catalog.product.publish',
  DELETE: 'catalog.product.delete',
  RESTORE: 'catalog.product.update',
  MOVE_CATEGORY: 'catalog.product.update',
  ASSIGN_COLLECTION: 'catalog.collection.update',
  SET_TAX_CLASS: 'pricing.tax.update',
  SET_BRAND: 'catalog.product.update',
  ADJUST_STOCK: 'catalog.inventory.update',
};

export function permissionFor(action: BulkActionType): Permission {
  return ACTION_PERMISSIONS[action];
}

export const bulkActionService = {
  permissionFor,

  async run(input: BulkActionInput, actorId: string | null): Promise<BulkActionResultDto> {
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
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    await catalogCacheService.invalidateAll();

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
    case 'ACTIVATE':
    case 'DEACTIVATE': {
      await prisma.product.update({
        where: { id },
        data: {
          status: input.action === 'ACTIVATE' ? 'ACTIVE' : 'DRAFT',
          version: { increment: 1 },
        },
      });
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
      await productAdminService.setCategories(id, {
        primaryCategoryId: input.categoryId!,
        categoryIds: [],
      });
      return;
    }

    case 'ASSIGN_COLLECTION': {
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
      await prisma.product.update({
        where: { id },
        data: { taxClassId: input.taxClassId!, version: { increment: 1 } },
      });
      return;
    }

    case 'SET_BRAND': {
      await prisma.product.update({
        where: { id },
        data: { brandId: input.brandId!, version: { increment: 1 } },
      });
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
