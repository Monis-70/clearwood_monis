import { PRODUCT_BADGE_CODES, type ProductBadgeCode } from '@shared/enums';
import type { ProductBadgeDto } from '@shared/types/storefront';

import { settingsService, type BadgeStyle } from './storefrontSettings.service';

/**
 * Time-aware merchandising, judged the same way everywhere a product is shown: the listing SQL
 * (listing.repository), cards, the product page and automatic collections.
 *
 *   new arrival  the `isNewArrival` flag (an admin's override), or live for less than the
 *                `catalog.new_arrival_days` window - nobody has to tag every new product
 *   featured     `isFeatured`, until `featuredUntil` passes
 *   badges       facts about the product; which ones show and their words come from the
 *                `catalog.badges` setting, plus the product's own `badgeText`
 */

const DAY_MS = 86_400_000;

export interface MerchandisingContext {
  now: Date;
  /** Live since this moment = new arrival; null when the window is switched off. */
  newArrivalSince: Date | null;
  badges: Partial<Record<ProductBadgeCode, BadgeStyle>>;
}

export function merchandisingAt(
  settings: { newArrivalDays: number; badges: Partial<Record<ProductBadgeCode, BadgeStyle>> },
  now = new Date(),
): MerchandisingContext {
  return {
    now,
    newArrivalSince:
      settings.newArrivalDays > 0
        ? new Date(now.getTime() - settings.newArrivalDays * DAY_MS)
        : null,
    badges: settings.badges,
  };
}

export async function loadMerchandising(now = new Date()): Promise<MerchandisingContext> {
  return merchandisingAt(await settingsService.read(), now);
}

export function isNewArrivalAt(
  product: { isNewArrival: boolean; publishedAt: Date | null; createdAt: Date },
  context: Pick<MerchandisingContext, 'newArrivalSince'>,
): boolean {
  if (product.isNewArrival) return true;
  if (!context.newArrivalSince) return false;
  return (product.publishedAt ?? product.createdAt).getTime() >= context.newArrivalSince.getTime();
}

export function isFeaturedAt(
  product: { isFeatured: boolean; featuredUntil: Date | null },
  now: Date,
): boolean {
  return product.isFeatured && (product.featuredUntil === null || product.featuredUntil > now);
}

export interface BadgeFacts {
  customText: string | null;
  customColor: string | null;
  newArrival: boolean;
  sale: boolean;
  bestSeller: boolean;
  featured: boolean;
  specialCollection: boolean;
  madeToOrder: boolean;
  customizable: boolean;
  inHouse: boolean;
}

/** The product's own badge first, then every configured badge whose fact holds, in code order. */
export function badgesFor(facts: BadgeFacts, context: MerchandisingContext): ProductBadgeDto[] {
  const holds: Record<Exclude<ProductBadgeCode, 'CUSTOM'>, boolean> = {
    NEW_ARRIVAL: facts.newArrival,
    SALE: facts.sale,
    BEST_SELLER: facts.bestSeller,
    FEATURED: facts.featured,
    SPECIAL_COLLECTION: facts.specialCollection,
    MADE_TO_ORDER: facts.madeToOrder,
    CUSTOMIZABLE: facts.customizable,
    IN_HOUSE: facts.inHouse,
  };

  const badges: ProductBadgeDto[] = [];
  if (facts.customText) {
    badges.push({ code: 'CUSTOM', label: facts.customText, color: facts.customColor });
  }
  for (const code of PRODUCT_BADGE_CODES) {
    if (code === 'CUSTOM' || !holds[code]) continue;
    const style = context.badges[code];
    if (style) badges.push({ code, label: style.label, color: style.color });
  }
  return badges;
}
