import { z } from 'zod';

import {
  ATTRIBUTE_DATA_TYPES,
  ATTRIBUTE_INPUTS,
  CATEGORY_KINDS,
  COLLECTION_TYPES,
  DEVICE_TARGETS,
  MEDIA_KINDS,
  MEDIA_ROLES,
  NAVIGATION_ITEM_TYPES,
  NAVIGATION_MENU_KEYS,
  PRICE_ADJUSTMENT_BASES,
  PRICE_ADJUSTMENT_SCOPES,
  PRICE_ADJUSTMENT_TYPES,
  PRODUCT_STATUSES,
  PRODUCT_TYPES,
  STOCK_STATUSES,
  VISIBILITIES,
} from '../enums';
import type { CategoryNode, NavigationNode } from '../types/catalog';

import {
  basisPointsSchema,
  booleanQuerySchema,
  idSchema,
  listQuerySchema,
  paiseSchema,
  slugSchema,
} from './common';

/**
 * Single source of truth for catalog validation: the backend validates with these, OpenAPI is
 * generated from them, and both frontends infer their types from them. Never redefine them.
 */

/* ------------------------------------------------------------ enum schemas */

export const categoryKindSchema = z.enum(CATEGORY_KINDS);
export const productTypeSchema = z.enum(PRODUCT_TYPES);
export const productStatusSchema = z.enum(PRODUCT_STATUSES);
export const visibilitySchema = z.enum(VISIBILITIES);
export const stockStatusSchema = z.enum(STOCK_STATUSES);
export const attributeInputSchema = z.enum(ATTRIBUTE_INPUTS);
export const attributeDataTypeSchema = z.enum(ATTRIBUTE_DATA_TYPES);
export const mediaKindSchema = z.enum(MEDIA_KINDS);
export const mediaRoleSchema = z.enum(MEDIA_ROLES);
export const deviceTargetSchema = z.enum(DEVICE_TARGETS);
export const collectionTypeSchema = z.enum(COLLECTION_TYPES);
export const priceAdjustmentScopeSchema = z.enum(PRICE_ADJUSTMENT_SCOPES);
export const priceAdjustmentTypeSchema = z.enum(PRICE_ADJUSTMENT_TYPES);
export const priceAdjustmentBasisSchema = z.enum(PRICE_ADJUSTMENT_BASES);
export const navigationItemTypeSchema = z.enum(NAVIGATION_ITEM_TYPES);
export const navigationMenuKeySchema = z.enum(NAVIGATION_MENU_KEYS);

/* ------------------------------------------------------------- media DTOs */

export const mediaDtoSchema = z.object({
  id: idSchema,
  kind: mediaKindSchema,
  url: z.string(),
  mimeType: z.string(),
  altText: z.string().nullable(),
  title: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  blurhash: z.string().nullable(),
});

export const productMediaDtoSchema = mediaDtoSchema.extend({
  role: mediaRoleSchema,
  position: z.number().int(),
  deviceTarget: deviceTargetSchema,
  attributeValueId: idSchema.nullable(),
  variantId: idSchema.nullable(),
});

/* --------------------------------------------------------- attribute DTOs */

export const attributeValueDtoSchema = z.object({
  id: idSchema,
  code: z.string(),
  label: z.string(),
  position: z.number().int(),
  colorHex: z.string().nullable(),
  swatchMediaId: idSchema.nullable(),
  numericValue: z.number().int().nullable(),
});

export const attributeDtoSchema = z.object({
  id: idSchema,
  code: z.string(),
  name: z.string(),
  groupCode: z.string().nullable(),
  groupName: z.string().nullable(),
  inputType: attributeInputSchema,
  dataType: attributeDataTypeSchema,
  unit: z.string().nullable(),
  isVariantDefining: z.boolean(),
  isFilterable: z.boolean(),
  isSearchable: z.boolean(),
  isRequired: z.boolean(),
  isComparable: z.boolean(),
  showInSwatch: z.boolean(),
  position: z.number().int(),
  helpText: z.string().nullable(),
  values: z.array(attributeValueDtoSchema),
});

export const resolvedCategoryAttributeDtoSchema = attributeDtoSchema.extend({
  inheritedFrom: z.string(),
  isRequiredForCategory: z.boolean(),
  isVariantDefiningForCategory: z.boolean(),
  isFilterableForCategory: z.boolean(),
});

/* ---------------------------------------------------------- category DTOs */

export const categoryBreadcrumbDtoSchema = z.object({
  id: idSchema,
  name: z.string(),
  slug: slugSchema,
  depth: z.number().int(),
});

