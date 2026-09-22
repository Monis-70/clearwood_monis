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
} from './shipping.driver';
import { ProviderUnsupportedError } from './shipping.driver';

/**
 * "We arranged it ourselves."
 *
 * Furniture is not always couriered — a sofa often goes on our own truck, or with a local
 * transporter booked over the phone. This driver exists so that case is a normal shipment with a
 * normal timeline and a normal POD, rather than an order nobody can fulfil in the system.
 *
 * It integrates with nothing. Every capability that needs a courier API is honestly false, and an
 * admin drives the status by hand.
 */
export class ManualShippingDriver implements ShippingProviderDriverContract {
  readonly name: ShippingProviderDriver = 'manual';
  readonly providerCode: string;

  constructor(providerCode = 'MANUAL') {
    this.providerCode = providerCode;
  }

  capabilities(): ProviderCapabilities {
    return {
      supportsForwardShipment: true,
      supportsReversePickup: true,
      // Everything below needs a courier API, and there isn't one.
      supportsNdr: false,
      supportsExchange: false,
      supportsTracking: false,
      supportsLabel: false,
      supportsManifest: false,
      supportsCod: true,
      supportsCancellation: true,
      supportsServiceability: false,
      supportsPickupLocations: false,
    };
  }

  async health(): Promise<ProviderHealth> {
    return {
      reachable: true,
      authenticated: true,
      message: 'Manual fulfilment needs no connection',
      failureKind: null,
    };
  }

  /** There is no provider, so the shipment's own number is its only identity. */
  async createOrder(input: CreateShipmentOrderInput): Promise<CreatedShipmentOrder> {
    return {
      providerOrderId: input.referenceNumber,
      providerShipmentId: input.referenceNumber,
      status: 'MANUAL',
      raw: { manual: true, reference: input.referenceNumber },
    };
  }

  async createReturn(input: CreateShipmentOrderInput): Promise<CreatedShipmentOrder> {
    return this.createOrder(input);
  }

  async serviceability(_input: ServiceabilityInput): Promise<CourierOptionDto[]> {
    throw new ProviderUnsupportedError(this.providerCode, 'serviceability');
  }

  /** Only an AWB somebody typed in. `assignAwb` without one is meaningless here. */
  async assignAwb(_input: AssignAwbInput): Promise<AssignedAwb> {
    throw new ProviderUnsupportedError(this.providerCode, 'automatic AWB assignment');
  }

  async schedulePickup(_providerShipmentId: string, pickupDate?: Date): Promise<PickupResult> {
    return {
      scheduledAt: (pickupDate ?? new Date()).toISOString(),
      tokenNumber: null,
      status: 'MANUAL',
      raw: { manual: true },
    };
  }

  async generateLabel(_providerShipmentId: string): Promise<DocumentResult> {
    throw new ProviderUnsupportedError(this.providerCode, 'label generation');
  }

  async generateManifest(_providerShipmentId: string): Promise<DocumentResult> {
    throw new ProviderUnsupportedError(this.providerCode, 'manifest generation');
  }

  async trackByAwb(_awbNumber: string): Promise<TrackingResult> {
    throw new ProviderUnsupportedError(this.providerCode, 'tracking');
  }

  async trackByShipment(_providerShipmentId: string): Promise<TrackingResult> {
    throw new ProviderUnsupportedError(this.providerCode, 'tracking');
  }

  async cancelShipment(): Promise<CancelResult> {
    return { cancelled: true, status: 'CANCELLED', message: null, raw: { manual: true } };
  }

  async fetchNdr(): Promise<ProviderNdr[]> {
    return [];
  }

  async actOnNdr(_input: NdrRecordInput): Promise<{ accepted: boolean; message: string | null }> {
    throw new ProviderUnsupportedError(this.providerCode, 'NDR actions');
  }

  async pickupLocations(): Promise<ProviderPickupLocation[]> {
    return [];
  }

  /** Nothing sends us webhooks, so nothing is ever accepted. */
  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(_rawBody: Buffer): ParsedShippingWebhook {
    throw new ProviderUnsupportedError(this.providerCode, 'webhooks');
  }
}
