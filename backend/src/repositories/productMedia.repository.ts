import type { Prisma, ProductMedia } from '@prisma/client';

import { prisma } from '../config/prisma';

type Client = Prisma.TransactionClient | typeof prisma;

const withMedia = {
  media: { include: { variants: { orderBy: [{ width: 'asc' as const }] } } },
} satisfies Prisma.ProductMediaInclude;

export type ProductMediaWithMedia = Prisma.ProductMediaGetPayload<{ include: typeof withMedia }>;

export const productMediaRepository = {
  findById(id: string): Promise<ProductMediaWithMedia | null> {
    return prisma.productMedia.findUnique({ where: { id }, include: withMedia });
  },

  findForProduct(productId: string): Promise<ProductMediaWithMedia[]> {
    return prisma.productMedia.findMany({
      where: { productId },
      include: withMedia,
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  },

  /** Several products in ONE query, so a cart or a grid does not resolve galleries per line. */
  findForProducts(productIds: string[]): Promise<ProductMediaWithMedia[]> {
    if (productIds.length === 0) return Promise.resolve([]);

    return prisma.productMedia.findMany({
      where: { productId: { in: productIds } },
      include: withMedia,
      orderBy: [{ productId: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
    });
  },

  findExisting(
    productId: string,
    mediaId: string,
    attributeValueId: string | null,
    variantId: string | null,
    client: Client = prisma,
  ): Promise<ProductMedia | null> {
    return client.productMedia.findFirst({
      where: { productId, mediaId, attributeValueId, variantId },
    });
  },

  create(
    data: Prisma.ProductMediaUncheckedCreateInput,
    client: Client = prisma,
  ): Promise<ProductMediaWithMedia> {
    return client.productMedia.create({ data, include: withMedia });
  },

  update(
    id: string,
    data: Prisma.ProductMediaUncheckedUpdateInput,
    client: Client = prisma,
  ): Promise<ProductMediaWithMedia> {
    return client.productMedia.update({ where: { id }, data, include: withMedia });
  },

  delete(id: string): Promise<ProductMedia> {
    return prisma.productMedia.delete({ where: { id } });
  },

  /** At most one PRIMARY per product: the current one becomes GALLERY before another is set. */
  async demoteOtherPrimaries(
    productId: string,
    keepId: string | null,
    client: Client = prisma,
  ): Promise<number> {
    const result = await client.productMedia.updateMany({
      where: { productId, primaryMark: true, ...(keepId ? { id: { not: keepId } } : {}) },
      data: { role: 'GALLERY', primaryMark: null },
    });
    return result.count;
  },

  async maxPosition(productId: string): Promise<number> {
    const row = await prisma.productMedia.aggregate({
      where: { productId },
      _max: { position: true },
    });
    return row._max.position ?? 0;
  },

  setPosition(id: string, position: number): Promise<ProductMedia> {
    return prisma.productMedia.update({ where: { id }, data: { position } });
  },

  countForProduct(productId: string): Promise<number> {
    return prisma.productMedia.count({ where: { productId } });
  },

  /** Slugs of the products whose galleries use any of these assets. */
  async productSlugsForMedia(mediaIds: string[]): Promise<string[]> {
    if (mediaIds.length === 0) return [];

    const rows = await prisma.product.findMany({
      where: { media: { some: { mediaId: { in: mediaIds } } } },
      select: { slug: true },
    });
    return rows.map((row) => row.slug);
  },
};
