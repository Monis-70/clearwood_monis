import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { payment as paymentDriver } from '../src/container';
import type { MockPaymentDriver } from '../src/drivers/payment';
import { passwordService } from '../src/modules/auth/password.service';
import { escapeCsvValue } from '../src/modules/catalog-admin/import-export/csv';
import { refundService } from '../src/modules/payments/refund/refund.service';
import { reportService, REPORT_KINDS } from '../src/modules/reports/report.service';

import { placeAndPayOrder, type PaidOrderFixture } from './helpers/paidOrder';
import { setStockForProduct } from './helpers/stock';

/**
 * Slice D - operational reports.
 *
 * A report nobody checks is a number nobody should trust, so every figure here is reconciled
 * against a value computed independently from the rows the report did NOT read: SALES_SUMMARY
 * against the order snapshots, GST_HSN_SUMMARY against per-item tax, SPLIT_PAYOUT against the
 * transfer and reversal rows.
 *
 * G1 applies throughout: each reconciliation also asserts the compared figure is non-zero, since
 * 0 === 0 would otherwise pass for an empty database.
 */

const app = createApp();
const API = '/api/v1';
const ADMIN_API = `${API}/admin`;
const mock = paymentDriver as MockPaymentDriver;
const SLUG = 'ashoka-nesting-table-set';
const TEST_PASSWORD = 'Rosewood-Teak-2026';

/** Wide enough to cover everything this run creates, and inside the 366-day cap. */
const RANGE = {
  from: new Date(Date.now() - 300 * 24 * 60 * 60 * 1000),
  to: new Date(Date.now() + 24 * 60 * 60 * 1000),
};

interface Session {
  header: string;
  csrf: string;
}

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

async function admin(email: string, roleCode: string): Promise<Session> {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });

  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: `Reports ${roleCode}`,
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

function get(session: Session, path: string) {
  return request(app).get(`${ADMIN_API}${path}`).set('Cookie', session.header);
}

function query(kind: string, extra = ''): string {
  return `/reports?kind=${kind}&from=${RANGE.from.toISOString()}&to=${RANGE.to.toISOString()}${extra}`;
}

/** The CSV body minus the header row, ignoring the trailing blank. */
function dataRows(csv: string): string[] {
  return csv.trim().split('\r\n').slice(1);
}

let superAdmin: Session;
let fixture: PaidOrderFixture;

beforeAll(async () => {
  mock.setScenario('success');
  mock.setReversesTransfersWithRefund(false);

  superAdmin = await admin('reports.super@clearwood.local', 'SUPER_ADMIN');
  await setStockForProduct(SLUG, 400);

  // A paid order plus a processed refund, so every report has something real to foot to.
  fixture = await placeAndPayOrder({ qty: 3, slug: SLUG });

  const refund = await refundService.request(
    fixture.orderNumber,
    {
      lines: [{ orderItemId: fixture.itemId, qty: 1 }],
      reason: 'CUSTOMER_REQUEST',
      restock: false,
      reversalPolicy: 'PROPORTIONAL',
    },
    { actorType: 'ADMIN', actorId: null },
  );

  await refundService.approve(refund.id, { actorType: 'ADMIN' });
  await refundService.execute(refund.id);
});

/* ------------------------------------------------------------ SALES_SUMMARY */

