import { brandAdminService } from '../../src/container';

import { DEMO_PRODUCTS } from './data/demoProducts';
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
  const createdSlugs = new Set<string>();

  for (const brand of BRANDS) {
    // CREATE-ONLY (deleted rows included): logo, position, state and copy are the admin's.
    const existing = await prisma.brand.findFirst({
      where: { slug: brand.slug },
      select: { id: true },
    });
    if (existing) continue;

    const logo = await ensureSeedMedia({
      key: `brand-${brand.slug}`,
      label: brand.name,
      caption: 'Brand mark',
      hex: brand.hex,
      width: 800,
      height: 800,
      altText: `${brand.name} logo`,
    });

    await brandAdminService.create({
      name: brand.name,
      slug: brand.slug,
      logoMediaId: logo.id,
      description: brand.description,
      isActive: true,
      position: brand.position,
    });
    createdSlugs.add(brand.slug);
  }

  /*
   * Attach the demo catalog - only the demo SKUs, and only to a brand created in this run - so a
   * re-seed never brands a product an admin created or whose brand an admin cleared.
   */
  const [house, outdoor] = await Promise.all([
    createdSlugs.has('clearwood')
      ? prisma.brand.findFirst({ where: { slug: 'clearwood', deletedAt: null } })
      : null,
    createdSlugs.has('clearwood-outdoor')
      ? prisma.brand.findFirst({ where: { slug: 'clearwood-outdoor', deletedAt: null } })
      : null,
  ]);

  let assigned = 0;

  if (house || outdoor) {
    const products = await prisma.product.findMany({
      where: {
        sku: { in: DEMO_PRODUCTS.map((product) => product.sku) },
        brandId: null,
        deletedAt: null,
      },
      select: { id: true, slug: true },
    });

    for (const product of products) {
      const brand = /outdoor|garden|balcony|patio/.test(product.slug) ? outdoor : house;
      if (!brand) continue;
      await prisma.product.update({ where: { id: product.id }, data: { brandId: brand.id } });
      assigned += 1;
    }
  }

  log(
    'brands',
    `${BRANDS.length} brands ensured (${createdSlugs.size} created), ${assigned} products linked`,
  );
}
