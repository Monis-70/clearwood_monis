import { log, prisma } from './context';

/**
 * Shipping providers and the warehouse we ship from.
 *
 * `MANUAL` is the default on purpose: it is the only fully verified path, and a furniture business
 * genuinely starts by putting a sofa on its own truck. `MOCK` exists so the demo fulfilment below
 * can exercise a courier API end to end without an account anywhere.
 *
 * Shiprocket is seeded DISABLED with no credentials. Its client has never spoken to Shiprocket, so
 * a seeded-live provider would be an invitation to ship real orders through unverified code.
 */

const PROVIDERS = [
  {
    code: 'MANUAL',
    name: 'Own truck / local transporter',
    driver: 'manual',
    isActive: true,
    isDefault: true,
    notes: 'Admin-driven fulfilment. No courier API; AWBs are recorded by hand.',
  },
  {
    code: 'MOCK',
    name: 'Mock courier network (demo)',
    driver: 'mock',
    isActive: true,
    isDefault: false,
    notes: 'A complete offline courier simulator. Never contacts a network.',
  },
  {
    code: 'SHIPROCKET',
    name: 'Shiprocket (UNVERIFIED)',
    driver: 'shiprocket',
    isActive: false,
    isDefault: false,
    notes:
      'UNVERIFIED: endpoint paths have never been validated against a live account. See the ' +
      'Prompt 17 go-live checklist before enabling.',
  },
];

const PICKUP = {
  code: 'MAIN',
  name: 'ClearWood Works, Mumbai',
  contactName: 'Dispatch Desk',
  phone: '919810000010',
  email: 'dispatch@clearwood.local',
  line1: 'Plot 14, Kalamboli Furniture Estate',
  line2: 'Panvel',
  city: 'Navi Mumbai',
  state: 'Maharashtra',
  stateCode: 'MH',
  pincode: '410218',
  country: 'IN',
  isActive: true,
  isDefault: true,
};

export async function seedShippingProviders(): Promise<void> {
  for (const provider of PROVIDERS) {
    await prisma.shippingProvider.upsert({
      where: { code: provider.code },
      create: provider,
      // `isActive` is deliberately NOT overwritten: an admin who disabled a provider should not
      // find it switched back on by a deploy.
      update: { name: provider.name, driver: provider.driver, notes: provider.notes },
    });
  }

  await prisma.pickupLocation.upsert({
    where: { code: PICKUP.code },
    create: PICKUP,
    update: { name: PICKUP.name, phone: PICKUP.phone, pincode: PICKUP.pincode },
  });

  log('shipping-providers', `${PROVIDERS.length} providers, 1 pickup location`);
}
