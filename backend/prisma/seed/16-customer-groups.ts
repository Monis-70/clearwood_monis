import { log, prisma } from './context';

/** The pricing audiences. RETAIL is the default every anonymous shopper falls into. */

const GROUPS = [
  {
    code: 'RETAIL',
    name: 'Retail',
    description: 'Walk-in and online customers. The default group.',
    isDefault: true,
    priority: 10,
    discountBp: null,
  },
  {
    code: 'TRADE',
    name: 'Trade / Interior designers',
    description: 'Verified interior designers and architects buying for clients.',
    isDefault: false,
    priority: 50,
    discountBp: 1000,
  },
  {
    code: 'BULK',
    name: 'Corporate / Bulk',
    description: 'Offices, hotels and builders ordering in volume.',
    isDefault: false,
    priority: 60,
    discountBp: null,
  },
  {
    code: 'VIP',
    name: 'VIP',
    description: 'Long-standing customers with negotiated pricing.',
    isDefault: false,
    priority: 70,
    discountBp: null,
  },
] as const;

export async function seedCustomerGroups(): Promise<void> {
  let created = 0;

  for (const group of GROUPS) {
    const existing = await prisma.customerGroup.findFirst({ where: { code: group.code } });

    if (existing) {
      // Structure stays in sync; the admin-editable name and discount are written once.
      await prisma.customerGroup.update({
        where: { id: existing.id },
        data: { isDefault: group.isDefault, priority: group.priority, deletedAt: null },
      });
      continue;
    }

    await prisma.customerGroup.create({ data: { ...group, discountBp: group.discountBp } });
    created += 1;
  }

  log('customer-groups', `${GROUPS.length} groups ensured (${created} created)`);
}
