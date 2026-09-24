import { TAX_CLASSES } from './data/taxClasses';
import { log, prisma } from './context';

/**
 * CREATE-ONLY. A tax class that exists (by code, deleted ones included) belongs to the admin, who
 * has full CRUD for it: a rate or HSN change, a new default and a deletion all survive a re-seed.
 * A GST change after install is an admin edit, never a seed side effect.
 */
export async function seedTaxClasses(): Promise<void> {
  let created = 0;

  for (const taxClass of TAX_CLASSES) {
    const existing = await prisma.taxClass.findUnique({
      where: { code: taxClass.code },
      select: { id: true },
    });
    if (existing) continue;

    // Never a second default: one an admin chose (or an earlier seed made) keeps the role.
    const defaultTaken =
      taxClass.isDefault &&
      (await prisma.taxClass.count({ where: { isDefault: true, deletedAt: null } })) > 0;

    await prisma.taxClass.create({
      data: { ...taxClass, isDefault: taxClass.isDefault && !defaultTaken },
    });
    created += 1;
  }

  log('tax-classes', `${TAX_CLASSES.length} tax classes ensured (${created} created)`);
}
