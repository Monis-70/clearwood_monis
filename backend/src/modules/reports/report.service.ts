import type { Permission } from '@shared/enums';

import { csvRow, paiseToCsv } from '../catalog-admin/import-export/csv';
import {
  reportRepository,
  type ReportRange,
} from '../../repositories/report.repository';

/**
 * Prompt 9B slice D — operational reports.
 *
 * Every report is CSV, generated on request, and never stored. A stored report is a figure that
 * was true once and is quoted forever; regenerating from the ledger means the number is always
 * the number the ledger currently holds.
 *
 * Formula escaping comes from the existing writer (`escapeCsvValue`): a product name of
 * `=HYPERLINK(...)` would otherwise execute when an admin opens the file in Excel.
 *
 * Each report returns its rows AND the totals it computed, so a caller — and the test suite — can
 * reconcile the file against an independently derived figure rather than trusting the writer.
 */

export const REPORT_KINDS = [
  'SALES_SUMMARY',
  'GST_HSN_SUMMARY',
  'SPLIT_PAYOUT',
  'REFUND_SUMMARY',
  'TOP_PRODUCTS',
  'INVENTORY_MOVEMENT',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Each report needs the privilege for the data it exposes; a report is an export of that data. */
export const REPORT_PERMISSIONS: Record<ReportKind, Permission> = {
  SALES_SUMMARY: 'order.order.export',
  GST_HSN_SUMMARY: 'order.order.export',
  TOP_PRODUCTS: 'order.order.export',
  REFUND_SUMMARY: 'order.refund.read',
  SPLIT_PAYOUT: 'payment.split.read',
  INVENTORY_MOVEMENT: 'catalog.inventory.read',
};

export interface ReportResult {
  kind: ReportKind;
  filename: string;
  csv: string;
  rowCount: number;
  /** The figures the report footed to. Named so a test can reconcile each one independently. */
  totals: Record<string, number>;
}

function build(
  kind: ReportKind,
  range: ReportRange,
  headers: string[],
  rows: unknown[][],
  totals: Record<string, number>,
): ReportResult {
  const stamp = `${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}`;

  return {
    kind,
    filename: `${kind.toLowerCase()}_${stamp}.csv`,
    csv: csvRow(headers) + rows.map(csvRow).join(''),
    rowCount: rows.length,
    totals,
  };
}

export const reportService = {
  async generate(kind: ReportKind, range: ReportRange): Promise<ReportResult> {
    switch (kind) {
      case 'SALES_SUMMARY':
        return this.salesSummary(range);
      case 'GST_HSN_SUMMARY':
        return this.gstHsnSummary(range);
      case 'SPLIT_PAYOUT':
        return this.splitPayout(range);
      case 'REFUND_SUMMARY':
        return this.refundSummary(range);
      case 'TOP_PRODUCTS':
        return this.topProducts(range);
      case 'INVENTORY_MOVEMENT':
        return this.inventoryMovement(range);
    }
  },

  /** One row per order, footed to the same totals the order snapshots hold. */
  async salesSummary(range: ReportRange): Promise<ReportResult> {
    const orders = await reportRepository.salesOrders(range);

    const rows = orders.map((order) => [
      order.orderNumber,
      order.placedAt?.toISOString().slice(0, 10) ?? '',
      order.status,
      order.paymentStatus,
      order.channel,
      order.placeOfSupply,
      paiseToCsv(order.subtotalPaise),
      paiseToCsv(order.discountPaise),
      paiseToCsv(order.shippingPaise),
      paiseToCsv(order.taxPaise),
      paiseToCsv(order.roundingPaise),
      paiseToCsv(order.grandTotalPaise),
      paiseToCsv(order.paidPaise),
      paiseToCsv(order.refundedPaise),
      paiseToCsv(order.paidPaise - order.refundedPaise),
    ]);

    const sum = (pick: (order: (typeof orders)[number]) => number) =>
      orders.reduce((total, order) => total + pick(order), 0);

    return build(
      'SALES_SUMMARY',
      range,
      [
        'orderNumber',
        'placedOn',
        'status',
        'paymentStatus',
        'channel',
        'placeOfSupply',
        'subtotal',
        'discount',
        'shipping',
        'tax',
        'rounding',
        'grandTotal',
        'paid',
        'refunded',
        'netReceived',
      ],
      rows,
      {
        orders: orders.length,
        subtotalPaise: sum((order) => order.subtotalPaise),
        discountPaise: sum((order) => order.discountPaise),
        shippingPaise: sum((order) => order.shippingPaise),
        taxPaise: sum((order) => order.taxPaise),
        grandTotalPaise: sum((order) => order.grandTotalPaise),
        paidPaise: sum((order) => order.paidPaise),
        refundedPaise: sum((order) => order.refundedPaise),
        netReceivedPaise: sum((order) => order.paidPaise - order.refundedPaise),
      },
    );
  },

  /**
   * GST output tax grouped by HSN and rate, which is the shape GSTR-1 asks for.
   *
   * CGST/SGST and IGST are kept in separate columns rather than summed: an intra-state sale and
   * an inter-state sale of the same item are different lines on the return.
   */
  async gstHsnSummary(range: ReportRange): Promise<ReportResult> {
    const items = await reportRepository.soldItems(range);

    interface Bucket {
      hsnCode: string;
      taxRateBp: number;
      qty: number;
      taxablePaise: number;
      cgstPaise: number;
      sgstPaise: number;
      igstPaise: number;
      taxPaise: number;
    }

    const buckets = new Map<string, Bucket>();

    for (const item of items) {
      const hsnCode = item.hsnCode ?? 'UNCLASSIFIED';
      const key = `${hsnCode}|${item.taxRateBp}`;

      const bucket = buckets.get(key) ?? {
        hsnCode,
        taxRateBp: item.taxRateBp,
        qty: 0,
        taxablePaise: 0,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: 0,
        taxPaise: 0,
      };

      bucket.qty += item.qty;
      bucket.taxablePaise += item.taxablePaise;
      bucket.cgstPaise += item.cgstPaise;
      bucket.sgstPaise += item.sgstPaise;
      bucket.igstPaise += item.igstPaise;
      bucket.taxPaise += item.taxPaise;

      buckets.set(key, bucket);
    }

    const ordered = [...buckets.values()].sort(
      (a, b) => a.hsnCode.localeCompare(b.hsnCode) || a.taxRateBp - b.taxRateBp,
    );

    const rows = ordered.map((bucket) => [
      bucket.hsnCode,
      (bucket.taxRateBp / 100).toFixed(2),
      bucket.qty,
      paiseToCsv(bucket.taxablePaise),
      paiseToCsv(bucket.cgstPaise),
      paiseToCsv(bucket.sgstPaise),
      paiseToCsv(bucket.igstPaise),
      paiseToCsv(bucket.taxPaise),
    ]);

    const sum = (pick: (bucket: Bucket) => number) =>
      ordered.reduce((total, bucket) => total + pick(bucket), 0);

    return build(
      'GST_HSN_SUMMARY',
      range,
      ['hsnCode', 'taxRatePercent', 'qty', 'taxableValue', 'cgst', 'sgst', 'igst', 'totalTax'],
      rows,
      {
        hsnCodes: ordered.length,
        lineItems: items.length,
        qty: sum((bucket) => bucket.qty),
        taxablePaise: sum((bucket) => bucket.taxablePaise),
        cgstPaise: sum((bucket) => bucket.cgstPaise),
        sgstPaise: sum((bucket) => bucket.sgstPaise),
        igstPaise: sum((bucket) => bucket.igstPaise),
        taxPaise: sum((bucket) => bucket.taxPaise),
      },
    );
  },

  /**
   * What each split account was actually owed: transferred minus what came back.
   *
   * `netPayoutPaise` is derived from the REVERSAL ROWS, not from `transfer.reversedPaise`. The
   * counter and the rows are two independent records of the same fact, and a report that reads
   * the counter cannot notice the counter drifting. Both are emitted so they can be compared.
   */
  async splitPayout(range: ReportRange): Promise<ReportResult> {
    const [transfers, reversals] = await Promise.all([
      reportRepository.transfers(range),
      reportRepository.reversals(range),
    ]);

    const reversedByTransfer = new Map<string, number>();
    for (const reversal of reversals) {
      reversedByTransfer.set(
        reversal.paymentTransferId,
        (reversedByTransfer.get(reversal.paymentTransferId) ?? 0) + reversal.amountPaise,
      );
    }

    const rows = transfers.map((transfer) => {
      const reversed = reversedByTransfer.get(transfer.id) ?? 0;

      return [
        transfer.account.key,
        transfer.account.name,
        transfer.payment.order?.orderNumber ?? '',
        transfer.createdAt.toISOString().slice(0, 10),
        transfer.status,
        transfer.settlementStatus ?? '',
        paiseToCsv(transfer.amountPaise),
        paiseToCsv(reversed),
        paiseToCsv(transfer.reversedPaise),
        paiseToCsv(transfer.amountPaise - reversed),
      ];
    });

    const transferredPaise = transfers.reduce((total, entry) => total + entry.amountPaise, 0);
    const reversedFromRowsPaise = reversals.reduce((total, entry) => total + entry.amountPaise, 0);
    const reversedFromCountersPaise = transfers.reduce(
      (total, entry) => total + entry.reversedPaise,
      0,
    );

    return build(
      'SPLIT_PAYOUT',
      range,
      [
        'accountKey',
        'accountName',
        'orderNumber',
        'transferredOn',
        'status',
        'settlementStatus',
        'transferred',
        'reversedFromRows',
        'reversedFromCounter',
        'netPayout',
      ],
      rows,
      {
        transfers: transfers.length,
        reversals: reversals.length,
        transferredPaise,
        reversedFromRowsPaise,
        reversedFromCountersPaise,
        netPayoutPaise: transferredPaise - reversedFromRowsPaise,
      },
    );
  },

  async refundSummary(range: ReportRange): Promise<ReportResult> {
    const refunds = await reportRepository.refunds(range);

    const rows = refunds.map((refund) => [
      refund.refundNumber,
      refund.order.orderNumber,
      refund.createdAt.toISOString().slice(0, 10),
      refund.processedAt?.toISOString().slice(0, 10) ?? '',
      refund.status,
      refund.reason,
      refund.speed,
      refund.isFullRefund ? 'FULL' : 'PARTIAL',
      paiseToCsv(refund.order.grandTotalPaise),
      paiseToCsv(refund.amountPaise),
    ]);

    const processed = refunds.filter((refund) => refund.status === 'PROCESSED');

    return build(
      'REFUND_SUMMARY',
      range,
      [
        'refundNumber',
        'orderNumber',
        'requestedOn',
        'processedOn',
        'status',
        'reason',
        'speed',
        'scope',
        'orderTotal',
        'refundAmount',
      ],
      rows,
      {
        refunds: refunds.length,
        processedRefunds: processed.length,
        requestedPaise: refunds.reduce((total, refund) => total + refund.amountPaise, 0),
        processedPaise: processed.reduce((total, refund) => total + refund.amountPaise, 0),
      },
    );
  },

  /** Ranked by revenue rather than units: twenty pouffes are not a better seller than one sofa. */
  async topProducts(range: ReportRange): Promise<ReportResult> {
    const items = await reportRepository.soldItems(range);

    interface Row {
      sku: string;
      productName: string;
      qty: number;
      revenuePaise: number;
      orders: Set<string>;
    }

    const bySku = new Map<string, Row>();

    for (const item of items) {
      const row = bySku.get(item.sku) ?? {
        sku: item.sku,
        productName: item.productName,
        qty: 0,
        revenuePaise: 0,
        orders: new Set<string>(),
      };

      row.qty += item.qty;
      row.revenuePaise += item.lineTotalPaise;
      row.orders.add(item.order.orderNumber);

      bySku.set(item.sku, row);
    }

    const ordered = [...bySku.values()].sort(
      (a, b) => b.revenuePaise - a.revenuePaise || a.sku.localeCompare(b.sku),
    );

    const rows = ordered.map((row, index) => [
      index + 1,
      row.sku,
      row.productName,
      row.qty,
      row.orders.size,
      paiseToCsv(row.revenuePaise),
    ]);

    return build(
      'TOP_PRODUCTS',
      range,
      ['rank', 'sku', 'productName', 'qtySold', 'orderCount', 'revenue'],
      rows,
      {
        products: ordered.length,
        qty: ordered.reduce((total, row) => total + row.qty, 0),
        revenuePaise: ordered.reduce((total, row) => total + row.revenuePaise, 0),
      },
    );
  },

  async inventoryMovement(range: ReportRange): Promise<ReportResult> {
    const movements = await reportRepository.inventoryMovements(range);

    const rows = movements.map((movement) => [
      movement.createdAt.toISOString(),
      movement.variant.sku,
      movement.variant.product.name,
      movement.reason,
      movement.refType ?? '',
      movement.refId ?? '',
      movement.actorType,
      movement.delta,
      movement.balanceAfter,
    ]);

    const inwards = movements.filter((movement) => movement.delta > 0);
    const outwards = movements.filter((movement) => movement.delta < 0);

    return build(
      'INVENTORY_MOVEMENT',
      range,
      ['at', 'sku', 'productName', 'reason', 'refType', 'refId', 'actorType', 'delta', 'balanceAfter'],
      rows,
      {
        movements: movements.length,
        inwardUnits: inwards.reduce((total, movement) => total + movement.delta, 0),
        outwardUnits: Math.abs(outwards.reduce((total, movement) => total + movement.delta, 0)),
        netUnits: movements.reduce((total, movement) => total + movement.delta, 0),
      },
    );
  },
};
