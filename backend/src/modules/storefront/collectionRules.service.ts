import type { Prisma } from '@prisma/client';

import type { CollectionRuleField, CollectionRuleOperator } from '@shared/enums';
import type { CollectionRules } from '@shared/schemas/catalogAdmin';
import { collectionRulesSchema } from '@shared/schemas/catalogAdmin';
import type { CollectionEvaluationDto } from '@shared/types/storefront';

import { logger } from '../../config/logger';
import { catalogEvents } from '../../events/catalogEvents';
import { publishedWhere, storefrontRepository } from '../../repositories/storefront.repository';
import { AppError } from '../../utils/AppError';
import { jsonColumn } from '../../utils/jsonColumn';
import { catalogCacheService } from '../catalog-admin/catalogCache.service';

/**
 * Evaluates AUTOMATIC collections.
 *
 * The rule tree is COMPILED to a Prisma `where` object — there is no `eval`, no string
 * concatenation and no raw SQL anywhere in this file. A field outside the whitelist or an operator
 * outside the enum cannot reach this code because Zod rejects it at the boundary, and the compiler
 * below still refuses it a second time.
 */

const rulesColumn = jsonColumn<CollectionRules>(undefined, 'Collection.rulesJson');

type RuleValue = string | number | boolean | (string | number)[];

function asArray(value: RuleValue): (string | number)[] {
  if (!Array.isArray(value)) {
    throw AppError.validation('This operator needs a list of values', { value });
  }
  return value;
}

function asNumber(value: RuleValue): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw AppError.validation('This operator needs a number', { value });
  }
  return parsed;
}

function asString(value: RuleValue): string {
  if (typeof value !== 'string') {
    throw AppError.validation('This operator needs a string', { value });
  }
  return value;
}

/** Scalar Product columns a rule may compare directly. */
const DIRECT_COLUMNS: Partial<Record<CollectionRuleField, keyof Prisma.ProductWhereInput>> = {
  brandId: 'brandId',
  taxClassId: 'taxClassId',
  basePricePaise: 'basePricePaise',
  compareAtPricePaise: 'compareAtPricePaise',
  productType: 'productType',
  searchKeywords: 'searchKeywords',
  createdAt: 'createdAt',
  isFeatured: 'isFeatured',
  isNewArrival: 'isNewArrival',
  isBestSeller: 'isBestSeller',
  isSpecialCollection: 'isSpecialCollection',
  isMadeToOrder: 'isMadeToOrder',
  soldCount: 'soldCount',
  ratingAvgBp: 'ratingAvgBp',
};

function scalarCondition(
  operator: CollectionRuleOperator,
  value: RuleValue,
): Prisma.IntFilter | Prisma.StringFilter | boolean | string | number | object {
  switch (operator) {
    case 'EQUALS':
      return typeof value === 'boolean' ? value : { equals: value as string | number };
    case 'NOT_EQUALS':
      return { not: value as string | number };
    case 'GREATER_THAN':
      return { gt: asNumber(value) };
    case 'GREATER_OR_EQUAL':
      return { gte: asNumber(value) };
    case 'LESS_THAN':
      return { lt: asNumber(value) };
    case 'LESS_OR_EQUAL':
      return { lte: asNumber(value) };
    case 'BETWEEN': {
      const [from, to] = asArray(value);
      return { gte: asNumber(from as number), lte: asNumber(to as number) };
    }
    case 'CONTAINS':
      return { contains: asString(value) };
    case 'STARTS_WITH':
      return { startsWith: asString(value) };
    case 'IN':
      return { in: asArray(value) };
    case 'NOT_IN':
      return { notIn: asArray(value) };
    default:
      throw AppError.validation(`Unsupported operator "${String(operator)}"`);
  }
}

