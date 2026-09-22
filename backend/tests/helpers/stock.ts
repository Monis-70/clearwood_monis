import { prisma } from '../../src/config/prisma';
import { inventoryService } from '../../src/modules/catalog-admin/inventory.service';

/**
 * Stock scaffolding that goes through the real path.
 *
 * Tests used to `prisma.productVariant.updateMany({ data: { stockQty } })` directly — the exact
 * bypass `inventory.service` exists to prevent. That left the one guarded writer unexercised by
 * scaffolding and, worse, made the bypass look like an accepted idiom. Setting stock through
 * `adjust({ absolute })` means every test run also exercises the compare-and-set and writes a real
 * `InventoryLedger` row.
 */

const SYSTEM = { actorType: 'SYSTEM' as const, actorId: null };

/** Sets every live variant of a product to an absolute quantity, ledgered. */
export async function setStockForProduct(slug: string, absolute: number): Promise<void> {
  const variants = await prisma.productVariant.findMany({
    where: { product: { slug }, deletedAt: null },
    select: { id: true, reservedQty: true },
  });

  for (const variant of variants) {
    // Reservations are settled by the order flow; scaffolding clears them so a fresh test starts
    // from a known position rather than inheriting another test's holds.
    if (variant.reservedQty !== 0) {
      await prisma.productVariant.update({
        where: { id: variant.id },
        data: { reservedQty: 0 },
      });
    }

    await inventoryService.adjust(
      variant.id,
      { absolute, reason: 'CORRECTION', note: 'test scaffolding' },
      SYSTEM,
    );
  }
}

export async function setStockForVariant(variantId: string, absolute: number): Promise<void> {
  await inventoryService.adjust(
    variantId,
    { absolute, reason: 'CORRECTION', note: 'test scaffolding' },
    SYSTEM,
  );
}
