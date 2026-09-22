import { buildLineKey } from '../../src/modules/cart/lineKey';

import { log, prisma } from './context';

/**
 * Demo wishlists: the default list every customer gets, plus a shared public one so the
 * `/wishlists/shared/{token}` route can be opened straight after a seed.
 *
 * The share token is fixed here only because it is demo data on a demo install; real tokens are
 * minted from `randomBytes` by `wishlist.service`. The shared view exposes no customer PII, which
 * is what makes a guessable demo token harmless.
 *
 * `addedPricePaise` is set deliberately high on one item so the price-drop flag is visible in the
 * UI on the very first run.
 */

const SHARED_TOKEN = 'seedshare0000000000000001';

interface SeedList {
  id: string;
  name: string;
  isDefault: boolean;
  isPublic: boolean;
  shareToken: string | null;
  items: { slug: string; priority?: 'LOW' | 'NORMAL' | 'HIGH'; inflatePrice?: boolean }[];
}

const LISTS: SeedList[] = [
  {
    id: 'seedwish0000000000000001',
    name: 'My Wishlist',
    isDefault: true,
    isPublic: false,
    shareToken: null,
    items: [
      { slug: 'teakwood-chesterfield-leather-sofa', priority: 'HIGH' },
      { slug: 'arjun-wingback-lounge-chair' },
      // Saved at a higher price than it sells for now, so the list shows a price drop immediately.
      { slug: 'ortho-zen-pocket-spring-mattress', inflatePrice: true },
    ],
  },
  {
    id: 'seedwish0000000000000002',
    name: 'Living Room Ideas',
    isDefault: false,
    isPublic: true,
    shareToken: SHARED_TOKEN,
    items: [
      { slug: 'malabar-l-shaped-sofa', priority: 'HIGH' },
      { slug: 'banyan-live-edge-coffee-table' },
      { slug: 'konark-storage-bench', priority: 'LOW' },
    ],
  },
];

export async function seedDemoWishlists(): Promise<void> {
  const customer = await prisma.customer.findUnique({
    where: { email: 'aarav.mehta@example.com' },
  });

  if (!customer) {
    log('demo-wishlists', 'skipped (demo customers are not seeded)');
    return;
  }

  let itemCount = 0;

  for (const list of LISTS) {
    const data = {
      customerId: customer.id,
      sessionId: null,
      name: list.name,
      isDefault: list.isDefault,
      isPublic: list.isPublic,
      shareToken: list.shareToken,
      deletedAt: null,
    };

    await prisma.wishlist.upsert({
      where: { id: list.id },
      update: data,
      create: { id: list.id, ...data },
    });

    const keptLineKeys: string[] = [];
    let position = 0;

    for (const item of list.items) {
      const product = await prisma.product.findUnique({
        where: { slug: item.slug },
        include: {
          variants: {
            where: { deletedAt: null },
            include: { attributeValues: { select: { attributeValueId: true } } },
          },
        },
      });

      if (!product) continue;

      const variant =
        product.variants.find((candidate) => candidate.isDefault) ?? product.variants[0];

      // Same formula as the cart, so "move to cart" lands on the line the shopper already has.
      const optionValueIds = (variant?.attributeValues ?? []).map((link) => link.attributeValueId);

      const lineKey = buildLineKey({
        productId: product.id,
        variantId: variant?.id ?? null,
        optionValueIds,
      });
      keptLineKeys.push(lineKey);

      const price = variant?.pricePaise ?? product.basePricePaise;

      const itemData = {
        productId: product.id,
        variantId: variant?.id ?? null,
        selectedOptionsJson: JSON.stringify(optionValueIds),
        priority: item.priority ?? 'NORMAL',
        addedPricePaise: item.inflatePrice ? Math.round(price * 1.25) : price,
        position: position++,
      };

      await prisma.wishlistItem.upsert({
        where: { wishlistId_lineKey: { wishlistId: list.id, lineKey } },
        update: itemData,
        create: { wishlistId: list.id, lineKey, ...itemData },
      });

      itemCount += 1;
    }

    await prisma.wishlistItem.deleteMany({
      where: { wishlistId: list.id, lineKey: { notIn: keptLineKeys } },
    });

    await prisma.wishlist.update({
      where: { id: list.id },
      data: { itemCount: await prisma.wishlistItem.count({ where: { wishlistId: list.id } }) },
    });
  }

  log('demo-wishlists', `${LISTS.length} wishlists / ${itemCount} items ensured`);
}
