import type { Prisma } from '@prisma/client';

import { prisma } from '../config/prisma';

/** R1 — testimonials, stores and admin navigation reach Prisma only through this file. */

export const testimonialRepository = {
  findById(id: string) {
    return prisma.testimonial.findFirst({ where: { id, deletedAt: null } });
  },

  list(filter: { featured?: boolean; includeInactive?: boolean } = {}) {
    return prisma.testimonial.findMany({
      where: {
        deletedAt: null,
        ...(filter.includeInactive ? {} : { isActive: true }),
        ...(filter.featured === undefined ? {} : { isFeatured: filter.featured }),
      },
      orderBy: [{ isFeatured: 'desc' }, { position: 'asc' }],
    });
  },

  create(data: Prisma.TestimonialUncheckedCreateInput) {
    return prisma.testimonial.create({ data });
  },

  softDelete(id: string) {
    return prisma.testimonial.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  reorder(order: { id: string; position: number }[]) {
    return prisma.$transaction(
      order.map((entry) =>
        prisma.testimonial.updateMany({
          where: { id: entry.id },
          data: { position: entry.position },
        }),
      ),
    );
  },
};

export const storeRepository = {
  findById(id: string) {
    return prisma.storeLocation.findFirst({ where: { id, deletedAt: null } });
  },

  list(includeInactive = false) {
    return prisma.storeLocation.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ isFlagship: 'desc' }, { position: 'asc' }],
    });
  },

  create(data: Prisma.StoreLocationUncheckedCreateInput) {
    return prisma.storeLocation.create({ data });
  },

  softDelete(id: string) {
    return prisma.storeLocation.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  slugExists(slug: string, exceptId: string | null) {
    return prisma.storeLocation.findFirst({
      where: { slug, deletedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
  },

  reorder(order: { id: string; position: number }[]) {
    return prisma.$transaction(
      order.map((entry) =>
        prisma.storeLocation.updateMany({
          where: { id: entry.id },
          data: { position: entry.position },
        }),
      ),
    );
  },
};

export const navigationAdminRepository = {
  findMenu(key: string) {
    return prisma.navigationMenu.findUnique({ where: { key } });
  },

  listMenus() {
    return prisma.navigationMenu.findMany({ orderBy: { key: 'asc' } });
  },

  findItem(id: string) {
    return prisma.navigationItem.findUnique({ where: { id } });
  },

  itemsForMenu(menuId: string) {
    return prisma.navigationItem.findMany({
      where: { menuId },
      orderBy: [{ parentId: 'asc' }, { position: 'asc' }],
    });
  },

  createItem(data: Prisma.NavigationItemUncheckedCreateInput) {
    return prisma.navigationItem.create({ data });
  },

  updateItem(id: string, data: Prisma.NavigationItemUncheckedUpdateInput) {
    return prisma.navigationItem.update({ where: { id }, data });
  },

  deleteItem(id: string) {
    return prisma.navigationItem.delete({ where: { id } });
  },

  childCount(parentId: string): Promise<number> {
    return prisma.navigationItem.count({ where: { parentId } });
  },

  reorder(menuId: string, order: { id: string; position: number }[]) {
    return prisma.$transaction(
      order.map((entry) =>
        prisma.navigationItem.updateMany({
          where: { id: entry.id, menuId },
          data: { position: entry.position },
        }),
      ),
    );
  },

  /** Referential checks for the item validator, batched. */
  categoryExists(id: string) {
    return prisma.category.findFirst({
      where: { id, deletedAt: null, isActive: true },
      select: { id: true },
    });
  },

  collectionExists(id: string) {
    return prisma.collection.findFirst({
      where: { id, deletedAt: null, isActive: true },
      select: { id: true },
    });
  },

  publishedPage(slug: string) {
    return prisma.page.findFirst({
      where: { slug, deletedAt: null, status: { in: ['PUBLISHED', 'SCHEDULED'] } },
      select: { id: true, slug: true, status: true, publishedAt: true },
    });
  },
};

export const settingWriteRepository = {
  upsert(key: string, value: string, valueType: string, group: string, isPublic: boolean) {
    return prisma.appSetting.upsert({
      where: { key },
      create: { key, value, valueType, group, isPublic },
      update: { value },
    });
  },

  findByKeys(keys: string[]) {
    return prisma.appSetting.findMany({ where: { key: { in: keys } } });
  },
};