describe('SALES_SUMMARY', () => {
  it('foots to the sum of the order snapshots', async () => {
    const report = await reportService.salesSummary(RANGE);

    // Independently computed from the orders themselves, not from the report's own aggregation.
    const orders = await prisma.order.findMany({
      where: {
        paymentStatus: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
        placedAt: { gte: RANGE.from, lte: RANGE.to },
      },
      select: { grandTotalPaise: true, paidPaise: true, taxPaise: true, refundedPaise: true },
    });

    const expected = orders.reduce(
      (totals, order) => ({
        grandTotalPaise: totals.grandTotalPaise + order.grandTotalPaise,
        paidPaise: totals.paidPaise + order.paidPaise,
        taxPaise: totals.taxPaise + order.taxPaise,
        refundedPaise: totals.refundedPaise + order.refundedPaise,
      }),
      { grandTotalPaise: 0, paidPaise: 0, taxPaise: 0, refundedPaise: 0 },
    );

    // G1: 0 === 0 would pass on an empty database. Prove there is revenue before matching it.
    expect(orders.length).toBeGreaterThan(0);
    expect(expected.grandTotalPaise).toBeGreaterThan(0);
    expect(expected.paidPaise).toBeGreaterThan(0);
    expect(expected.taxPaise).toBeGreaterThan(0);
    expect(expected.refundedPaise).toBeGreaterThan(0);

    expect(report.totals.orders).toBe(orders.length);
    expect(report.totals.grandTotalPaise).toBe(expected.grandTotalPaise);
    expect(report.totals.paidPaise).toBe(expected.paidPaise);
    expect(report.totals.taxPaise).toBe(expected.taxPaise);
    expect(report.totals.refundedPaise).toBe(expected.refundedPaise);
    expect(report.totals.netReceivedPaise).toBe(expected.paidPaise - expected.refundedPaise);

    // The file has as many rows as the figure claims.
    expect(dataRows(report.csv).length).toBe(orders.length);
    expect(report.rowCount).toBe(orders.length);
  });

  it('excludes orders that were never paid for', async () => {
    const report = await reportService.salesSummary(RANGE);

    const unpaid = await prisma.order.count({
      where: { paymentStatus: { in: ['PENDING', 'FAILED'] } },
    });

    expect(unpaid).toBeGreaterThan(0);
    expect(report.csv).not.toContain('PENDING_PAYMENT');
  });
});

/* --------------------------------------------------------- GST_HSN_SUMMARY */

describe('GST_HSN_SUMMARY', () => {
  it('foots to the per-item tax on every sold line', async () => {
    const report = await reportService.gstHsnSummary(RANGE);

    const items = await prisma.orderItem.findMany({
      where: {
        order: {
          paymentStatus: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
          placedAt: { gte: RANGE.from, lte: RANGE.to },
        },
      },
      select: {
        qty: true,
        taxablePaise: true,
        taxPaise: true,
        cgstPaise: true,
        sgstPaise: true,
        igstPaise: true,
      },
    });

    const expected = items.reduce(
      (totals, item) => ({
        qty: totals.qty + item.qty,
        taxablePaise: totals.taxablePaise + item.taxablePaise,
        taxPaise: totals.taxPaise + item.taxPaise,
        cgstPaise: totals.cgstPaise + item.cgstPaise,
        sgstPaise: totals.sgstPaise + item.sgstPaise,
        igstPaise: totals.igstPaise + item.igstPaise,
      }),
      { qty: 0, taxablePaise: 0, taxPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 },
    );

    expect(items.length).toBeGreaterThan(0);
    expect(expected.taxPaise).toBeGreaterThan(0);
    expect(expected.taxablePaise).toBeGreaterThan(0);

    expect(report.totals.lineItems).toBe(items.length);
    expect(report.totals.qty).toBe(expected.qty);
    expect(report.totals.taxablePaise).toBe(expected.taxablePaise);
    expect(report.totals.taxPaise).toBe(expected.taxPaise);
    expect(report.totals.cgstPaise).toBe(expected.cgstPaise);
    expect(report.totals.sgstPaise).toBe(expected.sgstPaise);
    expect(report.totals.igstPaise).toBe(expected.igstPaise);

    // CGST + SGST + IGST must exhaust the tax: a split that loses a paise is a filing error.
    expect(
      report.totals.cgstPaise + report.totals.sgstPaise + report.totals.igstPaise,
    ).toBe(report.totals.taxPaise);
  });

  it('agrees with the order-level tax column', async () => {
    const [hsn, sales] = await Promise.all([
      reportService.gstHsnSummary(RANGE),
      reportService.salesSummary(RANGE),
    ]);

    // Two independent paths to the same figure: per-line tax and the frozen order total.
    expect(hsn.totals.taxPaise).toBeGreaterThan(0);
    expect(hsn.totals.taxPaise).toBe(sales.totals.taxPaise);
  });

  it('groups by HSN and rate, not by order', async () => {
    const report = await reportService.gstHsnSummary(RANGE);

    expect(report.totals.hsnCodes).toBeGreaterThan(0);
    expect(report.totals.hsnCodes).toBeLessThanOrEqual(report.totals.lineItems);
    expect(dataRows(report.csv).length).toBe(report.totals.hsnCodes);
  });
});

/* ------------------------------------------------------------- SPLIT_PAYOUT */

