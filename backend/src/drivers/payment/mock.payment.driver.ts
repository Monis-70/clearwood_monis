import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { PaymentDriver as PaymentDriverName } from '@shared/enums';

import { AppError } from '../../utils/AppError';

import type {
  CreateOrderInput,
  CreateRefundInput,
  ParsedWebhook,
  PaymentDriver,
  PaymentDriverCapabilities,
  ProviderOrder,
  ProviderPayment,
  ProviderRefund,
  ProviderReversal,
  ProviderSettlement,
  ProviderTransfer,
  ProviderTransferRequest,
} from './payment.driver';
import { ProviderCallError } from './payment.driver';

/**
 * A complete offline payment provider.
 *
 * This is not a set of stubs returning `{}`. It models orders, authorisation, capture, Route
 * transfers (including on-hold), partial and full refunds, transfer reversals and settlements, and
 * it can emit webhook payloads on demand — so the entire Prompt 9A flow, webhook path included, is
 * exercisable with no network at all.
 *
 * WHY THE SIGNATURES ARE REAL: the mock signs with genuine HMAC-SHA256 over exactly the strings
 * Razorpay signs (`${order_id}|${payment_id}` for checkout, the raw body for webhooks). That means
 * the verification code path under test is the same code path that runs in production — only the
 * secret differs. A mock that returned `true` would leave the most security-sensitive branch in the
 * system completely untested.
 *
 * SCENARIOS steer the simulator without a network. They are selected by `setScenario()` (used by
 * tests) or by the last three digits of the amount, so a fixture can ask for a failure simply by
 * ordering ₹x.99 — see `scenarioForAmount`.
 */

export const MOCK_KEY_ID = 'rzp_test_mock0000000000';
export const MOCK_KEY_SECRET = 'mock_key_secret_for_tests_only';
export const MOCK_WEBHOOK_SECRET = 'mock_webhook_secret_for_tests_only';

export type MockScenario =
  | 'success'
  | 'failure'
  | 'timeout'
  | 'signature-mismatch'
  | 'transfer-failure'
  | 'partial-capture'
  /** The provider considers the refund and rejects it. TERMINAL: retrying changes nothing. */
  | 'refund-failure'
  /** The refund call never lands. RETRYABLE: nothing happened at the provider. */
  | 'refund-unreachable'
  /** The refund call times out AFTER the provider received it. UNKNOWN: it may have succeeded. */
  | 'refund-timeout'
  /** A reversal times out ambiguously. */
  | 'reversal-timeout';

interface MockOrderRecord {
  providerOrderId: string;
  amountPaise: number;
  currency: string;
  receipt: string;
  status: string;
  notes: Record<string, string>;
}

interface MockPaymentRecord {
  providerPaymentId: string;
  providerOrderId: string;
  amountPaise: number;
  capturedPaise: number;
  refundedPaise: number;
  status: string;
  method: string;
  scenario: MockScenario;
}

/** Deterministic ids: the same seed always produces the same id, so fixtures are stable. */
function stableId(prefix: string, seed: string): string {
  return `${prefix}_${createHash('sha256').update(seed).digest('hex').slice(0, 14)}`;
}

export class MockPaymentDriver implements PaymentDriver {
  readonly name: PaymentDriverName = 'mock';

  readonly keyId = MOCK_KEY_ID;
  readonly keySecret = MOCK_KEY_SECRET;
  readonly webhookSecret = MOCK_WEBHOOK_SECRET;

  private scenario: MockScenario = 'success';
  private providerReverses = false;
  private permissiveRefunds = false;
  private reversalNonce = 0;
  private readonly orders = new Map<string, MockOrderRecord>();
  private readonly payments = new Map<string, MockPaymentRecord>();
  private readonly transfers = new Map<string, ProviderTransfer[]>();
  private readonly refunds = new Map<string, ProviderRefund>();

  /** Tests drive the simulator through this rather than through magic amounts. */
  setScenario(scenario: MockScenario): void {
    this.scenario = scenario;
  }

