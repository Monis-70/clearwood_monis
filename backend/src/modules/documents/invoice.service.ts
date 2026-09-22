import type { DocumentType } from '@shared/enums';

import { logger } from '../../config/logger';
import { storage } from '../../container';
import {
  documentRepository,
  documentSequenceRepository,
} from '../../repositories/document.repository';
import { orderRepository, type OrderWithDetail } from '../../repositories/order.repository';
import { AppError } from '../../utils/AppError';
import { notificationService } from '../notifications/notification.service';
import { financialYearKey } from '../orders/orderNumber.service';

import { amountInWords } from './amountInWords';
import {
  checksumOf,
  renderInvoicePdf,
  type InvoiceDocumentData,
  type InvoiceLine,
  type InvoiceParty,
} from './pdf.renderer';

/**
 * GST tax invoices and credit notes.
 *
 * THREE RULES, all of them legal rather than technical:
 *
 *  1. **An invoice is issued once and never regenerated.** If the figures were wrong, the remedy is
 *     a credit note, not a new PDF. So the bytes are stored, checksummed, and re-served — never
 *     re-rendered on download.
 *  2. **The numbering is gapless and per financial year.** GST requires an unbroken series;
 *     `DocumentSequence` allocates by compare-and-set so concurrency cannot skip or repeat one.
 *  3. **Everything comes from the FROZEN order snapshot.** An invoice re-derived from today's
 *     catalog would change when a price changes, which is precisely what an invoice must not do.
 *
 * CGST/SGST vs IGST is decided by the place of supply on the order, not by re-deciding it here.
 */

const PREFIX: Record<string, string> = {
  TAX_INVOICE: 'invoice',
  CREDIT_NOTE: 'credit-note',
};

async function sellerParty(): Promise<InvoiceParty> {
  const { prisma } = await import('../../config/prisma');

  // Read directly: these are private settings and the public cache deliberately excludes them.
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: 'seller.' } },
    select: { key: true, value: true },
  });

  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));

  return {
    name: settings['seller.legal_name'] ?? 'ClearWood Furnitures Private Limited',
    gstin: settings['seller.gstin'] ?? null,
    address: String(settings['seller.address'] ?? '')
      .split(', ')
      .filter(Boolean),
    stateCode: settings['seller.state_code'] ?? 'MH',
  };
}

function addressParty(address: {
  fullName: string;
  phone: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
}): InvoiceParty {
  return {
    name: address.fullName,
    phone: address.phone,
    address: [
      address.line1,
      address.line2 ?? '',
      address.landmark ?? '',
      `${address.city}, ${address.state} ${address.pincode}`,
    ].filter(Boolean),
    stateCode: address.stateCode,
  };
}

