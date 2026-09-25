import type { Request, Response } from 'express';

import type { ImportEntity } from '@shared/enums';
import type {
  AttributeCreateInput,
  AttributeGroupCreateInput,
  AttributeGroupUpdateInput,
  AttributeUpdateInput,
  AttributeValueCreateInput,
  AttributeValueUpdateInput,
  BrandCreateInput,
  BrandListQuery,
  BulkActionInput,
  CatalogSettingsUpdateInput,
  CategoryAttributeUpsertInput,
  CategoryBulkInput,
  CategoryCreateInput,
  CategoryDeleteQuery,
  CategoryListQuery,
  CategoryMoveInput,
  CategoryUpdateInput,
  CollectionCreateInput,
  AdminCollectionListQuery,
  CollectionProductsInput,
  CollectionUpdateInput,
  ExportQuery,
  ImportJobListQuery,
  InventoryAdjustInput,
  InventoryBulkAdjustInput,
  InventoryHistoryQuery,
  LowStockQuery,
  PriceAdjustmentCreateInput,
  PriceAdjustmentUpdateInput,
  AdminPriceAdjustmentListQuery,
  AdminAttributeListQuery,
  AdminProductListQuery,
  ProductAttributeValuesInput,
  ProductCategoriesInput,
  ProductCreateInput,
  ProductDuplicateInput,
  ProductPublishInput,
  ProductRelationsInput,
  ProductUpdateInput,
  ReorderInput,
  TaxClassCreateInput,
  TaxClassUpdateInput,
  VariantCreateInput,
  VariantListQuery,
  VariantMatrixInput,
  VariantUpdateInput,
} from '@shared/schemas/catalogAdmin';
import type { IdParam, ListQuery } from '@shared/schemas/common';

import { attributeAdminService } from '../modules/catalog-admin/attribute.admin.service';
import { brandAdminService } from '../modules/catalog-admin/brand.admin.service';
import { bulkActionService } from '../modules/catalog-admin/bulkAction.service';
import { catalogSettingsService } from '../modules/catalog-admin/catalogSettings.service';
import { categoryAdminService } from '../modules/catalog-admin/category.admin.service';
import { collectionAdminService } from '../modules/catalog-admin/collection.admin.service';
import { exportService } from '../modules/catalog-admin/import-export/export.service';
import { importService } from '../modules/catalog-admin/import-export/import.service';
import { inventoryService } from '../modules/catalog-admin/inventory.service';
import { priceAdjustmentAdminService } from '../modules/catalog-admin/priceAdjustment.admin.service';
import { productAdminService } from '../modules/catalog-admin/product.admin.service';
import { slugRedirectService } from '../modules/catalog-admin/slugRedirect.service';
import { variantAdminService } from '../modules/catalog-admin/variant.admin.service';
import { variantMatrixService } from '../modules/catalog-admin/variantMatrix.service';
import { auditService } from '../modules/auth/audit.service';
import { AppError } from '../utils/AppError';
import { ok, paginated } from '../utils/response';

/** R1 — thin controllers: validate (middleware), call the service, audit, respond. */

function actorId(req: Request): string | null {
  return req.auth?.principalId ?? null;
}

/* ------------------------------------------------------------- categories */

export const adminCatalogSettingsController = {
  async get(_req: Request, res: Response): Promise<void> {
    ok(res, await catalogSettingsService.get());
  },

  async update(req: Request, res: Response): Promise<void> {
    const before = await catalogSettingsService.get();
    const updated = await catalogSettingsService.update(req.body as CatalogSettingsUpdateInput);

    void auditService.recordFromRequest(req, {
      action: 'SETTING_CHANGED',
      entity: 'AppSetting',
      entityId: 'catalog',
      severity: 'NOTICE',
      changes: auditService.diff({ ...before }, { ...updated }),
    });

    ok(res, updated);
  },
};

