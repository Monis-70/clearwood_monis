import { log, prisma } from './context';

/**
 * Storefront and search configuration. Structural, not demo data — the listing engine needs page
 * sizes and the popularity formula on any install. Idempotent and edit-preserving.
 */

interface SeedSetting {
  key: string;
  value: string;
  group: string;
  valueType: 'string' | 'number' | 'boolean' | 'json';
  isPublic: boolean;
}

const STOREFRONT_SETTINGS: SeedSetting[] = [
  {
    key: 'catalog.default_page_size',
    value: '24',
    group: 'catalog',
    valueType: 'number',
    isPublic: true,
  },
  {
    key: 'catalog.max_page_size',
    value: '96',
    group: 'catalog',
    valueType: 'number',
    isPublic: false,
  },
  {
    key: 'catalog.show_out_of_stock',
    value: 'true',
    group: 'catalog',
    valueType: 'boolean',
    isPublic: true,
  },
  // popularityScore = views7d*w1 + cartAdds*w2 + purchases*w3 + wishlists*w4 + recency bonus.
  {
    key: 'search.popularity_weights',
    value: JSON.stringify({
      views7d: 1,
      cartAdds: 5,
      purchases: 20,
      wishlists: 3,
      recencyDays: 30,
    }),
    group: 'search',
    valueType: 'json',
    isPublic: false,
  },
  {
    key: 'search.min_suggest_frequency',
    value: '2',
    group: 'search',
    valueType: 'number',
    isPublic: false,
  },
];

export async function seedStorefrontSettings(): Promise<void> {
  for (const setting of STOREFRONT_SETTINGS) {
    await prisma.appSetting.upsert({
      where: { key: setting.key },
      update: {
        group: setting.group,
        valueType: setting.valueType,
        isPublic: setting.isPublic,
      },
      create: setting,
    });
  }

  log('storefront-settings', `${STOREFRONT_SETTINGS.length} storefront settings ensured`);
}
