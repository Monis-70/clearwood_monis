import type {
  CourierStrategy,
  DocumentType,
  NdrAction,
  NdrPolicy,
  NdrStatus,
  NotificationChannel,
  NotificationEvent,
  NotificationStatus,
  PackagingType,
  ProviderFailureKind,
  ProviderOperationStatus,
  ReturnItemCondition,
  ReturnReason,
  ReturnResolution,
  ReturnStatus,
  ShipmentDirection,
  ShipmentEventSource,
  ShipmentStatus,
  ShippingProviderDriver,
} from '../enums';

/**
 * Prompt 9B — fulfilment, shipments, returns, documents and notifications.
 *
 * THE RULE THAT SHAPES EVERY TYPE BELOW: **the local Shipment is the source of truth.** Provider
 * identifiers (`providerOrderId`, `providerShipmentId`, `awbNumber`, `providerStatus`) are external
 * references we store so we can talk to the courier, not fields we take orders from. A courier
 * renaming a status, or returning one we have never seen, must never be able to corrupt an order.
 *
 * THE OTHER RULE: **nothing here re-prices anything.** A shipping provider's charge is an
 * operational cost recorded on the shipment; the customer's frozen order total (Prompt 9A, law L2)
 * is untouchable.
 */

/* ---------------------------------------------------------------- provider */

export interface ProviderCapabilities {
  supportsForwardShipment: boolean;
  supportsReversePickup: boolean;
  supportsNdr: boolean;
  supportsExchange: boolean;
  supportsTracking: boolean;
  supportsLabel: boolean;
  supportsManifest: boolean;
  supportsCod: boolean;
  supportsCancellation: boolean;
  supportsServiceability: boolean;
  supportsPickupLocations: boolean;
}

export interface ShippingProviderDto {
  id: string;
  code: string;
  name: string;
  driver: ShippingProviderDriver;
  isActive: boolean;
  isDefault: boolean;
  /** True once credentials are present. The credentials themselves are never returned. */
  isConfigured: boolean;
  capabilities: ProviderCapabilities;
  lastHealthyAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  notes: string | null;
  version: number;
}

export interface ProviderHealthDto {
  code: string;
  driver: ShippingProviderDriver;
  reachable: boolean;
  authenticated: boolean;
  checkedAt: string;
  message: string;
  /** Present only when the driver could not be reached — never a credential. */
  failureKind: ProviderFailureKind | null;
}

export interface ProviderOperationDto {
  id: string;
  providerCode: string;
  operation: string;
  entityType: string;
  entityId: string;
  status: ProviderOperationStatus;
  attempt: number;
  failureKind: ProviderFailureKind | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/* ------------------------------------------------------- pickup locations */

export interface PickupLocationDto {
  id: string;
  code: string;
  name: string;
  providerCode: string | null;
  /** The provider's own name for this pickup point, which its API addresses it by. */
  providerLocationId: string | null;
  contactName: string;
  phone: string;
  email: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  country: string;
  isActive: boolean;
  isDefault: boolean;
  version: number;
}

/* ---------------------------------------------------------- serviceability */

export interface CourierOptionDto {
  courierId: string;
  courierName: string;
  service: string | null;
  estimatedDeliveryDays: number | null;
  estimatedDeliveryDate: string | null;
  estimatedPickupDate: string | null;
  /** What the courier charges US. Never added to the customer's frozen order total. */
  chargePaise: number;
  codAvailable: boolean;
  codChargePaise: number;
  reversePickupAvailable: boolean;
  rating: number | null;
  /** An opaque handle for the follow-up call. Never the provider's raw payload. */
  providerRawReference: string | null;
  providerCode: string;
  isRecommended: boolean;
  recommendationReason: string | null;
}

export interface ServiceabilityResultDto {
  providerCode: string;
  pickupPincode: string;
  deliveryPincode: string;
  isServiceable: boolean;
  codAvailable: boolean;
  options: CourierOptionDto[];
  strategy: CourierStrategy;
  checkedAt: string;
  message: string | null;
}

/* ---------------------------------------------------------------- shipment */

export interface ShipmentItemDto {
  id: string;
  orderItemId: string;
  sku: string;
  productName: string;
  variantName: string | null;
  qty: number;
}

export interface ShipmentEventDto {
  id: string;
  status: ShipmentStatus | null;
  providerStatus: string | null;
  providerStatusCode: string | null;
  description: string;
  location: string | null;
  source: ShipmentEventSource;
  occurredAt: string;
  isCustomerVisible: boolean;
}

export interface ShipmentPackageDto {
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  packageCount: number;
  packagingType: PackagingType;
  declaredValuePaise: number;
}

export interface ShipmentDto {
  id: string;
  shipmentNumber: string;
  orderId: string;
  orderNumber: string;
  direction: ShipmentDirection;
  status: ShipmentStatus;

  providerCode: string;
  providerOrderId: string | null;
  providerShipmentId: string | null;
  providerCourierId: string | null;
  providerCourierName: string | null;
  awbNumber: string | null;
  /** The courier's own words, kept purely for diagnostics. Never drives a transition alone. */
  providerStatus: string | null;
  providerStatusCode: string | null;

  isCod: boolean;
  codAmountPaise: number;
  /** Operational cost, not customer money. */
  shippingCostPaise: number;

  package: ShipmentPackageDto;
  pickupLocationCode: string | null;
  pickupScheduledAt: string | null;
  pickupTokenNumber: string | null;

  estimatedDeliveryAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;

