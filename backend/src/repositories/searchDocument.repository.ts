import type { Prisma, SearchSynonym } from '@prisma/client';

import type { SearchEntityType } from '@shared/enums';

import { prisma } from '../config/prisma';
import type { SearchDocumentInput } from '../drivers/search/search.driver';

/**
 * R1 — the SQL search driver reads and writes its index through here, so Prisma stays confined to
 * the repository layer even though the driver owns the relevance logic.
 */

export interface SearchScanFilter {
  entityTypes?: SearchEntityType[];
  entityIds?: string[] | undefined;
  locale: string;
  inStockOnly?: boolean;
}

/** What a query needs of every candidate; the long text columns are read once per checksum. */
const headSelect = {
  id: true,
  entityType: true,
  entityId: true,
  slug: true,
  title: true,
  subtitle: true,
  boostScore: true,
  popularityScore: true,
  checksum: true,
} satisfies Prisma.SearchDocumentSelect;

const textSelect = {
  id: true,
  checksum: true,
  title: true,
  sku: true,
  brandText: true,
  categoryText: true,
  attributeText: true,
  keywordsText: true,
  bodyText: true,
} satisfies Prisma.SearchDocumentSelect;

export type SearchDocumentHead = Prisma.SearchDocumentGetPayload<{ select: typeof headSelect }>;
export type SearchDocumentText = Prisma.SearchDocumentGetPayload<{ select: typeof textSelect }>;

const TEXT_FIELDS = [
  'title',
  'sku',
  'brandText',
  'categoryText',
  'attributeText',
  'keywordsText',
] as const;

/** Ties broken by id DESC: MySQL then reads SearchDocument_popularityScore_idx backwards, no sort. */
const POPULAR_FIRST = [
  { popularityScore: 'desc' },
  { id: 'desc' },
] satisfies Prisma.SearchDocumentOrderByWithRelationInput[];

function scanWhere(filter: SearchScanFilter): Prisma.SearchDocumentWhereInput {
  return {
    isActive: true,
    locale: filter.locale,
    ...(filter.entityTypes?.length ? { entityType: { in: filter.entityTypes } } : {}),
    ...(filter.entityIds ? { entityId: { in: filter.entityIds } } : {}),
    ...(filter.inStockOnly ? { inStock: true } : {}),
  };
}

export const searchDocumentRepository = {
  /** The candidate window the driver scores in memory: the most popular documents first. */
  scanHeads(filter: SearchScanFilter, take: number): Promise<SearchDocumentHead[]> {
    return prisma.searchDocument.findMany({
      where: scanWhere(filter),
      select: headSelect,
      orderBy: POPULAR_FIRST,
      take,
    });
  },

  /**
   * The most popular documents containing EVERY word in a short field (title, SKU, brand,
   * category, attributes, keywords - the body would double the scan for the weakest field). Only
   * asked for when the index is larger than the window, so an exact title or SKU can never fall
   * outside it. The columns' utf8mb4_0900_ai_ci collation folds case and accents as `normalise`.
   */
  headsWithEveryWord(
    filter: SearchScanFilter,
    words: string[],
    take: number,
  ): Promise<SearchDocumentHead[]> {
    return prisma.searchDocument.findMany({
      where: {
        ...scanWhere(filter),
        AND: words.map((word) => ({
          OR: TEXT_FIELDS.map(
            (field) => ({ [field]: { contains: word } }) as Prisma.SearchDocumentWhereInput,
          ),
        })),
      },
      select: headSelect,
      orderBy: POPULAR_FIRST,
      take,
    });
  },

  texts(ids: string[]): Promise<SearchDocumentText[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.searchDocument.findMany({ where: { id: { in: ids } }, select: textSelect });
  },

  /** The whole stored document, for the admin index inspector. */
  findActive(entityType: SearchEntityType, entityId: string, locale: string) {
    return prisma.searchDocument.findFirst({
      where: { entityType, entityId, locale, isActive: true },
    });
  },

  findChecksums(
    entityType: SearchEntityType,
    entityIds: string[],
    locale: string,
  ): Promise<{ entityId: string; checksum: string }[]> {
    return prisma.searchDocument.findMany({
      where: { entityType, entityId: { in: entityIds }, locale },
      select: { entityId: true, checksum: true },
    });
  },

  async upsert(doc: SearchDocumentInput): Promise<void> {
    const { entityType, entityId, locale, ...rest } = doc;

    await prisma.searchDocument.upsert({
      where: { entityType_entityId_locale: { entityType, entityId, locale } },
      create: { entityType, entityId, locale, ...rest, indexedAt: new Date() },
      update: { ...rest, indexedAt: new Date() },
    });
  },

  async remove(entityType: SearchEntityType, entityId: string): Promise<void> {
    await prisma.searchDocument.deleteMany({ where: { entityType, entityId } });
  },

  async clear(entityType?: SearchEntityType): Promise<void> {
    await prisma.searchDocument.deleteMany({
      where: entityType ? { entityType } : {},
    });
  },

  count(entityType?: SearchEntityType): Promise<number> {
    return prisma.searchDocument.count({ where: entityType ? { entityType } : {} });
  },

  async listEntityIds(entityType: SearchEntityType): Promise<string[]> {
    const rows = await prisma.searchDocument.findMany({
      where: { entityType },
      select: { entityId: true },
    });
    return rows.map((row) => row.entityId);
  },

  async removeMany(entityType: SearchEntityType, entityIds: string[]): Promise<number> {
    if (entityIds.length === 0) return 0;
    const result = await prisma.searchDocument.deleteMany({
      where: { entityType, entityId: { in: entityIds } },
    });
    return result.count;
  },

  async setPopularity(entityId: string, popularityScore: number): Promise<void> {
    await prisma.searchDocument.updateMany({
      where: { entityType: 'PRODUCT', entityId },
      data: { popularityScore },
    });
  },
};

export const searchSynonymRepository = {
  findActive(): Promise<SearchSynonym[]> {
    return prisma.searchSynonym.findMany({ where: { isActive: true }, orderBy: { term: 'asc' } });
  },

  findAll(): Promise<SearchSynonym[]> {
    return prisma.searchSynonym.findMany({ orderBy: { term: 'asc' } });
  },

  findByTerm(term: string): Promise<SearchSynonym | null> {
    return prisma.searchSynonym.findUnique({ where: { term } });
  },

  upsert(
    term: string,
    data: Omit<Prisma.SearchSynonymCreateInput, 'term'>,
  ): Promise<SearchSynonym> {
    return prisma.searchSynonym.upsert({
      where: { term },
      create: { term, ...data },
      update: data,
    });
  },

  async remove(term: string): Promise<void> {
    await prisma.searchSynonym.delete({ where: { term } });
  },
};
