import type { CatalogSettingsUpdateInput } from '@shared/schemas/catalogAdmin';
import type { AdminCatalogSettingsDto } from '@shared/types/catalogAdmin';

import { logger } from '../../config/logger';
import { settingWriteRepository } from '../../repositories/content.repository';
import { storefrontRepository } from '../../repositories/storefront.repository';
import { categoryService } from '../../services/category.service';
import { settingService } from '../../services/setting.service';
import { AppError } from '../../utils/AppError';
import { collectionRulesService } from '../storefront/collectionRules.service';
import { settingsService } from '../storefront/storefrontSettings.service';

import { catalogCacheService } from './catalogCache.service';

/**
 * R8 - the catalog's storefront settings, edited by an admin instead of a developer: page sizes,
 * the out-of-stock policy, the new-arrival window and the words on each card badge. Stored as
 * AppSetting rows (group `catalog`) and read back through storefrontSettings.service, the one
 * reader the listing, cards and product page share.
 */

const KEYS = {
  defaultPageSize: { key: 'catalog.default_page_size', valueType: 'number', isPublic: true },
  maxPageSize: { key: 'catalog.max_page_size', valueType: 'number', isPublic: false },
  showOutOfStock: { key: 'catalog.show_out_of_stock', valueType: 'boolean', isPublic: true },
  newArrivalDays: { key: 'catalog.new_arrival_days', valueType: 'number', isPublic: true },
  badges: { key: 'catalog.badges', valueType: 'json', isPublic: false },
} as const;

async function current(): Promise<AdminCatalogSettingsDto> {
  // Read past the cache: the admin must see what is stored, not what a worker still holds.
  const settings = await settingsService.load();
  return {
    defaultPageSize: settings.defaultPageSize,
    maxPageSize: settings.maxPageSize,
    showOutOfStock: settings.showOutOfStock,
    newArrivalDays: settings.newArrivalDays,
    badges: settings.badges,
  };
}

export const catalogSettingsService = {
  get: current,

  async update(input: CatalogSettingsUpdateInput): Promise<AdminCatalogSettingsDto> {
    const before = await current();

    const next = {
      defaultPageSize: input.defaultPageSize ?? before.defaultPageSize,
      maxPageSize: input.maxPageSize ?? before.maxPageSize,
    };
    if (next.defaultPageSize > next.maxPageSize) {
      throw AppError.validation('defaultPageSize cannot exceed maxPageSize', next);
    }

    const writes: [keyof typeof KEYS, string][] = [];
    if (input.defaultPageSize !== undefined) {
      writes.push(['defaultPageSize', String(input.defaultPageSize)]);
    }
    if (input.maxPageSize !== undefined) writes.push(['maxPageSize', String(input.maxPageSize)]);
    if (input.showOutOfStock !== undefined) {
      writes.push(['showOutOfStock', String(input.showOutOfStock)]);
    }
    if (input.newArrivalDays !== undefined) {
      writes.push(['newArrivalDays', String(input.newArrivalDays)]);
    }
    if (input.badges !== undefined) {
      // Merged per code: sending one badge does not switch the others off; null does.
      const merged: Record<string, { label: string; color: string | null }> = { ...before.badges };
      for (const [code, style] of Object.entries(input.badges)) {
        if (style === undefined) continue;
        if (style === null) delete merged[code];
        else merged[code] = style;
      }
      writes.push(['badges', JSON.stringify(merged)]);
    }

    for (const [field, value] of writes) {
      const { key, valueType, isPublic } = KEYS[field];
      await settingWriteRepository.upsert(key, value, valueType, 'catalog', isPublic);
    }

    await settingService.invalidate();
    await catalogCacheService.invalidateStorefrontSettings();
    // Badges and the new-arrival window are judged on every card, CMS blocks included.
    await catalogCacheService.invalidateCategoryMerchandising();

    if (input.newArrivalDays !== undefined && input.newArrivalDays !== before.newArrivalDays) {
      // What "new" means moved: rule categories' counts and automatic collections follow now.
      await categoryService.recomputeProductCounts();
      for (const collection of await storefrontRepository.findAutomaticCollectionIds()) {
        await collectionRulesService
          .evaluate(collection.id, { quiet: true })
          .catch((error: unknown) =>
            logger.warn(
              { err: error, collectionId: collection.id },
              'collection re-evaluation failed',
            ),
          );
      }
      await catalogCacheService.invalidateSchedule();
    }

    return current();
  },
};