  reset(): void {
    this.scenario = 'success';
    this.providerReverses = false;
    this.permissiveRefunds = false;
    this.orders.clear();
    this.payments.clear();
    this.transfers.clear();
    this.refunds.clear();
  }

  /** ₹x.97/.98/.99 endings pick a scenario, so seeds and .http files can too. */
  private scenarioForAmount(amountPaise: number): MockScenario {
    if (this.scenario !== 'success') return this.scenario;
    switch (amountPaise % 100) {
      case 99:
        return 'failure';
      case 98:
        return 'timeout';
      case 97:
        return 'transfer-failure';
      default:
        return 'success';
    }
  }

  capabilities(): PaymentDriverCapabilities {
    return {
      supportsSplit: true,
      supportsInstantRefund: true,
      supportsOnHoldTransfers: true,
      supportsPartialCapture: true,
      supportsSettlementFetch: true,
      // Flipped by `setReversesTransfersWithRefund` so both H5 shapes are testable.
      reversesTransfersWithRefund: this.providerReverses,
      supportsClientReference: true,
      supportsIdempotencyKey: true,
    };
  }

  /** Test seam: simulate a provider that reverses linked-account transfers itself. */
  setReversesTransfersWithRefund(value: boolean): void {
    this.providerReverses = value;
  }

  /**
   * Test seam: a provider that will refund anything you ask for.
   *
   * Used to prove our own guard is what stops an over-refund, rather than the provider's.
   */
  setPermissiveRefunds(value: boolean): void {
    this.permissiveRefunds = value;
  }

  /* ------------------------------------------------------------- orders */

  async createOrder(input: CreateOrderInput): Promise<ProviderOrder> {
    const scenario = this.scenarioForAmount(input.amountPaise);
    if (scenario === 'timeout') {
      throw new AppError(504, 'PAYMENT_PROVIDER_TIMEOUT', 'The payment provider did not respond');
    }

    const providerOrderId = stableId('order_mock', `${input.receipt}:${input.amountPaise}`);
    const record: MockOrderRecord = {
      providerOrderId,
      amountPaise: input.amountPaise,
      currency: input.currency ?? 'INR',
      receipt: input.receipt,
      status: 'created',
      notes: input.notes ?? {},
    };
    this.orders.set(providerOrderId, record);

    return { ...record, raw: { ...record, entity: 'order' } };
  }

  async fetchOrder(providerOrderId: string): Promise<ProviderOrder> {
    const record = this.orders.get(providerOrderId);
    if (!record) throw AppError.notFound('No such provider order', { providerOrderId });
    return { ...record, raw: { ...record, entity: 'order' } };
  }

  /* ----------------------------------------------------------- payments */