export const adminCategoryController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await categoryAdminService.list(req.query as unknown as CategoryListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async tree(_req: Request, res: Response): Promise<void> {
    ok(res, await categoryAdminService.tree());
  },

  async get(req: Request, res: Response): Promise<void> {
    ok(res, await categoryAdminService.get((req.params as unknown as IdParam).id));
  },

  async create(req: Request, res: Response): Promise<void> {
    const created = await categoryAdminService.create(req.body as CategoryCreateInput);

    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Category',
      entityId: created.id,
      meta: { slug: created.slug, path: created.path },
    });

    ok(res, created, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const before = await categoryAdminService.get(id);
    const updated = await categoryAdminService.update(id, req.body as CategoryUpdateInput);

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Category',
      entityId: id,
      changes: auditService.diff({ ...before }, { ...updated }),
    });

    ok(res, updated);
  },

  async move(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const before = await categoryAdminService.get(id);
    const moved = await categoryAdminService.move(id, req.body as CategoryMoveInput);

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Category',
      entityId: id,
      severity: 'NOTICE',
      meta: { from: before.path, to: moved.path, parentId: moved.parentId },
    });

    ok(res, moved);
  },

  async reorder(req: Request, res: Response): Promise<void> {
    const count = await categoryAdminService.reorder(req.body as ReorderInput);

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Category',
      entityId: null,
      meta: { reordered: count },
    });

    ok(res, { reordered: count });
  },

  async deleteImpact(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const { strategy } = req.query as unknown as CategoryDeleteQuery;
    ok(res, await categoryAdminService.deleteImpact(id, strategy));
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const { strategy } = req.query as unknown as CategoryDeleteQuery;

    const result = await categoryAdminService.remove(id, strategy);

    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'Category',
      entityId: id,
      severity: 'WARNING',
      meta: { strategy, ...result },
    });

    ok(res, result);
  },

  async restore(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const restored = await categoryAdminService.restore(id);

    void auditService.recordFromRequest(req, {
      action: 'RESTORE',
      entity: 'Category',
      entityId: id,
    });

    ok(res, restored);
  },

  async bulk(req: Request, res: Response): Promise<void> {
    const body = req.body as CategoryBulkInput;
    const isActive = body.action === 'ACTIVATE';
    const count = await categoryAdminService.bulkSetActive(body.ids, isActive);

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Category',
      entityId: null,
      severity: 'WARNING',
      meta: { bulk: body.action, requested: body.ids.length, updated: count },
    });

    ok(res, { action: body.action, requested: body.ids.length, updated: count });
  },

  async redirects(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await slugRedirectService.listFor('CATEGORY', id));
  },

  async products(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const page = await categoryAdminService.listProducts(id, req.query as unknown as ListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async reorderProducts(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const count = await categoryAdminService.reorderProducts(id, req.body as ReorderInput);

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Category',
      entityId: id,
      meta: { reorderedProducts: count },
    });

    ok(res, { reordered: count });
  },
};

/* ------------------------------------------------------------- attributes */

