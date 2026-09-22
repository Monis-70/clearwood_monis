import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import {
  CACHE_DRIVERS,
  DATABASE_PROVIDERS,
  MAIL_DRIVERS,
  OTP_DRIVERS,
  PAYMENT_DRIVERS,
  STORAGE_DRIVERS,
} from '@shared/enums';

import { versionController } from '../controllers/version.controller';
import {
  commonErrorResponses,
  jsonContent,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';

const versionSchema = registry.register(
  'Version',
  z.object({
    name: z.string().openapi({ example: 'ClearWood Furnitures' }),
    version: z.string().openapi({ example: '0.1.0' }),
    env: z.enum(['development', 'test', 'production']),
    drivers: z.object({
      db: z.enum(DATABASE_PROVIDERS),
      cache: z.enum(CACHE_DRIVERS),
      storage: z.enum(STORAGE_DRIVERS),
      mail: z.enum(MAIL_DRIVERS),
      payment: z.enum(PAYMENT_DRIVERS),
      otp: z.enum(OTP_DRIVERS),
    }),
  }),
);

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/version`,
  tags: ['System'],
  summary: 'Build and active driver information',
  description: 'Shows which driver each external dependency is currently bound to.',
  responses: {
    200: jsonContent(successBodySchema(versionSchema), 'Build information'),
    ...commonErrorResponses,
  },
});

export const versionRouter: Router = Router();

versionRouter.get('/version', versionController.get);
