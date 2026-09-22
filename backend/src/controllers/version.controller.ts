import type { Request, Response } from 'express';

import { versionService } from '../services/version.service';
import { ok } from '../utils/response';

export const versionController = {
  get(_req: Request, res: Response): void {
    ok(res, versionService.getVersion());
  },
};
