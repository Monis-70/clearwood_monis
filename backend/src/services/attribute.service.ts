import type { AttributeDataType, AttributeInput } from '@shared/enums';
import type { AttributeListQuery } from '@shared/schemas/catalog';
import type { AttributeDto } from '@shared/types/catalog';

import {
  attributeRepository,
  type AttributeWithValues,
} from '../repositories/attribute.repository';
import type { PageResult } from '../repositories/helpers';

import { categoryAttributeService, toAttributeValueDto } from './categoryAttribute.service';

export function toAttributeDto(attribute: AttributeWithValues): AttributeDto {
  return {
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
    position: attribute.position,
    helpText: attribute.helpText,
    values: attribute.values.map(toAttributeValueDto),
  };
}

export const attributeService = {
  /**
   * Without `categorySlug` this lists the global attribute dictionary; with it, the list is the
   * inherited set resolved for that category (so a child shows everything its ancestors define).
   */
  async list(query: AttributeListQuery): Promise<PageResult<AttributeDto>> {
    if (query.categorySlug) {
      const resolved = await categoryAttributeService.resolveForCategorySlug(query.categorySlug);
      const filtered = query.filterableOnly
        ? resolved.filter((attribute) => attribute.isFilterableForCategory)
        : resolved;

      const start = (query.page - 1) * query.limit;
      return {
        items: filtered.slice(start, start + query.limit),
        total: filtered.length,
        page: query.page,
        limit: query.limit,
      };
    }

    const page = await attributeRepository.list(query, { filterableOnly: query.filterableOnly });
    return { ...page, items: page.items.map(toAttributeDto) };
  },
};
