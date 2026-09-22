import { log, prisma } from './context';

/**
 * Pricing and GST configuration. Structural, not demo data — the engine needs these on any install.
 * Idempotent and edit-preserving: only the metadata is refreshed, never an admin's chosen value.
 */

interface SeedSetting {
  key: string;
  value: string;
  group: string;
  valueType: 'string' | 'number' | 'boolean' | 'json';
  isPublic: boolean;
}

const PRICING_SETTINGS: SeedSetting[] = [
  // Indian retail convention is tax-exclusive display for furniture; flip this and the engine
  // extracts GST from the shown price instead of adding to it.
  {
    key: 'pricing.prices_include_tax',
    value: 'false',
    group: 'pricing',
    valueType: 'boolean',
    isPublic: true,
  },
  {
    key: 'pricing.seller_state_code',
    value: 'MH',
    group: 'pricing',
    valueType: 'string',
    isPublic: false,
  },
  {
    key: 'pricing.default_place_of_supply',
    value: 'MH',
    group: 'pricing',
    valueType: 'string',
    isPublic: false,
  },
  {
    key: 'pricing.shipping_taxable',
    value: 'true',
    group: 'pricing',
    valueType: 'boolean',
    isPublic: false,
  },
  {
    key: 'pricing.shipping_tax_class_code',
    value: 'GST_18',
    group: 'pricing',
    valueType: 'string',
    isPublic: false,
  },
  {
    key: 'pricing.round_total_to_rupee',
    value: 'true',
    group: 'pricing',
    valueType: 'boolean',
    isPublic: true,
  },
  {
    key: 'pricing.free_shipping_threshold_paise',
    value: '5000000',
    group: 'pricing',
    valueType: 'number',
    isPublic: true,
  },
  {
    key: 'pricing.show_savings_badge',
    value: 'true',
    group: 'pricing',
    valueType: 'boolean',
    isPublic: true,
  },
  {
    key: 'pricing.min_order_value_paise',
    value: '0',
    group: 'pricing',
    valueType: 'number',
    isPublic: true,
  },
];

export async function seedPricingSettings(): Promise<void> {
  for (const setting of PRICING_SETTINGS) {
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

  log('pricing-settings', `${PRICING_SETTINGS.length} pricing settings ensured`);
}
