import { parse } from 'csv-parse/sync';

import type { ImportEntity, InventoryReason } from '@shared/enums';
import type { Permission } from '@shared/enums';
import type { ImportJobListQuery } from '@shared/schemas/catalogAdmin';
import type { ImportJobDto, ImportRowErrorDto } from '@shared/types/catalogAdmin';

import { env } from '../../../config/env';
import { prisma } from '../../../config/prisma';
import { notDeleted, pageResult, skipTake, type PageResult } from '../../../repositories/helpers';
import { AppError } from '../../../utils/AppError';
import { jsonColumn } from '../../../utils/jsonColumn';
import { slugify } from '../../../utils/slug';
import { inventoryService } from '../inventory.service';
import { catalogCacheService } from '../catalogCache.service';

import { csvToPaise, csvBoolean, unescapeCsvValue } from './csv';
import { EXPORT_HEADERS } from './export.service';

/**
 * CSV import.
 *
 * Safety rules:
 *  - imports are confined to the catalog. There is no importable entity that can reach AdminUser,
 *    Role, Permission, RolePermission or any other security-domain table, and the entity whitelist
 *    below is the only way in;
 *  - every entity declares the permissions it needs (inventory needs catalog.inventory.update,
 *    price rules need pricing.adjustment.create AND .update), checked before a byte is parsed;
 *  - a job is validated first (dryRun) and may only be committed once it has passed;
 *  - commits run in chunks of IMPORT_CHUNK_SIZE inside a transaction, so a bad row rolls back its
 *    own chunk and is reported — a partial product is never written;
 *  - upserts are keyed on natural business keys (sku / slug / attribute code), so re-running the
 *    same file is idempotent.
 */

const errorsColumn = jsonColumn<ImportRowErrorDto[]>(undefined, 'ImportJob.errorsJson');
const summaryColumn = jsonColumn<Record<string, number>>(undefined, 'ImportJob.summaryJson');

/** The only tables an import may ever touch. */
export const IMPORT_PERMISSIONS: Record<ImportEntity, Permission[]> = {
  PRODUCT: ['catalog.product.import'],
  VARIANT: ['catalog.product.import', 'catalog.variant.update'],
  CATEGORY: ['catalog.product.import', 'catalog.category.update'],
  ATTRIBUTE_VALUE: ['catalog.product.import', 'catalog.attribute.update'],
  PRICE_ADJUSTMENT: ['pricing.adjustment.create', 'pricing.adjustment.update'],
  INVENTORY: ['catalog.inventory.update'],
};

export function assertImportAllowed(entity: ImportEntity, granted: readonly string[]): void {
  const required = IMPORT_PERMISSIONS[entity];
  const missing = required.filter((permission) => !granted.includes(permission));

  if (missing.length > 0) {
    throw AppError.forbidden(`Importing ${entity} requires ${missing.join(', ')}`, {
      entity,
      required,
      missing,
    });
  }
}

interface ParsedRow {
  row: number;
  data: Record<string, string>;
}

interface RowOutcome {
  ok: boolean;
  error?: ImportRowErrorDto;
}

function parseCsv(buffer: Buffer, entity: ImportEntity): ParsedRow[] {
  const records = parse(buffer, {
    columns: (header: string[]) => header.map((column) => column.trim()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  if (records.length > env.IMPORT_MAX_ROWS) {
    throw AppError.validation(
      `That file has ${records.length} rows; the limit is ${env.IMPORT_MAX_ROWS}`,
      { rows: records.length, max: env.IMPORT_MAX_ROWS },
    );
  }

  const expected = EXPORT_HEADERS[entity];
  const actual = Object.keys(records[0] ?? {});
  const missing = expected.filter((column) => !actual.includes(column));

  // Only the key columns are mandatory; the rest may be omitted for a partial update.
  const keyColumns = expected.slice(0, entity === 'ATTRIBUTE_VALUE' ? 2 : 1);
  const missingKeys = keyColumns.filter((column) => missing.includes(column));

  if (missingKeys.length > 0) {
    throw AppError.validation('The file is missing required columns', {
      missing: missingKeys,
      expected,
    });
  }

  return records.map((data, index) => ({
    row: index + 2, // +1 for the header, +1 because humans count from 1
    data: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, unescapeCsvValue(String(value ?? ''))]),
    ),
  }));
}

