import type { ProviderFailureKind, ShippingProviderDriver } from '@shared/enums';
import type { CourierOptionDto, ProviderCapabilities } from '@shared/types/fulfilment';

/**
 * The logistics provider boundary.
 *
 * Everything the fulfilment module knows about couriers goes through this interface, which is why
 * `mock` can run the entire shipment, tracking, NDR, RTO and return story offline while
 * `shiprocket` talks to a real API with the same call sequence — and why `manual` (somebody booked
 * a truck by phone) is a first-class provider rather than a special case bolted onto the services.
 *
 * FOUR RULES THE IMPLEMENTATIONS MUST HOLD:
 *
 *  1. **Capability-honest.** A driver that cannot do something says so in `capabilities()` and
 *     throws `ProviderUnsupportedError` if called anyway. Services check first; they never assume.
 *  2. **Normalised out, never raw.** Every method returns OUR shape. A caller must never have to
 *     know a provider's field names, and a provider's raw payload must never reach a customer.
 *  3. **Amounts are integer paise.** Providers quote in rupees; the conversion happens at this
 *     boundary and nowhere else.
 *  4. **Failures are classified.** Every error is a `ProviderError` carrying a `kind`, so the retry
 *     policy can tell a timeout worth retrying from a validation error that never will be.
 */

export class ProviderError extends Error {
  readonly kind: ProviderFailureKind;
  readonly status: number | null;
  readonly providerCode: string;
  readonly details: Record<string, unknown>;

  constructor(
    kind: ProviderFailureKind,
    message: string,
    options: {
      providerCode?: string;
      status?: number | null;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.providerCode = options.providerCode ?? 'UNKNOWN';
    this.details = options.details ?? {};
  }

  /** Only transient conditions. A validation error retried is a validation error twice. */
  get retryable(): boolean {
    return (
      this.kind === 'TIMEOUT' ||
      this.kind === 'TRANSPORT' ||
      this.kind === 'RATE_LIMIT' ||
      this.kind === 'PROVIDER_SERVER'
    );
  }
}

export class ProviderUnsupportedError extends ProviderError {
  constructor(providerCode: string, capability: string) {
    super('UNSUPPORTED', `${providerCode} does not support ${capability}`, { providerCode });
    this.name = 'ProviderUnsupportedError';
  }
}

/* ------------------------------------------------------------------ inputs */

export interface ProviderAddress {
  name: string;
  phone: string;
  email?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  country: string;
}

export interface ProviderParcel {
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  packageCount: number;
  declaredValuePaise: number;
}

export interface ProviderOrderLine {
  sku: string;
  name: string;
  qty: number;
  unitPricePaise: number;
  hsnCode?: string | null;
  taxRateBp?: number;
  discountPaise?: number;
}

export interface CreateShipmentOrderInput {
  /** OUR order/shipment number. Shiprocket calls this the "reference" order id. */
  referenceNumber: string;
  orderedAt: Date;
  pickupLocationName: string | null;
  billing: ProviderAddress;
  shipping: ProviderAddress | null;
  lines: ProviderOrderLine[];
  parcel: ProviderParcel;
  isCod: boolean;
  codAmountPaise: number;
  subTotalPaise: number;
  isReturn?: boolean;
}

export interface CreatedShipmentOrder {
  providerOrderId: string;
  providerShipmentId: string | null;
  status: string | null;
  raw: Record<string, unknown>;
}

export interface ServiceabilityInput {
  pickupPincode: string;
  deliveryPincode: string;
  weightGrams: number;
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  isCod: boolean;
  declaredValuePaise: number;
  isReturn?: boolean;
}

export interface AssignAwbInput {
  providerShipmentId: string;
  providerOrderId: string;
  courierId?: string | null;
  isReturn?: boolean;
}

export interface AssignedAwb {
  awbNumber: string;
  courierId: string | null;
  courierName: string | null;
  /** What the courier charges us, in paise. */
  chargePaise: number;
  estimatedDeliveryAt: string | null;
  raw: Record<string, unknown>;
}

export interface PickupResult {
  scheduledAt: string | null;
  tokenNumber: string | null;
  status: string | null;
  raw: Record<string, unknown>;
}

export interface DocumentResult {
  /** A provider URL. We FETCH it server-side and re-serve it signed; we never hand it out raw. */
  url: string | null;
  raw: Record<string, unknown>;
}

export interface TrackingScan {
  occurredAt: string;
  description: string;
  location: string | null;
  providerStatus: string | null;
  providerStatusCode: string | null;
  /** Stable per scan, so a replayed webhook cannot double a timeline. */
  dedupeKey: string;
}

export interface TrackingResult {
  awbNumber: string | null;
  courierName: string | null;
  providerStatus: string | null;
  providerStatusCode: string | null;
  estimatedDeliveryAt: string | null;
  deliveredAt: string | null;
  isReturn: boolean;
  scans: TrackingScan[];
  raw: Record<string, unknown>;
}

export interface CancelResult {
  cancelled: boolean;
  status: string | null;
  message: string | null;
  raw: Record<string, unknown>;
}

export interface NdrRecordInput {
  awbNumber: string;
  action: 'REATTEMPT' | 'RETURN' | 'CONTACT_BUYER' | 'FAKE_ATTEMPT';
  note?: string;
  reattemptDate?: Date;
}

export interface ProviderNdr {
  providerNdrId: string;
  awbNumber: string;
  reason: string;
  reasonCode: string | null;
  attemptCount: number;
  raisedAt: string;
  raw: Record<string, unknown>;
}

export interface ProviderPickupLocation {
  providerLocationId: string;
  name: string;
  pincode: string;
  city: string | null;
  state: string | null;
  raw: Record<string, unknown>;
}

export interface ParsedShippingWebhook {
  /** Stable event identity. Derived when the provider does not supply one. */
  providerEventId: string;
  eventType: string;
  awbNumber: string | null;
  providerOrderId: string | null;
  providerShipmentId: string | null;
  referenceNumber: string | null;
  providerStatus: string | null;
  providerStatusCode: string | null;
  courierName: string | null;
  estimatedDeliveryAt: string | null;
  isReturn: boolean;
  scans: TrackingScan[];
  /** Already redacted. */
  payload: Record<string, unknown>;
}

export interface ProviderHealth {
  reachable: boolean;
  authenticated: boolean;
  message: string;
  failureKind: ProviderFailureKind | null;
}

/* ------------------------------------------------------------- the driver */

export interface ShippingProviderDriverContract {
  readonly name: ShippingProviderDriver;
  readonly providerCode: string;

