import { log, prisma } from './context';

/**
 * Demo address books.
 *
 * Deliberately mixed: serviceable metro pincodes alongside one that no seeded zone covers, so the
 * "we don't deliver there yet" path is reachable without editing data by hand. One default per
 * usage is an invariant of `address.service`, so exactly one address per customer is flagged.
 *
 * Idempotent: addresses are matched on (customerId, label), which is unique per demo customer here.
 */

interface SeedAddress {
  label: string;
  type: 'HOME' | 'WORK' | 'OTHER';
  usage: 'SHIPPING' | 'BILLING' | 'BOTH';
  fullName: string;
  phone: string;
  line1: string;
  line2?: string;
  landmark?: string;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  isDefaultShipping?: boolean;
  isDefaultBilling?: boolean;
  deliveryInstructions?: string;
}

const BY_CUSTOMER: Record<string, SeedAddress[]> = {
  'aarav.mehta@example.com': [
    {
      label: 'Home',
      type: 'HOME',
      usage: 'BOTH',
      fullName: 'Aarav Mehta',
      phone: '919810000001',
      line1: '14 Sagar Villa, Marine Drive',
      line2: 'Flat 3B',
      landmark: 'Opposite Intercontinental',
      city: 'Mumbai',
      state: 'Maharashtra',
      stateCode: 'MH',
      pincode: '400001',
      isDefaultShipping: true,
      isDefaultBilling: true,
      deliveryInstructions: 'Service lift only. Call before arriving.',
    },
    {
      label: 'Office',
      type: 'WORK',
      usage: 'SHIPPING',
      fullName: 'Aarav Mehta',
      phone: '919810000001',
      line1: 'Level 7, Amar Tech Park, Balewadi',
      city: 'Pune',
      state: 'Maharashtra',
      stateCode: 'MH',
      pincode: '411045',
    },
    {
      // No seeded zone covers this pincode — the storefront must say so rather than promise an ETA.
      label: 'Parents',
      type: 'OTHER',
      usage: 'SHIPPING',
      fullName: 'Nalini Mehta',
      phone: '919810000004',
      line1: 'House 22, Tribal Colony Road',
      city: 'Kavaratti',
      state: 'Lakshadweep',
      stateCode: 'LD',
      pincode: '682555',
    },
  ],
  '919810000002': [
    {
      label: 'Home',
      type: 'HOME',
      usage: 'BOTH',
      fullName: 'Ishita Rao',
      phone: '919810000002',
      line1: '48, 5th Cross, Koramangala 6th Block',
      landmark: 'Near Jyoti Nivas College',
      city: 'Bengaluru',
      state: 'Karnataka',
      stateCode: 'KA',
      pincode: '560034',
      isDefaultShipping: true,
      isDefaultBilling: true,
    },
    {
      label: 'Studio',
      type: 'WORK',
      usage: 'SHIPPING',
      fullName: 'Ishita Rao',
      phone: '919810000002',
      line1: '3rd Floor, Brigade Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      stateCode: 'KA',
      pincode: '560001',
    },
  ],
};

export async function seedDemoAddresses(): Promise<void> {
  let total = 0;

  for (const [identifier, addresses] of Object.entries(BY_CUSTOMER)) {
    const customer = identifier.includes('@')
      ? await prisma.customer.findUnique({ where: { email: identifier } })
      : await prisma.customer.findUnique({ where: { phone: identifier } });

    if (!customer) continue;

    for (const address of addresses) {
      const existing = await prisma.address.findFirst({
        where: { customerId: customer.id, label: address.label },
      });

      const data = {
        ...address,
        isDefaultShipping: address.isDefaultShipping ?? false,
        isDefaultBilling: address.isDefaultBilling ?? false,
        country: 'IN',
        deletedAt: null,
      };

      const saved = existing
        ? await prisma.address.update({ where: { id: existing.id }, data })
        : await prisma.address.create({ data: { customerId: customer.id, ...data } });

      // `Customer.defaultAddressId` is the fast path the cart reads; keep it in step.
      if (data.isDefaultShipping) {
        await prisma.customer.update({
          where: { id: customer.id },
          data: { defaultAddressId: saved.id },
        });
      }

      total += 1;
    }
  }

  log('demo-addresses', `${total} demo addresses ensured`);
}
