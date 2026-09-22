import { createHash } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { env } from '../config/env';
import { logger } from '../config/logger';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';

/**
 * Optional `Idempotency-Key` support for mutations that would otherwise duplicate work when a
 * client retries (product create/duplicate, stock adjustment, bulk actions, import commit).
 *
 * Contract:
 *  - the key is scoped per principal + route, so two admins may use the same key safely;
 *  - the first request runs normally and its response body is stored until `expiresAt`;
 *  - a retry with the SAME key and SAME payload replays the stored response with
 *    `Idempotent-Replay: true` and never re-executes the handler;
 *  - the same key with a DIFFERENT payload is a client bug and is rejected with 409;
 *  - a request that is still running answers 409 IDEMPOTENCY_IN_PROGRESS rather than racing;
 *  - failures (4xx/5xx) release the key so the caller can correct the request and retry.
 */

const HEADER = 'idempotency-key';
const REPLAY_HEADER = 'Idempotent-Replay';

function hashPayload(req: Request): string {
  return createHash('sha256')
    .update(JSON.stringify({ body: req.body ?? null, query: req.query ?? null }))
    .digest('hex');
}

export function idempotency(scope: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.get(HEADER);
    if (!key) {
      next();
      return;
    }

    if (key.length < 8 || key.length > 200) {
      next(
        AppError.validation('Idempotency-Key must be between 8 and 200 characters', {
          header: HEADER,
        }),
      );
      return;
    }

    void run(req, res, next, scope, key);
  };
}

async function run(
  req: Request,
  res: Response,
  next: NextFunction,
  scope: string,
  key: string,
): Promise<void> {
  const requestHash = hashPayload(req);
  const principalId = req.auth?.principalId ?? null;
  const expiresAt = new Date(Date.now() + env.IDEMPOTENCY_TTL_HOURS * 3_600_000);

  try {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { scope_key: { scope, key } },
    });

    if (existing && existing.expiresAt.getTime() > Date.now()) {
      if (existing.principalId !== principalId || existing.requestHash !== requestHash) {
        next(
          new AppError(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'This Idempotency-Key was already used with a different request',
            { key, scope },
          ),
        );
        return;
      }

      // The outcome is written after the first response is flushed, so a retry that arrives in
      // that window waits for it rather than being told the key is busy.
      const settled =
        existing.status === 'IN_PROGRESS' ? await waitForOutcome(scope, key) : existing;

      if (!settled || settled.status === 'IN_PROGRESS') {
        next(
          new AppError(
            409,
            'IDEMPOTENCY_IN_PROGRESS',
            'An identical request is still being processed',
            { key, scope },
          ),
        );
        return;
      }

      res.setHeader(REPLAY_HEADER, 'true');
      res.status(settled.responseStatus ?? 200).json(JSON.parse(settled.responseJson ?? 'null'));
      return;
    }

    if (existing) {
      await prisma.idempotencyKey.delete({ where: { id: existing.id } });
    }

    await prisma.idempotencyKey.create({
      data: {
        key,
        scope,
        principalType: req.auth?.principalType ?? 'SYSTEM',
        principalId,
        method: req.method,
        path: req.originalUrl.split('?')[0] ?? req.path,
        requestHash,
        status: 'IN_PROGRESS',
        expiresAt,
      },
    });
  } catch (error) {
    // A broken ledger must never block a legitimate write; fall through without replay support.
    logger.error({ err: error, scope, key }, 'idempotency ledger unavailable');
    next();
    return;
  }

  captureResponse(req, res, scope, key);
  next();
}

/** Polls briefly for a concurrent request's outcome so a fast retry replays instead of 409ing. */
async function waitForOutcome(scope: string, key: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const row = await prisma.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
    if (!row || row.status !== 'IN_PROGRESS') return row;
  }
  return null;
}

/** Records the outcome once the response is on the wire. */
function captureResponse(req: Request, res: Response, scope: string, key: string): void {
  const originalJson = res.json.bind(res);
  let captured: unknown = null;

  res.json = (body: unknown) => {
    captured = body;
    return originalJson(body);
  };

  res.on('finish', () => {
    const settled =
      res.statusCode >= 200 && res.statusCode < 300
        ? prisma.idempotencyKey.updateMany({
            where: { scope, key },
            data: {
              status: 'COMPLETED',
              responseStatus: res.statusCode,
              responseJson: JSON.stringify(captured ?? null),
              completedAt: new Date(),
            },
          })
        : // Not a success: drop the key so the caller can fix the request and retry.
          prisma.idempotencyKey.deleteMany({ where: { scope, key } });

    void settled.catch((error: unknown) =>
      logger.error({ err: error, scope, key }, 'failed to settle idempotency key'),
    );
  });
}

/** Housekeeping for expired rows; called by the admin GC endpoint and by tests. */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const { count } = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}
