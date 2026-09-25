import { z } from 'zod';

import {
  BULK_ACTION_TYPES,
  COLLECTION_RULE_FIELDS,
  COLLECTION_RULE_OPERATORS,
  DELETE_STRATEGIES,
  IMPORT_ENTITIES,
  IMPORT_STATUSES,
  INVENTORY_REASONS,
  PRODUCT_BADGE_CODES,
  PRODUCT_RELATION_TYPES,
  PUBLICATION_STATES,
  RULE_MATCH_MODES,
  SLUG_ENTITY_TYPES,
} from '../enums';

import {
  attributeDataTypeSchema,
  attributeInputSchema,
  categoryKindSchema,
  collectionTypeSchema,
  deviceTargetSchema,
  priceAdjustmentBasisSchema,
  priceAdjustmentScopeSchema,
  priceAdjustmentTypeSchema,
  productStatusSchema,
  productTypeSchema,
  visibilitySchema,
} from './catalog';
import {
  basisPointsSchema,
  booleanQuerySchema,
  idSchema,
  listQuerySchema,
  paiseSchema,
  slugSchema,
} from './common';

/**
 * Admin catalog contracts (Prompt 5). The API validates with these, OpenAPI is generated from
 * them and the admin UI infers its form types from them — never redefine a shape locally.
 */

/* ------------------------------------------------------------ enum schemas */

export const bulkActionTypeSchema = z.enum(BULK_ACTION_TYPES);
export const importEntitySchema = z.enum(IMPORT_ENTITIES);
export const importEntityParamSchema = z.object({ entity: importEntitySchema });
export const importStatusSchema = z.enum(IMPORT_STATUSES);
export const inventoryReasonSchema = z.enum(INVENTORY_REASONS);
export const productRelationTypeSchema = z.enum(PRODUCT_RELATION_TYPES);
export const slugEntityTypeSchema = z.enum(SLUG_ENTITY_TYPES);
export const deleteStrategySchema = z.enum(DELETE_STRATEGIES);

/** Reasons an admin may pick by hand; ORDER_* belongs to the order engine (Prompt 9). */
export const manualInventoryReasonSchema = z.enum([
  'MANUAL_ADJUSTMENT',
  'INITIAL_STOCK',
  'PURCHASE',
  'PRODUCTION',
  'RETURN',
  'DAMAGE',
  'CORRECTION',
  'CANCELLATION',
]);

/* --------------------------------------------------------- shared fragments */

/**
 * Optimistic locking: every PATCH echoes the version it was loaded with. A mismatch is a
 * 409 STALE_RESOURCE rather than a silent overwrite of someone else's edit.
 */
export const versionSchema = z.number().int().min(0);
export const withVersion = z.object({ version: versionSchema });

const seoFields = {
  seoTitle: z.string().max(180).nullish(),
  seoDescription: z.string().max(400).nullish(),
  seoKeywords: z.string().max(400).nullish(),
};

const nameField = z.string().min(2).max(160);
const noteField = z.string().max(500).nullish();
const hexColorField = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #RRGGBB colour');

/** Lowercase-dashed keys shared by navigation items and categories ("contract-work"). */
export const leadFormKeySchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase words joined by dashes');

export const reorderSchema = z.object({
  items: z
    .array(z.object({ id: idSchema, position: z.number().int().min(0).max(100_000) }))
    .min(1)
    .max(500),
});

export const idsSchema = z.object({ ids: z.array(idSchema).min(1).max(500) });

/** Categories only switch on and off in bulk; anything else is a per-category decision. */
export const categoryBulkSchema = idsSchema.extend({
  action: z.enum(['ACTIVATE', 'DEACTIVATE']),
});

/* ------------------------------------------------------------- categories */

export const categoryListQuerySchema = listQuerySchema.extend({
  q: z.string().min(1).max(120).optional(),
  parentId: idSchema.optional(),
  kind: categoryKindSchema.optional(),
  depth: z.coerce.number().int().min(0).max(10).optional(),
  isActive: booleanQuerySchema.optional(),
  includeDeleted: booleanQuerySchema.default(false),
});

