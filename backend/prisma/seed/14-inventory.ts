import { inventoryService, productAdminService } from '../../src/container';

import { log, prisma } from './context';
import { DEMO_PRODUCTS } from './data/demoProducts';

/**
 * Opening stock for the demo catalog, written through InventoryService so the ledger is the only
 * thing that ever moved stock — balances and history reconcile exactly.
 *
 * Idempotent: a variant that already has an INITIAL_STOCK entry is skipped, so re-seeding never
 * inflates the balance.
 */

/** The quantity each demo variant is meant to open with, keyed by SKU. */
const FIXTURE_STOCK = new Map<string, number>(
  DEMO_PRODUCTS.flatMap((product) =>
    product.variants.map(
      (variant) => [`${product.sku}-${variant.suffix}`, variant.stockQty ?? 0] as const,
    ),
  ),
);

/** Deterministic fallback for variants with no fixture entry; made-to-order stays at zero. */
function openingStockFor(sku: string, isMadeToOrder: boolean): number {
  if (isMadeToOrder) return 0;

  const fixture = FIXTURE_STOCK.get(sku);
  if (fixture !== undefined) return fixture;

  let hash = 0;
  for (const char of sku) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return 4 + (hash % 21); // 4–24 units
}

export async function seedInventory(): Promise<void> {
  const variants = await prisma.productVariant.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      sku: true,
      stockQty: true,
      product: { select: { isMadeToOrder: true } },
    },
  });

  let seeded = 0;

  for (const variant of variants) {
    const already = await prisma.inventoryLedger.count({
      where: { variantId: variant.id, reason: 'INITIAL_STOCK' },
    });
    if (already > 0) continue;

    const opening = openingStockFor(variant.sku, variant.product.isMadeToOrder);
    if (opening === 0) continue;

    await inventoryService.adjust(
      variant.id,
      { absolute: opening, reason: 'INITIAL_STOCK', note: 'Seeded opening stock' },
      { actorType: 'SYSTEM', actorId: null },
    );
    seeded += 1;
  }

  const [entries, balance] = await Promise.all([
    prisma.inventoryLedger.count(),
    prisma.productVariant.aggregate({ _sum: { stockQty: true }, where: { deletedAt: null } }),
  ]);

  log(
    'inventory',
    `${seeded} variants given opening stock (${entries} ledger rows, ${balance._sum.stockQty ?? 0} units on hand)`,
  );
}

/** One-time backfill so products created before Prompt 5 get a completeness score. */
export async function backfillCompleteness(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });

  let updated = 0;
  for (const product of products) {
    await productAdminService.refreshCompleteness(product.id);
    updated += 1;
  }

  log('inventory', `${updated} product completeness scores recomputed`);
}