export const invoiceService = {
  /** `INV/2026-27/000001`, gapless within the financial year. */
  async allocateNumber(type: DocumentType, now = new Date()): Promise<string> {
    const { env } = await import('../../config/env');

    const prefix = type === 'CREDIT_NOTE' ? env.CREDIT_NOTE_PREFIX : env.INVOICE_NUMBER_PREFIX;
    const fy = financialYearKey(now);
    const sequence = await documentSequenceRepository.next(`${PREFIX[type] ?? type}:${fy}`, prefix);

    return `${prefix}/${fy}/${String(sequence).padStart(6, '0')}`;
  },

  /**
   * Issues the tax invoice for an order, or returns the one already issued.
   *
   * Idempotent by design: a second call is a no-op that hands back the original document, because
   * issuing a second invoice for one order is a GST problem, not a convenience.
   */
  async issueInvoice(orderNumber: string) {
    const order = await orderRepository.findByNumber(orderNumber);
    if (!order) throw AppError.notFound('Order not found');

    const existing = await documentRepository.findForOrder(order.id, 'TAX_INVOICE');
    if (existing) return existing;

    // An invoice is a demand for money that has been agreed; a draft has agreed nothing.
    if (!['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURN_REQUESTED', 'RETURNED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.status)) {
      throw new AppError(
        422,
        'INVOICE_NOT_ISSUABLE',
        `An order in ${order.status} cannot be invoiced`,
        { status: order.status },
      );
    }

    const documentNumber = await this.allocateNumber('TAX_INVOICE');
    const data = await this.buildInvoiceData(order, documentNumber, 'TAX_INVOICE');
    const rendered = await renderInvoicePdf(data);

    const storageKey = `documents/${order.id}/${documentNumber.replace(/\//g, '-')}.pdf`;
    await storage.put(storageKey, rendered.bytes, { contentType: 'application/pdf' });

    const document = await documentRepository.create({
      orderId: order.id,
      type: 'TAX_INVOICE',
      documentNumber,
      storageKey,
      mimeType: 'application/pdf',
      sizeBytes: rendered.bytes.length,
      checksum: rendered.checksum,
      totalPaise: data.totalPaise,
      taxPaise: data.cgstPaise + data.sgstPaise + data.igstPaise,
    });

    logger.info({ orderNumber, documentNumber, bytes: rendered.bytes.length }, 'tax invoice issued');

    await notificationService.dispatch(
      'INVOICE_ISSUED',
      { orderId: order.id },
      { documentNumber },
    );

    return document;
  },

  /**
   * Issues a credit note against a processed refund.
   *
   * A refund without a credit note is a GST problem: output tax was declared on the invoice and
   * has to be reversed on a document the department can see.
   */
  async issueCreditNote(refundId: string) {
    const { prisma } = await import('../../config/prisma');

    const refund = await prisma.refund.findUnique({
      where: { id: refundId },
      include: { items: true },
    });

    if (!refund) throw AppError.notFound('Refund not found');

    if (refund.status !== 'PROCESSED') {
      throw new AppError(
        422,
        'CREDIT_NOTE_NOT_ISSUABLE',
        'A credit note follows a processed refund',
        { status: refund.status },
      );
    }

    // One credit note per refund, enforced by a unique column rather than by counting rows.
    const already = await prisma.orderDocument.findFirst({ where: { refundId } });
    if (already) return already;

    const order = await orderRepository.findById(refund.orderId);
    if (!order) throw AppError.notFound('Order not found');

    const invoice = await documentRepository.findForOrder(order.id, 'TAX_INVOICE');

    const documentNumber = await this.allocateNumber('CREDIT_NOTE');
    const data = await this.buildCreditNoteData(
      order,
      documentNumber,
      refund,
      invoice?.documentNumber ?? null,
    );
    const rendered = await renderInvoicePdf(data);

    const storageKey = `documents/${order.id}/${documentNumber.replace(/\//g, '-')}.pdf`;
    await storage.put(storageKey, rendered.bytes, { contentType: 'application/pdf' });

    const document = await documentRepository.create({
      orderId: order.id,
      refundId,
      type: 'CREDIT_NOTE',
      documentNumber,
      storageKey,
      mimeType: 'application/pdf',
      sizeBytes: rendered.bytes.length,
      checksum: rendered.checksum,
      totalPaise: data.totalPaise,
      taxPaise: data.cgstPaise + data.sgstPaise + data.igstPaise,
    });

    logger.info(
      { orderNumber: order.orderNumber, documentNumber, refundNumber: refund.refundNumber },
      'credit note issued',
    );

    return document;
  },

  /* ---------------------------------------------------------- rendering */

  async buildInvoiceData(
    order: OrderWithDetail,
    documentNumber: string,
    kind: 'TAX_INVOICE',
  ): Promise<InvoiceDocumentData> {
    const seller = await sellerParty();

    const billing = order.addresses.find((address) => address.type === 'BILLING');
    const shipping = order.addresses.find((address) => address.type === 'SHIPPING');
    const primary = billing ?? shipping;

    if (!primary) throw new AppError(422, 'ORDER_ADDRESS_MISSING', 'This order has no address');

    // IGST when the buyer's state differs from ours; the order already froze both.
    const isInterState = order.igstPaise > 0;

    const lines: InvoiceLine[] = order.items.map((item) => ({
      description: item.variantName ? `${item.productName} (${item.variantName})` : item.productName,
      hsnCode: item.hsnCode,
      qty: item.qty,
      unitPricePaise: item.unitPricePaise,
      discountPaise: item.lineDiscountPaise,
      taxablePaise: item.taxablePaise,
      taxRateBp: item.taxRateBp,
      cgstPaise: item.cgstPaise,
      sgstPaise: item.sgstPaise,
      igstPaise: item.igstPaise,
      totalPaise: item.lineTotalPaise,
    }));

    return {
      kind,
      documentNumber,
      issuedAt: order.placedAt ?? order.createdAt,
      orderNumber: order.orderNumber,
      orderPlacedAt: order.placedAt,
      seller,
      billTo: addressParty(primary),
      shipTo: shipping && billing ? addressParty(shipping) : null,
      placeOfSupply: `${primary.state} (${primary.stateCode})`,
      isInterState,
      lines,
      subtotalPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      shippingPaise: order.shippingPaise,
      cgstPaise: order.cgstPaise,
      sgstPaise: order.sgstPaise,
      igstPaise: order.igstPaise,
      roundingPaise: order.roundingPaise,
      totalPaise: order.grandTotalPaise,
      amountInWords: amountInWords(order.grandTotalPaise),
      notes: [
        'Goods once sold are covered by the ClearWood warranty terms.',
        `Invoice raised under GSTIN ${seller.gstin ?? '-'}.`,
      ],
    };
  },

  async buildCreditNoteData(
    order: OrderWithDetail,
    documentNumber: string,
    refund: { refundNumber: string; amountPaise: number; items: { orderItemId: string; qty: number; amountPaise: number; taxPaise: number }[] },
    againstDocumentNumber: string | null,
  ): Promise<InvoiceDocumentData> {
    const seller = await sellerParty();

    const billing = order.addresses.find((address) => address.type === 'BILLING');
    const shipping = order.addresses.find((address) => address.type === 'SHIPPING');
    const primary = billing ?? shipping;

    if (!primary) throw new AppError(422, 'ORDER_ADDRESS_MISSING', 'This order has no address');

    const isInterState = order.igstPaise > 0;
    const itemsById = new Map(order.items.map((item) => [item.id, item]));

    const lines: InvoiceLine[] = refund.items.map((entry) => {
      const source = itemsById.get(entry.orderItemId);
      const taxable = entry.amountPaise - entry.taxPaise;

      // Tax splits follow the ORIGINAL invoice's treatment, never a fresh decision.
      const half = Math.round(entry.taxPaise / 2);

      return {
        description: source
          ? source.variantName
            ? `${source.productName} (${source.variantName})`
            : source.productName
          : 'Refunded item',
        hsnCode: source?.hsnCode ?? null,
        qty: entry.qty,
        unitPricePaise: entry.qty > 0 ? Math.round(entry.amountPaise / entry.qty) : 0,
        discountPaise: 0,
        taxablePaise: taxable,
        taxRateBp: source?.taxRateBp ?? 0,
        cgstPaise: isInterState ? 0 : half,
        sgstPaise: isInterState ? 0 : entry.taxPaise - half,
        igstPaise: isInterState ? entry.taxPaise : 0,
        totalPaise: entry.amountPaise,
      };
    });

    const taxTotal = lines.reduce(
      (sum, line) => sum + line.cgstPaise + line.sgstPaise + line.igstPaise,
      0,
    );
    const taxableTotal = lines.reduce((sum, line) => sum + line.taxablePaise, 0);

    return {
      kind: 'CREDIT_NOTE',
      documentNumber,
      issuedAt: new Date(),
      orderNumber: order.orderNumber,
      orderPlacedAt: order.placedAt,
      againstDocumentNumber,
      seller,
      billTo: addressParty(primary),
      shipTo: null,
      placeOfSupply: `${primary.state} (${primary.stateCode})`,
      isInterState,
      lines,
      subtotalPaise: taxableTotal,
      discountPaise: 0,
      shippingPaise: 0,
      cgstPaise: isInterState ? 0 : lines.reduce((sum, line) => sum + line.cgstPaise, 0),
      sgstPaise: isInterState ? 0 : lines.reduce((sum, line) => sum + line.sgstPaise, 0),
      igstPaise: isInterState ? taxTotal : 0,
      roundingPaise: 0,
      totalPaise: refund.amountPaise,
      amountInWords: amountInWords(refund.amountPaise),
      notes: [`Issued against refund ${refund.refundNumber}.`],
    };
  },

  /* ---------------------------------------------------------- retrieval */

  listForOrder(orderId: string, type?: DocumentType) {
    return documentRepository.listForOrder(orderId, type);
  },

  /**
   * Fetches the stored bytes and VERIFIES the checksum.
   *
   * The point of storing a checksum is to use it. A mismatch means the stored document is not the
   * one we issued, which is a serious enough condition to refuse the download rather than serve a
   * file whose figures nobody can vouch for.
   */
  async download(documentNumber: string): Promise<{ bytes: Buffer; mimeType: string; documentNumber: string }> {
    const document = await documentRepository.findByNumber(documentNumber);
    if (!document) throw AppError.notFound('Document not found');

    const bytes = await storage.get(document.storageKey);

    if (checksumOf(bytes) !== document.checksum) {
      logger.error(
        { documentNumber, storageKey: document.storageKey },
        'stored document does not match its checksum',
      );

      throw new AppError(
        409,
        'DOCUMENT_CHECKSUM_MISMATCH',
        'This document does not match the copy we issued and will not be served',
      );
    }

    return { bytes, mimeType: document.mimeType, documentNumber };
  },
};
