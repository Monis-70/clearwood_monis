import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';

import { settingController } from '../controllers/setting.controller';
import {
  commonErrorResponses,
  jsonContent,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';
import { asyncHandler, validate } from '../middleware';
import { publicSettingsQuerySchema } from '../schemas/setting.schema';

const publicSettingsSchema = registry.register(
  'PublicSettings',
  z.record(z.any()).openapi({
    description:
      'Flat key/value map of every AppSetting with isPublic=true. R8/R9 — the storefront reads its ' +
      'phone number, GST percent, USP line and so on from here, never from hardcoded values.',
    example: {
      'site.name': 'ClearWood Furnitures',
      'site.currency': 'INR',
      'site.gst_percent': 18,
      'site.usp_line': '100% in-house manufacturing. Zero outsourcing.',
    },
  }),
);

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/settings/public`,
  tags: ['Settings'],
  summary: 'Public application settings',
  request: { query: publicSettingsQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(publicSettingsSchema), 'Public settings'),
    ...commonErrorResponses,
  },
});

export const settingRouter: Router = Router();

settingRouter.get(
  '/settings/public',
  validate({ query: publicSettingsQuerySchema }),
  asyncHandler(settingController.listPublic),
);
