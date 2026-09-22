import { log, prisma } from './context';

/**
 * Banners and the announcement bar.
 *
 * Keyed on `name` so a re-seed does not duplicate, and so an admin who edits the copy keeps their
 * wording.
 */

async function imageIds(limit: number, skip = 0): Promise<string[]> {
  const rows = await prisma.media.findMany({
    where: { kind: 'IMAGE', status: 'READY', deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    skip,
    take: limit,
  });

  return rows.map((row) => row.id);
}

export async function seedBanners(): Promise<void> {
  const media = await imageIds(6, 6);
  const pick = (index: number): string | null => media[index % Math.max(media.length, 1)] ?? null;

  const BANNERS = [
    {
      name: 'Home hero — workshop',
      placement: 'HOME_HERO',
      mediaId: pick(0),
      headline: 'We Take Furniture Making Seriously',
      subheadline: 'Cut, joined and finished in our own Bengaluru workshop.',
      ctaLabel: 'Shop sofas',
      ctaUrl: '/sofas',
      position: 0,
    },
    {
      name: 'Home hero — made to order',
      placement: 'HOME_HERO',
      mediaId: pick(1),
      headline: 'Built to order, in your fabric',
      subheadline: 'Choose the wood, the finish and the size.',
      ctaLabel: 'Explore',
      ctaUrl: '/collections/made-to-order',
      position: 1,
    },
    {
      name: 'Home strip — assembly included',
      placement: 'HOME_STRIP',
      mediaId: pick(2),
      headline: 'Free assembly on every large piece',
      subheadline: 'Our team does not leave until it is standing and level.',
      position: 0,
    },
    {
      name: 'Category top — sofas',
      placement: 'CATEGORY_TOP',
      mediaId: pick(3),
      headline: 'Sofas built for Indian living rooms',
      subheadline: 'Deep seats, hard-wearing fabric, frames that survive a move.',
      position: 0,
    },
    {
      name: 'Cart promo — GST invoice',
      placement: 'CART_PROMO',
      mediaId: null,
      headline: 'GST invoice on every order',
      subheadline: 'Claim it against your business if you can.',
      position: 0,
    },
  ];

  let created = 0;

  for (const banner of BANNERS) {
    const existing = await prisma.banner.findFirst({
      where: { name: banner.name, deletedAt: null },
      select: { id: true },
    });

    if (existing) continue;

    await prisma.banner.create({
      data: {
        name: banner.name,
        placement: banner.placement,
        mediaId: banner.mediaId,
        headline: banner.headline,
        subheadline: banner.subheadline ?? null,
        ctaLabel: 'ctaLabel' in banner ? (banner.ctaLabel ?? null) : null,
        ctaUrl: 'ctaUrl' in banner ? (banner.ctaUrl ?? null) : null,
        ctaStyle: 'PRIMARY',
        position: banner.position,
        isActive: true,
        deviceVisibility: 'ALL',
      },
    });

    created += 1;
  }

  const ANNOUNCEMENT = {
    message: 'Free assembly and delivery on orders above \u20B930,000 \u2014 this month only.',
    linkUrl: '/collections/deals-of-the-week',
    linkLabel: 'See the deals',
  };

  const existingBar = await prisma.announcementBar.findFirst({
    where: { message: ANNOUNCEMENT.message, deletedAt: null },
    select: { id: true },
  });

  if (!existingBar) {
    await prisma.announcementBar.create({
      data: {
        ...ANNOUNCEMENT,
        backgroundHex: '#1F2937',
        textHex: '#FFFFFF',
        isDismissible: true,
        isActive: true,
        position: 0,
        deviceVisibility: 'ALL',
      },
    });
  }

  log('banners', `${BANNERS.length} banners (${created} created) + 1 announcement bar`);
}
