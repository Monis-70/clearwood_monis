import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import { REPORT_KINDS, reportQuerySchema } from '@shared/schemas/fulfilment';

import { adminReportController } from '../controllers/report.controller';
import {
  commonErrorResponses,
  errorBodySchema,
  jsonContent,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';
import { asyncHandler, authenticate, requireAnyPermission, validate } from '../middleware';
import { REPORT_PERMISSIONS } from '../modules/reports/report.service';

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
    '`format=csv` (the default) streams the rows. Each kind needs the permission for its data: ' +
    Object.entries(REPORT_PERMISSIONS)
      .map(([kind, permission]) => `${kind} \u2192 \`${permission}\``)
      .join(', ') +
    '.',
  security: [{ adminBearer: [] }],
  request: { query: reportQuerySchema },
  responses: {
    ...commonErrorResponses,
    200: {
      description: 'CSV rows (format=csv, the default) or the totals envelope (format=json)',
      content: {
        ...csvResponse.content,
        'application/json': { schema: successBodySchema(reportTotalsSchema) },
      },
    },
    403: jsonContent(errorBodySchema, 'Missing the permission this report kind needs'),
  },
});

adminReportRouter.get(
  '/reports',
  authenticate('ADMIN'),
  // Coarse gate only; the controller then requires the permission of the chosen kind.
  requireAnyPermission([...new Set(Object.values(REPORT_PERMISSIONS))]),
  validate({ query: reportQuerySchema }),
  asyncHandler(adminReportController.generate),
);
