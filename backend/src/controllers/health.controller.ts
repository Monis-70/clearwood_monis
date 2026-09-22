import type { Request, Response } from 'express';

import { healthService } from '../services/health.service';
import { AppError } from '../utils/AppError';
import { ok } from '../utils/response';

/** R1 — controllers stay thin: no Prisma, no business logic, no hand-written envelopes. */
export const healthController = {
  health(_req: Request, res: Response): void {
    ok(res, healthService.getHealth());
  },

  async ready(_req: Request, res: Response): Promise<void> {
    const report = await healthService.getReadiness();

    if (report.status !== 'ready') {
      // 503 still carries the per-dependency detail so an operator can see what is down.
      throw AppError.serviceUnavailable('One or more dependencies are unavailable', report);
    }

    ok(res, report);
  },
};
