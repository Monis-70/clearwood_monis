import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { PaymentDriver as PaymentDriverName } from '@shared/enums';

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../utils/AppError';

import { redactProviderPayload } from './payment.driver';
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

/**
 * Razorpay, including Route split payments.
 *
 * FOUR THINGS THIS FILE IS CAREFUL ABOUT:
 *
 *  1. **No amount conversion.** Razorpay's API speaks integer paise and so do we, so an amount
 *     crosses this boundary untouched. There is deliberately not a single `* 100` in this file.
 *  2. **Retries cannot double-charge.** Only 5xx and network failures are retried, never a 4xx, and
 *     every retryable write carries an `X-Razorpay-Idempotency` key generated once per logical
 *     call — so a retry after a timeout returns the original result instead of charging again.
 *  3. **Constant-time signatures.** Both verifications use `timingSafeEqual`.
 *  4. **The key secret never escapes.** It is used to build an Authorization header and to sign,
 *     and it is never logged, never put in an error and never stored — responses go through
 *     `redactProviderPayload` before they are returned.
 *
 * The HTTP client is injected so tests can drive every branch without a network.
 */

export type HttpResponse = { status: number; body: unknown };

export interface PaymentHttpClient {
  request(init: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
  }): Promise<HttpResponse>;
}

