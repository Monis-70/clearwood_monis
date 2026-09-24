import type { StockStatus } from '@shared/enums';

import { combinationKeyOf } from '../../src/modules/catalog-admin/variantOptions';
import { mark } from '../../src/utils/uniqueMark';

import { DEMO_PRICE_ADJUSTMENTS, DEMO_PRODUCTS, type SeedProduct } from './data/demoProducts';
import { log, prisma } from './context';
import { ensureSeedMedia } from './media-assets';

/**
 * Runs only when SEED_DEMO is on (default: development). Every product exercises a different part
 * of the schema — multi-category membership, variant matrices, non-variant specs, colour- and
 * variant-specific media, and price adjustments across four scopes.
 */

const FALLBACK_HEX = '#E3DACE';
const PUBLISHED_FROM = Date.UTC(2026, 0, 15);

interface ValueRef {
  attributeId: string;
  valueId: string;
  label: string;
  colorHex: string | null;
}

function stockStatusFor(product: SeedProduct, stockQty: number): StockStatus {
  if (product.isMadeToOrder) return 'MADE_TO_ORDER';
  if (stockQty <= 0) return 'OUT_OF_STOCK';
  if (stockQty <= 2) return 'LOW_STOCK';
  return 'IN_STOCK';
}

export async function seedDemoCatalog(): Promise<void> {
  const taxClasses = new Map(
    (await prisma.taxClass.findMany({ select: { id: true, code: true } })).map((row) => [
      row.code,
      row.id,
    ]),
  );
  const categoryIds = new Map(
    (await prisma.category.findMany({ select: { id: true, slug: true } })).map((row) => [
      row.slug,
      row.id,
    ]),
  );

  const attributeValues = new Map<string, ValueRef>();
  for (const attribute of await prisma.attribute.findMany({
    select: {
      id: true,
      code: true,
      values: { select: { id: true, code: true, label: true, colorHex: true } },
    },
  })) {
    for (const value of attribute.values) {
      attributeValues.set(`${attribute.code}:${value.code}`, {
        attributeId: attribute.id,
        valueId: value.id,
        label: value.label,
        colorHex: value.colorHex,
      });
    }
  }

  const requireValue = (attributeCode: string, valueCode: string): ValueRef => {
    const ref = attributeValues.get(`${attributeCode}:${valueCode}`);
    if (!ref) throw new Error(`Unknown attribute value ${attributeCode}:${valueCode}`);
    return ref;
  };

  let variantCount = 0;
  let mediaCount = 0;

  for (const [index, product] of DEMO_PRODUCTS.entries()) {
    const taxClassId = taxClasses.get(product.taxClassCode) ?? null;

    const row = await prisma.product.upsert({
      where: { sku: product.sku },
      // Content (name, copy, prices) is preserved; only lifecycle fields are synced.
      update: { status: 'ACTIVE', position: index + 1, taxClassId, deletedAt: null },
      create: {
        sku: product.sku,
        slug: product.slug,
        name: product.name,
        subtitle: product.subtitle,
        shortDescription: product.shortDescription,
        description: product.description,
        productType: product.productType,
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        taxClassId,
        basePricePaise: product.basePricePaise,
        compareAtPricePaise: product.compareAtPricePaise ?? null,
        isMadeToOrder: product.isMadeToOrder ?? false,
        leadTimeDays: product.leadTimeDays ?? null,
        allowCustomization: product.allowCustomization ?? false,
        manufacturingNote: product.manufacturingNote ?? null,
        warrantyMonths: product.warrantyMonths ?? null,
        careInstructions: product.careInstructions ?? null,
        assemblyRequired: product.assemblyRequired ?? false,
        weightGrams: product.weightGrams ?? null,
        lengthMm: product.lengthMm ?? null,
        widthMm: product.widthMm ?? null,
        heightMm: product.heightMm ?? null,
        seatHeightMm: product.seatHeightMm ?? null,
        isFeatured: product.isFeatured ?? false,
        isNewArrival: product.isNewArrival ?? false,
        isSpecialCollection: product.isSpecialCollection ?? false,
        isBestSeller: product.isBestSeller ?? false,
        ratingAvgBp: product.ratingAvgBp ?? 0,
        ratingCount: product.ratingCount ?? 0,
        soldCount: product.soldCount ?? 0,
        position: index + 1,
        publishedAt: new Date(PUBLISHED_FROM + index * 86_400_000),
        seoTitle: `${product.name} | ClearWood Furnitures`,
        seoDescription: product.shortDescription,
        searchKeywords: [product.name, product.subtitle].join(' ').toLowerCase(),
      },
    });

    for (const [categoryIndex, slug] of product.categories.entries()) {
      const categoryId = categoryIds.get(slug);
      if (!categoryId)
        throw new Error(`Product ${product.sku} references unknown category ${slug}`);

      await prisma.productCategory.upsert({
        where: { productId_categoryId: { productId: row.id, categoryId } },
        update: {
          isPrimary: categoryIndex === 0,
          primaryMark: mark(categoryIndex === 0),
          position: categoryIndex + 1,
        },
        create: {
          productId: row.id,
          categoryId,
          isPrimary: categoryIndex === 0,
          primaryMark: mark(categoryIndex === 0),
          position: categoryIndex + 1,
        },
      });
    }

    for (const [specIndex, spec] of product.specs.entries()) {
      const ref = requireValue(spec.attribute, spec.value);
      const existing = await prisma.productAttributeValue.findFirst({
        where: { productId: row.id, attributeId: ref.attributeId, attributeValueId: ref.valueId },
        select: { id: true },
      });

      if (existing) {
        await prisma.productAttributeValue.update({
          where: { id: existing.id },
          data: { position: specIndex + 1 },
        });
      } else {
        await prisma.productAttributeValue.create({
          data: {
            productId: row.id,
            attributeId: ref.attributeId,
            attributeValueId: ref.valueId,
            position: specIndex + 1,
          },
        });
      }
    }

    const variantIds = new Map<string, string>();

    for (const [variantIndex, variant] of product.variants.entries()) {
      const sku = `${product.sku}-${variant.suffix}`;

      // Prompt 5 made InventoryService the only writer of stockQty, so the fixture quantity is
      // applied by seed/14-inventory as an opening ledger entry instead of being set here.
      const variantRow = await prisma.productVariant.upsert({
        where: { sku },
        update: {
          position: variantIndex + 1,
          isDefault: variant.isDefault ?? false,
          defaultMark: mark(variant.isDefault ?? false),
          isActive: true,
          deletedAt: null,
        },
        create: {
          productId: row.id,
          sku,
          name: Object.values(variant.attributes).join(' / '),
          pricePaise: variant.pricePaise ?? null,
          position: variantIndex + 1,
          isDefault: variant.isDefault ?? false,
          defaultMark: mark(variant.isDefault ?? false),
          stockStatus: stockStatusFor(product, variant.stockQty ?? 0),
          lowStockThreshold: 2,
          leadTimeDays: variant.leadTimeDays ?? product.leadTimeDays ?? null,
        },
      });
      variantIds.set(variant.suffix, variantRow.id);
      variantCount += 1;

      const options = Object.entries(variant.attributes).map(([attributeCode, valueCode]) => {
        const ref = requireValue(attributeCode, valueCode);
        return { attributeId: ref.attributeId, attributeValueId: ref.valueId };
      });

      for (const option of options) {
        await prisma.variantAttributeValue.upsert({
          where: {
            variantId_attributeId: { variantId: variantRow.id, attributeId: option.attributeId },
          },
          update: { attributeValueId: option.attributeValueId },
          create: { variantId: variantRow.id, ...option },
        });
      }

      await prisma.productVariant.update({
        where: { id: variantRow.id },
        data: { combinationKey: combinationKeyOf(options) },
      });
    }

    const firstVariant = product.variants[0];
    const swatchCode = product.variantAttributes[0];
    const swatchRef = requireValue(swatchCode, firstVariant.attributes[swatchCode]);
    const hex = swatchRef.colorHex ?? FALLBACK_HEX;

    const mediaPlan = [
      { suffix: '01', role: 'PRIMARY', caption: product.subtitle, deviceTarget: 'ALL' },
      { suffix: '02', role: 'HOVER', caption: 'Detail view', deviceTarget: 'ALL' },
      { suffix: '03', role: 'GALLERY', caption: 'In the workshop', deviceTarget: 'ALL' },
      {
        suffix: '04',
        role: 'GALLERY',
        caption: `${swatchRef.label} close-up`,
        deviceTarget: 'ALL',
        attributeValueId: swatchRef.valueId,
      },
      {
        suffix: '05',
        role: 'GALLERY',
        caption: `${firstVariant.suffix} as built`,
        deviceTarget: 'ALL',
        variantId: variantIds.get(firstVariant.suffix),
      },
      { suffix: '06', role: 'LIFESTYLE', caption: 'Styled at home', deviceTarget: 'MOBILE' },
    ] as const;

    for (const [mediaIndex, plan] of mediaPlan.entries()) {
      const media = await ensureSeedMedia({
        key: `${product.slug}-${plan.suffix}`,
        label: product.name,
        caption: plan.caption,
        hex,
        width: plan.deviceTarget === 'MOBILE' ? 800 : 1200,
        height: plan.deviceTarget === 'MOBILE' ? 1000 : 900,
        altText: `${product.name} — ${plan.caption}`,
      });

      const existing = await prisma.productMedia.findFirst({
        where: { productId: row.id, mediaId: media.id },
        select: { id: true },
      });

      const data = {
        role: plan.role,
        primaryMark: mark(plan.role === 'PRIMARY'),
        position: mediaIndex + 1,
        deviceTarget: plan.deviceTarget,
        attributeValueId: 'attributeValueId' in plan ? plan.attributeValueId : null,
        variantId: 'variantId' in plan ? (plan.variantId ?? null) : null,
      };

      if (existing) {
        await prisma.productMedia.update({ where: { id: existing.id }, data });
      } else {
        await prisma.productMedia.create({
          data: { productId: row.id, mediaId: media.id, altText: media.altText, ...data },
        });
      }
      mediaCount += 1;
    }
  }

  await seedPriceAdjustments(categoryIds, requireValue);

  log(
    'demo-catalog',
    `${DEMO_PRODUCTS.length} products, ${variantCount} variants, ${mediaCount} media links upserted`,
  );
}

