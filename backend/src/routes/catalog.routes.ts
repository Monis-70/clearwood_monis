import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import {
  attributeDtoSchema,
  attributeListQuerySchema,
  categoryNodeBaseSchema,
  categoryTreeQuerySchema,
  categoryBreadcrumbDtoSchema,
  navigationMenuKeySchema,
  navigationNodeBaseSchema,
  navigationParamsSchema,
  resolvedCategoryAttributeDtoSchema,
} from '@shared/schemas/catalog';
import { slugParamSchema } from '@shared/schemas/common';

import { catalogController } from '../controllers/catalog.controller';
import {
  commonErrorResponses,
  errorBodySchema,
  jsonContent,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';
import { asyncHandler, validate } from '../middleware';

/**
 * READ-ONLY endpoints that prove the catalog schema.
 *
 * Admin CRUD lives in adminCatalog.routes, price resolution in pricing.routes, and listing,
 * filters, facets, search and the PDP in storefront.routes.
 */

// `children` is recursive; OpenAPI cannot follow a `z.lazy` reference, so it is documented as a
// free-form array of the same node. Validation still uses the recursive schema in shared/.
const recursiveChildren = (label: string) =>
  z.array(z.record(z.any())).openapi({ description: `Nested ${label}[] — same shape, recursive` });

const categoryNodeSchema = registry.register(
  'CategoryNode',
  categoryNodeBaseSchema.extend({ children: recursiveChildren('CategoryNode') }),
);

const categoryDetailSchema = registry.register(
  'CategoryDetail',
  categoryNodeBaseSchema.extend({
    description: z.string().nullable(),
    bannerMediaId: z.string().nullable(),
    mobileBannerMediaId: z.string().nullable(),
    seoTitle: z.string().nullable(),
    seoDescription: z.string().nullable(),
    seoKeywords: z.string().nullable(),
    breadcrumbs: z.array(categoryBreadcrumbDtoSchema),
    children: z.array(categoryNodeSchema),
    attributes: z.array(resolvedCategoryAttributeDtoSchema),
  }),
);

const attributeSchema = registry.register('Attribute', attributeDtoSchema);

const navigationNodeSchema = registry.register(
  'NavigationNode',
  navigationNodeBaseSchema.extend({ children: recursiveChildren('NavigationNode') }),
);

const navigationMenuSchema = registry.register(
  'NavigationMenu',
  z.object({
    key: navigationMenuKeySchema,
    name: z.string(),
    items: z.array(navigationNodeSchema),
  }),
);

const notFoundResponse = { 404: jsonContent(errorBodySchema, 'No such record') };

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/categories/tree`,
  tags: ['Catalog'],
  summary: 'Full category tree',
  description:
    'The entire menu/category structure, nested and ordered. Cached for 5 minutes and invalidated ' +
    'by every catalog write (R9).',
  request: { query: categoryTreeQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(categoryNodeSchema)), 'Category tree'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/categories/{slug}`,
  tags: ['Catalog'],
  summary: 'One category with breadcrumbs, children and inherited attributes',
  request: { params: slugParamSchema },
  responses: {
    200: jsonContent(successBodySchema(categoryDetailSchema), 'Category detail'),
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/attributes`,
  tags: ['Catalog'],
  summary: 'Attribute dictionary, optionally resolved for a category',
  description:
    'Without `categorySlug` this is the global dictionary. With it, the response is the inherited ' +
    'set for that category (ancestors included).',
  request: { query: attributeListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(attributeSchema)), 'Attributes (paginated)'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/navigation/{key}`,
  tags: ['Navigation'],
  summary: 'A whole menu, nested',
  description: 'MAIN, FOOTER_PRIMARY, FOOTER_SECONDARY, MOBILE or TOP_BAR. Cached for 5 minutes.',
  request: { params: navigationParamsSchema },
  responses: {
    200: jsonContent(successBodySchema(navigationMenuSchema), 'Navigation menu'),
    ...notFoundResponse,
    ...commonErrorResponses,
  },
});

export const catalogRouter: Router = Router();

catalogRouter.get(
  '/catalog/categories/tree',
  validate({ query: categoryTreeQuerySchema }),
  asyncHandler(catalogController.categoryTree),
);

catalogRouter.get(
  '/catalog/categories/:slug',
  validate({ params: slugParamSchema }),
  asyncHandler(catalogController.categoryBySlug),
);

catalogRouter.get(
  '/catalog/attributes',
  validate({ query: attributeListQuerySchema }),
  asyncHandler(catalogController.attributes),
);

catalogRouter.get(
  '/navigation/:key',
  validate({ params: navigationParamsSchema }),
  asyncHandler(catalogController.navigation),
);
