import type { Response } from 'express';

import { buildPaginationMeta, type ApiMeta, type ApiSuccess } from '@shared/types/api';
import type { PaginationInput } from '@shared/types/api';

/**
 * R3 — every successful response leaves the API through one of these two helpers, so the envelope
 * can never drift between endpoints.
 */

export function ok<T>(res: Response, data: T, meta: ApiMeta | null = null, status = 200): Response {
  const body: ApiSuccess<T> = { success: true, data, meta };
  return res.status(status).json(body);
}

export function created<T>(res: Response, data: T, meta: ApiMeta | null = null): Response {
  return ok(res, data, meta, 201);
}

export function noContent(res: Response): Response {
  return ok(res, null, null, 200);
}

/** R5 — the only way a list endpoint may answer. */
export function paginated<T>(res: Response, items: T[], pagination: PaginationInput): Response {
  return ok(res, items, buildPaginationMeta(pagination));
}
