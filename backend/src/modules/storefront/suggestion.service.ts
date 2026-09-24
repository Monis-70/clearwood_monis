import type { SuggestionDto } from '@shared/types/storefront';

import { env } from '../../config/env';
import { cache, search, storage } from '../../container';
import { highlightRange, normalise } from '../../drivers/search';
import { searchAnalyticsRepository } from '../../repositories/searchAnalytics.repository';
import { storefrontRepository } from '../../repositories/storefront.repository';
import { STOREFRONT_CACHE_PREFIXES } from '../catalog-admin/catalogCache.service';

import { settingsService } from './storefrontSettings.service';

/**
 * Autocomplete. Debounce-friendly by design: cached for a minute and hard-capped, so a keystroke
 * storm costs one query per distinct prefix rather than one per keystroke.
 */

const POPULAR_WINDOW_DAYS = 30;
const SUGGEST_TTL_SECONDS = 60;

export const suggestionService = {
  async suggest(prefix: string, limit?: number): Promise<SuggestionDto[]> {
    const normalised = normalise(prefix);
    if (normalised.length < env.SEARCH_MIN_QUERY_LENGTH) return [];

    const cap = Math.min(limit ?? env.SEARCH_SUGGEST_LIMIT, env.SEARCH_SUGGEST_LIMIT);
    const key = `${STOREFRONT_CACHE_PREFIXES.suggest}${normalised}:${cap}`;

    return cache.wrap(key, SUGGEST_TTL_SECONDS, () => this.compute(prefix, normalised, cap));
  },

  async compute(prefix: string, normalised: string, cap: number): Promise<SuggestionDto[]> {
    const settings = await settingsService.read();
    const since = new Date(Date.now() - POPULAR_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [hits, popular] = await Promise.all([
      search.suggest(prefix, cap),
      searchAnalyticsRepository.popularQueries(
        since,
        normalised,
        settings.minSuggestFrequency,
        Math.max(2, Math.floor(cap / 4)),
      ),
    ]);

    const productIds = hits
      .filter((hit) => hit.type === 'PRODUCT' && hit.entityId)
      .map((hit) => hit.entityId!);

    const images = await this.thumbnails(productIds);

    const entitySuggestions: SuggestionDto[] = hits.map((hit) => ({
      type: hit.type,
      label: hit.label,
      slug: hit.slug,
      entityId: hit.entityId,
      imageUrl: hit.entityId ? (images.get(hit.entityId) ?? null) : null,
      highlight: hit.highlight,
    }));

    const querySuggestions: SuggestionDto[] = popular
      .filter((row) => row.query !== normalised)
      .map((row) => ({
        type: 'QUERY' as const,
        label: row.query,
        slug: null,
        entityId: null,
        imageUrl: null,
        highlight: highlightRange(row.query, prefix),
      }));

    return [...querySuggestions, ...entitySuggestions].slice(0, cap);
  },

  async thumbnails(productIds: string[]): Promise<Map<string, string>> {
    if (productIds.length === 0) return new Map();

    const rows = await storefrontRepository.findCards(productIds);
    return new Map(
      rows
        .filter((row) => row.media[0])
        .map((row) => [row.id, storage.url(row.media[0]!.media.path)]),
    );
  },
};
