import { resolveShippingDriver, type Env } from '../../config/env';
import { logger } from '../../config/logger';

import { ManualShippingDriver } from './manual.shipping.driver';
import { MockShippingDriver } from './mock.shipping.driver';
import type { ShippingProviderDriverContract } from './shipping.driver';
import { ShiprocketShippingDriver } from './shiprocket.shipping.driver.UNVERIFIED';

export type {
  ShippingProviderDriverContract,
  ProviderAddress,
  ProviderParcel,
  ProviderOrderLine,
  CreateShipmentOrderInput,
  CreatedShipmentOrder,
  ServiceabilityInput,
  AssignAwbInput,
  AssignedAwb,
  PickupResult,
  DocumentResult,
  TrackingScan,
  TrackingResult,
  CancelResult,
  NdrRecordInput,
  ProviderNdr,
  ProviderPickupLocation,
  ParsedShippingWebhook,
  ProviderHealth,
} from './shipping.driver';

export {
  ProviderError,
  ProviderUnsupportedError,
  redactShippingPayload,
  redactedShippingJson,
  rupeesToPaise,
  paiseToRupees,
  gramsToKg,
  mmToCm,
} from './shipping.driver';

export { ManualShippingDriver } from './manual.shipping.driver';
export { MockShippingDriver, MOCK_SHIPPING_TOKEN } from './mock.shipping.driver';
export type { MockShippingScenario } from './mock.shipping.driver';

/** UNVERIFIED — never validated against a live Shiprocket account. See the file's header. */
export {
  ShiprocketShippingDriver,
  fetchShippingHttpClient,
  PATHS as SHIPROCKET_PATHS,
} from './shiprocket.shipping.driver.UNVERIFIED';
export type { ShippingHttpClient } from './shiprocket.shipping.driver.UNVERIFIED';

/**
 * The configured default provider.
 *
 * This is only the fallback used when a shipment does not name one — providers are rows in the
 * database, so an admin can run Shiprocket for couriered parcels and manual dispatch for a
 * wardrobe on the same day without an environment change.
 *
 * Shiprocket is ON HOLD: a selection that is not enabled, not verified (production) or not
 * configured falls back to manual with a warning rather than stopping the process.
 */
export function createShipping(env: Env): ShippingProviderDriverContract {
  const { driver, heldBack } = resolveShippingDriver(env);

  if (heldBack) {
    logger.warn(
      { requested: env.SHIPPING_DRIVER, using: driver, reason: heldBack },
      'SHIPPING_DRIVER=shiprocket is held back — falling back to manual, admin-driven fulfilment',
    );
  }

  switch (driver) {
    case 'shiprocket':
      // Loud on purpose. This integration has never spoken to Shiprocket.
      logger.warn(
        { driver: 'shiprocket', base: env.SHIPROCKET_BASE_URL, verified: env.SHIPPING_PROVIDER_VERIFIED },
        'UNVERIFIED SHIPPING PROVIDER SELECTED — the Shiprocket endpoint paths have never been validated against a live account. Validate them before taking real orders.',
      );
      return new ShiprocketShippingDriver();
    case 'mock':
      logger.debug({ driver: 'mock' }, 'shipping driver ready — no parcel will move');
      return new MockShippingDriver();
    case 'manual':
    default:
      logger.debug({ driver: 'manual' }, 'shipping driver ready — admin-driven fulfilment');
      return new ManualShippingDriver();
  }
}

/** Resolves the driver for a provider row, so per-provider dispatch has one implementation. */
export function shippingDriverFor(
  driver: string,
  providerCode: string,
): ShippingProviderDriverContract {
  switch (driver) {
    case 'shiprocket':
      return new ShiprocketShippingDriver(undefined, { providerCode });
    case 'mock':
      return new MockShippingDriver(providerCode);
    case 'manual':
    default:
      return new ManualShippingDriver(providerCode);
  }
}