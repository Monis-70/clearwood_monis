/*
 * =============================================================================
 *  UNVERIFIED INTEGRATION — NOT VALIDATED AGAINST A LIVE SHIPROCKET ACCOUNT
 * =============================================================================
 *
 *  NO LIVE SHIPROCKET ACCOUNT EXISTS FOR THIS PROJECT.
 *  NO LIVE CALL HAS EVER BEEN MADE BY THIS CODE — NOT ONCE, NOT IN ANY ENVIRONMENT.
 *
 *  Everything here was written from Shiprocket's published documentation. That means the
 *  authentication scheme, the webhook body shape and the `x-api-key` header convention are
 *  documented facts, but THE ENDPOINT PATHS IN `PATHS` BELOW ARE CONVENTION AND ARE UNVERIFIED.
 *  So are the response field names each method reads. A path that 404s or a renamed field will
 *  fail at runtime, and no test in this repository can catch that, because every test runs against
 *  the mock.
 *
 *  WHY THIS FILE IS NAMED `.UNVERIFIED.ts`:
 *  Unverified integration code is more dangerous than absent integration code. It looks finished,
 *  so nobody re-checks it before go-live. The filename exists to make that impossible to forget.
 *
 *  BEFORE THIS MAY BE USED IN PRODUCTION:
 *    1. Create a Shiprocket API user (Settings -> API -> Add New API User).
 *    2. Validate EVERY path in `PATHS` against the sandbox, correcting them in that one map.
 *    3. Confirm the response field names each parser reads.
 *    4. Run one real end-to-end shipment: create -> AWB -> pickup -> track -> cancel.
 *    5. Confirm a real webhook is received, verified and applied.
 *    6. Only then set SHIPPING_PROVIDER_VERIFIED=true, which is what production startup demands.
 *
 *  The verified fulfilment paths are `manual` and `mock`. Those are the ones with test coverage.
 * =============================================================================
 */

import { timingSafeEqual } from 'node:crypto';

import type { ShippingProviderDriver } from '@shared/enums';
import type { CourierOptionDto, ProviderCapabilities } from '@shared/types/fulfilment';

import { env } from '../../config/env';
import { logger } from '../../config/logger';

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
  ProviderAddress,
  ProviderHealth,
  ProviderNdr,
  ProviderPickupLocation,
  ServiceabilityInput,
  ShippingProviderDriverContract,
  TrackingResult,
  TrackingScan,
} from './shipping.driver';
import {
  ProviderError,
  gramsToKg,
  mmToCm,
  paiseToRupees,
  redactShippingPayload,
  rupeesToPaise,
} from './shipping.driver';

/**
 * Shiprocket.
 *
 * See the quarantine banner at the top of this file: this class has never spoken to Shiprocket.
 *
 * WHAT IS DOCUMENTED (and therefore trustworthy): REST/JSON; authentication is a bearer token from
 * the Authentication API using an API user created under Settings -> API -> Add New API User; the
 * status codes are 200/202, 400, 401 (expired or bad token), 404, 405, 422, 429 (rate limit) and
 * 5xx; the webhook is a POST of `application/json` whose security token arrives in the `x-api-key`
 * header, whose receiving URL must not contain "shiprocket"/"kartrocket"/"sr"/"kr", and which must
 * be answered with 200 and nothing else. The webhook body carries `awb`, `courier_name`,
 * `current_status`, `current_status_id`, `order_id`, `sr_order_id`, `etd`, `is_return`, `pod`,
 * `qc_*` and a `scans[]` array of `{date, status, activity, location, sr-status, sr-status-label}`.
 *
 * Also documented, and the single easiest way to corrupt an integration: on the create-order
 * request `order_id` is **your** reference number, but on the response `order_id` is
 * **Shiprocket's** id — and every later call wants Shiprocket's. This driver keeps them in two
 * separate fields and never conflates them.
 *
 * WHAT IS NOT VERIFIED: the endpoint paths, and the response field names each method reads.
 *
 * Operationally it caches its bearer token, refreshes it once on a 401 and retries the original
 * call, converts rupees to paise at the boundary, classifies every failure, and retries only what
 * is transient.
 */