export const categoryCreateSchema = z.object({
  name: nameField,
  slug: slugSchema.optional(),
  parentId: idSchema.nullish(),
  kind: categoryKindSchema.default('STANDARD'),
  position: z.number().int().min(0).max(100_000).optional(),
  isActive: z.boolean().default(true),
  showInMenu: z.boolean().default(true),
  menuColumn: z.number().int().min(1).max(12).nullish(),
  isFeatured: z.boolean().default(false),
  leadFormKey: leadFormKeySchema.nullish(),
  shortDescription: z.string().max(400).nullish(),
  description: z.string().max(20_000).nullish(),
  iconMediaId: idSchema.nullish(),
  bannerMediaId: idSchema.nullish(),
  mobileBannerMediaId: idSchema.nullish(),
  deleteStrategyNote: noteField,
  ...seoFields,
});

export const categoryUpdateSchema = categoryCreateSchema
  .partial()
  .extend({ version: versionSchema });

export const categoryMoveSchema = z.object({
  parentId: idSchema.nullable(),
  position: z.number().int().min(0).max(100_000).optional(),
  version: versionSchema,
});

export const categoryDeleteQuerySchema = z.object({
  strategy: deleteStrategySchema.default('BLOCK'),
});

/* ------------------------------------------------------------- attributes */

export const attributeGroupCreateSchema = z.object({
  name: nameField,
  code: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Use UPPER_SNAKE_CASE'),
  position: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
});

export const attributeGroupUpdateSchema = attributeGroupCreateSchema.partial();

export const attributeCreateSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Use UPPER_SNAKE_CASE'),
  name: nameField,
  groupId: idSchema.nullish(),
  inputType: attributeInputSchema,
  dataType: attributeDataTypeSchema.default('STRING'),
  unit: z.string().max(24).nullish(),
  isVariantDefining: z.boolean().default(false),
  isFilterable: z.boolean().default(true),
  isSearchable: z.boolean().default(false),
  isRequired: z.boolean().default(false),
  isComparable: z.boolean().default(false),
  showInSwatch: z.boolean().default(false),
  position: z.number().int().min(0).max(10_000).default(0),
  helpText: z.string().max(500).nullish(),
  isActive: z.boolean().default(true),
});

export const attributeUpdateSchema = attributeCreateSchema
  .partial()
  .extend({ version: versionSchema });

export const adminAttributeListQuerySchema = listQuerySchema.extend({
  q: z.string().min(1).max(120).optional(),
  groupId: idSchema.optional(),
  isVariantDefining: booleanQuerySchema.optional(),
  isFilterable: booleanQuerySchema.optional(),
  includeInactive: booleanQuerySchema.default(true),
});

export const attributeValueCreateSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Use UPPER_SNAKE_CASE'),
  label: z.string().min(1).max(160),
  description: z.string().max(1_000).nullish(),
  position: z.number().int().min(0).max(10_000).default(0),
  colorHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullish(),
  swatchMediaId: idSchema.nullish(),
  numericValue: z.number().int().nullish(),
  isActive: z.boolean().default(true),
});

export const attributeValueUpdateSchema = attributeValueCreateSchema
  .partial()
  .extend({ version: versionSchema });

export const categoryAttributeUpsertSchema = z.object({
  attributeId: idSchema,
  isRequired: z.boolean().optional(),
  isVariantDefining: z.boolean().optional(),
  isFilterable: z.boolean().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});

/* ------------------------------------------------------------------ brands */

export const brandCreateSchema = z.object({
  name: nameField,
  slug: slugSchema.optional(),
  logoMediaId: idSchema.nullish(),
  description: z.string().max(4_000).nullish(),
  isActive: z.boolean().default(true),
  position: z.number().int().min(0).max(10_000).default(0),
});

export const brandUpdateSchema = brandCreateSchema.partial().extend({ version: versionSchema });

export const brandListQuerySchema = listQuerySchema.extend({
  q: z.string().min(1).max(120).optional(),
  includeInactive: booleanQuerySchema.default(true),
});

/* -------------------------------------------------------------- tax classes */

