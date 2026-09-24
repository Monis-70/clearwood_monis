import { createHash } from 'node:crypto';

import type { Request, Response } from 'express';

import type { IdParam, ListQuery, SlugParam } from '@shared/schemas/common';
import type {
  AnalyticsQuery,
  CollectionListQuery,
  CollectionRulePreviewInput,
  OptionsQuery,
  PdpQuery,
  ProductBatchInput,
  RelatedQueryInput,
  ReindexQuery,
  ResolvePathInput,
  SearchClickInput,
  SearchQueryInput,
  StorefrontListQuery,
  SuggestQueryInput,
  SynonymCreateInput,
  SynonymUpdateInput,
  ViewBeaconInput,
} from '@shared/schemas/storefront';

import { collectionRulesService } from '../modules/storefront/collectionRules.service';
import { optionAvailabilityService } from '../modules/storefront/optionAvailability.service';
import { pdpService } from '../modules/storefront/pdp.service';
import { popularityService } from '../modules/storefront/popularity.service';
import { redirectService } from '../modules/storefront/redirect.service';
import { searchAdminService } from '../modules/storefront/searchAdmin.service';
import { searchAnalyticsService } from '../modules/storefront/searchAnalytics.service';
import { storefrontFacade } from '../modules/storefront/storefront.facade';
import { suggestionService } from '../modules/storefront/suggestion.service';
import { storefrontRepository } from '../repositories/storefront.repository';
import { AppError } from '../utils/AppError';
import { ok, paginated } from '../utils/response';

/** R1 — thin: already-validated input in, service out, one envelope. */

function identityOf(req: Request): { customerId: string | null } {
  return { customerId: req.auth?.realm === 'CUSTOMER' ? req.auth.principalId : null };
}

/**
 * Weak ETag over the payload. Prompt 17's Nginx layer builds on this; until then it saves the
 * storefront a full download when nothing changed.
 */
