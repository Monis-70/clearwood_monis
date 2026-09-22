import { z } from 'zod';

import { BLOCK_TYPES, type BlockCategory, type BlockType } from '../enums';

/**
 * THE BLOCK CONTRACT (Prompt 10A).
 *
 * A page is an ordered list of typed blocks. This file is the single definition of what each type
 * is: its Zod config schema, a default the admin builder can drop in, and — declaratively — where
 * inside its config the media ids and entity references live.
 *
 * Those last two matter more than they look. Because every block declares its own `mediaFields`
 * and `referenceFields` as config PATHS, the backend can sync MediaUsage and validate references
 * for ALL twenty-two types with one generic walk. There is no per-type special-casing anywhere in
 * the services, which is what makes "adding a block type is: registry entry + Zod schema + React
 * component, nothing else" actually true rather than aspirational.
 *
 * Adding a `BlockType` to the enum without an entry here fails a test that iterates the enum.
 */

/* ------------------------------------------------------------ path helpers */

/**
 * A config path. Three forms, deliberately no more:
 *   'mediaId'              a top-level field
 *   'left.mediaId'         a nested field
 *   'slides[].mediaId'     that field on every element of an array
 *
 * There is no wildcard, no filter and no expression syntax: these paths are walked over
 * admin-supplied data, and anything richer would be an evaluator.
 */
export type ConfigPath = string;

/** Every non-empty string value found at `path` inside `config`. Order is stable. */
export function valuesAtPath(config: unknown, path: ConfigPath): string[] {
  const segments = path.split('.');
  let cursor: unknown[] = [config];

  for (const segment of segments) {
    const isArray = segment.endsWith('[]');
    const key = isArray ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];

    for (const node of cursor) {
      if (node === null || typeof node !== 'object') continue;

      const value = (node as Record<string, unknown>)[key];
      if (value === undefined || value === null) continue;

      if (isArray) {
        if (Array.isArray(value)) next.push(...value);
      } else if (Array.isArray(value)) {
        next.push(...value);
      } else {
        next.push(value);
      }
    }

    cursor = next;
  }

  return cursor.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/* -------------------------------------------------------- shared fragments */

const mediaId = z.string().min(1).max(40);
const entityId = z.string().min(1).max(40);

/**
 * Relative, or absolute https. Never `javascript:`, `data:` or any other scheme.
 *
 * `//evil.example.com` starts with a slash but the browser resolves it as absolute, so the second
 * slash is refused explicitly rather than trusted to the first check.
 */
export const safeUrl = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      (value.startsWith('/') && !value.startsWith('//')) || /^https:\/\/[^\s/]+/i.test(value),
    'must be a relative path or an https:// URL',
  );

const heading = z.string().trim().max(200);
const blurb = z.string().trim().max(600);

/* --------------------------------------------------------------- registry */

export interface BlockReferenceFields {
  categoryIds?: ConfigPath[];
  collectionIds?: ConfigPath[];
  productIds?: ConfigPath[];
  faqIds?: ConfigPath[];
}

export interface BlockDefinition {
  type: BlockType;
  label: string;
  description: string;
  category: BlockCategory;
  /** Refused beyond this many on one page. Absent means unlimited. */
  maxPerPage?: number;
  /**
   * What may be SAVED. Deliberately tolerant: an admin drags a hero slider in and it has no
   * slides yet, and refusing to store that would make the builder unusable.
   */
  configSchema: z.ZodTypeAny;
  /**
   * What may be SHOWN TO CUSTOMERS. Stricter, and checked by the publish gate. Absent means the
   * draft schema is already strict enough.
   */
  publishSchema?: z.ZodTypeAny;
  /** Must validate against `configSchema` — a test asserts it for every type. */
  defaultConfig: unknown;
  /** Config paths holding media ids, so MediaUsage syncs without knowing the block type. */
  mediaFields: ConfigPath[];
  referenceFields: BlockReferenceFields;
}