export const taxClassCreateSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Use UPPER_SNAKE_CASE'),
  name: nameField,
  rateBp: basisPointsSchema.max(10_000),
  hsnCode: z.string().max(16).nullish(),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const taxClassUpdateSchema = taxClassCreateSchema.partial();

/* ---------------------------------------------------------------- products */

export const productListQuerySchema = listQuerySchema.extend({
  q: z.string().min(1).max(160).optional(),
  categoryId: idSchema.optional(),
  collectionId: idSchema.optional(),
  status: productStatusSchema.optional(),
  publication: z.enum(PUBLICATION_STATES).optional(),
  visibility: visibilitySchema.optional(),
  brandId: idSchema.optional(),
  taxClassId: idSchema.optional(),
  productType: productTypeSchema.optional(),
  priceMin: z.coerce.number().int().min(0).optional(),
  priceMax: z.coerce.number().int().min(0).optional(),
  stock: z.enum(['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'ANY']).optional(),
  isFeatured: booleanQuerySchema.optional(),
  isNewArrival: booleanQuerySchema.optional(),
  isSpecialCollection: booleanQuerySchema.optional(),
  customizable: booleanQuerySchema.optional(),
  madeToOrder: booleanQuerySchema.optional(),
  completenessMax: z.coerce.number().int().min(0).max(100).optional(),
  completenessMin: z.coerce.number().int().min(0).max(100).optional(),
  hasMedia: booleanQuerySchema.optional(),
  updatedSince: z.coerce.date().optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  includeDeleted: booleanQuerySchema.default(false),
});

export const productCreateSchema = z.object({
  sku: z.string().min(2).max(64),
  slug: slugSchema.optional(),
  name: nameField,
  subtitle: z.string().max(200).nullish(),
  shortDescription: z.string().max(600).nullish(),
  description: z.string().max(40_000).nullish(),
  productType: productTypeSchema.default('SIMPLE'),
  visibility: visibilitySchema.default('PUBLIC'),
  brandId: idSchema.nullish(),
  taxClassId: idSchema.nullish(),
  basePricePaise: paiseSchema.default(0),
  compareAtPricePaise: paiseSchema.nullish(),
  costPricePaise: paiseSchema.nullish(),
  isMadeToOrder: z.boolean().default(false),
  leadTimeDays: z.number().int().min(0).max(365).nullish(),
  allowCustomization: z.boolean().default(false),
  manufacturedInHouse: z.boolean().default(true),
  manufacturingNote: z.string().max(2_000).nullish(),
  warrantyMonths: z.number().int().min(0).max(600).nullish(),
  careInstructions: z.string().max(4_000).nullish(),
  assemblyRequired: z.boolean().default(false),
  weightGrams: z.number().int().min(0).nullish(),
  lengthMm: z.number().int().min(0).nullish(),
  widthMm: z.number().int().min(0).nullish(),
  heightMm: z.number().int().min(0).nullish(),
  seatHeightMm: z.number().int().min(0).nullish(),
  isFeatured: z.boolean().default(false),
  featuredUntil: z.coerce.date().nullish(),
  isNewArrival: z.boolean().default(false),
  isSpecialCollection: z.boolean().default(false),
  isBestSeller: z.boolean().default(false),
  badgeText: z.string().trim().min(1).max(40).nullish(),
  badgeColor: hexColorField.nullish(),
  minOrderQty: z.number().int().min(1).max(999).default(1),
  maxOrderQty: z.number().int().min(1).max(999).nullish(),
  position: z.number().int().min(0).max(100_000).default(0),
  searchKeywords: z.string().max(1_000).nullish(),
  categoryIds: z.array(idSchema).max(30).optional(),
  primaryCategoryId: idSchema.optional(),
  ...seoFields,
});

export const productUpdateSchema = productCreateSchema
  .omit({ categoryIds: true, primaryCategoryId: true })
  .partial()
  .extend({ version: versionSchema });

export const productCategoriesSchema = z.object({
  primaryCategoryId: idSchema,
  categoryIds: z.array(idSchema).max(30).default([]),
});

/** `publishAt` in the future schedules the product; absent or past publishes it now. */
export const productPublishSchema = z.object({
  publishAt: z.coerce.date().optional(),
});

/** The merchandising state a bulk action may set; at least one field. */
export const merchandisingSchema = z
  .object({
    isFeatured: z.boolean().optional(),
    featuredUntil: z.coerce.date().nullish(),
    isNewArrival: z.boolean().optional(),
    isBestSeller: z.boolean().optional(),
    isSpecialCollection: z.boolean().optional(),
    badgeText: z.string().trim().min(1).max(40).nullish(),
    badgeColor: hexColorField.nullish(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Set at least one merchandising field',
  });

/** A card badge an admin turns on: its words and colour. `null` turns the badge off. */
const badgeStyleSchema = z
  .object({ label: z.string().trim().min(1).max(40), color: hexColorField.nullable() })
  .nullable();

/**
 * The storefront's catalog settings (AppSetting group `catalog`). Every field optional; a field
 * left out is not changed. `badges` is merged per code, never replaced wholesale.
 */
export const catalogSettingsUpdateSchema = z
  .object({
    defaultPageSize: z.number().int().min(1).max(100).optional(),
    maxPageSize: z.number().int().min(1).max(200).optional(),
    showOutOfStock: z.boolean().optional(),
    newArrivalDays: z.number().int().min(0).max(365).optional(),
    badges: z
      .object(
        Object.fromEntries(
          PRODUCT_BADGE_CODES.filter((code) => code !== 'CUSTOM').map((code) => [
            code,
            badgeStyleSchema.optional(),
          ]),
        ) as Record<
          Exclude<(typeof PRODUCT_BADGE_CODES)[number], 'CUSTOM'>,
          z.ZodOptional<typeof badgeStyleSchema>
        >,
      )
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Change at least one setting',
  })
  .refine(
    (value) =>
      value.defaultPageSize === undefined ||
      value.maxPageSize === undefined ||
      value.defaultPageSize <= value.maxPageSize,
    { message: 'defaultPageSize cannot exceed maxPageSize', path: ['defaultPageSize'] },
  );

export const productAttributeValuesSchema = z.object({
  values: z
    .array(
      z.object({
        attributeId: idSchema,
        attributeValueId: idSchema.nullish(),
        valueText: z.string().max(500).nullish(),
        valueNumber: z.number().int().nullish(),
        valueBoolean: z.boolean().nullish(),
        position: z.number().int().min(0).max(10_000).default(0),
      }),
    )
    .max(100),
});

export const productRelationsSchema = z.object({
  relations: z
    .array(
      z.object({
        relatedProductId: idSchema,
        type: productRelationTypeSchema,
        position: z.number().int().min(0).max(10_000).default(0),
      }),
    )
    .max(100),
});

export const productDuplicateSchema = z.object({
  sku: z.string().min(2).max(64).optional(),
  name: nameField.optional(),
  slug: slugSchema.optional(),
  includeVariants: z.boolean().default(true),
  includeMedia: z.boolean().default(true),
  includeRelations: z.boolean().default(true),
  includePriceAdjustments: z.boolean().default(true),
});

/* ---------------------------------------------------------------- variants */

export const variantCreateSchema = z.object({
  sku: z.string().min(2).max(64).optional(),
  name: z.string().max(160).nullish(),
  pricePaise: paiseSchema.nullish(),
  compareAtPricePaise: paiseSchema.nullish(),
  costPricePaise: paiseSchema.nullish(),
  weightGrams: z.number().int().min(0).nullish(),
  barcode: z.string().max(64).nullish(),
  position: z.number().int().min(0).max(10_000).default(0),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  lowStockThreshold: z.number().int().min(0).max(100_000).default(0),
  allowBackorder: z.boolean().default(false),
  leadTimeDays: z.number().int().min(0).max(365).nullish(),
  lengthMm: z.number().int().min(0).nullish(),
  widthMm: z.number().int().min(0).nullish(),
  heightMm: z.number().int().min(0).nullish(),
  /** Exactly one value per variant-defining attribute. */
  attributeValues: z
    .array(z.object({ attributeId: idSchema, attributeValueId: idSchema }))
    .max(20)
    .default([]),
  /** Opening stock is written through the inventory ledger, never assigned directly. */
  openingStock: z.number().int().min(0).max(1_000_000).optional(),
});

export const variantUpdateSchema = variantCreateSchema
  .omit({ openingStock: true })
  .partial()
  .extend({ version: versionSchema });

export const variantListQuerySchema = listQuerySchema.extend({
  includeInactive: booleanQuerySchema.default(true),
});

/* ----------------------------------------------------------- variant matrix */

export const skuPatternSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9{}:_\-.]+$/, 'Only letters, digits, - _ . and {TOKEN} placeholders');

export const variantMatrixSchema = z.object({
  attributeIds: z.array(idSchema).min(1).max(5),
  selectedValueIdsByAttribute: z.record(z.array(idSchema).min(1).max(60)),
  skuPattern: skuPatternSchema.default('{PRODUCT_SKU}-{INDEX}'),
  pricingMode: z.enum(['INHERIT', 'FIXED']).default('INHERIT'),
  namePattern: z.string().max(160).optional(),
});

/* --------------------------------------------------------------- inventory */

export const inventoryAdjustSchema = z.object({
  delta: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  absolute: z.number().int().min(0).max(1_000_000).optional(),
  reason: manualInventoryReasonSchema.default('MANUAL_ADJUSTMENT'),
  note: z.string().max(500).nullish(),
  refType: z.string().max(64).nullish(),
  refId: idSchema.nullish(),
  /**
   * Lost-update protection. When supplied the write only lands if stock is still this value —
   * two concurrent adjustments can never silently overwrite each other.
   */
  expectedBalance: z.number().int().min(0).max(1_000_000).optional(),
});

export const inventoryBulkAdjustSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: idSchema.optional(),
        sku: z.string().min(2).max(64).optional(),
        delta: z.number().int().min(-1_000_000).max(1_000_000).optional(),
        absolute: z.number().int().min(0).max(1_000_000).optional(),
        note: z.string().max(500).nullish(),
      }),
    )
    .min(1)
    .max(1_000),
  reason: manualInventoryReasonSchema.default('MANUAL_ADJUSTMENT'),
});

