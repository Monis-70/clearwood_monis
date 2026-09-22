import type { Response } from 'express';

import type { ImportEntity } from '@shared/enums';
import type { ExportQuery } from '@shared/schemas/catalogAdmin';

import { env } from '../../../config/env';
import { prisma } from '../../../config/prisma';
import { notDeleted } from '../../../repositories/helpers';

import { csvRow, paiseToCsv } from './csv';

/**
 * Streaming CSV export. Rows are written as they are read so a 50k-row export never buffers in
 * memory, and every cell goes through escapeCsvValue (formula-injection safe).
 */

export const EXPORT_HEADERS: Record<ImportEntity, string[]> = {
  PRODUCT: [
    'sku',
    'slug',
    'name',
    'productType',
    'status',
    'visibility',
    'brandSlug',
    'taxClassCode',
    'basePriceRupees',
    'compareAtPriceRupees',
    'primaryCategorySlug',
    'categorySlugs',
    'shortDescription',
    'description',
    'warrantyMonths',
    'weightGrams',
    'lengthMm',
    'widthMm',
    'heightMm',
    'seoTitle',
    'seoDescription',
    'searchKeywords',
  ],
  VARIANT: [
    'sku',
    'productSku',
    'name',
    'priceRupees',
    'compareAtPriceRupees',
    'barcode',
    'position',
    'isDefault',
    'isActive',
    'lowStockThreshold',
    'allowBackorder',
    'attributeCodes',
    'attributeValueCodes',
  ],
  CATEGORY: [
    'slug',
    'name',
    'parentSlug',
    'kind',
    'position',
    'isActive',
    'showInMenu',
    'shortDescription',
    'seoTitle',
    'seoDescription',
  ],
  ATTRIBUTE_VALUE: ['attributeCode', 'code', 'label', 'position', 'colorHex', 'isActive'],
  PRICE_ADJUSTMENT: [
    'name',
    'scope',
    'adjustmentType',
    'basis',
    'priority',
    'isActive',
    'valueRupees',
    'valueBp',
    'productSku',
    'variantSku',
    'categorySlug',
    'attributeValueCode',
    'startsAt',
    'endsAt',
  ],
  INVENTORY: ['variantSku', 'stockQty', 'reservedQty', 'lowStockThreshold', 'allowBackorder'],
};

function filename(entity: ImportEntity): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `clearwood-${entity.toLowerCase().replace('_', '-')}-${stamp}.csv`;
}

