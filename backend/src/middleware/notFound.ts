import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../utils/AppError';

/** Anything that reaches here has matched no route — answer with the standard error envelope. */
export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} does not exist`));
}
