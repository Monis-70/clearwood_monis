import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import { idParamSchema } from '@shared/schemas/common';
import {
  announcementCreateSchema,
  announcementUpdateSchema,
  bannerCreateSchema,
  bannerListQuerySchema,
  bannerPublicQuerySchema,
  bannerUpdateSchema,
  blockCreateSchema,
  blockReorderSchema,
  blockUpdateSchema,
  cmsReorderSchema,
  cmsSlugParamSchema,
  contentPageQuerySchema,
  pageCreateSchema,
  pageDuplicateSchema,
  pageListQuerySchema,
  pageScheduleSchema,
  pageUpdateSchema,
} from '@shared/schemas/cms';

import {
  adminAnnouncementController,
  adminBannerController,
  adminPageController,
  contentController,
} from '../controllers/cms.controller';
import {
  commonErrorResponses,
  jsonContent,
  nullDataResponse,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';
import { asyncHandler, authenticate, optionalAuth, requirePermission, validate } from '../middleware';
import { csrfProtection } from '../modules/auth/csrf.service';

/**
 * Prompt 10A — CMS pages, blocks, banners and the announcement bar.
 *
 * Public reads use `optionalAuth` on purpose: a signed-in wholesale customer must see their own
 * prices inside a product block, and an anonymous one must not be handed somebody else's.
 */

const ADMIN_PREFIX = `${API_PREFIX}/admin`;
const adminGuard = [authenticate('ADMIN'), csrfProtection('ADMIN')];

export const contentRouter: Router = Router();
export const adminCmsRouter: Router = Router();

const anyObject = z.record(z.unknown());

const renderedPageSchema = registry.register(
  'RenderedPage',
  z
    .object({
      slug: z.string(),
      title: z.string(),
      type: z.string(),
      pricingBasis: z.string().describe('DEFAULT_GROUP, or CUSTOMER_GROUP:{code}'),
      seo: anyObject,
      blocks: z.array(
        z.object({
          id: z.string(),
          type: z.string().openapi({ example: 'HERO_SLIDER' }),
          position: z.number().int(),
          config: anyObject,
          data: anyObject.describe('Hydrated, render-ready payload for this block type'),
        }),
      ),
    })
    .passthrough(),
);

const adminPageSchema = registry.register(
  'AdminPage',
  z
    .object({
      id: z.string(),
      slug: z.string(),
      title: z.string(),
      status: z.string().openapi({ example: 'PUBLISHED' }),
      isSystem: z.boolean(),
      version: z.number().int(),
      blocks: z.array(anyObject),
    })
    .passthrough(),
);

const bannerSchema = registry.register(
  'Banner',
  z
    .object({
      id: z.string(),
      name: z.string(),
      placement: z.string().openapi({ example: 'HOME_HERO' }),
      position: z.number().int(),
    })
    .passthrough(),
);

const blockTypeSchema = registry.register(
  'BlockTypeDefinition',
  z
    .object({
      type: z.string(),
      label: z.string(),
      description: z.string(),
      category: z.string(),
      maxPerPage: z.number().int().nullable(),
      defaultConfig: anyObject,
      mediaFields: z.array(z.string()),
      referenceFields: anyObject,
    })
    .passthrough(),
);

/* ----------------------------------------------------------- OpenAPI docs */

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/content/home`,
  tags: ['Content'],
  summary: 'The home page, fully hydrated',
  description:
    'Every block arrives render-ready: product blocks carry priced cards from the P6 engine for ' +
    'the caller\u2019s customer group, media carries its source set. ETag and 304 supported.',
  request: { query: contentPageQuerySchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(renderedPageSchema), 'Hydrated home page'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/content/pages/{slug}`,
  tags: ['Content'],
  summary: 'A published page, fully hydrated',
  description: 'A draft, scheduled-for-later or expired page answers 404, never 403.',
  request: { params: cmsSlugParamSchema, query: contentPageQuerySchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(renderedPageSchema), 'Hydrated page'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/content/banners`,
  tags: ['Content'],
  summary: 'Live banners for a placement',
  request: { query: bannerPublicQuerySchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(bannerSchema)), 'Banners'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/content/banners/{id}/impression`,
  tags: ['Content'],
  summary: 'Record a banner impression',
  description: 'Accepted and counted out of band; never delays or fails the page that reported it.',
  request: { params: idParamSchema },
  responses: {
    ...commonErrorResponses,
    202: jsonContent(successBodySchema(z.object({ accepted: z.boolean() })), 'Accepted'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/content/banners/{id}/click`,
  tags: ['Content'],
  summary: 'Record a banner click',
  request: { params: idParamSchema },
  responses: {
    ...commonErrorResponses,
    202: jsonContent(successBodySchema(z.object({ accepted: z.boolean() })), 'Accepted'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/content/announcement`,
  tags: ['Content'],
  summary: 'The announcement bar showing right now, or null',
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(anyObject.nullable()), 'Announcement'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/cms/block-types`,
  tags: ['Admin CMS'],
  summary: 'Admin: the block registry',
  description:
    'The contract the page builder is generated from: every block type with its default config ' +
    'and the config paths holding media ids and entity references.',
  security: [{ adminBearer: [] }],
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(blockTypeSchema)), 'Block types'),
  },
});

const pagePaths = [
  { method: 'get' as const, path: '/cms/pages', summary: 'Admin: list pages', query: pageListQuerySchema },
  { method: 'post' as const, path: '/cms/pages', summary: 'Admin: create a page', body: pageCreateSchema },
];

for (const entry of pagePaths) {
  registry.registerPath({
    method: entry.method,
    path: `${ADMIN_PREFIX}${entry.path}`,
    tags: ['Admin CMS'],
    summary: entry.summary,
    security: [{ adminBearer: [] }],
    request: {
      ...(entry.query ? { query: entry.query } : {}),
      ...(entry.body ? { body: jsonContent(entry.body, 'Page') } : {}),
    },
    responses: {
      ...commonErrorResponses,
      ...(entry.method === 'post'
        ? { 201: jsonContent(successBodySchema(adminPageSchema), 'Created') }
        : { 200: jsonContent(successBodySchema(z.array(adminPageSchema)), 'Pages') }),
    },
  });
}

for (const entry of [
  { method: 'get' as const, summary: 'Admin: read a page' },
  { method: 'patch' as const, summary: 'Admin: update a page', body: pageUpdateSchema },
  { method: 'delete' as const, summary: 'Admin: soft-delete a page' },
]) {
  registry.registerPath({
    method: entry.method,
    path: `${ADMIN_PREFIX}/cms/pages/{id}`,
    tags: ['Admin CMS'],
    summary: entry.summary,
    security: [{ adminBearer: [] }],
    request: {
      params: idParamSchema,
      ...('body' in entry && entry.body ? { body: jsonContent(entry.body, 'Page') } : {}),
    },
    responses: {
      ...commonErrorResponses,
      200:
        entry.method === 'delete'
          ? nullDataResponse
          : jsonContent(successBodySchema(adminPageSchema), 'Page'),
    },
  });
}

for (const entry of [
  { path: '/cms/pages/{id}/publish', summary: 'Admin: publish a page', body: undefined },
  { path: '/cms/pages/{id}/unpublish', summary: 'Admin: unpublish a page', body: undefined },
  { path: '/cms/pages/{id}/schedule', summary: 'Admin: schedule a page', body: pageScheduleSchema },
  {
    path: '/cms/pages/{id}/duplicate',
    summary: 'Admin: duplicate a page',
    body: pageDuplicateSchema,
    created: true,
  },
  { path: '/cms/pages/{id}/preview', summary: 'Admin: render a page including drafts', body: undefined },
  { path: '/cms/pages/{id}/blocks', summary: 'Admin: add a block', body: blockCreateSchema, created: true },
  { path: '/cms/pages/{id}/blocks/reorder', summary: 'Admin: reorder blocks', body: blockReorderSchema },
]) {
  registry.registerPath({
    method: 'post',
    path: `${ADMIN_PREFIX}${entry.path}`,
    tags: ['Admin CMS'],
    summary: entry.summary,
    description:
      entry.path.endsWith('/publish') || entry.path.endsWith('/schedule')
        ? 'Refuses with 422 PAGE_NOT_PUBLISHABLE and returns EVERY blocker at once, like the product publish gate.'
        : undefined,
    security: [{ adminBearer: [] }],
    request: {
      params: idParamSchema,
      ...(entry.body ? { body: jsonContent(entry.body, 'Payload') } : {}),
    },
    responses: {
      ...commonErrorResponses,
      ...('created' in entry && entry.created
        ? { 201: jsonContent(successBodySchema(adminPageSchema), 'Created') }
        : entry.path.endsWith('/preview')
          ? { 200: jsonContent(successBodySchema(renderedPageSchema), 'Rendered page') }
          : { 200: jsonContent(successBodySchema(adminPageSchema), 'Page') }),
    },
  });
}

for (const entry of [
  { method: 'patch' as const, summary: 'Admin: update a block', body: blockUpdateSchema },
  { method: 'delete' as const, summary: 'Admin: remove a block', body: undefined },
]) {
  registry.registerPath({
    method: entry.method,
    path: `${ADMIN_PREFIX}/cms/pages/{id}/blocks/{blockId}`,
    tags: ['Admin CMS'],
    summary: entry.summary,
    security: [{ adminBearer: [] }],
    request: {
      params: z.object({ id: z.string(), blockId: z.string() }),
      ...(entry.body ? { body: jsonContent(entry.body, 'Block') } : {}),
    },
    responses: {
      ...commonErrorResponses,
      200: jsonContent(successBodySchema(adminPageSchema), 'Page'),
    },
  });
}

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/cms/pages/{id}/revisions`,
  tags: ['Admin CMS'],
  summary: 'Admin: list a page\u2019s revisions',
  security: [{ adminBearer: [] }],
  request: { params: idParamSchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Revisions'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/cms/pages/{id}/revisions/{version}/restore`,
  tags: ['Admin CMS'],
  summary: 'Admin: restore a revision',
  description: 'Writes a NEW revision rather than rewinding, so the history stays append-only.',
  security: [{ adminBearer: [] }],
  request: { params: z.object({ id: z.string(), version: z.string() }) },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(adminPageSchema), 'Restored page'),
  },
});

for (const entry of [
  { method: 'get' as const, path: '/cms/banners', summary: 'Admin: list banners', query: bannerListQuerySchema },
  { method: 'post' as const, path: '/cms/banners', summary: 'Admin: create a banner', body: bannerCreateSchema },
  { method: 'get' as const, path: '/cms/announcements', summary: 'Admin: list announcement bars' },
  {
    method: 'post' as const,
    path: '/cms/announcements',
    summary: 'Admin: create an announcement bar',
    body: announcementCreateSchema,
  },
]) {
  registry.registerPath({
    method: entry.method,
    path: `${ADMIN_PREFIX}${entry.path}`,
    tags: ['Admin CMS'],
    summary: entry.summary,
    security: [{ adminBearer: [] }],
    request: {
      ...('query' in entry && entry.query ? { query: entry.query } : {}),
      ...('body' in entry && entry.body ? { body: jsonContent(entry.body, 'Payload') } : {}),
    },
    responses: {
      ...commonErrorResponses,
      ...(entry.method === 'post'
        ? { 201: jsonContent(successBodySchema(bannerSchema), 'Created') }
        : { 200: jsonContent(successBodySchema(z.array(bannerSchema)), 'Items') }),
    },
  });
}

for (const entry of [
  { method: 'patch' as const, path: '/cms/banners/{id}', summary: 'Admin: update a banner', body: bannerUpdateSchema },
  { method: 'delete' as const, path: '/cms/banners/{id}', summary: 'Admin: delete a banner' },
  {
    method: 'patch' as const,
    path: '/cms/announcements/{id}',
    summary: 'Admin: update an announcement bar',
    body: announcementUpdateSchema,
  },
  { method: 'delete' as const, path: '/cms/announcements/{id}', summary: 'Admin: delete an announcement bar' },
  { method: 'get' as const, path: '/cms/banners/{id}/stats', summary: 'Admin: banner impressions and clicks' },
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
      200:
        entry.method === 'delete'
          ? nullDataResponse
          : entry.path.endsWith('/stats')
            ? jsonContent(successBodySchema(anyObject), 'Impressions and clicks')
            : jsonContent(successBodySchema(bannerSchema), 'Item'),
    },
  });
}

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/cms/banners/reorder`,
  tags: ['Admin CMS'],
  summary: 'Admin: reorder banners',
  security: [{ adminBearer: [] }],
  request: { body: jsonContent(cmsReorderSchema, 'Order') },
  responses: { ...commonErrorResponses, 200: nullDataResponse },
});

/* --------------------------------------------------------------- routes */

contentRouter.get(
  '/content/home',
  optionalAuth('CUSTOMER'),
  validate({ query: contentPageQuerySchema }),
  asyncHandler(contentController.home),
);

contentRouter.get(
  '/content/banners',
  validate({ query: bannerPublicQuerySchema }),
  asyncHandler(contentController.banners),
);

contentRouter.get('/content/announcement', asyncHandler(contentController.announcement));

contentRouter.post(
  '/content/banners/:id/impression',
  validate({ params: idParamSchema }),
  asyncHandler(contentController.impression),
);

contentRouter.post(
  '/content/banners/:id/click',
  validate({ params: idParamSchema }),
  asyncHandler(contentController.click),
);

// Last of the /content routes: ':slug' would otherwise swallow 'home' and 'banners'.
contentRouter.get(
  '/content/pages/:slug',
  optionalAuth('CUSTOMER'),
  validate({ params: cmsSlugParamSchema, query: contentPageQuerySchema }),
  asyncHandler(contentController.page),
);

adminCmsRouter.get(
  '/cms/block-types',
  authenticate('ADMIN'),
  requirePermission('cms.page.read'),
  asyncHandler(adminPageController.blockTypes),
);

adminCmsRouter.get(
  '/cms/pages',
  authenticate('ADMIN'),
  requirePermission('cms.page.read'),
  validate({ query: pageListQuerySchema }),
  asyncHandler(adminPageController.list),
);

adminCmsRouter.post(
  '/cms/pages',
  ...adminGuard,
  requirePermission('cms.page.create'),
  validate({ body: pageCreateSchema }),
  asyncHandler(adminPageController.create),
);

adminCmsRouter.get(
  '/cms/pages/:id',
  authenticate('ADMIN'),
  requirePermission('cms.page.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminPageController.get),
);

adminCmsRouter.patch(
  '/cms/pages/:id',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ params: idParamSchema, body: pageUpdateSchema }),
  asyncHandler(adminPageController.update),
);

adminCmsRouter.delete(
  '/cms/pages/:id',
  ...adminGuard,
  requirePermission('cms.page.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminPageController.remove),
);

adminCmsRouter.post(
  '/cms/pages/:id/duplicate',
  ...adminGuard,
  requirePermission('cms.page.create'),
  validate({ params: idParamSchema, body: pageDuplicateSchema }),
  asyncHandler(adminPageController.duplicate),
);

adminCmsRouter.post(
  '/cms/pages/:id/publish',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminPageController.publish),
);

adminCmsRouter.post(
  '/cms/pages/:id/unpublish',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminPageController.unpublish),
);

adminCmsRouter.post(
  '/cms/pages/:id/schedule',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ params: idParamSchema, body: pageScheduleSchema }),
  asyncHandler(adminPageController.schedule),
);

adminCmsRouter.post(
  '/cms/pages/:id/preview',
  ...adminGuard,
  requirePermission('cms.page.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminPageController.preview),
);

// Before '/blocks/:blockId', or 'reorder' is read as a block id.
adminCmsRouter.post(
  '/cms/pages/:id/blocks/reorder',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ params: idParamSchema, body: blockReorderSchema }),
  asyncHandler(adminPageController.reorderBlocks),
);

adminCmsRouter.post(
  '/cms/pages/:id/blocks',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ params: idParamSchema, body: blockCreateSchema }),
  asyncHandler(adminPageController.addBlock),
);

adminCmsRouter.patch(
  '/cms/pages/:id/blocks/:blockId',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ body: blockUpdateSchema }),
  asyncHandler(adminPageController.updateBlock),
);

adminCmsRouter.delete(
  '/cms/pages/:id/blocks/:blockId',
  ...adminGuard,
  requirePermission('cms.page.update'),
  asyncHandler(adminPageController.removeBlock),
);

adminCmsRouter.get(
  '/cms/pages/:id/revisions',
  authenticate('ADMIN'),
  requirePermission('cms.page.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminPageController.listRevisions),
);

adminCmsRouter.post(
  '/cms/pages/:id/revisions/:version/restore',
  ...adminGuard,
  requirePermission('cms.page.update'),
  asyncHandler(adminPageController.restoreRevision),
);

adminCmsRouter.get(
  '/cms/banners',
  authenticate('ADMIN'),
  requirePermission('cms.banner.read'),
  validate({ query: bannerListQuerySchema }),
  asyncHandler(adminBannerController.list),
);

adminCmsRouter.post(
  '/cms/banners/reorder',
  ...adminGuard,
  requirePermission('cms.banner.update'),
  validate({ body: cmsReorderSchema }),
  asyncHandler(adminBannerController.reorder),
);

adminCmsRouter.post(
  '/cms/banners',
  ...adminGuard,
  requirePermission('cms.banner.create'),
  validate({ body: bannerCreateSchema }),
  asyncHandler(adminBannerController.create),
);

adminCmsRouter.get(
  '/cms/banners/:id/stats',
  authenticate('ADMIN'),
  requirePermission('cms.banner.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminBannerController.stats),
);

adminCmsRouter.patch(
  '/cms/banners/:id',
  ...adminGuard,
  requirePermission('cms.banner.update'),
  validate({ params: idParamSchema, body: bannerUpdateSchema }),
  asyncHandler(adminBannerController.update),
);

adminCmsRouter.delete(
  '/cms/banners/:id',
  ...adminGuard,
  requirePermission('cms.banner.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminBannerController.remove),
);

adminCmsRouter.get(
  '/cms/announcements',
  authenticate('ADMIN'),
  requirePermission('cms.banner.read'),
  asyncHandler(adminAnnouncementController.list),
);

adminCmsRouter.post(
  '/cms/announcements',
  ...adminGuard,
  requirePermission('cms.banner.create'),
  validate({ body: announcementCreateSchema }),
  asyncHandler(adminAnnouncementController.create),
);

adminCmsRouter.patch(
  '/cms/announcements/:id',
  ...adminGuard,
  requirePermission('cms.banner.update'),
  validate({ params: idParamSchema, body: announcementUpdateSchema }),
  asyncHandler(adminAnnouncementController.update),
);

adminCmsRouter.delete(
  '/cms/announcements/:id',
  ...adminGuard,
  requirePermission('cms.banner.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminAnnouncementController.remove),
);
