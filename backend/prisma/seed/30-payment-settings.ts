import { env } from '../../src/config/env';

import { log, prisma } from './context';

/**
 * Payment and order settings.
 *
 * Structural, not demo data: checkout needs to know whether COD is on and how long a payment hold
 * lasts on any install. `payment.split.enabled` was a Prompt 1 placeholder; this is where it is
 * flipped on for real.
 */

interface SeedSetting {
  key: string;
  value: string;
  group: string;
  valueType: 'string' | 'number' | 'boolean' | 'json';
  isPublic: boolean;
}

const SETTINGS: SeedSetting[] = [
  {
    key: 'payment.split.enabled',
    value: String(env.SPLIT_ENABLED === 'true'),
    group: 'payment',
    valueType: 'boolean',
    // Public since Prompt 1; 9A only flips the value.
    isPublic: true,
  },
  {
    key: 'payment.cod.enabled',
    value: String(env.COD_ENABLED === 'true'),
    group: 'payment',
    valueType: 'boolean',
    // Public: the storefront decides whether to offer COD before the customer signs in.
    isPublic: true,
  },
  {
    key: 'payment.cod.max_order_paise',
    value: String(env.COD_MAX_ORDER_PAISE),
    group: 'payment',
    valueType: 'number',
    isPublic: true,
  },
  {
    key: 'payment.cod.fee_paise',
    value: String(env.COD_FEE_PAISE),
    group: 'payment',
    valueType: 'number',
    isPublic: true,
  },
  {
    key: 'payment.methods_enabled',
    value: JSON.stringify(['RAZORPAY', 'COD']),
    group: 'payment',
    valueType: 'json',
    isPublic: true,
  },
  {
    // AUTOMATIC: Razorpay captures on authorisation, so there is no second manual step.
    key: 'payment.capture_mode',
    value: 'AUTOMATIC',
    group: 'payment',
    valueType: 'string',
    isPublic: false,
  },
  {
    key: 'payment.hold_minutes',
    value: String(env.CHECKOUT_HOLD_MINUTES),
    group: 'payment',
    valueType: 'number',
    isPublic: false,
  },
  {
    key: 'order.number_prefix',
    value: env.ORDER_NUMBER_PREFIX,
    group: 'order',
    valueType: 'string',
    isPublic: false,
  },
  {
    key: 'order.cancellation_window_hours',
    value: '24',
    group: 'order',
    valueType: 'number',
    isPublic: true,
  },
  {
    key: 'order.auto_confirm_cod',
    value: 'true',
    group: 'order',
    valueType: 'boolean',
    isPublic: false,
  },
];

/**
 * Prompt 1 shipped `payment.split.enabled` as a placeholder set to false. 9A owns it now, so its
 * VALUE is resynced here; every other setting's value is an admin's decision once it exists.
 */
const VALUE_OWNED_BY_THIS_STEP = new Set(['payment.split.enabled']);

export async function seedPaymentSettings(): Promise<void> {
  for (const setting of SETTINGS) {
    await prisma.appSetting.upsert({
      where: { key: setting.key },
      update: {
        group: setting.group,
        valueType: setting.valueType,
        isPublic: setting.isPublic,
        ...(VALUE_OWNED_BY_THIS_STEP.has(setting.key) ? { value: setting.value } : {}),
      },
      create: setting,
    });
  }

  log('payment-settings', `${SETTINGS.length} payment and order settings ensured`);
}
