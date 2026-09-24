import type { ListQuery } from '@shared/schemas/common';
import type { SortOrder } from '@shared/enums';

import { AppError } from '../utils/AppError';

/**
 * Shared repository plumbing. R1 — only repositories import this.
 * `PageResult` carries exactly what `paginated()` (R5) needs; the envelope itself is built in the
 * controller so the shared `Paginated<T>` shape stays the single response contract.
 */

/** D6 — soft-deleted rows are invisible unless a caller explicitly asks for them. */
export const notDeleted = { deletedAt: null } as const;

export interface PageResult<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export function skipTake(query: Pick<ListQuery, 'page' | 'limit'>): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.limit, take: query.limit };
}

/**
 * R10 — `sort` arrives from the query string, so it is matched against a per-repository allowlist
 * before it is ever handed to Prisma.
 *
 * Every ordering ends with `id`, so rows that tie on the sort field keep one order and a page
 * boundary can neither repeat nor skip a row.
 */
export function orderBy<TField extends string>(
  sort: string | undefined,
  order: SortOrder,
  allowed: readonly TField[],
  fallback: Partial<Record<TField, SortOrder>>[],
): Record<string, SortOrder>[] {
  if (!sort) return withIdTiebreak(fallback as Record<string, SortOrder>[]);

  if (!(allowed as readonly string[]).includes(sort)) {
    throw AppError.validation(`Cannot sort by "${sort}"`, {
      allowed,
      field: 'sort',
    });
  }

  return withIdTiebreak([{ [sort]: order }]);
}

function withIdTiebreak(ordering: Record<string, SortOrder>[]): Record<string, SortOrder>[] {
  return ordering.some((entry) => 'id' in entry) ? ordering : [...ordering, { id: 'asc' }];
}

export function pageResult<T>(items: T[], total: number, query: ListQuery): PageResult<T> {
  return { items, total, page: query.page, limit: query.limit };
}
