import type { AttributeDataType, AttributeInput } from '@shared/enums';
import type { AttributeValueDto, ResolvedCategoryAttributeDto } from '@shared/types/catalog';

import { cache } from '../container';
import {
  attributeRepository,
  type AttributeWithValues,
} from '../repositories/attribute.repository';
import { categoryRepository } from '../repositories/category.repository';
import { AppError } from '../utils/AppError';

import { categoryPathService } from './categoryPath.service';

const ATTRIBUTE_CACHE_PREFIX = 'cat:attrs:';
const TTL_SECONDS = 300;

/**
 * Cache namespaces owned by the catalog. Every future write path (Prompt 5 admin CRUD, Prompt 11
 * configurator) must call `invalidateCatalogCache()` so R9 holds: an admin edit shows up on the
 * storefront with zero code change and no restart.
 */
const CATALOG_CACHE_PREFIXES = {
  all: ['cat:', 'nav:', 'prod:'],
  categories: ['cat:'],
  attributes: [ATTRIBUTE_CACHE_PREFIX],
  navigation: ['nav:'],
  products: ['prod:'],
} as const;

export type CatalogCacheScope = keyof typeof CATALOG_CACHE_PREFIXES;

export async function invalidateCatalogCache(scope: CatalogCacheScope = 'all'): Promise<void> {
  await Promise.all(CATALOG_CACHE_PREFIXES[scope].map((prefix) => cache.delByPrefix(prefix)));
}

export function toAttributeValueDto(
  value: AttributeWithValues['values'][number],
): AttributeValueDto {
  return {
    id: value.id,
    code: value.code,
    label: value.label,
    position: value.position,
    colorHex: value.colorHex,
    swatchMediaId: value.swatchMediaId,
    numericValue: value.numericValue,
  };
}

export const categoryAttributeService = {
  /**
   * Attributes are inherited down the category path: "sofas" defines COLOUR/FABRIC and
   * "sofas/fabric-sofas" gets them for free, while a row on the child overrides the parent's flags.
   */
  async resolveForCategory(categoryId: string): Promise<ResolvedCategoryAttributeDto[]> {
    return cache.wrap(`${ATTRIBUTE_CACHE_PREFIX}${categoryId}`, TTL_SECONDS, async () => {
      const category = await categoryRepository.findById(categoryId);
      if (!category) throw AppError.notFound('Category not found', { categoryId });

      const lineageSlugs = categoryPathService.ancestorSlugs(category.path);
      const lineage = await categoryRepository.findManyBySlugs(lineageSlugs);
      const depthBySlug = new Map(lineageSlugs.map((slug, index) => [slug, index]));

      const links = await attributeRepository.findCategoryLinks(lineage.map((row) => row.id));
      if (links.length === 0) return [];

      const attributes = await attributeRepository.findManyByIds([
        ...new Set(links.map((link) => link.attributeId)),
      ]);
      const attributeById = new Map(attributes.map((attribute) => [attribute.id, attribute]));

      // Walk root -> leaf so the closest definition wins.
      const ordered = [...links].sort(
        (a, b) =>
          (depthBySlug.get(a.category.slug) ?? 0) - (depthBySlug.get(b.category.slug) ?? 0) ||
          a.position - b.position,
      );

      const resolved = new Map<string, ResolvedCategoryAttributeDto>();

      for (const link of ordered) {
        const attribute = attributeById.get(link.attributeId);
        if (!attribute) continue;

        resolved.set(attribute.id, {
          id: attribute.id,
          code: attribute.code,
          name: attribute.name,
          groupCode: attribute.group?.code ?? null,
          groupName: attribute.group?.name ?? null,
          inputType: attribute.inputType as AttributeInput,
          dataType: attribute.dataType as AttributeDataType,
          unit: attribute.unit,
          isVariantDefining: attribute.isVariantDefining,
          isFilterable: attribute.isFilterable,
          isSearchable: attribute.isSearchable,
          isRequired: attribute.isRequired,
          isComparable: attribute.isComparable,
          showInSwatch: attribute.showInSwatch,
          position: link.position,
          helpText: attribute.helpText,
          values: attribute.values.map(toAttributeValueDto),
          inheritedFrom: link.category.slug,
          isRequiredForCategory: link.isRequired,
          isVariantDefiningForCategory: link.isVariantDefining || attribute.isVariantDefining,
          isFilterableForCategory: link.isFilterable && attribute.isFilterable,
        });
      }

      return [...resolved.values()].sort(
        (a, b) => a.position - b.position || a.name.localeCompare(b.name),
      );
    });
  },

  async resolveForCategorySlug(slug: string): Promise<ResolvedCategoryAttributeDto[]> {
    const category = await categoryRepository.findBySlug(slug, true);
    if (!category) throw AppError.notFound(`Category "${slug}" not found`, { slug });
    return this.resolveForCategory(category.id);
  },
};
