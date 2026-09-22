import type { Prisma, SearchDocument, SearchSynonym } from '@prisma/client';

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
  /**
   * The candidate set the driver scores in memory.
   *
   * MySQL upgrade: replace this with a `MATCH(title, bodyText, keywordsText) AGAINST (?)`
   * pre-filter — the scoring above it does not change.
   */
  scan(filter: SearchScanFilter, take: number): Promise<SearchDocument[]> {
    return prisma.searchDocument.findMany({
      where: scanWhere(filter),
      orderBy: [{ popularityScore: 'desc' }, { id: 'asc' }],
      take,
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

  findPriceBounds(
    entityIds: string[],
  ): Promise<{ entityId: string; minPricePaise: number | null; maxPricePaise: number | null }[]> {
    return prisma.searchDocument.findMany({
      where: { entityType: 'PRODUCT', entityId: { in: entityIds } },
      select: { entityId: true, minPricePaise: true, maxPricePaise: true },
    });
  },

  /** Global slider bounds for a scope, straight off the indexed default-group range. */
  async priceExtent(entityIds: string[]): Promise<{ minPaise: number; maxPaise: number }> {
    if (entityIds.length === 0) return { minPaise: 0, maxPaise: 0 };

    const aggregate = await prisma.searchDocument.aggregate({
      where: { entityType: 'PRODUCT', entityId: { in: entityIds } },
      _min: { minPricePaise: true },
      _max: { maxPricePaise: true },
    });

    return {
      minPaise: aggregate._min.minPricePaise ?? 0,
      maxPaise: aggregate._max.maxPricePaise ?? 0,
    };
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
