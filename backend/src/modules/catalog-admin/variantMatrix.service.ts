import type { VariantMatrixInput } from '@shared/schemas/catalogAdmin';
import type { MatrixCombinationDto, VariantMatrixPreviewDto } from '@shared/types/catalogAdmin';

import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { categoryAttributeService } from '../../services/categoryAttribute.service';
import { AppError } from '../../utils/AppError';

import { catalogCacheService } from './catalogCache.service';
import { stockStatusFor } from './inventory.service';

/**
 * The variant matrix: "this sofa comes in 3 fabrics × 2 sizes × 2 leg finishes".
 *
 * `preview()` is non-destructive and shows exactly what `generate()` would do — which combinations
 * already exist, which are new, and which existing variants would no longer be covered by the
 * chosen selection (orphans). Generation only ever creates the missing rows; it never deletes.
 *
 * SKU pattern tokens: {PRODUCT_SKU}, {ATTR:CODE} (the value code of that attribute) and {INDEX}.
 * Collisions get a numeric suffix, so a pattern that is not unique still produces valid SKUs.
 */

interface ResolvedValue {
  attributeId: string;
  attributeCode: string;
  attributeValueId: string;
  valueCode: string;
  label: string;
}

function cartesian(groups: ResolvedValue[][]): ResolvedValue[][] {
  return groups.reduce<ResolvedValue[][]>(
    (acc, group) => acc.flatMap((combo) => group.map((value) => [...combo, value])),
    [[]],
  );
}

function comboKey(values: ResolvedValue[]): string {
  return values
    .map((value) => `${value.attributeId}:${value.attributeValueId}`)
    .sort()
    .join('|');
}

function renderPattern(
  pattern: string,
  productSku: string,
  values: ResolvedValue[],
  index: number,
): string {
  const byCode = new Map(values.map((value) => [value.attributeCode, value.valueCode]));

  return pattern
    .replace(/\{PRODUCT_SKU\}/g, productSku)
    .replace(/\{INDEX\}/g, String(index + 1).padStart(2, '0'))
    .replace(/\{ATTR:([A-Z0-9_]+)\}/g, (_match, code: string) => byCode.get(code) ?? code)
    .replace(/-{2,}/g, '-')
    .toUpperCase();
}

async function resolveSelection(
  productId: string,
  input: VariantMatrixInput,
): Promise<{ productSku: string; groups: ResolvedValue[][] }> {
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: {
      id: true,
      sku: true,
      isMadeToOrder: true,
      categories: { where: { isPrimary: true }, select: { categoryId: true } },
    },
  });
  if (!product) throw AppError.notFound('Product not found', { productId });

  const primaryCategoryId = product.categories[0]?.categoryId;
  if (!primaryCategoryId) {
    throw AppError.validation('Set a primary category before generating variants', { productId });
  }

  const resolved = await categoryAttributeService.resolveForCategory(primaryCategoryId);
  const byId = new Map(resolved.map((attribute) => [attribute.id, attribute]));

  const groups: ResolvedValue[][] = [];

  for (const attributeId of input.attributeIds) {
    const attribute = byId.get(attributeId);

    if (!attribute) {
      throw AppError.validation(
        'That attribute does not apply to this product’s primary category',
        { attributeId, categoryId: primaryCategoryId },
      );
    }
    if (!attribute.isVariantDefining && !attribute.isVariantDefiningForCategory) {
      throw new AppError(
        422,
        'ATTRIBUTE_NOT_VARIANT_DEFINING',
        `"${attribute.name}" is not a variant-defining attribute`,
        { attributeId },
      );
    }

    const selectedIds = input.selectedValueIdsByAttribute[attributeId] ?? [];
    if (selectedIds.length === 0) {
      throw AppError.validation('Select at least one value for every chosen attribute', {
        attributeId,
      });
    }

    const allowed = new Map(attribute.values.map((value) => [value.id, value]));
    const group: ResolvedValue[] = [];

    for (const valueId of selectedIds) {
      const value = allowed.get(valueId);
      if (!value) {
        throw AppError.validation('That value does not belong to the attribute', {
          attributeId,
          attributeValueId: valueId,
        });
      }
      group.push({
        attributeId,
        attributeCode: attribute.code,
        attributeValueId: value.id,
        valueCode: value.code,
        label: value.label,
      });
    }

    groups.push(group);
  }

  return { productSku: product.sku, groups };
}