function withETag(req: Request, res: Response, body: unknown, maxAgeSeconds: number): boolean {
  const etag = `W/"${createHash('sha1').update(JSON.stringify(body)).digest('base64url')}"`;

  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}, stale-while-revalidate=60`);

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return true;
  }
  return false;
}

const LISTING_MAX_AGE = 60;
const PDP_MAX_AGE = 120;

export const storefrontController = {
  async listProducts(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as StorefrontListQuery;
    const result = await storefrontFacade.listProducts(query, identityOf(req));

    if (withETag(req, res, result.data, LISTING_MAX_AGE)) return;
    ok(res, result.data, {
      page: result.pagination.page,
      limit: result.pagination.limit,
      total: result.pagination.total,
      totalPages: Math.max(1, Math.ceil(result.pagination.total / result.pagination.limit)),
      hasNext: result.pagination.page * result.pagination.limit < result.pagination.total,
    });
  },

  async productDetail(req: Request, res: Response): Promise<void> {
    const { slug } = req.params as unknown as SlugParam;
    const query = req.query as unknown as PdpQuery;

    const detail = await pdpService.cached(slug, query, identityOf(req));
    if (withETag(req, res, detail, PDP_MAX_AGE)) return;
    ok(res, detail);
  },

  async productOptions(req: Request, res: Response): Promise<void> {
    const { slug } = req.params as unknown as SlugParam;
    const query = req.query as unknown as OptionsQuery;

    const card = await storefrontRepository.findCardBySlug(slug);
    if (!card) throw AppError.notFound(`Product "${slug}" not found`, { slug });

    ok(
      res,
      await optionAvailabilityService.forProduct(card.id, {
        variantId: query.variantId,
        optionValueIds: query.optionValueIds,
      }),
    );
  },

  async related(req: Request, res: Response): Promise<void> {
    const { slug } = req.params as unknown as SlugParam;
    const query = req.query as unknown as RelatedQueryInput;

    const card = await storefrontRepository.findCardBySlug(slug);
    if (!card) throw AppError.notFound(`Product "${slug}" not found`, { slug });

    const relations = await storefrontRepository.findRelations(card.id, query.type);
    const outcome = await pdpService.relatedCards(
      card.id,
      relations,
      card.categories.map((link) => link.categoryId),
      identityOf(req),
    );

    // A named type is exactly that curated group - never the category fallback under its name.
    const items = query.type
      ? (outcome.groups.find((group) => group.type === query.type)?.items ?? [])
      : outcome.related;
    ok(res, items.slice(0, query.limit));
  },

  async batch(req: Request, res: Response): Promise<void> {
    const input = req.body as ProductBatchInput;
    ok(res, await storefrontFacade.batch(input, identityOf(req)));
  },

  async categoryLanding(req: Request, res: Response): Promise<void> {
    const { slug } = req.params as unknown as SlugParam;
    const query = req.query as unknown as StorefrontListQuery;

    const landing = await storefrontFacade.categoryLanding(slug, identityOf(req), query);
    if (withETag(req, res, landing, LISTING_MAX_AGE)) return;
    ok(res, landing);
  },

  async collections(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as CollectionListQuery;
    ok(res, await storefrontFacade.collections(query));
  },

  async collectionBySlug(req: Request, res: Response): Promise<void> {
    const { slug } = req.params as unknown as SlugParam;
    const query = req.query as unknown as StorefrontListQuery;

    const result = await storefrontFacade.collectionBySlug(slug, query, identityOf(req));

    ok(
      res,
      { collection: result.collection, products: result.products.data },
      {
        page: result.products.pagination.page,
        limit: result.products.pagination.limit,
        total: result.products.pagination.total,
        totalPages: Math.max(
          1,
          Math.ceil(result.products.pagination.total / result.products.pagination.limit),
        ),
        hasNext:
          result.products.pagination.page * result.products.pagination.limit <
          result.products.pagination.total,
      },
    );
  },

  async filters(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as StorefrontListQuery;
    const facets = await storefrontFacade.filters(query, identityOf(req));

    if (withETag(req, res, facets, LISTING_MAX_AGE)) return;
    ok(res, facets);
  },

  /** The four curated strips every storefront home page needs. */
  curated(preset: 'new-arrivals' | 'best-sellers' | 'deals' | 'featured') {
    return async (req: Request, res: Response): Promise<void> => {
      const base = req.query as unknown as StorefrontListQuery;

      const query: StorefrontListQuery = {
        ...base,
        includeFacets: false,
        ...(preset === 'new-arrivals' ? { isNewArrival: true, sort: 'NEWEST' as const } : {}),
        ...(preset === 'best-sellers' ? { sort: 'BEST_SELLING' as const } : {}),
        ...(preset === 'deals' ? { onSale: true, sort: 'POPULARITY' as const } : {}),
        ...(preset === 'featured' ? { isFeatured: true, sort: 'CURATED' as const } : {}),
      };

      const result = await storefrontFacade.listProducts(query, identityOf(req));
      ok(res, result.data.items, {
        page: result.pagination.page,
        limit: result.pagination.limit,
        total: result.pagination.total,
        totalPages: Math.max(1, Math.ceil(result.pagination.total / result.pagination.limit)),
        hasNext: result.pagination.page * result.pagination.limit < result.pagination.total,
      });
    };
  },

  async search(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as SearchQueryInput;

    ok(
      res,
      await storefrontFacade.search(query, identityOf(req), {
        ip: req.ip,
        sessionId: query.sessionId,
      }),
    );
  },

  async suggest(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as SuggestQueryInput;
    ok(res, await suggestionService.suggest(query.q, query.limit));
  },

  async searchClick(req: Request, res: Response): Promise<void> {
    const input = req.body as SearchClickInput;

    const recorded = await searchAnalyticsService.logClick({
      queryLogId: input.queryLogId,
      query: input.query,
      entityType: input.entityType,
      entityId: input.entityId,
      position: input.position,
    });

    ok(res, { recorded }, null, 202);
  },

  async resolve(req: Request, res: Response): Promise<void> {
    const { path } = req.query as unknown as ResolvePathInput;
    ok(res, await redirectService.resolvePath(path));
  },

  async recordView(req: Request, res: Response): Promise<void> {
    const { slug } = req.params as unknown as SlugParam;
    const input = req.body as ViewBeaconInput;

    const card = await storefrontRepository.findCardBySlug(slug);
    if (!card) throw AppError.notFound(`Product "${slug}" not found`, { slug });

    const counted = await popularityService.recordView(
      card.id,
      input.sessionId ?? null,
      req.headers['user-agent'],
    );

    ok(res, { counted }, null, 202);
  },
};

export const adminSearchController = {
  async listSynonyms(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as ListQuery;
    const page = await searchAdminService.listSynonyms(query);
    paginated(res, page.items, { page: query.page, limit: query.limit, total: page.total });
  },

  async createSynonym(req: Request, res: Response): Promise<void> {
    ok(res, await searchAdminService.createSynonym(req.body as SynonymCreateInput), null, 201);
  },

  async updateSynonym(req: Request, res: Response): Promise<void> {
    const { term } = req.params as { term: string };
    ok(res, await searchAdminService.updateSynonym(term, req.body as SynonymUpdateInput));
  },

  async deleteSynonym(req: Request, res: Response): Promise<void> {
    const { term } = req.params as { term: string };
    await searchAdminService.deleteSynonym(term);
    ok(res, { deleted: true });
  },

  async reindex(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as ReindexQuery;
    const triggeredById = req.auth?.principalId ?? null;

    ok(
      res,
      await searchAdminService.reindex(query.entityType, query.full, triggeredById),
      null,
      202,
    );
  },

  async job(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await searchAdminService.job(id));
  },

  async jobs(_req: Request, res: Response): Promise<void> {
    ok(res, await searchAdminService.recentJobs());
  },

  async analytics(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as AnalyticsQuery;
    ok(res, await searchAnalyticsService.report(query.days, query.limit));
  },

  async searchDocument(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await searchAdminService.documentFor(id));
  },

  async popularity(_req: Request, res: Response): Promise<void> {
    ok(res, await popularityService.recomputeScores());
  },
};

export const adminCollectionRulesController = {
  async evaluate(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await collectionRulesService.evaluate(id));
  },

  async preview(req: Request, res: Response): Promise<void> {
    const input = req.body as CollectionRulePreviewInput;
    ok(res, await collectionRulesService.preview(input.rules, input.sampleSize));
  },

  async evaluateAll(_req: Request, res: Response): Promise<void> {
    ok(res, await collectionRulesService.evaluateAll());
  },
};
