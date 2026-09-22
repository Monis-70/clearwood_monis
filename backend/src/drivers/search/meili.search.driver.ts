import type { SearchEntityType } from '@shared/enums';

import { AppError } from '../../utils/AppError';

import type {
  SearchDocumentInput,
  SearchDriver,
  SearchHealth,
  SearchQuery,
  SearchResult,
  SearchSuggestion,
} from './search.driver';

/**
 * TODO(Prompt 17): a Meilisearch-backed implementation, for when the catalog outgrows a table
 * scan. Nothing wires it yet — `SEARCH_DRIVER=meili` is rejected by the factory until the methods
 * below are real.
 *
 * The shape is fixed by `SearchDriver`, so the migration is: implement these seven methods against
 * `MEILI_HOST`/`MEILI_API_KEY`, flip the env var, run a full reindex. No route, service or test
 * changes — that is the entire point of the interface.
 *
 * Mapping notes for whoever picks this up:
 *   - one Meili index per locale, primary key `entityType_entityId`
 *   - searchableAttributes in weight order: title, sku, brandText, categoryText, attributeText,
 *     keywordsText, bodyText (Meili ranks by attribute position, so the order IS the weighting)
 *   - filterableAttributes: entityType, isActive, inStock, minPricePaise, entityId
 *   - sortableAttributes: popularityScore, minPricePaise
 *   - synonyms: push SearchSynonym rows into the index settings instead of expanding at query time
 */
export class MeiliSearchDriver implements SearchDriver {
  readonly name = 'meili' as const;

  private notImplemented(method: string): never {
    throw AppError.serviceUnavailable(`Meilisearch driver is not implemented yet (${method})`, {
      driver: 'meili',
      hint: 'Set SEARCH_DRIVER=sql',
    });
  }

  indexOne(_doc: SearchDocumentInput): Promise<boolean> {
    this.notImplemented('indexOne');
  }

  indexMany(_docs: SearchDocumentInput[]): Promise<number> {
    this.notImplemented('indexMany');
  }

  remove(_entityType: SearchEntityType, _entityId: string): Promise<void> {
    this.notImplemented('remove');
  }

  clear(_entityType?: SearchEntityType): Promise<void> {
    this.notImplemented('clear');
  }

  search(_query: SearchQuery): Promise<SearchResult> {
    this.notImplemented('search');
  }

  suggest(_prefix: string, _limit: number): Promise<SearchSuggestion[]> {
    this.notImplemented('suggest');
  }

  async health(): Promise<SearchHealth> {
    return {
      name: this.name,
      healthy: false,
      documentCount: 0,
      detail: 'driver stub — not implemented',
    };
  }
}
