import type { Prisma, ProductMedia } from '@prisma/client';

import { prisma } from '../config/prisma';

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
  ): Promise<ProductMedia | null> {
    return prisma.productMedia.findFirst({
      where: { productId, mediaId, attributeValueId, variantId },
    });
  },

  create(data: Prisma.ProductMediaUncheckedCreateInput): Promise<ProductMediaWithMedia> {
    return prisma.productMedia.create({ data, include: withMedia });
  },

  update(
    id: string,
    data: Prisma.ProductMediaUncheckedUpdateInput,
  ): Promise<ProductMediaWithMedia> {
    return prisma.productMedia.update({ where: { id }, data, include: withMedia });
  },

  delete(id: string): Promise<ProductMedia> {
    return prisma.productMedia.delete({ where: { id } });
  },

  /** Exactly one PRIMARY per product — every other row is demoted to GALLERY. */
  async demoteOtherPrimaries(productId: string, keepId: string): Promise<number> {
    const result = await prisma.productMedia.updateMany({
      where: { productId, role: 'PRIMARY', id: { not: keepId } },
      data: { role: 'GALLERY' },
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
};
