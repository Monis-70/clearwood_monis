import pino, { type Logger } from 'pino';

import { env, isDevelopment, isTest } from './env';

/**
 * R10 — secrets never reach the logs. Redaction is applied to the shapes pino-http produces as
 * well as to anything we log by hand.
 */
const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'authorization',
  'cookie',
  '*.password',
  '*.token',
  '*.secret',
  '*.accessToken',
  '*.refreshToken',
  '*.authorization',
];

export const logger: Logger = pino({
  name: 'clearwood-api',
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { env: env.NODE_ENV },
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,env',
          singleLine: false,
        },
      }
    : undefined,
});

export type { Logger };
