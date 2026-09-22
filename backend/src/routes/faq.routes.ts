import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import { idParamSchema } from '@shared/schemas/common';
import {
  categorySlugParamSchema,
  cmsReorderSchema,
  cmsSlugParamSchema,
  faqCategoryCreateSchema,
  faqCategoryUpdateSchema,
  faqCreateSchema,
  faqPublicQuerySchema,
  faqUpdateSchema,
  helpArticleCreateSchema,
  helpArticleUpdateSchema,
  helpCategoryCreateSchema,
  helpCategoryUpdateSchema,
  helpfulVoteSchema,
} from '@shared/schemas/cms';

import {
  adminFaqController,
  adminHelpController,
  publicFaqController,
  publicHelpController,
} from '../controllers/faq.controller';
import { commonErrorResponses, jsonContent, registry, successBodySchema, z } from '../docs/registry';
import { asyncHandler, authenticate, requirePermission, validate } from '../middleware';
import { csrfProtection } from '../modules/auth/csrf.service';

/**
 * Prompt 10A — FAQs and the help centre.
 *
 * Help articles are stored as markdown AND as sanitised HTML. The HTML is produced at write time,
 * so a read never runs a parser and the stored bytes are the bytes we vouched for.
 */

const ADMIN_PREFIX = `${API_PREFIX}/admin`;
const adminGuard = [authenticate('ADMIN'), csrfProtection('ADMIN')];

export const faqRouter: Router = Router();
export const adminFaqRouter: Router = Router();

const anyObject = z.record(z.unknown());

const faqSchema = registry.register(
  'Faq',
  z
    .object({
      id: z.string(),
      question: z.string(),
      answer: z.string(),
      visibility: z.string().openapi({ example: 'SHIPPING' }),
      position: z.number().int(),
    })
    .passthrough(),
);

const helpArticleSchema = registry.register(
  'HelpArticle',
  z
    .object({
      id: z.string(),
      slug: z.string(),
      title: z.string(),
      excerpt: z.string().nullable(),
      bodyHtml: z.string().describe('Sanitised at write time against the shared allowlist'),
    })
    .passthrough(),
);

/* ----------------------------------------------------------- OpenAPI docs */

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/content/faqs`,
  tags: ['Content'],
  summary: 'FAQs, optionally narrowed to a product or category',
  description:
    'An untargeted FAQ applies everywhere in its visibility; a targeted one applies only where ' +
    'listed. Empty targets mean everywhere, never nowhere.',
  request: { query: faqPublicQuerySchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(faqSchema)), 'FAQs'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/content/faq-categories`,
  tags: ['Content'],
  summary: 'FAQ categories',
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Categories'),
  },
});

