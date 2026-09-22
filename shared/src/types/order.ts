import type {
  CheckoutStep,
  FulfillmentStatus,
  OrderChannel,
  OrderStatus,
  PaymentMethodType,
  PaymentProvider,
  PaymentStatus,
  RefundReason,
  RefundStatus,
  ReservationStatus,
  SettlementStatus,
  SplitBasis,
  SplitMode,
  SplitScope,
  TransferStatus,
  WebhookStatus,
} from '../enums';
import type { PriceBreakdown, PriceComponent } from './pricing';
import type { CartIssueDto } from './cart';

/**
 * Prompt 9A — orders, the payment ledger and the Razorpay Route split.
 *
 * THE FIVE LAWS these types exist to enforce:
 *
 *  L1 the client never sends an amount — no DTO below accepts one on the way in;
 *  L2 an order is immutable money — `breakdown` is the frozen `PriceBreakdown`, replayed on read,
 *     never re-quoted;
 *  L3 the webhook is the source of truth — every provider event is persisted before it is acted on;
 *  L4 money movement is double-entry — Order → Payment → PaymentTransfer → Settlement, and
 *     Refund → TransferReversal, with a ledger check that must balance;
 *  L5 nothing is held without a release path — every reservation carries an expiry and a reason.
 */

/* ----------------------------------------------------------------- orders */

export interface OrderItemDto {
  id: string;
  productId: string;
  variantId: string | null;
  sku: string;
  productName: string;
  variantName: string | null;
  brandName: string | null;
  imageUrl: string | null;
  optionLabels: { label: string; value: string }[];
  qty: number;
  unitPricePaise: number;
  baseUnitPricePaise: number;
  lineSubtotalPaise: number;
  lineDiscountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  taxRateBp: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  hsnCode: string | null;
  lineTotalPaise: number;
  /** The per-line components frozen at placement — never recomputed. */
  components: PriceComponent[];
  isMadeToOrder: boolean;
  leadTimeDays: number | null;
  fulfilledQty: number;
  cancelledQty: number;
  refundedQty: number;
  refundedAmountPaise: number;
  position: number;
}

export interface OrderAddressDto {
  type: 'SHIPPING' | 'BILLING';
  fullName: string;
  phone: string;
  altPhone: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  country: string;
  deliveryInstructions: string | null;
}

export interface OrderTimelineEntryDto {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  note: string | null;
  actorType: string;
  actorName: string | null;
  isCustomerVisible: boolean;
  createdAt: string;
}

export interface OrderDto {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
  channel: OrderChannel;
  currency: 'INR';
  isGuest: boolean;
  customerId: string | null;
  contactEmail: string | null;
  contactPhone: string | null;

  items: OrderItemDto[];
  shippingAddress: OrderAddressDto | null;
  billingAddress: OrderAddressDto | null;

  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  roundingPaise: number;
  grandTotalPaise: number;
  totalSavingsPaise: number;
  paidPaise: number;
  refundedPaise: number;
  duePaise: number;

  couponCode: string | null;
  placeOfSupply: string;
  /** The whole frozen breakdown, exactly as the engine produced it at placement (L2). */
  breakdown: PriceBreakdown;
  pricingEngineVersion: string;

  customerNote: string | null;
  giftMessage: string | null;
  estimatedDeliveryMinDays: number | null;
  estimatedDeliveryMaxDays: number | null;

  placedAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  expiresAt: string | null;
  createdAt: string;
  version: number;
}

/** What a guest sees from `/orders/track` — deliberately narrower than `OrderDto`. */
export interface OrderTrackingDto {
  orderNumber: string;
  status: OrderStatus;
  fulfillmentStatus: FulfillmentStatus;
  placedAt: string | null;
  estimatedDeliveryMinDays: number | null;
  estimatedDeliveryMaxDays: number | null;
  itemCount: number;
  grandTotalPaise: number;
  timeline: OrderTimelineEntryDto[];
  /** City only — never the full address, and never a phone number or an email. */
  shippingCity: string | null;
}

export interface OrderSummaryDto {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  itemCount: number;
  grandTotalPaise: number;
  placedAt: string | null;
  createdAt: string;
  firstItemName: string | null;
  firstItemImageUrl: string | null;
}

/* --------------------------------------------------------------- checkout */

export interface CheckoutPaymentMethodDto {
  provider: PaymentProvider;
  label: string;
  isAvailable: boolean;
  unavailableReason: string | null;
}

export interface CheckoutSessionDto {
  id: string;
  step: CheckoutStep;
  cartId: string;
  orderId: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  shippingAddress: OrderAddressDto | null;
  billingAddress: OrderAddressDto | null;
  sameAsShipping: boolean;
  /** Always a live quote while the session is open; frozen only when the order is placed. */
  breakdown: PriceBreakdown;
  quotedTotalPaise: number;
  quoteHash: string;
  /** True when the live quote no longer matches the one the shopper agreed to. */
  priceChanged: boolean;
  methods: CheckoutPaymentMethodDto[];
  issues: CartIssueDto[];
  isCheckoutReady: boolean;
  etaMinDays: number | null;
  etaMaxDays: number | null;
  codAvailable: boolean;
  expiresAt: string;
  status: string;
  version: number;
}

