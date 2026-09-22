import type { PaymentDriver as PaymentDriverName, ProviderOutcome } from '@shared/enums';

/**
 * The payment provider boundary.
 *
 * Everything the order module knows about money movement goes through this interface, which is why
 * `mock` can run the entire checkout, split, webhook and refund story offline while `razorpay`
 * talks to the real API with the same call sequence.
 *
 * TWO RULES THE IMPLEMENTATIONS MUST HOLD:
 *
 *  - **Amounts are integer paise, end to end.** Razorpay's API is already in paise, so there is no
 *    conversion anywhere in this layer. A driver that multiplies or divides by 100 is a bug.
 *  - **Signature checks are constant-time.** Both `verifyPaymentSignature` and
 *    `verifyWebhookSignature` compare with `timingSafeEqual`; neither may return early on the first
 *    differing byte.
 */

export interface PaymentDriverCapabilities {
  supportsSplit: boolean;
  supportsInstantRefund: boolean;
  supportsOnHoldTransfers: boolean;
  supportsPartialCapture: boolean;
  supportsSettlementFetch: boolean;
  /**
   * H5 - true when the provider reverses linked-account transfers as PART of the refund.
   * If it does, issuing our own reversals as well would take the money back twice.
   */
  reversesTransfersWithRefund: boolean;
  /** True when a client reference can be sent and later searched for, which is what makes H3 work. */
  supportsClientReference: boolean;
  supportsIdempotencyKey: boolean;
}

/**
 * H4 - a provider failure carrying the only thing that actually matters: whether we KNOW what
 * happened.
 *
 * A timeout is not a failure. The request may well have been received, processed and charged; all
 * that failed is our knowledge of it. Collapsing that into "failed" is how a customer gets refunded
 * twice.
 */
export class ProviderCallError extends Error {
  readonly outcome: ProviderOutcome;
  readonly providerCode: string | null;
  readonly status: number | null;
  readonly details: Record<string, unknown>;

  constructor(
    outcome: ProviderOutcome,
    message: string,
    options: {
      providerCode?: string | null;
      status?: number | null;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderCallError';
    this.outcome = outcome;
    this.providerCode = options.providerCode ?? null;
    this.status = options.status ?? null;
    this.details = options.details ?? {};
  }
}

export interface ProviderTransferRequest {
  /** The provider's linked-account id (`acc_...`), resolved from SplitAccount.providerAccountId. */
  account: string;
  amountPaise: number;
  currency?: string;
  notes?: Record<string, string>;
  onHold?: boolean;
  onHoldUntil?: Date | null;
}

export interface ProviderOrder {
  providerOrderId: string;
  amountPaise: number;
  currency: string;
  status: string;
  receipt?: string;
  raw: Record<string, unknown>;
}

export interface ProviderPayment {
  providerPaymentId: string;
  providerOrderId: string | null;
  status: string;
  amountPaise: number;
  capturedPaise: number;
  currency: string;
  method: string | null;
  methodDetail: string | null;
  feePaise: number | null;
  taxPaise: number | null;
  errorCode: string | null;
  errorDescription: string | null;
  errorSource: string | null;
  errorStep: string | null;
  errorReason: string | null;
  raw: Record<string, unknown>;
}

export interface ProviderTransfer {
  providerTransferId: string;
  providerRecipientId: string;
  amountPaise: number;
  feePaise: number | null;
  taxPaise: number | null;
  status: string;
  onHold: boolean;
  settlementStatus: string | null;
  errorCode: string | null;
  errorDescription: string | null;
  raw: Record<string, unknown>;
}

export interface ProviderReversal {
  providerReversalId: string;
  providerTransferId: string;
  amountPaise: number;
  status: string;
  raw: Record<string, unknown>;
}

export interface ProviderRefund {
  providerRefundId: string;
  providerPaymentId: string;
  amountPaise: number;
  status: string;
  speed: string;
  errorCode: string | null;
  errorDescription: string | null;
  /** Our own reference, echoed back by the provider. Null when the provider did not keep it. */
  clientReference: string | null;
  /** Reversals the provider performed itself as part of this refund (H5). */
  reversals: ProviderReversal[];
  raw: Record<string, unknown>;
}

export interface ProviderSettlement {
  providerSettlementId: string;
  amountPaise: number;
  feePaise: number;
  taxPaise: number;
  utr: string | null;
  status: string;
  settledAt: string | null;
  raw: Record<string, unknown>;
}

export interface ParsedWebhook {
  providerEventId: string;
  eventType: string;
  /** The primary entity the event is about — a payment, refund, transfer or settlement. */
  entity: Record<string, unknown> | null;
  payload: Record<string, unknown>;
}

export interface CreateOrderInput {
  amountPaise: number;
  currency?: string;
  receipt: string;
  notes?: Record<string, string>;
  /** Route transfers attached at order time; we attach ours after capture instead. */
  transfers?: ProviderTransferRequest[];
}

export interface CreateRefundInput {
  amountPaise: number;
  speed?: 'NORMAL' | 'OPTIMUM';
  notes?: Record<string, string>;
  reverseAllTransfers?: boolean;
  /** Deterministic per refund. Sent to the provider so a retry can find the original (H3). */
  clientReference?: string;
  /** Provider idempotency header value, when `capabilities().supportsIdempotencyKey`. */
  idempotencyKey?: string;
}

export interface PaymentDriver {
  readonly name: PaymentDriverName;

