import type { SearchDriverName, SearchEntityType } from '@shared/enums';

/**
 * The search contract. Everything above this line talks to the interface only, so Prompt 17 can
 * swap `sql` for Meilisearch/OpenSearch without touching a single route, service or test.
 */

export interface SearchDocumentInput {
  entityType: SearchEntityType;
  entityId: string;
  title: string;
  subtitle: string | null;
  bodyText: string;
  keywordsText: string;
  brandText: string | null;
  categoryText: string;
  attributeText: string;
  sku: string | null;
  slug: string;
  locale: string;
  minPricePaise: number | null;
  maxPricePaise: number | null;
  inStock: boolean;
  isActive: boolean;
  popularityScore: number;
  boostScore: number;
  /** Hash of the payload; an unchanged document is skipped instead of rewritten. */
  checksum: string;
}

export interface SearchQuery {
  q: string;
  entityTypes?: SearchEntityType[];
  limit?: number;
  offset?: number;
  locale?: string;
  /** Intersect with an id set the caller already narrowed by SQL filters. */
  entityIds?: string[] | undefined;
  inStockOnly?: boolean;
}

export interface SearchHit {
  entityType: SearchEntityType;
  entityId: string;
  slug: string;
  title: string;
  subtitle: string | null;
  score: number;
  matchedFields: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  normalizedQuery: string;
  expandedTerms: string[];
  tookMs: number;
}

export interface SearchSuggestion {
  type: SearchEntityType | 'QUERY';
  label: string;
  slug: string | null;
  entityId: string | null;
  imageUrl: string | null;
  /** Character range of the matched prefix inside `label`, for the UI to bold. */
  highlight: { start: number; length: number } | null;
  score: number;
}

export interface SearchHealth {
  name: SearchDriverName;
  healthy: boolean;
  documentCount: number;
  detail?: string;
}

export interface SearchDriver {
  readonly name: SearchDriverName;
  indexOne(doc: SearchDocumentInput): Promise<boolean>;
  /** Returns how many documents actually changed (checksum-skipped ones do not count). */
  indexMany(docs: SearchDocumentInput[]): Promise<number>;
  remove(entityType: SearchEntityType, entityId: string): Promise<void>;
  clear(entityType?: SearchEntityType): Promise<void>;
  search(query: SearchQuery): Promise<SearchResult>;
  suggest(prefix: string, limit: number): Promise<SearchSuggestion[]>;
  health(): Promise<SearchHealth>;
}

/** Weighted field hits. Tuned once, here, so relevance is explainable rather than magical. */
export const FIELD_WEIGHTS = {
  title: 10,
  sku: 9,
  brandText: 6,
  categoryText: 5,
  attributeText: 4,
  keywordsText: 4,
  bodyText: 2,
} as const;

export const EXACT_PHRASE_BONUS = 25;
export const PREFIX_BONUS = 6;
export const ALL_TERMS_BONUS = 12;
export const DEFAULT_LOCALE = 'en';