export const adminAttributeController = {
  async listGroups(_req: Request, res: Response): Promise<void> {
    ok(res, await attributeAdminService.listGroups());
  },

  async createGroup(req: Request, res: Response): Promise<void> {
    const group = await attributeAdminService.createGroup(req.body as AttributeGroupCreateInput);
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'AttributeGroup',
      entityId: group.id,
    });
    ok(res, group, null, 201);
  },

  async updateGroup(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const group = await attributeAdminService.updateGroup(
      id,
      req.body as AttributeGroupUpdateInput,
    );
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'AttributeGroup',
      entityId: id,
    });
    ok(res, group);
  },

  async removeGroup(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await attributeAdminService.removeGroup(id);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'AttributeGroup',
      entityId: id,
      severity: 'WARNING',
    });
    ok(res, { deleted: true });
  },

  async list(req: Request, res: Response): Promise<void> {
    const page = await attributeAdminService.list(req.query as unknown as AdminAttributeListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async get(req: Request, res: Response): Promise<void> {
    ok(res, await attributeAdminService.get((req.params as unknown as IdParam).id));
  },

  async create(req: Request, res: Response): Promise<void> {
    const attribute = await attributeAdminService.create(req.body as AttributeCreateInput);
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Attribute',
      entityId: attribute.id,
      meta: { code: attribute.code },
    });
    ok(res, attribute, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const attribute = await attributeAdminService.update(id, req.body as AttributeUpdateInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Attribute',
      entityId: id,
    });
    ok(res, attribute);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await attributeAdminService.remove(id);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'Attribute',
      entityId: id,
      severity: 'WARNING',
    });
    ok(res, { deleted: true });
  },

  async reorder(req: Request, res: Response): Promise<void> {
    const count = await attributeAdminService.reorder(req.body as ReorderInput);
    ok(res, { reordered: count });
  },

  async createValue(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const value = await attributeAdminService.createValue(
      id,
      req.body as AttributeValueCreateInput,
    );
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'AttributeValue',
      entityId: value.id,
      meta: { attributeId: id, code: value.code },
    });
    ok(res, value, null, 201);
  },

  async updateValue(req: Request, res: Response): Promise<void> {
    const { valueId } = req.params as unknown as { valueId: string };
    const value = await attributeAdminService.updateValue(
      valueId,
      req.body as AttributeValueUpdateInput,
    );
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'AttributeValue',
      entityId: valueId,
    });
    ok(res, value);
  },

  async removeValue(req: Request, res: Response): Promise<void> {
    const { valueId } = req.params as unknown as { valueId: string };
    await attributeAdminService.removeValue(valueId);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'AttributeValue',
      entityId: valueId,
      severity: 'WARNING',
    });
    ok(res, { deleted: true });
  },

  async listForCategory(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await attributeAdminService.listForCategory(id));
  },

  async attachToCategory(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const link = await attributeAdminService.upsertCategoryAttribute(
      id,
      req.body as CategoryAttributeUpsertInput,
    );
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'CategoryAttribute',
      entityId: link.id,
      meta: { categoryId: id, attributeId: link.attributeId },
    });
    ok(res, link, null, 201);
  },

  async detachFromCategory(req: Request, res: Response): Promise<void> {
    const { id, attributeId } = req.params as unknown as { id: string; attributeId: string };
    await attributeAdminService.removeCategoryAttribute(id, attributeId);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'CategoryAttribute',
      entityId: null,
      meta: { categoryId: id, attributeId },
    });
    ok(res, { detached: true });
  },
};

/* ------------------------------------------------------- brands / taxes */

export const adminBrandController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await brandAdminService.list(req.query as unknown as BrandListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async create(req: Request, res: Response): Promise<void> {
    const brand = await brandAdminService.create(req.body as BrandCreateInput);
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Brand',
      entityId: brand.id,
    });
    ok(res, brand, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const brand = await brandAdminService.update(id, req.body as never);
    void auditService.recordFromRequest(req, { action: 'UPDATE', entity: 'Brand', entityId: id });
    ok(res, brand);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await brandAdminService.remove(id);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'Brand',
      entityId: id,
      severity: 'WARNING',
    });
    ok(res, { deleted: true });
  },
};

export const adminTaxClassController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await taxClassList(req);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async create(req: Request, res: Response): Promise<void> {
    const { taxClassAdminService } =
      await import('../modules/catalog-admin/taxClass.admin.service');
    const taxClass = await taxClassAdminService.create(req.body as TaxClassCreateInput);
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'TaxClass',
      entityId: taxClass.id,
      severity: 'NOTICE',
    });
    ok(res, taxClass, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { taxClassAdminService } =
      await import('../modules/catalog-admin/taxClass.admin.service');
    const { id } = req.params as unknown as IdParam;
    const taxClass = await taxClassAdminService.update(id, req.body as TaxClassUpdateInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'TaxClass',
      entityId: id,
      severity: 'NOTICE',
    });
    ok(res, taxClass);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { taxClassAdminService } =
      await import('../modules/catalog-admin/taxClass.admin.service');
    const { id } = req.params as unknown as IdParam;
    await taxClassAdminService.remove(id);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'TaxClass',
      entityId: id,
      severity: 'WARNING',
    });
    ok(res, { deleted: true });
  },
};

async function taxClassList(req: Request) {
  const { taxClassAdminService } = await import('../modules/catalog-admin/taxClass.admin.service');
  return taxClassAdminService.list(req.query as unknown as ListQuery);
}

/* ---------------------------------------------------------------- products */

