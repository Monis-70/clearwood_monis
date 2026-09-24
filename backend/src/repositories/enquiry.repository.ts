import type { Enquiry, Prisma } from '@prisma/client';

import type { EnquiryListQuery } from '@shared/schemas/enquiry';

import { prisma } from '../config/prisma';

import { notDeleted, orderBy, pageResult, skipTake, type PageResult } from './helpers';
import { reachableWhere } from './storefront.repository';
import { updateVersioned } from './versioned';

/** R1 - enquiries (contract work, custom furniture, interiors, bulk orders) are stored here. */

const SORTABLE = ['createdAt', 'updatedAt', 'status'] as const;

export const enquiryRepository = {
  create(data: Prisma.EnquiryUncheckedCreateInput): Promise<Enquiry> {
    return prisma.enquiry.create({ data });
  },

  findById(id: string): Promise<Enquiry | null> {
    return prisma.enquiry.findFirst({ where: { id, ...notDeleted } });
  },

  async list(query: EnquiryListQuery): Promise<PageResult<Enquiry>> {
    const where: Prisma.EnquiryWhereInput = {
      ...notDeleted,
      ...(query.status ? { status: query.status } : {}),
      ...(query.formKey ? { formKey: query.formKey } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.assignedToId ? { assignedToId: query.assignedToId } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q } },
              { email: { contains: query.q } },
              { phone: { contains: query.q } },
              { companyName: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.enquiry.findMany({
        where,
        ...skipTake(query),
        orderBy: orderBy(query.sort, query.order, SORTABLE, [{ createdAt: 'desc' }]),
      }),
      prisma.enquiry.count({ where }),
    ]);
    return pageResult(items, total, query);
  },

  /** Optimistic locking: a stale `version` is a 409 STALE_RESOURCE, like every admin write. */
  update(id: string, version: number, data: Prisma.EnquiryUpdateInput): Promise<void> {
    return updateVersioned(prisma.enquiry, 'Enquiry', id, version, data as Record<string, unknown>);
  },

  /** The page it was sent from, if a shopper can open it. */
  async findReachableProductId(slug: string): Promise<string | null> {
    const row = await prisma.product.findFirst({
      where: { slug, ...reachableWhere() },
      select: { id: true },
    });
    return row?.id ?? null;
  },

  async findCategoryId(slug: string): Promise<string | null> {
    const row = await prisma.category.findFirst({
      where: { slug, ...notDeleted },
      select: { id: true },
    });
    return row?.id ?? null;
  },

  /** Names for the context columns, one query each, never one per row. */
  async contextNames(
    categoryIds: string[],
    productIds: string[],
  ): Promise<{ categories: Map<string, string>; products: Map<string, string> }> {
    const [categories, products] = await Promise.all([
      categoryIds.length > 0
        ? prisma.category.findMany({
            where: { id: { in: categoryIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      productIds.length > 0
        ? prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);
    return {
      categories: new Map(categories.map((row) => [row.id, row.name])),
      products: new Map(products.map((row) => [row.id, row.name])),
    };
  },

  /** A form key is live while some active surface offers it (checked before anything is stored). */
  async isOfferedFormKey(formKey: string, liveCategoryIds: Set<string>): Promise<boolean> {
    const [navigation, categories, block] = await Promise.all([
      prisma.navigationItem.findFirst({
        where: { type: 'LEAD_FORM', leadFormKey: formKey, isActive: true },
        select: { id: true },
      }),
      prisma.category.findMany({
        where: { leadFormKey: formKey, ...notDeleted, isActive: true },
        select: { id: true },
      }),
      prisma.pageBlock.findFirst({
        where: {
          type: 'LEAD_FORM_CTA',
          isActive: true,
          configJson: { contains: `"leadFormKey":"${formKey}"` },
        },
        select: { id: true },
      }),
    ]);
    return (
      navigation !== null ||
      block !== null ||
      categories.some((category) => liveCategoryIds.has(category.id))
    );
  },

  findActiveAdmin(id: string): Promise<{ id: string } | null> {
    return prisma.adminUser.findFirst({
      where: { id, status: 'ACTIVE', ...notDeleted },
      select: { id: true },
    });
  },
};
