import type { SettingValueType } from '@shared/enums';

import { env } from '../../src/config/env';

import { log, prisma } from './context';

/**
 * Moved unchanged from Prompt 1's seed.ts.
 *
 * Metadata (group / valueType / isPublic) is kept in sync on every run, but an existing `value` is
 * never clobbered — once an admin edits a setting, re-seeding must not undo their change (R8).
 */

interface SeedSetting {
  key: string;
  value: string;
  group: string;
  valueType: SettingValueType;
  isPublic: boolean;
}

const settings: SeedSetting[] = [
  {
    key: 'site.name',
    value: env.APP_NAME,
    group: 'site',
    valueType: 'string',
    isPublic: true,
  },
  {
    key: 'site.phone',
    value: env.SUPPORT_PHONE,
    group: 'site',
    valueType: 'string',
    isPublic: true,
  },
  {
    key: 'site.whatsapp',
    value: env.WHATSAPP_NUMBER,
    group: 'site',
    valueType: 'string',
    isPublic: true,
  },
  {
    key: 'site.email',
    value: env.SUPPORT_EMAIL,
    group: 'site',
    valueType: 'string',
    isPublic: true,
  },
  {
    key: 'site.currency',
    value: 'INR',
    group: 'site',
    valueType: 'string',
    isPublic: true,
  },
  {
    key: 'site.gst_percent',
    value: '18',
    group: 'site',
    valueType: 'number',
    isPublic: true,
  },
  {
    // D5 — money is integer paise: 999900 paise = ₹9,999.
    key: 'site.free_shipping_threshold',
    value: '999900',
    group: 'site',
    valueType: 'number',
    isPublic: true,
  },
  {
    key: 'site.usp_line',
    value: '100% in-house manufacturing. Zero outsourcing.',
    group: 'site',
    valueType: 'string',
    isPublic: true,
  },
  {
    key: 'payment.split.enabled',
    value: 'false',
    group: 'payment',
    valueType: 'boolean',
    isPublic: true,
  },
];

export async function seedSettings(): Promise<void> {
  for (const setting of settings) {
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

  log('settings', `${settings.length} settings upserted`);
}
