import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodIssue, ZodTypeAny } from 'zod';

import { AppError } from '../utils/AppError';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
  headers?: ZodTypeAny;
}

type Location = keyof ValidationSchemas;

/**
 * R2 — the factory every route uses. Parsed (and coerced/defaulted) values replace the raw input,
 * so controllers only ever see validated data. Anything invalid becomes a 422 listing every issue.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  const entries = Object.entries(schemas) as [Location, ZodTypeAny][];

  return (req: Request, _res: Response, next: NextFunction): void => {
    const issues: (ZodIssue & { location: Location })[] = [];

    for (const [location, schema] of entries) {
      const result = schema.safeParse(req[location]);

      if (result.success) {
        // `req.query` / `req.params` are getters in Express 4.20+, so assign in place.
        Object.defineProperty(req, location, {
          value: result.data,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } else {
        issues.push(...result.error.issues.map((issue) => ({ ...issue, location })));
      }
    }

    if (issues.length > 0) {
      next(
        AppError.validation(
          'Request validation failed',
          issues.map((issue) => ({
            location: issue.location,
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message,
          })),
        ),
      );
      return;
    }

    next();
  };
}
