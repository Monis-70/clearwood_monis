import type { SearchAnalyticsDto } from '@shared/types/storefront';

import { logger } from '../../config/logger';
import { searchAnalyticsRepository } from '../../repositories/searchAnalytics.repository';
import { normalise } from '../../drivers/search';

/**
 * Query logging and the numbers the admin screen reads.
 *
 * Logging is fire-and-forget on purpose: a search must never fail because an analytics insert did.
 */

const BP = 10_000;

export const searchAnalyticsService = {
  async logQuery(input: {
    rawQuery: string;
    resultCount: number;
    filters?: Record<string, unknown>;
    customerId?: string | null;
    sessionId?: string | null;
    ip?: string | null;
  }): Promise<string | null> {
    try {
      const row = await searchAnalyticsRepository.logQuery({
        rawQuery: input.rawQuery.slice(0, 200),
        normalizedQuery: normalise(input.rawQuery),
        resultCount: input.resultCount,
        hasResults: input.resultCount > 0,
        filtersJson: input.filters ? JSON.stringify(input.filters) : null,
        customerId: input.customerId ?? null,
        sessionId: input.sessionId ?? null,
        ip: input.ip ?? null,
      });
      return row.id;
    } catch (error) {
      logger.warn({ err: error }, 'search query log skipped');
      return null;
    }
  },

  async logClick(input: {
    queryLogId?: string | undefined;
    query?: string | undefined;
    entityType: string;
    entityId: string;
    position: number;
  }): Promise<boolean> {
    const id =
      input.queryLogId ??
      (input.query
        ? (await searchAnalyticsRepository.findLatestForQuery(normalise(input.query)))?.id
        : undefined);

    if (!id) return false;

    const updated = await searchAnalyticsRepository.recordClick(id, {
      entityType: input.entityType,
      entityId: input.entityId,
      position: input.position,
    });
    return updated > 0;
  },

  async report(days: number, limit: number): Promise<SearchAnalyticsDto> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [top, zero, totals, trendRows] = await Promise.all([
      searchAnalyticsRepository.topQueries(since, limit),
      searchAnalyticsRepository.zeroResultQueries(since, limit),
      searchAnalyticsRepository.totals(since),
      searchAnalyticsRepository.findForTrend(since),
    ]);

    const clicks = await searchAnalyticsRepository.clickCountsFor(
      top.map((row) => row.normalizedQuery),
      since,
    );

    const byDate = new Map<string, { searches: number; zeroResults: number }>();
    for (const row of trendRows) {
      const date = row.createdAt.toISOString().slice(0, 10);
      const entry = byDate.get(date) ?? { searches: 0, zeroResults: 0 };
      entry.searches += 1;
      if (!row.hasResults) entry.zeroResults += 1;
      byDate.set(date, entry);
    }

    return {
      topQueries: top.map((row) => ({
        query: row.normalizedQuery,
        count: row._count._all,
        avgResults: Math.round(row._avg.resultCount ?? 0),
        clickThroughBp:
          row._count._all === 0
            ? 0
            : Math.round(((clicks.get(row.normalizedQuery) ?? 0) / row._count._all) * BP),
      })),
      zeroResultQueries: zero.map((row) => ({
        query: row.normalizedQuery,
        count: row._count._all,
        lastSeenAt: (row._max.createdAt ?? since).toISOString(),
      })),
      totals: {
        ...totals,
        clickThroughBp:
          totals.searches === 0 ? 0 : Math.round((totals.clicks / totals.searches) * BP),
      },
      trend: [...byDate].map(([date, value]) => ({ date, ...value })),
    };
  },
};
