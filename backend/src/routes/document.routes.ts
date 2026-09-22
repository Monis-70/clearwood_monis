import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import { idParamSchema } from '@shared/schemas/common';
import { documentListQuerySchema } from '@shared/schemas/fulfilment';
import { orderNumberParamSchema } from '@shared/schemas/order';

import {
  adminDocumentController,
  customerDocumentController,
} from '../controllers/document.controller';
import {
  commonErrorResponses,
  jsonContent,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';
import { asyncHandler, authenticate, idempotency, requirePermission, validate } from '../middleware';
import { csrfProtection } from '../modules/auth/csrf.service';

/**
 * Prompt 9B slice B — GST tax invoices and credit notes.
 *
 * A tax invoice is a legal document, so the routes are deliberately narrow: issue once, download
 * many times, never regenerate. There is no update and no delete.
 */

const ADMIN_PREFIX = `${API_PREFIX}/admin`;

const adminGuard = [authenticate('ADMIN'), csrfProtection('ADMIN')];

export const documentRouter: Router = Router();
export const adminDocumentRouter: Router = Router();

const documentSchema = registry.register(
  'OrderDocument',
  z
    .object({
      type: z.string().openapi({ example: 'TAX_INVOICE' }),
      documentNumber: z.string().nullable().openapi({ example: 'INV/2026-27/000001' }),
      totalPaise: z.number().int(),
      taxPaise: z.number().int(),
      sizeBytes: z.number().int(),
      checksum: z.string().describe('SHA-256 of the stored bytes, re-verified on every download'),
      issuedAt: z.string(),
    })
    .passthrough(),
);

const documentNumberParamSchema = z.object({
  documentNumber: z
    .string()
    .trim()
    .toUpperCase()
    .min(4)
    .max(48)
    .regex(/^[A-Z0-9/-]+$/, 'invalid document number'),
});

const pdfResponse = {
  description: 'The stored PDF',
  content: { 'application/pdf': { schema: z.string().openapi({ format: 'binary' }) } },
};

/* ----------------------------------------------------------- OpenAPI docs */

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/orders/{orderNumber}/documents`,
  tags: ['Admin documents'],
  summary: 'Admin: documents issued for an order',
  security: [{ adminBearer: [] }],
  request: { params: orderNumberParamSchema, query: documentListQuerySchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(documentSchema)), 'Documents'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/orders/{orderNumber}/documents/invoice`,
  tags: ['Admin documents'],
  summary: 'Admin: issue the GST tax invoice',
  description:
    'Issued ONCE and never regenerated: the bytes are stored and checksummed, and a second call ' +
    'returns the original. If the figures are wrong the remedy is a credit note, not a new PDF.',
  security: [{ adminBearer: [] }],
  request: { params: orderNumberParamSchema },
  responses: {
    ...commonErrorResponses,
    201: jsonContent(successBodySchema(documentSchema), 'Invoice issued'),
  },
});

registry.registerPath({
  method: 'post',
  path: `${ADMIN_PREFIX}/refunds/{id}/credit-note`,
  tags: ['Admin documents'],
  summary: 'Admin: issue the credit note for a processed refund',
  description:
    'A refund without a credit note is a GST problem: output tax declared on the invoice has to ' +
    'be reversed on a document the department can see. One credit note per refund.',
  security: [{ adminBearer: [] }],
  request: { params: idParamSchema },
  responses: {
    ...commonErrorResponses,
    201: jsonContent(successBodySchema(documentSchema), 'Credit note issued'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/documents/{documentNumber}/download`,
  tags: ['Admin documents'],
  summary: 'Admin: download a document',
  description: 'The stored checksum is re-verified; a mismatched document is refused, not served.',
  security: [{ adminBearer: [] }],
  request: { params: documentNumberParamSchema },
  responses: { ...commonErrorResponses, 200: pdfResponse },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/me/orders/{orderNumber}/documents`,
  tags: ['My orders'],
  summary: 'Documents issued for one of my orders',
  security: [{ customerBearer: [] }],
  request: { params: orderNumberParamSchema },
  responses: {
    ...commonErrorResponses,
    200: jsonContent(successBodySchema(z.array(documentSchema)), 'Documents'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${API_PREFIX}/me/orders/{orderNumber}/invoice`,
  tags: ['My orders'],
  summary: 'Download my tax invoice',
  security: [{ customerBearer: [] }],
  request: { params: orderNumberParamSchema },
  responses: { ...commonErrorResponses, 200: pdfResponse },
});

/* ------------------------------------------------------------------ routes */

adminDocumentRouter.get(
  '/orders/:orderNumber/documents',
  authenticate('ADMIN'),
  requirePermission('order.order.read'),
  validate({ params: orderNumberParamSchema, query: documentListQuerySchema }),
  asyncHandler(adminDocumentController.list),
);

adminDocumentRouter.post(
  '/orders/:orderNumber/documents/invoice',
  ...adminGuard,
  requirePermission('order.order.update'),
  idempotency('invoice-issue'),
  validate({ params: orderNumberParamSchema }),
  asyncHandler(adminDocumentController.issueInvoice),
);

adminDocumentRouter.post(
  '/refunds/:id/credit-note',
  ...adminGuard,
  requirePermission('order.refund.approve'),
  idempotency('credit-note-issue'),
  validate({ params: idParamSchema }),
  asyncHandler(adminDocumentController.issueCreditNote),
);

adminDocumentRouter.get(
  '/documents/:documentNumber/download',
  authenticate('ADMIN'),
  requirePermission('order.order.read'),
  validate({ params: documentNumberParamSchema }),
  asyncHandler(adminDocumentController.download),
);

documentRouter.get(
  '/me/orders/:orderNumber/documents',
  authenticate('CUSTOMER'),
  validate({ params: orderNumberParamSchema }),
  asyncHandler(customerDocumentController.list),
);

documentRouter.get(
  '/me/orders/:orderNumber/invoice',
  authenticate('CUSTOMER'),
  validate({ params: orderNumberParamSchema }),
  asyncHandler(customerDocumentController.download),
);
