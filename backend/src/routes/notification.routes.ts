import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import {
  notificationLogQuerySchema,
  notificationTemplateSchema,
} from '@shared/schemas/fulfilment';

import { adminNotificationController } from '../controllers/notification.controller';
import {
  commonErrorResponses,
  jsonContent,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';
import { asyncHandler, authenticate, requirePermission, validate } from '../middleware';
import { csrfProtection } from '../modules/auth/csrf.service';

/**
 * Prompt 9B slice C — order-lifecycle notifications.
 *
 * Admin-only and deliberately read-mostly. There is no "send" route: a notification is a
 * consequence of a business event, and a button that emails a customer "your order has shipped"
 * when it has not is a way to lie to them from the console. The only write is to the wording.
 *
 * There is no delete for logs either — the log is the evidence that we did or did not tell
 * somebody something, which is exactly the kind of record that gets asked for afterwards.
 */

const ADMIN_PREFIX = `${API_PREFIX}/admin`;

const adminGuard = [authenticate('ADMIN'), csrfProtection('ADMIN')];

export const adminNotificationRouter: Router = Router();

const templateSchema = registry.register(
  'NotificationTemplate',
  z
    .object({
      id: z.string(),
      event: z.string().openapi({ example: 'ORDER_CONFIRMED' }),
      channel: z.string().openapi({ example: 'EMAIL' }),
      subject: z.string().nullable(),
      body: z.string(),
      isActive: z.boolean(),
      version: z.number().int(),
      tokens: z
        .array(z.string())
        .describe('The {{tokens}} this template references. Anything else renders empty.'),
      updatedAt: z.string(),
    })
    .passthrough(),
);

const logSchema = registry.register(
  'NotificationLog',
  z
    .object({
      id: z.string(),
      event: z.string(),
      channel: z.string(),
      recipient: z
        .string()
        .describe('Masked at write time, e.g. "ra***@example.com". No plaintext copy is kept.')
        .openapi({ example: 'ra***@example.com' }),
      subject: z.string().nullable(),
      status: z.string().openapi({ example: 'SENT' }),
      error: z.string().nullable(),
      orderId: z.string().nullable(),
      sentAt: z.string().nullable(),
      createdAt: z.string(),
    })
    .passthrough(),
);

/* ----------------------------------------------------------- OpenAPI docs */

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/notifications/templates`,
  tags: ['Admin notifications'],
  summary: 'Admin: list the notification templates',
  description:
    'Eight order-lifecycle events have a seeded EMAIL template. Events without one are raised ' +
    'internally and send nothing.',
  security: [{ adminBearer: [] }],
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(templateSchema)), 'Templates'),
  },
});

registry.registerPath({
  method: 'put',
  path: `${ADMIN_PREFIX}/notifications/templates`,
  tags: ['Admin notifications'],
  summary: 'Admin: create or update a template',
  description:
    'Upsert by (event, channel). Tokens are whitelisted: `{{orderNumber}}` and the rest of the ' +
    'documented vocabulary are substituted, anything else renders as an empty string. No ' +
    'expression of any kind is evaluated.',
  security: [{ adminBearer: [] }],
  request: { body: jsonContent(notificationTemplateSchema, 'Template') },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(templateSchema), 'Saved'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/notifications/logs`,
  tags: ['Admin notifications'],
  summary: 'Admin: what was sent, and what failed',
  description:
    'Every attempt is here, including SKIPPED and FAILED. A notification failure never fails the ' +
    'order it belongs to, so this log is the only place a failure is visible.',
  security: [{ adminBearer: [] }],
  request: { query: notificationLogQuerySchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(logSchema)), 'Notification log'),
  },
});

/* --------------------------------------------------------------- routes */

adminNotificationRouter.get(
  '/notifications/templates',
  authenticate('ADMIN'),
  requirePermission('system.setting.read'),
  asyncHandler(adminNotificationController.listTemplates),
);

adminNotificationRouter.put(
  '/notifications/templates',
  ...adminGuard,
  requirePermission('system.setting.update'),
  validate({ body: notificationTemplateSchema }),
  asyncHandler(adminNotificationController.upsertTemplate),
);

adminNotificationRouter.get(
  '/notifications/logs',
  authenticate('ADMIN'),
  requirePermission('order.order.read'),
  validate({ query: notificationLogQuerySchema }),
  asyncHandler(adminNotificationController.listLogs),
);