/** The default client. `fetch` is global on Node 18+, so there is no dependency to add. */
export const fetchHttpClient: PaymentHttpClient = {
  async request({ method, url, headers, body, timeoutMs }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });

      const text = await response.text();
      return {
        status: response.status,
        body: text ? (JSON.parse(text) as unknown) : null,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

interface RazorpayErrorBody {
  error?: { code?: string; description?: string; reason?: string; step?: string; source?: string };
}

const RETRYABLE_STATUS = (status: number): boolean => status >= 500;

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class RazorpayPaymentDriver implements PaymentDriver {
  readonly name: PaymentDriverName = 'razorpay';

  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;

  constructor(
    private readonly http: PaymentHttpClient = fetchHttpClient,
    options: {
      keyId?: string;
      keySecret?: string;
      webhookSecret?: string;
      baseUrl?: string;
    } = {},
  ) {
    // env already refuses to boot with PAYMENT_DRIVER=razorpay and any of these missing.
    this.keyId = options.keyId ?? env.RAZORPAY_KEY_ID ?? '';
    this.keySecret = options.keySecret ?? env.RAZORPAY_KEY_SECRET ?? '';
    this.webhookSecret = options.webhookSecret ?? env.RAZORPAY_WEBHOOK_SECRET ?? '';
    this.baseUrl = (options.baseUrl ?? env.RAZORPAY_API_BASE).replace(/\/+$/, '');
  }

  capabilities(): PaymentDriverCapabilities {
    return {
      supportsSplit: true,
      supportsInstantRefund: true,
      supportsOnHoldTransfers: true,
      supportsPartialCapture: true,
      supportsSettlementFetch: true,
      /**
       * Razorpay CAN reverse linked-account transfers via `reverse_all`, but we do not use it: we
       * plan reversals ourselves so each one is recorded against the transfer it undoes and the
       * ledger can be verified. Advertising false here is what keeps H5's single decision honest.
       */
      reversesTransfersWithRefund: false,
      supportsClientReference: true,
      supportsIdempotencyKey: true,
    };
  }

  /* --------------------------------------------------------------- http */

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: { idempotencyKey?: string } = {},
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    // Generated ONCE per logical call, so every retry of this call is the same request to Razorpay.
    const idempotencyKey = options.idempotencyKey ?? randomUUID();

    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method === 'POST') headers['X-Razorpay-Idempotency'] = idempotencyKey;

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= env.PAYMENT_MAX_RETRIES; attempt += 1) {
      try {
        const response = await this.http.request({
          method,
          url,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          timeoutMs: env.PAYMENT_HTTP_TIMEOUT_MS,
        });

        if (response.status >= 200 && response.status < 300) return asRecord(response.body);

        // A 4xx is the provider's considered answer: retrying it can only waste time or double-charge.
        if (!RETRYABLE_STATUS(response.status)) throw this.toAppError(response);

        lastError = this.toAppError(response);
      } catch (error) {
        if (error instanceof AppError && error.statusCode < 500) throw error;
        lastError = error;
      }

      if (attempt < env.PAYMENT_MAX_RETRIES) await this.backoff(attempt);
    }

    logger.error(
      { path, method, attempts: env.PAYMENT_MAX_RETRIES + 1 },
      'razorpay call failed after retries',
    );

    throw lastError instanceof AppError
      ? lastError
      : new AppError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'The payment provider is unreachable');
  }

  /** Exponential with full jitter, so a provider blip does not turn into a thundering herd. */
  private async backoff(attempt: number): Promise<void> {
    const ceiling = Math.min(2_000 * 2 ** attempt, 10_000);
    const delay = Math.floor(Math.random() * ceiling);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private toAppError(response: HttpResponse): AppError {
    const error = (response.body as RazorpayErrorBody | null)?.error ?? {};
    const status = response.status >= 500 ? 502 : 422;

    // The description is the provider's own words; the secret is never part of it.
    return new AppError(
      status,
      status === 502 ? 'PAYMENT_PROVIDER_ERROR' : 'PAYMENT_REQUEST_REJECTED',
      error.description ?? 'The payment provider rejected the request',
      {
        providerCode: error.code ?? null,
        reason: error.reason ?? null,
        step: error.step ?? null,
        source: error.source ?? null,
      },
    );
  }

  /* ------------------------------------------------------------- orders */

  async createOrder(input: CreateOrderInput): Promise<ProviderOrder> {
    const raw = await this.call(
      'POST',
      '/v1/orders',
      {
        // Already paise on both sides — no conversion, deliberately.
        amount: input.amountPaise,
        currency: input.currency ?? 'INR',
        receipt: input.receipt,
        notes: input.notes ?? {},
        ...(input.transfers?.length
          ? {
              transfers: input.transfers.map((transfer) => ({
                account: transfer.account,
                amount: transfer.amountPaise,
                currency: transfer.currency ?? 'INR',
                notes: transfer.notes ?? {},
                on_hold: transfer.onHold ? 1 : 0,
              })),
            }
          : {}),
      },
      { idempotencyKey: `order:${input.receipt}` },
    );

    return {
      providerOrderId: String(raw.id),
      amountPaise: Number(raw.amount ?? input.amountPaise),
      currency: String(raw.currency ?? 'INR'),
      status: String(raw.status ?? 'created'),
      receipt: String(raw.receipt ?? input.receipt),
      raw: redactProviderPayload(raw) as Record<string, unknown>,
    };
  }

  async fetchOrder(providerOrderId: string): Promise<ProviderOrder> {
    const raw = await this.call('GET', `/v1/orders/${encodeURIComponent(providerOrderId)}`);

    return {
      providerOrderId: String(raw.id),
      amountPaise: Number(raw.amount ?? 0),
      currency: String(raw.currency ?? 'INR'),
      status: String(raw.status ?? 'created'),
      receipt: String(raw.receipt ?? ''),
      raw: redactProviderPayload(raw) as Record<string, unknown>,
    };
  }

  /* ----------------------------------------------------------- payments */

  verifyPaymentSignature(input: {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  }): boolean {
    const expected = Buffer.from(
      createHmac('sha256', this.keySecret)
        .update(`${input.providerOrderId}|${input.providerPaymentId}`)
        .digest('hex'),
    );
    const provided = Buffer.from(input.signature ?? '');

    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }

  private toPayment(raw: Record<string, unknown>): ProviderPayment {
    const error = asRecord(raw);

    return {
      providerPaymentId: String(raw.id),
      providerOrderId: stringOrNull(raw.order_id),
      status: String(raw.status ?? 'created'),
      amountPaise: Number(raw.amount ?? 0),
      capturedPaise: Number(raw.amount_captured ?? (raw.captured ? (raw.amount ?? 0) : 0)),
      currency: String(raw.currency ?? 'INR'),
      method: stringOrNull(raw.method),
      methodDetail: stringOrNull(raw.vpa) ?? stringOrNull(raw.bank) ?? stringOrNull(raw.wallet),
      feePaise: intOrNull(raw.fee),
      taxPaise: intOrNull(raw.tax),
      errorCode: stringOrNull(error.error_code),
      errorDescription: stringOrNull(error.error_description),
      errorSource: stringOrNull(error.error_source),
      errorStep: stringOrNull(error.error_step),
      errorReason: stringOrNull(error.error_reason),
      raw: redactProviderPayload(raw) as Record<string, unknown>,
    };
  }

  async fetchPayment(providerPaymentId: string): Promise<ProviderPayment> {
    return this.toPayment(
      await this.call('GET', `/v1/payments/${encodeURIComponent(providerPaymentId)}`),
    );
  }

  async capturePayment(
    providerPaymentId: string,
    amountPaise: number,
    currency = 'INR',
  ): Promise<ProviderPayment> {
    return this.toPayment(
      await this.call(
        'POST',
        `/v1/payments/${encodeURIComponent(providerPaymentId)}/capture`,
        { amount: amountPaise, currency },
        { idempotencyKey: `capture:${providerPaymentId}:${amountPaise}` },
      ),
    );
  }

  /* ---------------------------------------------------------- transfers */

  private toTransfer(raw: Record<string, unknown>): ProviderTransfer {
    return {
      providerTransferId: String(raw.id),
      providerRecipientId: String(raw.recipient ?? ''),
      amountPaise: Number(raw.amount ?? 0),
      feePaise: intOrNull(raw.fees),
      taxPaise: intOrNull(raw.tax),
      status: String(raw.status ?? 'pending'),
      onHold: raw.on_hold === true || raw.on_hold === 1,
      settlementStatus: stringOrNull(raw.settlement_status),
      errorCode: stringOrNull(asRecord(raw.error).code),
      errorDescription: stringOrNull(asRecord(raw.error).description),
      raw: redactProviderPayload(raw) as Record<string, unknown>,
    };
  }

  async createTransfers(
    providerPaymentId: string,
    transfers: ProviderTransferRequest[],
  ): Promise<ProviderTransfer[]> {
    const raw = await this.call(
      'POST',
      `/v1/payments/${encodeURIComponent(providerPaymentId)}/transfers`,
      {
        transfers: transfers.map((transfer) => ({
          account: transfer.account,
          amount: transfer.amountPaise,
          currency: transfer.currency ?? 'INR',
          notes: transfer.notes ?? {},
          on_hold: transfer.onHold ? 1 : 0,
          ...(transfer.onHoldUntil
            ? { on_hold_until: Math.floor(transfer.onHoldUntil.getTime() / 1000) }
            : {}),
        })),
      },
      { idempotencyKey: `transfers:${providerPaymentId}` },
    );

    const items = Array.isArray(raw.items) ? raw.items : [];
    return items.map((item) => this.toTransfer(asRecord(item)));
  }

  async fetchTransfers(providerPaymentId: string): Promise<ProviderTransfer[]> {
    const raw = await this.call(
      'GET',
      `/v1/payments/${encodeURIComponent(providerPaymentId)}/transfers`,
    );
    const items = Array.isArray(raw.items) ? raw.items : [];
    return items.map((item) => this.toTransfer(asRecord(item)));
  }

  async reverseTransfer(
    providerTransferId: string,
    amountPaise: number,
  ): Promise<ProviderReversal> {
    const raw = await this.call(
      'POST',
      `/v1/transfers/${encodeURIComponent(providerTransferId)}/reversals`,
      { amount: amountPaise },
      { idempotencyKey: `reversal:${providerTransferId}:${amountPaise}` },
    );

    return {
      providerReversalId: String(raw.id),
      providerTransferId,
      amountPaise: Number(raw.amount ?? amountPaise),
      status: String(raw.status ?? 'processed'),
      raw: redactProviderPayload(raw) as Record<string, unknown>,
    };
  }

  /* ------------------------------------------------------------ refunds */

  private toRefund(raw: Record<string, unknown>): ProviderRefund {
    const notes = asRecord(raw.notes);

    return {
      providerRefundId: String(raw.id),
      providerPaymentId: String(raw.payment_id ?? ''),
      amountPaise: Number(raw.amount ?? 0),
      status: String(raw.status ?? 'pending'),
      speed: String(raw.speed_processed ?? raw.speed_requested ?? 'normal').toUpperCase(),
      errorCode: stringOrNull(asRecord(raw.error).code),
      errorDescription: stringOrNull(asRecord(raw.error).description),
      // Razorpay has no first-class client reference, so ours rides in `notes` and comes back here.
      clientReference: stringOrNull(notes.clientReference),
      // Razorpay does not enumerate reversals on the refund body; they are fetched separately.
      reversals: [],
      raw: redactProviderPayload(raw) as Record<string, unknown>,
    };
  }

  async createRefund(providerPaymentId: string, input: CreateRefundInput): Promise<ProviderRefund> {
    const raw = await this.call(
      'POST',
      `/v1/payments/${encodeURIComponent(providerPaymentId)}/refund`,
      {
        amount: input.amountPaise,
        speed: (input.speed ?? 'NORMAL').toLowerCase(),
        notes: {
          ...(input.notes ?? {}),
          // H3 - deterministic, so a retry after a timeout can find this exact refund.
          ...(input.clientReference ? { clientReference: input.clientReference } : {}),
        },
        ...(input.reverseAllTransfers ? { reverse_all: 1 } : {}),
      },
      {
        idempotencyKey:
          input.idempotencyKey ?? `refund:${providerPaymentId}:${input.amountPaise}`,
      },
    );

    return this.toRefund(raw);
  }

  async fetchRefund(providerRefundId: string): Promise<ProviderRefund> {
    return this.toRefund(
      await this.call('GET', `/v1/refunds/${encodeURIComponent(providerRefundId)}`),
    );
  }

  async fetchRefundsForPayment(providerPaymentId: string): Promise<ProviderRefund[]> {
    const raw = await this.call(
      'GET',
      `/v1/payments/${encodeURIComponent(providerPaymentId)}/refunds?count=100`,
    );

    const items = Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [];
    return items.map((item) => this.toRefund(item));
  }

  /* -------------------------------------------------------- settlements */

  async fetchSettlements(from: Date, to: Date): Promise<ProviderSettlement[]> {
    const params = new URLSearchParams({
      from: String(Math.floor(from.getTime() / 1000)),
      to: String(Math.floor(to.getTime() / 1000)),
      count: '100',
    });

    const raw = await this.call('GET', `/v1/settlements?${params.toString()}`);
    const items = Array.isArray(raw.items) ? raw.items : [];

    return items.map((item) => {
      const entry = asRecord(item);
      return {
        providerSettlementId: String(entry.id),
        amountPaise: Number(entry.amount ?? 0),
        feePaise: Number(entry.fees ?? 0),
        taxPaise: Number(entry.tax ?? 0),
        utr: stringOrNull(entry.utr),
        status: String(entry.status ?? 'created'),
        settledAt:
          typeof entry.created_at === 'number'
            ? new Date(entry.created_at * 1000).toISOString()
            : null,
        raw: redactProviderPayload(entry) as Record<string, unknown>,
      };
    });
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
    const container = asRecord(payload.payload);

    const first = ['payment', 'refund', 'transfer', 'settlement', 'order']
      .map((key) => asRecord(asRecord(container[key]).entity))
      .find((entity) => Object.keys(entity).length > 0);

    return {
      // Razorpay sends the event id in a header; the body id is the fallback.
      providerEventId: String(payload.id ?? `${payload.event}:${payload.created_at}`),
      eventType: String(payload.event ?? 'unknown'),
      entity: first ?? null,
      payload: redactProviderPayload(payload) as Record<string, unknown>,
    };
  }
}
