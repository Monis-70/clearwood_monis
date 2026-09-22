import { createHash } from 'node:crypto';

import type { ProviderFailureKind } from '@shared/enums';
import type { ProviderCapabilities } from '@shared/types/fulfilment';

import { logger } from '../../config/logger';
import {
  ProviderError,
  ProviderUnsupportedError,
  redactedShippingJson,
  shippingDriverFor,
  type ShippingProviderDriverContract,
} from '../../drivers/shipping';
import {
  providerOperationRepository,
  shippingProviderRepository,
  type ProviderWithConfigs,
} from '../../repositories/shipment.repository';
import { AppError } from '../../utils/AppError';

/**
 * The single door between our services and any courier.
 *
 * Three jobs, none of which belongs in a shipment service:
 *
 *  1. **Resolve.** A provider is a database row, not an environment variable, so an admin can add
 *     one, flip it live and switch a shipment to it without a deploy. This resolves the row and
 *     builds the matching driver, with per-provider credentials overriding the environment.
 *
 *  2. **Journal.** Every mutating call is claimed against a `ProviderOperation` first. A duplicate
 *     key means the call has already been attempted — so instead of retrying blindly into a second
 *     shipment at the courier, we refuse and demand reconciliation. A duplicate charge can be
 *     refunded; a duplicate parcel is a wardrobe on a lorry.
 *
 *  3. **Translate.** Provider failures come back as classified `ProviderError`s and leave here as
 *     `AppError`s with a safe message, so a courier's raw complaint never reaches a customer.
 */

interface ResolvedProvider {
  row: ProviderWithConfigs;
  driver: ShippingProviderDriverContract;
}

const driverCache = new Map<string, { driver: ShippingProviderDriverContract; at: number }>();
const CACHE_TTL_MS = 60_000;

/** Non-secret config a provider row may override the environment with. */
function configOverrides(row: ProviderWithConfigs): Record<string, string> {
  return Object.fromEntries(row.configs.map((config) => [config.key, config.value]));
}

export const providerGateway = {
  /** Test seam and admin-edit hook: a credential change must not be served from cache. */
  invalidate(code?: string): void {
    if (code) driverCache.delete(code);
    else driverCache.clear();
  },

  async resolve(code?: string | null): Promise<ResolvedProvider> {
    const row = code
      ? await shippingProviderRepository.findByCode(code)
      : await shippingProviderRepository.findDefault();

    if (!row) {
      throw new AppError(
        422,
        'SHIPPING_PROVIDER_UNKNOWN',
        code ? `Unknown shipping provider ${code}` : 'No default shipping provider is configured',
      );
    }

    if (!row.isActive) {
      throw new AppError(
        422,
        'SHIPPING_PROVIDER_DISABLED',
        `Shipping provider ${row.code} is disabled`,
      );
    }

    const cached = driverCache.get(row.code);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { row, driver: cached.driver };
    }

    const overrides = configOverrides(row);
    const driver = shippingDriverFor(row.driver, row.code);

    // Per-provider credentials win over the environment, which is what lets two Shiprocket
    // accounts (say, one per warehouse) coexist.
    if (row.driver === 'shiprocket' && Object.keys(overrides).length > 0) {
      const { ShiprocketShippingDriver } = await import('../../drivers/shipping');
      const configured = new ShiprocketShippingDriver(undefined, {
        providerCode: row.code,
        ...(overrides.email ? { email: overrides.email } : {}),
        ...(overrides.password ? { password: overrides.password } : {}),
        ...(overrides.webhookToken ? { webhookToken: overrides.webhookToken } : {}),
        ...(overrides.baseUrl ? { baseUrl: overrides.baseUrl } : {}),
      });

      driverCache.set(row.code, { driver: configured, at: Date.now() });
      return { row, driver: configured };
    }

    driverCache.set(row.code, { driver, at: Date.now() });
    return { row, driver };
  },

  async capabilities(code?: string | null): Promise<ProviderCapabilities> {
    const { driver } = await this.resolve(code);
    return driver.capabilities();
  },

  /** Refuses up front rather than letting a driver throw halfway through a shipment. */
  async assertCapability(code: string | null | undefined, capability: keyof ProviderCapabilities) {
    const resolved = await this.resolve(code);

    if (!resolved.driver.capabilities()[capability]) {
      throw new AppError(
        422,
        'SHIPPING_CAPABILITY_UNSUPPORTED',
        `${resolved.row.code} does not support ${String(capability)}`,
        { provider: resolved.row.code, capability },
      );
    }

    return resolved;
  },

  /**
   * Deterministic operation key.
   *
   * The same logical intent must produce the same key on every attempt, which is exactly what makes
   * "already claimed" mean "already attempted" rather than "attempted at a different millisecond".
   */
  operationKey(providerCode: string, operation: string, entityId: string, salt = ''): string {
    return createHash('sha256')
      .update(`${providerCode}:${operation}:${entityId}:${salt}`)
      .digest('hex');
  },

  /**
   * Runs a mutating provider call inside the operation journal.
   *
   * `onDuplicate` decides what happens when the key was already claimed. Callers that can safely
   * reconcile (fetch the existing shipment from the courier) pass a resolver; callers that cannot
   * get a 409 telling an admin to reconcile by hand.
   */
  async run<T>(
    context: {
      providerCode: string;
      providerId: string | null;
      operation: string;
      entityType: string;
      entityId: string;
      salt?: string;
    },
    call: (driver: ShippingProviderDriverContract) => Promise<T>,
    options: { onDuplicate?: 'fail' | 'proceed' } = {},
  ): Promise<T> {
    const { driver } = await this.resolve(context.providerCode);

    const idempotencyKey = this.operationKey(
      context.providerCode,
      context.operation,
      context.entityId,
      context.salt ?? '',
    );

    const claimed = await providerOperationRepository.claim({
      providerId: context.providerId,
      providerCode: context.providerCode,
      operation: context.operation,
      entityType: context.entityType,
      entityId: context.entityId,
      idempotencyKey,
    });

    if (!claimed) {
      const existing = await providerOperationRepository.findByKey(idempotencyKey);

      // A previous attempt that FAILED cleanly is safe to repeat — the courier did nothing.
      const safeToRepeat = existing?.status === 'FAILED' && existing.failureKind === 'VALIDATION';

      if (options.onDuplicate !== 'proceed' && !safeToRepeat) {
        throw new AppError(
          409,
          'PROVIDER_OPERATION_DUPLICATE',
          `${context.operation} was already attempted for this ${context.entityType} and must be reconciled, not repeated`,
          { operation: context.operation, status: existing?.status ?? 'UNKNOWN' },
        );
      }
    }

    try {
      const result = await call(driver);

      if (claimed) {
        await providerOperationRepository.finish(claimed.id, 'SUCCESS', {
          responseJson: redactedShippingJson(result).slice(0, 8_000),
        });
      }

      if (context.providerId) {
        await shippingProviderRepository.recordHealth(context.providerId, true, null);
      }

      return result;
    } catch (error) {
      const failure =
        error instanceof ProviderError
          ? error
          : new ProviderError('TRANSPORT', 'The courier could not be reached', {
              providerCode: context.providerCode,
            });

      if (claimed) {
        await providerOperationRepository.finish(claimed.id, 'FAILED', {
          failureKind: failure.kind,
          errorMessage: failure.message.slice(0, 500),
        });
      }

      if (context.providerId) {
        await shippingProviderRepository.recordHealth(
          context.providerId,
          false,
          failure.message.slice(0, 500),
        );
      }

      // The provider's own words stay in the log; the caller gets something safe.
      logger.error(
        {
          provider: context.providerCode,
          operation: context.operation,
          entityId: context.entityId,
          kind: failure.kind,
          status: failure.status,
        },
        'shipping provider call failed',
      );

      throw toAppError(failure, context.operation);
    }
  },

  async health(code: string) {
    const { row, driver } = await this.resolve(code);
    const health = await driver.health();

    await shippingProviderRepository.recordHealth(
      row.id,
      health.reachable && health.authenticated,
      health.reachable && health.authenticated ? null : health.message,
    );

    return { provider: row.code, ...health };
  },
};

