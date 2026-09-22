import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import { idParamSchema } from '@shared/schemas/common';
import {
  cmsReorderSchema,
  contentSettingsSchema,
  navigationItemCreateSchema,
  navigationItemUpdateSchema,
  storeCreateSchema,
  storeUpdateSchema,
  testimonialCreateSchema,
  testimonialUpdateSchema,
} from '@shared/schemas/cms';

import {
  adminContentSettingsController,
  adminNavigationController,
  adminSeoController,
  adminStoreController,
  adminTestimonialController,
  publicContentController,
} from '../controllers/content.controller';
import { commonErrorResponses, jsonContent, registry, successBodySchema, z } from '../docs/registry';
import { asyncHandler, authenticate, requirePermission, validate } from '../middleware';
import { csrfProtection } from '../modules/auth/csrf.service';

/** Prompt 10A — testimonials, stores, navigation administration, site settings and SEO. */

const ADMIN_PREFIX = `${API_PREFIX}/admin`;
const adminGuard = [authenticate('ADMIN'), csrfProtection('ADMIN')];

export const publicContentRouter: Router = Router();
export const adminContentRouter: Router = Router();

const anyObject = z.record(z.unknown());
const menuKeyParamSchema = z.object({ key: z.string().trim().min(2).max(40) });

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/content/testimonials`,
  tags: ['Content'],
  summary: 'Customer testimonials',
  request: { query: z.object({ featured: z.coerce.boolean().optional() }) },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Testimonials'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/content/stores`,
  tags: ['Content'],
  summary: 'Showroom locations and opening hours',
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(anyObject)), 'Stores'),
  },
});

for (const entry of [
  { method: 'get' as const, path: '/cms/testimonials', summary: 'Admin: list testimonials' },
  {
    method: 'post' as const,
    path: '/cms/testimonials',
    summary: 'Admin: create a testimonial',
    body: testimonialCreateSchema,
  },
  { method: 'get' as const, path: '/cms/stores', summary: 'Admin: list stores' },
  { method: 'post' as const, path: '/cms/stores', summary: 'Admin: create a store', body: storeCreateSchema },
  { method: 'get' as const, path: '/navigation', summary: 'Admin: list navigation menus' },
  { method: 'get' as const, path: '/content/settings', summary: 'Admin: read the content settings' },
  {
    method: 'put' as const,
    path: '/content/settings',
    summary: 'Admin: write the content settings',
    body: contentSettingsSchema,
  },
  { method: 'post' as const, path: '/seo/sitemap/rebuild', summary: 'Admin: rebuild the sitemap cache' },
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
      200: jsonContent(successBodySchema(anyObject), 'Result'),
      201: jsonContent(successBodySchema(anyObject), 'Created'),
    },
  });
}

for (const entry of [
  {
    method: 'patch' as const,
    path: '/cms/testimonials/{id}',
    summary: 'Admin: update a testimonial',
    body: testimonialUpdateSchema,
  },
  { method: 'delete' as const, path: '/cms/testimonials/{id}', summary: 'Admin: delete a testimonial' },
  { method: 'patch' as const, path: '/cms/stores/{id}', summary: 'Admin: update a store', body: storeUpdateSchema },
  { method: 'delete' as const, path: '/cms/stores/{id}', summary: 'Admin: delete a store' },
  {
    method: 'patch' as const,
    path: '/navigation/items/{id}',
    summary: 'Admin: update a navigation item',
    body: navigationItemUpdateSchema,
  },
  { method: 'delete' as const, path: '/navigation/items/{id}', summary: 'Admin: delete a navigation item' },
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

for (const path of ['/cms/testimonials/reorder', '/cms/stores/reorder']) {
  registry.registerPath({
    method: 'post',
    path: `${ADMIN_PREFIX}${path}`,
    tags: ['Admin CMS'],
    summary: `Admin: reorder ${path.includes('stores') ? 'stores' : 'testimonials'}`,
    security: [{ adminBearer: [] }],
    request: { body: jsonContent(cmsReorderSchema, 'Order') },
    responses: { ...commonErrorResponses, 204: { description: 'Reordered' } },
  });
}

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/navigation/{key}`,
  tags: ['Admin CMS'],
  summary: 'Admin: one navigation menu with its items',
  security: [{ adminBearer: [] }],
  request: { params: menuKeyParamSchema },
  responses: { ...commonErrorResponses, 200: jsonContent(successBodySchema(anyObject), 'Menu') },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/navigation/{key}/items`,
  tags: ['Admin CMS'],
  summary: 'Admin: add a navigation item',
  description:
    'The target is verified: CATEGORY needs a live category, COLLECTION a live collection, PAGE a ' +
    'published page, URL a relative or https link. Depth is capped at 3.',
  security: [{ adminBearer: [] }],
  request: { params: menuKeyParamSchema, body: jsonContent(navigationItemCreateSchema, 'Item') },
  responses: { ...commonErrorResponses, 201: jsonContent(successBodySchema(anyObject), 'Created') },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/navigation/{key}/reorder`,
  tags: ['Admin CMS'],
  summary: 'Admin: reorder a navigation menu',
  security: [{ adminBearer: [] }],
  request: { params: menuKeyParamSchema, body: jsonContent(cmsReorderSchema, 'Order') },
  responses: { ...commonErrorResponses, 204: { description: 'Reordered' } },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/seo/preview/{type}/{id}`,
  tags: ['Admin CMS'],
  summary: 'Admin: the meta tags an entity will render with',
  security: [{ adminBearer: [] }],
  request: { params: z.object({ type: z.string(), id: z.string() }) },
  responses: { ...commonErrorResponses, 200: jsonContent(successBodySchema(anyObject), 'Meta') },
});

