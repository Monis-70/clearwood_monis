import { log, prisma } from './context';

/**
 * Quantity breaks on three demo products, so the tier resolver has real data to work with.
 * Furniture sells in sets, so the breaks sit at 2 (a pair), 5 (a dining set) and 10 (a project).
 */

const TIERS: {
  productSlug: string;
  breaks: { minQty: number; discountBp?: number; pricePaise?: number }[];
}[] = [
  {
    productSlug: 'kabir-3-seater-fabric-sofa',
    breaks: [
      { minQty: 2, discountBp: 500 },
      { minQty: 5, discountBp: 1000 },
      { minQty: 10, discountBp: 1500 },
    ],
  },
  {
    productSlug: 'mahseer-counter-stool',
    breaks: [
      { minQty: 2, discountBp: 300 },
      // A flat per-unit price for a full set of stools rather than another percentage.
      { minQty: 5, pricePaise: 899_900 },
      { minQty: 10, pricePaise: 849_900 },
    ],
  },
  {
    productSlug: 'ortho-zen-pocket-spring-mattress',
    breaks: [
      { minQty: 2, discountBp: 700 },
      { minQty: 5, discountBp: 1200 },
    ],
  },
];

export async function seedTierPrices(): Promise<void> {
  let created = 0;
  let skipped = 0;

  for (const entry of TIERS) {
    const product = await prisma.product.findFirst({
      where: { slug: entry.productSlug, deletedAt: null },
      select: { id: true },
    });

    if (!product) {
      skipped += 1;
      continue;
    }

    for (const tier of entry.breaks) {
      const existing = await prisma.tierPrice.findFirst({
        where: { productId: product.id, minQty: tier.minQty, customerGroupId: null },
      });
      if (existing) continue;

      await prisma.tierPrice.create({
        data: {
          productId: product.id,
          minQty: tier.minQty,
          pricePaise: tier.pricePaise ?? null,
          discountBp: tier.discountBp ?? null,
          isActive: true,
        },
      });
      created += 1;
    }
  }

  const total = await prisma.tierPrice.count({ where: { deletedAt: null } });
  log(
    'tier-prices',
    `${created} quantity breaks created (${total} total, ${skipped} products missing)`,
  );
}
