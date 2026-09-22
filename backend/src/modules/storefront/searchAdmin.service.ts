import type { SearchDocument } from '@prisma/client';

import type { SearchEntityType } from '@shared/enums';
import type { ListQuery } from '@shared/schemas/common';
import type { SynonymCreateInput, SynonymUpdateInput } from '@shared/schemas/storefront';
import type { SearchIndexJobDto } from '@shared/types/storefront';

import { logger } from '../../config/logger';
import { search } from '../../container';
import { SqlSearchDriver } from '../../drivers/search';
import { searchIndexJobRepository } from '../../repositories/searchAnalytics.repository';
import {
  searchDocumentRepository,
  searchSynonymRepository,
} from '../../repositories/searchDocument.repository';
import { storefrontRepository } from '../../repositories/storefront.repository';
import { AppError } from '../../utils/AppError';
import { jsonColumn } from '../../utils/jsonColumn';
import { catalogCacheService } from '../catalog-admin/catalogCache.service';

import { searchIndexerService } from './searchIndexer.service';

/** Admin-side search management: synonyms, reindex jobs and index inspection. */

const synonymList = jsonColumn<string[]>(undefined, 'SearchSynonym.synonymsJson');
const errorList = jsonColumn<string[]>(undefined, 'SearchIndexJob.errorsJson');

export interface SynonymDto {
  term: string;
  synonyms: string[];
  isTwoWay: boolean;
  isActive: boolean;
  note: string | null;
  updatedAt: string;
}

function toDto(row: {
  term: string;
  synonymsJson: string;
  isTwoWay: boolean;
  isActive: boolean;
  note: string | null;
  updatedAt: Date;
}): SynonymDto {
  return {
    term: row.term,
    synonyms: synonymList.parse(row.synonymsJson, []),
    isTwoWay: row.isTwoWay,
    isActive: row.isActive,
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toJobDto(job: {
  id: string;
  status: string;
  entityType: string | null;
  isFull: boolean;
  total: number;
  processed: number;
  failed: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorsJson: string | null;
}): SearchIndexJobDto {
  return {
    id: job.id,
    status: job.status,
    entityType: job.entityType,
    isFull: job.isFull,
    total: job.total,
    processed: job.processed,
    failed: job.failed,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    errors: errorList.parse(job.errorsJson, []),
  };
}

/** The synonym cache lives inside the SQL driver; a write has to be visible on the next query. */
function refreshDriverSynonyms(): void {
  if (search instanceof SqlSearchDriver) search.invalidateSynonyms();
}

export const searchAdminService = {
  async listSynonyms(query: ListQuery): Promise<{ items: SynonymDto[]; total: number }> {
    const rows = await searchSynonymRepository.findAll();
    const start = (query.page - 1) * query.limit;

    return {
      items: rows.slice(start, start + query.limit).map(toDto),
      total: rows.length,
    };
  },

  async createSynonym(input: SynonymCreateInput): Promise<SynonymDto> {
    const term = input.term.trim().toLowerCase();

    if (await searchSynonymRepository.findByTerm(term)) {
      throw AppError.conflict(`A synonym for "${term}" already exists`, { term });
    }

    const row = await searchSynonymRepository.upsert(term, {
      synonymsJson: JSON.stringify(input.synonyms.map((value) => value.trim().toLowerCase())),
      isTwoWay: input.isTwoWay,
      isActive: input.isActive,
      note: input.note ?? null,
    });

    refreshDriverSynonyms();
    await catalogCacheService.invalidateStorefront();
    return toDto(row);
  },

  async updateSynonym(term: string, input: SynonymUpdateInput): Promise<SynonymDto> {
    const key = term.trim().toLowerCase();
    const existing = await searchSynonymRepository.findByTerm(key);
    if (!existing) throw AppError.notFound(`No synonym for "${key}"`, { term: key });

    const row = await searchSynonymRepository.upsert(key, {
      synonymsJson: input.synonyms
        ? JSON.stringify(input.synonyms.map((value) => value.trim().toLowerCase()))
        : existing.synonymsJson,
      isTwoWay: input.isTwoWay ?? existing.isTwoWay,
      isActive: input.isActive ?? existing.isActive,
      note: input.note === undefined ? existing.note : (input.note ?? null),
    });

    refreshDriverSynonyms();
    await catalogCacheService.invalidateStorefront();
    return toDto(row);
  },

  async deleteSynonym(term: string): Promise<void> {
    const key = term.trim().toLowerCase();
    if (!(await searchSynonymRepository.findByTerm(key))) {
      throw AppError.notFound(`No synonym for "${key}"`, { term: key });
    }

    await searchSynonymRepository.remove(key);
    refreshDriverSynonyms();
    await catalogCacheService.invalidateStorefront();
  },

  /**
   * Reindexing runs inline and chunked. The job row exists so the admin panel can poll progress
   * and so Prompt 17 can move this onto a queue without a migration.
   */
  async reindex(
    entityType: SearchEntityType | undefined,
    full: boolean,
    triggeredById: string | null,
  ): Promise<SearchIndexJobDto> {
    const job = await searchIndexJobRepository.create({
      status: 'RUNNING',
      entityType: entityType ?? null,
      isFull: full,
      startedAt: new Date(),
      triggeredById,
    });

    try {
      if (full) await search.clear(entityType);

      const outcome = await searchIndexerService.reindexAll(
        entityType,
        async (processed, total) => {
          await searchIndexJobRepository.update(job.id, { processed, total });
        },
      );

      const finished = await searchIndexJobRepository.update(job.id, {
        status: outcome.failed > 0 ? 'FAILED' : 'COMPLETED',
        total: outcome.total,
        processed: outcome.processed,
        failed: outcome.failed,
        finishedAt: new Date(),
        errorsJson: outcome.errors.length > 0 ? JSON.stringify(outcome.errors) : null,
      });

      await catalogCacheService.invalidateStorefront();
      return toJobDto(finished);
    } catch (error) {
      logger.error({ err: error, jobId: job.id }, 'reindex failed');

      const failed = await searchIndexJobRepository.update(job.id, {
        status: 'FAILED',
        finishedAt: new Date(),
        errorsJson: JSON.stringify([error instanceof Error ? error.message : 'unknown error']),
      });
      return toJobDto(failed);
    }
  },

  async job(id: string): Promise<SearchIndexJobDto> {
    const job = await searchIndexJobRepository.findById(id);
    if (!job) throw AppError.notFound('Reindex job not found', { id });
    return toJobDto(job);
  },

  async recentJobs(take = 10): Promise<SearchIndexJobDto[]> {
    return (await searchIndexJobRepository.listRecent(take)).map(toJobDto);
  },

  /** What the index actually holds for one product — the first thing to check when relevance lies. */
  async documentFor(productId: string): Promise<{
    stored: SearchDocument | null;
    rebuilt: Record<string, unknown> | null;
  }> {
    const [stored] = await searchDocumentRepository.scan(
      { locale: 'en', entityTypes: ['PRODUCT'], entityIds: [productId] },
      1,
    );

    const product = await storefrontRepository.findIndexableById(productId);
    const rebuilt = product
      ? ((await searchIndexerService.buildProductDocument(product)) as unknown as Record<
          string,
          unknown
        >)
      : null;

    return { stored: stored ?? null, rebuilt };
  },
};
