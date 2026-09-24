import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import { idParamSchema, listQuerySchema, slugParamSchema } from '@shared/schemas/common';
import {
  analyticsQuerySchema,
  collectionListQuerySchema,
  collectionRulePreviewSchema,
  optionsQuerySchema,
  pdpQuerySchema,
  productBatchSchema,
  reindexQuerySchema,
  relatedQuerySchema,
  resolvePathSchema,
  searchClickSchema,
  searchQuerySchema,
  storefrontListQuerySchema,
  suggestQuerySchema,
  synonymCreateSchema,
  synonymTermParamSchema,
  synonymUpdateSchema,
  viewBeaconSchema,
} from '@shared/schemas/storefront';

import {
  adminCollectionRulesController,
  adminSearchController,
  storefrontController,
} from '../controllers/storefront.controller';
import {
  commonErrorResponses,
  errorBodySchema,
  jsonContent,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';
import {
  asyncHandler,
  authRateLimit,
  authenticate,
  optionalAuth,
  requirePermission,
  validate,
} from '../middleware';
import { csrfProtection } from '../modules/auth/csrf.service';

/**
 * Prompt 7 — the storefront read surface.
 *
 * Every public route uses `optionalAuth('CUSTOMER')` so a signed-in customer's group pricing is
 * applied automatically while anonymous browsing still works.
 */

const ADMIN_PREFIX = `${API_PREFIX}/admin`;
const guard = [authenticate('ADMIN'), csrfProtection('ADMIN')];

const unauthorised = { 401: jsonContent(errorBodySchema, 'Not authenticated') };
const forbidden = { 403: jsonContent(errorBodySchema, 'Missing permission or CSRF token') };
const notFoundResponse = { 404: jsonContent(errorBodySchema, 'No such record') };

export const storefrontRouter: Router = Router();
export const adminStorefrontRouter: Router = Router();

/* ----------------------------------------------------------- OpenAPI docs */

const anyObject = z.record(z.any());

const productCardSchema = registry.register(
  'ProductCard',
  z.object({
    id: z.string(),
    slug: z.string(),
    sku: z.string(),
    name: z.string(),
    pricePaise: z.number().int(),
    indexedMinPricePaise: z.number().int().nullable(),
    compareAtPricePaise: z.number().int().nullable(),
    savingsPaise: z.number().int(),
    inStock: z.boolean(),
    stockStatus: z.string(),
    ratingAvgBp: z.number().int(),
    swatches: z.array(anyObject),
    image: anyObject.nullable(),
  }),
);

const facetSchema = registry.register(
  'Facet',
  z.object({
    key: z.string(),
    kind: z.enum(['ATTRIBUTE', 'BRAND', 'PRICE', 'AVAILABILITY', 'RATING', 'FLAG']),
    label: z.string(),
    attributeId: z.string().nullable(),
    values: z.array(anyObject),
    minPaise: z.number().int().optional(),
    maxPaise: z.number().int().optional(),
    buckets: z.array(anyObject).optional(),
  }),
);

const productListSchema = registry.register(
  'ProductList',
  z.object({
    items: z.array(productCardSchema),
    facets: z.array(facetSchema),
    appliedFilters: z.array(anyObject),
    availableSorts: z.array(anyObject),
    sort: z.string(),
    /** `DEFAULT_GROUP` or `CUSTOMER_GROUP:<code>` — filtering always uses the default group. */
    pricingBasis: z.string(),
    priceBounds: z.object({ minPaise: z.number().int(), maxPaise: z.number().int() }),
    nextCursor: z.string().nullable(),
    query: z.string().nullable(),
    totalCount: z.number().int(),
  }),
);

const productDetailSchema = registry.register(
  'StorefrontProductDetail',
  z
    .object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      price: anyObject.describe('The Prompt 6 PriceBreakdown, verbatim'),
      pricingBasis: z.string(),
      options: anyObject,
      gallery: z.array(anyObject),
      specs: z.array(anyObject),
      related: z.array(productCardSchema),
      frequentlyBoughtTogether: z.array(productCardSchema),
      relationGroups: z
        .array(z.object({ type: z.string(), items: z.array(productCardSchema) }))
        .describe('Curated relations grouped by type; only products a shopper can open'),
      jsonLd: z.array(anyObject),
    })
    .passthrough(),
);

const searchResponseSchema = registry.register(
  'SearchResponse',
  z.object({
    query: z.string(),
    normalizedQuery: z.string(),
    expandedTerms: z.array(z.string()),
    queryLogId: z.string().nullable(),
    products: productListSchema,
    categories: z.array(anyObject),
    collections: z.array(anyObject),
    brands: z.array(anyObject),
    tookMs: z.number().int(),
  }),
);

