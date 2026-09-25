import { z } from 'zod';

import { NAVIGATION_MENU_COLUMN_MAX } from '../constants';
import {
  BANNER_PLACEMENTS,
  BLOCK_TYPES,
  CONTENT_STATUSES,
  DEVICE_KINDS,
  DEVICE_VISIBILITIES,
  FAQ_VISIBILITIES,
  PAGE_STATUSES,
  PAGE_TYPES,
} from '../enums';
import { booleanQuerySchema, listQuerySchema } from './common';

/* ------------------------------------------------------------------ pages */

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(140)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase words separated by single hyphens');

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a #rrggbb colour');

/**
 * Relative, or absolute https. Never `javascript:`, `data:` or any other scheme.
 *
 * `//evil.example.com` is the one that catches people out: it starts with a slash, so a naive
 * "starts with /" check passes it, and the browser then resolves it to `https://evil.example.com`.
 * That is an open redirect in the main navigation, so a second slash is refused explicitly.
 */
export const contentUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      (value.startsWith('/') && !value.startsWith('//')) || /^https:\/\/[^\s/]+/i.test(value),
    'must be a relative path or an https:// URL',
  );

export const pageCreateSchema = z
  .object({
    slug,
    title: z.string().trim().min(1).max(200),
    type: z.enum(PAGE_TYPES).default('STANDARD'),
    template: z.string().trim().max(60).nullish(),
    excerpt: z.string().trim().max(500).nullish(),
    heroMediaId: z.string().trim().max(40).nullish(),
    ogMediaId: z.string().trim().max(40).nullish(),
    seoTitle: z.string().trim().max(200).nullish(),
    seoDescription: z.string().trim().max(400).nullish(),
    seoKeywords: z.string().trim().max(400).nullish(),
    canonicalUrl: contentUrlSchema.nullish(),
    noIndex: z.boolean().default(false),
  })
  .strict();
export type PageCreateInput = z.infer<typeof pageCreateSchema>;

export const pageUpdateSchema = pageCreateSchema
  .partial()
  .extend({ version: z.number().int().min(0) })
  .strict();
export type PageUpdateInput = z.infer<typeof pageUpdateSchema>;

export const pageListQuerySchema = listQuerySchema.extend({
  status: z.enum(PAGE_STATUSES).optional(),
  type: z.enum(PAGE_TYPES).optional(),
  q: z.string().trim().max(120).optional(),
});
export type PageListQuery = z.infer<typeof pageListQuerySchema>;

export const pageScheduleSchema = z
  .object({
    scheduledAt: z.coerce.date(),
    expiresAt: z.coerce.date().nullish(),
  })
  .strict()
  .refine(
    (input) => !input.expiresAt || input.expiresAt > input.scheduledAt,
    { message: 'expiresAt must be after scheduledAt', path: ['expiresAt'] },
  );
export type PageScheduleInput = z.infer<typeof pageScheduleSchema>;

export const pageDuplicateSchema = z.object({ slug, title: z.string().trim().min(1).max(200) }).strict();
export type PageDuplicateInput = z.infer<typeof pageDuplicateSchema>;

/* ----------------------------------------------------------------- blocks */

export const blockCreateSchema = z
  .object({
    type: z.enum(BLOCK_TYPES),
    position: z.number().int().min(0).max(199).optional(),
    isActive: z.boolean().default(true),
    deviceVisibility: z.enum(DEVICE_VISIBILITIES).default('ALL'),
    config: z.record(z.unknown()).default({}),
    startsAt: z.coerce.date().nullish(),
    endsAt: z.coerce.date().nullish(),
    anchorId: z
      .string()
      .trim()
      .max(60)
      .regex(/^[a-zA-Z0-9_-]*$/, 'letters, digits, hyphen and underscore only')
      .nullish(),
    cssClass: z
      .string()
      .trim()
      .max(120)
      .regex(/^[a-zA-Z0-9 _-]*$/, 'letters, digits, spaces, hyphen and underscore only')
      .nullish(),
  })
  .strict();
export type BlockCreateInput = z.infer<typeof blockCreateSchema>;