export const adminProductController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await productAdminService.list(req.query as unknown as AdminProductListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async get(req: Request, res: Response): Promise<void> {
    ok(res, await productAdminService.get((req.params as unknown as IdParam).id));
  },

  async create(req: Request, res: Response): Promise<void> {
    const product = await productAdminService.create(req.body as ProductCreateInput);

    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Product',
      entityId: product.id,
      meta: { sku: product.sku, slug: product.slug },
    });

    ok(res, product, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const before = await productAdminService.get(id);
    const updated = await productAdminService.update(id, req.body as ProductUpdateInput);

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Product',
      entityId: id,
      changes: auditService.diff(
        { ...before, variants: undefined, media: undefined },
        { ...updated, variants: undefined, media: undefined },
      ),
    });

    ok(res, updated);
  },

  async duplicate(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const copy = await productAdminService.duplicate(id, req.body as ProductDuplicateInput);

    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Product',
      entityId: copy.id,
      meta: { duplicatedFrom: id, sku: copy.sku, slug: copy.slug },
    });

    ok(res, copy, null, 201);
  },

  async publish(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const product = await productAdminService.publish(id, req.body as ProductPublishInput);

    void auditService.recordFromRequest(req, {
      action: 'PUBLISH',
      entity: 'Product',
      entityId: id,
      severity: 'NOTICE',
      meta: {
        completeness: product.completenessScore,
        publishedAt: product.publishedAt,
        scheduled: product.publication === 'SCHEDULED',
      },
    });

    ok(res, product);
  },

  async unpublish(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const product = await productAdminService.unpublish(id);

    void auditService.recordFromRequest(req, {
      action: 'UNPUBLISH',
      entity: 'Product',
      entityId: id,
      severity: 'NOTICE',
    });

    ok(res, product);
  },

  async blockers(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await productAdminService.publishBlockers(id));
  },

  async setCategories(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const product = await productAdminService.setCategories(id, req.body as ProductCategoriesInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Product',
      entityId: id,
      meta: { categories: product.categories.length },
    });
    ok(res, product);
  },

  async setAttributeValues(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const product = await productAdminService.setAttributeValues(
      id,
      req.body as ProductAttributeValuesInput,
    );
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Product',
      entityId: id,
      meta: { specs: product.attributeValues.length },
    });
    ok(res, product);
  },

  async setRelations(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const product = await productAdminService.setRelations(id, req.body as ProductRelationsInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Product',
      entityId: id,
      meta: { relations: product.relations.length },
    });
    ok(res, product);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await productAdminService.softDelete(id);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'Product',
      entityId: id,
      severity: 'WARNING',
    });
    ok(res, { deleted: true });
  },

  async restore(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const product = await productAdminService.restore(id);
    void auditService.recordFromRequest(req, {
      action: 'RESTORE',
      entity: 'Product',
      entityId: id,
    });
    ok(res, product);
  },

  async bulk(req: Request, res: Response): Promise<void> {
    const input = req.body as BulkActionInput;

    const permission = bulkActionService.permissionFor(input.action);
    if (!req.auth?.permissions.includes(permission)) {
      throw AppError.forbidden(`This bulk action requires ${permission}`, {
        action: input.action,
        permission,
      });
    }

    const result = await bulkActionService.run(input, actorId(req));

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Product',
      entityId: null,
      severity: 'WARNING',
      meta: {
        bulk: input.action,
        requested: result.requested,
        succeeded: result.succeeded,
        failed: result.failed,
      },
    });

    ok(res, result);
  },

  async redirects(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await slugRedirectService.listFor('PRODUCT', id));
  },
};

/* ---------------------------------------------------------------- variants */