const suggestionSchema = registry.register(
  'Suggestion',
  z.object({
    type: z.string(),
    label: z.string(),
    slug: z.string().nullable(),
    entityId: z.string().nullable(),
    imageUrl: z.string().nullable(),
    highlight: z.object({ start: z.number().int(), length: z.number().int() }).nullable(),
  }),
);

const resolveSchema = registry.register(
  'ResolveResult',
  z.object({
    type: z.enum(['PRODUCT', 'CATEGORY', 'COLLECTION', 'REDIRECT', 'NOT_FOUND']),
    path: z.string(),
    entity: anyObject.nullable(),
    redirectTo: z.string().nullable(),
    statusCode: z.number().int().nullable(),
  }),
);

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/products`,
  tags: ['Storefront'],
  summary: 'Product listing with facets',
  description:
    'Filters, sorts and facets in one call. Filtering and sorting always run against the DEFAULT ' +
    "customer group's indexed price; the price each card shows is resolved for the caller's own " +
    'group. `pricingBasis` says which was used. Supports offset and opaque-cursor pagination.',
  request: { query: storefrontListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(productListSchema), 'Products, facets and pagination meta'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/products/{slug}`,
  tags: ['Storefront'],
  summary: 'Full product detail page payload',
  description:
    'Product core, breadcrumbs, gallery, variants, the option-availability matrix, the resolved ' +
    'Prompt 6 price, specs, delivery estimate, related products and ready-to-inject JSON-LD.',
  request: { params: slugParamSchema, query: pdpQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(productDetailSchema), 'Product detail'),
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/products/{slug}/options`,
  tags: ['Storefront'],
  summary: 'Option availability matrix',
  request: { params: slugParamSchema, query: optionsQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Availability per option value'),
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/products/{slug}/related`,
  tags: ['Storefront'],
  summary: 'Related products: one curated type with `type`, else all curated or the same category',
  description:
    'Without `type`: every curated relation except FREQUENTLY_BOUGHT, falling back to the ' +
    "primary category's best sellers when none is curated. With `type`: exactly that curated " +
    'group, in position order, and an empty list when there is none (never the fallback).',
  request: { params: slugParamSchema, query: relatedQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(productCardSchema)), 'Related products'),
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/catalog/products/batch`,
  tags: ['Storefront'],
  summary: 'Many products by slug or id (recently viewed, compare)',
  request: { body: jsonContent(productBatchSchema, 'Slugs or ids') },
  responses: {
    200: jsonContent(successBodySchema(z.array(productCardSchema)), 'Product cards'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/categories/{slug}/landing`,
  tags: ['Storefront'],
  summary: 'Category landing page: banner, children, facet defaults, featured products, SEO',
  request: { params: slugParamSchema, query: storefrontListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Category landing payload'),
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/collections`,
  tags: ['Storefront'],
  summary: 'Active collections',
  request: { query: collectionListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Collections'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/collections/{slug}`,
  tags: ['Storefront'],
  summary: 'One collection and its products',
  request: { params: slugParamSchema, query: storefrontListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Collection with products'),
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/filters`,
  tags: ['Storefront'],
  summary: 'Facet definitions and price bounds for a scope',
  request: { query: storefrontListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(facetSchema)), 'Facets'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/new-arrivals`,
  tags: ['Storefront'],
  summary: 'Curated strip: new arrivals',
  request: { query: storefrontListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(productCardSchema)), 'Products'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/best-sellers`,
  tags: ['Storefront'],
  summary: 'Curated strip: best sellers',
  request: { query: storefrontListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(productCardSchema)), 'Products'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/deals`,
  tags: ['Storefront'],
  summary: 'Curated strip: products on sale',
  request: { query: storefrontListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(productCardSchema)), 'Products'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/featured`,
  tags: ['Storefront'],
  summary: 'Curated strip: featured products',
  request: { query: storefrontListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(productCardSchema)), 'Products'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/resolve`,
  tags: ['Storefront'],
  summary: 'What is at this path? Entity, 301 redirect or not found',
  description:
    'Serves the SlugRedirect rows Prompt 5 has been writing since the first rename. Chains are ' +
    'already flattened on write, so a lookup is one hop.',
  request: { query: resolvePathSchema },
  responses: {
    200: jsonContent(successBodySchema(resolveSchema), 'Resolution'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/catalog/products/{slug}/view`,
  tags: ['Storefront'],
  summary: 'Record a product view (rate-limited, bot-filtered)',
  request: { params: slugParamSchema, body: jsonContent(viewBeaconSchema, 'Session id') },
  responses: {
    202: jsonContent(successBodySchema(z.object({ counted: z.boolean() })), 'Accepted'),
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/search`,
  tags: ['Search'],
  summary: 'Search products, categories, collections and brands',
  description:
    'Relevance is weighted per field (title 10, sku 9, brand 6, category 5, attributes 4, ' +
    'keywords 4, body 2) with an exact-phrase bonus. Admin-managed synonyms expand the query.',
  request: { query: searchQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(searchResponseSchema), 'Grouped search results'),
    ...commonErrorResponses,
    422: jsonContent(errorBodySchema, 'Query shorter than SEARCH_MIN_QUERY_LENGTH'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/search/suggest`,
  tags: ['Search'],
  summary: 'Autocomplete',
  request: { query: suggestQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(suggestionSchema)), 'Suggestions'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/search/click`,
  tags: ['Search'],
  summary: 'Record which result was clicked (feeds CTR and the synonym workflow)',
  request: { body: jsonContent(searchClickSchema, 'Click') },
  responses: {
    202: jsonContent(successBodySchema(z.object({ recorded: z.boolean() })), 'Accepted'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/search/synonyms`,
  tags: ['Search'],
  summary: 'Admin: list search synonyms',
  security: [{ adminCookie: [] }],
  request: { query: listQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Synonyms'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/search/reindex`,
  tags: ['Search'],
  summary: 'Admin: rebuild the search index (chunked, returns a job)',
  security: [{ adminCookie: [] }],
  request: { query: reindexQuerySchema },
  responses: {
    202: jsonContent(successBodySchema(anyObject), 'Reindex job'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/search/jobs/{id}`,
  tags: ['Search'],
  summary: 'Admin: reindex job progress',
  security: [{ adminCookie: [] }],
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Job'),
    ...unauthorised,
    ...forbidden,
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/search/analytics`,
  tags: ['Search'],
  summary: 'Admin: top queries, zero-result queries, CTR and a 30-day trend',
  security: [{ adminCookie: [] }],
  request: { query: analyticsQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Analytics'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/collections/{id}/evaluate`,
  tags: ['Storefront'],
  summary: 'Admin: materialise an AUTOMATIC collection',
  security: [{ adminCookie: [] }],
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Evaluation summary'),
    ...unauthorised,
    ...forbidden,
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/collections/rules/preview`,
  tags: ['Storefront'],
  summary: 'Admin: dry-run a collection rule tree',
  security: [{ adminCookie: [] }],
  request: { body: jsonContent(collectionRulePreviewSchema, 'Rules') },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Matching count and a sample'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/catalog/products/{id}/search-document`,
  tags: ['Search'],
  summary: 'Admin: inspect what was indexed for a product',
  security: [{ adminCookie: [] }],
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(anyObject), 'Stored and freshly rebuilt documents'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

/* --------------------------------------------------------- public routes */

storefrontRouter.get(
  '/catalog/products',
  optionalAuth('CUSTOMER'),
  validate({ query: storefrontListQuerySchema }),
  asyncHandler(storefrontController.listProducts),
);

storefrontRouter.get(
  '/catalog/filters',
  optionalAuth('CUSTOMER'),
  validate({ query: storefrontListQuerySchema }),
  asyncHandler(storefrontController.filters),
);

storefrontRouter.get(
  '/catalog/resolve',
  validate({ query: resolvePathSchema }),
  asyncHandler(storefrontController.resolve),
);

storefrontRouter.get(
  '/catalog/new-arrivals',
  optionalAuth('CUSTOMER'),
  validate({ query: storefrontListQuerySchema }),
  asyncHandler(storefrontController.curated('new-arrivals')),
);

storefrontRouter.get(
  '/catalog/best-sellers',
  optionalAuth('CUSTOMER'),
  validate({ query: storefrontListQuerySchema }),
  asyncHandler(storefrontController.curated('best-sellers')),
);

storefrontRouter.get(
  '/catalog/deals',
  optionalAuth('CUSTOMER'),
  validate({ query: storefrontListQuerySchema }),
  asyncHandler(storefrontController.curated('deals')),
);

storefrontRouter.get(
  '/catalog/featured',
  optionalAuth('CUSTOMER'),
  validate({ query: storefrontListQuerySchema }),
  asyncHandler(storefrontController.curated('featured')),
);

storefrontRouter.get(
  '/catalog/collections',
  optionalAuth('CUSTOMER'),
  validate({ query: collectionListQuerySchema }),
  asyncHandler(storefrontController.collections),
);

storefrontRouter.get(
  '/catalog/collections/:slug',
  optionalAuth('CUSTOMER'),
  validate({ params: slugParamSchema, query: storefrontListQuerySchema }),
  asyncHandler(storefrontController.collectionBySlug),
);

storefrontRouter.get(
  '/catalog/categories/:slug/landing',
  optionalAuth('CUSTOMER'),
  validate({ params: slugParamSchema, query: storefrontListQuerySchema }),
  asyncHandler(storefrontController.categoryLanding),
);

// Registered before `/catalog/products/:slug` so "batch" is never read as a slug.
storefrontRouter.post(
  '/catalog/products/batch',
  optionalAuth('CUSTOMER'),
  validate({ body: productBatchSchema }),
  asyncHandler(storefrontController.batch),
);

storefrontRouter.get(
  '/catalog/products/:slug/options',
  optionalAuth('CUSTOMER'),
  validate({ params: slugParamSchema, query: optionsQuerySchema }),
  asyncHandler(storefrontController.productOptions),
);

storefrontRouter.get(
  '/catalog/products/:slug/related',
  optionalAuth('CUSTOMER'),
  validate({ params: slugParamSchema, query: relatedQuerySchema }),
  asyncHandler(storefrontController.related),
);

storefrontRouter.post(
  '/catalog/products/:slug/view',
  optionalAuth('CUSTOMER'),
  authRateLimit('product-view'),
  validate({ params: slugParamSchema, body: viewBeaconSchema }),
  asyncHandler(storefrontController.recordView),
);

storefrontRouter.get(
  '/catalog/products/:slug',
  optionalAuth('CUSTOMER'),
  validate({ params: slugParamSchema, query: pdpQuerySchema }),
  asyncHandler(storefrontController.productDetail),
);

storefrontRouter.get(
  '/search',
  optionalAuth('CUSTOMER'),
  validate({ query: searchQuerySchema }),
  asyncHandler(storefrontController.search),
);

storefrontRouter.get(
  '/search/suggest',
  validate({ query: suggestQuerySchema }),
  asyncHandler(storefrontController.suggest),
);

storefrontRouter.post(
  '/search/click',
  optionalAuth('CUSTOMER'),
  validate({ body: searchClickSchema }),
  asyncHandler(storefrontController.searchClick),
);

/* ---------------------------------------------------------- admin routes */

adminStorefrontRouter.get(
  '/search/synonyms',
  authenticate('ADMIN'),
  requirePermission('catalog.product.update'),
  validate({ query: listQuerySchema }),
  asyncHandler(adminSearchController.listSynonyms),
);

adminStorefrontRouter.post(
  '/search/synonyms',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ body: synonymCreateSchema }),
  asyncHandler(adminSearchController.createSynonym),
);

adminStorefrontRouter.patch(
  '/search/synonyms/:term',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ params: synonymTermParamSchema, body: synonymUpdateSchema }),
  asyncHandler(adminSearchController.updateSynonym),
);

adminStorefrontRouter.delete(
  '/search/synonyms/:term',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ params: synonymTermParamSchema }),
  asyncHandler(adminSearchController.deleteSynonym),
);

adminStorefrontRouter.post(
  '/search/reindex',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ query: reindexQuerySchema }),
  asyncHandler(adminSearchController.reindex),
);

adminStorefrontRouter.get(
  '/search/jobs',
  authenticate('ADMIN'),
  requirePermission('catalog.product.update'),
  asyncHandler(adminSearchController.jobs),
);

adminStorefrontRouter.get(
  '/search/jobs/:id',
  authenticate('ADMIN'),
  requirePermission('catalog.product.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminSearchController.job),
);

adminStorefrontRouter.get(
  '/search/analytics',
  authenticate('ADMIN'),
  requirePermission('catalog.product.update'),
  validate({ query: analyticsQuerySchema }),
  asyncHandler(adminSearchController.analytics),
);

adminStorefrontRouter.post(
  '/search/popularity/recompute',
  ...guard,
  requirePermission('catalog.product.update'),
  asyncHandler(adminSearchController.popularity),
);

adminStorefrontRouter.get(
  '/catalog/products/:id/search-document',
  authenticate('ADMIN'),
  requirePermission('catalog.product.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminSearchController.searchDocument),
);

adminStorefrontRouter.post(
  '/collections/rules/preview',
  ...guard,
  requirePermission('catalog.collection.update'),
  validate({ body: collectionRulePreviewSchema }),
  asyncHandler(adminCollectionRulesController.preview),
);

adminStorefrontRouter.post(
  '/collections/evaluate-all',
  ...guard,
  requirePermission('catalog.collection.update'),
  asyncHandler(adminCollectionRulesController.evaluateAll),
);

adminStorefrontRouter.post(
  '/collections/:id/evaluate',
  ...guard,
  requirePermission('catalog.collection.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminCollectionRulesController.evaluate),
);
