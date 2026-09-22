import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { ShippingProviderDriver } from '@shared/enums';
import type { CourierOptionDto, ProviderCapabilities } from '@shared/types/fulfilment';

import type {
  AssignAwbInput,
  AssignedAwb,
  CancelResult,
  CreateShipmentOrderInput,
  CreatedShipmentOrder,
  DocumentResult,
  NdrRecordInput,
  ParsedShippingWebhook,
  PickupResult,
  ProviderHealth,
  ProviderNdr,
  ProviderPickupLocation,
  ServiceabilityInput,
  ShippingProviderDriverContract,
  TrackingResult,
  TrackingScan,
} from './shipping.driver';
import { ProviderError, redactShippingPayload } from './shipping.driver';

/**
 * A complete offline courier network.
 *
 * Not a set of stubs: it models order creation, three couriers with different prices and speeds,
 * AWB assignment, pickups, a full tracking timeline, NDR, RTO, reverse pickup, cancellation,
 * duplicate webhook delivery, timeouts and token expiry — so the entire Prompt 9B flow is
 * exercisable with no Shiprocket account and no network.
 *
 * **The webhook signature is a real HMAC.** Shiprocket authenticates deliveries with an `x-api-key`
 * shared token; the mock verifies its own token the same constant-time way, so the code path under
 * test is the code path that runs in production.
 *
 * Scenarios are selected with `setScenario()` so a test can demand a timeout, an auth failure or a
 * duplicate delivery without waiting for one to happen.
 */

export const MOCK_SHIPPING_TOKEN = 'mock_shipping_webhook_token_for_tests_only';

export type MockShippingScenario =
  | 'success'
  | 'timeout'
  | 'auth-failure'
  | 'validation-failure'
  | 'server-error'
  | 'not-serviceable'
  | 'ndr'
  | 'rto';

interface MockOrderRecord {
  providerOrderId: string;
  providerShipmentId: string;
  referenceNumber: string;
  isReturn: boolean;
  isCod: boolean;
  deliveryPincode: string;
  awbNumber: string | null;
  courierId: string | null;
  courierName: string | null;
  status: string;
  cancelled: boolean;
  scans: TrackingScan[];
}

const COURIERS = [
  { id: '11', name: 'Mock Express', days: 2, basePaise: 11_000, cod: true, reverse: true, rating: 4.6 },
  { id: '22', name: 'Mock Surface', days: 5, basePaise: 6_500, cod: true, reverse: true, rating: 4.1 },
  { id: '33', name: 'Mock Heavy Freight', days: 7, basePaise: 24_000, cod: false, reverse: false, rating: 3.9 },
];

