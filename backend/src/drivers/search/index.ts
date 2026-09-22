import type { Env } from '../../config/env';
import { logger } from '../../config/logger';

import { MeiliSearchDriver } from './meili.search.driver';
import type { SearchDriver } from './search.driver';
import { SqlSearchDriver } from './sql.search.driver';

export type {
  SearchDriver,
  SearchDocumentInput,
  SearchQuery,
  SearchResult,
  SearchHit,
  SearchSuggestion,
  SearchHealth,
} from './search.driver';
export { FIELD_WEIGHTS, DEFAULT_LOCALE } from './search.driver';
export { SqlSearchDriver } from './sql.search.driver';
export { normalise, tokenise, expandSynonyms, highlightRange } from './tokenize';

export function createSearch(env: Env): SearchDriver {
  switch (env.SEARCH_DRIVER) {
    case 'meili':
      logger.warn({ driver: 'meili' }, 'search driver is a stub — queries will fail');
      return new MeiliSearchDriver();
    case 'sql':
    default:
      logger.debug({ driver: 'sql', maxResults: env.SEARCH_MAX_RESULTS }, 'search driver ready');
      return new SqlSearchDriver();
  }
}
