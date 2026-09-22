import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import {
  adminAttributeListQuerySchema,
  attributeCreateSchema,
  attributeGroupCreateSchema,
  attributeGroupUpdateSchema,
  attributeUpdateSchema,
  attributeValueCreateSchema,
  attributeValueUpdateSchema,
  brandCreateSchema,
  brandListQuerySchema,
  brandUpdateSchema,
  bulkActionSchema,
  categoryAttributeUpsertSchema,
  categoryCreateSchema,
  categoryDeleteQuerySchema,
  categoryListQuerySchema,
  categoryMoveSchema,
  categoryUpdateSchema,
  collectionCreateSchema,
  collectionProductsSchema,
  collectionUpdateSchema,
  exportQuerySchema,
  importJobListQuerySchema,
  inventoryAdjustSchema,
  inventoryBulkAdjustSchema,
  inventoryHistoryQuerySchema,
  lowStockQuerySchema,
  priceAdjustmentCreateSchema,
  priceAdjustmentListQuerySchema,
  priceAdjustmentUpdateSchema,
  productAttributeValuesSchema,
  productCategoriesSchema,
  productCreateSchema,
  productDuplicateSchema,
  productListQuerySchema,
  productRelationsSchema,
  productUpdateSchema,
  reorderSchema,
  taxClassCreateSchema,
  taxClassUpdateSchema,
  variantCreateSchema,
  variantListQuerySchema,
  variantMatrixSchema,
  variantUpdateSchema,
} from '@shared/schemas/catalogAdmin';
import { idParamSchema, listQuerySchema } from '@shared/schemas/common';

import {
  adminAttributeController,
  adminBrandController,
  adminCategoryController,
  adminCollectionController,
  adminImportExportController,
  adminInventoryController,
  adminPriceAdjustmentController,
  adminProductController,
  adminTaxClassController,
  adminVariantController,
} from '../controllers/catalogAdmin.controller';
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
  authRateLimit,
  authenticate,
  idempotency,
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
const stale = { 409: jsonContent(errorBodySchema, 'Version conflict or in-use guard') };

const path = (suffix: string): string => `${ADMIN_PREFIX}${suffix}`;

export const adminCatalogRouter: Router = Router();

/* ----------------------------------------------------------- OpenAPI docs */

const adminCategorySchema = registry.register(
  'AdminCategory',
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    parentId: z.string().nullable(),
    path: z.string(),
    depth: z.number().int(),
    position: z.number().int(),
    kind: z.string(),
    isActive: z.boolean(),
    childCount: z.number().int(),
    productCountCache: z.number().int(),
    version: z.number().int(),
  }),
);

const bulkResultSchema = registry.register(
  'BulkActionResult',
  z.object({
    action: z.string(),
    requested: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    results: z.array(
      z.object({
        id: z.string(),
        ok: z.boolean(),
        code: z.string().nullable(),
        message: z.string().nullable(),
      }),
    ),
  }),
);

const matrixPreviewSchema = registry.register(
  'VariantMatrixPreview',
  z.object({
    productId: z.string(),
    total: z.number().int(),
    newCount: z.number().int(),
    existingCount: z.number().int(),
    orphanedVariantIds: z.array(z.string()),
    combinations: z.array(z.record(z.any())),
  }),
);

const importJobSchema = registry.register(
  'ImportJob',
  z.object({
    id: z.string(),
    entity: z.string(),
    status: z.string(),
    fileName: z.string(),
    dryRun: z.boolean(),
    totalRows: z.number().int(),
    successRows: z.number().int(),
    errorRows: z.number().int(),
    errors: z.array(
      z.object({
        row: z.number().int(),
        column: z.string().nullable(),
        message: z.string(),
      }),
    ),
  }),
);