async function seedPriceAdjustments(
  categoryIds: Map<string, string>,
  requireValue: (attributeCode: string, valueCode: string) => ValueRef,
): Promise<void> {
  for (const rule of DEMO_PRICE_ADJUSTMENTS) {
    const attributeRef =
      rule.attributeCode && rule.attributeValueCode
        ? requireValue(rule.attributeCode, rule.attributeValueCode)
        : null;

    const product = rule.productSlug
      ? await prisma.product.findUnique({ where: { slug: rule.productSlug }, select: { id: true } })
      : null;
    const variant = rule.variantSku
      ? await prisma.productVariant.findUnique({
          where: { sku: rule.variantSku },
          select: { id: true },
        })
      : null;

    const data = {
      scope: rule.scope,
      adjustmentType: rule.adjustmentType,
      basis: rule.basis ?? 'BASE',
      priority: rule.priority,
      valuePaise: rule.valuePaise ?? null,
      valueBp: rule.valueBp ?? null,
      categoryId: rule.categorySlug ? (categoryIds.get(rule.categorySlug) ?? null) : null,
      productId: product?.id ?? null,
      variantId: variant?.id ?? null,
      attributeId: attributeRef?.attributeId ?? null,
      attributeValueId: attributeRef?.valueId ?? null,
      startsAt: rule.startsAt ? new Date(rule.startsAt) : null,
      endsAt: rule.endsAt ? new Date(rule.endsAt) : null,
      isActive: true,
      deletedAt: null,
    };

    const existing = await prisma.priceAdjustment.findFirst({
      where: { name: rule.name },
      select: { id: true },
    });

    if (existing) {
      await prisma.priceAdjustment.update({ where: { id: existing.id }, data });
    } else {
      await prisma.priceAdjustment.create({
        data: { name: rule.name, note: rule.note ?? null, ...data },
      });
    }
  }

  log('demo-catalog', `${DEMO_PRICE_ADJUSTMENTS.length} price adjustments upserted`);
}