export const variantMatrixService = {
  async preview(productId: string, input: VariantMatrixInput): Promise<VariantMatrixPreviewDto> {
    const { productSku, groups } = await resolveSelection(productId, input);

    const total = groups.reduce((product, group) => product * group.length, 1);
    if (total > env.VARIANT_MATRIX_MAX) {
      throw new AppError(
        422,
        'VARIANT_MATRIX_TOO_LARGE',
        `That selection would create ${total} variants; the cap is ${env.VARIANT_MATRIX_MAX}`,
        { total, max: env.VARIANT_MATRIX_MAX },
      );
    }

    const existing = await prisma.productVariant.findMany({
      where: { productId, deletedAt: null },
      include: { attributeValues: true },
    });

    const existingByKey = new Map(
      existing.map((variant) => [
        comboKey(
          variant.attributeValues.map((row) => ({
            attributeId: row.attributeId,
            attributeCode: '',
            attributeValueId: row.attributeValueId,
            valueCode: '',
            label: '',
          })),
        ),
        variant,
      ]),
    );

    const combinations: MatrixCombinationDto[] = cartesian(groups).map((values, index) => {
      const key = comboKey(values);
      const match = existingByKey.get(key);

      return {
        key,
        values: values.map((value) => ({
          attributeId: value.attributeId,
          attributeValueId: value.attributeValueId,
          label: value.label,
        })),
        sku: match?.sku ?? renderPattern(input.skuPattern, productSku, values, index),
        name: values.map((value) => value.label).join(' / '),
        exists: Boolean(match),
        existingVariantId: match?.id ?? null,
      };
    });

    const wantedKeys = new Set(combinations.map((combination) => combination.key));

    return {
      productId,
      total: combinations.length,
      newCount: combinations.filter((combination) => !combination.exists).length,
      existingCount: combinations.filter((combination) => combination.exists).length,
      orphanedVariantIds: [...existingByKey.entries()]
        .filter(([key]) => !wantedKeys.has(key))
        .map(([, variant]) => variant.id),
      combinations,
    };
  },

  /** Creates only the missing combinations, in one transaction. */
  async generate(
    productId: string,
    input: VariantMatrixInput,
  ): Promise<{ created: number; preview: VariantMatrixPreviewDto }> {
    const preview = await this.preview(productId, input);
    const missing = preview.combinations.filter((combination) => !combination.exists);

    if (missing.length === 0) return { created: 0, preview };

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
      select: { basePricePaise: true, isMadeToOrder: true },
    });

    const taken = new Set(
      (await prisma.productVariant.findMany({ select: { sku: true } })).map((row) => row.sku),
    );

    const existingCount = await prisma.productVariant.count({ where: { productId } });

    await prisma.$transaction(async (tx) => {
      for (const [index, combination] of missing.entries()) {
        let sku = combination.sku;
        let suffix = 2;
        while (taken.has(sku)) {
          sku = `${combination.sku}-${suffix}`;
          suffix += 1;
        }
        taken.add(sku);

        await tx.productVariant.create({
          data: {
            productId,
            sku,
            name: input.namePattern ? input.namePattern : combination.name,
            // Real per-option pricing arrives with the Prompt 6 PriceAdjustment engine.
            pricePaise: input.pricingMode === 'FIXED' ? product.basePricePaise : null,
            position: existingCount + index,
            isActive: true,
            isDefault: false,
            stockStatus: stockStatusFor({
              stockQty: 0,
              lowStockThreshold: 0,
              allowBackorder: false,
              isMadeToOrder: product.isMadeToOrder,
            }),
            attributeValues: {
              createMany: {
                data: combination.values.map((value) => ({
                  attributeId: value.attributeId,
                  attributeValueId: value.attributeValueId,
                })),
              },
            },
          },
        });
      }
    });

    await catalogCacheService.invalidateProduct(productId, 'variant-matrix');

    return { created: missing.length, preview: await this.preview(productId, input) };
  },
};
