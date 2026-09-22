import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import { idParamSchema, slugParamSchema } from '@shared/schemas/common';
import {
  galleryQuerySchema,
  mediaBulkDeleteSchema,
  mediaFolderCreateSchema,
  mediaFolderUpdateSchema,
  mediaHardDeleteQuerySchema,
  mediaListQuerySchema,
  mediaPresignSchema,
  mediaUpdateSchema,
  productMediaAttachSchema,
  productMediaItemParamsSchema,
  productMediaParamsSchema,
  productMediaReorderSchema,
  productMediaUpdateSchema,
} from '@shared/schemas/media';

import {
  adminMediaController,
  productMediaController,
  publicMediaController,
} from '../controllers/media.controller';
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
  authenticate,
  authRateLimit,
  requirePermission,
  validate,
} from '../middleware';
import { uploadMiddleware } from '../middleware/upload';
import { csrfProtection } from '../modules/auth/csrf.service';

const ADMIN_PREFIX = `${API_PREFIX}/admin`;
const guard = [authenticate('ADMIN'), csrfProtection('ADMIN')];

const unauthorised = { 401: jsonContent(errorBodySchema, 'Not authenticated') };
const forbidden = { 403: jsonContent(errorBodySchema, 'Missing permission or CSRF token') };
const notFound = { 404: jsonContent(errorBodySchema, 'No such record') };

const mediaVariantSchema = registry.register(
  'MediaVariant',
  z.object({
    id: z.string(),
    label: z.string(),
    format: z.string(),
    url: z.string(),
    width: z.number().int(),
    height: z.number().int(),
    sizeBytes: z.number().int(),
    isDefault: z.boolean(),
    deviceTarget: z.string(),
  }),
);

const mediaAssetSchema = registry.register(
  'MediaAsset',
  z.object({
    id: z.string(),
    kind: z.string(),
    status: z.string(),
    source: z.string(),
    disk: z.string(),
    path: z.string(),
    url: z.string(),
    mimeType: z.string(),
    originalName: z.string(),
    sizeBytes: z.number().int(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    durationSec: z.number().int().nullable(),
    altText: z.string().nullable(),
    title: z.string().nullable(),
    tags: z.array(z.string()),
    folderId: z.string().nullable(),
    folderPath: z.string().nullable(),
    checksumSha256: z.string().nullable(),
    dominantColorHex: z.string().nullable(),
    blurhash: z.string().nullable(),
    lqipDataUri: z.string().nullable(),
    focalPoint: z.object({ x: z.number().int(), y: z.number().int() }).nullable(),
    isOptimized: z.boolean(),
    processingError: z.string().nullable(),
    usageCount: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    variants: z.array(mediaVariantSchema),
  }),
);

const mediaFolderSchema = registry.register(
  'MediaFolder',
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    path: z.string(),
    depth: z.number().int(),
    position: z.number().int(),
    parentId: z.string().nullable(),
    isSystem: z.boolean(),
    mediaCount: z.number().int().optional(),
    children: z.array(z.record(z.any())).optional(),
  }),
);

const galleryItemSchema = registry.register(
  'GalleryItem',
  z.object({
    mediaId: z.string(),
    productMediaId: z.string(),
    role: z.string(),
    position: z.number().int(),
    alt: z.string().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    focalPoint: z.object({ x: z.number().int(), y: z.number().int() }).nullable(),
    blurhash: z.string().nullable(),
    lqip: z.string().nullable(),
    url: z.string(),
    deviceTarget: z.string(),
    attributeValueId: z.string().nullable(),
    variantId: z.string().nullable(),
    sources: z.array(
      z.object({
        label: z.string(),
        format: z.string(),
        url: z.string(),
        width: z.number().int(),
        height: z.number().int(),
      }),
    ),
  }),
);

function adminPath(suffix: string): string {
  return `${ADMIN_PREFIX}${suffix}`;
}

