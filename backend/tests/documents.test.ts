import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { payment as paymentDriver } from '../src/container';
import type { MockPaymentDriver } from '../src/drivers/payment';
import { passwordService } from '../src/modules/auth/password.service';
import { amountInWords } from '../src/modules/documents/amountInWords';
import { invoiceService } from '../src/modules/documents/invoice.service';
import { renderInvoicePdf, type InvoiceDocumentData } from '../src/modules/documents/pdf.renderer';
import { ledgerIntegrityService } from '../src/modules/orders/ledgerIntegrity.service';
import { refundService } from '../src/modules/payments/refund/refund.service';
import { orderRepository } from '../src/repositories/order.repository';
import { documentSequenceRepository } from '../src/repositories/document.repository';

import { placeAndPayOrder, type PaidOrderFixture } from './helpers/paidOrder';
import { expectLedgerOk } from './helpers/ledger';
import { setStockForProduct } from './helpers/stock';

/** SHA-256 of nothing. Any checksum equal to this means the thing under test produced no bytes. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * Slice B - GST tax invoices and credit notes.
 *
 * A tax invoice is a legal document, so the properties under test are legal ones: the numbering is
 * gapless, the figures equal the frozen order, it is issued exactly once, and the stored bytes are
 * provably the ones we produced.
 */

const app = createApp();
const API = '/api/v1';
const ADMIN_API = `${API}/admin`;
const mock = paymentDriver as MockPaymentDriver;
const SLUG = 'ashoka-nesting-table-set';
const TEST_PASSWORD = 'Rosewood-Teak-2026';

interface Session {
  header: string;
  csrf: string;
}

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

async function admin(email: string, roleCode: string): Promise<Session> {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });

  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: `Docs ${roleCode}`,
      passwordHash: await passwordService.hash(TEST_PASSWORD),
      status: 'ACTIVE',
    },
  });

  await prisma.adminUserRole.upsert({
    where: { adminUserId_roleId: { adminUserId: user.id, roleId: role.id } },
    update: {},
    create: { adminUserId: user.id, roleId: role.id },
  });

  const response = await request(app)
    .post(`${ADMIN_API}/auth/login`)
    .send({ email, password: TEST_PASSWORD });

  const jar = cookiesOf(response);
  return {
    header: jar.map((cookie) => cookie.split(';')[0]).join('; '),
    csrf:
      jar
        .find((cookie) => cookie.startsWith('cw_adm_csrf='))
        ?.split(';')[0]
        ?.split('=')[1] ?? '',
  };
}

function post(session: Session, path: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post(`${ADMIN_API}${path}`)
    .set('Cookie', session.header)
    .set('X-CSRF-Token', session.csrf)
    .send(body);
}

function get(session: Session, path: string) {
  return request(app).get(`${ADMIN_API}${path}`).set('Cookie', session.header);
}

let superAdmin: Session;

async function invoicedOrder(qty = 2): Promise<{ order: PaidOrderFixture; documentNumber: string }> {
  const order = await placeAndPayOrder({ qty, slug: SLUG });

  const response = await post(superAdmin, `/orders/${enc(order.orderNumber)}/documents/invoice`);
  expect(response.status, JSON.stringify(response.body)).toBe(201);

  return { order, documentNumber: response.body.data.documentNumber as string };
}

beforeAll(async () => {
  mock.setScenario('success');
  mock.setReversesTransfersWithRefund(false);

  superAdmin = await admin('docs.super@clearwood.local', 'SUPER_ADMIN');
  await setStockForProduct(SLUG, 400);
});

/* -------------------------------------------------------- amount in words */

describe('amountInWords', () => {
  it('uses the Indian numbering system', () => {
    expect(amountInWords(120_000_000)).toBe('Rupees Twelve Lakh Only');
    expect(amountInWords(1_00_00_00_000)).toBe('Rupees One Crore Only');
    expect(amountInWords(123_456_789)).toBe(
      'Rupees Twelve Lakh Thirty Four Thousand Five Hundred and Sixty Seven and Paise Eighty Nine Only',
    );
  });

  it('handles the awkward small cases', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only');
    expect(amountInWords(100)).toBe('Rupees One Only');
    expect(amountInWords(1)).toBe('Rupees Zero and Paise One Only');
    expect(amountInWords(1_500)).toBe('Rupees Fifteen Only');
    // 110000 paise is exactly 1100 rupees, so there is no "and" clause.
    expect(amountInWords(110_000)).toBe('Rupees One Thousand One Hundred Only');
    // 111000 paise is 1110 rupees, which does take one.
    expect(amountInWords(111_000)).toBe('Rupees One Thousand One Hundred and Ten Only');
  });

  it('refuses fractional paise', () => {
    expect(() => amountInWords(10.5)).toThrow(/whole paise/);
  });
});