function toDto(job: {
  id: string;
  entity: string;
  status: string;
  fileName: string;
  dryRun: boolean;
  totalRows: number;
  processedRows: number;
  successRows: number;
  errorRows: number;
  errorsJson: string | null;
  summaryJson: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}): ImportJobDto {
  return {
    id: job.id,
    entity: job.entity as ImportEntity,
    status: job.status as ImportJobDto['status'],
    fileName: job.fileName,
    dryRun: job.dryRun,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    successRows: job.successRows,
    errorRows: job.errorRows,
    errors: errorsColumn.parse(job.errorsJson, []),
    summary: summaryColumn.parseOrNull(job.summaryJson),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------ row writers */

type Writer = (
  row: ParsedRow,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  dryRun: boolean,
) => Promise<void>;

const writers: Record<ImportEntity, Writer> = {
  async PRODUCT(row, tx, dryRun) {
    const { data } = row;
    if (!data.sku) throw new RowError('sku', 'sku is required');
    if (!data.name) throw new RowError('name', 'name is required');

    const basePricePaise = csvToPaise(data.basePriceRupees, 'basePriceRupees') ?? 0;
    const compareAt = csvToPaise(data.compareAtPriceRupees, 'compareAtPriceRupees');

    const brand = data.brandSlug
      ? await tx.brand.findFirst({ where: { slug: data.brandSlug }, select: { id: true } })
      : null;
    if (data.brandSlug && !brand)
      throw new RowError('brandSlug', `unknown brand "${data.brandSlug}"`);

    const taxClass = data.taxClassCode
      ? await tx.taxClass.findFirst({ where: { code: data.taxClassCode }, select: { id: true } })
      : null;
    if (data.taxClassCode && !taxClass) {
      throw new RowError('taxClassCode', `unknown tax class "${data.taxClassCode}"`);
    }

    if (dryRun) return;

    const existing = await tx.product.findFirst({ where: { sku: data.sku }, select: { id: true } });

    const payload = {
      name: data.name,
      productType: data.productType || 'SIMPLE',
      visibility: data.visibility || 'PUBLIC',
      brandId: brand?.id ?? null,
      taxClassId: taxClass?.id ?? null,
      basePricePaise,
      compareAtPricePaise: compareAt,
      shortDescription: data.shortDescription || null,
      description: data.description || null,
      warrantyMonths: data.warrantyMonths ? Number(data.warrantyMonths) : null,
      weightGrams: data.weightGrams ? Number(data.weightGrams) : null,
      lengthMm: data.lengthMm ? Number(data.lengthMm) : null,
      widthMm: data.widthMm ? Number(data.widthMm) : null,
      heightMm: data.heightMm ? Number(data.heightMm) : null,
      seoTitle: data.seoTitle || null,
      seoDescription: data.seoDescription || null,
      searchKeywords: data.searchKeywords || null,
    };

    const productId = existing
      ? (
          await tx.product.update({
            where: { id: existing.id },
            data: payload,
            select: { id: true },
          })
        ).id
      : (
          await tx.product.create({
            data: {
              ...payload,
              sku: data.sku,
              slug: data.slug ? slugify(data.slug) : slugify(data.name),
              // Imports never publish: a human decides when a product goes live.
              status: 'DRAFT',
            },
            select: { id: true },
          })
        ).id;

    const slugs = [
      ...(data.primaryCategorySlug ? [data.primaryCategorySlug] : []),
      ...(data.categorySlugs ? data.categorySlugs.split('|').filter(Boolean) : []),
    ];

    if (slugs.length > 0) {
      const categories = await tx.category.findMany({
        where: { slug: { in: slugs } },
        select: { id: true, slug: true },
      });
      const bySlug = new Map(categories.map((category) => [category.slug, category.id]));
      const unknown = slugs.filter((slug) => !bySlug.has(slug));
      if (unknown.length > 0) {
        throw new RowError('categorySlugs', `unknown categories: ${unknown.join(', ')}`);
      }

      await tx.productCategory.deleteMany({ where: { productId } });
      await tx.productCategory.createMany({
        data: [...new Set(slugs)].map((slug, index) => ({
          productId,
          categoryId: bySlug.get(slug)!,
          isPrimary: slug === data.primaryCategorySlug,
          position: index,
        })),
      });
    }
  },

  async VARIANT(row, tx, dryRun) {
    const { data } = row;
    if (!data.sku) throw new RowError('sku', 'sku is required');
    if (!data.productSku) throw new RowError('productSku', 'productSku is required');

    const product = await tx.product.findFirst({
      where: { sku: data.productSku },
      select: { id: true },
    });
    if (!product) throw new RowError('productSku', `unknown product "${data.productSku}"`);

    const pricePaise = csvToPaise(data.priceRupees, 'priceRupees');
    const compareAt = csvToPaise(data.compareAtPriceRupees, 'compareAtPriceRupees');

    if (dryRun) return;

    const existing = await tx.productVariant.findFirst({
      where: { sku: data.sku },
      select: { id: true },
    });

    const payload = {
      name: data.name || null,
      pricePaise,
      compareAtPricePaise: compareAt,
      barcode: data.barcode || null,
      position: data.position ? Number(data.position) : 0,
      isDefault: csvBoolean(data.isDefault) ?? false,
      isActive: csvBoolean(data.isActive) ?? true,
      lowStockThreshold: data.lowStockThreshold ? Number(data.lowStockThreshold) : 0,
      allowBackorder: csvBoolean(data.allowBackorder) ?? false,
    };

    if (existing) {
      await tx.productVariant.update({ where: { id: existing.id }, data: payload });
    } else {
      await tx.productVariant.create({
        data: { ...payload, sku: data.sku, productId: product.id },
      });
    }
  },

  async CATEGORY(row, tx, dryRun) {
    const { data } = row;
    if (!data.slug) throw new RowError('slug', 'slug is required');
    if (!data.name) throw new RowError('name', 'name is required');

    const parent = data.parentSlug
      ? await tx.category.findFirst({
          where: { slug: data.parentSlug },
          select: { id: true, path: true, depth: true },
        })
      : null;
    if (data.parentSlug && !parent) {
      throw new RowError('parentSlug', `unknown parent "${data.parentSlug}"`);
    }

    if (dryRun) return;

    const slug = slugify(data.slug);
    const path = parent ? `${parent.path}/${slug}` : slug;
    const depth = parent ? parent.depth + 1 : 0;

    const payload = {
      name: data.name,
      parentId: parent?.id ?? null,
      path,
      depth,
      kind: data.kind || 'STANDARD',
      position: data.position ? Number(data.position) : 0,
      isActive: csvBoolean(data.isActive) ?? true,
      showInMenu: csvBoolean(data.showInMenu) ?? true,
      shortDescription: data.shortDescription || null,
      seoTitle: data.seoTitle || null,
      seoDescription: data.seoDescription || null,
    };

    const existing = await tx.category.findFirst({ where: { slug }, select: { id: true } });
    if (existing) {
      await tx.category.update({ where: { id: existing.id }, data: payload });
    } else {
      await tx.category.create({ data: { ...payload, slug } });
    }
  },

  async ATTRIBUTE_VALUE(row, tx, dryRun) {
    const { data } = row;
    if (!data.attributeCode) throw new RowError('attributeCode', 'attributeCode is required');
    if (!data.code) throw new RowError('code', 'code is required');

    const attribute = await tx.attribute.findFirst({
      where: { code: data.attributeCode },
      select: { id: true },
    });
    if (!attribute) {
      throw new RowError('attributeCode', `unknown attribute "${data.attributeCode}"`);
    }

    if (dryRun) return;

    const payload = {
      label: data.label || data.code,
      position: data.position ? Number(data.position) : 0,
      colorHex: data.colorHex || null,
      isActive: csvBoolean(data.isActive) ?? true,
    };

    await tx.attributeValue.upsert({
      where: { attributeId_code: { attributeId: attribute.id, code: data.code } },
      update: payload,
      create: { ...payload, attributeId: attribute.id, code: data.code },
    });
  },

  async PRICE_ADJUSTMENT(row, tx, dryRun) {
    const { data } = row;
    if (!data.name) throw new RowError('name', 'name is required');
    if (!data.scope) throw new RowError('scope', 'scope is required');

    const valuePaise = csvToPaise(data.valueRupees, 'valueRupees');
    const valueBp = data.valueBp ? Number(data.valueBp) : null;
    if (valuePaise === null && valueBp === null) {
      throw new RowError('valueRupees', 'provide valueRupees or valueBp');
    }

    const product = data.productSku
      ? await tx.product.findFirst({ where: { sku: data.productSku }, select: { id: true } })
      : null;
    if (data.productSku && !product) {
      throw new RowError('productSku', `unknown product "${data.productSku}"`);
    }

    const variant = data.variantSku
      ? await tx.productVariant.findFirst({ where: { sku: data.variantSku }, select: { id: true } })
      : null;
    if (data.variantSku && !variant) {
      throw new RowError('variantSku', `unknown variant "${data.variantSku}"`);
    }

    const category = data.categorySlug
      ? await tx.category.findFirst({ where: { slug: data.categorySlug }, select: { id: true } })
      : null;
    if (data.categorySlug && !category) {
      throw new RowError('categorySlug', `unknown category "${data.categorySlug}"`);
    }

    if (dryRun) return;

    const payload = {
      scope: data.scope,
      adjustmentType: data.adjustmentType || 'FIXED',
      basis: data.basis || 'BASE',
      priority: data.priority ? Number(data.priority) : 100,
      isActive: csvBoolean(data.isActive) ?? true,
      valuePaise,
      valueBp,
      productId: product?.id ?? null,
      variantId: variant?.id ?? null,
      categoryId: category?.id ?? null,
      startsAt: data.startsAt ? new Date(data.startsAt) : null,
      endsAt: data.endsAt ? new Date(data.endsAt) : null,
    };

    const existing = await tx.priceAdjustment.findFirst({
      where: { name: data.name, scope: payload.scope, deletedAt: null },
      select: { id: true },
    });

    if (existing) {
      await tx.priceAdjustment.update({ where: { id: existing.id }, data: payload });
    } else {
      await tx.priceAdjustment.create({ data: { ...payload, name: data.name } });
    }
  },

  async INVENTORY(row, tx, dryRun) {
    const { data } = row;
    if (!data.variantSku) throw new RowError('variantSku', 'variantSku is required');

    const variant = await tx.productVariant.findFirst({
      where: { sku: data.variantSku, ...notDeleted },
      select: { id: true, stockQty: true },
    });
    if (!variant) throw new RowError('variantSku', `unknown variant "${data.variantSku}"`);

    if (data.stockQty === '' || data.stockQty === undefined) {
      throw new RowError('stockQty', 'stockQty is required');
    }
    const target = Number(data.stockQty);
    if (!Number.isInteger(target) || target < 0) {
      throw new RowError('stockQty', `"${data.stockQty}" is not a valid quantity`);
    }

    if (dryRun) return;

    // Stock only ever moves through the ledger, even during an import.
    await inventoryService.setAbsolute(
      variant.id,
      target,
      { reason: 'CORRECTION' as InventoryReason, note: 'CSV import' },
      { actorType: 'ADMIN', actorId: null },
    );
  },
};

class RowError extends Error {
  constructor(
    readonly column: string,
    message: string,
  ) {
    super(message);
  }
}

export const importService = {
  assertImportAllowed,
  toDto,

  /** Parses and validates a file, writing nothing when `dryRun` is true. */
  async createJob(
    entity: ImportEntity,
    file: { buffer: Buffer; originalName: string },
    dryRun: boolean,
    createdById: string | null,
  ): Promise<ImportJobDto> {
    const rows = parseCsv(file.buffer, entity);

    const job = await prisma.importJob.create({
      data: {
        entity,
        status: 'VALIDATING',
        fileName: file.originalName,
        dryRun,
        totalRows: rows.length,
        createdById,
        startedAt: new Date(),
      },
    });

    return this.run(job.id, rows, entity, dryRun);
  },

  async run(
    jobId: string,
    rows: ParsedRow[],
    entity: ImportEntity,
    dryRun: boolean,
  ): Promise<ImportJobDto> {
    const writer = writers[entity];
    const errors: ImportRowErrorDto[] = [];
    let success = 0;

    for (let start = 0; start < rows.length; start += env.IMPORT_CHUNK_SIZE) {
      const chunk = rows.slice(start, start + env.IMPORT_CHUNK_SIZE);
      const outcomes = await runChunk(chunk, writer, dryRun);

      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.ok) success += 1;
        else if (outcome.error) errors.push(outcome.error);
        else errors.push({ row: chunk[index]!.row, column: null, message: 'Chunk rolled back' });
      }
    }

    const status = dryRun
      ? errors.length > 0
        ? 'FAILED_VALIDATION'
        : 'VALIDATED'
      : errors.length > 0
        ? 'FAILED'
        : 'COMPLETED';

    const job = await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status,
        processedRows: rows.length,
        successRows: success,
        errorRows: errors.length,
        errorsJson: errorsColumn.serialize(errors),
        summaryJson: summaryColumn.serialize({
          total: rows.length,
          success,
          errors: errors.length,
        }),
        finishedAt: new Date(),
      },
    });

    if (!dryRun) await catalogCacheService.invalidateAll();

    return toDto(job);
  },

  /** Re-runs a validated job for real. Re-running a completed job is a safe no-op upsert. */
  async commit(jobId: string, buffer: Buffer): Promise<ImportJobDto> {
    const job = await prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job) throw AppError.notFound('Import job not found', { id: jobId });

    if (job.status !== 'VALIDATED' && job.status !== 'COMPLETED') {
      throw new AppError(
        409,
        'IMPORT_NOT_VALIDATED',
        'Only a job that passed validation can be committed',
        { id: jobId, status: job.status },
      );
    }

    const entity = job.entity as ImportEntity;
    const rows = parseCsv(buffer, entity);

    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'IMPORTING', dryRun: false, startedAt: new Date() },
    });

    return this.run(jobId, rows, entity, false);
  },

  async get(id: string): Promise<ImportJobDto> {
    const job = await prisma.importJob.findUnique({ where: { id } });
    if (!job) throw AppError.notFound('Import job not found', { id });
    return toDto(job);
  },

  async list(query: ImportJobListQuery): Promise<PageResult<ImportJobDto>> {
    const args = {
      where: {
        ...(query.entity ? { entity: query.entity } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
    };

    const [items, total] = await Promise.all([
      prisma.importJob.findMany({ ...args, ...skipTake(query), orderBy: { createdAt: 'desc' } }),
      prisma.importJob.count(args),
    ]);

    return pageResult(items.map(toDto), total, query);
  },
};

/**
 * Runs one chunk inside a transaction. A single bad row aborts the whole chunk, so a product is
 * never written half-way; the failing row is reported and the rest of the file continues.
 */
async function runChunk(
  chunk: ParsedRow[],
  writer: Writer,
  dryRun: boolean,
): Promise<RowOutcome[]> {
  const outcomes: RowOutcome[] = chunk.map(() => ({ ok: false }));

  try {
    await prisma.$transaction(async (tx) => {
      for (const [index, row] of chunk.entries()) {
        try {
          await writer(row, tx, dryRun);
          outcomes[index] = { ok: true };
        } catch (error) {
          outcomes[index] = {
            ok: false,
            error: {
              row: row.row,
              column: error instanceof RowError ? error.column : null,
              message: error instanceof Error ? error.message : 'Unknown error',
            },
          };
          throw error;
        }
      }
    });
  } catch {
    // Rows that had already succeeded inside the aborted transaction are reported as rolled back.
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.ok) {
        outcomes[index] = {
          ok: false,
          error: {
            row: chunk[index]!.row,
            column: null,
            message: 'Rolled back because another row in this chunk failed',
          },
        };
      }
    }
  }

  return outcomes;
}
