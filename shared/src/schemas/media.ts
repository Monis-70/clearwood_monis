import { z } from 'zod';

import { MEDIA_SOURCES, MEDIA_STATUSES, MEDIA_USAGE_TYPES } from '../enums';

import { deviceTargetSchema, mediaKindSchema, mediaRoleSchema } from './catalog';
import { booleanQuerySchema, idSchema, listQuerySchema, slugSchema } from './common';

/**
 * Single source of truth for media validation: the backend validates with these, OpenAPI is
 * generated from them, and the admin UI infers its types from them.
 * Kind/role/device enums are re-used from the catalog schemas rather than redefined.
 */

export const mediaStatusSchema = z.enum(MEDIA_STATUSES);
export const mediaSourceSchema = z.enum(MEDIA_SOURCES);
export const mediaUsageTypeSchema = z.enum(MEDIA_USAGE_TYPES);

/** 0–10000 basis points of width/height, so a focal point survives any resize. */
export const focalPointSchema = z.object({
  x: z.number().int().min(0).max(10_000),
  y: z.number().int().min(0).max(10_000),
});

export const mediaTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[\w][\w .-]*$/, 'tags may only contain letters, digits, spaces, dots and dashes');

export const mediaListQuerySchema = listQuerySchema.extend({
  kind: mediaKindSchema.optional(),
  status: mediaStatusSchema.optional(),
  folderId: idSchema.optional(),
  folderPath: z.string().trim().max(400).optional(),
  tag: mediaTagSchema.optional(),
  search: z.string().trim().max(160).optional(),
  unusedOnly: booleanQuerySchema.default(false),
  includeDeleted: booleanQuerySchema.default(false),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type MediaListQuery = z.infer<typeof mediaListQuerySchema>;

export const mediaUpdateSchema = z
  .object({
    altText: z.string().trim().max(300).nullish(),
    title: z.string().trim().max(200).nullish(),
    tags: z.array(mediaTagSchema).max(25).optional(),
    focalPoint: focalPointSchema.nullish(),
    folderId: idSchema.nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type MediaUpdateInput = z.infer<typeof mediaUpdateSchema>;

export const mediaUploadMetaSchema = z.object({
  folderId: idSchema.optional(),
  folderPath: z.string().trim().max(400).optional(),
  altText: z.string().trim().max(300).optional(),
  title: z.string().trim().max(200).optional(),
  tags: z
    .union([z.array(mediaTagSchema), z.string()])
    .optional()
    .transform((value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean)
        : value,
    ),
});
export type MediaUploadMeta = z.infer<typeof mediaUploadMetaSchema>;

export const mediaBulkDeleteSchema = z.object({
  ids: z.array(idSchema).min(1).max(100),
});
export type MediaBulkDeleteInput = z.infer<typeof mediaBulkDeleteSchema>;

export const mediaHardDeleteQuerySchema = z.object({
  force: booleanQuerySchema.default(false),
});

export const mediaPresignSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(3).max(120),
  sizeBytes: z.number().int().min(1),
  folderPath: z.string().trim().max(400).optional(),
});
export type MediaPresignInput = z.infer<typeof mediaPresignSchema>;

/* ------------------------------------------------------------- folders */

export const mediaFolderCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: slugSchema.optional(),
  parentId: idSchema.nullish(),
  position: z.number().int().min(0).max(999).optional(),
});
export type MediaFolderCreateInput = z.infer<typeof mediaFolderCreateSchema>;

export const mediaFolderUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    parentId: idSchema.nullish(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type MediaFolderUpdateInput = z.infer<typeof mediaFolderUpdateSchema>;

/* -------------------------------------------------------- product media */

export const productMediaAttachSchema = z.object({
  items: z
    .array(
      z.object({
        mediaId: idSchema,
        role: mediaRoleSchema.default('GALLERY'),
        position: z.number().int().min(0).max(999).optional(),
        altText: z.string().trim().max(300).optional(),
        deviceTarget: deviceTargetSchema.default('ALL'),
        attributeValueId: idSchema.nullish(),
        variantId: idSchema.nullish(),
      }),
    )
    .min(1)
    .max(50),
});
export type ProductMediaAttachInput = z.infer<typeof productMediaAttachSchema>;

export const productMediaUpdateSchema = z
  .object({
    role: mediaRoleSchema.optional(),
    altText: z.string().trim().max(300).nullish(),
    deviceTarget: deviceTargetSchema.optional(),
    attributeValueId: idSchema.nullish(),
    variantId: idSchema.nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type ProductMediaUpdateInput = z.infer<typeof productMediaUpdateSchema>;

export const productMediaReorderSchema = z.object({
  items: z.array(z.object({ id: idSchema, position: z.number().int().min(0).max(999) })).min(1),
});
export type ProductMediaReorderInput = z.infer<typeof productMediaReorderSchema>;

export const productMediaParamsSchema = z.object({ productId: idSchema });
export const productMediaItemParamsSchema = z.object({ productId: idSchema, id: idSchema });

/* --------------------------------------------------------------- gallery */

export const galleryQuerySchema = z.object({
  variantId: idSchema.optional(),
  attributeValueId: idSchema.optional(),
  device: deviceTargetSchema.optional(),
});
export type GalleryQuery = z.infer<typeof galleryQuerySchema>;

export const signedMediaParamsSchema = z.object({
  key: z.string().min(1).max(500),
});

export const signedMediaQuerySchema = z.object({
  expires: z.coerce.number().int().positive(),
  signature: z
    .string()
    .min(16)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
});