const categoryNodeBaseSchema = z.object({
  id: idSchema,
  name: z.string(),
  slug: slugSchema,
  path: z.string(),
  depth: z.number().int(),
  position: z.number().int(),
  kind: categoryKindSchema,
  leadFormKey: z.string().nullable(),
  parentId: idSchema.nullable(),
  isActive: z.boolean(),
  showInMenu: z.boolean(),
  menuColumn: z.number().int().nullable(),
  isFeatured: z.boolean(),
  shortDescription: z.string().nullable(),
  iconMediaId: idSchema.nullable(),
  productCountCache: z.number().int(),
});

/** The node without its `children` — OpenAPI generation cannot follow a `z.lazy` reference. */
export { categoryNodeBaseSchema };

export const categoryNodeSchema: z.ZodType<CategoryNode> = categoryNodeBaseSchema.extend({
  children: z.lazy(() => z.array(categoryNodeSchema)),
});

export const categoryDetailSchema = categoryNodeBaseSchema.extend({
  description: z.string().nullable(),
  bannerMediaId: idSchema.nullable(),
  mobileBannerMediaId: idSchema.nullable(),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  seoKeywords: z.string().nullable(),
  breadcrumbs: z.array(categoryBreadcrumbDtoSchema),
  children: z.array(categoryNodeSchema),
  attributes: z.array(resolvedCategoryAttributeDtoSchema),
});

/* ----------------------------------------------------------- product DTOs */

export const variantAttributeDtoSchema = z.object({
  attributeId: idSchema,
  attributeCode: z.string(),
  attributeValueId: idSchema,
  valueCode: z.string(),
  valueLabel: z.string(),
});

export const variantDtoSchema = z.object({
  id: idSchema,
  sku: z.string(),
  name: z.string().nullable(),
  pricePaise: paiseSchema.nullable(),
  compareAtPricePaise: paiseSchema.nullable(),
  effectiveBasePricePaise: paiseSchema,
  position: z.number().int(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  stockQty: z.number().int(),
  stockStatus: stockStatusSchema,
  leadTimeDays: z.number().int().nullable(),
  attributes: z.array(variantAttributeDtoSchema),
});

export const productSummarySchema = z.object({
  id: idSchema,
  sku: z.string(),
  slug: slugSchema,
  name: z.string(),
  subtitle: z.string().nullable(),
  shortDescription: z.string().nullable(),
  productType: productTypeSchema,
  status: productStatusSchema,
  visibility: visibilitySchema,
  basePricePaise: paiseSchema,
  compareAtPricePaise: paiseSchema.nullable(),
  isMadeToOrder: z.boolean(),
  allowCustomization: z.boolean(),
  isFeatured: z.boolean(),
  isNewArrival: z.boolean(),
  isSpecialCollection: z.boolean(),
  isBestSeller: z.boolean(),
  ratingAvgBp: basisPointsSchema,
  ratingCount: z.number().int(),
  primaryMedia: mediaDtoSchema.nullable(),
});

export const productDetailSchema = productSummarySchema.extend({
  description: z.string().nullable(),
  brandId: idSchema.nullable(),
  taxClassId: idSchema.nullable(),
  leadTimeDays: z.number().int().nullable(),
  manufacturedInHouse: z.boolean(),
  manufacturingNote: z.string().nullable(),
  warrantyMonths: z.number().int().nullable(),
  careInstructions: z.string().nullable(),
  assemblyRequired: z.boolean(),
  weightGrams: z.number().int().nullable(),
  lengthMm: z.number().int().nullable(),
  widthMm: z.number().int().nullable(),
  heightMm: z.number().int().nullable(),
  seatHeightMm: z.number().int().nullable(),
  minOrderQty: z.number().int(),
  maxOrderQty: z.number().int().nullable(),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  seoKeywords: z.string().nullable(),
  categories: z.array(categoryBreadcrumbDtoSchema),
  specs: z.array(z.object({ attributeCode: z.string(), label: z.string(), value: z.string() })),
  variants: z.array(variantDtoSchema),
  media: z.array(productMediaDtoSchema),
});

/* -------------------------------------------------------- navigation DTOs */

const navigationNodeBaseSchema = z.object({
  id: idSchema,
  label: z.string(),
  type: navigationItemTypeSchema,
  position: z.number().int(),
  isHighlighted: z.boolean(),
  badgeText: z.string().nullable(),
  badgeColor: z.string().nullable(),
  url: z.string().nullable(),
  categorySlug: slugSchema.nullable(),
  collectionSlug: slugSchema.nullable(),
  leadFormKey: z.string().nullable(),
  iconMediaId: idSchema.nullable(),
  menuColumn: z.number().int().nullable(),
  openInNewTab: z.boolean(),
});

export { navigationNodeBaseSchema };

export const navigationNodeSchema: z.ZodType<NavigationNode> = navigationNodeBaseSchema.extend({
  children: z.lazy(() => z.array(navigationNodeSchema)),
});

export const navigationMenuDtoSchema = z.object({
  key: navigationMenuKeySchema,
  name: z.string(),
  items: z.array(navigationNodeSchema),
});

/* ------------------------------------------------------- request schemas */

export const MAX_CATEGORY_DEPTH = 4;

export const categoryTreeQuerySchema = z.object({
  depth: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_CATEGORY_DEPTH + 1)
    .optional(),
  includeInactive: booleanQuerySchema.default(false),
});
export type CategoryTreeQuery = z.infer<typeof categoryTreeQuerySchema>;

