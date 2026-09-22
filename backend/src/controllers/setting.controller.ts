import type { Request, Response } from 'express';

import type { PublicSettingsQuery } from '../schemas/setting.schema';
import { settingService } from '../services/setting.service';
import { ok } from '../utils/response';

export const settingController = {
  async listPublic(req: Request, res: Response): Promise<void> {
    const { group } = req.query as unknown as PublicSettingsQuery;
    ok(res, await settingService.getPublicSettings(group));
  },
};
