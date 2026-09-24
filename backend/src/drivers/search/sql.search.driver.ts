import type { SearchEntityType } from '@shared/enums';

import { env, typoToleranceEnabled } from '../../config/env';
import {
  searchDocumentRepository,
  searchSynonymRepository,
  type SearchDocumentHead,
  type SearchDocumentText,
  type SearchScanFilter,
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
 * It scores the most popular documents in memory - plus, once the index outgrows that window, the
 * most popular ones containing every query word - so every line of relevance logic stays here.
 *
 * A document's text is normalised once per checksum (the indexer changes the checksum whenever any
 * field changes) and kept in a bounded per-process map, so a query reads only short columns. The
 * map can never serve stale text: every query compares it with the checksum it just read.
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

/** A field as the scorer sees it, with its distinct words of four letters or more by length. */
interface PreparedField {
  text: string;
  wordsByLength: Map<number, string[]>;
}

interface PreparedDocument {
  checksum: string;
  fields: Record<ScoredField, PreparedField>;
}

/** A hit plus whether every query word matched exactly, which decides if the window was enough. */
type ScoredHit = SearchHit & { precise: boolean };

function prepareField(raw: string | null): PreparedField {
  const text = normalise(raw ?? '');
  const wordsByLength = new Map<number, string[]>();
  for (const word of new Set(text.split(' '))) {
    // isNearMatch never matches a word shorter than four letters.
    if (word.length < 4) continue;
    const bucket = wordsByLength.get(word.length);
    if (bucket) bucket.push(word);
    else wordsByLength.set(word.length, [word]);
  }
  return { text, wordsByLength };
}

/** `text.split(' ').some(word => isNearMatch(word, term))`, visiting only lengths that can match. */
function hasNearWord(field: PreparedField, term: string): boolean {
  for (let length = term.length - 1; length <= term.length + 1; length += 1) {
    const bucket = field.wordsByLength.get(length);
    if (bucket?.some((word) => isNearMatch(word, term))) return true;
  }
  return false;
}

export class SqlSearchDriver implements SearchDriver {
  readonly name = 'sql' as const;

  private synonymCache: CachedSynonyms | null = null;
  /** Insertion order is recency: a hit is re-inserted, the oldest entry is evicted first. */
  private readonly prepared = new Map<string, PreparedDocument>();

  constructor(private readonly maxPrepared: number = env.SEARCH_MEMO_MAX_DOCUMENTS) {}

  /** How many candidates are scored at most, per pass. */
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

    const filter: SearchScanFilter = {
      locale,
      ...(query.entityTypes ? { entityTypes: query.entityTypes } : {}),
      entityIds: query.entityIds,
      ...(query.inStockOnly ? { inStockOnly: true } : {}),
    };
    const window = this.candidateLimit(limit + offset);
    const heads = await searchDocumentRepository.scanHeads(filter, window);
    const scored = await this.rank(heads, tokens, expandedTerms, normalizedQuery);

    /*
     * A full window means the index is larger than it. When the window holds fewer documents
     * matching every query word than the page needs, the most popular such documents outside it
     * are scored too, so an exact title or SKU is found however unpopular it is.
     */
    if (
      heads.length === window &&
      scored.filter((entry) => entry.precise).length < limit + offset
    ) {
      const seen = new Set(heads.map((head) => head.id));
      const precise = (
        await searchDocumentRepository.headsWithEveryWord(filter, tokens, limit + offset)
      ).filter((head) => !seen.has(head.id));
      scored.push(...(await this.rank(precise, tokens, expandedTerms, normalizedQuery)));
    }

    const hits = scored
      .map(({ precise: _precise, ...hit }) => hit)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.title.localeCompare(b.title) ||
          a.entityId.localeCompare(b.entityId),
      );

    return {
      hits: hits.slice(offset, offset + limit),
      total: hits.length,
      normalizedQuery,
      expandedTerms,
      tookMs: Date.now() - startedAt,
    };
  }

  private async rank(
    heads: SearchDocumentHead[],
    tokens: string[],
    expandedTerms: string[],
    normalizedQuery: string,
  ): Promise<ScoredHit[]> {
    const prepared = await this.prepare(heads);
    return heads
      .map((head) => {
        const document = prepared.get(head.id);
        return document ? this.score(head, document, tokens, expandedTerms, normalizedQuery) : null;
      })
      .filter((entry): entry is ScoredHit => entry !== null);
  }

  /** Normalised text for every head, reading the long columns only for unseen checksums. */
  private async prepare(heads: SearchDocumentHead[]): Promise<Map<string, PreparedDocument>> {
    const ready = new Map<string, PreparedDocument>();
    const missing: string[] = [];

    for (const head of heads) {
      const known = this.prepared.get(head.id);
      if (known?.checksum === head.checksum) {
        ready.set(head.id, known);
        this.prepared.delete(head.id);
        this.prepared.set(head.id, known);
      } else {
        missing.push(head.id);
      }
    }

    for (const row of await searchDocumentRepository.texts(missing)) {
      const document = this.remember(row);
      ready.set(row.id, document);
    }
    return ready;
  }

  private remember(row: SearchDocumentText): PreparedDocument {
    const document: PreparedDocument = {
      checksum: row.checksum,
      fields: {
        title: prepareField(row.title),
        sku: prepareField(row.sku),
        brandText: prepareField(row.brandText),
        categoryText: prepareField(row.categoryText),
        attributeText: prepareField(row.attributeText),
        keywordsText: prepareField(row.keywordsText),
        bodyText: prepareField(row.bodyText),
      },
    };

    if (this.maxPrepared > 0) {
      this.prepared.delete(row.id);
      this.prepared.set(row.id, document);
      while (this.prepared.size > this.maxPrepared) {
        const oldest = this.prepared.keys().next();
        if (oldest.done) break;
        this.prepared.delete(oldest.value);
      }
    }
    return document;
  }

  private score(
    head: SearchDocumentHead,
    document: PreparedDocument,
    tokens: string[],
    expandedTerms: string[],
    normalizedQuery: string,
  ): ScoredHit | null {
    let score = 0;
    const matchedFields: string[] = [];
    const matchedOriginalTokens = new Set<string>();

    for (const field of SCORED_FIELDS) {
      const prepared = document.fields[field];
      const haystack = prepared.text;
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
        if (hasNearWord(prepared, term)) {
          fieldHits += 0.5;
        }
      }

      if (fieldHits > 0) {
        score += fieldHits * FIELD_WEIGHTS[field];
        matchedFields.push(field);
      }
    }

    if (score === 0) return null;

    if (document.fields.title.text.includes(normalizedQuery)) score += EXACT_PHRASE_BONUS;
    const precise = tokens.every((token) => matchedOriginalTokens.has(token));
    if (precise) score += ALL_TERMS_BONUS;

    score += head.boostScore;
    score += Math.min(head.popularityScore, 100) / 100;

    return {
      entityType: head.entityType as SearchEntityType,
      entityId: head.entityId,
      slug: head.slug,
      title: head.title,
      subtitle: head.subtitle,
      score: Math.round(score * 100) / 100,
      matchedFields,
      precise,
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
