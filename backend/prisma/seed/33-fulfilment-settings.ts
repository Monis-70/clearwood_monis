import { log, prisma } from './context';

/**
 * Fulfilment settings and the seller profile that documents will print from.
 *
 * Public settings are readable by the storefront (the returns window has to be, or the UI cannot
 * tell a customer the truth); everything about our own dispatch operation is private.
 */

interface Setting {
  key: string;
  value: string;
  valueType: 'STRING' | 'INT' | 'BOOL';
  group: string;
  isPublic: boolean;
}

const SETTINGS: Setting[] = [
  {
    key: 'fulfilment.return_window_days',
    value: '7',
    valueType: 'INT',
    group: 'fulfilment',
    isPublic: true,
  },
  {
    key: 'fulfilment.courier_strategy',
    value: 'LOWEST_COST',
    valueType: 'STRING',
    group: 'fulfilment',
    isPublic: false,
  },
  {
    key: 'fulfilment.auto_ndr_policy',
    value: 'REATTEMPT_TWICE',
    valueType: 'STRING',
    group: 'fulfilment',
    isPublic: false,
  },
  {
    key: 'fulfilment.tracking_poll_minutes',
    value: '60',
    valueType: 'INT',
    group: 'fulfilment',
    isPublic: false,
  },
  {
    key: 'seller.legal_name',
    value: 'ClearWood Furnitures Private Limited',
    valueType: 'STRING',
    group: 'seller',
    isPublic: false,
  },
  {
    key: 'seller.gstin',
    value: '27AABCC1234D1ZP',
    valueType: 'STRING',
    group: 'seller',
    isPublic: false,
  },
  {
    key: 'seller.state_code',
    value: 'MH',
    valueType: 'STRING',
    group: 'seller',
    isPublic: false,
  },
  {
    key: 'seller.address',
    value: 'Plot 14, Kalamboli Furniture Estate, Panvel, Navi Mumbai 410218',
    valueType: 'STRING',
    group: 'seller',
    isPublic: false,
  },
];

export async function seedFulfilmentSettings(): Promise<void> {
  for (const setting of SETTINGS) {
    await prisma.appSetting.upsert({
      where: { key: setting.key },
      create: setting,
      // Only the metadata is refreshed: an admin's edited VALUE survives a re-seed.
      update: {
        valueType: setting.valueType,
        group: setting.group,
        isPublic: setting.isPublic,
      },
    });
  }

  log('fulfilment-settings', `${SETTINGS.length} settings`);
}
