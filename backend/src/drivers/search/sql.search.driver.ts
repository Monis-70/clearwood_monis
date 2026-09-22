import type { SearchDocument } from '@prisma/client';

import type { SearchEntityType } from '@shared/enums';

import { env, typoToleranceEnabled } from '../../config/env';
import {
  searchDocumentRepository,
  searchSynonymRepository,
} from '../../repositories/searchDocument.repository';
import { jsonColumn } from '../../utils/jsonColumn';

import {
  ALL_TERMS_BONUS,
  DEFAULT_LOCALE,
  EXACT_PHRASE_BONUS,
  FIELD_WEIGHTS,
  PREFIX_BONUS,
  type SearchDocumentInput,
  type SearchDriver,
  type SearchHealth,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  type SearchSuggestion,
} from './search.driver';
import {
  expandSynonyms,
  highlightRange,
  isNearMatch,
  normalise,
  tokenise,
  withNumberJoins,
  type SynonymEntry,
} from './tokenize';

/**
 * The search implementation for the CURRENT database.
 *
 * It scans the denormalised SearchDocument table and scores in memory, which keeps every line of
 * relevance logic portable: no FULLTEXT, no MATCH/AGAINST, no ts_vector, nothing that would have to
 * be rewritten when SQLite becomes MySQL 8 (rule D4). The one place a provider matters is
 * `candidateLimit()`, and it is isolated on purpose.
 *
 * MySQL upgrade: add FULLTEXT(title, bodyText, keywordsText) to SearchDocument and replace
 * `searchDocumentRepository.scan` with a MATCH ... AGAINST pre-filter. The scoring below, the
 * synonym expansion and the public interface all stay exactly as they are.
 */

const SYNONYM_CACHE_MS = 60_000;
const SCAN_MULTIPLIER = 20;
const MAX_SCAN = 5_000;

const synonymList = jsonColumn<string[]>(undefined, 'SearchSynonym.synonymsJson');

type ScoredField = keyof typeof FIELD_WEIGHTS;

const SCORED_FIELDS: ScoredField[] = [
  'title',
  'sku',
  'brandText',
  'categoryText',
  'attributeText',
  'keywordsText',
  'bodyText',
];

interface CachedSynonyms {
  loadedAt: number;
  entries: SynonymEntry[];
}

export class SqlSearchDriver implements SearchDriver {
  readonly name = 'sql' as const;

  private synonymCache: CachedSynonyms | null = null;

  /**
   * The only provider-aware decision in the driver: how many rows it is willing to pull back
   * before scoring. MySQL's FULLTEXT pre-filter will make this cap irrelevant.
   */
  private candidateLimit(requested: number): number {
    const base = Math.max(requested, env.SEARCH_MAX_RESULTS) * SCAN_MULTIPLIER;
    return Math.min(base, MAX_SCAN);
  }

  private async synonyms(): Promise<SynonymEntry[]> {
    if (this.synonymCache && Date.now() - this.synonymCache.loadedAt < SYNONYM_CACHE_MS) {
      return this.synonymCache.entries;
    }

    const rows = await searchSynonymRepository.findActive();
    const entries = rows.map((row) => ({
      term: row.term,
      synonyms: synonymList.parse(row.synonymsJson, []),
      isTwoWay: row.isTwoWay,
    }));

    this.synonymCache = { loadedAt: Date.now(), entries };
    return entries;
  }

  /** Tests and the synonym admin screen need the next query to see their write immediately. */
  invalidateSynonyms(): void {
    this.synonymCache = null;
  }

  async indexOne(doc: SearchDocumentInput): Promise<boolean> {
    const [existing] = await searchDocumentRepository.findChecksums(
      doc.entityType,
      [doc.entityId],
      doc.locale,
    );

    if (existing?.checksum === doc.checksum) return false;

    await searchDocumentRepository.upsert(doc);
    return true;
  }

  async indexMany(docs: SearchDocumentInput[]): Promise<number> {
    if (docs.length === 0) return 0;

    const byType = new Map<SearchEntityType, SearchDocumentInput[]>();
    for (const doc of docs) {
      byType.set(doc.entityType, [...(byType.get(doc.entityType) ?? []), doc]);
    }

    const known = new Map<string, string>();
    for (const [entityType, group] of byType) {
      const rows = await searchDocumentRepository.findChecksums(
        entityType,
        group.map((doc) => doc.entityId),
        group[0]!.locale,
      );
      for (const row of rows) known.set(`${entityType}:${row.entityId}`, row.checksum);
    }

    let written = 0;
    for (const doc of docs) {
      if (known.get(`${doc.entityType}:${doc.entityId}`) === doc.checksum) continue;
      await searchDocumentRepository.upsert(doc);
      written += 1;
    }
    return written;
  }