export type ShippingHttpResponse = { status: number; body: unknown };

export interface ShippingHttpClient {
  request(init: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
  }): Promise<ShippingHttpResponse>;
}

export const fetchShippingHttpClient: ShippingHttpClient = {
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
      return { status: response.status, body: text ? safeJson(text) : null };
    } finally {
      clearTimeout(timer);
    }
  },
};

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

/**
 * Every Shiprocket path, in one place.
 *
 * UNVERIFIED. These follow the documented `/v1/external/...` convention but were never confirmed
 * against a live account. If an endpoint 404s, correct it here — nothing else in the codebase
 * hardcodes a path.
 */
export const PATHS = {
  login: '/auth/login',
  createOrder: '/orders/create/adhoc',
  createReturn: '/orders/create/return',
  serviceability: '/courier/serviceability/',
  assignAwb: '/courier/assign/awb',
  generatePickup: '/courier/generate/pickup',
  generateLabel: '/courier/generate/label',
  generateManifest: '/manifests/generate',
  trackByAwb: '/courier/track/awb',
  trackByShipment: '/courier/track/shipment',
  cancelOrder: '/orders/cancel',
  cancelShipment: '/orders/cancel/shipment/awbs',
  ndrList: '/ndr',
  ndrAction: '/ndr',
  pickupLocations: '/settings/company/pickup',
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 0 && text !== 'null' ? text : null;
}

function num(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
}

export class ShiprocketShippingDriver implements ShippingProviderDriverContract {
  readonly name: ShippingProviderDriver = 'shiprocket';
  readonly providerCode: string;

  private readonly email: string;
  private readonly password: string;
  private readonly webhookToken: string;
  private readonly baseUrl: string;

  private token: string | null = null;
  private tokenExpiresAt = 0;
  /** Concurrent callers share one login instead of stampeding the auth endpoint. */
  private pendingLogin: Promise<string> | null = null;

  constructor(
    private readonly http: ShippingHttpClient = fetchShippingHttpClient,
    options: {
      email?: string;
      password?: string;
      webhookToken?: string;
      baseUrl?: string;
      providerCode?: string;
    } = {},
  ) {
    // env refuses to boot with Shiprocket enabled and any of these missing.
    this.email = options.email ?? env.SHIPROCKET_EMAIL ?? '';
    this.password = options.password ?? env.SHIPROCKET_PASSWORD ?? '';
    this.webhookToken = options.webhookToken ?? env.SHIPROCKET_WEBHOOK_TOKEN ?? '';
    this.baseUrl = (options.baseUrl ?? env.SHIPROCKET_BASE_URL).replace(/\/+$/, '');
    this.providerCode = options.providerCode ?? 'SHIPROCKET';
  }

  capabilities(): ProviderCapabilities {
    return {
      supportsForwardShipment: true,
      supportsReversePickup: true,
      supportsNdr: true,
      supportsExchange: true,
      supportsTracking: true,
      supportsLabel: true,
      supportsManifest: true,
      supportsCod: true,
      supportsCancellation: true,
      supportsServiceability: true,
      supportsPickupLocations: true,
    };
  }

  /* ---------------------------------------------------------------- auth */

