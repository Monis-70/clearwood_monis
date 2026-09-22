import { env } from '../../config/env';
import { cache } from '../../container';
import { productStatRepository } from '../../repositories/searchAnalytics.repository';
import { searchDocumentRepository } from '../../repositories/searchDocument.repository';
import { storefrontRepository } from '../../repositories/storefront.repository';
import { STOREFRONT_CACHE_PREFIXES } from '../catalog-admin/catalogCache.service';

import { settingsService } from './storefrontSettings.service';

/**
 * Product popularity: the input to the POPULARITY sort and to search relevance tie-breaks.
 *
 * Views are rate-limited per session and obvious bots are dropped, because an unguarded counter is
 * a scoreboard anyone can edit.
 */

const BOT_PATTERN =
  /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|headless|curl|wget|python-requests|okhttp/i;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const popularityService = {
  isBot(userAgent: string | undefined): boolean {
    if (!userAgent || userAgent.trim().length === 0) return true;
    return BOT_PATTERN.test(userAgent);
  },

  /** Returns false when the view was ignored (bot, or a repeat inside the dedupe window). */
  async recordView(
    productId: string,
    sessionId: string | null,
    userAgent: string | undefined,
  ): Promise<boolean> {
    if (this.isBot(userAgent)) return false;

    if (sessionId) {
      const key = `${STOREFRONT_CACHE_PREFIXES.view}${sessionId}:${productId}`;
      const seen = await cache.get<number>(key);
      if (seen) return false;

      await cache.set(key, 1, env.PRODUCT_VIEW_DEDUPE_SECONDS);
    }

    await productStatRepository.recordView(productId, new Date());
    return true;
  },

  /**
   * popularityScore = w1*views7d + w2*cartAdds + w3*purchases + w4*wishlists + a recency bonus.
   * Weights come from AppSettings (`search.popularity_weights`), never from a constant here.
   */
  async recomputeScores(): Promise<{ updated: number }> {
    const { popularityWeights: weights } = await settingsService.read();

    await productStatRepository.resetWindow(new Date(Date.now() - SEVEN_DAYS_MS));

    const stats = await productStatRepository.findAll();
    const now = Date.now();
    const recomputedAt = new Date();

    for (const stat of stats) {
      const ageDays = stat.lastViewedAt
        ? (now - stat.lastViewedAt.getTime()) / (24 * 60 * 60 * 1000)
        : weights.recencyDays;

      const recency = Math.max(0, weights.recencyDays - ageDays);

      const score = Math.round(
        weights.views7d * stat.viewCount7d +
          weights.cartAdds * stat.cartAddCount +
          weights.purchases * stat.purchaseCount +
          weights.wishlists * stat.wishlistCount +
          recency,
      );

      await productStatRepository.setScore(stat.productId, score, recomputedAt);
      await searchDocumentRepository.setPopularity(stat.productId, score);
    }

    return { updated: stats.length };
  },

  /** Seeds a stat row for every publishable product so the sort is never sparse. */
  async backfill(): Promise<number> {
    const ids = await storefrontRepository.listIndexableIds();
    const existing = await productStatRepository.findAll();
    const known = new Set(existing.map((row) => row.productId));

    let created = 0;
    for (const id of ids) {
      if (known.has(id)) continue;
      await productStatRepository.setScore(id, 0, new Date());
      created += 1;
    }
    return created;
  },
};