  labelDocumentId: string | null;
  manifestDocumentId: string | null;

  lastSyncedAt: string | null;
  items: ShipmentItemDto[];
  events: ShipmentEventDto[];
  version: number;
  createdAt: string;
}

/** What a customer is allowed to see. No provider ids, no cost, no internal notes. */
export interface ShipmentTrackingDto {
  shipmentNumber: string;
  status: ShipmentStatus;
  courierName: string | null;
  awbNumber: string | null;
  estimatedDeliveryAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  events: { description: string; location: string | null; occurredAt: string }[];
  items: { sku: string; productName: string; qty: number }[];
}

/* --------------------------------------------------------------------- NDR */

export interface NdrRecordDto {
  id: string;
  shipmentId: string;
  shipmentNumber: string;
  orderNumber: string;
  awbNumber: string | null;
  reason: string;
  reasonCode: string | null;
  attemptCount: number;
  status: NdrStatus;
  actionTaken: NdrAction | null;
  actionNote: string | null;
  actedById: string | null;
  actedAt: string | null;
  raisedAt: string;
}

/* ----------------------------------------------------------------- returns */

export interface ReturnItemDto {
  id: string;
  orderItemId: string;
  sku: string;
  productName: string;
  variantName: string | null;
  qtyRequested: number;
  qtyApproved: number;
  qtyReceived: number;
  qtyRestocked: number;
  condition: ReturnItemCondition;
  inspectionNote: string | null;
  /** Taken from the FROZEN order line. Never recomputed. */
  refundableAmountPaise: number;
  refundableTaxPaise: number;
}

export interface ReturnRequestDto {
  id: string;
  returnNumber: string;
  orderId: string;
  orderNumber: string;
  customerId: string | null;
  status: ReturnStatus;
  reason: ReturnReason;
  reasonNote: string | null;
  resolution: ReturnResolution;
  isExchange: boolean;

  items: ReturnItemDto[];
  /** The reverse shipment, once one exists. */
  shipmentId: string | null;
  shipmentNumber: string | null;
  refundId: string | null;

  requestedAmountPaise: number;
  approvedAmountPaise: number;
  refundedAmountPaise: number;

  requestedByType: string;
  approvedById: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  receivedAt: string | null;
  inspectedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  version: number;
}

/* --------------------------------------------------------------- documents */

export interface OrderDocumentDto {
  id: string;
  orderId: string;
  shipmentId: string | null;
  type: DocumentType;
  documentNumber: string | null;
  /** SHA-256 of the stored bytes: an invoice that changed is a detectable event. */
  checksum: string;
  sizeBytes: number;
  mimeType: string;
  issuedAt: string;
  /** Short-lived and signed. Never a raw provider URL. */
  downloadUrl: string | null;
}

/* ----------------------------------------------------------- notifications */

export interface NotificationTemplateDto {
  id: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  subject: string | null;
  body: string;
  isActive: boolean;
  version: number;
}

export interface NotificationLogDto {
  id: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  recipient: string;
  status: NotificationStatus;
  orderId: string | null;
  shipmentId: string | null;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------- settings */

export interface ShippingSettingsDto {
  defaultProviderCode: string;
  manualFallbackEnabled: boolean;
  autoAssignCourier: boolean;
  courierStrategy: CourierStrategy;
  courierPriority: string[];
  defaultPickupLocationCode: string | null;
  codEnabled: boolean;
  codMinOrderPaise: number;
  codMaxOrderPaise: number;
  returnPickupEnabled: boolean;
  returnWindowDays: number;
  ndrPolicy: NdrPolicy;
  autoGenerateLabel: boolean;
  autoGenerateManifest: boolean;
  autoInvoiceOnShip: boolean;
  trackingSyncMinutes: number;
  providerMaxRetries: number;
  providerRetryBackoffMs: number;
  allowShipmentCancellation: boolean;
  rtoRestockEnabled: boolean;
}

/* ---------------------------------------------------------- reconciliation */

export interface ShipmentReconciliationIssueDto {
  shipmentId: string;
  shipmentNumber: string;
  orderNumber: string;
  issue:
    | 'MISSING_PROVIDER_ORDER'
    | 'MISSING_AWB'
    | 'AWB_MISMATCH'
    | 'STALE_LOCAL_STATUS'
    | 'UNKNOWN_PROVIDER_STATUS'
    | 'CANCELLED_LOCALLY_ACTIVE_REMOTELY'
    | 'DUPLICATE_PROVIDER_ORDER'
    | 'DELIVERED_REMOTELY_NOT_LOCALLY'
    | 'RTO_REMOTELY_NOT_LOCALLY';
  detail: string;
  localValue: string | null;
  providerValue: string | null;
  /** True when `repair` can fix it without a human deciding anything. */
  autoRepairable: boolean;
}

export interface ShipmentReconciliationReportDto {
  scanned: number;
  synced: number;
  repaired: number;
  issues: ShipmentReconciliationIssueDto[];
  checkedAt: string;
}

/* ------------------------------------------------------------- reporting */

export interface ShipmentSummaryReportDto {
  byStatus: { status: ShipmentStatus; count: number }[];
  byCourier: { courierName: string; count: number; costPaise: number }[];
  totals: {
    shipments: number;
    delivered: number;
    undelivered: number;
    rto: number;
    returns: number;
    codShipments: number;
    shippingCostPaise: number;
  };
  slaDays: { averageDeliveryDays: number | null; onTimeRateBp: number | null };
}