export const blockUpdateSchema = blockCreateSchema.partial().strict();
export type BlockUpdateInput = z.infer<typeof blockUpdateSchema>;

export const blockReorderSchema = z
  .object({
    order: z
      .array(z.object({ id: z.string().min(1).max(40), position: z.number().int().min(0).max(199) }))
      .min(1)
      .max(200),
  })
  .strict();
export type BlockReorderInput = z.infer<typeof blockReorderSchema>;

/* ---------------------------------------------------------------- banners */

export const bannerCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    placement: z.enum(BANNER_PLACEMENTS),
    mediaId: z.string().trim().max(40).nullish(),
    mobileMediaId: z.string().trim().max(40).nullish(),
    altText: z.string().trim().max(200).nullish(),
    headline: z.string().trim().max(200).nullish(),
    subheadline: z.string().trim().max(600).nullish(),
    ctaLabel: z.string().trim().max(60).nullish(),
    ctaUrl: contentUrlSchema.nullish(),
    ctaStyle: z.enum(['PRIMARY', 'SECONDARY', 'LINK']).nullish(),
    backgroundHex: hex.nullish(),
    textHex: hex.nullish(),
    position: z.number().int().min(0).max(999).default(0),
    isActive: z.boolean().default(true),
    deviceVisibility: z.enum(DEVICE_VISIBILITIES).default('ALL'),
    startsAt: z.coerce.date().nullish(),
    endsAt: z.coerce.date().nullish(),
    targetCategoryIds: z.array(z.string().max(40)).max(50).nullish(),
    targetCollectionIds: z.array(z.string().max(40)).max(50).nullish(),
  })
  .strict();
export type BannerCreateInput = z.infer<typeof bannerCreateSchema>;

export const bannerUpdateSchema = bannerCreateSchema
  .partial()
  .extend({ version: z.number().int().min(0) })
  .strict();
export type BannerUpdateInput = z.infer<typeof bannerUpdateSchema>;

export const bannerListQuerySchema = listQuerySchema.extend({
  placement: z.enum(BANNER_PLACEMENTS).optional(),
  isActive: booleanQuerySchema.optional(),
});
export type BannerListQuery = z.infer<typeof bannerListQuerySchema>;

export const bannerPublicQuerySchema = z
  .object({
    placement: z.enum(BANNER_PLACEMENTS),
    device: z.enum(DEVICE_KINDS).optional(),
    categoryId: z.string().max(40).optional(),
    collectionId: z.string().max(40).optional(),
  })
  .strict();
export type BannerPublicQuery = z.infer<typeof bannerPublicQuerySchema>;

export const cmsReorderSchema = z
  .object({
    order: z
      .array(z.object({ id: z.string().min(1).max(40), position: z.number().int().min(0).max(999) }))
      .min(1)
      .max(500),
  })
  .strict();
export type CmsReorderInput = z.infer<typeof cmsReorderSchema>;

/* -------------------------------------------------------- announcement bar */

export const announcementCreateSchema = z
  .object({
    message: z.string().trim().min(1).max(300),
    linkUrl: contentUrlSchema.nullish(),
    linkLabel: z.string().trim().max(60).nullish(),
    backgroundHex: hex.nullish(),
    textHex: hex.nullish(),
    isDismissible: z.boolean().default(true),
    startsAt: z.coerce.date().nullish(),
    endsAt: z.coerce.date().nullish(),
    isActive: z.boolean().default(true),
    position: z.number().int().min(0).max(999).default(0),
    deviceVisibility: z.enum(DEVICE_VISIBILITIES).default('ALL'),
  })
  .strict();
export type AnnouncementCreateInput = z.infer<typeof announcementCreateSchema>;

export const announcementUpdateSchema = announcementCreateSchema
  .partial()
  .extend({ version: z.number().int().min(0) })
  .strict();
export type AnnouncementUpdateInput = z.infer<typeof announcementUpdateSchema>;

/* -------------------------------------------------------------------- FAQ */

