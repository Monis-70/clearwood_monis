import { env } from '../../src/config/env';
import { buildLineKey } from '../../src/modules/cart/lineKey';

import { epochMinus } from './epoch';
import { log, prisma } from './context';

/**
 * Demo carts, so the admin abandoned-cart view, the validator and the merge flow all have real
 * data to work with on a fresh install.
 *
 * Four shapes:
 *   1. an ACTIVE customer cart with several lines, a coupon and a pincode;
 *   2. an ABANDONED cart older than CART_ABANDON_AFTER_HOURS;
 *   3. a deliberately broken cart — an out-of-stock line and a line above the per-line maximum —
 *      so `validate()` has genuine issues to report rather than a synthetic one;
 *   4. a guest cart keyed by a fixed sessionId, ready to be merge-tested against cart 1.
 *
 * Idempotent: every cart has a fixed id and every line a deterministic lineKey, so re-seeding
 * upserts in place. Prices written here are SNAPSHOTS (`addedUnitPricePaise`) — never authoritative.
 * The engine re-quotes on every read, which is exactly what makes a stale snapshot safe to seed.
 */

const GUEST_SESSION_ID = 'seed-guest-session-0001';

interface SeedLine {
  slug: string;
  /** Which variant of that product, by SKU suffix. Falls back to the default variant. */
  variantSuffix?: string;
  qty: number;
  saveState?: 'IN_CART' | 'SAVED_FOR_LATER';
}

interface SeedCart {
  id: string;
  /** ACTIVE carts own their `activeOwnerKey`; finished ones must leave it NULL. */
  status: 'ACTIVE' | 'ABANDONED';
  owner: 'CUSTOMER' | 'GUEST';
  couponCode?: string;
  pincode?: string;
  /** How long ago this cart was last touched, in hours. Drives the abandoned sweep. */
  idleHours: number;
  lines: SeedLine[];
}

const DEMO_CARTS: SeedCart[] = [
  {
    id: 'seedcart0000000000000001',
    status: 'ACTIVE',
    owner: 'CUSTOMER',
    couponCode: 'WELCOME10',
    pincode: '400001',
    idleHours: 0,
    lines: [
      { slug: 'kabir-3-seater-fabric-sofa', variantSuffix: 'BEI-COT', qty: 2 },
      { slug: 'kabir-3-seater-fabric-sofa', variantSuffix: 'OLI-COT', qty: 1 },
      { slug: 'banyan-live-edge-coffee-table', qty: 1 },
      { slug: 'nilgiri-rocking-chair', qty: 1, saveState: 'SAVED_FOR_LATER' },
    ],
  },
  {
    id: 'seedcart0000000000000002',
    status: 'ABANDONED',
    owner: 'CUSTOMER',
    pincode: '110001',
    idleHours: 72,
    lines: [
      { slug: 'malabar-l-shaped-sofa', qty: 1 },
      { slug: 'ashoka-nesting-table-set', qty: 2 },
    ],
  },
  {
    id: 'seedcart0000000000000003',
    status: 'ACTIVE',
    owner: 'GUEST',
    idleHours: 1,
    lines: [
      // `rajwada-diwan` is seeded with zero stock, so this line reports OUT_OF_STOCK for real.
      { slug: 'rajwada-diwan', qty: 1 },
      // Above CART_MAX_QTY_PER_LINE, so the validator reports MAX_QTY_EXCEEDED with a real fix.
      { slug: 'mahseer-counter-stool', qty: env.CART_MAX_QTY_PER_LINE + 5 },
    ],
  },
  {
    id: 'seedcart0000000000000004',
    status: 'ACTIVE',
    owner: 'GUEST',
    idleHours: 2,
    lines: [
      // Overlaps cart 1 on purpose: merging must SUM these quantities onto the existing line.
      { slug: 'kabir-3-seater-fabric-sofa', variantSuffix: 'BEI-COT', qty: 1 },
      { slug: 'konark-storage-bench', qty: 1 },
    ],
  },
];

/** Cart 3 is a guest cart too, but it must not collide with cart 4 on the one-ACTIVE-cart rule. */
const GUEST_SESSIONS: Record<string, string> = {
  seedcart0000000000000003: 'seed-guest-session-broken',
  seedcart0000000000000004: GUEST_SESSION_ID,
};

