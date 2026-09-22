import { randomBytes } from 'node:crypto';

import type { CookieOptions, Request, Response } from 'express';

import type { AuthRealm } from '@shared/enums';

import { isProduction } from '../../config/env';

import { realmConfig } from './realm.config';
import { tokenService } from './token.service';

/**
 * The refresh token lives in an httpOnly cookie and nowhere else. Browsers never see it in a
 * response body, never put it in storage, and never read it from JavaScript.
 * The CSRF token is the only auth cookie that is deliberately readable by scripts.
 */

function baseOptions(realm: AuthRealm, httpOnly: boolean): CookieOptions {
  const config = realmConfig(realm);

  return {
    httpOnly,
    secure: config.secure || isProduction,
    sameSite: config.sameSite,
    domain: config.cookieDomain === 'localhost' ? undefined : config.cookieDomain,
  };
}

export interface IssuedCookies {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  accessTtlMs: number;
  refreshExpiresAt: Date;
}

export const cookieService = {
  newCsrfToken(): string {
    return randomBytes(24).toString('base64url');
  },

  setAuthCookies(res: Response, realm: AuthRealm, issued: IssuedCookies): void {
    const config = realmConfig(realm);

    res.cookie(config.cookieName, issued.accessToken, {
      ...baseOptions(realm, true),
      path: config.cookiePath,
      maxAge: issued.accessTtlMs,
    });

    res.cookie(config.refreshCookieName, issued.refreshToken, {
      ...baseOptions(realm, true),
      path: config.refreshCookiePath,
      expires: issued.refreshExpiresAt,
    });

    // Readable by the frontend so it can echo the value in X-CSRF-Token (double submit).
    res.cookie(config.csrfCookieName, issued.csrfToken, {
      ...baseOptions(realm, false),
      path: config.csrfCookiePath,
      expires: issued.refreshExpiresAt,
    });
  },

  clearAuthCookies(res: Response, realm: AuthRealm): void {
    const config = realmConfig(realm);

    res.clearCookie(config.cookieName, { ...baseOptions(realm, true), path: config.cookiePath });
    res.clearCookie(config.refreshCookieName, {
      ...baseOptions(realm, true),
      path: config.refreshCookiePath,
    });
    res.clearCookie(config.csrfCookieName, {
      ...baseOptions(realm, false),
      path: config.csrfCookiePath,
    });
  },

  /**
   * Every value the browser sent for one cookie name.
   *
   * A cookie issued under an older, narrower path is a *different* cookie to the browser, which
   * then sends both — and cookie-parser keeps only the first. Reading all of them means a stale
   * duplicate left over from an earlier deployment cannot silently break CSRF.
   */
  readAllCookieValues(req: Request, name: string): string[] {
    const header = req.headers.cookie;
    if (!header) return [];

    return header
      .split(';')
      .map((pair) => pair.trim())
      .filter((pair) => pair.startsWith(`${name}=`))
      .map((pair) => decodeURIComponent(pair.slice(name.length + 1)))
      .filter(Boolean);
  },

  readAccessToken(req: Request, realm: AuthRealm): string | null {
    return (req.cookies?.[realmConfig(realm).cookieName] as string | undefined) ?? null;
  },

  readRefreshToken(req: Request, realm: AuthRealm): string | null {
    return (req.cookies?.[realmConfig(realm).refreshCookieName] as string | undefined) ?? null;
  },

  readCsrfCookie(req: Request, realm: AuthRealm): string | null {
    return (req.cookies?.[realmConfig(realm).csrfCookieName] as string | undefined) ?? null;
  },

  accessTtlMs(realm: AuthRealm): number {
    return tokenService.ttlToMs(realmConfig(realm).accessTtl);
  },
};
