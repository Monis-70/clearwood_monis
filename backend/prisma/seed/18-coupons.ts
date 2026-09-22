import { log, prisma } from './context';

/** Demo coupons covering every type and every rejection path the tests exercise. */

interface SeedCoupon {
  code: string;
  name: string;
  type: string;
  valueBp?: number;
  valuePaise?: number;
  minSubtotalPaise?: number;
  maxDiscountPaise?: number;
  usageLimit?: number;
  perCustomerLimit?: number;
  startsAt?: string;
  endsAt?: string;
  isActive?: boolean;
  isStackable?: boolean;
  firstOrderOnly?: boolean;
  groupCode?: string;
  description: string;
  termsText?: string;
}

const COUPONS: SeedCoupon[] = [
  {
    code: 'WELCOME10',
    name: 'Welcome — 10% off your first order',
    type: 'PERCENT',
    valueBp: 1000,
    maxDiscountPaise: 200_000,
    perCustomerLimit: 1,
    firstOrderOnly: true,
    description: '10% off your first ClearWood order, up to ₹2,000.',
    termsText:
      'Valid once per customer on their first order. Cannot be combined with other offers.',
  },
  {
    code: 'FLAT2000',
    name: 'Flat ₹2,000 off above ₹20,000',
    type: 'FIXED',
    valuePaise: 200_000,
    minSubtotalPaise: 2_000_000,
    description: '₹2,000 off when you spend ₹20,000 or more.',
  },
  {
    code: 'FREESHIP',
    name: 'Free delivery',
    type: 'FREE_SHIPPING',
    description: 'Delivery on us, anywhere we ship.',
    isStackable: true,
  },
  {
    code: 'TRADE15',
    name: 'Trade partners — 15% off',
    type: 'PERCENT',
    valueBp: 1500,
    groupCode: 'TRADE',
    description: 'Reserved for verified interior designers and architects.',
  },
  {
    code: 'EXPIRED2025',
    name: 'Winter 2025 sale (ended)',
    type: 'PERCENT',
    valueBp: 2000,
    startsAt: '2025-11-01T00:00:00.000Z',
    endsAt: '2025-12-31T23:59:59.000Z',
    description: 'Kept on purpose so the expired-coupon path stays covered.',
  },
];

export async function seedCoupons(): Promise<void> {
  const trade = await prisma.customerGroup.findFirst({ where: { code: 'TRADE' } });
  let created = 0;

  for (const coupon of COUPONS) {
    const existing = await prisma.coupon.findFirst({ where: { code: coupon.code } });
    if (existing) continue;

    const { groupCode, startsAt, endsAt, ...rest } = coupon;

    await prisma.coupon.create({
      data: {
        ...rest,
        code: coupon.code,
        valueBp: coupon.valueBp ?? null,
        valuePaise: coupon.valuePaise ?? null,
        minSubtotalPaise: coupon.minSubtotalPaise ?? null,
        maxDiscountPaise: coupon.maxDiscountPaise ?? null,
        usageLimit: coupon.usageLimit ?? null,
        perCustomerLimit: coupon.perCustomerLimit ?? null,
        startsAt: startsAt ? new Date(startsAt) : null,
        endsAt: endsAt ? new Date(endsAt) : null,
        isActive: coupon.isActive ?? true,
        isStackable: coupon.isStackable ?? false,
        firstOrderOnly: coupon.firstOrderOnly ?? false,
        appliesToJson: groupCode && trade ? JSON.stringify({ customerGroupIds: [trade.id] }) : null,
        termsText: coupon.termsText ?? null,
      },
    });
    created += 1;
  }

  log('coupons', `${COUPONS.length} demo coupons ensured (${created} created)`);
}