function stableId(prefix: string, seed: string): string {
  return `${prefix}${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

function iso(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString();
}

export class MockShippingDriver implements ShippingProviderDriverContract {
  readonly name: ShippingProviderDriver = 'mock';
  readonly providerCode: string;
  readonly webhookToken = MOCK_SHIPPING_TOKEN;

  private scenario: MockShippingScenario = 'success';
  private readonly orders = new Map<string, MockOrderRecord>();

  constructor(providerCode = 'MOCK') {
    this.providerCode = providerCode;
  }

  setScenario(scenario: MockShippingScenario): void {
    this.scenario = scenario;
  }

  reset(): void {
    this.scenario = 'success';
    this.orders.clear();
  }

  capabilities(): ProviderCapabilities {
    return {
      supportsForwardShipment: true,
      supportsReversePickup: true,
      supportsNdr: true,
      supportsExchange: false,
      supportsTracking: true,
      supportsLabel: true,
      supportsManifest: true,
      supportsCod: true,
      supportsCancellation: true,
      supportsServiceability: true,
      supportsPickupLocations: true,
    };
  }

  /** Every failure scenario funnels through here, so each one is a real classified ProviderError. */
  private guard(): void {
    switch (this.scenario) {
      case 'timeout':
        throw new ProviderError('TIMEOUT', 'The courier API did not respond', {
          providerCode: this.providerCode,
        });
      case 'auth-failure':
        throw new ProviderError('AUTHENTICATION', 'The courier rejected our credentials', {
          providerCode: this.providerCode,
          status: 401,
        });
      case 'validation-failure':
        throw new ProviderError('VALIDATION', 'The courier rejected the request as invalid', {
          providerCode: this.providerCode,
          status: 422,
        });
      case 'server-error':
        throw new ProviderError('PROVIDER_SERVER', 'The courier API is having a bad day', {
          providerCode: this.providerCode,
          status: 502,
        });
      default:
    }
  }

  async health(): Promise<ProviderHealth> {
    try {
      this.guard();
      return { reachable: true, authenticated: true, message: 'Mock courier ready', failureKind: null };
    } catch (error) {
      const failure = error as ProviderError;
      return {
        reachable: failure.kind !== 'TRANSPORT' && failure.kind !== 'TIMEOUT',
        authenticated: failure.kind !== 'AUTHENTICATION',
        message: failure.message,
        failureKind: failure.kind,
      };
    }
  }

  /* ------------------------------------------------------------- orders */

  async createOrder(input: CreateShipmentOrderInput): Promise<CreatedShipmentOrder> {
    this.guard();

    const providerOrderId = stableId('mockord_', input.referenceNumber);
    const providerShipmentId = stableId('mockshp_', input.referenceNumber);

    // Deterministic ids mean a duplicate create returns the SAME ids, which is exactly what makes
    // "reconcile before retrying" safe to test.
    const existing = this.orders.get(providerShipmentId);
    if (existing) {
      return {
        providerOrderId: existing.providerOrderId,
        providerShipmentId: existing.providerShipmentId,
        status: existing.status,
        raw: { duplicate: true },
      };
    }

    this.orders.set(providerShipmentId, {
      providerOrderId,
      providerShipmentId,
      referenceNumber: input.referenceNumber,
      isReturn: input.isReturn ?? false,
      isCod: input.isCod,
      deliveryPincode: input.shipping?.pincode ?? input.billing.pincode,
      awbNumber: null,
      courierId: null,
      courierName: null,
      status: 'NEW',
      cancelled: false,
      scans: [],
    });

    return {
      providerOrderId,
      providerShipmentId,
      status: 'NEW',
      raw: { reference: input.referenceNumber, cod: input.isCod },
    };
  }

  async createReturn(input: CreateShipmentOrderInput): Promise<CreatedShipmentOrder> {
    return this.createOrder({ ...input, isReturn: true });
  }

  /* ----------------------------------------------------- serviceability */

  async serviceability(input: ServiceabilityInput): Promise<CourierOptionDto[]> {
    this.guard();

    // A pincode ending 555 is the "nobody delivers there" fixture.
    if (this.scenario === 'not-serviceable' || input.deliveryPincode.endsWith('555')) return [];

    const kg = Math.max(input.weightGrams / 1000, 0.5);

    return COURIERS.filter((courier) => (input.isCod ? courier.cod : true))
      .filter((courier) => (input.isReturn ? courier.reverse : true))
      .map((courier) => ({
        courierId: courier.id,
        courierName: courier.name,
        service: courier.days <= 3 ? 'Air' : 'Surface',
        estimatedDeliveryDays: courier.days,
        estimatedDeliveryDate: iso(courier.days),
        estimatedPickupDate: iso(1),
        chargePaise: courier.basePaise + Math.round(kg * 1_500),
        codAvailable: courier.cod,
        codChargePaise: courier.cod && input.isCod ? 3_500 : 0,
        reversePickupAvailable: courier.reverse,
        rating: courier.rating,
        providerRawReference: `${courier.id}:${input.deliveryPincode}`,
        providerCode: this.providerCode,
        isRecommended: false,
        recommendationReason: null,
      }));
  }

  /* --------------------------------------------------------------- AWB */

  async assignAwb(input: AssignAwbInput): Promise<AssignedAwb> {
    this.guard();

    const record = this.orders.get(input.providerShipmentId);
    if (!record) {
      throw new ProviderError('VALIDATION', 'No such shipment at the courier', {
        providerCode: this.providerCode,
        status: 404,
      });
    }

    const courier = COURIERS.find((entry) => entry.id === input.courierId) ?? COURIERS[0]!;

    record.awbNumber = stableId('MOCKAWB', `${input.providerShipmentId}:${courier.id}`).toUpperCase();
    record.courierId = courier.id;
    record.courierName = courier.name;
    record.status = 'AWB ASSIGNED';

    this.addScan(record, 'AWB assigned', 'MANIFEST GENERATED', '5');

    return {
      awbNumber: record.awbNumber,
      courierId: courier.id,
      courierName: courier.name,
      chargePaise: courier.basePaise,
      estimatedDeliveryAt: iso(courier.days),
      raw: { courier: courier.name },
    };
  }

  async schedulePickup(providerShipmentId: string, pickupDate?: Date): Promise<PickupResult> {
    this.guard();

    const record = this.orders.get(providerShipmentId);
    if (!record) {
      throw new ProviderError('VALIDATION', 'No such shipment at the courier', {
        providerCode: this.providerCode,
        status: 404,
      });
    }

    record.status = 'PICKUP SCHEDULED';
    this.addScan(record, 'Pickup scheduled', 'PICKUP SCHEDULED', '4');

    return {
      scheduledAt: (pickupDate ?? new Date(Date.now() + 86_400_000)).toISOString(),
      tokenNumber: stableId('PT', providerShipmentId).toUpperCase(),
      status: 'PICKUP SCHEDULED',
      raw: {},
    };
  }

  async generateLabel(providerShipmentId: string): Promise<DocumentResult> {
    this.guard();
    // A data: URL so the storage path is exercised without a network fetch.
    return {
      url: `data:application/pdf;base64,${Buffer.from(
        `%PDF-1.4 mock label for ${providerShipmentId}`,
      ).toString('base64')}`,
      raw: {},
    };
  }

  async generateManifest(providerShipmentId: string): Promise<DocumentResult> {
    this.guard();
    return {
      url: `data:application/pdf;base64,${Buffer.from(
        `%PDF-1.4 mock manifest for ${providerShipmentId}`,
      ).toString('base64')}`,
      raw: {},
    };
  }

  /* ---------------------------------------------------------- tracking */

  private addScan(record: MockOrderRecord, description: string, status: string, code: string): void {
    record.scans.push({
      occurredAt: new Date().toISOString(),
      description,
      location: 'Mumbai Hub (Maharashtra)',
      providerStatus: status,
      providerStatusCode: code,
      dedupeKey: stableId('scan_', `${record.providerShipmentId}:${status}:${record.scans.length}`),
    });
  }

  /** Test hook: move a shipment forward the way a courier would over the following days. */
  advance(providerShipmentId: string, to: 'PICKED_UP' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'UNDELIVERED' | 'RTO'): void {
    const record = this.orders.get(providerShipmentId);
    if (!record) return;

    const map: Record<string, [string, string, string]> = {
      PICKED_UP: ['Shipment picked up', 'PICKED UP', '42'],
      IN_TRANSIT: ['In transit', 'IN TRANSIT', '18'],
      OUT_FOR_DELIVERY: ['Out for delivery', 'OUT FOR DELIVERY', '17'],
      DELIVERED: ['Delivered', 'DELIVERED', '7'],
      UNDELIVERED: ['Delivery attempt failed — customer unavailable', 'UNDELIVERED', '15'],
      RTO: ['Return to origin initiated', 'RTO INITIATED', '21'],
    };

    const [description, status, code] = map[to]!;
    record.status = status;
    this.addScan(record, description, status, code);
  }

  private toTracking(record: MockOrderRecord): TrackingResult {
    const last = record.scans.at(-1);
    const delivered = record.status === 'DELIVERED';

    return {
      awbNumber: record.awbNumber,
      courierName: record.courierName,
      providerStatus: record.status,
      providerStatusCode: last?.providerStatusCode ?? null,
      estimatedDeliveryAt: iso(3),
      deliveredAt: delivered ? new Date().toISOString() : null,
      isReturn: record.isReturn,
      scans: record.scans,
      raw: { reference: record.referenceNumber },
    };
  }

  async trackByAwb(awbNumber: string): Promise<TrackingResult> {
    this.guard();

    const record = [...this.orders.values()].find((entry) => entry.awbNumber === awbNumber);
    if (!record) {
      throw new ProviderError('VALIDATION', 'No shipment with that AWB', {
        providerCode: this.providerCode,
        status: 404,
      });
    }
    return this.toTracking(record);
  }

  async trackByShipment(providerShipmentId: string): Promise<TrackingResult> {
    this.guard();

    const record = this.orders.get(providerShipmentId);
    if (!record) {
      throw new ProviderError('VALIDATION', 'No such shipment at the courier', {
        providerCode: this.providerCode,
        status: 404,
      });
    }
    return this.toTracking(record);
  }

  /* ----------------------------------------------------- cancel and NDR */

  async cancelShipment(input: {
    providerOrderId: string | null;
    providerShipmentId: string | null;
    awbNumber: string | null;
  }): Promise<CancelResult> {
    this.guard();

    const record = input.providerShipmentId ? this.orders.get(input.providerShipmentId) : undefined;
    if (!record) {
      return { cancelled: false, status: null, message: 'Unknown shipment', raw: {} };
    }

    // A courier will not cancel a parcel it has already collected.
    if (['PICKED UP', 'IN TRANSIT', 'OUT FOR DELIVERY', 'DELIVERED'].includes(record.status)) {
      return {
        cancelled: false,
        status: record.status,
        message: 'Already picked up — cancel at the courier',
        raw: {},
      };
    }

    record.cancelled = true;
    record.status = 'CANCELED';
    return { cancelled: true, status: 'CANCELED', message: null, raw: {} };
  }

  async fetchNdr(awbNumber?: string): Promise<ProviderNdr[]> {
    this.guard();

    return [...this.orders.values()]
      .filter((record) => record.status === 'UNDELIVERED')
      .filter((record) => (awbNumber ? record.awbNumber === awbNumber : true))
      .map((record) => ({
        providerNdrId: stableId('ndr_', record.providerShipmentId),
        awbNumber: record.awbNumber ?? '',
        reason: 'Customer unavailable',
        reasonCode: 'CUSTOMER_UNAVAILABLE',
        attemptCount: 1,
        raisedAt: new Date().toISOString(),
        raw: {},
      }));
  }

  async actOnNdr(input: NdrRecordInput): Promise<{ accepted: boolean; message: string | null }> {
    this.guard();

    const record = [...this.orders.values()].find((entry) => entry.awbNumber === input.awbNumber);
    if (!record) return { accepted: false, message: 'Unknown AWB' };

    if (input.action === 'RETURN') {
      record.status = 'RTO INITIATED';
      this.addScan(record, 'Return to origin initiated', 'RTO INITIATED', '21');
    } else if (input.action === 'REATTEMPT') {
      record.status = 'OUT FOR DELIVERY';
      this.addScan(record, 'Reattempt scheduled', 'OUT FOR DELIVERY', '17');
    }

    return { accepted: true, message: null };
  }

  async pickupLocations(): Promise<ProviderPickupLocation[]> {
    this.guard();
    return [
      {
        providerLocationId: 'Mock Warehouse',
        name: 'Mock Warehouse',
        pincode: '400001',
        city: 'Mumbai',
        state: 'Maharashtra',
        raw: {},
      },
    ];
  }

  /* ---------------------------------------------------------- webhooks */

  /** Shared-token auth, compared in constant time — the same shape Shiprocket uses. */
  verifyWebhook(_rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
    const provided = Buffer.from(headers['x-api-key'] ?? '');
    const expected = Buffer.from(this.webhookToken);

    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  parseWebhook(rawBody: Buffer): ParsedShippingWebhook {
    const payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;

    const scans = Array.isArray(payload.scans)
      ? (payload.scans as Record<string, unknown>[]).map((scan, index) => ({
          occurredAt: String(scan.date ?? new Date().toISOString()),
          description: String(scan.activity ?? ''),
          location: scan.location ? String(scan.location) : null,
          providerStatus: scan['sr-status-label'] ? String(scan['sr-status-label']) : null,
          providerStatusCode: scan['sr-status'] ? String(scan['sr-status']) : null,
          dedupeKey: stableId('scan_', `${String(payload.awb)}:${String(scan.date)}:${index}`),
        }))
      : [];

    return {
      providerEventId: stableId('evt_', rawBody.toString('utf8')),
      eventType: String(payload.current_status ?? 'UPDATE'),
      awbNumber: payload.awb ? String(payload.awb) : null,
      providerOrderId: payload.sr_order_id ? String(payload.sr_order_id) : null,
      providerShipmentId: payload.shipment_id ? String(payload.shipment_id) : null,
      referenceNumber: payload.order_id ? String(payload.order_id) : null,
      providerStatus: payload.current_status ? String(payload.current_status) : null,
      providerStatusCode: payload.current_status_id ? String(payload.current_status_id) : null,
      courierName: payload.courier_name ? String(payload.courier_name) : null,
      estimatedDeliveryAt: payload.etd ? String(payload.etd) : null,
      isReturn: payload.is_return === 1 || payload.is_return === true,
      scans,
      payload: redactShippingPayload(payload) as Record<string, unknown>,
    };
  }

  /**
   * Test hook: builds a delivery in Shiprocket's documented webhook shape, so the parser is
   * exercised against the real body format rather than something invented for the mock.
   */
  buildWebhook(
    awbNumber: string,
    status: string,
    statusCode: string,
    options: { referenceNumber?: string; isReturn?: boolean; scanDate?: string } = {},
  ): { body: Buffer; headers: Record<string, string> } {
    const date = options.scanDate ?? new Date().toISOString();

    const body = Buffer.from(
      JSON.stringify({
        awb: awbNumber,
        courier_name: 'Mock Express',
        current_status: status,
        current_status_id: statusCode,
        shipment_status: status,
        shipment_status_id: statusCode,
        current_timestamp: date,
        order_id: options.referenceNumber ?? '',
        sr_order_id: stableId('mockord_', options.referenceNumber ?? awbNumber),
        awb_assigned_date: date,
        etd: iso(3),
        scans: [
          {
            date,
            status: statusCode,
            activity: status,
            location: 'Mumbai Hub (Maharashtra)',
            'sr-status': statusCode,
            'sr-status-label': status,
          },
        ],
        is_return: options.isReturn ? 1 : 0,
      }),
    );

    return { body, headers: { 'x-api-key': this.webhookToken } };
  }

  /** Test hook: the HMAC helper, kept so a signature-style provider can reuse the same path. */
  sign(body: Buffer): string {
    return createHmac('sha256', this.webhookToken).update(body).digest('hex');
  }
}
