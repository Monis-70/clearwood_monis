import { z } from 'zod';

import { PRODUCT_RELATION_TYPES, PRODUCT_SORTS, SEARCH_ENTITY_TYPES } from '../enums';

import { collectionRulesSchema } from './catalogAdmin';
import {
  booleanQuerySchema,
  idSchema,
  listQuerySchema,
  paginationQuerySchema,
  slugSchema,
} from './common';

/**
 * Prompt 7 request contracts. R2 — nothing reaches a service without passing through here first,
 * which is also what makes `q` inert: it is a validated string handed to a parameterised query.
 */

/* --------------------------------------------------------------- listing */

/** Query strings repeat a key or comma-separate it; both must produce the same array. */
const csvIds = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return [] as string[];
    const parts = Array.isArray(value) ? value : value.split(',');
    return parts.map((part) => part.trim()).filter(Boolean);
  })
  .pipe(z.array(idSchema).max(60));

const csvSlugs = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return [] as string[];
    const parts = Array.isArray(value) ? value : value.split(',');
    return parts.map((part) => part.trim().toLowerCase()).filter(Boolean);
  })
  .pipe(z.array(slugSchema).max(40));

export const searchTermSchema = z.string().trim().min(1).max(120);

export const storefrontListQuerySchema = paginationQuerySchema.extend({
  q: searchTermSchema.optional(),
  categorySlug: slugSchema.optional(),
  collectionSlug: slugSchema.optional(),
  brandIds: csvIds,
  brandSlugs: csvSlugs,
  attributeValueIds: csvIds,
  priceMin: z.coerce.number().int().min(0).optional(),
  priceMax: z.coerce.number().int().min(0).optional(),
  inStockOnly: booleanQuerySchema.optional(),
  madeToOrder: booleanQuerySchema.optional(),
  customizable: booleanQuerySchema.optional(),
  isNewArrival: booleanQuerySchema.optional(),
  isFeatured: booleanQuerySchema.optional(),
  onSale: booleanQuerySchema.optional(),
  ratingMin: z.coerce.number().int().min(0).max(5).optional(),
  leadTimeMax: z.coerce.number().int().min(0).max(365).optional(),
  sort: z.enum(PRODUCT_SORTS).optional(),
  /** Opaque; produced by a previous page. Mutually exclusive with `page`. */
  cursor: z.string().max(200).optional(),
  includeFacets: booleanQuerySchema.default(true),
  pincode: z
    .string()
    .regex(/^[1-9][0-9]{5}$/)
    .optional(),
});
export type StorefrontListQuery = z.infer<typeof storefrontListQuerySchema>;

export const facetQuerySchema = storefrontListQuerySchema.omit({
  page: true,
  limit: true,
  cursor: true,
  includeFacets: true,
});
export type FacetQuery = z.infer<typeof facetQuerySchema>;

/* -------------------------------------------------------------------- PDP */

export const pdpQuerySchema = z.object({
  variantId: idSchema.optional(),
  optionValueIds: z
    .string()
    .max(600)
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        : [],
    ),
  qty: z.coerce.number().int().min(1).max(999).default(1),
  pincode: z
    .string()
    .regex(/^[1-9][0-9]{5}$/)
    .optional(),
  couponCode: z.string().min(2).max(40).optional(),
});
export type PdpQuery = z.infer<typeof pdpQuerySchema>;

export const optionsQuerySchema = z.object({
  variantId: idSchema.optional(),
  optionValueIds: z
    .string()
    .max(600)
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        : [],
    ),
});
export type OptionsQuery = z.infer<typeof optionsQuerySchema>;

export const relatedQuerySchema = z.object({
  type: z.enum(PRODUCT_RELATION_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(24).default(8),
});
export type RelatedQueryInput = z.infer<typeof relatedQuerySchema>;

export const productBatchSchema = z
  .object({
    slugs: z.array(slugSchema).max(50).optional(),
    ids: z.array(idSchema).max(50).optional(),
    pincode: z
      .string()
      .regex(/^[1-9][0-9]{5}$/)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.slugs?.length && !value.ids?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['slugs'],
        message: 'Provide slugs or ids',
      });
    }
  });
export type ProductBatchInput = z.infer<typeof productBatchSchema>;

export const viewBeaconSchema = z.object({
  sessionId: z.string().min(6).max(64).optional(),
  variantId: idSchema.optional(),
});
export type ViewBeaconInput = z.infer<typeof viewBeaconSchema>;

/* ----------------------------------------------------------------- search */

export const searchQuerySchema = storefrontListQuerySchema.extend({
  q: searchTermSchema,
  sessionId: z.string().min(6).max(64).optional(),
  types: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (value === undefined) return [...SEARCH_ENTITY_TYPES];
      const parts = Array.isArray(value) ? value : value.split(',');
      return parts.map((part) => part.trim().toUpperCase()).filter(Boolean);
    })
    .pipe(z.array(z.enum(SEARCH_ENTITY_TYPES)).min(1)),
});
export type SearchQueryInput = z.infer<typeof searchQuerySchema>;

export const suggestQuerySchema = z.object({
  q: z.string().trim().min(1).max(60),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});
export type SuggestQueryInput = z.infer<typeof suggestQuerySchema>;

export const searchClickSchema = z
  .object({
    queryLogId: idSchema.optional(),
    query: searchTermSchema.optional(),
    entityType: z.enum(SEARCH_ENTITY_TYPES),
    entityId: idSchema,
    position: z.number().int().min(0).max(1_000),
  })
  .superRefine((value, ctx) => {
    if (!value.queryLogId && !value.query) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['queryLogId'],
        message: 'Provide queryLogId or query',
      });
    }
  });
export type SearchClickInput = z.infer<typeof searchClickSchema>;

export const resolvePathSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(300)
    .regex(/^\/?[A-Za-z0-9/_-]*$/, 'path may only contain slugs and slashes'),
});
export type ResolvePathInput = z.infer<typeof resolvePathSchema>;

export const collectionListQuerySchema = listQuerySchema.extend({
  includeEmpty: booleanQuerySchema.default(false),
});
export type CollectionListQuery = z.infer<typeof collectionListQuerySchema>;

/* ------------------------------------------------------- collection rules */

/** Prompt 5 already owns the DSL; Prompt 7 only adds the dry-run wrapper around it. */
export const collectionRulePreviewSchema = z.object({
  rules: collectionRulesSchema,
  sampleSize: z.number().int().min(1).max(50).default(10),
});
export type CollectionRulePreviewInput = z.infer<typeof collectionRulePreviewSchema>;

/* ------------------------------------------------------------- admin search */

export const synonymCreateSchema = z.object({
  term: z.string().trim().min(2).max(60),
  synonyms: z.array(z.string().trim().min(2).max(60)).min(1).max(25),
  isTwoWay: z.boolean().default(true),
  isActive: z.boolean().default(true),
  note: z.string().max(300).nullish(),
});
export type SynonymCreateInput = z.infer<typeof synonymCreateSchema>;

export const synonymUpdateSchema = synonymCreateSchema.partial().omit({ term: true });
export type SynonymUpdateInput = z.infer<typeof synonymUpdateSchema>;

export const synonymTermParamSchema = z.object({
  term: z.string().trim().min(2).max(60),
});

export const reindexQuerySchema = z.object({
  entityType: z.enum(SEARCH_ENTITY_TYPES).optional(),
  full: booleanQuerySchema.default(false),
});
export type ReindexQuery = z.infer<typeof reindexQuerySchema>;

export const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
