import { Router } from 'express';

import { healthController } from '../controllers/health.controller';
import {
  commonErrorResponses,
  jsonContent,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';
import { asyncHandler } from '../middleware';

const healthSchema = registry.register(
  'Health',
  z.object({
    status: z.literal('ok'),
    uptime: z.number().openapi({ description: 'Process uptime in seconds', example: 12.345 }),
    timestamp: z.string().datetime(),
  }),
);

const dependencySchema = z.object({
  status: z.enum(['up', 'down']),
  driver: z.string(),
  latencyMs: z.number().int(),
  error: z.string().optional(),
});

const readinessSchema = registry.register(
  'Readiness',
  z.object({
    status: z.enum(['ready', 'degraded', 'unavailable']).openapi({
      description:
        '`degraded`: the cache is down and reads are served from the database; still in rotation.',
    }),
    timestamp: z.string().datetime(),
    dependencies: z.object({ database: dependencySchema, cache: dependencySchema }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/health',
  tags: ['System'],
  summary: 'Liveness probe',
  description: 'Answers without touching any dependency. Used by PM2 / nginx (Prompt 17).',
  responses: {
    200: jsonContent(successBodySchema(healthSchema), 'The process is alive'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: '/ready',
  tags: ['System'],
  summary: 'Readiness probe',
  description:
    'Checks the database (SELECT 1) and the cache. Returns 503 only when the database is down: ' +
    'a cache outage answers 200 with `status: degraded`, because every read falls back to MySQL.',
  responses: {
    200: jsonContent(
      successBodySchema(readinessSchema),
      'The database answered (cache up or degraded)',
    ),
    503: jsonContent(
      z.object({
        success: z.literal(false),
        error: z.object({
          code: z.literal('SERVICE_UNAVAILABLE'),
          message: z.string(),
          details: readinessSchema,
          traceId: z.string().uuid(),
        }),
      }),
      'The database is down — `error.details` carries the per-dependency status',
    ),
    ...commonErrorResponses,
  },
});

export const healthRouter: Router = Router();

healthRouter.get('/health', healthController.health);
healthRouter.get('/ready', asyncHandler(healthController.ready));