  capabilities(): ProviderCapabilities;
  health(): Promise<ProviderHealth>;

  createOrder(input: CreateShipmentOrderInput): Promise<CreatedShipmentOrder>;
  serviceability(input: ServiceabilityInput): Promise<CourierOptionDto[]>;
  assignAwb(input: AssignAwbInput): Promise<AssignedAwb>;
  schedulePickup(providerShipmentId: string, pickupDate?: Date): Promise<PickupResult>;
  generateLabel(providerShipmentId: string): Promise<DocumentResult>;
  generateManifest(providerShipmentId: string): Promise<DocumentResult>;

  trackByAwb(awbNumber: string): Promise<TrackingResult>;
  trackByShipment(providerShipmentId: string): Promise<TrackingResult>;

  cancelShipment(input: {
    providerOrderId: string | null;
    providerShipmentId: string | null;
    awbNumber: string | null;
  }): Promise<CancelResult>;

  createReturn(input: CreateShipmentOrderInput): Promise<CreatedShipmentOrder>;

  fetchNdr(awbNumber?: string): Promise<ProviderNdr[]>;
  actOnNdr(input: NdrRecordInput): Promise<{ accepted: boolean; message: string | null }>;

  pickupLocations(): Promise<ProviderPickupLocation[]>;

  /** Verified against the raw body BEFORE it is parsed. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;
  parseWebhook(rawBody: Buffer): ParsedShippingWebhook;
}

/* ----------------------------------------------------------------- helpers */

/** Providers quote rupees; every amount crosses this boundary as integer paise. */
export function rupeesToPaise(rupees: number | string | null | undefined): number {
  if (rupees === null || rupees === undefined || rupees === '') return 0;

  const value = typeof rupees === 'string' ? Number(rupees) : rupees;
  if (!Number.isFinite(value)) return 0;

  return Math.round(value * 100);
}

export function paiseToRupees(paise: number): number {
  return Math.round(paise) / 100;
}

/** Grams -> kilograms, which is what every Indian courier API speaks. */
export function gramsToKg(grams: number): number {
  return Math.max(Math.round(grams) / 1000, 0.01);
}

export function mmToCm(mm: number): number {
  return Math.max(Math.round(mm) / 10, 0.5);
}

const REDACTED_KEYS = new Set([
  'password',
  'token',
  'api_key',
  'apikey',
  'x-api-key',
  'authorization',
  'secret',
  'access_token',
  'refresh_token',
]);

/** Everything a provider says passes through here before it is logged or stored. */
export function redactShippingPayload(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[CIRCULAR]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((entry) => redactShippingPayload(entry, seen));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase())
      ? '[REDACTED]'
      : redactShippingPayload(entry, seen);
  }
  return out;
}

export function redactedShippingJson(value: unknown): string {
  return JSON.stringify(redactShippingPayload(value));
}
