import { brandAdminService } from '../../src/container';

import { log, prisma } from './context';
import { ensureSeedMedia } from './media-assets';

/**
 * The house brand and its two sub-labels. Structural data — the storefront shows brand badges, so
 * it must exist even without SEED_DEMO.
 */

const BRANDS = [
  {
    slug: 'clearwood',
    name: 'ClearWood',
    hex: '#B4613A',
    description:
      'Solid-wood furniture made in our own workshop, finished by hand and built to outlast trends.',
    position: 0,
  },
  {
    slug: 'clearwood-signature',
    name: 'ClearWood Signature',
    hex: '#8A5A3B',
    description: 'Our flagship line: rare timbers, deeper detailing and a longer warranty.',
    position: 1,
  },
  {
    slug: 'clearwood-outdoor',
    name: 'ClearWood Outdoor',
    hex: '#7E8C77',
    description: 'Weather-resistant teak and powder-coated frames for balconies and gardens.',
    position: 2,
  },
] as const;

export async function seedBrands(): Promise<void> {
  let created = 0;

  for (const brand of BRANDS) {
    const logo = await ensureSeedMedia({
      key: `brand-${brand.slug}`,
      label: brand.name,
      caption: 'Brand mark',
      hex: brand.hex,
      width: 800,
      height: 800,
      altText: `${brand.name} logo`,
    });

    const existing = await prisma.brand.findFirst({ where: { slug: brand.slug } });

    if (existing) {
      // Structural fields stay in sync; the admin-editable description is written once.
      await prisma.brand.update({
        where: { id: existing.id },
        data: { logoMediaId: logo.id, position: brand.position, deletedAt: null },
      });
      continue;
    }

    await brandAdminService.create({
      name: brand.name,
      slug: brand.slug,
      logoMediaId: logo.id,
      description: brand.description,
      isActive: true,
      position: brand.position,
    });
    created += 1;
  }

  // Attach the demo catalog: outdoor products to the outdoor label, the rest to the house brand.
  const [house, outdoor] = await Promise.all([
    prisma.brand.findFirst({ where: { slug: 'clearwood' } }),
    prisma.brand.findFirst({ where: { slug: 'clearwood-outdoor' } }),
  ]);

  let assigned = 0;

  if (house && outdoor) {
    const products = await prisma.product.findMany({
      where: { brandId: null, deletedAt: null },
      select: { id: true, slug: true },
    });

    for (const product of products) {
      const brandId = /outdoor|garden|balcony|patio/.test(product.slug) ? outdoor.id : house.id;
      await prisma.product.update({ where: { id: product.id }, data: { brandId } });
      assigned += 1;
    }
  }

  log(
    'brands',
    `${BRANDS.length} brands ensured (${created} created), ${assigned} products linked`,
  );
}
