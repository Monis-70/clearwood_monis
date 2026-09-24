import { timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import type { AuthRealm } from '@shared/enums';

import { csrfEnabled } from '../../config/env';
import { AppError } from '../../utils/AppError';

import { cookieService } from './cookie.service';
import { realmConfig } from './realm.config';

/**
 * Double-submit CSRF. A cookie-authenticated mutating request must echo the non-httpOnly CSRF
 * cookie in `X-CSRF-Token`. Bearer-token requests carry no ambient credential, so they are exempt.
 */

const CSRF_HEADER = 'x-csrf-token';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const csrfService = {
  headerName: CSRF_HEADER,

  isMutating(method: string): boolean {
    return MUTATING.has(method.toUpperCase());
  },

  /**
   * True when the caller is relying on cookies rather than a Bearer token.
   *
   * Only a `Bearer` header exempts, because only a Bearer header replaces the cookie in
   * `authenticate` (see `readToken`). Any other Authorization header - `Basic` credentials a
   * browser attaches on its own behind an authenticating proxy, say - leaves the ambient cookie
   * doing the authenticating, so it must not switch the CSRF check off.
   */
  usesCookieAuth(req: Request, realm: AuthRealm): boolean {
    if (req.get('authorization')?.toLowerCase().startsWith('bearer ')) return false;
    return Boolean(
      cookieService.readAccessToken(req, realm) ?? cookieService.readRefreshToken(req, realm),
    );
  },

  assert(req: Request, realm: AuthRealm): void {
    if (!csrfEnabled) return;
    if (!this.isMutating(req.method)) return;
    if (!this.usesCookieAuth(req, realm)) return;

    const header = req.get(CSRF_HEADER);
    const cookies = cookieService.readAllCookieValues(req, realmConfig(realm).csrfCookieName);

    // Any match wins: a stale duplicate of the same cookie under an older path must not lock the
    // admin out of every mutation with no way to recover from the UI.
    if (!header || !cookies.some((cookie) => constantTimeEquals(cookie, header))) {
      throw new AppError(403, 'CSRF_TOKEN_INVALID', 'Missing or invalid CSRF token', {
        header: CSRF_HEADER,
        cookie: realmConfig(realm).csrfCookieName,
      });
    }
  },
};

/** Route-level guard used by every cookie-authenticated mutating endpoint. */
export function csrfProtection(realm: AuthRealm) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      csrfService.assert(req, realm);
      next();
    } catch (error) {
      next(error);
    }
  };
}
