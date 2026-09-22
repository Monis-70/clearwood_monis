import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

import { env, isTest } from '../config/env';
import { AppError } from '../utils/AppError';

/** R10 — a blunt but effective guard in front of /api. Tightened per-route from Prompt 3. */
export const apiRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, _res, next) => {
    next(
      AppError.tooManyRequests(
        `Too many requests — the limit is ${env.RATE_LIMIT_MAX} per ${Math.round(
          env.RATE_LIMIT_WINDOW_MS / 1000,
        )}s.`,
      ),
    );
  },
});