/** Provider failures become safe, actionable API errors. */
export function toAppError(failure: ProviderError, operation: string): AppError {
  if (failure instanceof ProviderUnsupportedError) {
    return new AppError(422, 'SHIPPING_CAPABILITY_UNSUPPORTED', failure.message);
  }

  const byKind: Record<ProviderFailureKind, { status: number; code: string; message: string }> = {
    AUTHENTICATION: {
      status: 502,
      code: 'SHIPPING_PROVIDER_AUTH_FAILED',
      message: 'The courier rejected our credentials. Check the provider settings.',
    },
    VALIDATION: {
      status: 422,
      code: 'SHIPPING_PROVIDER_REJECTED',
      // The courier's validation message is genuinely useful here — and it is about OUR request,
      // not about another customer, so it is safe to surface.
      message: failure.message,
    },
    RATE_LIMIT: {
      status: 503,
      code: 'SHIPPING_PROVIDER_RATE_LIMITED',
      message: 'The courier is rate limiting us. Try again shortly.',
    },
    TIMEOUT: {
      status: 504,
      code: 'SHIPPING_PROVIDER_TIMEOUT',
      message: `The courier did not respond to ${operation}. It may still have succeeded — reconcile before retrying.`,
    },
    TRANSPORT: {
      status: 502,
      code: 'SHIPPING_PROVIDER_UNREACHABLE',
      message: 'The courier could not be reached.',
    },
    PROVIDER_CLIENT: {
      status: 502,
      code: 'SHIPPING_PROVIDER_ERROR',
      message: `The courier could not complete ${operation}.`,
    },
    PROVIDER_SERVER: {
      status: 502,
      code: 'SHIPPING_PROVIDER_ERROR',
      message: `The courier is unavailable. ${operation} was not completed.`,
    },
    UNSUPPORTED: {
      status: 422,
      code: 'SHIPPING_CAPABILITY_UNSUPPORTED',
      message: failure.message,
    },
  };

  const mapped = byKind[failure.kind];
  return new AppError(mapped.status, mapped.code, mapped.message, {
    provider: failure.providerCode,
  });
}
