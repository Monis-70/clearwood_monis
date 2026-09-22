import { TAX_CLASSES } from './data/taxClasses';
import { log, prisma } from './context';

export async function seedTaxClasses(): Promise<void> {
  for (const taxClass of TAX_CLASSES) {
    await prisma.taxClass.upsert({
      where: { code: taxClass.code },
      // Rate and HSN are compliance data, not editorial content — always kept in sync.
      update: {
        rateBp: taxClass.rateBp,
        hsnCode: taxClass.hsnCode,
        isDefault: taxClass.isDefault,
        deletedAt: null,
      },
      create: taxClass,
    });
  }

  log('tax-classes', `${TAX_CLASSES.length} tax classes upserted`);
}
