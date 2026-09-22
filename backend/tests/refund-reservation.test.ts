import { beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import { payment as paymentDriver } from '../src/container';
import type { MockPaymentDriver } from '../src/drivers/payment';
import { ledgerIntegrityService } from '../src/modules/orders/ledgerIntegrity.service';
import { reconciliationService } from '../src/modules/orders/reconciliation.service';
import { paymentAdminService } from '../src/modules/payments/paymentAdmin.service';
import { refundService } from '../src/modules/payments/refund/refund.service';
import { refundReservation } from '../src/modules/payments/refund/refundReservation';
import { orderRepository } from '../src/repositories/order.repository';

import { expectNoInfrastructureFailures, runConcurrently } from './helpers/concurrency';
import { placeAndPayOrder, type PaidOrderFixture } from './helpers/paidOrder';
import { expectLedgerOk } from './helpers/ledger';
import { setStockForProduct } from './helpers/stock';

/**
 * H7 - refund capacity is RESERVED, not checked.
 *
 * The distinction these tests exist to prove: a check asks "is there room now", a reservation says
 * "the room is mine". Under concurrency only the second one holds, and the provider's own
 * validation is never allowed to be what saves us.
 */

const mock = paymentDriver as MockPaymentDriver;

async function requestRefund(order: PaidOrderFixture, qty: number) {
  return refundService.request(
    order.orderNumber,
    {
      lines: [{ orderItemId: order.itemId, qty }],
      reason: 'CUSTOMER_REQUEST',
      restock: false,
      reversalPolicy: 'PROPORTIONAL',
    },
    { actorType: 'ADMIN' },
  );
}

beforeAll(async () => {
  mock.setScenario('success');
  mock.setReversesTransfersWithRefund(false);

  await setStockForProduct('arjun-wingback-lounge-chair', 900);
});

/* ------------------------------------------------- the local guard is load-bearing */

describe('H7 - the LOCAL guard rejects an over-refund', () => {
  it('5 parallel 40% refunds succeed exactly twice even when the provider allows anything', async () => {
    // The provider will refund whatever it is asked to. Only our reservation stands in the way.
    mock.setPermissiveRefunds(true);

    const order = await placeAndPayOrder({ qty: 5, slug: 'arjun-wingback-lounge-chair' });

    const refunds: { id: string }[] = [];
    for (let i = 0; i < 5; i += 1) {
      const refund = await requestRefund(order, 2);
      await refundService.approve(refund.id, { actorType: 'ADMIN' });
      refunds.push(refund);
    }

    const measured = await runConcurrently(refunds.length, (index) =>
      refundService.execute(refunds[index]!.id),
    );

    expectNoInfrastructureFailures(measured);
    console.log(`[concurrency] refund H7 5x40%: ${JSON.stringify(measured.outcomes)}`);

    expect(measured.ok, 'the local reservation must admit exactly two').toBe(2);
    expect(measured.contended, 'a refund lost a race instead of being refused').toBe(0);
    expect(measured.refused).toBe(3);

    mock.setPermissiveRefunds(false);

    // Every rejection must be OUR guard, not the provider's, and not a lost race.
    expect(measured.reasons).toEqual(['AppError REFUND_EXCEEDS_PAID']);

    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBeLessThanOrEqual(after!.paidPaise);
    expect(after!.refundReservedPaise).toBe(0);

    const ledger = await ledgerIntegrityService.verifyOrder(order.orderId);
    expect(
      ledger.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.expected} vs ${c.actual}`),
    ).toEqual([]);
  });

  it('no provider call happens when the reservation cannot be taken', async () => {
    const order = await placeAndPayOrder({ qty: 2, slug: 'arjun-wingback-lounge-chair' });

    const first = await requestRefund(order, 2);
    await refundService.approve(first.id, { actorType: 'ADMIN' });
    await refundService.execute(first.id);

    // Everything is refunded; a second refund cannot even be requested.
    await expect(requestRefund(order, 1)).rejects.toThrow();

    const payment = await prisma.payment.findFirstOrThrow({
      where: { orderId: order.orderId, status: 'CAPTURED' },
    });
    const atProvider = await paymentDriver.fetchRefundsForPayment(payment.providerPaymentId!);

    expect(atProvider).toHaveLength(1);
  });
});

/* --------------------------------------------------------------- reserve / confirm */

describe('H7 - reserve, confirm, release', () => {
  it('reserves before the provider call and confirms after it', async () => {
    const order = await placeAndPayOrder({ qty: 4, slug: 'arjun-wingback-lounge-chair' });
    const refund = await requestRefund(order, 2);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    await refundService.execute(refund.id);

    const after = await orderRepository.findById(order.orderId);

    // Confirmed: the hold is gone and the money is settled.
    expect(after!.refundReservedPaise).toBe(0);
    expect(after!.refundedPaise).toBe(refund.amountPaise);

    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(row.capacityConfirmed).toBe(true);
  });

  it('PROPORTIONAL reversal reservations sum exactly to the refund', async () => {
    const order = await placeAndPayOrder({ qty: 4, slug: 'arjun-wingback-lounge-chair' });
    const refund = await requestRefund(order, 2);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    // Hold the reservation open by failing ambiguously, so the held amounts can be inspected.
    mock.setScenario('refund-timeout');
    await expect(refundService.execute(refund.id)).rejects.toThrow();
    mock.setScenario('success');

    const transfers = await prisma.paymentTransfer.findMany({
      where: { payment: { orderId: order.orderId } },
    });

    const reserved = transfers.reduce((sum, row) => sum + row.reversalReservedPaise, 0);
    expect(reserved).toBe(refund.amountPaise);

    const held = await orderRepository.findById(order.orderId);
    expect(held!.refundReservedPaise).toBe(refund.amountPaise);
  });

  it('releasing twice is a no-op', async () => {
    const order = await placeAndPayOrder({ qty: 2, slug: 'arjun-wingback-lounge-chair' });

    await refundReservation.reserveOrder(order.orderId, 10_000);
    expect((await orderRepository.findById(order.orderId))!.refundReservedPaise).toBe(10_000);

    expect(await refundReservation.releaseOrder(order.orderId, 10_000)).toBe(true);
    expect(await refundReservation.releaseOrder(order.orderId, 10_000)).toBe(false);

    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundReservedPaise).toBe(0);
  });

  it('a TERMINAL failure returns the capacity immediately', async () => {
    const order = await placeAndPayOrder({ qty: 2, slug: 'arjun-wingback-lounge-chair' });
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    mock.setScenario('refund-failure');
    await expect(refundService.execute(refund.id)).rejects.toThrow();
    mock.setScenario('success');

    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundReservedPaise).toBe(0);

    const transfers = await prisma.paymentTransfer.findMany({
      where: { payment: { orderId: order.orderId } },
    });
    for (const transfer of transfers) expect(transfer.reversalReservedPaise).toBe(0);
  });
});

/* --------------------------------------------------- UNKNOWN holds, and what follows */

describe('H7 - UNKNOWN holds the capacity', () => {
  it('keeps the reservation and blocks a refund that would exceed capacity', async () => {
    const order = await placeAndPayOrder({ qty: 2, slug: 'arjun-wingback-lounge-chair' });

    const first = await requestRefund(order, 2);
    await refundService.approve(first.id, { actorType: 'ADMIN' });

    mock.setScenario('refund-timeout');
    await expect(refundService.execute(first.id)).rejects.toThrow(/did not confirm/);
    mock.setScenario('success');

    const held = await orderRepository.findById(order.orderId);
    expect(held!.refundReservedPaise).toBe(first.amountPaise);
    // Nothing is settled: we do not know that it moved.
    expect(held!.refundedPaise).toBe(0);

    // The held capacity is exactly what stops a second refund going out.
    await expect(requestRefund(order, 2)).rejects.toThrow();
  });

  it('reconciliation CONFIRMS a verified refund, consuming the capacity', async () => {
    const order = await placeAndPayOrder({ qty: 2, slug: 'arjun-wingback-lounge-chair' });
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    // The provider accepted it, then the answer was lost.
    mock.setScenario('refund-timeout');
    await expect(refundService.execute(refund.id)).rejects.toThrow();
    mock.setScenario('success');

    await reconciliationService.verifyPendingRefunds();

    const resolved = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(resolved.status).toBe('PROCESSED');

    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundedPaise).toBe(refund.amountPaise);
    expect(after!.refundReservedPaise).toBe(0);
  });

  it('reconciliation RELEASES capacity when the provider never had the refund', async () => {
    const order = await placeAndPayOrder({ qty: 2, slug: 'arjun-wingback-lounge-chair' });
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    // Never landed, but we could not tell at the time.
    mock.setScenario('refund-unreachable');
    await expect(refundService.execute(refund.id)).rejects.toThrow();
    mock.setScenario('success');

    // RETRYABLE releases straight away — the capacity is back without reconciliation.
    const after = await orderRepository.findById(order.orderId);
    expect(after!.refundReservedPaise).toBe(0);

    // And the order can be refunded again.
    const retry = await requestRefund(order, 1);
    await refundService.approve(retry.id, { actorType: 'ADMIN' });
    await refundService.execute(retry.id);

    const settled = await orderRepository.findById(order.orderId);
    expect(settled!.refundedPaise).toBe(retry.amountPaise);
  });

  it('a held reservation shows in the needs-attention queue with its amount', async () => {
    const order = await placeAndPayOrder({ qty: 2, slug: 'arjun-wingback-lounge-chair' });
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    mock.setScenario('refund-timeout');
    await expect(refundService.execute(refund.id)).rejects.toThrow();
    mock.setScenario('success');

    const queue = await paymentAdminService.needsAttention();
    const entry = queue.refunds.find((row) => row.id === refund.id);

    expect(entry).toBeDefined();
    expect(entry!.capacityHeldPaise).toBe(refund.amountPaise);
    expect(entry!.canRetry).toBe(false);
    expect(entry!.reason).toMatch(/capacity is still held/i);
  });
});

/* ------------------------------------------------------------------ ledger */

describe('H7 - the ledger sees reserved capacity', () => {
  it('counts reserved capacity inside the ceiling', async () => {
    const order = await placeAndPayOrder({ qty: 2, slug: 'arjun-wingback-lounge-chair' });
    const refund = await requestRefund(order, 1);
    await refundService.approve(refund.id, { actorType: 'ADMIN' });

    mock.setScenario('refund-timeout');
    await expect(refundService.execute(refund.id)).rejects.toThrow();
    mock.setScenario('success');

    const report = await ledgerIntegrityService.verifyOrder(order.orderId);
    expectLedgerOk(report, {
      minChecks: 10,
      mustInclude: ['refunded_plus_reserved_within_paid'],
    });

    const ceiling = report.checks.find(
      (entry) => entry.name === 'refunded_plus_reserved_within_paid',
    );
    expect(ceiling).toBeDefined();
    expect(ceiling!.ok).toBe(true);
  });

  it('flags a reservation with no refund behind it', async () => {
    const order = await placeAndPayOrder({ qty: 2, slug: 'arjun-wingback-lounge-chair' });

    // An orphan: capacity held by nothing. Only reachable by corruption, which is why it is checked.
    await refundReservation.reserveOrder(order.orderId, 5_000);

    const report = await ledgerIntegrityService.verifyOrder(order.orderId);
    const orphan = report.checks.find((entry) => entry.name === 'reservation_is_not_orphaned');

    expect(orphan).toBeDefined();
    expect(orphan!.ok).toBe(false);

    await refundReservation.releaseOrder(order.orderId, 5_000);
  });
});