export const adminVariantController = {
  async list(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await variantAdminService.list(id, req.query as unknown as VariantListQuery));
  },

  async create(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const variant = await variantAdminService.create(id, req.body as VariantCreateInput);

    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'ProductVariant',
      entityId: variant.id,
      meta: { productId: id, sku: variant.sku },
    });

    ok(res, variant, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id, variantId } = req.params as unknown as { id: string; variantId: string };
    const variant = await variantAdminService.update(id, variantId, req.body as VariantUpdateInput);

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'ProductVariant',
      entityId: variantId,
    });

    ok(res, variant);
  },

  async setDefault(req: Request, res: Response): Promise<void> {
    const { id, variantId } = req.params as unknown as { id: string; variantId: string };
    ok(res, await variantAdminService.setDefault(id, variantId));
  },

  async reorder(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const count = await variantAdminService.reorder(id, req.body as ReorderInput);
    ok(res, { reordered: count });
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id, variantId } = req.params as unknown as { id: string; variantId: string };
    await variantAdminService.remove(id, variantId);

    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'ProductVariant',
      entityId: variantId,
      severity: 'WARNING',
    });

    ok(res, { deleted: true });
  },

  async matrixPreview(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await variantMatrixService.preview(id, req.body as VariantMatrixInput));
  },

  async matrixGenerate(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const result = await variantMatrixService.generate(id, req.body as VariantMatrixInput);

    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'ProductVariant',
      entityId: null,
      severity: 'NOTICE',
      meta: { productId: id, created: result.created, total: result.preview.total },
    });

    ok(res, result, null, 201);
  },
};

/* --------------------------------------------------------------- inventory */

export const adminInventoryController = {
  async history(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const page = await inventoryService.history(id, req.query as unknown as InventoryHistoryQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async snapshot(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await inventoryService.snapshot(id));
  },

  async adjust(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const input = req.body as InventoryAdjustInput;

    const result = await inventoryService.adjust(id, input, {
      actorType: req.auth?.principalType ?? 'ADMIN',
      actorId: actorId(req),
    });

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'InventoryLedger',
      entityId: result.entry.id,
      meta: {
        variantId: id,
        delta: result.entry.delta,
        balanceAfter: result.entry.balanceAfter,
        reason: result.entry.reason,
      },
    });

    ok(res, result);
  },

  async bulkAdjust(req: Request, res: Response): Promise<void> {
    const input = req.body as InventoryBulkAdjustInput;

    const resolved = [];
    for (const item of input.items) {
      const variantId =
        item.variantId ??
        (item.sku
          ? (
              await import('../config/prisma').then(({ prisma }) =>
                prisma.productVariant.findFirst({
                  where: { sku: item.sku, deletedAt: null },
                  select: { id: true },
                }),
              )
            )?.id
          : undefined);

      if (!variantId) {
        throw AppError.validation('Every item needs a variantId or a known sku', { item });
      }
      resolved.push({ ...item, variantId });
    }

    const results = await inventoryService.bulkAdjust(resolved, input.reason, {
      actorType: req.auth?.principalType ?? 'ADMIN',
      actorId: actorId(req),
    });

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'InventoryLedger',
      entityId: null,
      severity: 'WARNING',
      meta: {
        bulk: true,
        requested: results.length,
        succeeded: results.filter((row) => row.ok).length,
      },
    });

    ok(res, { results });
  },

  async lowStock(req: Request, res: Response): Promise<void> {
    const page = await inventoryService.lowStock(req.query as unknown as LowStockQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },
};

/* ------------------------------------------------------------- collections */

export const adminCollectionController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await collectionAdminService.list(
      req.query as unknown as AdminCollectionListQuery,
    );
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async get(req: Request, res: Response): Promise<void> {
    ok(res, await collectionAdminService.get((req.params as unknown as IdParam).id));
  },

  async create(req: Request, res: Response): Promise<void> {
    const collection = await collectionAdminService.create(req.body as CollectionCreateInput);
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Collection',
      entityId: collection.id,
    });
    ok(res, collection, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const before = await collectionAdminService.get(id);
    const collection = await collectionAdminService.update(id, req.body as CollectionUpdateInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Collection',
      entityId: id,
      changes: auditService.diff({ ...before }, { ...collection }),
    });
    ok(res, collection);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await collectionAdminService.remove(id);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'Collection',
      entityId: id,
      severity: 'WARNING',
    });
    ok(res, { deleted: true });
  },

  async restore(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const collection = await collectionAdminService.restore(id);
    void auditService.recordFromRequest(req, {
      action: 'RESTORE',
      entity: 'Collection',
      entityId: id,
    });
    ok(res, collection);
  },

  async setProducts(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const count = await collectionAdminService.setProducts(id, req.body as CollectionProductsInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Collection',
      entityId: id,
      meta: { products: count },
    });
    ok(res, { products: count });
  },

  async reorderProducts(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const count = await collectionAdminService.reorderProducts(id, req.body as ReorderInput);
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Collection',
      entityId: id,
      meta: { reordered: count },
    });
    ok(res, { reordered: count });
  },
};