const definitions: BlockDefinition[] = [
  {
    type: 'HERO_SLIDER',
    label: 'Hero slider',
    description: 'Full-width rotating slides at the top of a page.',
    category: 'HERO',
    maxPerPage: 1,
    configSchema: z.object({
      slides: z
        .array(
          z.object({
            mediaId,
            mobileMediaId: mediaId.optional(),
            altText: z.string().trim().max(200).optional(),
            headline: heading,
            subheadline: blurb.optional(),
            ctaLabel: z.string().trim().max(60).optional(),
            ctaUrl: safeUrl.optional(),
            textHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
          }),
        )
        .max(8)
        .default([]),
      autoplayMs: z.number().int().min(0).max(30_000).default(6_000),
      showDots: z.boolean().default(true),
    }),
    publishSchema: z.object({
      slides: z.array(z.object({ mediaId, headline: heading.min(1) })).min(1).max(8),
      autoplayMs: z.number().int().min(0).max(30_000),
      showDots: z.boolean(),
    }),
    defaultConfig: { slides: [], autoplayMs: 6_000, showDots: true },
    mediaFields: ['slides[].mediaId', 'slides[].mobileMediaId'],
    referenceFields: {},
  },
  {
    type: 'CATEGORY_CIRCLES',
    label: 'Category circles',
    description: 'Round category shortcuts, the standard mobile entry point.',
    category: 'COMMERCE',
    configSchema: z.object({
      title: heading.optional(),
      categoryIds: z.array(entityId).max(20).default([]),
      showLabels: z.boolean().default(true),
    }),
    publishSchema: z.object({
      title: heading.optional(),
      categoryIds: z.array(entityId).min(1).max(20),
      showLabels: z.boolean(),
    }),
    defaultConfig: { categoryIds: [], showLabels: true },
    mediaFields: [],
    referenceFields: { categoryIds: ['categoryIds'] },
  },
  {
    type: 'FEATURED_COLLECTION',
    label: 'Featured collection',
    description: 'One collection with its banner and a row of products.',
    category: 'COMMERCE',
    configSchema: z.object({
      collectionId: z.string().max(40).default(''),
      title: heading.optional(),
      limit: z.number().int().min(2).max(24).default(8),
      showViewAll: z.boolean().default(true),
    }),
    publishSchema: z.object({
      collectionId: entityId,
      title: heading.optional(),
      limit: z.number().int().min(2).max(24),
      showViewAll: z.boolean(),
    }),
    defaultConfig: { collectionId: '', limit: 8, showViewAll: true },
    mediaFields: [],
    referenceFields: { collectionIds: ['collectionId'] },
  },
  {
    type: 'PRODUCT_GRID',
    label: 'Product grid',
    description: 'A grid of products, chosen explicitly or drawn from a collection.',
    category: 'COMMERCE',
    configSchema: z.object({
      title: heading.optional(),
      subtitle: blurb.optional(),
      productIds: z.array(entityId).max(48).default([]),
      collectionId: entityId.optional(),
      categoryId: entityId.optional(),
      limit: z.number().int().min(2).max(48).default(8),
      columns: z.number().int().min(2).max(6).default(4),
    }),
    publishSchema: z
      .object({
        productIds: z.array(entityId).max(48),
        collectionId: entityId.optional(),
        categoryId: entityId.optional(),
      })
      .passthrough()
      .refine(
        (config) =>
          config.productIds.length > 0 || Boolean(config.collectionId) || Boolean(config.categoryId),
        'choose products explicitly, or a collection, or a category',
      ),
    defaultConfig: { productIds: [], limit: 8, columns: 4 },
    mediaFields: [],
    referenceFields: {
      productIds: ['productIds'],
      collectionIds: ['collectionId'],
      categoryIds: ['categoryId'],
    },
  },
  {
    type: 'PRODUCT_CAROUSEL',
    label: 'Product carousel',
    description: 'A horizontally scrolling row of products.',
    category: 'COMMERCE',
    configSchema: z.object({
      title: heading.optional(),
      subtitle: blurb.optional(),
      productIds: z.array(entityId).max(48).default([]),
      collectionId: entityId.optional(),
      categoryId: entityId.optional(),
      limit: z.number().int().min(2).max(48).default(12),
      showViewAll: z.boolean().default(true),
    }),
    publishSchema: z
      .object({
        productIds: z.array(entityId).max(48),
        collectionId: entityId.optional(),
        categoryId: entityId.optional(),
      })
      .passthrough()
      .refine(
        (config) =>
          config.productIds.length > 0 || Boolean(config.collectionId) || Boolean(config.categoryId),
        'choose products explicitly, or a collection, or a category',
      ),
    defaultConfig: { productIds: [], limit: 12, showViewAll: true },
    mediaFields: [],
    referenceFields: {
      productIds: ['productIds'],
      collectionIds: ['collectionId'],
      categoryIds: ['categoryId'],
    },
  },
  {
    type: 'BANNER_SPLIT',
    label: 'Split banner',
    description: 'Two half-width promotional panels side by side.',
    category: 'CONTENT',
    configSchema: z.object({
      panels: z
        .array(
          z.object({
            mediaId,
            headline: heading,
            subheadline: blurb.optional(),
            ctaLabel: z.string().trim().max(60).optional(),
            ctaUrl: safeUrl.optional(),
          }),
        )
        .max(2)
        .default([]),
    }),
    publishSchema: z.object({
      panels: z.array(z.object({ mediaId, headline: heading.min(1) })).length(2),
    }),
    defaultConfig: { panels: [] },
    mediaFields: ['panels[].mediaId'],
    referenceFields: {},
  },
  {
    type: 'BANNER_FULL',
    label: 'Full-width banner',
    description: 'One edge-to-edge promotional image.',
    category: 'CONTENT',
    configSchema: z.object({
      mediaId: z.string().max(40).default(''),
      mobileMediaId: mediaId.optional(),
      altText: z.string().trim().max(200).optional(),
      headline: heading.optional(),
      subheadline: blurb.optional(),
      ctaLabel: z.string().trim().max(60).optional(),
      ctaUrl: safeUrl.optional(),
    }),
    publishSchema: z.object({ mediaId }).passthrough(),
    defaultConfig: { mediaId: '' },
    mediaFields: ['mediaId', 'mobileMediaId'],
    referenceFields: {},
  },
  {
    type: 'COUNTDOWN_DEAL',
    label: 'Countdown deal',
    description: 'A timed offer with a live countdown and its products.',
    category: 'COMMERCE',
    maxPerPage: 2,
    configSchema: z.object({
      collectionId: z.string().max(40).default(''),
      headline: heading,
      subheadline: blurb.optional(),
      endsAt: z.string().datetime(),
      limit: z.number().int().min(2).max(24).default(8),
    }),
    publishSchema: z
      .object({ collectionId: entityId, headline: heading.min(1), endsAt: z.string().datetime() })
      .passthrough(),
    defaultConfig: {
      collectionId: '',
      headline: 'Deals of the week',
      endsAt: '2030-01-01T00:00:00.000Z',
      limit: 8,
    },
    mediaFields: [],
    referenceFields: { collectionIds: ['collectionId'] },
  },
  {
    type: 'USP_STRIP',
    label: 'USP strip',
    description: 'A row of short selling points with icons.',
    category: 'CONTENT',
    configSchema: z.object({
      items: z
        .array(
          z.object({
            iconMediaId: mediaId.optional(),
            title: z.string().trim().min(1).max(80),
            subtitle: z.string().trim().max(160).optional(),
          }),
        )
        .max(8)
        .default([]),
    }),
    publishSchema: z.object({
      items: z.array(z.object({ title: z.string().trim().min(1).max(80) }).passthrough()).min(1),
    }),
    defaultConfig: { items: [] },
    mediaFields: ['items[].iconMediaId'],
    referenceFields: {},
  },
  {
    type: 'RICH_TEXT',
    label: 'Rich text',
    description: 'Formatted copy. Sanitised on save against the shared allowlist.',
    category: 'CONTENT',
    configSchema: z.object({
      html: z.string().max(40_000),
      align: z.enum(['LEFT', 'CENTER']).default('LEFT'),
      maxWidthPx: z.number().int().min(320).max(1600).optional(),
    }),
    defaultConfig: { html: '', align: 'LEFT' },
    mediaFields: [],
    referenceFields: {},
  },
  {
    type: 'IMAGE_WITH_TEXT',
    label: 'Image with text',
    description: 'A picture beside a paragraph — the usual brand-story block.',
    category: 'CONTENT',
    configSchema: z.object({
      mediaId: z.string().max(40).default(''),
      imagePosition: z.enum(['LEFT', 'RIGHT']).default('LEFT'),
      headline: heading,
      body: z.string().trim().max(2_000),
      ctaLabel: z.string().trim().max(60).optional(),
      ctaUrl: safeUrl.optional(),
    }),
    publishSchema: z.object({ mediaId, headline: heading.min(1) }).passthrough(),
    defaultConfig: { mediaId: '', imagePosition: 'LEFT', headline: '', body: '' },
    mediaFields: ['mediaId'],
    referenceFields: {},
  },
  {
    type: 'VIDEO_EMBED',
    label: 'Video',
    description: 'An embedded video from a whitelisted host.',
    category: 'CONTENT',
    configSchema: z.object({
      url: safeUrl,
      posterMediaId: mediaId.optional(),
      caption: blurb.optional(),
      autoplay: z.boolean().default(false),
    }),
    defaultConfig: { url: 'https://www.youtube.com/embed/placeholder', autoplay: false },
    mediaFields: ['posterMediaId'],
    referenceFields: {},
  },
  {
    type: 'TESTIMONIALS',
    label: 'Testimonials',
    description: 'Customer quotes, featured or hand-picked.',
    category: 'SOCIAL',
    configSchema: z.object({
      title: heading.optional(),
      testimonialIds: z.array(entityId).max(24).default([]),
      featuredOnly: z.boolean().default(true),
      limit: z.number().int().min(1).max(24).default(6),
    }),
    defaultConfig: { testimonialIds: [], featuredOnly: true, limit: 6 },
    mediaFields: [],
    referenceFields: {},
  },
  {
    type: 'FAQ_ACCORDION',
    label: 'FAQ accordion',
    description: 'Questions and answers, chosen explicitly or by visibility.',
    category: 'CONTENT',
    configSchema: z.object({
      title: heading.optional(),
      faqIds: z.array(entityId).max(30).default([]),
      visibility: z
        .enum(['GLOBAL', 'PRODUCT', 'CATEGORY', 'ORDER', 'SHIPPING', 'PAYMENT', 'WARRANTY', 'CARE'])
        .optional(),
      limit: z.number().int().min(1).max(30).default(6),
    }),
    defaultConfig: { faqIds: [], limit: 6 },
    mediaFields: [],
    referenceFields: { faqIds: ['faqIds'] },
  },
  {
    type: 'TRUST_BADGES',
    label: 'Trust badges',
    description: 'Guarantees and payment marks.',
    category: 'CONTENT',
    configSchema: z.object({
      items: z
        .array(
          z.object({
            mediaId: mediaId.optional(),
            label: z.string().trim().min(1).max(80),
            caption: z.string().trim().max(160).optional(),
          }),
        )
        .max(10)
        .default([]),
    }),
    publishSchema: z.object({
      items: z.array(z.object({ label: z.string().trim().min(1).max(80) }).passthrough()).min(1),
    }),
    defaultConfig: { items: [] },
    mediaFields: ['items[].mediaId'],
    referenceFields: {},
  },
  {
    type: 'STORE_LOCATOR',
    label: 'Store locator',
    description: 'Showroom addresses and opening hours.',
    category: 'CONTENT',
    configSchema: z.object({
      title: heading.optional(),
      storeIds: z.array(entityId).max(30).default([]),
      showMap: z.boolean().default(true),
    }),
    defaultConfig: { storeIds: [], showMap: true },
    mediaFields: [],
    referenceFields: {},
  },
  {
    type: 'NEWSLETTER_SIGNUP',
    label: 'Newsletter signup',
    description: 'Email capture strip.',
    category: 'SOCIAL',
    maxPerPage: 2,
    configSchema: z.object({
      headline: heading,
      subheadline: blurb.optional(),
      buttonLabel: z.string().trim().max(40).default('Subscribe'),
    }),
    defaultConfig: { headline: 'Join our list', buttonLabel: 'Subscribe' },
    mediaFields: [],
    referenceFields: {},
  },
  {
    type: 'LEAD_FORM_CTA',
    label: 'Lead form',
    description: 'A call to action that opens an enquiry form. Forms arrive in Prompt 10B.',
    category: 'SOCIAL',
    configSchema: z.object({
      leadFormKey: z.string().trim().max(60).default(''),
      headline: heading,
      subheadline: blurb.optional(),
      buttonLabel: z.string().trim().max(40).default('Enquire now'),
      mediaId: mediaId.optional(),
    }),
    publishSchema: z
      .object({ leadFormKey: z.string().trim().min(1).max(60), headline: heading.min(1) })
      .passthrough(),
    defaultConfig: { leadFormKey: '', headline: '', buttonLabel: 'Enquire now' },
    mediaFields: ['mediaId'],
    referenceFields: {},
  },
  {
    type: 'INSTAGRAM_GRID',
    label: 'Instagram grid',
    description: 'Curated social images. Uploaded, not fetched live.',
    category: 'SOCIAL',
    configSchema: z.object({
      handle: z.string().trim().max(60).optional(),
      title: heading.optional(),
      items: z
        .array(z.object({ mediaId, linkUrl: safeUrl.optional() }))
        .max(12)
        .default([]),
    }),
    publishSchema: z.object({ items: z.array(z.object({ mediaId }).passthrough()).min(1) }),
    defaultConfig: { items: [] },
    mediaFields: ['items[].mediaId'],
    referenceFields: {},
  },
  {
    type: 'BRAND_STRIP',
    label: 'Brand strip',
    description: 'A row of brand logos.',
    category: 'CONTENT',
    configSchema: z.object({
      title: heading.optional(),
      brandIds: z.array(entityId).max(30).default([]),
    }),
    defaultConfig: { brandIds: [] },
    mediaFields: [],
    referenceFields: {},
  },
  {
    type: 'SPACER',
    label: 'Spacer',
    description: 'Vertical breathing room.',
    category: 'LAYOUT',
    configSchema: z.object({
      heightPx: z.number().int().min(4).max(200).default(48),
      showDivider: z.boolean().default(false),
    }),
    defaultConfig: { heightPx: 48, showDivider: false },
    mediaFields: [],
    referenceFields: {},
  },
  {
    type: 'CUSTOM_HTML',
    label: 'Custom HTML',
    description:
      'Raw markup, sanitised on save. The original is kept separately so an admin can keep editing what they wrote.',
    category: 'LAYOUT',
    maxPerPage: 5,
    configSchema: z.object({
      html: z.string().max(40_000),
    }),
    defaultConfig: { html: '' },
    mediaFields: [],
    referenceFields: {},
  },
];

