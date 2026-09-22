import type { Attribute, AttributeGroup, AttributeValue } from '@prisma/client';

import type {
  AdminAttributeListQuery,
  AttributeCreateInput,
  AttributeGroupCreateInput,
  AttributeGroupUpdateInput,
  AttributeUpdateInput,
  AttributeValueCreateInput,
  AttributeValueUpdateInput,
  CategoryAttributeUpsertInput,
  ReorderInput,
} from '@shared/schemas/catalogAdmin';

import { prisma } from '../../config/prisma';
import { notDeleted, pageResult, skipTake, type PageResult } from '../../repositories/helpers';
import { updateVersioned } from '../../repositories/versioned';
import { AppError } from '../../utils/AppError';
import { mediaUsageService } from '../media/media-usage.service';

import { catalogCacheService } from './catalogCache.service';

/**
 * Attribute dictionary administration.
 *
 * The hard rule here is referential honesty: an attribute or value that is already describing a
 * product, a variant, a price rule or a colour-specific image may not be deleted, and an attribute
 * that variants are built on may not stop being variant-defining. Both refusals report exactly what
 * is referencing them so the admin can act.
 */

type AttributeWithValues = Attribute & { values: AttributeValue[] };

async function attributeUsage(attributeId: string): Promise<Record<string, number>> {
  const [variants, products, priceAdjustments, categories] = await Promise.all([
    prisma.variantAttributeValue.count({ where: { attributeId } }),
    prisma.productAttributeValue.count({ where: { attributeId } }),
    prisma.priceAdjustment.count({ where: { attributeId, deletedAt: null } }),
    prisma.categoryAttribute.count({ where: { attributeId } }),
  ]);
  return { variants, products, priceAdjustments, categories };
}

async function valueUsage(attributeValueId: string): Promise<Record<string, number>> {
  const [variants, products, priceAdjustments, productMedia] = await Promise.all([
    prisma.variantAttributeValue.count({ where: { attributeValueId } }),
    prisma.productAttributeValue.count({ where: { attributeValueId } }),
    prisma.priceAdjustment.count({ where: { attributeValueId, deletedAt: null } }),
    prisma.productMedia.count({ where: { attributeValueId } }),
  ]);
  return { variants, products, priceAdjustments, productMedia };
}

