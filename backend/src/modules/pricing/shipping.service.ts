import type { ShippingMethod } from '@shared/enums';
import type { PricingShippingRate, ServiceabilityResult } from '@shared/types/pricing';

import { prisma } from '../../config/prisma';
import { notDeleted } from '../../repositories/helpers';

/**
 * Shipping zones, serviceability and rate selection.
 *
 * Zone resolution precedence is fixed: an exact pincode row beats a range, a range beats the
 * default (lowest-priority active) zone. Nothing else resolves a zone.
 *
 * Address book and cart integration belong to Prompt 8 — this service only exposes the methods.
 */

export interface ZoneMatch {
  zoneId: string;
  zoneCode: string;
  zoneName: string;
  matchedBy: 'PINCODE' | 'RANGE' | 'DEFAULT';
  stateCode: string | null;
  state: string | null;
  city: string | null;
  isServiceable: boolean;
  codAvailable: boolean;
  etaMinDays: number | null;
  etaMaxDays: number | null;
}

export const shippingService = {
  async resolveZone(pincode: string | null): Promise<ZoneMatch | null> {
    if (pincode) {
      const exact = await prisma.shippingPincode.findUnique({
        where: { pincode },
        include: { zone: true },
      });

      if (exact && !exact.zone.deletedAt && exact.zone.isActive) {
        return {
          zoneId: exact.zoneId,
          zoneCode: exact.zone.code,
          zoneName: exact.zone.name,
          matchedBy: 'PINCODE',
          stateCode: exact.stateCode,
          state: exact.state,
          city: exact.city,
          isServiceable: exact.isServiceable,
          codAvailable: exact.codAvailable,
          etaMinDays: exact.etaMinDays,
          etaMaxDays: exact.etaMaxDays,
        };
      }

      const ranges = await prisma.shippingPincodeRange.findMany({
        where: { fromPincode: { lte: pincode }, toPincode: { gte: pincode } },
        include: { zone: true },
      });

      const range = ranges.find((row) => row.zone.isActive && !row.zone.deletedAt);
      if (range) {
        return {
          zoneId: range.zoneId,
          zoneCode: range.zone.code,
          zoneName: range.zone.name,
          matchedBy: 'RANGE',
          stateCode: range.stateCode,
          state: null,
          city: null,
          isServiceable: true,
          codAvailable: false,
          etaMinDays: null,
          etaMaxDays: null,
        };
      }
    }

    const fallback = await prisma.shippingZone.findFirst({
      where: { isActive: true, ...notDeleted },
      orderBy: { priority: 'desc' },
    });
    if (!fallback) return null;

    return {
      zoneId: fallback.id,
      zoneCode: fallback.code,
      zoneName: fallback.name,
      matchedBy: 'DEFAULT',
      stateCode: null,
      state: null,
      city: null,
      isServiceable: true,
      codAvailable: false,
      etaMinDays: null,
      etaMaxDays: null,
    };
  },

  async serviceability(pincode: string): Promise<ServiceabilityResult> {
    const zone = await this.resolveZone(pincode);

    if (!zone) {
      return {
        pincode,
        isServiceable: false,
        codAvailable: false,
        zoneCode: null,
        zoneName: null,
        city: null,
        state: null,
        stateCode: null,
        etaMinDays: null,
        etaMaxDays: null,
        matchedBy: 'NONE',
      };
    }

    // A zone with no rates cannot actually ship anything.
    const rates = await this.ratesForZone(zone.zoneId);
    const fastest = rates
      .filter((rate) => rate.etaMinDays !== null)
      .sort((a, b) => (a.etaMinDays ?? 99) - (b.etaMinDays ?? 99))[0];

    return {
      pincode,
      isServiceable: zone.isServiceable && rates.length > 0,
      codAvailable: zone.codAvailable,
      zoneCode: zone.zoneCode,
      zoneName: zone.zoneName,
      city: zone.city,
      state: zone.state,
      stateCode: zone.stateCode,
      etaMinDays: zone.etaMinDays ?? fastest?.etaMinDays ?? null,
      etaMaxDays: zone.etaMaxDays ?? fastest?.etaMaxDays ?? null,
      matchedBy: zone.matchedBy,
    };
  },

  async ratesForZone(zoneId: string): Promise<PricingShippingRate[]> {
    const rows = await prisma.shippingRate.findMany({
      where: { zoneId, isActive: true, ...notDeleted },
      include: { zone: { select: { code: true } } },
      orderBy: [{ priority: 'asc' }, { basePaise: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      zoneId: row.zoneId,
      zoneCode: row.zone.code,
      method: row.method as ShippingMethod,
      name: row.name,
      conditionType: row.conditionType,
      minValue: row.minValue,
      maxValue: row.maxValue,
      basePaise: row.basePaise,
      perUnitPaise: row.perUnitPaise,
      freeAbovePaise: row.freeAbovePaise,
      etaMinDays: row.etaMinDays,
      etaMaxDays: row.etaMaxDays,
      priority: row.priority,
    }));
  },

  /**
   * The rate that would be charged for a given cart shape. The engine does the same selection
   * internally from the loaded context; this is the standalone estimator for Prompt 8.
   */
  async estimate(input: {
    pincode: string | null;
    subtotalPaise: number;
    weightGrams: number;
    itemCount: number;
    method?: ShippingMethod;
  }): Promise<{ zone: ZoneMatch | null; rate: PricingShippingRate | null; pricePaise: number }> {
    const zone = await this.resolveZone(input.pincode);
    if (!zone) return { zone: null, rate: null, pricePaise: 0 };

    const rates = await this.ratesForZone(zone.zoneId);
    const rate = pickRate(rates, input);
    if (!rate) return { zone, rate: null, pricePaise: 0 };

    const free = rate.freeAbovePaise !== null && input.subtotalPaise >= rate.freeAbovePaise;
    const pricePaise = free
      ? 0
      : rate.basePaise + (rate.perUnitPaise ?? 0) * Math.max(0, input.itemCount - 1);

    return { zone, rate, pricePaise };
  },
};

export function pickRate(
  rates: PricingShippingRate[],
  input: { subtotalPaise: number; weightGrams: number; itemCount: number; method?: ShippingMethod },
): PricingShippingRate | null {
  const matching = rates.filter((rate) => {
    if (input.method && rate.method !== input.method) return false;

    const value =
      rate.conditionType === 'WEIGHT'
        ? input.weightGrams
        : rate.conditionType === 'ITEM_COUNT'
          ? input.itemCount
          : input.subtotalPaise;

    if (rate.minValue !== null && value < rate.minValue) return false;
    if (rate.maxValue !== null && value > rate.maxValue) return false;
    return true;
  });

  return (
    matching.sort((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority : a.id < b.id ? -1 : 1,
    )[0] ?? null
  );
}
