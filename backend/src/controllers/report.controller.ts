import type { Request, Response } from 'express';

import type { ReportQuery } from '@shared/schemas/fulfilment';

import { auditService } from '../modules/auth/audit.service';
import { reportService, type ReportKind } from '../modules/reports/report.service';
import { ok } from '../utils/response';

/** R1 — thin: resolve the caller, call a service, answer through the one envelope. */

export const adminReportController = {
  async generate(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as ReportQuery;

    const report = await reportService.generate(query.kind as ReportKind, {
      from: query.from,
      to: query.to,
    });

    // Who pulled which figures, and for what period. Financial exports leave the building.
    await auditService.recordFromRequest(req, {
      action: 'EXPORT',
      entity: 'Report',
      entityId: report.kind,
      severity: 'NOTICE',
      meta: {
        kind: report.kind,
        from: query.from.toISOString(),
        to: query.to.toISOString(),
        rowCount: report.rowCount,
      },
    });

    if (query.format === 'json') {
      ok(res, { kind: report.kind, rowCount: report.rowCount, totals: report.totals });
      return;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
    res.send(report.csv);
  },
};