registry.registerPath({
  method: 'get',
  path: path('/catalog/categories/tree'),
  tags: ['Admin catalog'],
  summary: 'The whole category tree, inactive rows included',
  responses: {
    200: jsonContent(successBodySchema(z.array(adminCategorySchema)), 'Category tree'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: path('/catalog/categories'),
  tags: ['Admin catalog'],
  summary: 'Create a category',
  request: { body: { content: { 'application/json': { schema: categoryCreateSchema } } } },
  responses: {
    201: jsonContent(successBodySchema(adminCategorySchema), 'Created'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'patch',
  path: path('/catalog/categories/{id}'),
  tags: ['Admin catalog'],
  summary: 'Update a category (optimistic locking via `version`)',
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: categoryUpdateSchema } } },
  },
  responses: {
    200: jsonContent(successBodySchema(adminCategorySchema), 'Updated'),
    ...unauthorised,
    ...forbidden,
    ...notFound,
    ...stale,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'delete',
  path: path('/catalog/categories/{id}'),
  tags: ['Admin catalog'],
  summary: 'Delete a category using a strategy (BLOCK, SOFT, REASSIGN_CHILDREN, CASCADE_SOFT)',
  request: { params: idParamSchema, query: categoryDeleteQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.object({ deleted: z.number().int() })), 'Deleted'),
    ...unauthorised,
    ...forbidden,
    ...notFound,
    ...stale,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: path('/catalog/products'),
  tags: ['Admin catalog'],
  summary: 'Search products with the full admin filter set',
  request: { query: productListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(z.record(z.any()))), 'Paginated products'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: path('/catalog/products/{id}/publish'),
  tags: ['Admin catalog'],
  summary: 'Publish a product; 422 lists every blocker',
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(z.record(z.any())), 'Published'),
    ...unauthorised,
    ...forbidden,
    ...notFound,
    ...commonErrorResponses,
    422: jsonContent(errorBodySchema, 'PRODUCT_NOT_PUBLISHABLE with an itemised blocker list'),
  },
});

registry.registerPath({
  method: 'post',
  path: path('/catalog/products/{id}/variants/matrix/preview'),
  tags: ['Admin catalog'],
  summary: 'Preview the variant matrix without writing anything',
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: variantMatrixSchema } } },
  },
  responses: {
    200: jsonContent(successBodySchema(matrixPreviewSchema), 'Preview'),
    ...unauthorised,
    ...forbidden,
    ...notFound,
    ...commonErrorResponses,
    422: jsonContent(
      errorBodySchema,
      'VARIANT_MATRIX_TOO_LARGE or a non variant-defining attribute',
    ),
  },
});

