import { env } from '../../config/env';
import { cache } from '../../container';
import { settingRepository } from '../../repositories/setting.repository';
import { jsonColumn } from '../../utils/jsonColumn';
import { STOREFRONT_CACHE_PREFIXES } from '../catalog-admin/catalogCache.service';

/**
 * R9 — page sizes, the out-of-stock policy and the popularity weights are admin-driven, never
 * constants in a controller. Defaults exist only so a fresh database still boots.
 */

export interface PopularityWeights {
  views7d: number;
  cartAdds: number;
  purchases: number;
  wishlists: number;
  recencyDays: number;
}

export interface StorefrontSettings {
  defaultPageSize: number;
  maxPageSize: number;
  showOutOfStock: boolean;
  minSuggestFrequency: number;
  popularityWeights: PopularityWeights;
}

export const STOREFRONT_SETTING_DEFAULTS: StorefrontSettings = {
  defaultPageSize: 24,
  maxPageSize: 96,
  showOutOfStock: true,
  minSuggestFrequency: 2,
  popularityWeights: { views7d: 1, cartAdds: 5, purchases: 20, wishlists: 3, recencyDays: 30 },
};

const weightsColumn = jsonColumn<Partial<PopularityWeights>>(
  undefined,
  'search.popularity_weights',
);

export const settingsService = {
  async read(): Promise<StorefrontSettings> {
    const key = `${STOREFRONT_CACHE_PREFIXES.settings}v1`;
    const cached = await cache.get<StorefrontSettings>(key);
    if (cached) return cached;

    const rows = [
      ...(await settingRepository.findByGroup('catalog')),
      ...(await settingRepository.findByGroup('search')),
    ];
    const byKey = new Map(rows.map((row) => [row.key, row.value]));

    const num = (settingKey: string, fallback: number): number => {
      const value = Number(byKey.get(settingKey));
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    const bool = (settingKey: string, fallback: boolean): boolean => {
      const value = byKey.get(settingKey);
      return value === undefined ? fallback : value === 'true' || value === '1';
    };

    const settings: StorefrontSettings = {
      defaultPageSize: num(
        'catalog.default_page_size',
        STOREFRONT_SETTING_DEFAULTS.defaultPageSize,
      ),
      maxPageSize: num('catalog.max_page_size', STOREFRONT_SETTING_DEFAULTS.maxPageSize),
      showOutOfStock: bool('catalog.show_out_of_stock', STOREFRONT_SETTING_DEFAULTS.showOutOfStock),
      minSuggestFrequency: num(
        'search.min_suggest_frequency',
        STOREFRONT_SETTING_DEFAULTS.minSuggestFrequency,
      ),
      popularityWeights: {
        ...STOREFRONT_SETTING_DEFAULTS.popularityWeights,
        ...weightsColumn.parse(byKey.get('search.popularity_weights'), {}),
      },
    };

    await cache.set(key, settings, env.STOREFRONT_CACHE_TTL_SECONDS);
    return settings;
  },
};