for (const entry of [
  { path: `${API_PREFIX}/content/faqs/{id}/helpful`, summary: 'Was this FAQ helpful?' },
  { path: `${API_PREFIX}/content/help/articles/{id}/helpful`, summary: 'Was this article helpful?' },
]) {
  registry.registerPath({
    method: 'post',
    path: entry.path,
    tags: ['Content'],
    summary: entry.summary,
    request: { params: idParamSchema, body: jsonContent(helpfulVoteSchema, 'Vote') },
    responses: {
      ...commonErrorResponses,
      200: jsonContent(successBodySchema(z.object({ counted: z.boolean() })), 'Counted'),
    },
  });
}

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/content/help`,
  tags: ['Content'],
  summary: 'Help centre: category tree and featured articles',
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(anyObject), 'Help centre'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/content/help/{categorySlug}`,
  tags: ['Content'],
  summary: 'One help category and its articles',
  request: { params: categorySlugParamSchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(anyObject), 'Category'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/content/help/articles/{slug}`,
  tags: ['Content'],
  summary: 'One help article',
  request: { params: cmsSlugParamSchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(helpArticleSchema), 'Article'),
  },
});

for (const entry of [
  { method: 'get' as const, path: '/cms/faq-categories', summary: 'Admin: list FAQ categories' },
  {
    method: 'post' as const,
    path: '/cms/faq-categories',
    summary: 'Admin: create a FAQ category',
    body: faqCategoryCreateSchema,
  },
  { method: 'get' as const, path: '/cms/faqs', summary: 'Admin: list FAQs' },
  { method: 'post' as const, path: '/cms/faqs', summary: 'Admin: create a FAQ', body: faqCreateSchema },
  { method: 'get' as const, path: '/cms/help/categories', summary: 'Admin: help category tree' },
  {
    method: 'post' as const,
    path: '/cms/help/categories',
    summary: 'Admin: create a help category',
    body: helpCategoryCreateSchema,
  },
  { method: 'get' as const, path: '/cms/help/articles', summary: 'Admin: list help articles' },
  {
    method: 'post' as const,
    path: '/cms/help/articles',
    summary: 'Admin: create a help article',
    body: helpArticleCreateSchema,
  },
]) {
  registry.registerPath({
    method: entry.method,
    path: `${ADMIN_PREFIX}${entry.path}`,
    tags: ['Admin CMS'],
    summary: entry.summary,
    security: [{ adminBearer: [] }],
    request: { ...('body' in entry && entry.body ? { body: jsonContent(entry.body, 'Payload') } : {}) },
    responses: {
      ...commonErrorResponses,
      200: jsonContent(successBodySchema(z.array(anyObject)), 'Items'),
      201: jsonContent(successBodySchema(anyObject), 'Created'),
    },
  });
}

for (const entry of [
  {
    method: 'patch' as const,
    path: '/cms/faq-categories/{id}',
    summary: 'Admin: update a FAQ category',
    body: faqCategoryUpdateSchema,
  },
  { method: 'delete' as const, path: '/cms/faq-categories/{id}', summary: 'Admin: delete a FAQ category' },
  { method: 'patch' as const, path: '/cms/faqs/{id}', summary: 'Admin: update a FAQ', body: faqUpdateSchema },
  { method: 'delete' as const, path: '/cms/faqs/{id}', summary: 'Admin: delete a FAQ' },
  {
    method: 'patch' as const,
    path: '/cms/help/categories/{id}',
    summary: 'Admin: update a help category',
    body: helpCategoryUpdateSchema,
  },
  {
    method: 'delete' as const,
    path: '/cms/help/categories/{id}',
    summary: 'Admin: delete a help category',
  },
  {
    method: 'patch' as const,
    path: '/cms/help/articles/{id}',
    summary: 'Admin: update a help article',
    body: helpArticleUpdateSchema,
  },
  { method: 'delete' as const, path: '/cms/help/articles/{id}', summary: 'Admin: delete a help article' },
]) {
  registry.registerPath({
    method: entry.method,
    path: `${ADMIN_PREFIX}${entry.path}`,
    tags: ['Admin CMS'],
    summary: entry.summary,
    security: [{ adminBearer: [] }],
    request: {
      params: idParamSchema,
      ...('body' in entry && entry.body ? { body: jsonContent(entry.body, 'Payload') } : {}),
    },
    responses: {
      ...commonErrorResponses,
      200: jsonContent(successBodySchema(anyObject), 'Item'),
      204: { description: 'Deleted' },
    },
  });
}

for (const path of ['/cms/faqs/reorder', '/cms/help/articles/reorder']) {
  registry.registerPath({
    method: 'post',
    path: `${ADMIN_PREFIX}${path}`,
    tags: ['Admin CMS'],
    summary: `Admin: reorder ${path.includes('help') ? 'help articles' : 'FAQs'}`,
    security: [{ adminBearer: [] }],
    request: { body: jsonContent(cmsReorderSchema, 'Order') },
    responses: { ...commonErrorResponses, 204: { description: 'Reordered' } },
  });
}

/* --------------------------------------------------------------- routes */

faqRouter.get(
  '/content/faqs',
  validate({ query: faqPublicQuerySchema }),
  asyncHandler(publicFaqController.list),
);

faqRouter.get('/content/faq-categories', asyncHandler(publicFaqController.categories));

faqRouter.post(
  '/content/faqs/:id/helpful',
  validate({ params: idParamSchema, body: helpfulVoteSchema }),
  asyncHandler(publicFaqController.vote),
);

faqRouter.get('/content/help', asyncHandler(publicHelpController.overview));

// Before '/help/:categorySlug', or 'articles' is read as a category slug.
faqRouter.post(
  '/content/help/articles/:id/helpful',
  validate({ params: idParamSchema, body: helpfulVoteSchema }),
  asyncHandler(publicHelpController.vote),
);

faqRouter.get(
  '/content/help/articles/:slug',
  validate({ params: cmsSlugParamSchema }),
  asyncHandler(publicHelpController.article),
);

faqRouter.get(
  '/content/help/:categorySlug',
  validate({ params: categorySlugParamSchema }),
  asyncHandler(publicHelpController.category),
);

adminFaqRouter.get(
  '/cms/faq-categories',
  authenticate('ADMIN'),
  requirePermission('cms.faq.read'),
  asyncHandler(adminFaqController.listCategories),
);

adminFaqRouter.post(
  '/cms/faq-categories',
  ...adminGuard,
  requirePermission('cms.faq.create'),
  validate({ body: faqCategoryCreateSchema }),
  asyncHandler(adminFaqController.createCategory),
);

adminFaqRouter.patch(
  '/cms/faq-categories/:id',
  ...adminGuard,
  requirePermission('cms.faq.update'),
  validate({ params: idParamSchema, body: faqCategoryUpdateSchema }),
  asyncHandler(adminFaqController.updateCategory),
);

adminFaqRouter.delete(
  '/cms/faq-categories/:id',
  ...adminGuard,
  requirePermission('cms.faq.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminFaqController.removeCategory),
);

adminFaqRouter.get(
  '/cms/faqs',
  authenticate('ADMIN'),
  requirePermission('cms.faq.read'),
  asyncHandler(adminFaqController.list),
);

adminFaqRouter.post(
  '/cms/faqs/reorder',
  ...adminGuard,
  requirePermission('cms.faq.update'),
  validate({ body: cmsReorderSchema }),
  asyncHandler(adminFaqController.reorder),
);

adminFaqRouter.post(
  '/cms/faqs',
  ...adminGuard,
  requirePermission('cms.faq.create'),
  validate({ body: faqCreateSchema }),
  asyncHandler(adminFaqController.create),
);

adminFaqRouter.patch(
  '/cms/faqs/:id',
  ...adminGuard,
  requirePermission('cms.faq.update'),
  validate({ params: idParamSchema, body: faqUpdateSchema }),
  asyncHandler(adminFaqController.update),
);

adminFaqRouter.delete(
  '/cms/faqs/:id',
  ...adminGuard,
  requirePermission('cms.faq.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminFaqController.remove),
);

adminFaqRouter.get(
  '/cms/help/categories',
  authenticate('ADMIN'),
  requirePermission('cms.page.read'),
  asyncHandler(adminHelpController.tree),
);

adminFaqRouter.post(
  '/cms/help/categories',
  ...adminGuard,
  requirePermission('cms.page.create'),
  validate({ body: helpCategoryCreateSchema }),
  asyncHandler(adminHelpController.createCategory),
);

adminFaqRouter.patch(
  '/cms/help/categories/:id',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ params: idParamSchema, body: helpCategoryUpdateSchema }),
  asyncHandler(adminHelpController.updateCategory),
);

adminFaqRouter.delete(
  '/cms/help/categories/:id',
  ...adminGuard,
  requirePermission('cms.page.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminHelpController.removeCategory),
);

adminFaqRouter.get(
  '/cms/help/articles',
  authenticate('ADMIN'),
  requirePermission('cms.page.read'),
  asyncHandler(adminHelpController.listArticles),
);

adminFaqRouter.post(
  '/cms/help/articles/reorder',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ body: cmsReorderSchema }),
  asyncHandler(adminHelpController.reorderArticles),
);

adminFaqRouter.post(
  '/cms/help/articles',
  ...adminGuard,
  requirePermission('cms.page.create'),
  validate({ body: helpArticleCreateSchema }),
  asyncHandler(adminHelpController.createArticle),
);

adminFaqRouter.patch(
  '/cms/help/articles/:id',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ params: idParamSchema, body: helpArticleUpdateSchema }),
  asyncHandler(adminHelpController.updateArticle),
);

adminFaqRouter.delete(
  '/cms/help/articles/:id',
  ...adminGuard,
  requirePermission('cms.page.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminHelpController.removeArticle),
);
