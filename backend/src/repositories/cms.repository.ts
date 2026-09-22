import { prisma } from '../config/prisma';

/**
 * R1 — the CMS reaches Prisma only through this file.
 *
 * Every method here takes a LIST and returns a list. That is not a style preference: the page
 * renderer hydrates an arbitrary number of blocks within a fixed query budget, and it can only do
 * that if nothing it calls fetches one row at a time.
 */

export const cmsReferenceRepository = {
  async liveCategoryIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];

    const rows = await prisma.category.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  async liveCollectionIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];

    const rows = await prisma.collection.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  async liveProductIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];

    const rows = await prisma.product.findMany({
      where: { id: { in: ids }, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  async liveFaqIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];

    const rows = await prisma.faq.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },
};

const mediaSelect = {
  id: true,
  url: true,
  path: true,
  disk: true,
  width: true,
  height: true,
  altText: true,
  blurhash: true,
  lqipDataUri: true,
  dominantColorHex: true,
  mimeType: true,
  variants: {
    select: { label: true, path: true, width: true, height: true, format: true, deviceTarget: true },
  },
} as const;

export const cmsHydrationRepository = {
  mediaByIds(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);

    return prisma.media.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: mediaSelect,
    });
  },

  categoriesByIds(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);

    return prisma.category.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      select: {
        id: true,
        slug: true,
        name: true,
        path: true,
        iconMediaId: true,
        productCountCache: true,
      },
    });
  },

  collectionsByIds(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);

    return prisma.collection.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      select: { id: true, slug: true, name: true, description: true, bannerMediaId: true },
    });
  },

  /** Members of several collections in ONE query, so N collection blocks cost one lookup. */
  collectionMembers(collectionIds: string[], perCollection: number) {
    if (collectionIds.length === 0) return Promise.resolve([]);

    return prisma.collectionProduct.findMany({
      where: {
        collectionId: { in: collectionIds },
        product: { deletedAt: null, status: 'ACTIVE' },
      },
      select: { collectionId: true, productId: true, position: true },
      orderBy: [{ collectionId: 'asc' }, { position: 'asc' }],
      // Over-fetch rather than query per collection; trimmed per collection in the renderer.
      take: collectionIds.length * Math.max(perCollection, 1) * 4,
    });
  },

  categoryMembers(categoryIds: string[], perCategory: number) {
    if (categoryIds.length === 0) return Promise.resolve([]);

    return prisma.productCategory.findMany({
      where: {
        categoryId: { in: categoryIds },
        product: { deletedAt: null, status: 'ACTIVE' },
      },
      select: { categoryId: true, productId: true, position: true },
      orderBy: [{ categoryId: 'asc' }, { position: 'asc' }],
      take: categoryIds.length * Math.max(perCategory, 1) * 4,
    });
  },

  faqsByIds(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);

    return prisma.faq.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      select: { id: true, question: true, answer: true, visibility: true, position: true },
      orderBy: { position: 'asc' },
    });
  },

  faqsByVisibility(visibilities: string[], limit: number) {
    if (visibilities.length === 0) return Promise.resolve([]);

    return prisma.faq.findMany({
      where: { visibility: { in: visibilities }, deletedAt: null, isActive: true },
      select: { id: true, question: true, answer: true, visibility: true, position: true },
      orderBy: { position: 'asc' },
      take: Math.max(limit, 1) * visibilities.length,
    });
  },

  testimonials(limit: number) {
    return prisma.testimonial.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: [{ isFeatured: 'desc' }, { position: 'asc' }],
      take: Math.max(limit, 1),
    });
  },

  stores() {
    return prisma.storeLocation.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: [{ isFlagship: 'desc' }, { position: 'asc' }],
    });
  },

  brandsByIds(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);

    return prisma.brand.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, slug: true, name: true, logoMediaId: true },
    });
  },
};

export type CmsMediaRow = Awaited<ReturnType<typeof cmsHydrationRepository.mediaByIds>>[number];

/** What the search indexer needs to make published content findable (Prompt B1 Task 4). */
export const cmsSearchRepository = {
  indexablePages(now: Date) {
    return prisma.page.findMany({
      where: {
        deletedAt: null,
        status: 'PUBLISHED',
        publishedAt: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: {
        id: true,
        slug: true,
        title: true,
        type: true,
        excerpt: true,
        seoTitle: true,
        seoDescription: true,
        seoKeywords: true,
        noIndex: true,
        viewCount: true,
        blocks: { where: { isActive: true }, select: { configJson: true } },
      },
    });
  },

  indexableHelpArticles() {
    return prisma.helpArticle.findMany({
      where: { deletedAt: null, status: 'PUBLISHED' },
      select: {
        id: true,
        slug: true,
        title: true,
        seoTitle: true,
        bodyHtml: true,
        viewCount: true,
        category: { select: { name: true } },
      },
    });
  },
};
