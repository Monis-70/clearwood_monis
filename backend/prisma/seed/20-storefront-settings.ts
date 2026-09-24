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
  // A product is a new arrival for this many days after it goes live (0: only the flag counts).
  {
    key: 'catalog.new_arrival_days',
    value: '30',
    group: 'catalog',
    valueType: 'number',
    isPublic: true,
  },
  // Which card badges show and their words. A code left out is never shown; IN_HOUSE,
  // MADE_TO_ORDER and FEATURED are available but off until an admin adds them.
  {
    key: 'catalog.badges',
    value: JSON.stringify({
      NEW_ARRIVAL: { label: 'New', color: '#7E8C77' },
      SALE: { label: 'Sale', color: '#B23B3B' },
      BEST_SELLER: { label: 'Bestseller', color: '#8A5A3B' },
      SPECIAL_COLLECTION: { label: 'Special Collection', color: '#B4613A' },
      CUSTOMIZABLE: { label: 'Customisable', color: '#1E1A16' },
    }),
    group: 'catalog',
    valueType: 'json',
    isPublic: false,
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