function compileRule(rule: {
  field: CollectionRuleField;
  operator: CollectionRuleOperator;
  value: RuleValue;
}): Prisma.ProductWhereInput {
  const { field, operator, value } = rule;

  const column = DIRECT_COLUMNS[field];
  if (column) {
    return { [column]: scalarCondition(operator, value) } as Prisma.ProductWhereInput;
  }

  switch (field) {
    case 'categoryId': {
      const ids = operator === 'IN' || operator === 'NOT_IN' ? asArray(value) : [value];
      const some = { categoryId: { in: ids.map(String) } };
      return operator === 'NOT_IN' || operator === 'NOT_EQUALS'
        ? { categories: { none: some } }
        : { categories: { some } };
    }
    case 'categoryPath': {
      const path = asString(value);
      return {
        categories: {
          some: {
            category: {
              OR: [{ path }, { path: { startsWith: `${path}/` } }],
            },
          },
        },
      };
    }
    case 'attributeValueId': {
      const ids = (operator === 'IN' || operator === 'NOT_IN' ? asArray(value) : [value]).map(
        String,
      );
      const clause: Prisma.ProductWhereInput = {
        OR: [
          { attributeValues: { some: { attributeValueId: { in: ids } } } },
          {
            variants: {
              some: {
                deletedAt: null,
                attributeValues: { some: { attributeValueId: { in: ids } } },
              },
            },
          },
        ],
      };
      return operator === 'NOT_IN' || operator === 'NOT_EQUALS' ? { NOT: clause } : clause;
    }
    case 'tags':
      return { searchKeywords: { contains: asString(value) } };
    case 'stockStatus': {
      const statuses = (operator === 'IN' ? asArray(value) : [value]).map(String);
      return {
        variants: { some: { deletedAt: null, isActive: true, stockStatus: { in: statuses } } },
      };
    }
    default:
      throw AppError.validation(`Unsupported rule field "${String(field)}"`);
  }
}

export function compileRules(rules: CollectionRules): Prisma.ProductWhereInput {
  const groups = rules.groups.map((group) => {
    const clauses = group.rules.map(compileRule);
    return group.match === 'ANY' ? { OR: clauses } : { AND: clauses };
  });

  return {
    ...publishedWhere(),
    ...(rules.match === 'ANY' ? { OR: groups } : { AND: groups }),
  };
}

export const collectionRulesService = {
  parse(rulesJson: string | null): CollectionRules | null {
    if (!rulesJson) return null;

    const raw = rulesColumn.parseOrNull(rulesJson);
    if (!raw) return null;

    const parsed = collectionRulesSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.validation('The stored collection rules are not valid', {
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  },

  /** Dry run for the admin: how many products match, plus a sample, without writing anything. */
  async preview(
    rules: CollectionRules,
    sampleSize: number,
  ): Promise<{ matched: number; sample: { id: string; sku: string; name: string }[] }> {
    const where = compileRules(rules);

    const [matched, sample] = await Promise.all([
      storefrontRepository.countMatching(where),
      storefrontRepository.findMatchingSample(where, sampleSize),
    ]);

    return { matched, sample };
  },

  /**
   * Materialises CollectionProduct rows for one AUTOMATIC collection.
   *
   * Manual position overrides survive: a product that is still matched keeps the position it had.
   * MANUAL collections are never touched.
   */
  async evaluate(collectionId: string): Promise<CollectionEvaluationDto> {
    const collection = await storefrontRepository.findCollectionById(collectionId);
    if (!collection) throw AppError.notFound('Collection not found', { collectionId });

    if (collection.type !== 'AUTOMATIC') {
      throw AppError.badRequest(
        'Only AUTOMATIC collections can be evaluated',
        'COLLECTION_NOT_AUTOMATIC',
        { collectionId, type: collection.type },
      );
    }

    const rules = this.parse(collection.rulesJson);
    if (!rules) {
      throw AppError.badRequest(
        'This collection has no rules to evaluate',
        'COLLECTION_RULES_MISSING',
        { collectionId },
      );
    }

    const matchedIds = await storefrontRepository.findMatchingIds(compileRules(rules), rules.limit);
    const evaluatedAt = new Date();
    const outcome = await storefrontRepository.syncCollectionMembers(
      collectionId,
      matchedIds,
      evaluatedAt,
    );

    await catalogCacheService.invalidateCollection();
    catalogEvents.emit('collection.changed', { collectionId, reason: 'evaluated' });

    return {
      collectionId,
      slug: collection.slug,
      matched: matchedIds.length,
      added: outcome.added,
      removed: outcome.removed,
      kept: outcome.kept,
      evaluatedAt: evaluatedAt.toISOString(),
    };
  },

  /** Every AUTOMATIC collection, in one pass. Run at seed time and on demand. */
  async evaluateAll(): Promise<CollectionEvaluationDto[]> {
    const collections = await storefrontRepository.findAutomaticCollectionIds();

    const results: CollectionEvaluationDto[] = [];
    for (const collection of collections) {
      try {
        results.push(await this.evaluate(collection.id));
      } catch (error) {
        logger.warn({ err: error, collectionId: collection.id }, 'collection evaluation failed');
      }
    }
    return results;
  },
};
