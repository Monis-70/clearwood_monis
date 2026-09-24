import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

import { env, isTest } from '../config/env';
import { AppError } from '../utils/AppError';

import { rateLimitStore } from './rateLimitStore';

/**
 * The limiter's bucket key. Credential endpoints key on ip + the identifier being attacked, so one
 * abusive client cannot lock every account and one targeted account cannot be sprayed from one IP.
 * A public form (`byIdentifier: false`) keys on the client alone: its "identifier" is whatever the
 * sender typed, and rotating it must not buy a fresh allowance.
 */
export function rateLimitKey(
  bucket: string,
  req: { ip?: string | undefined; body?: unknown },
  byIdentifier = true,
): string {
  if (!byIdentifier) return `${bucket}:${req.ip ?? 'unknown'}`;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const identifier =
    body.email ?? body.identifier ?? body.phone ?? body.destination ?? body.token ?? '';
  return `${bucket}:${req.ip ?? 'unknown'}:${String(identifier).toLowerCase().slice(0, 120)}`;
}

/** A tighter limiter for credential endpoints and public forms (see rateLimitKey). */
export function authRateLimit(
  bucket: string,
  options: { byIdentifier?: boolean } = {},
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    limit: env.AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: rateLimitStore(`auth:${bucket}`),
    skip: () => isTest,
    keyGenerator: (req) => rateLimitKey(bucket, req, options.byIdentifier ?? true),
    handler: (_req, _res, next) => {
      next(
        AppError.tooManyRequests(
          `Too many attempts — try again in ${Math.round(env.AUTH_RATE_LIMIT_WINDOW_MS / 1000)}s.`,
        ),
      );
    },
  });
}