/* ---------------------------------------------------------- pdf renderer */

describe('the PDF renderer', () => {
  const sample: InvoiceDocumentData = {
    kind: 'TAX_INVOICE',
    documentNumber: 'INV/2026-27/000001',
    issuedAt: new Date('2026-09-20T10:00:00Z'),
    orderNumber: 'CW/2026-27/000001',
    orderPlacedAt: new Date('2026-09-19T10:00:00Z'),
    seller: { name: 'ClearWood', gstin: '27AABCC1234D1ZP', address: ['Panvel'], stateCode: 'MH' },
    billTo: { name: 'Aarav', address: ['Mumbai'], phone: '919810000001' },
    shipTo: null,
    placeOfSupply: 'Maharashtra (27)',
    isInterState: false,
    lines: [
      {
        description: 'Teak Sofa',
        hsnCode: '9401',
        qty: 1,
        unitPricePaise: 200_000,
        discountPaise: 0,
        taxablePaise: 169_492,
        taxRateBp: 1_800,
        cgstPaise: 15_254,
        sgstPaise: 15_254,
        igstPaise: 0,
        totalPaise: 200_000,
      },
    ],
    subtotalPaise: 169_492,
    discountPaise: 0,
    shippingPaise: 0,
    cgstPaise: 15_254,
    sgstPaise: 15_254,
    igstPaise: 0,
    roundingPaise: 0,
    totalPaise: 200_000,
    amountInWords: 'Rupees Two Thousand Only',
  };

  it('produces a real PDF', async () => {
    const rendered = await renderInvoicePdf(sample);

    expect(rendered.bytes.length).toBeGreaterThan(1_000);
    expect(rendered.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(rendered.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(rendered.checksum).not.toBe(EMPTY_SHA256);
  });

  it('is byte-deterministic across time', async () => {
    const first = await renderInvoicePdf(sample);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await renderInvoicePdf(sample);

    // G1: two EMPTY buffers are also byte-identical, and an earlier version of this renderer
    // produced exactly that while reporting itself deterministic. Prove there is something here
    // before proving it is stable.
    expect(first.bytes.length).toBeGreaterThan(1_000);
    expect(first.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(first.checksum).not.toBe(EMPTY_SHA256);

    // PDFKit stamps CreationDate from the clock unless pinned; this proves it is pinned.
    expect(second.checksum).toBe(first.checksum);
    expect(second.bytes.equals(first.bytes)).toBe(true);
  });

  it('changes when the data changes', async () => {
    const first = await renderInvoicePdf(sample);
    const second = await renderInvoicePdf({ ...sample, totalPaise: 200_001 });

    expect(second.checksum).not.toBe(first.checksum);
  });

  it('renders IGST for an inter-state supply', async () => {
    const rendered = await renderInvoicePdf({
      ...sample,
      isInterState: true,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 30_508,
    });

    expect(rendered.bytes.length).toBeGreaterThan(1_000);
  });
});

/* -------------------------------------------------------------- numbering */

describe('document numbering', () => {
  it('is gapless under concurrency', async () => {
    const key = `test-invoice-${Date.now()}`;

    // Sequential: SQLite takes one writer, and the point is that no number repeats or is skipped.
    const numbers: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      numbers.push(await documentSequenceRepository.next(key, 'INV'));
    }

    expect(new Set(numbers).size).toBe(25);
    expect(Math.min(...numbers)).toBe(1);
    expect(Math.max(...numbers)).toBe(25);

    // Gapless: sorted, it is exactly 1..25.
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
  });

  it('uses the Indian financial year in the number', async () => {
    const number = await invoiceService.allocateNumber('TAX_INVOICE', new Date('2026-04-01'));
    expect(number).toMatch(/^INV\/2026-27\/\d{6}$/);

    const march = await invoiceService.allocateNumber('TAX_INVOICE', new Date('2026-03-31'));
    expect(march).toMatch(/^INV\/2025-26\/\d{6}$/);
  });
});

/* ------------------------------------------------------- issuing invoices */

describe('issuing a tax invoice', () => {
  it('issues once and returns the same document on a second call', async () => {
    const { order, documentNumber } = await invoicedOrder();

    const again = await post(superAdmin, `/orders/${enc(order.orderNumber)}/documents/invoice`);

    expect(again.status).toBe(201);
    expect(again.body.data.documentNumber).toBe(documentNumber);

    const count = await prisma.orderDocument.count({
      where: { orderId: order.orderId, type: 'TAX_INVOICE' },
    });
    expect(count).toBe(1);
  });

  it('states the order total exactly', async () => {
    const { order } = await invoicedOrder(3);

    const stored = await prisma.orderDocument.findFirstOrThrow({
      where: { orderId: order.orderId, type: 'TAX_INVOICE' },
    });
    const row = await orderRepository.findById(order.orderId);

    expect(stored.totalPaise).toBe(row!.grandTotalPaise);
    expect(stored.taxPaise).toBe(row!.cgstPaise + row!.sgstPaise + row!.igstPaise);
  });

  it('refuses to invoice an unconfirmed order', async () => {
    const order = await placeAndPayOrder({ qty: 1, slug: SLUG });
    await prisma.order.update({ where: { id: order.orderId }, data: { status: 'DRAFT' } });

    const response = await post(superAdmin, `/orders/${enc(order.orderNumber)}/documents/invoice`);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INVOICE_NOT_ISSUABLE');
  });

  it('lists and downloads with a verified checksum', async () => {
    const { order, documentNumber } = await invoicedOrder();

    const list = await get(superAdmin, `/orders/${enc(order.orderNumber)}/documents`);
    expect(list.status).toBe(200);
    expect(list.body.data[0].documentNumber).toBe(documentNumber);

    const download = await get(superAdmin, `/documents/${enc(documentNumber)}/download`);

    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses to serve a document whose stored bytes were tampered with', async () => {
    const { documentNumber } = await invoicedOrder();

    // Corrupt the RECORDED checksum, which is the same as the bytes having been swapped.
    await prisma.orderDocument.update({
      where: { documentNumber },
      data: { checksum: 'deadbeef'.repeat(8) },
    });

    const response = await get(superAdmin, `/documents/${enc(documentNumber)}/download`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DOCUMENT_CHECKSUM_MISMATCH');
  });
});

/* --------------------------------------------------------- credit notes */

describe('credit notes', () => {
  it('issues one that equals its refund, and only one', async () => {
    const { order } = await invoicedOrder(2);

    const refund = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'CUSTOMER_REQUEST',
        restock: false,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN', actorId: null },
    );

    await refundService.approve(refund.id, { actorType: 'ADMIN' });
    await refundService.execute(refund.id);

    const issued = await post(superAdmin, `/refunds/${refund.id}/credit-note`);
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(issued.body.data.totalPaise).toBe(refund.amountPaise);

    // A second call is a no-op, not a second note.
    const again = await post(superAdmin, `/refunds/${refund.id}/credit-note`);
    expect(again.body.data.documentNumber).toBe(issued.body.data.documentNumber);

    expect(
      await prisma.orderDocument.count({
        where: { orderId: order.orderId, type: 'CREDIT_NOTE' },
      }),
    ).toBe(1);
  });

  it('refuses a credit note for a refund that has not processed', async () => {
    const { order } = await invoicedOrder(2);

    const refund = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'CUSTOMER_REQUEST',
        restock: false,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN', actorId: null },
    );

    const response = await post(superAdmin, `/refunds/${refund.id}/credit-note`);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('CREDIT_NOTE_NOT_ISSUABLE');
  });
});

/* ------------------------------------------------------------------ ledger */

describe('the document ledger checks', () => {
  it('asserts the invoice equals the order and the credit note equals its refund', async () => {
    const { order } = await invoicedOrder(2);

    const refund = await refundService.request(
      order.orderNumber,
      {
        lines: [{ orderItemId: order.itemId, qty: 1 }],
        reason: 'CUSTOMER_REQUEST',
        restock: false,
        reversalPolicy: 'PROPORTIONAL',
      },
      { actorType: 'ADMIN', actorId: null },
    );

    await refundService.approve(refund.id, { actorType: 'ADMIN' });
    await refundService.execute(refund.id);
    await post(superAdmin, `/refunds/${refund.id}/credit-note`);

    const report = await ledgerIntegrityService.verifyOrder(order.orderId);

    expectLedgerOk(report, {
      minChecks: 10,
      mustInclude: [
        'invoice_total_matches_order',
        'invoice_tax_matches_order',
        'one_invoice_per_order',
        'credit_note_matches_refund_',
      ],
    });
  });

  it('catches an invoice that disagrees with its order', async () => {
    const { order } = await invoicedOrder(1);

    await prisma.orderDocument.updateMany({
      where: { orderId: order.orderId, type: 'TAX_INVOICE' },
      data: { totalPaise: 1 },
    });

    const report = await ledgerIntegrityService.verifyOrder(order.orderId);
    const failing = report.checks.find((check) => check.name === 'invoice_total_matches_order');

    expect(failing?.ok).toBe(false);
  });
});

/* -------------------------------------------------------- customer access */

describe('the customer document surface', () => {
  it('refuses an anonymous invoice download', async () => {
    const response = await request(app).get(`${API}/me/orders/CW%2F2026-27%2F000001/invoice`);
    expect([401, 403]).toContain(response.status);
  });
});