describe('SPLIT_PAYOUT', () => {
  it('foots to transfers minus reversals taken from the ledger rows', async () => {
    const report = await reportService.splitPayout(RANGE);

    const transfers = await prisma.paymentTransfer.findMany({
      where: { createdAt: { gte: RANGE.from, lte: RANGE.to } },
      select: { amountPaise: true, reversedPaise: true },
    });

    const reversals = await prisma.transferReversal.findMany({
      where: { createdAt: { gte: RANGE.from, lte: RANGE.to }, status: 'PROCESSED' },
      select: { amountPaise: true },
    });

    const transferred = transfers.reduce((total, entry) => total + entry.amountPaise, 0);
    const reversed = reversals.reduce((total, entry) => total + entry.amountPaise, 0);

    expect(transfers.length).toBeGreaterThan(0);
    expect(reversals.length).toBeGreaterThan(0);
    expect(transferred).toBeGreaterThan(0);
    expect(reversed).toBeGreaterThan(0);

    expect(report.totals.transferredPaise).toBe(transferred);
    expect(report.totals.reversedFromRowsPaise).toBe(reversed);
    expect(report.totals.netPayoutPaise).toBe(transferred - reversed);
  });

  /**
   * `transfer.reversedPaise` and the reversal rows are two independent records of one fact. A
   * report built on the counter alone could never notice the counter drifting, which is exactly
   * the bug that got through earlier in this prompt.
   */
  it('shows the reversal counter and the reversal rows agreeing', async () => {
    const report = await reportService.splitPayout(RANGE);

    expect(report.totals.reversedFromRowsPaise).toBeGreaterThan(0);
    expect(report.totals.reversedFromCountersPaise).toBe(report.totals.reversedFromRowsPaise);
  });

  it('never pays out more than was transferred', async () => {
    const report = await reportService.splitPayout(RANGE);

    expect(report.totals.transferredPaise).toBeGreaterThan(0);
    expect(report.totals.netPayoutPaise).toBeLessThanOrEqual(report.totals.transferredPaise);
    expect(report.totals.netPayoutPaise).toBeGreaterThanOrEqual(0);
  });
});

/* ----------------------------------------------------------- REFUND_SUMMARY */

describe('REFUND_SUMMARY', () => {
  it('foots to the refund rows and agrees with the order refunded column', async () => {
    const report = await reportService.refundSummary(RANGE);

    const processed = await prisma.refund.findMany({
      where: { status: 'PROCESSED', createdAt: { gte: RANGE.from, lte: RANGE.to } },
      select: { amountPaise: true },
    });

    const expected = processed.reduce((total, refund) => total + refund.amountPaise, 0);

    expect(processed.length).toBeGreaterThan(0);
    expect(expected).toBeGreaterThan(0);

    expect(report.totals.processedRefunds).toBe(processed.length);
    expect(report.totals.processedPaise).toBe(expected);

    // And the same money, counted from the order side instead.
    const sales = await reportService.salesSummary(RANGE);
    expect(sales.totals.refundedPaise).toBe(expected);
  });
});

/* ------------------------------------------------------------- TOP_PRODUCTS */

describe('TOP_PRODUCTS', () => {
  it('foots to the sum of line totals and ranks by revenue', async () => {
    const report = await reportService.topProducts(RANGE);

    const items = await prisma.orderItem.findMany({
      where: {
        order: {
          paymentStatus: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
          placedAt: { gte: RANGE.from, lte: RANGE.to },
        },
      },
      select: { qty: true, lineTotalPaise: true },
    });

    const revenue = items.reduce((total, item) => total + item.lineTotalPaise, 0);
    const qty = items.reduce((total, item) => total + item.qty, 0);

    expect(items.length).toBeGreaterThan(0);
    expect(revenue).toBeGreaterThan(0);

    expect(report.totals.revenuePaise).toBe(revenue);
    expect(report.totals.qty).toBe(qty);
    expect(report.totals.products).toBeGreaterThan(0);

    // Ranked descending by revenue.
    const amounts = dataRows(report.csv).map((row) => Number(row.split(',').pop()));
    expect(amounts.length).toBeGreaterThan(1);

    for (let index = 1; index < amounts.length; index += 1) {
      expect(amounts[index]).toBeLessThanOrEqual(amounts[index - 1]);
    }
  });
});

/* ------------------------------------------------------ INVENTORY_MOVEMENT */