registry.registerPath({
  method: 'post',
  path: path('/catalog/variants/{id}/inventory/adjust'),
  tags: ['Admin catalog'],
  summary: 'Move stock through the ledger (idempotent with an Idempotency-Key header)',
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: inventoryAdjustSchema } } },
  },
  responses: {
    200: jsonContent(successBodySchema(z.record(z.any())), 'New snapshot plus the ledger entry'),
    409: jsonContent(
      errorBodySchema,
      'INVENTORY_CONFLICT, INSUFFICIENT_STOCK or STOCK_BELOW_RESERVED',
    ),
    ...unauthorised,
    ...forbidden,
    ...notFound,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: path('/catalog/bulk'),
  tags: ['Admin catalog'],
  summary: 'Apply one action to many ids, reporting per-id results',
  request: { body: { content: { 'application/json': { schema: bulkActionSchema } } } },
  responses: {
    200: jsonContent(successBodySchema(bulkResultSchema), 'Per-id results'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: path('/catalog/import/{entity}'),
  tags: ['Admin catalog'],
  summary:
    'Upload a CSV (dry run by default); inventory and price rules need their own permissions',
  responses: {
    201: jsonContent(successBodySchema(importJobSchema), 'Import job with the validation report'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: path('/catalog/export/{entity}'),
  tags: ['Admin catalog'],
  summary: 'Stream a CSV export (formula-injection safe)',
  request: { query: exportQuerySchema },
  responses: {
    200: { description: 'text/csv', content: { 'text/csv': { schema: { type: 'string' } } } },
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

/* ---------------------------------------------------------------- routes */

/* categories */
adminCatalogRouter.get(
  '/catalog/categories/tree',
  authenticate('ADMIN'),
  requirePermission('catalog.category.read'),
  asyncHandler(adminCategoryController.tree),
);

adminCatalogRouter.get(
  '/catalog/categories',
  authenticate('ADMIN'),
  requirePermission('catalog.category.read'),
  validate({ query: categoryListQuerySchema }),
  asyncHandler(adminCategoryController.list),
);

adminCatalogRouter.post(
  '/catalog/categories/reorder',
  ...guard,
  requirePermission('catalog.category.reorder'),
  validate({ body: reorderSchema }),
  asyncHandler(adminCategoryController.reorder),
);

adminCatalogRouter.post(
  '/catalog/categories/bulk',
  ...guard,
  requirePermission('catalog.category.update'),
  authRateLimit('catalog-bulk'),
  validate({ body: bulkActionSchema }),
  asyncHandler(adminCategoryController.bulk),
);

adminCatalogRouter.get(
  '/catalog/categories/:id',
  authenticate('ADMIN'),
  requirePermission('catalog.category.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminCategoryController.get),
);

adminCatalogRouter.get(
  '/catalog/categories/:id/delete-impact',
  authenticate('ADMIN'),
  requirePermission('catalog.category.delete'),
  validate({ params: idParamSchema, query: categoryDeleteQuerySchema }),
  asyncHandler(adminCategoryController.deleteImpact),
);

adminCatalogRouter.get(
  '/catalog/categories/:id/redirects',
  authenticate('ADMIN'),
  requirePermission('catalog.category.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminCategoryController.redirects),
);

adminCatalogRouter.post(
  '/catalog/categories',
  ...guard,
  requirePermission('catalog.category.create'),
  idempotency('category-create'),
  validate({ body: categoryCreateSchema }),
  asyncHandler(adminCategoryController.create),
);

adminCatalogRouter.patch(
  '/catalog/categories/:id',
  ...guard,
  requirePermission('catalog.category.update'),
  validate({ params: idParamSchema, body: categoryUpdateSchema }),
  asyncHandler(adminCategoryController.update),
);

adminCatalogRouter.post(
  '/catalog/categories/:id/move',
  ...guard,
  requirePermission('catalog.category.reorder'),
  validate({ params: idParamSchema, body: categoryMoveSchema }),
  asyncHandler(adminCategoryController.move),
);

adminCatalogRouter.delete(
  '/catalog/categories/:id',
  ...guard,
  requirePermission('catalog.category.delete'),
  authRateLimit('catalog-destructive'),
  validate({ params: idParamSchema, query: categoryDeleteQuerySchema }),
  asyncHandler(adminCategoryController.remove),
);

adminCatalogRouter.post(
  '/catalog/categories/:id/restore',
  ...guard,
  requirePermission('catalog.category.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminCategoryController.restore),
);

/* category ↔ attribute mapping */
adminCatalogRouter.get(
  '/catalog/categories/:id/attributes',
  authenticate('ADMIN'),
  requirePermission('catalog.attribute.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminAttributeController.listForCategory),
);

adminCatalogRouter.post(
  '/catalog/categories/:id/attributes',
  ...guard,
  requirePermission('catalog.attribute.update'),
  validate({ params: idParamSchema, body: categoryAttributeUpsertSchema }),
  asyncHandler(adminAttributeController.attachToCategory),
);

adminCatalogRouter.delete(
  '/catalog/categories/:id/attributes/:attributeId',
  ...guard,
  requirePermission('catalog.attribute.update'),
  validate({ params: idParamSchema.extend({ attributeId: idParamSchema.shape.id }) }),
  asyncHandler(adminAttributeController.detachFromCategory),
);

/* attribute groups */
adminCatalogRouter.get(
  '/catalog/attribute-groups',
  authenticate('ADMIN'),
  requirePermission('catalog.attribute.read'),
  asyncHandler(adminAttributeController.listGroups),
);

adminCatalogRouter.post(
  '/catalog/attribute-groups',
  ...guard,
  requirePermission('catalog.attribute.create'),
  validate({ body: attributeGroupCreateSchema }),
  asyncHandler(adminAttributeController.createGroup),
);

adminCatalogRouter.patch(
  '/catalog/attribute-groups/:id',
  ...guard,
  requirePermission('catalog.attribute.update'),
  validate({ params: idParamSchema, body: attributeGroupUpdateSchema }),
  asyncHandler(adminAttributeController.updateGroup),
);

adminCatalogRouter.delete(
  '/catalog/attribute-groups/:id',
  ...guard,
  requirePermission('catalog.attribute.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminAttributeController.removeGroup),
);

/* attributes */
adminCatalogRouter.get(
  '/catalog/attributes',
  authenticate('ADMIN'),
  requirePermission('catalog.attribute.read'),
  validate({ query: adminAttributeListQuerySchema }),
  asyncHandler(adminAttributeController.list),
);

adminCatalogRouter.post(
  '/catalog/attributes/reorder',
  ...guard,
  requirePermission('catalog.attribute.update'),
  validate({ body: reorderSchema }),
  asyncHandler(adminAttributeController.reorder),
);

adminCatalogRouter.post(
  '/catalog/attributes',
  ...guard,
  requirePermission('catalog.attribute.create'),
  validate({ body: attributeCreateSchema }),
  asyncHandler(adminAttributeController.create),
);

adminCatalogRouter.get(
  '/catalog/attributes/:id',
  authenticate('ADMIN'),
  requirePermission('catalog.attribute.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminAttributeController.get),
);

adminCatalogRouter.patch(
  '/catalog/attributes/:id',
  ...guard,
  requirePermission('catalog.attribute.update'),
  validate({ params: idParamSchema, body: attributeUpdateSchema }),
  asyncHandler(adminAttributeController.update),
);

adminCatalogRouter.delete(
  '/catalog/attributes/:id',
  ...guard,
  requirePermission('catalog.attribute.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminAttributeController.remove),
);

adminCatalogRouter.post(
  '/catalog/attributes/:id/values',
  ...guard,
  requirePermission('catalog.attribute.update'),
  validate({ params: idParamSchema, body: attributeValueCreateSchema }),
  asyncHandler(adminAttributeController.createValue),
);

adminCatalogRouter.patch(
  '/catalog/attribute-values/:valueId',
  ...guard,
  requirePermission('catalog.attribute.update'),
  validate({ body: attributeValueUpdateSchema }),
  asyncHandler(adminAttributeController.updateValue),
);

adminCatalogRouter.delete(
  '/catalog/attribute-values/:valueId',
  ...guard,
  requirePermission('catalog.attribute.delete'),
  asyncHandler(adminAttributeController.removeValue),
);

/* brands */
adminCatalogRouter.get(
  '/catalog/brands',
  authenticate('ADMIN'),
  requirePermission('catalog.product.read'),
  validate({ query: brandListQuerySchema }),
  asyncHandler(adminBrandController.list),
);

adminCatalogRouter.post(
  '/catalog/brands',
  ...guard,
  requirePermission('catalog.product.create'),
  validate({ body: brandCreateSchema }),
  asyncHandler(adminBrandController.create),
);

adminCatalogRouter.patch(
  '/catalog/brands/:id',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ params: idParamSchema, body: brandUpdateSchema }),
  asyncHandler(adminBrandController.update),
);

adminCatalogRouter.delete(
  '/catalog/brands/:id',
  ...guard,
  requirePermission('catalog.product.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminBrandController.remove),
);

/* tax classes — pricing.tax.*, deliberately not catalog.* */
adminCatalogRouter.get(
  '/catalog/tax-classes',
  authenticate('ADMIN'),
  requirePermission('pricing.tax.read'),
  validate({ query: listQuerySchema }),
  asyncHandler(adminTaxClassController.list),
);

adminCatalogRouter.post(
  '/catalog/tax-classes',
  ...guard,
  requirePermission('pricing.tax.update'),
  validate({ body: taxClassCreateSchema }),
  asyncHandler(adminTaxClassController.create),
);

adminCatalogRouter.patch(
  '/catalog/tax-classes/:id',
  ...guard,
  requirePermission('pricing.tax.update'),
  validate({ params: idParamSchema, body: taxClassUpdateSchema }),
  asyncHandler(adminTaxClassController.update),
);

adminCatalogRouter.delete(
  '/catalog/tax-classes/:id',
  ...guard,
  requirePermission('pricing.tax.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminTaxClassController.remove),
);

/* products */
adminCatalogRouter.get(
  '/catalog/products',
  authenticate('ADMIN'),
  requirePermission('catalog.product.read'),
  validate({ query: productListQuerySchema }),
  asyncHandler(adminProductController.list),
);

adminCatalogRouter.post(
  '/catalog/products',
  ...guard,
  requirePermission('catalog.product.create'),
  idempotency('product-create'),
  validate({ body: productCreateSchema }),
  asyncHandler(adminProductController.create),
);

adminCatalogRouter.post(
  '/catalog/bulk',
  ...guard,
  requirePermission('catalog.product.read'),
  authRateLimit('catalog-bulk'),
  idempotency('catalog-bulk'),
  validate({ body: bulkActionSchema }),
  asyncHandler(adminProductController.bulk),
);

adminCatalogRouter.get(
  '/catalog/products/:id',
  authenticate('ADMIN'),
  requirePermission('catalog.product.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminProductController.get),
);

adminCatalogRouter.patch(
  '/catalog/products/:id',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ params: idParamSchema, body: productUpdateSchema }),
  asyncHandler(adminProductController.update),
);

adminCatalogRouter.post(
  '/catalog/products/:id/duplicate',
  ...guard,
  requirePermission('catalog.product.create'),
  idempotency('product-duplicate'),
  validate({ params: idParamSchema, body: productDuplicateSchema }),
  asyncHandler(adminProductController.duplicate),
);

adminCatalogRouter.get(
  '/catalog/products/:id/publish-blockers',
  authenticate('ADMIN'),
  requirePermission('catalog.product.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminProductController.blockers),
);

adminCatalogRouter.post(
  '/catalog/products/:id/publish',
  ...guard,
  requirePermission('catalog.product.publish'),
  validate({ params: idParamSchema }),
  asyncHandler(adminProductController.publish),
);

adminCatalogRouter.post(
  '/catalog/products/:id/unpublish',
  ...guard,
  requirePermission('catalog.product.publish'),
  validate({ params: idParamSchema }),
  asyncHandler(adminProductController.unpublish),
);

adminCatalogRouter.put(
  '/catalog/products/:id/categories',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ params: idParamSchema, body: productCategoriesSchema }),
  asyncHandler(adminProductController.setCategories),
);

adminCatalogRouter.put(
  '/catalog/products/:id/attribute-values',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ params: idParamSchema, body: productAttributeValuesSchema }),
  asyncHandler(adminProductController.setAttributeValues),
);

adminCatalogRouter.put(
  '/catalog/products/:id/relations',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ params: idParamSchema, body: productRelationsSchema }),
  asyncHandler(adminProductController.setRelations),
);

adminCatalogRouter.get(
  '/catalog/products/:id/redirects',
  authenticate('ADMIN'),
  requirePermission('catalog.product.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminProductController.redirects),
);

adminCatalogRouter.delete(
  '/catalog/products/:id',
  ...guard,
  requirePermission('catalog.product.delete'),
  authRateLimit('catalog-destructive'),
  validate({ params: idParamSchema }),
  asyncHandler(adminProductController.remove),
);

adminCatalogRouter.post(
  '/catalog/products/:id/restore',
  ...guard,
  requirePermission('catalog.product.update'),
  validate({ params: idParamSchema }),
  asyncHandler(adminProductController.restore),
);

/* variants */
adminCatalogRouter.get(
  '/catalog/products/:id/variants',
  authenticate('ADMIN'),
  requirePermission('catalog.variant.read'),
  validate({ params: idParamSchema, query: variantListQuerySchema }),
  asyncHandler(adminVariantController.list),
);

adminCatalogRouter.post(
  '/catalog/products/:id/variants',
  ...guard,
  requirePermission('catalog.variant.create'),
  validate({ params: idParamSchema, body: variantCreateSchema }),
  asyncHandler(adminVariantController.create),
);

adminCatalogRouter.post(
  '/catalog/products/:id/variants/reorder',
  ...guard,
  requirePermission('catalog.variant.update'),
  validate({ params: idParamSchema, body: reorderSchema }),
  asyncHandler(adminVariantController.reorder),
);

adminCatalogRouter.post(
  '/catalog/products/:id/variants/matrix/preview',
  ...guard,
  requirePermission('catalog.variant.read'),
  validate({ params: idParamSchema, body: variantMatrixSchema }),
  asyncHandler(adminVariantController.matrixPreview),
);

adminCatalogRouter.post(
  '/catalog/products/:id/variants/matrix/generate',
  ...guard,
  requirePermission('catalog.variant.create'),
  idempotency('variant-matrix'),
  validate({ params: idParamSchema, body: variantMatrixSchema }),
  asyncHandler(adminVariantController.matrixGenerate),
);

adminCatalogRouter.patch(
  '/catalog/products/:id/variants/:variantId',
  ...guard,
  requirePermission('catalog.variant.update'),
  validate({
    params: idParamSchema.extend({ variantId: idParamSchema.shape.id }),
    body: variantUpdateSchema,
  }),
  asyncHandler(adminVariantController.update),
);

adminCatalogRouter.post(
  '/catalog/products/:id/variants/:variantId/set-default',
  ...guard,
  requirePermission('catalog.variant.update'),
  validate({ params: idParamSchema.extend({ variantId: idParamSchema.shape.id }) }),
  asyncHandler(adminVariantController.setDefault),
);

adminCatalogRouter.delete(
  '/catalog/products/:id/variants/:variantId',
  ...guard,
  requirePermission('catalog.variant.delete'),
  validate({ params: idParamSchema.extend({ variantId: idParamSchema.shape.id }) }),
  asyncHandler(adminVariantController.remove),
);

/* inventory */
adminCatalogRouter.get(
  '/catalog/inventory/low-stock',
  authenticate('ADMIN'),
  requirePermission('catalog.inventory.read'),
  validate({ query: lowStockQuerySchema }),
  asyncHandler(adminInventoryController.lowStock),
);

adminCatalogRouter.post(
  '/catalog/inventory/bulk-adjust',
  ...guard,
  requirePermission('catalog.inventory.update'),
  authRateLimit('inventory-bulk'),
  idempotency('inventory-bulk'),
  validate({ body: inventoryBulkAdjustSchema }),
  asyncHandler(adminInventoryController.bulkAdjust),
);

adminCatalogRouter.get(
  '/catalog/variants/:id/inventory',
  authenticate('ADMIN'),
  requirePermission('catalog.inventory.read'),
  validate({ params: idParamSchema, query: inventoryHistoryQuerySchema }),
  asyncHandler(adminInventoryController.history),
);

adminCatalogRouter.get(
  '/catalog/variants/:id/inventory/snapshot',
  authenticate('ADMIN'),
  requirePermission('catalog.inventory.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminInventoryController.snapshot),
);

adminCatalogRouter.post(
  '/catalog/variants/:id/inventory/adjust',
  ...guard,
  requirePermission('catalog.inventory.update'),
  idempotency('inventory-adjust'),
  validate({ params: idParamSchema, body: inventoryAdjustSchema }),
  asyncHandler(adminInventoryController.adjust),
);

/* collections */
adminCatalogRouter.get(
  '/catalog/collections',
  authenticate('ADMIN'),
  requirePermission('catalog.collection.read'),
  validate({ query: listQuerySchema }),
  asyncHandler(adminCollectionController.list),
);

adminCatalogRouter.post(
  '/catalog/collections',
  ...guard,
  requirePermission('catalog.collection.create'),
  validate({ body: collectionCreateSchema }),
  asyncHandler(adminCollectionController.create),
);

adminCatalogRouter.get(
  '/catalog/collections/:id',
  authenticate('ADMIN'),
  requirePermission('catalog.collection.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminCollectionController.get),
);

adminCatalogRouter.patch(
  '/catalog/collections/:id',
  ...guard,
  requirePermission('catalog.collection.update'),
  validate({ params: idParamSchema, body: collectionUpdateSchema }),
  asyncHandler(adminCollectionController.update),
);

adminCatalogRouter.delete(
  '/catalog/collections/:id',
  ...guard,
  requirePermission('catalog.collection.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminCollectionController.remove),
);

adminCatalogRouter.put(
  '/catalog/collections/:id/products',
  ...guard,
  requirePermission('catalog.collection.update'),
  validate({ params: idParamSchema, body: collectionProductsSchema }),
  asyncHandler(adminCollectionController.setProducts),
);

adminCatalogRouter.post(
  '/catalog/collections/:id/products/reorder',
  ...guard,
  requirePermission('catalog.collection.update'),
  validate({ params: idParamSchema, body: reorderSchema }),
  asyncHandler(adminCollectionController.reorderProducts),
);

/* price adjustments */
adminCatalogRouter.get(
  '/catalog/price-adjustments/conflicts',
  authenticate('ADMIN'),
  requirePermission('pricing.adjustment.read'),
  asyncHandler(adminPriceAdjustmentController.conflicts),
);

adminCatalogRouter.get(
  '/catalog/price-adjustments',
  authenticate('ADMIN'),
  requirePermission('pricing.adjustment.read'),
  validate({ query: priceAdjustmentListQuerySchema }),
  asyncHandler(adminPriceAdjustmentController.list),
);

adminCatalogRouter.post(
  '/catalog/price-adjustments',
  ...guard,
  requirePermission('pricing.adjustment.create'),
  validate({ body: priceAdjustmentCreateSchema }),
  asyncHandler(adminPriceAdjustmentController.create),
);

adminCatalogRouter.patch(
  '/catalog/price-adjustments/:id',
  ...guard,
  requirePermission('pricing.adjustment.update'),
  validate({ params: idParamSchema, body: priceAdjustmentUpdateSchema }),
  asyncHandler(adminPriceAdjustmentController.update),
);

adminCatalogRouter.delete(
  '/catalog/price-adjustments/:id',
  ...guard,
  requirePermission('pricing.adjustment.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminPriceAdjustmentController.remove),
);

/* import / export */
adminCatalogRouter.get(
  '/catalog/export/:entity',
  authenticate('ADMIN'),
  requirePermission('catalog.product.export'),
  authRateLimit('catalog-export'),
  validate({ query: exportQuerySchema }),
  asyncHandler(adminImportExportController.export),
);

adminCatalogRouter.get(
  '/catalog/import/templates/:entity',
  authenticate('ADMIN'),
  requirePermission('catalog.product.import'),
  adminImportExportController.template,
);

adminCatalogRouter.get(
  '/catalog/import/jobs',
  authenticate('ADMIN'),
  requirePermission('catalog.product.import'),
  validate({ query: importJobListQuerySchema }),
  asyncHandler(adminImportExportController.listJobs),
);

adminCatalogRouter.get(
  '/catalog/import/jobs/:id',
  authenticate('ADMIN'),
  requirePermission('catalog.product.import'),
  validate({ params: idParamSchema }),
  asyncHandler(adminImportExportController.getJob),
);

adminCatalogRouter.post(
  '/catalog/import/jobs/:id/commit',
  ...guard,
  authRateLimit('catalog-import'),
  idempotency('import-commit'),
  uploadMiddleware.array('files'),
  validate({ params: idParamSchema }),
  asyncHandler(adminImportExportController.commit),
);

adminCatalogRouter.post(
  '/catalog/import/:entity',
  ...guard,
  authRateLimit('catalog-import'),
  uploadMiddleware.array('files'),
  asyncHandler(adminImportExportController.import),
);
