import { isProductBadgeCode, type ProductBadgeCode } from '@shared/enums';

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

export interface BadgeStyle {
  label: string;
  color: string | null;
}

export interface StorefrontSettings {
  defaultPageSize: number;
  maxPageSize: number;
  showOutOfStock: boolean;
  minSuggestFrequency: number;
  popularityWeights: PopularityWeights;
  /** A product counts as new for this many days after it goes live; 0 = only the flag. */
  newArrivalDays: number;
  /** Which badges a card may show and their words. A code absent here is never shown. */
  badges: Partial<Record<ProductBadgeCode, BadgeStyle>>;
}

export const STOREFRONT_SETTING_DEFAULTS: StorefrontSettings = {
  defaultPageSize: 24,
  maxPageSize: 96,
  showOutOfStock: true,
  minSuggestFrequency: 2,
  popularityWeights: { views7d: 1, cartAdds: 5, purchases: 20, wishlists: 3, recencyDays: 30 },
  newArrivalDays: 30,
  // No words in code: without the `catalog.badges` setting only a product's own badge shows.
  badges: {},
};

const weightsColumn = jsonColumn<Partial<PopularityWeights>>(
  undefined,
  'search.popularity_weights',
);
const badgesColumn = jsonColumn<Record<string, unknown>>(undefined, 'catalog.badges');

/** Keeps only known codes with a non-empty label, so a bad edit cannot break every card. */
export function parseBadges(
  raw: Record<string, unknown>,
): Partial<Record<ProductBadgeCode, BadgeStyle>> {
  const badges: Partial<Record<ProductBadgeCode, BadgeStyle>> = {};
  for (const [code, value] of Object.entries(raw)) {
    if (!isProductBadgeCode(code) || code === 'CUSTOM' || !value || typeof value !== 'object') {
      continue;
    }
    const { label, color } = value as { label?: unknown; color?: unknown };
    if (typeof label !== 'string' || label.trim().length === 0) continue;
    badges[code] = {
      label: label.trim().slice(0, 40),
      color: typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null,
    };
  }
  return badges;
}

export const settingsService = {
  async read(): Promise<StorefrontSettings> {
    return cache.wrap(
      // v2: the shape gained newArrivalDays and badges; an older cached copy must not be read.
      `${STOREFRONT_CACHE_PREFIXES.settings}v2`,
      env.STOREFRONT_CACHE_TTL_SECONDS,
      () => this.load(),
    );
  },

  async load(): Promise<StorefrontSettings> {
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
    /** Like num(), but 0 is a real answer ("switched off"), not a missing value. */
    const whole = (settingKey: string, fallback: number): number => {
      const raw = byKey.get(settingKey);
      const value = raw === undefined ? Number.NaN : Number(raw);
      return Number.isInteger(value) && value >= 0 ? value : fallback;
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
      newArrivalDays: Math.min(
        whole('catalog.new_arrival_days', STOREFRONT_SETTING_DEFAULTS.newArrivalDays),
        365,
      ),
      badges: parseBadges(badgesColumn.parse(byKey.get('catalog.badges'), {})),
    };

    return settings;
  },
};
