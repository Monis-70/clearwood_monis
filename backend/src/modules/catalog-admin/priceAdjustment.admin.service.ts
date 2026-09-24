import type { PriceAdjustment } from '@prisma/client';

import { PRICE_ADJUSTMENT_SCOPE_FK } from '@shared/schemas/catalog';
import type {
  AdminPriceAdjustmentListQuery,
  PriceAdjustmentCreateInput,
  PriceAdjustmentUpdateInput,
} from '@shared/schemas/catalogAdmin';
import type { PriceAdjustmentConflictDto } from '@shared/types/catalogAdmin';

import { prisma } from '../../config/prisma';
import { notDeleted, pageResult, skipTake, type PageResult } from '../../repositories/helpers';
import {
  priceScheduleRepository,
  type RuleTarget,
} from '../../repositories/priceSchedule.repository';
import { updateVersioned } from '../../repositories/versioned';
import { AppError } from '../../utils/AppError';

import { catalogCacheService } from './catalogCache.service';

/**
 * Price rules are stored and validated here; nothing is ever calculated.
 * The stacking engine that turns these rows into a price is Prompt 6.
 */

/** The most products one rule write re-prices inline; past it, the leased full re-price runs. */
const TARGETED_REPRICE_LIMIT = 500;

/**
 * Re-prices every product the rule reached before AND after the write (a rule moved off a
 * product must re-price that product too). A GLOBAL rule, or a reach too wide to do inline,
 * asks for the whole index instead. Exported for CSV import, which writes rules the same way.
 */
export async function announcePriceRules(...rules: RuleTarget[]): Promise<void> {
  const reached = new Set<string>();
  for (const rule of rules) {
    const reach = await priceScheduleRepository.productsForRule(rule);
    if (reach === 'ALL') return catalogCacheService.invalidatePricing();
    for (const id of reach) reached.add(id);
    if (reached.size > TARGETED_REPRICE_LIMIT) return catalogCacheService.invalidatePricing();
  }
  await catalogCacheService.invalidatePricing({ productIds: [...reached] });
}

const announce = announcePriceRules;

function assertScopeTarget(input: {
  scope: string;
  categoryId?: string | null;
  productId?: string | null;
  variantId?: string | null;
  attributeValueId?: string | null;
}): void {
  const field = PRICE_ADJUSTMENT_SCOPE_FK[input.scope as keyof typeof PRICE_ADJUSTMENT_SCOPE_FK];
  if (!field) return;

  const value = (input as Record<string, unknown>)[field];
  if (!value) {
    throw AppError.validation(`A ${input.scope} rule needs ${field}`, { field });
  }
}

function overlaps(
  a: { startsAt: Date | null; endsAt: Date | null },
  b: { startsAt: Date | null; endsAt: Date | null },
): boolean {
  const aStart = a.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const aEnd = a.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bStart = b.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bEnd = b.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return aStart <= bEnd && bStart <= aEnd;
}

export const priceAdjustmentAdminService = {
  async list(query: AdminPriceAdjustmentListQuery): Promise<PageResult<PriceAdjustment>> {
    const args = {
      where: {
        ...notDeleted,
        ...(query.includeInactive ? {} : { isActive: true }),
        ...(query.scope ? { scope: query.scope } : {}),
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.variantId ? { variantId: query.variantId } : {}),
        ...(query.attributeValueId ? { attributeValueId: query.attributeValueId } : {}),
      },
    };

    const [items, total] = await Promise.all([
      prisma.priceAdjustment.findMany({
        ...args,
        ...skipTake(query),
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
      }),
      prisma.priceAdjustment.count(args),
    ]);

    return pageResult(items, total, query);
  },

  async get(id: string): Promise<PriceAdjustment> {
    const row = await prisma.priceAdjustment.findFirst({ where: { id, ...notDeleted } });
    if (!row) throw AppError.notFound('Price adjustment not found', { id });
    return row;
  },

  async create(input: PriceAdjustmentCreateInput): Promise<PriceAdjustment> {
    assertScopeTarget(input);

    const created = await prisma.priceAdjustment.create({
      data: {
        name: input.name,
        scope: input.scope,
        adjustmentType: input.adjustmentType,
        basis: input.basis,
        priority: input.priority,
        isActive: input.isActive,
        valuePaise: input.valuePaise ?? null,
        valueBp: input.valueBp ?? null,
        categoryId: input.categoryId ?? null,
        productId: input.productId ?? null,
        variantId: input.variantId ?? null,
        attributeId: input.attributeId ?? null,
        attributeValueId: input.attributeValueId ?? null,
        minQty: input.minQty ?? null,
        maxQty: input.maxQty ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        note: input.note ?? null,
      },
    });

    await announce(created);
    return created;
  },

  async update(id: string, input: PriceAdjustmentUpdateInput): Promise<PriceAdjustment> {
    const before = await this.get(id);
    const { version, ...rest } = input;

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }

    await updateVersioned(prisma.priceAdjustment, 'PriceAdjustment', id, version, data);
    const after = await this.get(id);
    await announce(before, after);
    return after;
  },

  async setActive(id: string, isActive: boolean): Promise<PriceAdjustment> {
    const before = await this.get(id);
    const updated = await prisma.priceAdjustment.update({ where: { id }, data: { isActive } });
    await announce(before, updated);
    return updated;
  },

  async remove(id: string): Promise<void> {
    const before = await this.get(id);
    await prisma.priceAdjustment.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await announce(before);
  },

  /**
   * Rules with the same scope, target and priority whose date windows overlap will fight each
   * other once Prompt 6 starts stacking them — this report surfaces them before that happens.
   */
  async conflicts(): Promise<PriceAdjustmentConflictDto[]> {
    const rows = await prisma.priceAdjustment.findMany({
      where: { ...notDeleted, isActive: true },
      orderBy: [{ scope: 'asc' }, { priority: 'asc' }],
    });

    const buckets = new Map<string, typeof rows>();
    for (const row of rows) {
      const target =
        row.variantId ?? row.productId ?? row.categoryId ?? row.attributeValueId ?? 'GLOBAL';
      const key = `${row.scope}|${target}|${row.priority}`;
      buckets.set(key, [...(buckets.get(key) ?? []), row]);
    }

    const conflicts: PriceAdjustmentConflictDto[] = [];

    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;

      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          const a = bucket[i]!;
          const b = bucket[j]!;
          if (!overlaps(a, b)) continue;

          conflicts.push({
            scope: a.scope,
            priority: a.priority,
            window: {
              startsAt: a.startsAt?.toISOString() ?? null,
              endsAt: a.endsAt?.toISOString() ?? null,
            },
            adjustmentIds: [a.id, b.id],
            names: [a.name, b.name],
          });
        }
      }
    }

    return conflicts;
  },
};