export async function seedDemoCarts(): Promise<void> {
  const customer = await prisma.customer.findUnique({
    where: { email: 'aarav.mehta@example.com' },
  });

  if (!customer) {
    log('demo-carts', 'skipped (demo customers are not seeded)');
    return;
  }

  let lineCount = 0;

  for (const seed of DEMO_CARTS) {
    const sessionId = seed.owner === 'GUEST' ? GUEST_SESSIONS[seed.id]! : null;
    const customerId = seed.owner === 'CUSTOMER' ? customer.id : null;
    const lastActivityAt = epochMinus(0, seed.idleHours);

    // Only an ACTIVE cart claims the unique owner key; an abandoned one must release it.
    const activeOwnerKey =
      seed.status === 'ACTIVE' ? (customerId ? `c:${customerId}` : `s:${sessionId}`) : null;

    const ttlDays = customerId ? env.CART_CUSTOMER_TTL_DAYS : env.CART_GUEST_TTL_DAYS;

    const data = {
      customerId,
      sessionId,
      status: seed.status,
      activeOwnerKey,
      couponCode: seed.couponCode ?? null,
      pincode: seed.pincode ?? null,
      lastActivityAt,
      expiresAt: new Date(lastActivityAt.getTime() + ttlDays * 24 * 60 * 60 * 1000),
    };

    await prisma.cart.upsert({
      where: { id: seed.id },
      update: data,
      create: { id: seed.id, ...data },
    });

    const keptLineKeys: string[] = [];
    let position = 0;

    for (const line of seed.lines) {
      const product = await prisma.product.findUnique({
        where: { slug: line.slug },
        include: {
          variants: {
            where: { deletedAt: null },
            include: { attributeValues: { select: { attributeValueId: true } } },
          },
        },
      });

      // A slug may be absent if the demo catalog was trimmed; skip rather than fail the seed.
      if (!product) continue;

      const variant = line.variantSuffix
        ? product.variants.find((candidate) => candidate.sku.endsWith(line.variantSuffix!))
        : (product.variants.find((candidate) => candidate.isDefault) ?? product.variants[0]);

      /*
       * The key MUST be built the way `cart.service.resolveLine` builds it — variant id plus the
       * variant's own option value ids — or a seeded line and an API-added line would be two rows
       * for the same configuration, and the merge would never combine them.
       */
      const optionValueIds = (variant?.attributeValues ?? []).map((link) => link.attributeValueId);

      const lineKey = buildLineKey({
        productId: product.id,
        variantId: variant?.id ?? null,
        optionValueIds,
      });
      keptLineKeys.push(lineKey);

      const unitPricePaise = variant?.pricePaise ?? product.basePricePaise;

      const lineData = {
        productId: product.id,
        variantId: variant?.id ?? null,
        qty: line.qty,
        selectedOptionsJson: JSON.stringify(optionValueIds),
        saveState: line.saveState ?? 'IN_CART',
        addedUnitPricePaise: unitPricePaise,
        addedTotalPaise: unitPricePaise * line.qty,
        productNameSnapshot: product.name,
        variantNameSnapshot: variant?.name ?? null,
        skuSnapshot: variant?.sku ?? product.sku,
        position: position++,
      };

      await prisma.cartItem.upsert({
        where: { cartId_lineKey: { cartId: seed.id, lineKey } },
        update: lineData,
        create: { cartId: seed.id, lineKey, ...lineData },
      });

      lineCount += 1;
    }

    // Re-seeding after a line was removed from this file must not leave an orphan behind.
    await prisma.cartItem.deleteMany({
      where: { cartId: seed.id, lineKey: { notIn: keptLineKeys } },
    });

    const items = await prisma.cartItem.findMany({
      where: { cartId: seed.id, saveState: 'IN_CART' },
      select: { qty: true },
    });

    await prisma.cart.update({
      where: { id: seed.id },
      data: {
        itemCount: items.length,
        quantityTotal: items.reduce((total, item) => total + item.qty, 0),
      },
    });
  }

  log(
    'demo-carts',
    `${DEMO_CARTS.length} carts / ${lineCount} lines ensured (guest session: ${GUEST_SESSION_ID})`,
  );
}
