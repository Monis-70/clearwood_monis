import type { Prisma } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import type { z } from 'zod';

import {
  CATEGORY_KINDS,
  PRICE_ADJUSTMENT_SCOPES,
  PRODUCT_TYPES,
  VISIBILITIES,
  type ImportEntity,
  type InventoryReason,
} from '@shared/enums';
import type { Permission } from '@shared/enums';
import { MAX_CATEGORY_DEPTH, PRICE_ADJUSTMENT_SCOPE_FK } from '@shared/schemas/catalog';
import {
  attributeValueCreateSchema,
  priceAdjustmentCreateSchema,
  type ImportJobListQuery,
} from '@shared/schemas/catalogAdmin';
import type { ImportJobDto, ImportRowErrorDto } from '@shared/types/catalogAdmin';

import { env } from '../../../config/env';
import { prisma } from '../../../config/prisma';
import { notDeleted, pageResult, skipTake, type PageResult } from '../../../repositories/helpers';
import type { RuleTarget } from '../../../repositories/priceSchedule.repository';
import { categoryPathService } from '../../../services/categoryPath.service';
import { AppError } from '../../../utils/AppError';
import { jsonColumn } from '../../../utils/jsonColumn';
import { slugify } from '../../../utils/slug';
import { mark } from '../../../utils/uniqueMark';
import { inventoryService, stockStatusFor } from '../inventory.service';
import { catalogCacheService } from '../catalogCache.service';
import { announcePriceRules } from '../priceAdjustment.admin.service';
import { expandCategorySelection, writeCategoryLinks } from '../product.admin.service';
import { assertCombinationFree, assertVariantOptions } from '../variant.admin.service';
import { combinationKeyOf, type OptionPair } from '../variantOptions';

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

/** Gate for routes that only learn the entity after a lookup: no import grant, no lookup. */
export function assertAnyImportAllowed(granted: readonly string[]): void {
  const allowed = Object.values(IMPORT_PERMISSIONS).some((required) =>
    required.every((permission) => granted.includes(permission)),
  );

  if (!allowed) {
    throw AppError.forbidden('Importing requires an import permission');
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

/**
 * What the rows of one chunk wrote. Collected per chunk and merged into the job's only once the
 * chunk's transaction commits, so a rolled-back chunk announces nothing.
 */
interface Touched {
  productIds: Set<string>;
  categoryIds: Set<string>;
  /** A category was created or moved: the tree changed shape, not only a node's details. */
  categoryTreeChanged: boolean;
  attributeIds: Set<string>;
  /** Stored price rules before and after the write: both reaches are re-priced. */
  priceRules: RuleTarget[];
}

function emptyTouched(): Touched {
  return {
    productIds: new Set(),
    categoryIds: new Set(),
    categoryTreeChanged: false,
    attributeIds: new Set(),
    priceRules: [],
  };
}

function mergeTouched(into: Touched, from: Touched): void {
  for (const id of from.productIds) into.productIds.add(id);
  for (const id of from.categoryIds) into.categoryIds.add(id);
  into.categoryTreeChanged ||= from.categoryTreeChanged;
  for (const id of from.attributeIds) into.attributeIds.add(id);
  into.priceRules.push(...from.priceRules);
}

type Writer = (
  row: ParsedRow,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  dryRun: boolean,
  touched: Touched,
) => Promise<void>;

type Tx = Parameters<Writer>[1];

/**
 * A row's cells. Partial updates: a column the file does not carry leaves the stored value alone,
 * an empty cell in a column it does carry clears a nullable field, and only a new row takes the
 * defaults. Every parse failure is reported against its column.
 */
function cells(data: Record<string, string>) {
  const has = (column: string): boolean => Object.prototype.hasOwnProperty.call(data, column);
  const raw = (column: string): string => data[column] ?? '';
  const guard = <T>(column: string, parse: () => T): T => {
    try {
      return parse();
    } catch (error) {
      throw new RowError(column, error instanceof Error ? error.message : String(error));
    }
  };

  return {
    has,
    filled: (column: string): boolean => raw(column) !== '',
    text: (column: string): string | null => raw(column) || null,
    int(column: string, min = 0): number | null {
      const value = raw(column);
      if (value === '') return null;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < min) {
        throw new RowError(column, `"${value}" is not a whole number of at least ${min}`);
      }
      return parsed;
    },
    bool: (column: string): boolean | null => guard(column, () => csvBoolean(data[column])),
    paise: (column: string): number | null => guard(column, () => csvToPaise(data[column], column)),
    oneOf<T extends string>(column: string, allowed: readonly T[]): T | null {
      const value = raw(column);
      if (value === '') return null;
      if (!(allowed as readonly string[]).includes(value)) {
        throw new RowError(column, `"${value}" is not one of ${allowed.join(', ')}`);
      }
      return value as T;
    },
  };
}

/** Runs an admin-API guard and reports its refusal against a column. */
async function asRowError(column: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (error) {
    if (error instanceof AppError) throw new RowError(column, error.message);
    throw error;
  }
}

async function liveId(
  column: string,
  value: string,
  lookup: Promise<{ id: string } | null>,
): Promise<string> {
  const found = await lookup;
  if (!found) throw new RowError(column, `unknown or deleted "${value}"`);
  return found.id;
}

/** Validated exactly like the admin API; the first issue is reported against its CSV column. */
function parseRow<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  columns: Record<string, string>,
): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data as z.infer<S>;
  const issue = parsed.error.issues[0]!;
  const field = String(issue.path[0] ?? '');
  throw new RowError(columns[field] ?? (field || 'row'), `${field || 'row'}: ${issue.message}`);
}

