import { PrismaClient } from '@prisma/client';

/**
 * Shared state for the seed steps. The seed keeps its own PrismaClient (as it has since Prompt 1)
 * so it never inherits the API's dev query logging.
 */

export const prisma = new PrismaClient();

export type SeedPrisma = typeof prisma;

export function log(step: string, message: string): void {
  console.log(`[seed:${step}] ${message}`);
}

/** Every model the seed touches, for the idempotency test and the delivery report. */
export const SEEDED_MODELS = [
  'appSetting',
  'taxClass',
  'attributeGroup',
  'attribute',
  'attributeValue',
  'category',
  'categoryAttribute',
  'collection',
  'collectionProduct',
  'navigationMenu',
  'navigationItem',
  'mediaFolder',
  'media',
  'mediaVariant',
  'mediaUsage',
  'brand',
  'product',
  'productCategory',
  'productAttributeValue',
  'productVariant',
  'variantAttributeValue',
  'productMedia',
  'productRelation',
  'inventoryLedger',
  'slugRedirect',
  'priceAdjustment',
  'customerGroup',
  'priceList',
  'tierPrice',
  'coupon',
  'discountRule',
  'shippingZone',
  'shippingPincode',
  'shippingRate',
  'searchDocument',
  'searchSynonym',
  'productStat',
  'permission',
  'role',
  'rolePermission',
  'adminUser',
  'adminUserRole',
  'customer',
  'cart',
  'cartItem',
  'wishlist',
  'wishlistItem',
  'address',
  'splitAccount',
  'splitRule',
  'order',
  'orderItem',
  'payment',
  'paymentTransfer',
  'splitAllocation',
  'stockReservation',
] as const;

export type SeededModel = (typeof SEEDED_MODELS)[number];

export async function rowCounts(client: SeedPrisma = prisma): Promise<Record<SeededModel, number>> {
  const entries = await Promise.all(
    SEEDED_MODELS.map(async (model) => {
      const delegate = client[model] as unknown as { count(): Promise<number> };
      return [model, await delegate.count()] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<SeededModel, number>;
}
