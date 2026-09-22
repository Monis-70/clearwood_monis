import type { Prisma } from '@prisma/client';

import { prisma } from '../config/prisma';

/** R1 — FAQs and the help centre reach Prisma only through this file. */

const live = { deletedAt: null, isActive: true };

export const faqRepository = {
  listCategories(includeInactive = false) {
    return prisma.faqCategory.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { position: 'asc' },
    });
  },

  findCategory(id: string) {
    return prisma.faqCategory.findFirst({ where: { id, deletedAt: null } });
  },

  createCategory(data: Prisma.FaqCategoryUncheckedCreateInput) {
    return prisma.faqCategory.create({ data });
  },

  softDeleteCategory(id: string) {
    return prisma.faqCategory.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  findById(id: string) {
    return prisma.faq.findFirst({ where: { id, deletedAt: null } });
  },

  list(filter: { visibility?: string; categoryId?: string; includeInactive?: boolean }) {
    return prisma.faq.findMany({
      where: {
        deletedAt: null,
        ...(filter.includeInactive ? {} : { isActive: true }),
        ...(filter.visibility ? { visibility: filter.visibility } : {}),
        ...(filter.categoryId ? { faqCategoryId: filter.categoryId } : {}),
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  },

  /** Everything live, for the targeting filter to narrow in memory rather than in five queries. */
  listAllLive() {
    return prisma.faq.findMany({ where: live, orderBy: { position: 'asc' } });
  },

  search(term: string, limit: number) {
    return prisma.faq.findMany({
      where: {
        ...live,
        OR: [{ question: { contains: term } }, { answer: { contains: term } }],
      },
      orderBy: { position: 'asc' },
      take: limit,
    });
  },

  create(data: Prisma.FaqUncheckedCreateInput) {
    return prisma.faq.create({ data });
  },

  softDelete(id: string) {
    return prisma.faq.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  vote(id: string, helpful: boolean) {
    return prisma.faq.updateMany({
      where: { id, deletedAt: null },
      data: helpful ? { helpfulYes: { increment: 1 } } : { helpfulNo: { increment: 1 } },
    });
  },

  reorder(order: { id: string; position: number }[]) {
    return prisma.$transaction(
      order.map((entry) =>
        prisma.faq.updateMany({ where: { id: entry.id }, data: { position: entry.position } }),
      ),
    );
  },

  reorderCategories(order: { id: string; position: number }[]) {
    return prisma.$transaction(
      order.map((entry) =>
        prisma.faqCategory.updateMany({
          where: { id: entry.id },
          data: { position: entry.position },
        }),
      ),
    );
  },
};

export const helpRepository = {
  listCategories(includeInactive = false) {
    return prisma.helpCategory.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ depth: 'asc' }, { position: 'asc' }],
    });
  },

  findCategory(id: string) {
    return prisma.helpCategory.findFirst({ where: { id, deletedAt: null } });
  },

  findCategoryBySlug(slug: string) {
    return prisma.helpCategory.findFirst({ where: { slug, deletedAt: null } });
  },

  createCategory(data: Prisma.HelpCategoryUncheckedCreateInput) {
    return prisma.helpCategory.create({ data });
  },

  updateCategory(id: string, data: Prisma.HelpCategoryUncheckedUpdateInput) {
    return prisma.helpCategory.update({ where: { id }, data });
  },

  softDeleteCategory(id: string) {
    return prisma.helpCategory.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  categoryChildren(parentId: string) {
    return prisma.helpCategory.findMany({
      where: { parentId, deletedAt: null },
      orderBy: { position: 'asc' },
    });
  },

  findArticle(id: string) {
    return prisma.helpArticle.findFirst({ where: { id, deletedAt: null } });
  },

  findArticleBySlug(slug: string) {
    return prisma.helpArticle.findFirst({ where: { slug, deletedAt: null } });
  },

  listArticles(filter: { categoryId?: string; status?: string; includeDrafts?: boolean }) {
    return prisma.helpArticle.findMany({
      where: {
        deletedAt: null,
        ...(filter.categoryId ? { helpCategoryId: filter.categoryId } : {}),
        ...(filter.includeDrafts ? {} : { status: 'PUBLISHED' }),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: [{ position: 'asc' }, { title: 'asc' }],
    });
  },

  articlesByIds(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);

    return prisma.helpArticle.findMany({
      where: { id: { in: ids }, deletedAt: null, status: 'PUBLISHED' },
      select: { id: true, slug: true, title: true, excerpt: true },
    });
  },

  createArticle(data: Prisma.HelpArticleUncheckedCreateInput) {
    return prisma.helpArticle.create({ data });
  },

  softDeleteArticle(id: string) {
    return prisma.helpArticle.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  voteArticle(id: string, helpful: boolean) {
    return prisma.helpArticle.updateMany({
      where: { id, deletedAt: null },
      data: helpful ? { helpfulYes: { increment: 1 } } : { helpfulNo: { increment: 1 } },
    });
  },

  bumpArticleView(id: string) {
    return prisma.helpArticle.updateMany({
      where: { id, deletedAt: null },
      data: { viewCount: { increment: 1 } },
    });
  },

  slugExists(slug: string, exceptId: string | null) {
    return prisma.helpArticle.findFirst({
      where: { slug, deletedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
  },

  /** Published articles for the sitemap, paginated. */
  listPublished(skip: number, take: number) {
    return prisma.helpArticle.findMany({
      where: { status: 'PUBLISHED', deletedAt: null },
      select: { slug: true, updatedAt: true },
      orderBy: { slug: 'asc' },
      skip,
      take,
    });
  },

  countPublished(): Promise<number> {
    return prisma.helpArticle.count({ where: { status: 'PUBLISHED', deletedAt: null } });
  },

  reorderArticles(order: { id: string; position: number }[]) {
    return prisma.$transaction(
      order.map((entry) =>
        prisma.helpArticle.updateMany({
          where: { id: entry.id },
          data: { position: entry.position },
        }),
      ),
    );
  },
};