/**
 * `attributeCodes` / `attributeValueCodes` (pipe-separated, aligned - the export's format) as
 * option pairs. Both empty or both omitted: the variant's options are left as they are.
 */
async function importedOptions(
  tx: Tx,
  data: Record<string, string>,
): Promise<OptionPair[] | undefined> {
  const split = (value: string | undefined) =>
    (value ?? '')
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
  const attributeCodes = split(data.attributeCodes);
  const valueCodes = split(data.attributeValueCodes);

  if (attributeCodes.length === 0 && valueCodes.length === 0) return undefined;
  if (attributeCodes.length !== valueCodes.length) {
    throw new RowError('attributeValueCodes', 'give one value code for every attribute code');
  }

  const attributes = await tx.attribute.findMany({
    where: { code: { in: attributeCodes }, deletedAt: null },
    select: { id: true, code: true },
  });
  const attributeByCode = new Map(attributes.map((attribute) => [attribute.code, attribute.id]));
  const unknown = attributeCodes.filter((code) => !attributeByCode.has(code));
  if (unknown.length > 0) {
    throw new RowError('attributeCodes', `unknown attributes: ${unknown.join(', ')}`);
  }

  const values = await tx.attributeValue.findMany({
    where: {
      deletedAt: null,
      OR: attributeCodes.map((code, index) => ({
        attributeId: attributeByCode.get(code)!,
        code: valueCodes[index]!,
      })),
    },
    select: { id: true, attributeId: true, code: true },
  });
  const valueId = new Map(values.map((value) => [`${value.attributeId}|${value.code}`, value.id]));

  return attributeCodes.map((code, index) => {
    const attributeId = attributeByCode.get(code)!;
    const attributeValueId = valueId.get(`${attributeId}|${valueCodes[index]!}`);
    if (!attributeValueId) {
      throw new RowError('attributeValueCodes', `"${valueCodes[index]}" is not a value of ${code}`);
    }
    return { attributeId, attributeValueId };
  });
}