  private async authenticate(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (this.pendingLogin) return this.pendingLogin;

    this.pendingLogin = (async () => {
      const response = await this.http.request({
        method: 'POST',
        url: `${this.baseUrl}${PATHS.login}`,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: this.email, password: this.password }),
        timeoutMs: env.SHIPROCKET_TIMEOUT_MS,
      });

      if (response.status < 200 || response.status >= 300) {
        throw this.toProviderError(response, 'authentication');
      }

      const token = str(asRecord(response.body).token);
      if (!token) {
        throw new ProviderError('AUTHENTICATION', 'Shiprocket returned no token', {
          providerCode: this.providerCode,
          status: response.status,
        });
      }

      this.token = token;
      // Shiprocket tokens are documented as long-lived; refresh well inside that.
      this.tokenExpiresAt = Date.now() + 9 * 24 * 60 * 60 * 1000;
      return token;
    })();

    try {
      return await this.pendingLogin;
    } finally {
      this.pendingLogin = null;
    }
  }

  /** Test seam: lets a test assert the cache was invalidated. */
  clearToken(): void {
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  /* ---------------------------------------------------------------- http */

  private toProviderError(response: ShippingHttpResponse, operation: string): ProviderError {
    const body = asRecord(response.body);
    const message =
      str(body.message) ?? str(body.error) ?? `Shiprocket ${operation} failed (${response.status})`;

    const kind = (() => {
      switch (response.status) {
        case 401:
        case 403:
          return 'AUTHENTICATION' as const;
        case 400:
        case 404:
        case 405:
        case 422:
          return 'VALIDATION' as const;
        case 429:
          return 'RATE_LIMIT' as const;
        default:
          if (response.status >= 500) return 'PROVIDER_SERVER' as const;
          return 'PROVIDER_CLIENT' as const;
      }
    })();

    return new ProviderError(kind, message, {
      providerCode: this.providerCode,
      status: response.status,
      details: redactShippingPayload(body) as Record<string, unknown>,
    });
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = env.SHIPPING_RETRY_BACKOFF_MS * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private async call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined>; operation: string },
  ): Promise<Record<string, unknown>> {
    const query = options.query
      ? `?${new URLSearchParams(
          Object.entries(options.query)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]): [string, string] => [key, String(value)]),
        ).toString()}`
      : '';

    const url = `${this.baseUrl}${path}${query}`;
    let refreshed = false;
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt <= env.SHIPPING_MAX_RETRIES; attempt += 1) {
      try {
        const token = await this.authenticate();

        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        };
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';

        const response = await this.http.request({
          method,
          url,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          timeoutMs: env.SHIPROCKET_TIMEOUT_MS,
        });

        if (response.status >= 200 && response.status < 300) return asRecord(response.body);

        const error = this.toProviderError(response, options.operation);

        // A 401 usually means the token aged out. Refresh ONCE and replay; a second 401 is real.
        if (error.kind === 'AUTHENTICATION' && !refreshed) {
          refreshed = true;
          this.clearToken();
          await this.authenticate(true);
          continue;
        }

        if (!error.retryable) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof ProviderError) {
          if (!error.retryable) throw error;
          lastError = error;
        } else {
          // AbortController aborts and DNS/socket failures land here.
          const aborted = (error as { name?: string }).name === 'AbortError';
          lastError = new ProviderError(
            aborted ? 'TIMEOUT' : 'TRANSPORT',
            aborted ? 'Shiprocket did not respond in time' : 'Could not reach Shiprocket',
            { providerCode: this.providerCode },
          );
        }
      }

      if (attempt < env.SHIPPING_MAX_RETRIES) await this.backoff(attempt);
    }

    logger.error(
      { path, method, operation: options.operation, attempts: env.SHIPPING_MAX_RETRIES + 1 },
      'shiprocket call failed after retries',
    );

    throw (
      lastError ??
      new ProviderError('TRANSPORT', `Shiprocket ${options.operation} failed`, {
        providerCode: this.providerCode,
      })
    );
  }

  async health(): Promise<ProviderHealth> {
    try {
      await this.authenticate(true);
      return { reachable: true, authenticated: true, message: 'Authenticated', failureKind: null };
    } catch (error) {
      const failure =
        error instanceof ProviderError
          ? error
          : new ProviderError('TRANSPORT', 'Could not reach Shiprocket', {
              providerCode: this.providerCode,
            });

      return {
        reachable: failure.kind !== 'TRANSPORT' && failure.kind !== 'TIMEOUT',
        authenticated: false,
        message: failure.message,
        failureKind: failure.kind,
      };
    }
  }

  /* -------------------------------------------------------------- orders */

  private addressFields(prefix: 'billing' | 'shipping', address: ProviderAddress): Record<string, unknown> {
    const [first, ...rest] = address.name.trim().split(/\s+/);

    return {
      [`${prefix}_customer_name`]: first ?? address.name,
      [`${prefix}_last_name`]: rest.join(' '),
      [`${prefix}_address`]: address.line1,
      [`${prefix}_address_2`]: address.line2 ?? '',
      [`${prefix}_city`]: address.city,
      [`${prefix}_pincode`]: address.pincode,
      [`${prefix}_state`]: address.state,
      [`${prefix}_country`]: address.country,
      [`${prefix}_email`]: address.email ?? '',
      [`${prefix}_phone`]: address.phone,
    };
  }

  private orderPayload(input: CreateShipmentOrderInput): Record<string, unknown> {
    const shipping = input.shipping;

    return {
      // Documented trap: on the REQUEST this is OUR reference, not Shiprocket's id.
      order_id: input.referenceNumber,
      order_date: input.orderedAt.toISOString().slice(0, 19).replace('T', ' '),
      pickup_location: input.pickupLocationName ?? 'Primary',
      ...this.addressFields('billing', input.billing),
      shipping_is_billing: shipping === null,
      ...(shipping ? this.addressFields('shipping', shipping) : {}),
      order_items: input.lines.map((line) => ({
        name: line.name,
        sku: line.sku,
        units: line.qty,
        selling_price: paiseToRupees(line.unitPricePaise),
        discount: paiseToRupees(line.discountPaise ?? 0),
        tax: line.taxRateBp ? line.taxRateBp / 100 : 0,
        hsn: line.hsnCode ?? '',
      })),
      payment_method: input.isCod ? 'COD' : 'Prepaid',
      sub_total: paiseToRupees(input.subTotalPaise),
      length: mmToCm(input.parcel.lengthMm),
      breadth: mmToCm(input.parcel.widthMm),
      height: mmToCm(input.parcel.heightMm),
      weight: gramsToKg(input.parcel.weightGrams),
    };
  }

  async createOrder(input: CreateShipmentOrderInput): Promise<CreatedShipmentOrder> {
    const body = await this.call('POST', PATHS.createOrder, {
      body: this.orderPayload(input),
      operation: 'create order',
    });

    return {
      // On the RESPONSE, `order_id` is Shiprocket's id. Everything downstream uses this one.
      providerOrderId: str(body.order_id) ?? input.referenceNumber,
      providerShipmentId: str(body.shipment_id),
      status: str(body.status),
      raw: redactShippingPayload(body) as Record<string, unknown>,
    };
  }

  async createReturn(input: CreateShipmentOrderInput): Promise<CreatedShipmentOrder> {
    const body = await this.call('POST', PATHS.createReturn, {
      body: { ...this.orderPayload(input), order_id: input.referenceNumber },
      operation: 'create return order',
    });

    return {
      providerOrderId: str(body.order_id) ?? input.referenceNumber,
      providerShipmentId: str(body.shipment_id),
      status: str(body.status),
      raw: redactShippingPayload(body) as Record<string, unknown>,
    };
  }

  /* ------------------------------------------------------ serviceability */

  async serviceability(input: ServiceabilityInput): Promise<CourierOptionDto[]> {
    const body = await this.call('GET', PATHS.serviceability, {
      query: {
        pickup_postcode: input.pickupPincode,
        delivery_postcode: input.deliveryPincode,
        weight: gramsToKg(input.weightGrams),
        cod: input.isCod ? 1 : 0,
        declared_value: paiseToRupees(input.declaredValuePaise),
        ...(input.isReturn ? { is_return: 1 } : {}),
      },
      operation: 'serviceability',
    });

    const data = asRecord(body.data);
    const companies = Array.isArray(data.available_courier_companies)
      ? (data.available_courier_companies as Record<string, unknown>[])
      : [];

    const recommendedId = str(data.recommended_courier_company_id);

    return companies.map((courier) => {
      const courierId = str(courier.courier_company_id) ?? '';

      return {
        courierId,
        courierName: str(courier.courier_name) ?? 'Unknown courier',
        service: str(courier.courier_type),
        estimatedDeliveryDays: Math.max(Math.round(num(courier.estimated_delivery_days)), 0),
        estimatedDeliveryDate: str(courier.etd),
        estimatedPickupDate: str(courier.pickup_availability),
        // Providers quote rupees; paise from here on.
        chargePaise: rupeesToPaise(num(courier.rate)),
        codAvailable: num(courier.cod) === 1,
        codChargePaise: rupeesToPaise(num(courier.cod_charges)),
        reversePickupAvailable: num(courier.pickup_performance) > 0 || input.isReturn === true,
        rating: num(courier.rating) || null,
        providerRawReference: courierId,
        providerCode: this.providerCode,
        isRecommended: recommendedId !== null && courierId === recommendedId,
        recommendationReason: null,
      } satisfies CourierOptionDto;
    });
  }

  /* ----------------------------------------------------------------- AWB */

  async assignAwb(input: AssignAwbInput): Promise<AssignedAwb> {
    const body = await this.call('POST', PATHS.assignAwb, {
      body: {
        shipment_id: input.providerShipmentId,
        ...(input.courierId ? { courier_id: input.courierId } : {}),
        ...(input.isReturn ? { is_return: 1 } : {}),
      },
      operation: 'AWB assignment',
    });

    const data = asRecord(asRecord(body.response).data);
    const awb = str(data.awb_code);

    if (!awb) {
      throw new ProviderError('PROVIDER_CLIENT', 'Shiprocket assigned no AWB', {
        providerCode: this.providerCode,
        details: redactShippingPayload(body) as Record<string, unknown>,
      });
    }

    return {
      awbNumber: awb,
      courierId: str(data.courier_company_id),
      courierName: str(data.courier_name),
      chargePaise: rupeesToPaise(num(data.freight_charges)),
      estimatedDeliveryAt: str(data.etd),
      raw: redactShippingPayload(body) as Record<string, unknown>,
    };
  }

  async schedulePickup(providerShipmentId: string, pickupDate?: Date): Promise<PickupResult> {
    const body = await this.call('POST', PATHS.generatePickup, {
      body: {
        shipment_id: [providerShipmentId],
        ...(pickupDate ? { pickup_date: [pickupDate.toISOString().slice(0, 10)] } : {}),
      },
      operation: 'pickup scheduling',
    });

    const response = asRecord(body.response);

    return {
      scheduledAt: str(response.pickup_scheduled_date),
      tokenNumber: str(response.pickup_token_number),
      status: str(body.pickup_status) ?? str(response.status),
      raw: redactShippingPayload(body) as Record<string, unknown>,
    };
  }

  async generateLabel(providerShipmentId: string): Promise<DocumentResult> {
    const body = await this.call('POST', PATHS.generateLabel, {
      body: { shipment_id: [providerShipmentId] },
      operation: 'label generation',
    });

    return {
      url: str(body.label_url),
      raw: redactShippingPayload(body) as Record<string, unknown>,
    };
  }

  async generateManifest(providerShipmentId: string): Promise<DocumentResult> {
    const body = await this.call('POST', PATHS.generateManifest, {
      body: { shipment_id: [providerShipmentId] },
      operation: 'manifest generation',
    });

    return {
      url: str(body.manifest_url),
      raw: redactShippingPayload(body) as Record<string, unknown>,
    };
  }

  /* ------------------------------------------------------------ tracking */

  private toTracking(body: Record<string, unknown>): TrackingResult {
    // Shiprocket returns tracking either bare or wrapped in `tracking_data`.
    const tracking = asRecord(body.tracking_data ?? body);
    const shipmentTrack = Array.isArray(tracking.shipment_track)
      ? (tracking.shipment_track as Record<string, unknown>[])
      : [];
    const head = asRecord(shipmentTrack[0]);

    const activities = Array.isArray(tracking.shipment_track_activities)
      ? (tracking.shipment_track_activities as Record<string, unknown>[])
      : [];

    const awb = str(head.awb_code) ?? str(tracking.awb);

    const scans: TrackingScan[] = activities.map((activity, index) => {
      const date = str(activity.date) ?? new Date().toISOString();
      const code = str(activity['sr-status']) ?? str(activity.status);

      return {
        occurredAt: date,
        description: str(activity.activity) ?? '',
        location: str(activity.location),
        providerStatus: str(activity['sr-status-label']) ?? str(activity.status),
        providerStatusCode: code,
        // Provider scans carry no id, so identity is content + position.
        dedupeKey: `${awb ?? 'unknown'}:${date}:${code ?? ''}:${index}`,
      };
    });

    return {
      awbNumber: awb,
      courierName: str(head.courier_name),
      providerStatus: str(head.current_status) ?? str(tracking.current_status),
      providerStatusCode: str(head.current_status_id) ?? str(tracking.shipment_status),
      estimatedDeliveryAt: str(head.edd) ?? str(tracking.etd),
      deliveredAt: str(head.delivered_date),
      isReturn: num(tracking.is_return) === 1,
      scans,
      raw: redactShippingPayload(body) as Record<string, unknown>,
    };
  }

  async trackByAwb(awbNumber: string): Promise<TrackingResult> {
    const body = await this.call('GET', `${PATHS.trackByAwb}/${encodeURIComponent(awbNumber)}`, {
      operation: 'tracking by AWB',
    });
    return this.toTracking(body);
  }

  async trackByShipment(providerShipmentId: string): Promise<TrackingResult> {
    const body = await this.call(
      'GET',
      `${PATHS.trackByShipment}/${encodeURIComponent(providerShipmentId)}`,
      { operation: 'tracking by shipment' },
    );
    return this.toTracking(body);
  }

  /* -------------------------------------------------- cancel, NDR, misc */

  async cancelShipment(input: {
    providerOrderId: string | null;
    providerShipmentId: string | null;
    awbNumber: string | null;
  }): Promise<CancelResult> {
    // Before an AWB exists the ORDER is cancelled; afterwards the AWB is.
    const useAwb = input.awbNumber !== null;

    const body = await this.call('POST', useAwb ? PATHS.cancelShipment : PATHS.cancelOrder, {
      body: useAwb ? { awbs: [input.awbNumber] } : { ids: [input.providerOrderId] },
      operation: 'cancellation',
    });

    const message = str(body.message);

    return {
      cancelled: num(body.status_code) === 200 || str(body.status) === 'success' || message !== null,
      status: str(body.status),
      message,
      raw: redactShippingPayload(body) as Record<string, unknown>,
    };
  }

  async fetchNdr(awbNumber?: string): Promise<ProviderNdr[]> {
    const body = await this.call('GET', PATHS.ndrList, {
      ...(awbNumber ? { query: { awb: awbNumber } } : {}),
      operation: 'NDR list',
    });

    const rows = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];

    return rows.map((row) => ({
      providerNdrId: str(row.id) ?? str(row.ndr_id) ?? str(row.awb) ?? '',
      awbNumber: str(row.awb) ?? '',
      reason: str(row.ndr_reason) ?? str(row.reason) ?? 'Undelivered',
      reasonCode: str(row.ndr_reason_code),
      attemptCount: Math.max(Math.round(num(row.attempts)), 1),
      raisedAt: str(row.ndr_date) ?? new Date().toISOString(),
      raw: redactShippingPayload(row) as Record<string, unknown>,
    }));
  }

  async actOnNdr(input: NdrRecordInput): Promise<{ accepted: boolean; message: string | null }> {
    const action = input.action === 'RETURN' ? 'return' : 'reattempt';

    const body = await this.call('POST', `${PATHS.ndrAction}/${encodeURIComponent(input.awbNumber)}/action`, {
      body: {
        action,
        comment: input.note ?? '',
        ...(input.reattemptDate
          ? { deferred_date: input.reattemptDate.toISOString().slice(0, 10) }
          : {}),
      },
      operation: 'NDR action',
    });

    return {
      accepted: num(body.status_code) === 200 || str(body.status) === 'success',
      message: str(body.message),
    };
  }

  async pickupLocations(): Promise<ProviderPickupLocation[]> {
    const body = await this.call('GET', PATHS.pickupLocations, { operation: 'pickup locations' });

    const data = asRecord(body.data);
    const rows = Array.isArray(data.shipping_address)
      ? (data.shipping_address as Record<string, unknown>[])
      : [];

    return rows.map((row) => ({
      providerLocationId: str(row.id) ?? str(row.pickup_location) ?? '',
      name: str(row.pickup_location) ?? '',
      pincode: str(row.pin_code) ?? '',
      city: str(row.city),
      state: str(row.state),
      raw: redactShippingPayload(row) as Record<string, unknown>,
    }));
  }

  /* ------------------------------------------------------------ webhooks */

  /**
   * Shiprocket authenticates webhooks with the shared token it echoes in `x-api-key` — there is no
   * body signature, so this is a constant-time comparison of the token and nothing more.
   */
  verifyWebhook(_rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
    if (!this.webhookToken) return false;

    const provided = Buffer.from(headers['x-api-key'] ?? '');
    const expected = Buffer.from(this.webhookToken);

    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  parseWebhook(rawBody: Buffer): ParsedShippingWebhook {
    const payload = asRecord(safeJson(rawBody.toString('utf8')));

    const awb = str(payload.awb);
    const activities = Array.isArray(payload.scans)
      ? (payload.scans as Record<string, unknown>[])
      : [];

    const scans: TrackingScan[] = activities.map((activity, index) => {
      const date = str(activity.date) ?? new Date().toISOString();
      const code = str(activity['sr-status']) ?? str(activity.status);

      return {
        occurredAt: date,
        description: str(activity.activity) ?? '',
        location: str(activity.location),
        providerStatus: str(activity['sr-status-label']) ?? str(activity.status),
        providerStatusCode: code,
        dedupeKey: `${awb ?? 'unknown'}:${date}:${code ?? ''}:${index}`,
      };
    });

    const timestamp = str(payload.current_timestamp) ?? '';
    const statusCode = str(payload.current_status_id) ?? str(payload.shipment_status_id);

    return {
      // Shiprocket sends no event id, so identity is AWB + status + timestamp. That is what makes a
      // redelivery of the same scan a detectable duplicate rather than a second timeline entry.
      providerEventId: `${awb ?? 'unknown'}:${statusCode ?? ''}:${timestamp}`,
      eventType: str(payload.current_status) ?? 'UPDATE',
      awbNumber: awb,
      // `order_id` here is OUR reference; `sr_order_id` is Shiprocket's.
      providerOrderId: str(payload.sr_order_id),
      providerShipmentId: str(payload.shipment_id),
      referenceNumber: str(payload.order_id),
      providerStatus: str(payload.current_status) ?? str(payload.shipment_status),
      providerStatusCode: statusCode,
      courierName: str(payload.courier_name),
      estimatedDeliveryAt: str(payload.etd),
      isReturn: num(payload.is_return) === 1,
      scans,
      payload: redactShippingPayload(payload) as Record<string, unknown>,
    };
  }
}