export const faqCategoryCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug,
    description: z.string().trim().max(600).nullish(),
    iconMediaId: z.string().trim().max(40).nullish(),
    position: z.number().int().min(0).max(999).default(0),
    isActive: z.boolean().default(true),
  })
  .strict();
export type FaqCategoryCreateInput = z.infer<typeof faqCategoryCreateSchema>;

export const faqCategoryUpdateSchema = faqCategoryCreateSchema
  .partial()
  .extend({ version: z.number().int().min(0) })
  .strict();
export type FaqCategoryUpdateInput = z.infer<typeof faqCategoryUpdateSchema>;

export const faqCreateSchema = z
  .object({
    faqCategoryId: z.string().max(40).nullish(),
    question: z.string().trim().min(1).max(300),
    answer: z.string().trim().min(1).max(8_000),
    visibility: z.enum(FAQ_VISIBILITIES).default('GLOBAL'),
    position: z.number().int().min(0).max(999).default(0),
    isActive: z.boolean().default(true),
    targetProductIds: z.array(z.string().max(40)).max(100).nullish(),
    targetCategoryIds: z.array(z.string().max(40)).max(100).nullish(),
  })
  .strict();
export type FaqCreateInput = z.infer<typeof faqCreateSchema>;

export const faqUpdateSchema = faqCreateSchema
  .partial()
  .extend({ version: z.number().int().min(0) })
  .strict();
export type FaqUpdateInput = z.infer<typeof faqUpdateSchema>;

export const faqPublicQuerySchema = z
  .object({
    visibility: z.enum(FAQ_VISIBILITIES).optional(),
    productSlug: z.string().trim().max(140).optional(),
    categorySlug: z.string().trim().max(140).optional(),
    q: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type FaqPublicQuery = z.infer<typeof faqPublicQuerySchema>;

export const helpfulVoteSchema = z.object({ helpful: z.boolean() }).strict();
export type HelpfulVoteInput = z.infer<typeof helpfulVoteSchema>;

/* ------------------------------------------------------------ help centre */

export const helpCategoryCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug,
    description: z.string().trim().max(600).nullish(),
    iconMediaId: z.string().trim().max(40).nullish(),
    parentId: z.string().max(40).nullish(),
    position: z.number().int().min(0).max(999).default(0),
    isActive: z.boolean().default(true),
  })
  .strict();
export type HelpCategoryCreateInput = z.infer<typeof helpCategoryCreateSchema>;

export const helpCategoryUpdateSchema = helpCategoryCreateSchema
  .partial()
  .extend({ version: z.number().int().min(0) })
  .strict();
export type HelpCategoryUpdateInput = z.infer<typeof helpCategoryUpdateSchema>;

export const helpArticleCreateSchema = z
  .object({
    helpCategoryId: z.string().min(1).max(40),
    slug,
    title: z.string().trim().min(1).max(200),
    excerpt: z.string().trim().max(500).nullish(),
    bodyMarkdown: z.string().min(1).max(60_000),
    status: z.enum(CONTENT_STATUSES).default('DRAFT'),
    position: z.number().int().min(0).max(999).default(0),
    relatedArticleIds: z.array(z.string().max(40)).max(20).nullish(),
    seoTitle: z.string().trim().max(200).nullish(),
    seoDescription: z.string().trim().max(400).nullish(),
  })
  .strict();
export type HelpArticleCreateInput = z.infer<typeof helpArticleCreateSchema>;

export const helpArticleUpdateSchema = helpArticleCreateSchema
  .partial()
  .extend({ version: z.number().int().min(0) })
  .strict();
export type HelpArticleUpdateInput = z.infer<typeof helpArticleUpdateSchema>;

/* --------------------------------------------------------- testimonials */

export const testimonialCreateSchema = z
  .object({
    authorName: z.string().trim().min(1).max(120),
    authorLocation: z.string().trim().max(120).nullish(),
    authorRole: z.string().trim().max(120).nullish(),
    avatarMediaId: z.string().trim().max(40).nullish(),
    quote: z.string().trim().min(1).max(2_000),
    /** Basis points, like every other rate: 50000 = 5 stars. */
    ratingBp: z.number().int().min(0).max(50_000).nullish(),
    productId: z.string().max(40).nullish(),
    mediaIds: z.array(z.string().max(40)).max(10).nullish(),
    isFeatured: z.boolean().default(false),
    position: z.number().int().min(0).max(999).default(0),
    isActive: z.boolean().default(true),
    capturedAt: z.coerce.date().nullish(),
  })
  .strict();
