import type { Request, Response } from 'express';

import type { DocumentListQuery } from '@shared/schemas/fulfilment';

import { auditService } from '../modules/auth/audit.service';
import { invoiceService } from '../modules/documents/invoice.service';
import { orderRepository } from '../repositories/order.repository';
import { AppError } from '../utils/AppError';
import { created, ok } from '../utils/response';

/** R1 — thin: resolve the caller, call a service, answer through the one envelope. */

function toDto(document: {
  id: string;
  type: string;
  documentNumber: string | null;
  totalPaise: number;
  taxPaise: number;
  sizeBytes: number;
  checksum: string;
  issuedAt: Date;
}) {
  return {
    id: document.id,
    type: document.type,
    documentNumber: document.documentNumber,
    totalPaise: document.totalPaise,
    taxPaise: document.taxPaise,
    sizeBytes: document.sizeBytes,
    checksum: document.checksum,
    issuedAt: document.issuedAt.toISOString(),
  };
}

/**
 * Streams the stored bytes.
 *
 * `download()` re-verifies the checksum first, so a document whose stored copy no longer matches
 * what we issued is refused rather than served.
 */
async function send(res: Response, documentNumber: string): Promise<void> {
  const document = await invoiceService.download(documentNumber);

  res.setHeader('Content-Type', document.mimeType);
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${document.documentNumber.replace(/\//g, '-')}.pdf"`,
  );
  res.send(document.bytes);
}

export const adminDocumentController = {
  async list(req: Request, res: Response): Promise<void> {
    const { orderNumber } = req.params as { orderNumber: string };
    const query = req.query as unknown as DocumentListQuery;

    const order = await orderRepository.findByNumber(orderNumber);
    if (!order) throw AppError.notFound('Order not found');

    const documents = await invoiceService.listForOrder(order.id, query.type);
    ok(res, documents.map(toDto));
  },

  async issueInvoice(req: Request, res: Response): Promise<void> {
    const { orderNumber } = req.params as { orderNumber: string };
    const document = await invoiceService.issueInvoice(orderNumber);

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'OrderDocument',
      entityId: document.id,
      severity: 'CRITICAL',
      meta: { documentNumber: document.documentNumber, orderNumber },
    });

    created(res, toDto(document));
  },

  async issueCreditNote(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const document = await invoiceService.issueCreditNote(id);

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'OrderDocument',
      entityId: document.id,
      severity: 'CRITICAL',
      meta: { documentNumber: document.documentNumber, refundId: id },
    });

    created(res, toDto(document));
  },

  async download(req: Request, res: Response): Promise<void> {
    const { documentNumber } = req.params as { documentNumber: string };
    await send(res, documentNumber);
  },
};

export const customerDocumentController = {
  /** A customer may download the invoice for their own order, and nothing else. */
  async download(req: Request, res: Response): Promise<void> {
    if (req.auth?.realm !== 'CUSTOMER') {
      throw new AppError(401, 'NOT_AUTHENTICATED', 'Sign in to continue');
    }

    const { orderNumber } = req.params as { orderNumber: string };
    const order = await orderRepository.findByNumber(orderNumber);

    // 404 rather than 403: whether somebody else's order exists is not their business.
    if (!order || order.customerId !== req.auth.principalId) {
      throw AppError.notFound('Order not found');
    }

    const invoice = (await invoiceService.listForOrder(order.id, 'TAX_INVOICE'))[0];
    if (!invoice?.documentNumber) throw AppError.notFound('No invoice has been issued yet');

    await send(res, invoice.documentNumber);
  },

  async list(req: Request, res: Response): Promise<void> {
    if (req.auth?.realm !== 'CUSTOMER') {
      throw new AppError(401, 'NOT_AUTHENTICATED', 'Sign in to continue');
    }

    const { orderNumber } = req.params as { orderNumber: string };
    const order = await orderRepository.findByNumber(orderNumber);

    if (!order || order.customerId !== req.auth.principalId) {
      throw AppError.notFound('Order not found');
    }

    ok(res, (await invoiceService.listForOrder(order.id)).map(toDto));
  },
};