  createOrder(input: CreateOrderInput): Promise<ProviderOrder>;
  fetchOrder(providerOrderId: string): Promise<ProviderOrder>;

  /** HMAC-SHA256 of `${providerOrderId}|${providerPaymentId}`, compared in constant time. */
  verifyPaymentSignature(input: {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  }): boolean;

  fetchPayment(providerPaymentId: string): Promise<ProviderPayment>;
  capturePayment(
    providerPaymentId: string,
    amountPaise: number,
    currency?: string,
  ): Promise<ProviderPayment>;

  createTransfers(
    providerPaymentId: string,
    transfers: ProviderTransferRequest[],
  ): Promise<ProviderTransfer[]>;
  fetchTransfers(providerPaymentId: string): Promise<ProviderTransfer[]>;
  reverseTransfer(providerTransferId: string, amountPaise: number): Promise<ProviderReversal>;

  createRefund(providerPaymentId: string, input: CreateRefundInput): Promise<ProviderRefund>;
  fetchRefund(providerRefundId: string): Promise<ProviderRefund>;
  /**
   * H3 - every refund the provider holds against a payment.
   *
   * This is what turns an ambiguous timeout into a decidable question: we sent a deterministic
   * `clientReference`, so we can ask whether the provider already has a refund carrying it rather
   * than guessing and issuing a second one.
   */
  fetchRefundsForPayment(providerPaymentId: string): Promise<ProviderRefund[]>;

  fetchSettlements(from: Date, to: Date): Promise<ProviderSettlement[]>;

  /** HMAC-SHA256 of the RAW request body, compared in constant time. */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean;
  parseWebhook(rawBody: Buffer): ParsedWebhook;

  capabilities(): PaymentDriverCapabilities;
}

/**
 * H4 - the single place a provider failure is classified.
 *
 * THE DEFAULT IS `UNKNOWN`, deliberately. When something fails in a way we have not explicitly
 * reasoned about, the honest answer about somebody's money is "we do not know", and the expensive
 * mistake is assuming otherwise. Only a failure we can positively identify as a business rejection
 * (the provider read it and said no) or as never-sent is allowed to be anything else.
 */
export function classifyProviderError(error: unknown): ProviderOutcome {
  if (error instanceof ProviderCallError) return error.outcome;

  const candidate = error as { name?: string; code?: string; statusCode?: number };

  // An aborted request: the provider may have received and processed it regardless.
  if (candidate.name === 'AbortError' || candidate.code === 'ETIMEDOUT') return 'UNKNOWN';

  // Never established a connection, so nothing can have been received.
  if (candidate.code === 'ECONNREFUSED' || candidate.code === 'ENOTFOUND') return 'RETRYABLE';

  // Reset mid-flight: the request may have been fully delivered before the socket died.
  if (candidate.code === 'ECONNRESET' || candidate.code === 'EPIPE') return 'UNKNOWN';

  if (typeof candidate.statusCode === 'number') {
    // The provider considered it and rejected it. Retrying cannot change the answer.
    if (candidate.statusCode >= 400 && candidate.statusCode < 500) return 'TERMINAL';
  }

  return 'UNKNOWN';
}

/**
 * Keys whose values must never reach a log line, an error body or `rawResponseJson`.
 * `redactProviderPayload` is the single place that enforces it.
 */
const REDACTED_KEYS = new Set([
  'key_secret',
  'keysecret',
  'secret',
  'password',
  'token',
  'authorization',
  'card_number',
  'cardnumber',
  'number',
  'cvv',
  'expiry_month',
  'expiry_year',
  'pin',
  'signature',
  'webhook_secret',
]);

const KEEP_LAST_4 = new Set(['last4', 'card_last4']);

export const REDACTED = '[REDACTED]';

/** Deep-clones a provider payload with every secret-ish value replaced. Cycles are cut, not thrown. */
export function redactProviderPayload(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[CIRCULAR]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((entry) => redactProviderPayload(entry, seen));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();

    if (KEEP_LAST_4.has(lower)) {
      out[key] = entry;
    } else if (REDACTED_KEYS.has(lower)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactProviderPayload(entry, seen);
    }
  }
  return out;
}

/** What actually gets written to a `rawResponseJson` column. */
export function redactedJson(value: unknown): string {
  return JSON.stringify(redactProviderPayload(value));
}