export const inventoryHistoryQuerySchema = listQuerySchema.extend({
  reason: inventoryReasonSchema.optional(),
});

export const lowStockQuerySchema = listQuerySchema.extend({
  threshold: z.coerce.number().int().min(0).max(100_000).optional(),
  includeBackorder: booleanQuerySchema.default(false),
});

/* ------------------------------------------------------------- collections */

const collectionRuleSchema = z.object({
  field: z.enum(COLLECTION_RULE_FIELDS),
  operator: z.enum(COLLECTION_RULE_OPERATORS),
  value: z.union([
    z.string().max(200),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string().max(200), z.number()])).max(100),
  ]),
});

/** Stored and validated by Prompt 5; compiled to a Prisma `where` by Prompt 7. */
export const collectionRulesSchema = z.object({
  match: z.enum(RULE_MATCH_MODES).default('ALL'),
  groups: z
    .array(
      z.object({
        match: z.enum(RULE_MATCH_MODES).default('ALL'),
        rules: z.array(collectionRuleSchema).min(1).max(20),
      }),
    )
    .min(1)
    .max(10),
  limit: z.number().int().min(1).max(500).optional(),
});

const collectionFields = z.object({
  name: nameField,
  slug: slugSchema.optional(),
  type: collectionTypeSchema.default('MANUAL'),
  description: z.string().max(10_000).nullish(),
  rules: collectionRulesSchema.nullish(),
  imageMediaId: idSchema.nullish(),
  bannerMediaId: idSchema.nullish(),
  mobileBannerMediaId: idSchema.nullish(),
  isActive: z.boolean().default(true),
  position: z.number().int().min(0).max(10_000).default(0),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  seoTitle: z.string().max(180).nullish(),
  seoDescription: z.string().max(400).nullish(),
});