/*
 * Root-mounted, outside API_PREFIX and outside the API rate limiter: crawlers look for these at
 * the root and nowhere else, and throttling Googlebot is a way to get deindexed.
 */
const xmlResponse = {
  description: 'XML',
  content: { 'application/xml': { schema: z.string() } },
};

registry.registerPath({
  method: 'get',
  path: '/sitemap.xml',
  tags: ['SEO'],
  summary: 'Sitemap index',
  description: 'Lists one child sitemap per section per SITEMAP_PAGE_SIZE page.',
  responses: { 200: xmlResponse },
});

registry.registerPath({
  method: 'get',
  path: '/sitemap-{section}.xml',
  tags: ['SEO'],
  summary: 'One sitemap section',
  description:
    'Sections: products, categories, collections, pages, help. A page number may be appended ' +
    '(`sitemap-products-2.xml`). Only indexable, published, non-noIndex, non-deleted entries.',
  request: { params: z.object({ section: z.string().openapi({ example: 'products' }) }) },
  responses: { 200: xmlResponse, 404: xmlResponse },
});

registry.registerPath({
  method: 'get',
  path: '/robots.txt',
  tags: ['SEO'],
  summary: 'robots.txt, rendered from settings',
  responses: {
    200: { description: 'Plain text', content: { 'text/plain': { schema: z.string() } } },
  },
});

/* --------------------------------------------------------------- routes */

publicContentRouter.get('/content/testimonials', asyncHandler(publicContentController.testimonials));
publicContentRouter.get('/content/stores', asyncHandler(publicContentController.stores));

adminContentRouter.get(
  '/cms/testimonials',
  authenticate('ADMIN'),
  requirePermission('cms.page.read'),
  asyncHandler(adminTestimonialController.list),
);

adminContentRouter.post(
  '/cms/testimonials/reorder',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ body: cmsReorderSchema }),
  asyncHandler(adminTestimonialController.reorder),
);

adminContentRouter.post(
  '/cms/testimonials',
  ...adminGuard,
  requirePermission('cms.page.create'),
  validate({ body: testimonialCreateSchema }),
  asyncHandler(adminTestimonialController.create),
);

adminContentRouter.patch(
  '/cms/testimonials/:id',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ params: idParamSchema, body: testimonialUpdateSchema }),
  asyncHandler(adminTestimonialController.update),
);

adminContentRouter.delete(
  '/cms/testimonials/:id',
  ...adminGuard,
  requirePermission('cms.page.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminTestimonialController.remove),
);

adminContentRouter.get(
  '/cms/stores',
  authenticate('ADMIN'),
  requirePermission('cms.page.read'),
  asyncHandler(adminStoreController.list),
);

adminContentRouter.post(
  '/cms/stores/reorder',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ body: cmsReorderSchema }),
  asyncHandler(adminStoreController.reorder),
);

adminContentRouter.post(
  '/cms/stores',
  ...adminGuard,
  requirePermission('cms.page.create'),
  validate({ body: storeCreateSchema }),
  asyncHandler(adminStoreController.create),
);

adminContentRouter.patch(
  '/cms/stores/:id',
  ...adminGuard,
  requirePermission('cms.page.update'),
  validate({ params: idParamSchema, body: storeUpdateSchema }),
  asyncHandler(adminStoreController.update),
);

adminContentRouter.delete(
  '/cms/stores/:id',
  ...adminGuard,
  requirePermission('cms.page.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminStoreController.remove),
);

adminContentRouter.get(
  '/navigation',
  authenticate('ADMIN'),
  requirePermission('cms.navigation.read'),
  asyncHandler(adminNavigationController.listMenus),
);

// Before '/navigation/:key', or 'items' is read as a menu key.
adminContentRouter.patch(
  '/navigation/items/:id',
  ...adminGuard,
  requirePermission('cms.navigation.update'),
  validate({ params: idParamSchema, body: navigationItemUpdateSchema }),
  asyncHandler(adminNavigationController.updateItem),
);

adminContentRouter.delete(
  '/navigation/items/:id',
  ...adminGuard,
  requirePermission('cms.navigation.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminNavigationController.removeItem),
);

adminContentRouter.get(
  '/navigation/:key',
  authenticate('ADMIN'),
  requirePermission('cms.navigation.read'),
  validate({ params: menuKeyParamSchema }),
  asyncHandler(adminNavigationController.menu),
);

adminContentRouter.post(
  '/navigation/:key/items',
  ...adminGuard,
  requirePermission('cms.navigation.update'),
  validate({ params: menuKeyParamSchema, body: navigationItemCreateSchema }),
  asyncHandler(adminNavigationController.createItem),
);

adminContentRouter.post(
  '/navigation/:key/reorder',
  ...adminGuard,
  requirePermission('cms.navigation.update'),
  validate({ params: menuKeyParamSchema, body: cmsReorderSchema }),
  asyncHandler(adminNavigationController.reorder),
);

adminContentRouter.get(
  '/content/settings',
  authenticate('ADMIN'),
  requirePermission('system.setting.read'),
  asyncHandler(adminContentSettingsController.get),
);

adminContentRouter.put(
  '/content/settings',
  ...adminGuard,
  requirePermission('system.setting.update'),
  validate({ body: contentSettingsSchema }),
  asyncHandler(adminContentSettingsController.put),
);

adminContentRouter.post(
  '/seo/sitemap/rebuild',
  ...adminGuard,
  requirePermission('cms.page.update'),
  asyncHandler(adminSeoController.rebuild),
);

adminContentRouter.get(
  '/seo/preview/:type/:id',
  authenticate('ADMIN'),
  requirePermission('cms.page.read'),
  asyncHandler(adminSeoController.preview),
);