describe('INVENTORY_MOVEMENT', () => {
  it('foots to the ledger and nets to inward minus outward', async () => {
    const report = await reportService.inventoryMovement(RANGE);

    const movements = await prisma.inventoryLedger.findMany({
      where: { createdAt: { gte: RANGE.from, lte: RANGE.to } },
      select: { delta: true },
    });

    expect(movements.length).toBeGreaterThan(0);
    expect(report.totals.movements).toBe(movements.length);

    const inward = movements.filter((m) => m.delta > 0).reduce((t, m) => t + m.delta, 0);
    const outward = Math.abs(movements.filter((m) => m.delta < 0).reduce((t, m) => t + m.delta, 0));

    expect(inward).toBeGreaterThan(0);
    expect(outward).toBeGreaterThan(0);

    expect(report.totals.inwardUnits).toBe(inward);
    expect(report.totals.outwardUnits).toBe(outward);
    expect(report.totals.netUnits).toBe(inward - outward);
  });
});

/* ------------------------------------------------------------- CSV safety */

describe('CSV formula injection', () => {
  it('neutralises every dangerous leading character', () => {
    for (const dangerous of ['=', '+', '-', '@', '\t', '\r']) {
      const escaped = escapeCsvValue(`${dangerous}HYPERLINK("http://evil","click")`);
      expect(escaped.replace(/^"/, '').startsWith("'")).toBe(true);
    }
  });

  it('exports a malicious product name as inert text', async () => {
    const variant = await prisma.productVariant.findFirstOrThrow({
      where: { product: { slug: SLUG } },
      select: { productId: true },
    });

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: variant.productId },
      select: { name: true },
    });

    await prisma.product.update({
      where: { id: variant.productId },
      data: { name: '=cmd|\' /C calc\'!A0' },
    });

    try {
      const report = await reportService.inventoryMovement(RANGE);

      expect(report.rowCount).toBeGreaterThan(0);
      expect(report.csv).toContain('calc');
      // Present, but prefixed with an apostrophe so no spreadsheet will execute it.
      expect(report.csv).not.toMatch(/,=cmd/);
      expect(report.csv).toContain(",'=cmd");
    } finally {
      await prisma.product.update({
        where: { id: variant.productId },
        data: { name: product.name },
      });
    }
  });
});

/* ------------------------------------------------------------ HTTP routes */

describe('the reports route', () => {
  it.each(REPORT_KINDS)('serves %s as CSV with a header row', async (kind) => {
    const response = await get(superAdmin, query(kind));

    expect(response.status, response.text.slice(0, 300)).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain(kind.toLowerCase());

    const lines = response.text.trim().split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].split(',').length).toBeGreaterThan(2);
  });

  it('returns only the totals when asked for json', async () => {
    const response = await get(superAdmin, query('SALES_SUMMARY', '&format=json'));

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.kind).toBe('SALES_SUMMARY');
    expect(response.body.data.rowCount).toBeGreaterThan(0);
    expect(response.body.data.totals.grandTotalPaise).toBeGreaterThan(0);
  });

  it('matches the figures the service computed', async () => {
    const [response, direct] = await Promise.all([
      get(superAdmin, query('GST_HSN_SUMMARY', '&format=json')),
      reportService.gstHsnSummary(RANGE),
    ]);

    expect(direct.totals.taxPaise).toBeGreaterThan(0);
    expect(response.body.data.totals.taxPaise).toBe(direct.totals.taxPaise);
  });

  it('rejects an unknown report kind with 422 (R2)', async () => {
    const response = await get(superAdmin, query('NOT_A_REPORT'));

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a range that is inverted', async () => {
    const response = await get(
      superAdmin,
      `/reports?kind=SALES_SUMMARY&from=${RANGE.to.toISOString()}&to=${RANGE.from.toISOString()}`,
    );

    expect(response.status).toBe(422);
  });

  it('refuses an unbounded range rather than scanning every order ever placed', async () => {
    const response = await get(
      superAdmin,
      `/reports?kind=SALES_SUMMARY&from=2000-01-01T00:00:00.000Z&to=${RANGE.to.toISOString()}`,
    );

    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain('366');
  });

  it('requires the date range at all', async () => {
    const response = await get(superAdmin, '/reports?kind=SALES_SUMMARY');
    expect(response.status).toBe(422);
  });

  it('refuses an anonymous caller', async () => {
    const response = await request(app).get(`${ADMIN_API}${query('SALES_SUMMARY')}`);
    expect(response.status).toBe(401);
  });
});