export const exportService = {
  headersFor(entity: ImportEntity): string[] {
    return EXPORT_HEADERS[entity];
  },

  /** A header-only CSV the admin can fill in and re-upload. */
  template(entity: ImportEntity): string {
    return csvRow(EXPORT_HEADERS[entity]);
  },

  async stream(entity: ImportEntity, query: ExportQuery, res: Response): Promise<number> {
    const limit = Math.min(query.limit ?? env.EXPORT_MAX_ROWS, env.EXPORT_MAX_ROWS);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename(entity)}"`);
    res.write('\uFEFF'); // BOM so Excel reads UTF-8 correctly
    res.write(csvRow(EXPORT_HEADERS[entity]));

    let written = 0;

    switch (entity) {
      case 'PRODUCT': {
        const products = await prisma.product.findMany({
          where: {
            ...(query.includeDeleted ? {} : notDeleted),
            ...(query.status ? { status: query.status } : {}),
            ...(query.brandId ? { brandId: query.brandId } : {}),
            ...(query.categoryId ? { categories: { some: { categoryId: query.categoryId } } } : {}),
            ...(query.q
              ? { OR: [{ name: { contains: query.q } }, { sku: { contains: query.q } }] }
              : {}),
          },
          include: {
            brand: { select: { slug: true } },
            taxClass: { select: { code: true } },
            categories: { include: { category: { select: { slug: true } } } },
          },
          orderBy: { sku: 'asc' },
          take: limit,
        });

        for (const product of products) {
          res.write(
            csvRow([
              product.sku,
              product.slug,
              product.name,
              product.productType,
              product.status,
              product.visibility,
              product.brand?.slug ?? '',
              product.taxClass?.code ?? '',
              paiseToCsv(product.basePricePaise),
              paiseToCsv(product.compareAtPricePaise),
              product.categories.find((row) => row.isPrimary)?.category.slug ?? '',
              product.categories.map((row) => row.category.slug).join('|'),
              product.shortDescription,
              product.description,
              product.warrantyMonths,
              product.weightGrams,
              product.lengthMm,
              product.widthMm,
              product.heightMm,
              product.seoTitle,
              product.seoDescription,
              product.searchKeywords,
            ]),
          );
          written += 1;
        }
        break;
      }

      case 'VARIANT': {
        const variants = await prisma.productVariant.findMany({
          where: {
            ...(query.includeDeleted ? {} : notDeleted),
            ...(query.categoryId
              ? { product: { categories: { some: { categoryId: query.categoryId } } } }
              : {}),
          },
          include: {
            product: { select: { sku: true } },
            attributeValues: {
              include: {
                attribute: { select: { code: true } },
                attributeValue: { select: { code: true } },
              },
            },
          },
          orderBy: { sku: 'asc' },
          take: limit,
        });

        for (const variant of variants) {
          res.write(
            csvRow([
              variant.sku,
              variant.product.sku,
              variant.name,
              paiseToCsv(variant.pricePaise),
              paiseToCsv(variant.compareAtPricePaise),
              variant.barcode,
              variant.position,
              variant.isDefault,
              variant.isActive,
              variant.lowStockThreshold,
              variant.allowBackorder,
              variant.attributeValues.map((row) => row.attribute.code).join('|'),
              variant.attributeValues.map((row) => row.attributeValue.code).join('|'),
            ]),
          );
          written += 1;
        }
        break;
      }

      case 'CATEGORY': {
        const categories = await prisma.category.findMany({
          where: query.includeDeleted ? {} : notDeleted,
          include: { parent: { select: { slug: true } } },
          orderBy: [{ depth: 'asc' }, { position: 'asc' }],
          take: limit,
        });

        for (const category of categories) {
          res.write(
            csvRow([
              category.slug,
              category.name,
              category.parent?.slug ?? '',
              category.kind,
              category.position,
              category.isActive,
              category.showInMenu,
              category.shortDescription,
              category.seoTitle,
              category.seoDescription,
            ]),
          );
          written += 1;
        }
        break;
      }

      case 'ATTRIBUTE_VALUE': {
        const values = await prisma.attributeValue.findMany({
          where: query.includeDeleted ? {} : notDeleted,
          include: { attribute: { select: { code: true } } },
          orderBy: [{ attributeId: 'asc' }, { position: 'asc' }],
          take: limit,
        });

        for (const value of values) {
          res.write(
            csvRow([
              value.attribute.code,
              value.code,
              value.label,
              value.position,
              value.colorHex,
              value.isActive,
            ]),
          );
          written += 1;
        }
        break;
      }

      case 'PRICE_ADJUSTMENT': {
        const rows = await prisma.priceAdjustment.findMany({
          where: query.includeDeleted ? {} : notDeleted,
          orderBy: [{ scope: 'asc' }, { priority: 'asc' }],
          take: limit,
        });

        const [products, variants, categories, values] = await Promise.all([
          prisma.product.findMany({ select: { id: true, sku: true } }),
          prisma.productVariant.findMany({ select: { id: true, sku: true } }),
          prisma.category.findMany({ select: { id: true, slug: true } }),
          prisma.attributeValue.findMany({ select: { id: true, code: true } }),
        ]);
        const productSku = new Map(products.map((row) => [row.id, row.sku]));
        const variantSku = new Map(variants.map((row) => [row.id, row.sku]));
        const categorySlug = new Map(categories.map((row) => [row.id, row.slug]));
        const valueCode = new Map(values.map((row) => [row.id, row.code]));

        for (const row of rows) {
          res.write(
            csvRow([
              row.name,
              row.scope,
              row.adjustmentType,
              row.basis,
              row.priority,
              row.isActive,
              paiseToCsv(row.valuePaise),
              row.valueBp,
              row.productId ? (productSku.get(row.productId) ?? '') : '',
              row.variantId ? (variantSku.get(row.variantId) ?? '') : '',
              row.categoryId ? (categorySlug.get(row.categoryId) ?? '') : '',
              row.attributeValueId ? (valueCode.get(row.attributeValueId) ?? '') : '',
              row.startsAt,
              row.endsAt,
            ]),
          );
          written += 1;
        }
        break;
      }

      case 'INVENTORY': {
        const variants = await prisma.productVariant.findMany({
          where: notDeleted,
          orderBy: { sku: 'asc' },
          take: limit,
        });

        for (const variant of variants) {
          res.write(
            csvRow([
              variant.sku,
              variant.stockQty,
              variant.reservedQty,
              variant.lowStockThreshold,
              variant.allowBackorder,
            ]),
          );
          written += 1;
        }
        break;
      }
    }

    res.end();
    return written;
  },
};