registry.registerPath({
  method: 'post',
  path: adminPath('/media/upload'),
  tags: ['Media'],
  summary: 'Upload one or more assets',
  description:
    'multipart/form-data, field `files` (max MAX_UPLOAD_FILES). Types are identified by magic bytes, ' +
    'SVG is sanitised, identical bytes are de-duplicated and renditions are generated inline. ' +
    'Requires `media.asset.upload`.',
  responses: {
    201: jsonContent(
      successBodySchema(
        z.object({
          uploaded: z.array(z.object({ media: mediaAssetSchema, deduplicated: z.boolean() })),
        }),
      ),
      'Uploaded',
    ),
    413: jsonContent(errorBodySchema, 'File too large'),
    415: jsonContent(errorBodySchema, 'Unsupported file type'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: adminPath('/media'),
  tags: ['Media'],
  summary: 'Browse the media library',
  description: 'Requires `media.asset.read`.',
  request: { query: mediaListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(mediaAssetSchema)), 'Assets (paginated)'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: adminPath('/media/config'),
  tags: ['Media'],
  summary: 'Upload limits and the rendition ladder',
  description: 'The admin UI reads its limits from here so nothing is hardcoded in React (R8).',
  responses: {
    200: jsonContent(successBodySchema(z.record(z.any())), 'Media configuration'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: adminPath('/media/{id}'),
  tags: ['Media'],
  summary: 'One asset with its renditions and usage list',
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(mediaAssetSchema), 'Asset detail'),
    ...notFound,
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'patch',
  path: adminPath('/media/{id}'),
  tags: ['Media'],
  summary: 'Edit alt text, title, tags, focal point or folder',
  description: 'Requires `media.asset.update`.',
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: mediaUpdateSchema } } },
  },
  responses: {
    200: jsonContent(successBodySchema(mediaAssetSchema), 'Updated'),
    ...notFound,
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'delete',
  path: adminPath('/media/{id}/permanent'),
  tags: ['Media'],
  summary: 'Permanently delete an asset and its files',
  description:
    'Refuses with 409 MEDIA_IN_USE while MediaUsage rows exist; `?force=true` detaches them first ' +
    'and raises the audit severity. Requires `media.asset.delete`.',
  request: { params: idParamSchema, query: mediaHardDeleteQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.record(z.any())), 'Deleted'),
    409: jsonContent(errorBodySchema, 'Still referenced'),
    ...notFound,
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: adminPath('/media-folders'),
  tags: ['Media'],
  summary: 'The media folder tree',
  responses: {
    200: jsonContent(successBodySchema(z.array(mediaFolderSchema)), 'Folders'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: adminPath('/products/{productId}/media'),
  tags: ['Media'],
  summary: 'A product gallery, in admin order',
  description: 'Requires `catalog.product.update`.',
  request: { params: productMediaParamsSchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(z.record(z.any()))), 'Gallery items'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/catalog/products/{slug}/gallery`,
  tags: ['Catalog'],
  summary: 'Resolved public gallery for a product',
  description:
    'Variant-specific images beat colour-specific ones, which beat the generic gallery. PRIMARY is ' +
    'always first and HOVER second. Not the full PDP — that is Prompt 7.',
  request: { params: slugParamSchema, query: galleryQuerySchema },
  responses: {
    200: jsonContent(
      successBodySchema(
        z.object({
          productId: z.string(),
          slug: z.string(),
          items: z.array(galleryItemSchema),
        }),
      ),
      'Ordered gallery',
    ),
    ...notFound,
    ...commonErrorResponses,
  },
});

/* ---------------------------------------------------------------- routes */

export const adminMediaRouter: Router = Router();

adminMediaRouter.get(
  '/media/config',
  authenticate('ADMIN'),
  requirePermission('media.asset.read'),
  asyncHandler(adminMediaController.config),
);

adminMediaRouter.post(
  '/media/upload',
  ...guard,
  requirePermission('media.asset.upload'),
  authRateLimit('media-upload'),
  uploadMiddleware.array('files'),
  asyncHandler(adminMediaController.upload),
);

adminMediaRouter.post(
  '/media/presign',
  ...guard,
  requirePermission('media.asset.upload'),
  authRateLimit('media-presign'),
  validate({ body: mediaPresignSchema }),
  asyncHandler(adminMediaController.presign),
);

adminMediaRouter.get(
  '/media',
  authenticate('ADMIN'),
  requirePermission('media.asset.read'),
  validate({ query: mediaListQuerySchema }),
  asyncHandler(adminMediaController.list),
);

adminMediaRouter.get(
  '/media/gc',
  authenticate('ADMIN'),
  requirePermission('media.asset.delete'),
  asyncHandler(adminMediaController.garbageCollect),
);

adminMediaRouter.post(
  '/media/bulk-delete',
  ...guard,
  requirePermission('media.asset.delete'),
  validate({ body: mediaBulkDeleteSchema }),
  asyncHandler(adminMediaController.bulkDelete),
);

adminMediaRouter.get(
  '/media/:id',
  authenticate('ADMIN'),
  requirePermission('media.asset.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminMediaController.get),
);

adminMediaRouter.patch(
  '/media/:id',
  ...guard,
  requirePermission('media.asset.update'),
  validate({ params: idParamSchema, body: mediaUpdateSchema }),
  asyncHandler(adminMediaController.update),
);

adminMediaRouter.post(
  '/media/:id/replace',
  ...guard,
  requirePermission('media.asset.update'),
  authRateLimit('media-replace'),
  uploadMiddleware.array('files'),
  validate({ params: idParamSchema }),
  asyncHandler(adminMediaController.replace),
);

adminMediaRouter.post(
  '/media/:id/reprocess',
  ...guard,
  requirePermission('media.asset.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminMediaController.reprocess),
);

adminMediaRouter.post(
  '/media/:id/restore',
  ...guard,
  requirePermission('media.asset.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminMediaController.restore),
);

adminMediaRouter.delete(
  '/media/:id/permanent',
  ...guard,
  requirePermission('media.asset.delete'),
  validate({ params: idParamSchema, query: mediaHardDeleteQuerySchema }),
  asyncHandler(adminMediaController.hardDelete),
);

adminMediaRouter.delete(
  '/media/:id',
  ...guard,
  requirePermission('media.asset.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminMediaController.softDelete),
);

/* --------------------------------------------------------------- folders */

adminMediaRouter.get(
  '/media-folders',
  authenticate('ADMIN'),
  requirePermission('media.asset.read'),
  asyncHandler(adminMediaController.listFolders),
);

adminMediaRouter.post(
  '/media-folders',
  ...guard,
  requirePermission('media.asset.update'),
  validate({ body: mediaFolderCreateSchema }),
  asyncHandler(adminMediaController.createFolder),
);

adminMediaRouter.patch(
  '/media-folders/:id',
  ...guard,
  requirePermission('media.asset.update'),
  validate({ params: idParamSchema, body: mediaFolderUpdateSchema }),
  asyncHandler(adminMediaController.updateFolder),
);

adminMediaRouter.delete(
  '/media-folders/:id',
  ...guard,
  requirePermission('media.asset.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminMediaController.deleteFolder),
);

/* -------------------------------------------------------- product media */

adminMediaRouter.get(
  '/products/:productId/media',
  authenticate('ADMIN'),
  requirePermission('catalog.product.update'),
  validate({ params: productMediaParamsSchema }),
  asyncHandler(productMediaController.list),
);

adminMediaRouter.post(
  '/products/:productId/media',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ params: productMediaParamsSchema, body: productMediaAttachSchema }),
  asyncHandler(productMediaController.attach),
);

adminMediaRouter.patch(
  '/products/:productId/media/reorder',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ params: productMediaParamsSchema, body: productMediaReorderSchema }),
  asyncHandler(productMediaController.reorder),
);

adminMediaRouter.patch(
  '/products/:productId/media/:id',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ params: productMediaItemParamsSchema, body: productMediaUpdateSchema }),
  asyncHandler(productMediaController.update),
);

adminMediaRouter.delete(
  '/products/:productId/media/:id',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ params: productMediaItemParamsSchema }),
  asyncHandler(productMediaController.detach),
);

/* ---------------------------------------------------------------- public */

export const publicMediaRouter: Router = Router();

publicMediaRouter.get(
  '/catalog/products/:slug/gallery',
  validate({ params: slugParamSchema, query: galleryQuerySchema }),
  asyncHandler(publicMediaController.gallery),
);