/* -------------------------------------------------------- price adjustments */

export const adminPriceAdjustmentController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await priceAdjustmentAdminService.list(
      req.query as unknown as AdminPriceAdjustmentListQuery,
    );
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async conflicts(_req: Request, res: Response): Promise<void> {
    ok(res, await priceAdjustmentAdminService.conflicts());
  },

  async create(req: Request, res: Response): Promise<void> {
    const row = await priceAdjustmentAdminService.create(req.body as PriceAdjustmentCreateInput);
    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'PriceAdjustment',
      entityId: row.id,
      severity: 'NOTICE',
    });
    ok(res, row, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const row = await priceAdjustmentAdminService.update(
      id,
      req.body as PriceAdjustmentUpdateInput,
    );
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'PriceAdjustment',
      entityId: id,
      severity: 'NOTICE',
    });
    ok(res, row);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await priceAdjustmentAdminService.remove(id);
    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'PriceAdjustment',
      entityId: id,
      severity: 'WARNING',
    });
    ok(res, { deleted: true });
  },
};

/* ----------------------------------------------------------- import/export */

export const adminImportExportController = {
  async export(req: Request, res: Response): Promise<void> {
    const { entity } = req.params as unknown as { entity: ImportEntity };
    const rows = await exportService.stream(entity, req.query as unknown as ExportQuery, res);

    void auditService.recordFromRequest(req, {
      action: 'EXPORT',
      entity: 'Catalog',
      entityId: null,
      severity: 'NOTICE',
      meta: { entity, rows },
    });
  },

  template(req: Request, res: Response): void {
    const { entity } = req.params as unknown as { entity: ImportEntity };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clearwood-${entity.toLowerCase()}-template.csv"`,
    );
    res.send(exportService.template(entity));
  },

  async import(req: Request, res: Response): Promise<void> {
    const { entity } = req.params as unknown as { entity: ImportEntity };

    // Entity-specific authorisation: inventory and price rules need their own permissions.
    importService.assertImportAllowed(entity, req.auth?.permissions ?? []);

    const file = (req.files as Express.Multer.File[] | undefined)?.[0];
    if (!file) throw AppError.validation('Attach a CSV file as "files"', { field: 'files' });

    const dryRun = req.body?.dryRun !== 'false' && req.body?.dryRun !== false;

    const job = await importService.createJob(
      entity,
      { buffer: file.buffer, originalName: file.originalname },
      dryRun,
      actorId(req),
    );

    void auditService.recordFromRequest(req, {
      action: dryRun ? 'UPDATE' : 'IMPORT',
      entity: 'ImportJob',
      entityId: job.id,
      severity: dryRun ? 'INFO' : 'WARNING',
      meta: { entity, dryRun, rows: job.totalRows, errors: job.errorRows },
    });

    ok(res, job, null, 201);
  },

  async commit(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;

    importService.assertAnyImportAllowed(req.auth?.permissions ?? []);
    const existing = await importService.get(id);
    importService.assertImportAllowed(existing.entity, req.auth?.permissions ?? []);

    const file = (req.files as Express.Multer.File[] | undefined)?.[0];
    if (!file) {
      throw AppError.validation('Re-attach the same CSV file to commit it', { field: 'files' });
    }

    const job = await importService.commit(id, file.buffer);

    void auditService.recordFromRequest(req, {
      action: 'IMPORT',
      entity: 'ImportJob',
      entityId: id,
      severity: 'CRITICAL',
      meta: { entity: job.entity, success: job.successRows, errors: job.errorRows },
    });

    ok(res, job);
  },

  async listJobs(req: Request, res: Response): Promise<void> {
    const page = await importService.list(req.query as unknown as ImportJobListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async getJob(req: Request, res: Response): Promise<void> {
    ok(res, await importService.get((req.params as unknown as IdParam).id));
  },
};
