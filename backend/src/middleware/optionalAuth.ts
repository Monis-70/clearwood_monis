import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { AuthRealm } from '@shared/enums';

import { resolveAuthContext } from './authenticate';

/**
 * Never throws: an anonymous or broken credential simply leaves `req.auth` undefined.
 * Required by Prompt 8's guest cart, where a signed-in customer is a bonus rather than a gate.
 */
export function optionalAuth(realm: AuthRealm): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    resolveAuthContext(req, realm)
      .then((auth) => {
        req.auth = auth;
      })
      .catch(() => undefined)
      .finally(() => next());
  };
}