export const BLOCK_REGISTRY: Readonly<Record<BlockType, BlockDefinition>> = Object.freeze(
  Object.fromEntries(definitions.map((definition) => [definition.type, definition])),
) as Record<BlockType, BlockDefinition>;

export function blockDefinition(type: BlockType): BlockDefinition {
  return BLOCK_REGISTRY[type];
}

/** The schema a block must satisfy before customers can see it. */
export function publishSchemaFor(type: BlockType): z.ZodTypeAny {
  const definition = BLOCK_REGISTRY[type];
  return definition.publishSchema ?? definition.configSchema;
}

/** Every media id a block config references, wherever the definition says they live. */
export function mediaIdsIn(type: BlockType, config: unknown): string[] {
  const definition = BLOCK_REGISTRY[type];
  if (!definition) return [];

  return [
    ...new Set(definition.mediaFields.flatMap((path) => valuesAtPath(config, path))),
  ];
}

export type ReferenceKind = keyof BlockReferenceFields;

/** Every entity id a block config references, grouped by what it points at. */
export function referencesIn(
  type: BlockType,
  config: unknown,
): Record<ReferenceKind, string[]> {
  const definition = BLOCK_REGISTRY[type];
  const empty: Record<ReferenceKind, string[]> = {
    categoryIds: [],
    collectionIds: [],
    productIds: [],
    faqIds: [],
  };
  if (!definition) return empty;

  for (const kind of Object.keys(empty) as ReferenceKind[]) {
    const paths = definition.referenceFields[kind] ?? [];
    empty[kind] = [...new Set(paths.flatMap((path) => valuesAtPath(config, path)))];
  }

  return empty;
}

/** The registry as plain JSON for the admin builder. Zod schemas cannot cross the wire. */
export function blockRegistryManifest(): {
  type: BlockType;
  label: string;
  description: string;
  category: BlockCategory;
  maxPerPage: number | null;
  defaultConfig: unknown;
  mediaFields: ConfigPath[];
  referenceFields: BlockReferenceFields;
}[] {
  return BLOCK_TYPES.map((type) => {
    const definition = BLOCK_REGISTRY[type];
    return {
      type,
      label: definition.label,
      description: definition.description,
      category: definition.category,
      maxPerPage: definition.maxPerPage ?? null,
      defaultConfig: definition.defaultConfig,
      mediaFields: definition.mediaFields,
      referenceFields: definition.referenceFields,
    };
  });
}
