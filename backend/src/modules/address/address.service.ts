import { findIndianState } from '@shared/constants';
import type { AddressCreateInput, AddressUpdateInput } from '@shared/schemas/cart';
import type { AddressDto, PincodeLookupDto } from '@shared/types/cart';
import type { AddressType, AddressUsage } from '@shared/enums';

import { env } from '../../config/env';
import { cache } from '../../container';
import { addressRepository } from '../../repositories/cart.repository';
import { AppError } from '../../utils/AppError';
import { CART_CACHE_PREFIXES } from '../catalog-admin/catalogCache.service';
import { shippingService } from '../pricing/shipping.service';

/**
 * The address book.
 *
 * Ownership is enforced on every read and write by scoping to `req.auth.principalId` — an id from
 * the client is never trusted on its own, and a miss answers 404 rather than 403 so ids cannot be
 * enumerated.
 *
 * Deletes are soft. Prompt 9 will snapshot the address onto an order, but the row itself has to
 * survive so a customer can still see where an old order went.
 */

function toDto(
  address: Awaited<ReturnType<typeof addressRepository.findOwned>> & object,
  serviceability: PincodeLookupDto | null = null,
): AddressDto {
  return {
    id: address.id,
    label: address.label,
    type: address.type as AddressType,
    usage: address.usage as AddressUsage,
    fullName: address.fullName,
    phone: address.phone,
    altPhone: address.altPhone,
    line1: address.line1,
    line2: address.line2,
    landmark: address.landmark,
    city: address.city,
    state: address.state,
    stateCode: address.stateCode,
    pincode: address.pincode,
    country: address.country,
    isDefaultShipping: address.isDefaultShipping,
    isDefaultBilling: address.isDefaultBilling,
    deliveryInstructions: address.deliveryInstructions,
    isVerified: address.isVerified,
    serviceability,
    version: address.version,
  };
}

export const addressService = {
  async list(customerId: string): Promise<AddressDto[]> {
    const rows = await addressRepository.findForCustomer(customerId);
    return rows.map((row) => toDto(row));
  },

  async get(customerId: string, id: string): Promise<AddressDto> {
    const address = await addressRepository.findOwned(customerId, id);
    if (!address) throw AppError.notFound('Address not found', { id });

    return toDto(address, await this.lookupPincode(address.pincode));
  },

  async create(customerId: string, input: AddressCreateInput): Promise<AddressDto> {
    const count = await addressRepository.count(customerId);
    if (count >= env.ADDRESS_MAX_PER_CUSTOMER) {
      throw new AppError(
        422,
        'ADDRESS_LIMIT_REACHED',
        `You can save at most ${env.ADDRESS_MAX_PER_CUSTOMER} addresses`,
        { max: env.ADDRESS_MAX_PER_CUSTOMER },
      );
    }

    const state = findIndianState(input.stateCode);
    if (!state) throw AppError.validation('Unknown Indian state code', { field: 'stateCode' });

    const created = await addressRepository.create({
      customerId,
      label: input.label ?? null,
      type: input.type,
      usage: input.usage,
      fullName: input.fullName,
      phone: input.phone,
      altPhone: input.altPhone ?? null,
      line1: input.line1,
      line2: input.line2 ?? null,
      landmark: input.landmark ?? null,
      city: input.city,
      // The canonical name wins over whatever the form sent, so GST place-of-supply stays exact.
      state: state.name,
      stateCode: state.code,
      pincode: input.pincode,
      country: input.country,
      deliveryInstructions: input.deliveryInstructions ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      isDefaultShipping: false,
      isDefaultBilling: false,
    });

    // The first address a customer saves becomes their default without being asked.
    if (count === 0 || input.isDefaultShipping || input.isDefaultBilling) {
      const usage =
        input.isDefaultBilling && !input.isDefaultShipping
          ? 'BILLING'
          : input.isDefaultShipping && !input.isDefaultBilling
            ? 'SHIPPING'
            : 'BOTH';
      await addressRepository.setDefault(customerId, created.id, usage);
    }

    return this.get(customerId, created.id);
  },

  async update(customerId: string, id: string, input: AddressUpdateInput): Promise<AddressDto> {
    const existing = await addressRepository.findOwned(customerId, id);
    if (!existing) throw AppError.notFound('Address not found', { id });

    if (existing.version !== input.version) {
      throw new AppError(409, 'STALE_RESOURCE', 'This address changed elsewhere — reload', {
        yourVersion: input.version,
        currentVersion: existing.version,
      });
    }

    const state = input.stateCode ? findIndianState(input.stateCode) : null;
    if (input.stateCode && !state) {
      throw AppError.validation('Unknown Indian state code', { field: 'stateCode' });
    }

    const { version: _version, isDefaultShipping, isDefaultBilling, ...rest } = input;

    await addressRepository.update(id, {
      ...rest,
      ...(state ? { state: state.name, stateCode: state.code } : {}),
      version: { increment: 1 },
    });

    if (isDefaultShipping || isDefaultBilling) {
      const usage =
        isDefaultBilling && !isDefaultShipping
          ? 'BILLING'
          : isDefaultShipping && !isDefaultBilling
            ? 'SHIPPING'
            : 'BOTH';
      await addressRepository.setDefault(customerId, id, usage);
    }

    return this.get(customerId, id);
  },

  async remove(customerId: string, id: string): Promise<void> {
    const existing = await addressRepository.findOwned(customerId, id);
    if (!existing) throw AppError.notFound('Address not found', { id });

    await addressRepository.clearCustomerDefault(customerId, id);
    await addressRepository.softDelete(id);
  },

  async setDefault(
    customerId: string,
    id: string,
    usage: 'SHIPPING' | 'BILLING' | 'BOTH',
  ): Promise<AddressDto> {
    const existing = await addressRepository.findOwned(customerId, id);
    if (!existing) throw AppError.notFound('Address not found', { id });

    await addressRepository.setDefault(customerId, id, usage);
    return this.get(customerId, id);
  },

  /**
   * Autofill + serviceability in one call.
   *
   * The city/state come from the seeded `ShippingPincode` table; the delivery promise comes from
   * `shipping.service`, so the form and the cart can never disagree about a pincode.
   */
  async lookupPincode(pincode: string): Promise<PincodeLookupDto> {
    return cache.wrap(
      `${CART_CACHE_PREFIXES.pincode}${pincode}`,
      env.CATALOG_CACHE_TTL_SECONDS,
      () => this.resolvePincode(pincode),
    );
  },

  async resolvePincode(pincode: string): Promise<PincodeLookupDto> {
    const [row, serviceability] = await Promise.all([
      addressRepository.findPincode(pincode),
      shippingService.serviceability(pincode),
    ]);

    const result: PincodeLookupDto = {
      pincode,
      city: row?.city ?? serviceability.city,
      state: row?.state ?? serviceability.state,
      stateCode: row?.stateCode ?? serviceability.stateCode,
      isServiceable: serviceability.isServiceable,
      codAvailable: serviceability.codAvailable,
      etaMinDays: serviceability.etaMinDays,
      etaMaxDays: serviceability.etaMaxDays,
      zoneCode: serviceability.zoneCode,
      zoneName: serviceability.zoneName,
      matchedBy: serviceability.matchedBy,
    };

    return result;
  },
};
