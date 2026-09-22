import type { NextFunction, Request, Response } from 'express';

import { requestScope } from '../utils/requestScope';

/**
 * Opens the per-request memo used by `requestScope.once`. Must run before any route handler, and
 * before the query-count middleware so the counter sees the deduplicated total.
 */
export function requestScopeContext(_req: Request, _res: Response, next: NextFunction): void {
  requestScope.run(next);
}
