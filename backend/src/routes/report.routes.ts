import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import { REPORT_KINDS, reportQuerySchema } from '@shared/schemas/fulfilment';

import { adminReportController } from '../controllers/report.controller';
import { commonErrorResponses, jsonContent, registry, successBodySchema, z } from '../docs/registry';
import { asyncHandler, authenticate, requirePermission, validate } from '../middleware';

/**
 * Prompt 9B slice D — operational reports.
 *
 * One route, six reports, selected by `kind`. Six near-identical routes would be six places to
 * forget the date cap and six paths to audit.
 *
 * Nothing is stored: a report is generated from the ledger on request, so the figure in the file
 * is the figure the ledger holds now rather than one that was true when somebody last pressed a
 * button.
 */

const ADMIN_PREFIX = `${API_PREFIX}/admin`;

export const adminReportRouter: Router = Router();

const reportTotalsSchema = registry.register(
  'ReportTotals',
  z
    .object({
      kind: z.string().openapi({ example: 'SALES_SUMMARY' }),
      rowCount: z.number().int(),
      totals: z
        .record(z.number())
        .describe('The figures the report footed to, for reconciliation against the ledger.'),
    })
    .passthrough(),
);

const csvResponse = {
  description: 'The report as CSV. Cells beginning = + - @ are neutralised against formula injection.',
  content: { 'text/csv': { schema: z.string() } },
};

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/reports`,
  tags: ['Admin reports'],
  summary: 'Admin: generate an operational report',
  description:
    `One of ${REPORT_KINDS.join(', ')}. \`from\` and \`to\` are required and may not span more ` +
    'than 366 days. `format=json` returns only the totals, which is what a dashboard wants; ' +
    '`format=csv` (the default) streams the rows.',
  security: [{ adminBearer: [] }],
  request: { query: reportQuerySchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(reportTotalsSchema), 'Report totals (format=json)'),
    201: csvResponse,
  },
});

adminReportRouter.get(
  '/reports',
  authenticate('ADMIN'),
  // Reports expose revenue, payouts and refunds. Reading an order is not the same privilege.
  requirePermission('payment.settings.read'),
  validate({ query: reportQuerySchema }),
  asyncHandler(adminReportController.generate),
);