/** What the payment widget needs. Note there is no amount the client can influence (L1). */
export interface PlaceOrderResultDto {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  provider: PaymentProvider;
  providerOrderId: string | null;
  /** Server-computed, echoed only so the widget can display it. */
  amountPaise: number;
  currency: 'INR';
  keyId: string | null;
  prefill: { name: string | null; email: string | null; contact: string | null };
  /** COD confirms immediately; everything else waits for the provider. */
  requiresPayment: boolean;
}

export interface VerifyPaymentResultDto {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  /** True when the webhook got there first — the verify call is then a happy no-op (L3). */
  alreadyConfirmed: boolean;
}

/* ------------------------------------------------------------- payments */

export interface PaymentDto {
  id: string;
  provider: PaymentProvider;
  method: PaymentMethodType | null;
  methodDetail: string | null;
  status: PaymentStatus;
  attemptNumber: number;
  amountPaise: number;
  capturedPaise: number;
  refundedPaise: number;
  feePaise: number | null;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  authorizedAt: string | null;
  capturedAt: string | null;
  failedAt: string | null;
  errorCode: string | null;
  errorDescription: string | null;
  createdAt: string;
}

export interface PaymentTransferDto {
  id: string;
  paymentId: string;
  splitAccountKey: string;
  splitAccountName: string;
  providerTransferId: string | null;
  providerRecipientId: string;
  amountPaise: number;
  feePaise: number | null;
  status: TransferStatus;
  onHold: boolean;
  reversedPaise: number;
  settlementStatus: SettlementStatus | null;
  processedAt: string | null;
  errorCode: string | null;
  errorDescription: string | null;
}

export interface RefundDto {
  id: string;
  refundNumber: string;
  orderId: string;
  paymentId: string;
  amountPaise: number;
  status: RefundStatus;
  reason: RefundReason;
  reasonNote: string | null;
  isFullRefund: boolean;
  providerRefundId: string | null;
  requestedByType: string;
  approvedAt: string | null;
  processedAt: string | null;
  errorCode: string | null;
  errorDescription: string | null;
  createdAt: string;
}

export interface StockReservationDto {
  id: string;
  variantId: string;
  sku: string | null;
  qty: number;
  status: ReservationStatus;
  reservedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
}

/* ------------------------------------------------------------------ split */

export interface SplitAccountDto {
  id: string;
  key: string;
  name: string;
  providerAccountId: string;
  isActive: boolean;
  isPrimary: boolean;
  notes: string | null;
  version: number;
}

export interface SplitRuleDto {
  id: string;
  code: string;
  name: string;
  scope: SplitScope;
  scopeEntityId: string | null;
  basis: SplitBasis;
  mode: SplitMode;
  valuePaise: number | null;
  valueBp: number | null;
  recipientKey: string;
  priority: number;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  minOrderPaise: number | null;
  maxTransferPaise: number | null;
  onHold: boolean;
  onHoldUntil: string | null;
  notes: string | null;
  version: number;
}

/** One line of the computed split. Zero-value rows are kept for audit but never sent to a provider. */
export interface SplitAllocationDto {
  id?: string;
  splitAccountKey: string;
  splitAccountName: string;
  providerAccountId: string;
  splitRuleCode: string | null;
  orderItemId: string | null;
  amountPaise: number;
  basisAmountPaise: number;
  mode: SplitMode;
  sequence: number;
  isRemainder: boolean;
  /** Why an allocation ended up at zero, or was clamped. */
  note: string | null;
}

export interface SplitPreviewDto {
  transferablePaise: number;
  allocations: SplitAllocationDto[];
  /** Always equals `transferablePaise`; a mismatch throws SPLIT_INVARIANT_VIOLATION (L4). */
  allocatedPaise: number;
  rulesApplied: { code: string; scope: SplitScope; mode: SplitMode; priority: number }[];
}

/* ---------------------------------------------------------------- webhook */

export interface WebhookEventDto {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  signatureValid: boolean;
  status: WebhookStatus;
  attempts: number;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  receivedAt: string;
  processedAt: string | null;
  errorMessage: string | null;
}

/* --------------------------------------------------------------- integrity */

export interface LedgerCheckDto {
  orderId: string;
  orderNumber: string;
  ok: boolean;
  checks: {
    name: string;
    ok: boolean;
    expected: number;
    actual: number;
    message: string;
  }[];
}

export interface ReconciliationReportDto {
  scanned: number;
  confirmed: number;
  released: number;
  expired: number;
  capturedWithoutTransfers: string[];
  allocationMismatches: string[];
  orphanReservations: number;
}

/* ------------------------------------------------------------------ admin */

export interface AdminOrderRowDto {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
  customerName: string | null;
  customerEmail: string | null;
  isGuest: boolean;
  itemCount: number;
  grandTotalPaise: number;
  paidPaise: number;
  refundedPaise: number;
  couponCode: string | null;
  channel: OrderChannel;
  hasFailedTransfer: boolean;
  placedAt: string | null;
  createdAt: string;
}

export interface AdminOrderDetailDto extends AdminOrderRowDto {
  order: OrderDto;
  payments: PaymentDto[];
  transfers: PaymentTransferDto[];
  allocations: SplitAllocationDto[];
  reservations: StockReservationDto[];
  refunds: RefundDto[];
  timeline: OrderTimelineEntryDto[];
  integrity: LedgerCheckDto;
}
