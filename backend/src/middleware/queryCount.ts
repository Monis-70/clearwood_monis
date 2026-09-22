import type { NextFunction, Request, Response } from 'express';

import { queryCountDebug } from '../config/env';
import { logger } from '../config/logger';
import { queryInsights } from '../perf/queryInsights';

const HEADER = 'X-Query-Count';
const SLOW_QUERY_CHARS = 300;

/**
 * Counts the queries a request issued, puts the total on the response and logs the detail.
 *
 * Off in production regardless of DEBUG_QUERY_COUNT — `queryCountDebug` decides, not this file.
 * The header is written from a wrapped `res.writeHead` rather than a wrapped `res.end`, because
 * compression replaces `res.end` after this middleware runs and has already flushed the head by
 * the time the original is reached. `writeHead` is the last point at which a header can be added.
 */
export function queryCount(req: Request, res: Response, next: NextFunction): void {
  if (!queryCountDebug()) {
    next();
    return;
  }

  queryInsights.run((stats) => {
    const writeHead = res.writeHead.bind(res);

    res.writeHead = function patched(this: Response, ...args: unknown[]): Response {
      res.setHeader(HEADER, String(stats.count));
      res.setHeader('X-Query-Ms', stats.totalMs.toFixed(1));

      return writeHead(...(args as Parameters<typeof writeHead>));
    } as Response['writeHead'];

    res.on('finish', () => {
      if (stats.count === 0) return;

      logger.info(
        {
          requestId: req.requestId,
          method: req.method,
          route: req.originalUrl,
          queryCount: stats.count,
          queryMs: Number(stats.totalMs.toFixed(1)),
          slowestQueryMs: Number(stats.slowestMs.toFixed(1)),
          slowestQuery: stats.slowestQuery?.slice(0, SLOW_QUERY_CHARS) ?? null,
        },
        'query count',
      );
    });

    next();
  });
}