function totalUsage(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

export const attributeAdminService = {
  /* ------------------------------------------------------------- groups */

  listGroups(): Promise<AttributeGroup[]> {
    return prisma.attributeGroup.findMany({ orderBy: [{ position: 'asc' }, { name: 'asc' }] });
  },

  async createGroup(input: AttributeGroupCreateInput): Promise<AttributeGroup> {
    const clash = await prisma.attributeGroup.count({ where: { code: input.code } });
    if (clash > 0)
      throw AppError.conflict('That group code is already in use', { code: input.code });

    const group = await prisma.attributeGroup.create({ data: input });
    await catalogCacheService.invalidateAttributes();
    return group;
  },

  async updateGroup(id: string, input: AttributeGroupUpdateInput): Promise<AttributeGroup> {
    const group = await prisma.attributeGroup.update({ where: { id }, data: input });
    await catalogCacheService.invalidateAttributes();
    return group;
  },

  async removeGroup(id: string): Promise<void> {
    const attached = await prisma.attribute.count({ where: { groupId: id, ...notDeleted } });
    if (attached > 0) {
      throw new AppError(409, 'ATTRIBUTE_GROUP_IN_USE', 'This group still has attributes', {
        id,
        attributes: attached,
      });
    }
    await prisma.attributeGroup.delete({ where: { id } });
    await catalogCacheService.invalidateAttributes();
  },

  /* --------------------------------------------------------- attributes */

  async list(query: AdminAttributeListQuery): Promise<PageResult<AttributeWithValues>> {
    const args = {
      where: {
        ...notDeleted,
        ...(query.includeInactive ? {} : { isActive: true }),
        ...(query.groupId ? { groupId: query.groupId } : {}),
        ...(query.isVariantDefining === undefined
          ? {}
          : { isVariantDefining: query.isVariantDefining }),
        ...(query.isFilterable === undefined ? {} : { isFilterable: query.isFilterable }),
        ...(query.q
          ? { OR: [{ name: { contains: query.q } }, { code: { contains: query.q } }] }
          : {}),
      },
    };

    const [items, total] = await Promise.all([
      prisma.attribute.findMany({
        ...args,
        ...skipTake(query),
        include: { values: { where: notDeleted, orderBy: { position: 'asc' } } },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
      }),
      prisma.attribute.count(args),
    ]);

    return pageResult(items, total, query);
  },

  async get(id: string): Promise<AttributeWithValues> {
    const attribute = await prisma.attribute.findFirst({
      where: { id, ...notDeleted },
      include: { values: { where: notDeleted, orderBy: { position: 'asc' } } },
    });
    if (!attribute) throw AppError.notFound('Attribute not found', { id });
    return attribute;
  },

  async create(input: AttributeCreateInput): Promise<AttributeWithValues> {
    const clash = await prisma.attribute.count({ where: { code: input.code } });
    if (clash > 0)
      throw AppError.conflict('That attribute code is already in use', { code: input.code });

    const created = await prisma.attribute.create({
      data: {
        ...input,
        groupId: input.groupId ?? null,
        unit: input.unit ?? null,
        helpText: input.helpText ?? null,
      },
      select: { id: true },
    });

    await catalogCacheService.invalidateAttributes();
    return this.get(created.id);
  },

  async update(id: string, input: AttributeUpdateInput): Promise<AttributeWithValues> {
    const existing = await this.get(id);
    const { version, ...rest } = input;

    if (
      rest.isVariantDefining !== undefined &&
      rest.isVariantDefining !== existing.isVariantDefining
    ) {
      const usage = await attributeUsage(id);
      if (usage.variants > 0) {
        throw new AppError(
          409,
          'ATTRIBUTE_VARIANT_LOCK',
          'Variants are already built on this attribute, so it cannot change its variant-defining flag',
          { attributeId: id, usage },
        );
      }
    }

    if (rest.code && rest.code !== existing.code) {
      const clash = await prisma.attribute.count({ where: { code: rest.code, id: { not: id } } });
      if (clash > 0)
        throw AppError.conflict('That attribute code is already in use', { code: rest.code });
    }

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }

    await updateVersioned(prisma.attribute, 'Attribute', id, version, data);
    await catalogCacheService.invalidateAttributes();

    return this.get(id);
  },

  async remove(id: string): Promise<void> {
    await this.get(id);
    const usage = await attributeUsage(id);

    if (totalUsage(usage) > 0) {
      throw new AppError(409, 'ATTRIBUTE_IN_USE', 'This attribute is still referenced', {
        attributeId: id,
        usage,
      });
    }

    await prisma.attribute.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await catalogCacheService.invalidateAttributes();
  },

  async reorder(input: ReorderInput): Promise<number> {
    await prisma.$transaction(
      input.items.map((item) =>
        prisma.attribute.update({ where: { id: item.id }, data: { position: item.position } }),
      ),
    );
    await catalogCacheService.invalidateAttributes();
    return input.items.length;
  },

  /* ------------------------------------------------------------- values */

  async createValue(
    attributeId: string,
    input: AttributeValueCreateInput,
  ): Promise<AttributeValue> {
    await this.get(attributeId);

    const clash = await prisma.attributeValue.count({
      where: { attributeId, code: input.code },
    });
    if (clash > 0) {
      throw AppError.conflict('That value code is already used by this attribute', {
        code: input.code,
      });
    }

    const value = await prisma.attributeValue.create({
      data: {
        attributeId,
        code: input.code,
        label: input.label,
        position: input.position,
        colorHex: input.colorHex ?? null,
        swatchMediaId: input.swatchMediaId ?? null,
        numericValue: input.numericValue ?? null,
        isActive: input.isActive,
      },
    });

    if (value.swatchMediaId) {
      await mediaUsageService.attach({
        mediaId: value.swatchMediaId,
        usageType: 'ATTRIBUTE_SWATCH',
        entityId: value.id,
        field: 'swatchMediaId',
      });
    }

    await catalogCacheService.invalidateAttributes();
    return value;
  },

  async updateValue(id: string, input: AttributeValueUpdateInput): Promise<AttributeValue> {
    const existing = await prisma.attributeValue.findFirst({ where: { id, ...notDeleted } });
    if (!existing) throw AppError.notFound('Attribute value not found', { id });

    const { version, ...rest } = input;
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }

    await updateVersioned(prisma.attributeValue, 'AttributeValue', id, version, data);
    const updated = await prisma.attributeValue.findUniqueOrThrow({ where: { id } });

    if (updated.swatchMediaId !== existing.swatchMediaId) {
      if (existing.swatchMediaId) {
        await mediaUsageService.detach({
          mediaId: existing.swatchMediaId,
          usageType: 'ATTRIBUTE_SWATCH',
          entityId: id,
          field: 'swatchMediaId',
        });
      }
      if (updated.swatchMediaId) {
        await mediaUsageService.attach({
          mediaId: updated.swatchMediaId,
          usageType: 'ATTRIBUTE_SWATCH',
          entityId: id,
          field: 'swatchMediaId',
        });
      }
    }

    await catalogCacheService.invalidateAttributes();
    return updated;
  },

  async removeValue(id: string): Promise<void> {
    const existing = await prisma.attributeValue.findFirst({ where: { id, ...notDeleted } });
    if (!existing) throw AppError.notFound('Attribute value not found', { id });

    const usage = await valueUsage(id);
    if (totalUsage(usage) > 0) {
      throw new AppError(409, 'ATTRIBUTE_IN_USE', 'This value is still referenced', {
        attributeValueId: id,
        usage,
      });
    }

    await prisma.attributeValue.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    if (existing.swatchMediaId) {
      await mediaUsageService.detach({
        mediaId: existing.swatchMediaId,
        usageType: 'ATTRIBUTE_SWATCH',
        entityId: id,
        field: 'swatchMediaId',
      });
    }

    await catalogCacheService.invalidateAttributes();
  },

  /* -------------------------------------------------- category mapping */

  listForCategory(categoryId: string) {
    return prisma.categoryAttribute.findMany({
      where: { categoryId },
      include: { attribute: true },
      orderBy: { position: 'asc' },
    });
  },

  /** Attaches an attribute to a category, or overrides its flags for that category. */
  async upsertCategoryAttribute(categoryId: string, input: CategoryAttributeUpsertInput) {
    const [category, attribute] = await Promise.all([
      prisma.category.findFirst({ where: { id: categoryId, ...notDeleted } }),
      prisma.attribute.findFirst({ where: { id: input.attributeId, ...notDeleted } }),
    ]);
    if (!category) throw AppError.notFound('Category not found', { categoryId });
    if (!attribute) throw AppError.notFound('Attribute not found', { id: input.attributeId });

    const link = await prisma.categoryAttribute.upsert({
      where: { categoryId_attributeId: { categoryId, attributeId: input.attributeId } },
      update: {
        ...(input.isRequired === undefined ? {} : { isRequired: input.isRequired }),
        ...(input.isVariantDefining === undefined
          ? {}
          : { isVariantDefining: input.isVariantDefining }),
        ...(input.isFilterable === undefined ? {} : { isFilterable: input.isFilterable }),
        ...(input.position === undefined ? {} : { position: input.position }),
      },
      create: {
        categoryId,
        attributeId: input.attributeId,
        isRequired: input.isRequired ?? attribute.isRequired,
        isVariantDefining: input.isVariantDefining ?? attribute.isVariantDefining,
        isFilterable: input.isFilterable ?? attribute.isFilterable,
        position: input.position ?? attribute.position,
      },
    });

    await catalogCacheService.invalidateAttributes();
    return link;
  },

  async removeCategoryAttribute(categoryId: string, attributeId: string): Promise<void> {
    const variantsUsing = await prisma.variantAttributeValue.count({
      where: { attributeId, variant: { product: { categories: { some: { categoryId } } } } },
    });

    if (variantsUsing > 0) {
      throw new AppError(
        409,
        'ATTRIBUTE_IN_USE',
        'Variants in this category are built on that attribute',
        { categoryId, attributeId, variants: variantsUsing },
      );
    }

    await prisma.categoryAttribute.deleteMany({ where: { categoryId, attributeId } });
    await catalogCacheService.invalidateAttributes();
  },
};
