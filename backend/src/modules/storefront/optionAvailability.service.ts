import type { OptionAvailabilityDto, OptionValueAvailabilityDto } from '@shared/types/storefront';

import type { ProductForIndex } from '../../repositories/storefront.repository';
import { storefrontRepository } from '../../repositories/storefront.repository';
import { AppError } from '../../utils/AppError';
import { isVariantAvailable } from '../catalog-admin/availability';
import { pricingFacade } from '../pricing/pricing.facade';

/**
 * The PDP option matrix.
 *
 * Built from the variant list, never from the cartesian product of the attributes — a product with
 * 5 colours x 4 fabrics x 3 sizes has 12 variants, not 60 combinations, and this walks the 12.
 * The UI narrows progressively by intersecting `combinations` with whatever is already selected.
 */

export const optionAvailabilityService = {
  async forProduct(
    productId: string,
    selection: { variantId?: string | undefined; optionValueIds?: string[] },
  ): Promise<OptionAvailabilityDto> {
    const product = await storefrontRepository.findDetailById(productId);
    if (!product) throw AppError.notFound('Product not found', { productId });

    return this.build(product, selection);
  },

  async build(
    product: ProductForIndex,
    selection: { variantId?: string | undefined; optionValueIds?: string[] },
  ): Promise<OptionAvailabilityDto> {
    const variants = product.variants.filter((variant) => variant.isActive);
    const defaultVariant = variants.find((variant) => variant.isDefault) ?? variants[0] ?? null;

    const combinations = variants.map((variant) => ({
      variantId: variant.id,
      valueIds: variant.attributeValues.map((link) => link.attributeValueId),
      isInStock: isVariantAvailable(variant, product),
    }));

    /* Price deltas are quoted by the P6 engine, one call for every variant plus the default. */
    const deltas = await this.priceDeltas(product.id, variants, defaultVariant?.id ?? null);

    const byAttribute = new Map<
      string,
      {
        attributeId: string;
        code: string;
        name: string;
        inputType: string;
        values: Map<string, OptionValueAvailabilityDto>;
      }
    >();

    for (const variant of variants) {
      for (const link of variant.attributeValues) {
        const group = byAttribute.get(link.attributeId) ?? {
          attributeId: link.attributeId,
          code: link.attribute.code,
          name: link.attribute.name,
          inputType: link.attribute.inputType,
          values: new Map<string, OptionValueAvailabilityDto>(),
        };
        byAttribute.set(link.attributeId, group);

        const existing = group.values.get(link.attributeValueId);
        const inStock = isVariantAvailable(variant, product);

        if (existing) {
          existing.variantIds.push(variant.id);
          existing.isInStock = existing.isInStock || inStock;
          continue;
        }

        group.values.set(link.attributeValueId, {
          attributeId: link.attributeId,
          attributeCode: link.attribute.code,
          attributeName: link.attribute.name,
          valueId: link.attributeValueId,
          valueCode: link.attributeValue.code,
          label: link.attributeValue.label,
          description: link.attributeValue.description,
          colorHex: link.attributeValue.colorHex,
          swatchMediaId: link.attributeValue.swatchMediaId,
          isAvailable: true,
          isInStock: inStock,
          variantIds: [variant.id],
          priceDeltaPaise: deltas.get(variant.id) ?? null,
        });
      }
    }

    const selected = new Set(selection.optionValueIds ?? []);

    /*
     * Progressive narrowing: a value stays selectable only if at least one variant carries it
     * together with every value already chosen from the OTHER attributes.
     */
    for (const group of byAttribute.values()) {
      const otherSelections = [...selected].filter((valueId) => !group.values.has(valueId));

      for (const value of group.values.values()) {
        value.isAvailable = combinations.some(
          (combination) =>
            combination.valueIds.includes(value.valueId) &&
            otherSelections.every((other) => combination.valueIds.includes(other)),
        );
      }
    }

    const resolved =
      selection.variantId ??
      combinations.find(
        (combination) =>
          selected.size > 0 &&
          combination.valueIds.length === selected.size &&
          combination.valueIds.every((valueId) => selected.has(valueId)),
      )?.variantId ??
      null;

    return {
      productId: product.id,
      attributes: [...byAttribute.values()].map((group) => ({
        attributeId: group.attributeId,
        code: group.code,
        name: group.name,
        inputType: group.inputType,
        values: [...group.values.values()],
      })),
      combinations,
      defaultVariantId: defaultVariant?.id ?? null,
      resolvedVariantId: resolved,
    };
  },

  /** Delta of each variant's resolved unit price against the default variant's. */
  async priceDeltas(
    productId: string,
    variants: { id: string }[],
    defaultVariantId: string | null,
  ): Promise<Map<string, number>> {
    const deltas = new Map<string, number>();
    if (variants.length === 0) return deltas;

    const lines = await pricingFacade.quoteEach({
      items: variants.map((variant) => ({ productId, variantId: variant.id, qty: 1 })),
      channel: 'WEB',
    });

    const byVariant = new Map(
      lines.map((line, index) => [variants[index]!.id, line.unitPricePaise]),
    );

    const base =
      (defaultVariantId ? byVariant.get(defaultVariantId) : undefined) ??
      [...byVariant.values()][0] ??
      0;

    for (const [variantId, price] of byVariant) deltas.set(variantId, price - base);
    return deltas;
  },
};