  /**
   * Test-only: pretend the shopper completed the checkout widget. Returns exactly what the browser
   * would hand back, signature included.
   */
  simulateCheckout(providerOrderId: string): {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  } {
    const order = this.orders.get(providerOrderId);
    if (!order) throw AppError.notFound('No such provider order', { providerOrderId });

    const providerPaymentId = stableId('pay_mock', providerOrderId);
    const scenario = this.scenarioForAmount(order.amountPaise);

    this.payments.set(providerPaymentId, {
      providerPaymentId,
      providerOrderId,
      amountPaise: order.amountPaise,
      capturedPaise: scenario === 'failure' ? 0 : order.amountPaise,
      refundedPaise: 0,
      status: scenario === 'failure' ? 'failed' : 'captured',
      method: 'upi',
      scenario,
    });

    if (scenario !== 'failure') order.status = 'paid';

    const signature =
      scenario === 'signature-mismatch'
        ? randomBytes(32).toString('hex')
        : this.sign(`${providerOrderId}|${providerPaymentId}`);

    return { providerOrderId, providerPaymentId, signature };
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.keySecret).update(payload).digest('hex');
  }

  verifyPaymentSignature(input: {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  }): boolean {
    const expected = Buffer.from(this.sign(`${input.providerOrderId}|${input.providerPaymentId}`));
    const provided = Buffer.from(input.signature ?? '');

    // Length is not a secret, and timingSafeEqual throws on a mismatch.
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }

  async fetchPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const record = this.payments.get(providerPaymentId);
    if (!record) throw AppError.notFound('No such payment', { providerPaymentId });
    return this.toProviderPayment(record);
  }

  async capturePayment(
    providerPaymentId: string,
    amountPaise: number,
    currency = 'INR',
  ): Promise<ProviderPayment> {
    const record = this.payments.get(providerPaymentId);
    if (!record) throw AppError.notFound('No such payment', { providerPaymentId });

    if (record.scenario === 'failure') {
      throw new AppError(402, 'PAYMENT_FAILED', 'The payment was declined');
    }

    record.capturedPaise =
      record.scenario === 'partial-capture' ? Math.floor(amountPaise / 2) : amountPaise;
    record.status = 'captured';

    return { ...this.toProviderPayment(record), currency };
  }

  private toProviderPayment(record: MockPaymentRecord): ProviderPayment {
    const failed = record.status === 'failed';
    return {
      providerPaymentId: record.providerPaymentId,
      providerOrderId: record.providerOrderId,
      status: record.status,
      amountPaise: record.amountPaise,
      capturedPaise: record.capturedPaise,
      currency: 'INR',
      method: record.method,
      methodDetail: record.method === 'upi' ? 'mock@upi' : null,
      // 2% + 18% GST, the shape of a real Razorpay fee, so fee handling is exercised.
      feePaise: Math.round(record.capturedPaise * 0.02),
      taxPaise: Math.round(record.capturedPaise * 0.02 * 0.18),
      errorCode: failed ? 'BAD_REQUEST_ERROR' : null,
      errorDescription: failed ? 'Payment failed in the mock simulator' : null,
      errorSource: failed ? 'customer' : null,
      errorStep: failed ? 'payment_authentication' : null,
      errorReason: failed ? 'payment_failed' : null,
      raw: { entity: 'payment', ...record },
    };
  }

  /* ---------------------------------------------------------- transfers */

  async createTransfers(
    providerPaymentId: string,
    requests: ProviderTransferRequest[],
  ): Promise<ProviderTransfer[]> {
    const record = this.payments.get(providerPaymentId);
    if (!record) throw AppError.notFound('No such payment', { providerPaymentId });

    const created = requests.map((request, index): ProviderTransfer => {
      // Read from the CURRENT scenario, not the one frozen at payment time, so a retry after the
      // provider recovers behaves like a retry after the provider recovers. Only the FIRST leg
      // fails, because a partial failure is the case worth being able to reproduce.
      const failed = this.scenario === 'transfer-failure' && index === 0;

      return {
        providerTransferId: stableId(
          'trf_mock',
          `${providerPaymentId}:${request.account}:${index}`,
        ),
        providerRecipientId: request.account,
        amountPaise: request.amountPaise,
        feePaise: 0,
        taxPaise: 0,
        status: failed ? 'failed' : 'processed',
        onHold: request.onHold ?? false,
        settlementStatus: failed ? null : 'pending',
        errorCode: failed ? 'SERVER_ERROR' : null,
        errorDescription: failed ? 'Transfer rejected by the mock simulator' : null,
        raw: { entity: 'transfer', account: request.account, amount: request.amountPaise },
      };
    });

    this.transfers.set(providerPaymentId, [
      ...(this.transfers.get(providerPaymentId) ?? []).filter(
        (existing) =>
          !created.some((entry) => entry.providerTransferId === existing.providerTransferId),
      ),
      ...created,
    ]);

    return created;
  }

  async fetchTransfers(providerPaymentId: string): Promise<ProviderTransfer[]> {
    return this.transfers.get(providerPaymentId) ?? [];
  }

  async reverseTransfer(
    providerTransferId: string,
    amountPaise: number,
  ): Promise<ProviderReversal> {
    for (const [paymentId, list] of this.transfers) {
      const transfer = list.find((entry) => entry.providerTransferId === providerTransferId);
      if (!transfer) continue;

      // Same three-way classification as refunds: a reversal we cannot confirm must not be retried.
      if (this.scenario === 'reversal-timeout') {
        throw new ProviderCallError('UNKNOWN', 'Simulated timeout during reversal');
      }

      return {
        // Unique per call: a real provider never reuses a reversal id, and our schema enforces it.
        providerReversalId: stableId(
          'rvrsl_mock',
          `${providerTransferId}:${amountPaise}:${this.reversalNonce++}`,
        ),
        providerTransferId,
        amountPaise,
        status: 'processed',
        raw: { entity: 'reversal', paymentId, amount: amountPaise },
      };
    }
    throw AppError.notFound('No such transfer', { providerTransferId });
  }

  /* ------------------------------------------------------------ refunds */

  async createRefund(providerPaymentId: string, input: CreateRefundInput): Promise<ProviderRefund> {
    const record = this.payments.get(providerPaymentId);
    if (!record) throw AppError.notFound('No such payment', { providerPaymentId });

    // A client reference we have already seen means this is a RETRY of a refund the provider
    // accepted. Returning the original is what a real idempotent provider does, and it is what
    // stops an ambiguous timeout becoming a second refund.
    if (input.clientReference) {
      const existing = [...this.refunds.values()].find(
        (refund) => refund.clientReference === input.clientReference,
      );
      if (existing) return existing;
    }

    // The provider considered the request and said no. Nothing moved.
    if (this.scenario === 'refund-failure') {
      throw new ProviderCallError('TERMINAL', 'Simulated refund rejection', { status: 422 });
    }

    // The request never landed. Safe to retry.
    if (this.scenario === 'refund-unreachable') {
      throw new ProviderCallError('RETRYABLE', 'Simulated network failure before send');
    }

    const refundable = record.capturedPaise - record.refundedPaise;
    if (input.amountPaise > refundable) {
      /**
       * H7 - defence in depth ONLY, and deliberately permissive when asked to be.
       *
       * A remote system's validation can never be load-bearing for a local invariant: it may be
       * relaxed, versioned, or simply absent. `setPermissiveRefunds(true)` proves the LOCAL
       * reservation rejects an over-refund even when the provider would happily allow it.
       */
      if (!this.permissiveRefunds) {
        throw new ProviderCallError('TERMINAL', 'Refund is larger than the captured amount', {
          status: 422,
          details: { refundable, requested: input.amountPaise },
        });
      }
    }

    record.refundedPaise += input.amountPaise;

    const reversals: ProviderReversal[] =
      this.providerReverses && input.reverseAllTransfers
        ? (this.transfers.get(providerPaymentId) ?? []).map((transfer) => ({
            providerReversalId: stableId('rvsl_mock', `${transfer.providerTransferId}:auto`),
            providerTransferId: transfer.providerTransferId,
            // The provider reverses each transfer's share of the refund.
            amountPaise: Math.round(
              (transfer.amountPaise * input.amountPaise) / record.capturedPaise,
            ),
            status: 'processed',
            raw: { entity: 'reversal', auto: true },
          }))
        : [];

    const refund: ProviderRefund = {
      providerRefundId: stableId('rfnd_mock', `${providerPaymentId}:${record.refundedPaise}`),
      providerPaymentId,
      amountPaise: input.amountPaise,
      status: 'processed',
      speed: input.speed ?? 'NORMAL',
      errorCode: null,
      errorDescription: null,
      clientReference: input.clientReference ?? null,
      reversals,
      raw: { entity: 'refund', reverseAllTransfers: input.reverseAllTransfers ?? false },
    };

    this.refunds.set(refund.providerRefundId, refund);

    // THE DANGEROUS CASE: the provider has recorded the refund, and then the answer is lost. We
    // must not know whether it worked.
    if (this.scenario === 'refund-timeout') {
      throw new ProviderCallError('UNKNOWN', 'Simulated timeout after the provider accepted it');
    }

    return refund;
  }

  async fetchRefund(providerRefundId: string): Promise<ProviderRefund> {
    const refund = this.refunds.get(providerRefundId);
    if (!refund) throw AppError.notFound('No such refund', { providerRefundId });
    return refund;
  }

  /** H3 - lets a retry discover a refund the provider already holds for our client reference. */
  async fetchRefundsForPayment(providerPaymentId: string): Promise<ProviderRefund[]> {
    return [...this.refunds.values()].filter(
      (refund) => refund.providerPaymentId === providerPaymentId,
    );
  }

  /* -------------------------------------------------------- settlements */

  async fetchSettlements(from: Date, to: Date): Promise<ProviderSettlement[]> {
    const captured = [...this.payments.values()].filter((entry) => entry.status === 'captured');
    if (captured.length === 0) return [];

    const amountPaise = captured.reduce((sum, entry) => sum + entry.capturedPaise, 0);
    const feePaise = Math.round(amountPaise * 0.02);

    return [
      {
        providerSettlementId: stableId('setl_mock', `${from.toISOString()}:${to.toISOString()}`),
        amountPaise: amountPaise - feePaise,
        feePaise,
        taxPaise: Math.round(feePaise * 0.18),
        utr: 'MOCKUTR0000001',
        status: 'processed',
        settledAt: to.toISOString(),
        raw: { entity: 'settlement', payments: captured.length },
      },
    ];
  }

  /* ----------------------------------------------------------- webhooks */

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean {
    const expected = Buffer.from(
      createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex'),
    );
    const provided = Buffer.from(signatureHeader ?? '');

    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }

  parseWebhook(rawBody: Buffer): ParsedWebhook {
    const payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    const event = String(payload.event ?? 'unknown');
    const container = (payload.payload ?? {}) as Record<
      string,
      Record<string, { entity?: unknown }>
    >;

    // Razorpay nests as payload.<thing>.entity; take the first one that is actually present.
    const entity =
      (container.payment?.entity as Record<string, unknown> | undefined) ??
      (container.refund?.entity as Record<string, unknown> | undefined) ??
      (container.transfer?.entity as Record<string, unknown> | undefined) ??
      (container.settlement?.entity as Record<string, unknown> | undefined) ??
      (container.order?.entity as Record<string, unknown> | undefined) ??
      null;

    return {
      providerEventId: String(payload.id ?? stableId('evt_mock', rawBody.toString('utf8'))),
      eventType: event,
      entity,
      payload,
    };
  }

  /**
   * Test-only: builds a signed webhook delivery for an event, so the webhook path can be driven
   * end to end without a network or a provider dashboard.
   */
  buildWebhook(
    eventType: string,
    entity: Record<string, unknown>,
    options: { eventId?: string; entityKey?: string } = {},
  ): { body: Buffer; signature: string; eventId: string } {
    const entityKey = options.entityKey ?? eventType.split('.')[0]!;
    const eventId =
      options.eventId ?? stableId('evt_mock', `${eventType}:${JSON.stringify(entity)}`);

    const body = Buffer.from(
      JSON.stringify({
        id: eventId,
        event: eventType,
        created_at: Math.floor(Date.now() / 1000),
        payload: { [entityKey]: { entity } },
      }),
    );

    return {
      body,
      signature: createHmac('sha256', this.webhookSecret).update(body).digest('hex'),
      eventId,
    };
  }

  /** Test-only: the payment record as the provider would report it, for webhook fixtures. */
  paymentEntity(providerPaymentId: string): Record<string, unknown> {
    const record = this.payments.get(providerPaymentId);
    if (!record) throw AppError.notFound('No such payment', { providerPaymentId });

    return {
      id: record.providerPaymentId,
      entity: 'payment',
      order_id: record.providerOrderId,
      amount: record.amountPaise,
      amount_captured: record.capturedPaise,
      currency: 'INR',
      status: record.status,
      method: record.method,
    };
  }
}
