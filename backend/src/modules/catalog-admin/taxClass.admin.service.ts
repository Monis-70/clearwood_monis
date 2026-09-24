import type { TaxClass } from '@prisma/client';

import type { TaxClassCreateInput, TaxClassUpdateInput } from '@shared/schemas/catalogAdmin';
import type { ListQuery } from '@shared/schemas/common';

import { prisma } from '../../config/prisma';
import { notDeleted, pageResult, skipTake, type PageResult } from '../../repositories/helpers';
import { AppError } from '../../utils/AppError';

import { catalogCacheService } from './catalogCache.service';

/** GST classes. `rateBp` is basis points (18% = 1800) — never a float (D5). */
export const taxClassAdminService = {
  async list(query: ListQuery): Promise<PageResult<TaxClass>> {
    const args = { where: notDeleted };
    const [items, total] = await Promise.all([
      prisma.taxClass.findMany({
        ...args,
        ...skipTake(query),
        orderBy: [{ rateBp: 'asc' }, { id: 'asc' }],
      }),
      prisma.taxClass.count(args),
    ]);
    return pageResult(items, total, query);
  },

  async get(id: string): Promise<TaxClass> {
    const taxClass = await prisma.taxClass.findFirst({ where: { id, ...notDeleted } });
    if (!taxClass) throw AppError.notFound('Tax class not found', { id });
    return taxClass;
  },

  async create(input: TaxClassCreateInput): Promise<TaxClass> {
    const clash = await prisma.taxClass.count({ where: { code: input.code } });
    if (clash > 0)
      throw AppError.conflict('That tax class code is already in use', { code: input.code });

    const created = await prisma.taxClass.create({
      data: { ...input, hsnCode: input.hsnCode ?? null },
    });

    if (created.isDefault) await demoteOtherDefaults(created.id);
    // Tax is applied after the unit price the listing index holds.
    await catalogCacheService.invalidatePricing({ affectsCatalogPrices: false });
    return created;
  },

  async update(id: string, input: TaxClassUpdateInput): Promise<TaxClass> {
    await this.get(id);

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) data[key] = value;
    }

    const updated = await prisma.taxClass.update({ where: { id }, data });
    if (updated.isDefault) await demoteOtherDefaults(id);

    await catalogCacheService.invalidatePricing({ affectsCatalogPrices: false });
    return updated;
  },

  async remove(id: string): Promise<void> {
    const taxClass = await this.get(id);
    if (taxClass.isDefault) {
      throw new AppError(409, 'TAX_CLASS_DEFAULT', 'The default tax class cannot be removed', {
        id,
      });
    }

    const products = await prisma.product.count({ where: { taxClassId: id, ...notDeleted } });
    if (products > 0) {
      throw new AppError(409, 'TAX_CLASS_IN_USE', 'Products still use this tax class', {
        id,
        products,
      });
    }

    await prisma.taxClass.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await catalogCacheService.invalidatePricing({ affectsCatalogPrices: false });
  },
};

async function demoteOtherDefaults(keepId: string): Promise<void> {
  await prisma.taxClass.updateMany({
    where: { id: { not: keepId }, isDefault: true },
    data: { isDefault: false },
  });
}