const writers: Record<ImportEntity, Writer> = {
  async PRODUCT(row, tx, dryRun, touched) {
    const { data } = row;
    const c = cells(data);
    if (!data.sku) throw new RowError('sku', 'sku is required');

    const existing = await tx.product.findFirst({
      where: { sku: data.sku },
      select: { id: true, deletedAt: true },
    });
    if (existing?.deletedAt) {
      throw new RowError('sku', `"${data.sku}" belongs to a deleted product; restore it first`);
    }
    if (!data.name && (!existing || c.has('name'))) {
      throw new RowError('name', 'name is required');
    }

    const productType = c.oneOf('productType', PRODUCT_TYPES);
    const visibility = c.oneOf('visibility', VISIBILITIES);
    const basePricePaise = c.paise('basePriceRupees');
    const compareAtPricePaise = c.paise('compareAtPriceRupees');
    const measures = {
      warrantyMonths: c.int('warrantyMonths'),
      weightGrams: c.int('weightGrams'),
      lengthMm: c.int('lengthMm'),
      widthMm: c.int('widthMm'),
      heightMm: c.int('heightMm'),
    };

    const brand = data.brandSlug
      ? await tx.brand.findFirst({
          where: { slug: data.brandSlug, deletedAt: null },
          select: { id: true },
        })
      : null;
    if (data.brandSlug && !brand) {
      throw new RowError('brandSlug', `unknown brand "${data.brandSlug}"`);
    }

    const taxClass = data.taxClassCode
      ? await tx.taxClass.findFirst({
          where: { code: data.taxClassCode, deletedAt: null },
          select: { id: true },
        })
      : null;
    if (data.taxClassCode && !taxClass) {
      throw new RowError('taxClassCode', `unknown tax class "${data.taxClassCode}"`);
    }

    // The named primary first (else the first listed); a deleted category does not exist.
    const slugs = [
      ...new Set([
        ...(data.primaryCategorySlug ? [data.primaryCategorySlug] : []),
        ...(data.categorySlugs ?? '')
          .split('|')
          .map((slug) => slug.trim())
          .filter(Boolean),
      ]),
    ];
    let categoryIds: string[] = [];
    if (slugs.length > 0) {
      const categories = await tx.category.findMany({
        where: { slug: { in: slugs }, deletedAt: null },
        select: { id: true, slug: true, kind: true },
      });
      const bySlug = new Map(categories.map((category) => [category.slug, category.id]));
      const unknown = slugs.filter((slug) => !bySlug.has(slug));
      if (unknown.length > 0) {
        throw new RowError('categorySlugs', `unknown categories: ${unknown.join(', ')}`);
      }
      const services = categories.filter((category) => category.kind === 'SERVICE');
      if (services.length > 0) {
        throw new RowError(
          'categorySlugs',
          `service categories take enquiries, not products: ${services.map((row) => row.slug).join(', ')}`,
        );
      }
      categoryIds = slugs.map((slug) => bySlug.get(slug)!);
    }

    const slug = existing ? null : slugify(data.slug || data.name!);
    if (slug && (await tx.product.findFirst({ where: { slug }, select: { id: true } }))) {
      throw new RowError('slug', `slug "${slug}" is already in use`);
    }

    if (dryRun) return;

    // Only the columns the file carries; a new product takes the defaults for the rest.
    const fields: Record<string, unknown> = {};
    if (c.has('name')) fields.name = data.name;
    if (productType) fields.productType = productType;
    if (visibility) fields.visibility = visibility;
    if (c.has('brandSlug')) fields.brandId = brand?.id ?? null;
    if (c.has('taxClassCode')) fields.taxClassId = taxClass?.id ?? null;
    if (basePricePaise !== null) fields.basePricePaise = basePricePaise;
    if (c.has('compareAtPriceRupees')) fields.compareAtPricePaise = compareAtPricePaise;
    for (const [column, value] of Object.entries(measures)) {
      if (c.has(column)) fields[column] = value;
    }
    for (const column of [
      'shortDescription',
      'description',
      'seoTitle',
      'seoDescription',
      'searchKeywords',
    ]) {
      if (c.has(column)) fields[column] = c.text(column);
    }

    const productId = existing
      ? (
          await tx.product.update({
            where: { id: existing.id },
            data: { ...fields, version: { increment: 1 } } as Prisma.ProductUncheckedUpdateInput,
            select: { id: true },
          })
        ).id
      : (
          await tx.product.create({
            data: {
              ...fields,
              sku: data.sku,
              name: data.name!,
              slug: slug!,
              productType: productType ?? 'SIMPLE',
              visibility: visibility ?? 'PUBLIC',
              basePricePaise: basePricePaise ?? 0,
              // Imports never publish: a human decides when a product goes live.
              status: 'DRAFT',
            } as Prisma.ProductUncheckedCreateInput,
            select: { id: true },
          })
        ).id;

    if (categoryIds.length > 0) {
      const requested = await expandCategorySelection(categoryIds);
      await writeCategoryLinks(tx, productId, requested, categoryIds[0]!);
    }
    touched.productIds.add(productId);
  },

  async VARIANT(row, tx, dryRun, touched) {
    const { data } = row;
    const c = cells(data);
    if (!data.sku) throw new RowError('sku', 'sku is required');
    if (!data.productSku) throw new RowError('productSku', 'productSku is required');

    const product = await tx.product.findFirst({
      where: { sku: data.productSku, deletedAt: null },
      select: { id: true, isMadeToOrder: true },
    });
    if (!product) throw new RowError('productSku', `unknown product "${data.productSku}"`);

    const existing = await tx.productVariant.findFirst({
      where: { sku: data.sku },
      select: {
        id: true,
        productId: true,
        deletedAt: true,
        stockQty: true,
        lowStockThreshold: true,
        allowBackorder: true,
      },
    });
    if (existing && existing.productId !== product.id) {
      throw new RowError('sku', `"${data.sku}" is a variant of another product`);
    }
    if (existing?.deletedAt) {
      throw new RowError('sku', `"${data.sku}" belongs to a deleted variant`);
    }

    const pricePaise = c.paise('priceRupees');
    const compareAtPricePaise = c.paise('compareAtPriceRupees');
    const position = c.int('position');
    const lowStockThreshold = c.int('lowStockThreshold');
    const isDefault = c.bool('isDefault');
    const isActive = c.bool('isActive');
    const allowBackorder = c.bool('allowBackorder');

    // The same option rules as the admin API: variant-defining, active, one grid per product.
    const pairs = await importedOptions(tx, data);
    if (pairs) {
      await asRowError('attributeValueCodes', async () => {
        await assertVariantOptions(tx, product.id, pairs, existing?.id);
        await assertCombinationFree(tx, product.id, combinationKeyOf(pairs), existing?.id);
      });
    }

    if (dryRun) return;

    const fields: Record<string, unknown> = {};
    if (c.has('name')) fields.name = c.text('name');
    if (c.has('priceRupees')) fields.pricePaise = pricePaise;
    if (c.has('compareAtPriceRupees')) fields.compareAtPricePaise = compareAtPricePaise;
    if (c.has('barcode')) fields.barcode = c.text('barcode');
    if (position !== null) fields.position = position;
    if (isActive !== null) fields.isActive = isActive;
    if (lowStockThreshold !== null) fields.lowStockThreshold = lowStockThreshold;
    if (allowBackorder !== null) fields.allowBackorder = allowBackorder;
    if (isDefault !== null) {
      fields.isDefault = isDefault;
      fields.defaultMark = mark(isDefault);
    }
    if (pairs) fields.combinationKey = combinationKeyOf(pairs);
    fields.stockStatus = stockStatusFor({
      stockQty: existing?.stockQty ?? 0,
      lowStockThreshold: lowStockThreshold ?? existing?.lowStockThreshold ?? 0,
      allowBackorder: allowBackorder ?? existing?.allowBackorder ?? false,
      isMadeToOrder: product.isMadeToOrder,
    });

    // An imported default replaces the product's current one rather than joining it.
    if (isDefault) {
      await tx.productVariant.updateMany({
        where: {
          productId: product.id,
          defaultMark: true,
          ...(existing ? { id: { not: existing.id } } : {}),
        },
        data: { isDefault: false, defaultMark: null },
      });
    }

    const variantId = existing
      ? (
          await tx.productVariant.update({
            where: { id: existing.id },
            data: {
              ...fields,
              version: { increment: 1 },
            } as Prisma.ProductVariantUncheckedUpdateInput,
            select: { id: true },
          })
        ).id
      : (
          await tx.productVariant.create({
            data: {
              isDefault: false,
              defaultMark: null,
              ...fields,
              sku: data.sku,
              productId: product.id,
            } as Prisma.ProductVariantUncheckedCreateInput,
            select: { id: true },
          })
        ).id;

    if (pairs) {
      await tx.variantAttributeValue.deleteMany({ where: { variantId } });
      if (pairs.length > 0) {
        await tx.variantAttributeValue.createMany({
          data: pairs.map((pair) => ({ variantId, ...pair })),
        });
      }
    }
    touched.productIds.add(product.id);
  },

  async CATEGORY(row, tx, dryRun, touched) {
    const { data } = row;
    const c = cells(data);
    if (!data.slug) throw new RowError('slug', 'slug is required');

    const slug = slugify(data.slug);
    const existing = await tx.category.findFirst({
      where: { slug },
      select: {
        id: true,
        parentId: true,
        path: true,
        depth: true,
        kind: true,
        deletedAt: true,
      },
    });
    if (existing?.deletedAt) {
      throw new RowError('slug', `"${slug}" belongs to a deleted category; restore it first`);
    }
    if (!data.name && (!existing || c.has('name'))) {
      throw new RowError('name', 'name is required');
    }

    const kind = c.oneOf('kind', CATEGORY_KINDS);
    const position = c.int('position');
    const isActive = c.bool('isActive');
    const showInMenu = c.bool('showInMenu');

    if (kind === 'SERVICE' && existing && existing.kind !== 'SERVICE') {
      const products = await tx.productCategory.count({
        where: { categoryId: existing.id, product: { deletedAt: null } },
      });
      if (products > 0) {
        throw new RowError('kind', `"${slug}" still holds ${products} products`);
      }
    }

    // An empty parentSlug is a root; an omitted column leaves an existing category where it is.
    const placing = !existing || c.has('parentSlug');
    const parent = data.parentSlug
      ? await tx.category.findFirst({
          where: { slug: data.parentSlug, deletedAt: null },
          select: { id: true, path: true, depth: true },
        })
      : null;
    if (data.parentSlug && !parent) {
      throw new RowError('parentSlug', `unknown parent "${data.parentSlug}"`);
    }

    const moving = placing && (!existing || existing.parentId !== (parent?.id ?? null));
    const path = categoryPathService.buildPath(parent?.path ?? null, slug);
    const depth = categoryPathService.depthFor(parent?.depth ?? null);

    if (moving) {
      if (
        existing &&
        parent &&
        (parent.id === existing.id || parent.path.startsWith(`${existing.path}/`))
      ) {
        throw new RowError('parentSlug', 'a category cannot move under itself or a descendant');
      }
      const deepest = existing
        ? await tx.category.findFirst({
            where: { path: { startsWith: `${existing.path}/` } },
            orderBy: { depth: 'desc' },
            select: { depth: true },
          })
        : null;
      const lowest = deepest ? deepest.depth + (depth - existing!.depth) : depth;
      if (lowest > MAX_CATEGORY_DEPTH) {
        throw new RowError(
          'parentSlug',
          `the tree would reach depth ${lowest}; the cap is ${MAX_CATEGORY_DEPTH}`,
        );
      }
    }

    if (dryRun) return;

    const fields: Record<string, unknown> = {};
    if (c.has('name')) fields.name = data.name;
    if (kind) fields.kind = kind;
    if (position !== null) fields.position = position;
    if (isActive !== null) fields.isActive = isActive;
    if (showInMenu !== null) fields.showInMenu = showInMenu;
    for (const column of ['shortDescription', 'seoTitle', 'seoDescription']) {
      if (c.has(column)) fields[column] = c.text(column);
    }
    if (moving) Object.assign(fields, { parentId: parent?.id ?? null, path, depth });

    if (!existing) {
      const created = await tx.category.create({
        data: {
          kind: 'STANDARD',
          position: 0,
          isActive: true,
          showInMenu: true,
          ...fields,
          name: data.name!,
          slug,
        } as Prisma.CategoryUncheckedCreateInput,
        select: { id: true },
      });
      touched.categoryIds.add(created.id);
      touched.categoryTreeChanged = true;
      return;
    }

    await tx.category.update({
      where: { id: existing.id },
      data: { ...fields, version: { increment: 1 } } as Prisma.CategoryUncheckedUpdateInput,
    });
    touched.categoryIds.add(existing.id);
    if (moving) touched.categoryTreeChanged = true;

    // The subtree follows its root: every descendant's path and depth move with it.
    if (moving) {
      const shift = depth - existing.depth;
      const descendants = await tx.category.findMany({
        where: { path: { startsWith: `${existing.path}/` } },
        select: { id: true, path: true, depth: true },
      });
      for (const descendant of descendants) {
        await tx.category.update({
          where: { id: descendant.id },
          data: {
            path: `${path}${descendant.path.slice(existing.path.length)}`,
            depth: descendant.depth + shift,
          },
        });
      }
    }
  },

  async ATTRIBUTE_VALUE(row, tx, dryRun, touched) {
    const { data } = row;
    const c = cells(data);
    if (!data.attributeCode) throw new RowError('attributeCode', 'attributeCode is required');
    if (!data.code) throw new RowError('code', 'code is required');

    const attribute = await tx.attribute.findFirst({
      where: { code: data.attributeCode, deletedAt: null },
      select: { id: true },
    });
    if (!attribute) {
      throw new RowError('attributeCode', `unknown attribute "${data.attributeCode}"`);
    }

    const existing = await tx.attributeValue.findUnique({
      where: { attributeId_code: { attributeId: attribute.id, code: data.code } },
    });
    if (existing?.deletedAt) {
      throw new RowError('code', `"${data.code}" is a deleted value; restore it first`);
    }

    // The admin API's rules, applied to the stored row with the file's columns on top.
    const input: Record<string, unknown> = existing
      ? {
          label: existing.label,
          description: existing.description,
          position: existing.position,
          colorHex: existing.colorHex,
          isActive: existing.isActive,
        }
      : { code: data.code, label: data.label || data.code };
    if (c.filled('label')) input.label = data.label;
    if (c.has('description')) input.description = c.text('description');
    if (c.filled('position')) input.position = c.int('position');
    if (c.has('colorHex')) input.colorHex = c.text('colorHex');
    const isActive = c.bool('isActive');
    if (isActive !== null) input.isActive = isActive;

    const schema = existing
      ? attributeValueCreateSchema.omit({ code: true })
      : attributeValueCreateSchema;
    const value = parseRow(schema, input, { label: 'label' });

    if (dryRun) return;

    const fields = {
      label: value.label,
      description: value.description ?? null,
      position: value.position,
      colorHex: value.colorHex ?? null,
      isActive: value.isActive,
    };
    if (existing) {
      await tx.attributeValue.update({
        where: { id: existing.id },
        data: { ...fields, version: { increment: 1 } },
      });
    } else {
      await tx.attributeValue.create({
        data: { ...fields, attributeId: attribute.id, code: data.code },
      });
    }
    touched.attributeIds.add(attribute.id);
  },

  async PRICE_ADJUSTMENT(row, tx, dryRun, touched) {
    const { data } = row;
    const c = cells(data);
    if (!data.name) throw new RowError('name', 'name is required');
    const scope = c.oneOf('scope', PRICE_ADJUSTMENT_SCOPES);
    if (!scope) throw new RowError('scope', 'scope is required');

    const existing = await tx.priceAdjustment.findFirst({
      where: { name: data.name, scope, deletedAt: null },
    });

    // The stored rule with the file's columns on top, validated like an admin create.
    const input: Record<string, unknown> = existing
      ? {
          name: existing.name,
          scope: existing.scope,
          adjustmentType: existing.adjustmentType,
          basis: existing.basis,
          priority: existing.priority,
          isActive: existing.isActive,
          valuePaise: existing.valuePaise,
          valueBp: existing.valueBp,
          categoryId: existing.categoryId,
          productId: existing.productId,
          variantId: existing.variantId,
          attributeId: existing.attributeId,
          attributeValueId: existing.attributeValueId,
          minQty: existing.minQty,
          maxQty: existing.maxQty,
          startsAt: existing.startsAt,
          endsAt: existing.endsAt,
          note: existing.note,
        }
      : { name: data.name, scope };

    if (c.filled('adjustmentType')) input.adjustmentType = data.adjustmentType;
    if (c.filled('basis')) input.basis = data.basis;
    if (c.filled('priority')) input.priority = c.int('priority');
    const isActive = c.bool('isActive');
    if (isActive !== null) input.isActive = isActive;
    if (c.has('valueRupees')) input.valuePaise = c.paise('valueRupees');
    if (c.has('valueBp')) input.valueBp = c.int('valueBp', -1_000_000);
    if (c.has('startsAt')) input.startsAt = c.text('startsAt');
    if (c.has('endsAt')) input.endsAt = c.text('endsAt');

    if (c.has('productSku')) {
      input.productId = data.productSku
        ? await liveId(
            'productSku',
            data.productSku,
            tx.product.findFirst({
              where: { sku: data.productSku, deletedAt: null },
              select: { id: true },
            }),
          )
        : null;
    }
    if (c.has('variantSku')) {
      input.variantId = data.variantSku
        ? await liveId(
            'variantSku',
            data.variantSku,
            tx.productVariant.findFirst({
              where: { sku: data.variantSku, deletedAt: null },
              select: { id: true },
            }),
          )
        : null;
    }
    if (c.has('categorySlug')) {
      input.categoryId = data.categorySlug
        ? await liveId(
            'categorySlug',
            data.categorySlug,
            tx.category.findFirst({
              where: { slug: data.categorySlug, deletedAt: null },
              select: { id: true },
            }),
          )
        : null;
    }
    if (c.has('attributeValueCode')) {
      const values = data.attributeValueCode
        ? await tx.attributeValue.findMany({
            where: { code: data.attributeValueCode, deletedAt: null },
            select: { id: true, attributeId: true },
            take: 2,
          })
        : [];
      if (data.attributeValueCode && values.length !== 1) {
        throw new RowError(
          'attributeValueCode',
          values.length === 0
            ? `unknown attribute value "${data.attributeValueCode}"`
            : `"${data.attributeValueCode}" names values of several attributes`,
        );
      }
      input.attributeValueId = values[0]?.id ?? null;
      input.attributeId = values[0]?.attributeId ?? null;
    }

    const rule = parseRow(priceAdjustmentCreateSchema, input, {
      valuePaise: 'valueRupees',
      productId: 'productSku',
      variantId: 'variantSku',
      categoryId: 'categorySlug',
      attributeValueId: 'attributeValueCode',
    });
    const target = PRICE_ADJUSTMENT_SCOPE_FK[rule.scope as keyof typeof PRICE_ADJUSTMENT_SCOPE_FK];
    if (target && !rule[target as keyof typeof rule]) {
      throw new RowError('scope', `a ${rule.scope} rule needs ${target}`);
    }

    if (dryRun) return;

    const fields = {
      scope: rule.scope,
      adjustmentType: rule.adjustmentType,
      basis: rule.basis,
      priority: rule.priority,
      isActive: rule.isActive,
      valuePaise: rule.valuePaise ?? null,
      valueBp: rule.valueBp ?? null,
      categoryId: rule.categoryId ?? null,
      productId: rule.productId ?? null,
      variantId: rule.variantId ?? null,
      attributeId: rule.attributeId ?? null,
      attributeValueId: rule.attributeValueId ?? null,
      minQty: rule.minQty ?? null,
      maxQty: rule.maxQty ?? null,
      startsAt: rule.startsAt ?? null,
      endsAt: rule.endsAt ?? null,
      note: rule.note ?? null,
    };

    if (existing) {
      const updated = await tx.priceAdjustment.update({
        where: { id: existing.id },
        data: { ...fields, version: { increment: 1 } },
      });
      touched.priceRules.push(existing, updated);
    } else {
      touched.priceRules.push(
        await tx.priceAdjustment.create({ data: { ...fields, name: data.name } }),
      );
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

/**
 * Rows are written straight through Prisma, so nothing else learns of them. Invalidation is scoped
 * to what the committed rows touched - never every cache in the system:
 *  - PRODUCT / VARIANT: the product caches once, then exactly those products are re-priced and
 *    re-indexed (their category links may have moved, so counts are recounted by that event);
 *  - CATEGORY: those nodes (the whole tree when one was created or moved), their subtrees'
 *    products re-indexed;
 *  - ATTRIBUTE_VALUE: each attribute whose values changed, its products re-indexed;
 *  - PRICE_ADJUSTMENT: the reach of every rule before and after, as the admin API does;
 *  - INVENTORY goes through InventoryService, which announces every movement itself.
 */
async function announceImport(entity: ImportEntity, touched: Touched): Promise<void> {
  switch (entity) {
    case 'PRODUCT':
    case 'VARIANT':
      await catalogCacheService.invalidateProducts(
        [...touched.productIds],
        `import-${entity.toLowerCase()}`,
      );
      return;
    case 'CATEGORY':
      // As the admin API does: a created or moved node changes the tree (and which products a
      // CATEGORY price rule reaches); a rename or a flag only that node's details.
      if (touched.categoryTreeChanged) {
        await catalogCacheService.invalidateCategoryTree([...touched.categoryIds]);
      } else if (touched.categoryIds.size > 0) {
        await catalogCacheService.invalidateCategory([...touched.categoryIds]);
      }
      return;
    case 'ATTRIBUTE_VALUE':
      for (const attributeId of touched.attributeIds) {
        await catalogCacheService.invalidateAttributes(attributeId);
      }
      return;
    case 'PRICE_ADJUSTMENT':
      if (touched.priceRules.length > 0) await announcePriceRules(...touched.priceRules);
      return;
    default:
      return;
  }
}

export const importService = {
  assertImportAllowed,
  assertAnyImportAllowed,
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
    const touched = emptyTouched();
    let success = 0;

    for (let start = 0; start < rows.length; start += env.IMPORT_CHUNK_SIZE) {
      const chunk = rows.slice(start, start + env.IMPORT_CHUNK_SIZE);
      const outcomes = await runChunk(chunk, writer, dryRun, touched);

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

    if (!dryRun) await announceImport(entity, touched);

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
      prisma.importJob.findMany({
        ...args,
        ...skipTake(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
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
  touched: Touched,
): Promise<RowOutcome[]> {
  const outcomes: RowOutcome[] = chunk.map(() => ({ ok: false }));
  const written = emptyTouched();

  try {
    await prisma.$transaction(async (tx) => {
      for (const [index, row] of chunk.entries()) {
        try {
          await writer(row, tx, dryRun, written);
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
    // Committed: only now does what the chunk wrote become something to announce.
    mergeTouched(touched, written);
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