export const attributeListQuerySchema = listQuerySchema.extend({
  categorySlug: slugSchema.optional(),
  filterableOnly: booleanQuerySchema.default(false),
});
export type AttributeListQuery = z.infer<typeof attributeListQuerySchema>;

export const navigationParamsSchema = z.object({ key: navigationMenuKeySchema });
export type NavigationParams = z.infer<typeof navigationParamsSchema>;

/* -------------------------------------------- price adjustment validation */

/** Which FK a scope owns. GLOBAL and CUSTOMIZATION own none (Prompt 11 adds the latter's FK). */
export const PRICE_ADJUSTMENT_SCOPE_FK = {
  GLOBAL: null,
  CATEGORY: 'categoryId',
  PRODUCT: 'productId',
  VARIANT: 'variantId',
  ATTRIBUTE_VALUE: 'attributeValueId',
  CUSTOMIZATION: null,
} as const;

const SCOPE_FK_FIELDS = ['categoryId', 'productId', 'variantId', 'attributeValueId'] as const;

const priceAdjustmentBaseSchema = z.object({
  name: z.string().min(1).max(160),
  scope: priceAdjustmentScopeSchema,
  adjustmentType: priceAdjustmentTypeSchema,
  basis: priceAdjustmentBasisSchema.default('BASE'),
  priority: z.number().int().min(0).default(100),
  isActive: z.boolean().default(true),
  valuePaise: z.number().int().nullish(),
  valueBp: z.number().int().nullish(),
  categoryId: idSchema.nullish(),
  productId: idSchema.nullish(),
  variantId: idSchema.nullish(),
  attributeId: idSchema.nullish(),
  attributeValueId: idSchema.nullish(),
  minQty: z.number().int().min(1).nullish(),
  maxQty: z.number().int().min(1).nullish(),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  conditionsJson: z.string().nullish(),
  note: z.string().max(500).nullish(),
});

/**
 * The CHECK constraint SQLite cannot express: the value field must match the adjustment type, and
 * exactly the scope's own FK may be set. No resolution or maths here — that is Prompt 6.
 */
export const priceAdjustmentInputSchema = priceAdjustmentBaseSchema.superRefine((value, ctx) => {
  const needsPaise = value.adjustmentType === 'FIXED_AMOUNT' || value.adjustmentType === 'PER_UNIT';
  const needsBp = value.adjustmentType === 'PERCENT' || value.adjustmentType === 'MULTIPLIER';

  if (needsPaise && (value.valuePaise === null || value.valuePaise === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['valuePaise'],
      message: `${value.adjustmentType} requires valuePaise`,
    });
  }
  if (needsBp && (value.valueBp === null || value.valueBp === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['valueBp'],
      message: `${value.adjustmentType} requires valueBp`,
    });
  }

  const required = PRICE_ADJUSTMENT_SCOPE_FK[value.scope];

  for (const field of SCOPE_FK_FIELDS) {
    const provided = value[field];
    if (field === required) {
      if (provided === null || provided === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `scope ${value.scope} requires ${field}`,
        });
      }
    } else if (provided !== null && provided !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `scope ${value.scope} must not set ${field}`,
      });
    }
  }

  if (value.attributeId && value.scope !== 'ATTRIBUTE_VALUE') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['attributeId'],
      message: `scope ${value.scope} must not set attributeId`,
    });
  }

  if (value.minQty && value.maxQty && value.maxQty < value.minQty) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxQty'],
      message: 'maxQty must be greater than or equal to minQty',
    });
  }

  if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'endsAt must be after startsAt',
    });
  }
});
export type PriceAdjustmentInput = z.infer<typeof priceAdjustmentInputSchema>;