function windowInOrder(
  value: { startsAt?: Date | null | undefined; endsAt?: Date | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'endsAt must be after startsAt',
    });
  }
}

export const collectionCreateSchema = collectionFields.superRefine(windowInOrder);

export const collectionUpdateSchema = collectionFields
  .partial()
  .extend({ version: versionSchema })
  .superRefine(windowInOrder);

export const collectionProductsSchema = z.object({
  productIds: z.array(idSchema).max(1_000).default([]),
});

/** `includeDeleted`: the trash view, from which a collection is restored. */
export const adminCollectionListQuerySchema = listQuerySchema.extend({
  includeDeleted: booleanQuerySchema.default(false),
});

/* -------------------------------------------------------- price adjustments */

export const priceAdjustmentCreateSchema = z
  .object({
    name: nameField,
    scope: priceAdjustmentScopeSchema,
    adjustmentType: priceAdjustmentTypeSchema,
    basis: priceAdjustmentBasisSchema.default('BASE'),
    priority: z.number().int().min(0).max(10_000).default(100),
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
    note: noteField,
  })
  .superRefine((value, ctx) => {
    if (value.valuePaise == null && value.valueBp == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valuePaise'],
        message: 'Provide either valuePaise or valueBp',
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

export const priceAdjustmentUpdateSchema = z.object({
  name: nameField.optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
  valuePaise: z.number().int().nullish(),
  valueBp: z.number().int().nullish(),
  minQty: z.number().int().min(1).nullish(),
  maxQty: z.number().int().min(1).nullish(),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  note: noteField,
  version: versionSchema,
});

export const priceAdjustmentListQuerySchema = listQuerySchema.extend({
  scope: priceAdjustmentScopeSchema.optional(),
  productId: idSchema.optional(),
  categoryId: idSchema.optional(),
  variantId: idSchema.optional(),
  attributeValueId: idSchema.optional(),
  includeInactive: booleanQuerySchema.default(true),
});

/* ------------------------------------------------------------ bulk actions */

export const bulkActionSchema = z
  .object({
    action: bulkActionTypeSchema,
    ids: z.array(idSchema).min(1).max(500),
    categoryId: idSchema.optional(),
    collectionId: idSchema.optional(),
    taxClassId: idSchema.optional(),
    brandId: idSchema.optional(),
    merchandising: merchandisingSchema.optional(),
    delta: z.number().int().min(-100_000).max(100_000).optional(),
    reason: manualInventoryReasonSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const requires: Partial<Record<(typeof BULK_ACTION_TYPES)[number], keyof typeof value>> = {
      MOVE_CATEGORY: 'categoryId',
      ADD_CATEGORY: 'categoryId',
      REMOVE_CATEGORY: 'categoryId',
      ASSIGN_COLLECTION: 'collectionId',
      SET_TAX_CLASS: 'taxClassId',
      SET_BRAND: 'brandId',
      SET_MERCHANDISING: 'merchandising',
      ADJUST_STOCK: 'delta',
    };
    const required = requires[value.action];
    if (required && value[required] == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [required],
        message: `${value.action} requires ${required}`,
      });
    }
  });

/* --------------------------------------------------------- import / export */

export const exportQuerySchema = z.object({
  format: z.enum(['csv']).default('csv'),
  q: z.string().min(1).max(160).optional(),
  categoryId: idSchema.optional(),
  status: productStatusSchema.optional(),
  brandId: idSchema.optional(),
  includeDeleted: booleanQuerySchema.default(false),
  limit: z.coerce.number().int().min(1).max(1_000_000).optional(),
});

export const importUploadSchema = z.object({
  dryRun: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .default(true)
    .transform((value) => value === true || value === 'true'),
});

export const importJobListQuerySchema = listQuerySchema.extend({
  entity: importEntitySchema.optional(),
  status: importStatusSchema.optional(),
});

/* --------------------------------------------------------------- media link */

export const entityMediaSchema = z.object({
  mediaId: idSchema.nullable(),
  deviceTarget: deviceTargetSchema.default('ALL'),
});

/* -------------------------------------------------------------------- types */

export type CategoryListQuery = z.infer<typeof categoryListQuerySchema>;
export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>;
export type CategoryUpdateInput = z.infer<typeof categoryUpdateSchema>;
export type CategoryMoveInput = z.infer<typeof categoryMoveSchema>;
export type CategoryDeleteQuery = z.infer<typeof categoryDeleteQuerySchema>;
export type ReorderInput = z.infer<typeof reorderSchema>;
export type IdsInput = z.infer<typeof idsSchema>;
export type CategoryBulkInput = z.infer<typeof categoryBulkSchema>;

export type AttributeGroupCreateInput = z.infer<typeof attributeGroupCreateSchema>;
export type AttributeGroupUpdateInput = z.infer<typeof attributeGroupUpdateSchema>;
export type AttributeCreateInput = z.infer<typeof attributeCreateSchema>;
export type AttributeUpdateInput = z.infer<typeof attributeUpdateSchema>;
export type AdminAttributeListQuery = z.infer<typeof adminAttributeListQuerySchema>;
export type AttributeValueCreateInput = z.infer<typeof attributeValueCreateSchema>;
export type AttributeValueUpdateInput = z.infer<typeof attributeValueUpdateSchema>;
export type CategoryAttributeUpsertInput = z.infer<typeof categoryAttributeUpsertSchema>;

export type BrandCreateInput = z.infer<typeof brandCreateSchema>;
export type BrandUpdateInput = z.infer<typeof brandUpdateSchema>;
export type BrandListQuery = z.infer<typeof brandListQuerySchema>;
export type TaxClassCreateInput = z.infer<typeof taxClassCreateSchema>;
export type TaxClassUpdateInput = z.infer<typeof taxClassUpdateSchema>;

export type AdminProductListQuery = z.infer<typeof productListQuerySchema>;
export type ProductCreateInput = z.infer<typeof productCreateSchema>;
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;
export type ProductCategoriesInput = z.infer<typeof productCategoriesSchema>;
export type ProductPublishInput = z.infer<typeof productPublishSchema>;
export type MerchandisingInput = z.infer<typeof merchandisingSchema>;
export type AdminCollectionListQuery = z.infer<typeof adminCollectionListQuerySchema>;
export type CatalogSettingsUpdateInput = z.infer<typeof catalogSettingsUpdateSchema>;
export type ProductAttributeValuesInput = z.infer<typeof productAttributeValuesSchema>;
export type ProductRelationsInput = z.infer<typeof productRelationsSchema>;
export type ProductDuplicateInput = z.infer<typeof productDuplicateSchema>;

export type VariantCreateInput = z.infer<typeof variantCreateSchema>;
export type VariantUpdateInput = z.infer<typeof variantUpdateSchema>;
export type VariantListQuery = z.infer<typeof variantListQuerySchema>;
export type VariantMatrixInput = z.infer<typeof variantMatrixSchema>;

export type InventoryAdjustInput = z.infer<typeof inventoryAdjustSchema>;
export type InventoryBulkAdjustInput = z.infer<typeof inventoryBulkAdjustSchema>;
export type InventoryHistoryQuery = z.infer<typeof inventoryHistoryQuerySchema>;
export type LowStockQuery = z.infer<typeof lowStockQuerySchema>;

export type CollectionCreateInput = z.infer<typeof collectionCreateSchema>;
export type CollectionUpdateInput = z.infer<typeof collectionUpdateSchema>;
export type CollectionProductsInput = z.infer<typeof collectionProductsSchema>;
export type CollectionRules = z.infer<typeof collectionRulesSchema>;

export type PriceAdjustmentCreateInput = z.infer<typeof priceAdjustmentCreateSchema>;
export type PriceAdjustmentUpdateInput = z.infer<typeof priceAdjustmentUpdateSchema>;
export type AdminPriceAdjustmentListQuery = z.infer<typeof priceAdjustmentListQuerySchema>;

export type BulkActionInput = z.infer<typeof bulkActionSchema>;
export type ExportQuery = z.infer<typeof exportQuerySchema>;
export type ImportUploadInput = z.infer<typeof importUploadSchema>;
export type ImportJobListQuery = z.infer<typeof importJobListQuerySchema>;
