import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { REQUEST_ID_HEADER } from '@shared/constants';

/** Only echo a client-supplied id when it is safe — otherwise a caller could forge log lines. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Every request gets an id. It is exposed as the `x-request-id` header, added to every log line
 * and returned as `error.traceId`, so a user-reported failure can be found in the logs instantly.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(REQUEST_ID_HEADER);
  const id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();

  req.requestId = id;
  res.locals.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

export function getRequestId(req: Request): string {
  return req.requestId ?? randomUUID();
}
