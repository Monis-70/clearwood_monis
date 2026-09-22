import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { CookieOptions, Request, Response } from 'express';

import { env, isProduction } from '../../config/env';

/**
 * Guest cart identity.
 *
 * A guest is a 128-bit random session id carried in an httpOnly, signed cookie. The security rules
 * this file exists to enforce:
 *
 *  - the id comes from `randomBytes` (CSPRNG), never from a timestamp or a counter;
 *  - the signature is verified with `timingSafeEqual`, so a forged cookie cannot be brute-forced
 *    one byte at a time;
 *  - the cookie is httpOnly, so no storefront JavaScript can ever read the session id;
 *  - a tampered, malformed or expired cookie is treated as "no cart" and silently replaced — it is
 *    never a 500 and it never leaks why it failed;
 *  - nothing here is ever logged. The raw cookie and the secret must not reach a log line.
 */

const SESSION_BYTES = 16;
const SEPARATOR = '.';

export interface CartOwner {
  customerId: string | null;
  sessionId: string | null;
  /** Set when a write path needs a cookie minted before it can persist a guest cart. */
  isNewSession: boolean;
}

function sign(sessionId: string, expiresAtMs: number): string {
  return createHmac('sha256', env.CART_COOKIE_SECRET)
    .update(`${sessionId}${SEPARATOR}${expiresAtMs}`)
    .digest('base64url');
}

function cookieOptions(expires: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    expires,
  };
}

function newSessionId(): string {
  return randomBytes(SESSION_BYTES).toString('base64url');
}

function ttlMs(): number {
  return env.CART_GUEST_TTL_DAYS * 24 * 60 * 60 * 1000;
}

/** `<sessionId>.<expiresAtMs>.<signature>` — parsed defensively, never trusted. */
export function parseCartCookie(raw: string | undefined): string | null {
  if (!raw) return null;

  const parts = raw.split(SEPARATOR);
  if (parts.length !== 3) return null;

  const [sessionId, expiryText, signature] = parts as [string, string, string];
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(sessionId)) return null;

  const expiresAtMs = Number(expiryText);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;

  const expected = Buffer.from(sign(sessionId, expiresAtMs));
  const provided = Buffer.from(signature);

  // Length check first: timingSafeEqual throws on a mismatch, and the length is not a secret.
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

  return sessionId;
}

export const cartIdentity = {
  cookieName: env.CART_COOKIE_NAME,

  /**
   * Who is this cart for?
   *
   * A signed-in customer always wins — their cart follows the account, not the browser. A guest
   * falls back to the cookie. Nothing is minted here: a GET on an empty cart must not set a cookie,
   * so `isNewSession` tells the write paths when to call `persist`.
   */
  resolve(req: Request): CartOwner {
    const customerId = req.auth?.realm === 'CUSTOMER' ? req.auth.principalId : null;
    if (customerId) return { customerId, sessionId: null, isNewSession: false };

    const raw = req.cookies?.[env.CART_COOKIE_NAME] as string | undefined;
    const sessionId = parseCartCookie(raw);

    // A tampered or expired cookie is indistinguishable from no cookie at all, by design.
    if (sessionId) return { customerId: null, sessionId, isNewSession: false };

    return { customerId: null, sessionId: newSessionId(), isNewSession: true };
  },

  /** Read-only resolution: returns null rather than minting an id. */
  resolveExisting(req: Request): CartOwner {
    const customerId = req.auth?.realm === 'CUSTOMER' ? req.auth.principalId : null;
    if (customerId) return { customerId, sessionId: null, isNewSession: false };

    const sessionId = parseCartCookie(req.cookies?.[env.CART_COOKIE_NAME] as string | undefined);
    return { customerId: null, sessionId, isNewSession: false };
  },

  /** Writes the cookie only when a guest write actually happened. Refreshes the TTL on every use. */
  persist(res: Response, owner: CartOwner): void {
    if (!owner.sessionId) return;

    const expiresAtMs = Date.now() + ttlMs();
    const value = [owner.sessionId, expiresAtMs, sign(owner.sessionId, expiresAtMs)].join(
      SEPARATOR,
    );

    res.cookie(env.CART_COOKIE_NAME, value, cookieOptions(new Date(expiresAtMs)));
  },

  clear(res: Response): void {
    res.clearCookie(env.CART_COOKIE_NAME, { httpOnly: true, sameSite: 'lax', path: '/' });
  },

  /** The DB-level uniqueness key that makes "one ACTIVE cart per owner" impossible to race. */
  ownerKey(owner: { customerId?: string | null; sessionId?: string | null }): string {
    if (owner.customerId) return `c:${owner.customerId}`;
    if (owner.sessionId) return `s:${owner.sessionId}`;
    throw new Error('a cart owner needs a customerId or a sessionId');
  },
};
