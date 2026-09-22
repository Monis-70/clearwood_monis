import { z } from 'zod';

import { PAGINATION } from '../constants';
import { SORT_ORDERS } from '../enums';

/**
 * R2 / R5 — reusable request schemas. Anything that reaches Prisma via `sort` must be constrained
 * to a safe identifier shape (R10) even though Prisma itself parameterises queries.
 */

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(PAGINATION.DEFAULT_PAGE),
  limit: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const sortQuerySchema = z.object({
  sort: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9_.]*$/, 'sort must be a field name')
    .optional(),
  order: z.enum(SORT_ORDERS).default(PAGINATION.DEFAULT_ORDER),
});
export type SortQuery = z.infer<typeof sortQuerySchema>;

export const listQuerySchema = paginationQuerySchema.merge(sortQuerySchema);
export type ListQuery = z.infer<typeof listQuerySchema>;

/** cuid / cuid2 / ulid all fit this shape; kept permissive but injection-safe. */
export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'invalid id');

export const idParamSchema = z.object({ id: idSchema });
export type IdParam = z.infer<typeof idParamSchema>;

export const slugSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'invalid slug');

export const slugParamSchema = z.object({ slug: slugSchema });
export type SlugParam = z.infer<typeof slugParamSchema>;

/** Query strings carry booleans as text; `z.coerce.boolean()` would treat "false" as true. */
export const booleanQuerySchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) =>
    typeof value === 'boolean' ? value : value === 'true' || value === '1' || value === 'yes',
  );

/** D5 — money crossing the wire is always an integer paise amount. */
export const paiseSchema = z.number().int().min(0);

/** Rates and percentages are integer basis points: 18% = 1800, 100% = 10000. */
export const basisPointsSchema = z.number().int().min(0).max(1_000_000);