  async remove(entityType: SearchEntityType, entityId: string): Promise<void> {
    await searchDocumentRepository.remove(entityType, entityId);
  }

  async clear(entityType?: SearchEntityType): Promise<void> {
    await searchDocumentRepository.clear(entityType);
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const startedAt = Date.now();
    const locale = query.locale ?? DEFAULT_LOCALE;
    const limit = Math.min(query.limit ?? env.SEARCH_MAX_RESULTS, env.SEARCH_MAX_RESULTS);
    const offset = query.offset ?? 0;

    const normalizedQuery = normalise(query.q);
    const tokens = tokenise(query.q);

    if (tokens.length === 0) {
      return { hits: [], total: 0, normalizedQuery, expandedTerms: [], tookMs: 0 };
    }

    const expandedTerms = [
      ...new Set([...expandSynonyms(tokens, await this.synonyms()), ...withNumberJoins(tokens)]),
    ];

    const documents = await searchDocumentRepository.scan(
      {
        locale,
        ...(query.entityTypes ? { entityTypes: query.entityTypes } : {}),
        entityIds: query.entityIds,
        ...(query.inStockOnly ? { inStockOnly: true } : {}),
      },
      this.candidateLimit(limit + offset),
    );

    const scored = documents
      .map((document) => this.score(document, tokens, expandedTerms, normalizedQuery))
      .filter((entry): entry is SearchHit => entry !== null)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.title.localeCompare(b.title) ||
          a.entityId.localeCompare(b.entityId),
      );

    return {
      hits: scored.slice(offset, offset + limit),
      total: scored.length,
      normalizedQuery,
      expandedTerms,
      tookMs: Date.now() - startedAt,
    };
  }

  private score(
    document: SearchDocument,
    tokens: string[],
    expandedTerms: string[],
    normalizedQuery: string,
  ): SearchHit | null {
    const haystacks: Record<ScoredField, string> = {
      title: normalise(document.title),
      sku: normalise(document.sku ?? ''),
      brandText: normalise(document.brandText ?? ''),
      categoryText: normalise(document.categoryText),
      attributeText: normalise(document.attributeText),
      keywordsText: normalise(document.keywordsText),
      bodyText: normalise(document.bodyText),
    };

    let score = 0;
    const matchedFields: string[] = [];
    const matchedOriginalTokens = new Set<string>();

    for (const field of SCORED_FIELDS) {
      const haystack = haystacks[field];
      if (!haystack) continue;

      let fieldHits = 0;

      for (const term of expandedTerms) {
        if (!term) continue;

        if (haystack.includes(term)) {
          fieldHits += 1;
          if (tokens.includes(term)) matchedOriginalTokens.add(term);
          if (haystack.startsWith(term)) score += PREFIX_BONUS;
          continue;
        }

        if (!typoToleranceEnabled || term.length < 4) continue;
        if (haystack.split(' ').some((word) => isNearMatch(word, term))) {
          fieldHits += 0.5;
        }
      }

      if (fieldHits > 0) {
        score += fieldHits * FIELD_WEIGHTS[field];
        matchedFields.push(field);
      }
    }

    if (score === 0) return null;

    if (haystacks.title.includes(normalizedQuery)) score += EXACT_PHRASE_BONUS;
    if (tokens.every((token) => matchedOriginalTokens.has(token))) score += ALL_TERMS_BONUS;

    score += document.boostScore;
    score += Math.min(document.popularityScore, 100) / 100;

    return {
      entityType: document.entityType as SearchEntityType,
      entityId: document.entityId,
      slug: document.slug,
      title: document.title,
      subtitle: document.subtitle,
      score: Math.round(score * 100) / 100,
      matchedFields,
    };
  }

  async suggest(prefix: string, limit: number): Promise<SearchSuggestion[]> {
    const normalised = normalise(prefix);
    if (normalised.length < env.SEARCH_MIN_QUERY_LENGTH) return [];

    const result = await this.search({ q: prefix, limit: limit * 3 });

    return result.hits.slice(0, limit).map((hit) => ({
      type: hit.entityType,
      label: hit.title,
      slug: hit.slug,
      entityId: hit.entityId,
      imageUrl: null,
      highlight: highlightRange(hit.title, prefix),
      score: hit.score,
    }));
  }

  async health(): Promise<SearchHealth> {
    try {
      const documentCount = await searchDocumentRepository.count();
      return { name: this.name, healthy: true, documentCount };
    } catch (error) {
      return {
        name: this.name,
        healthy: false,
        documentCount: 0,
        detail: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }
}
