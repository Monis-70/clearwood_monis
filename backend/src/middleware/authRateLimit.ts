import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

import { env, isTest } from '../config/env';
import { AppError } from '../utils/AppError';

/**
 * A tighter limiter for credential endpoints, keyed by ip + the identifier being attacked, so one
 * abusive client cannot lock every account and one targeted account cannot be sprayed from one IP.
 */
export function authRateLimit(bucket: string): RateLimitRequestHandler {
  return rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    limit: env.AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => isTest,
    keyGenerator: (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const identifier =
        body.email ?? body.identifier ?? body.phone ?? body.destination ?? body.token ?? '';
      return `${bucket}:${req.ip ?? 'unknown'}:${String(identifier).toLowerCase().slice(0, 120)}`;
    },
    handler: (_req, _res, next) => {
      next(
        AppError.tooManyRequests(
          `Too many attempts — try again in ${Math.round(env.AUTH_RATE_LIMIT_WINDOW_MS / 1000)}s.`,
        ),
      );
    },
  });
}
