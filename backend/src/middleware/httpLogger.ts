import pinoHttp, { type HttpLogger } from 'pino-http';

import { isTest } from '../config/env';
import { logger } from '../config/logger';

/** Structured access log. Health probes are muted so `npm run dev` stays readable. */
export const httpLogger: HttpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as { requestId?: string }).requestId ?? 'unknown',
  autoLogging: {
    ignore: (req) => isTest || req.url === '/health' || req.url === '/ready',
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
