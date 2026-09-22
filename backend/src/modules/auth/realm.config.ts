import type { AuthRealm, PrincipalType } from '@shared/enums';

import { authCookieSecure, env } from '../../config/env';

/**
 * PART A — two INDEPENDENT realms, ONE implementation.
 *
 * Separate secrets, audiences, cookie names, paths and TTLs mean an admin token can never
 * authenticate a storefront request (and vice-versa) even once the admin panel moves to
 * admin.<domain>. Storage is shared (one RefreshToken table with a `principalType`
 * discriminator) because duplicating rotation and reuse detection would violate rule 3/5.
 */

export interface RealmConfig {
  realm: AuthRealm;
  principalType: PrincipalType;
  accessSecret: string;
  refreshSecret: string;
  accessTtl: string;
  refreshTtl: string;
  cookieName: string;
  refreshCookieName: string;
  csrfCookieName: string;
  cookiePath: string;
  /** Refresh cookie path — scoped tighter than the access cookie where possible. */
  refreshCookiePath: string;
  /**
   * Always `/`: the CSRF cookie is read by the frontend through `document.cookie`, and path
   * matching there uses the DOCUMENT's path, not the API request path. It is a nonce, not a
   * credential, so widening it costs nothing while the httpOnly cookies stay narrowly scoped.
   */
  csrfCookiePath: string;
  cookieDomain: string;
  sameSite: 'lax' | 'strict' | 'none';
  secure: boolean;
  audience: string;
  issuer: string;
  allowedOrigins: string[];
}

const ADMIN_COOKIE_PATH = `${env.API_PREFIX}/admin`;

const REALM_CONFIG: Record<AuthRealm, RealmConfig> = {
  ADMIN: {
    realm: 'ADMIN',
    principalType: 'ADMIN_USER',
    accessSecret: env.ADMIN_JWT_ACCESS_SECRET,
    refreshSecret: env.ADMIN_JWT_REFRESH_SECRET,
    accessTtl: env.ADMIN_ACCESS_TOKEN_TTL,
    refreshTtl: env.ADMIN_REFRESH_TOKEN_TTL,
    cookieName: 'cw_adm_at',
    refreshCookieName: 'cw_adm_rt',
    csrfCookieName: 'cw_adm_csrf',
    cookiePath: ADMIN_COOKIE_PATH,
    refreshCookiePath: ADMIN_COOKIE_PATH,
    csrfCookiePath: '/',
    cookieDomain: env.ADMIN_COOKIE_DOMAIN,
    sameSite: env.AUTH_COOKIE_SAMESITE,
    secure: authCookieSecure,
    audience: 'clearwood-admin',
    issuer: 'clearwood',
    allowedOrigins: [env.ADMIN_ORIGIN],
  },
  CUSTOMER: {
    realm: 'CUSTOMER',
    principalType: 'CUSTOMER',
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.CUSTOMER_ACCESS_TOKEN_TTL,
    refreshTtl: env.CUSTOMER_REFRESH_TOKEN_TTL,
    cookieName: 'cw_cus_at',
    refreshCookieName: 'cw_cus_rt',
    csrfCookieName: 'cw_cus_csrf',
    cookiePath: '/',
    refreshCookiePath: '/',
    csrfCookiePath: '/',
    cookieDomain: env.COOKIE_DOMAIN,
    sameSite: env.AUTH_COOKIE_SAMESITE,
    secure: authCookieSecure,
    audience: 'clearwood-web',
    issuer: 'clearwood',
    allowedOrigins: [env.WEB_ORIGIN],
  },
};

export function realmConfig(realm: AuthRealm): RealmConfig {
  return REALM_CONFIG[realm];
}

export const REALMS = Object.values(REALM_CONFIG);

/** Every auth cookie name in use — the CSRF middleware needs them to spot a cookie-auth request. */
export const AUTH_COOKIE_NAMES = REALMS.flatMap((config) => [
  config.cookieName,
  config.refreshCookieName,
  config.csrfCookieName,
]);