export type TestimonialCreateInput = z.infer<typeof testimonialCreateSchema>;

export const testimonialUpdateSchema = testimonialCreateSchema
  .partial()
  .extend({ version: z.number().int().min(0) })
  .strict();
export type TestimonialUpdateInput = z.infer<typeof testimonialUpdateSchema>;

/* -------------------------------------------------------------- stores */

const openingHoursSchema = z
  .array(
    z.object({
      day: z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']),
      opens: z.string().regex(/^\d{2}:\d{2}$/),
      closes: z.string().regex(/^\d{2}:\d{2}$/),
      closed: z.boolean().default(false),
    }),
  )
  .max(7);

export const storeCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    slug,
    addressLine1: z.string().trim().min(1).max(200),
    addressLine2: z.string().trim().max(200).nullish(),
    city: z.string().trim().min(1).max(80),
    state: z.string().trim().min(1).max(80),
    stateCode: z.string().trim().length(2),
    pincode: z.string().trim().regex(/^\d{6}$/, 'a six-digit Indian pincode'),
    phone: z.string().trim().max(30).nullish(),
    email: z.string().trim().max(160).nullish(),
    mapsUrl: contentUrlSchema.nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    openingHours: openingHoursSchema.nullish(),
    mediaIds: z.array(z.string().max(40)).max(12).nullish(),
    isActive: z.boolean().default(true),
    position: z.number().int().min(0).max(999).default(0),
    isFlagship: z.boolean().default(false),
  })
  .strict();
export type StoreCreateInput = z.infer<typeof storeCreateSchema>;

export const storeUpdateSchema = storeCreateSchema
  .partial()
  .extend({ version: z.number().int().min(0) })
  .strict();
export type StoreUpdateInput = z.infer<typeof storeUpdateSchema>;

/* ------------------------------------------------------- public rendering */

export const contentPageQuerySchema = z
  .object({ device: z.enum(DEVICE_KINDS).optional(), preview: z.coerce.boolean().optional() })
  .strict();
export type ContentPageQuery = z.infer<typeof contentPageQuerySchema>;

export const cmsSlugParamSchema = z.object({ slug });
export const categorySlugParamSchema = z.object({ categorySlug: slug });

/* -------------------------------------------------------------- navigation */

export const navigationItemCreateSchema = z
  .object({
    parentId: z.string().max(40).nullish(),
    label: z.string().trim().min(1).max(120),
    type: z.enum(['CATEGORY', 'COLLECTION', 'URL', 'LEAD_FORM', 'PAGE']),
    position: z.number().int().min(0).max(999).default(0),
    isActive: z.boolean().default(true),
    isHighlighted: z.boolean().default(false),
    badgeText: z.string().trim().max(40).nullish(),
    badgeColor: z.string().trim().max(20).nullish(),
    url: contentUrlSchema.nullish(),
    categoryId: z.string().max(40).nullish(),
    collectionId: z.string().max(40).nullish(),
    leadFormKey: z.string().trim().max(60).nullish(),
    pageSlug: slug.nullish(),
    iconMediaId: z.string().max(40).nullish(),
    menuColumn: z.number().int().min(0).max(NAVIGATION_MENU_COLUMN_MAX).nullish(),
    openInNewTab: z.boolean().default(false),
  })
  .strict();
export type NavigationItemCreateInput = z.infer<typeof navigationItemCreateSchema>;

export const navigationItemUpdateSchema = navigationItemCreateSchema.partial().strict();
export type NavigationItemUpdateInput = z.infer<typeof navigationItemUpdateSchema>;

/* ----------------------------------------------------------- site settings */

export const contentSettingsSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));
export type ContentSettingsInput = z.infer<typeof contentSettingsSchema>;
