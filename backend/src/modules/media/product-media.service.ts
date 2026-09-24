import type { DeviceTarget, MediaRole } from '@shared/enums';
import type {
  ProductMediaAttachInput,
  ProductMediaReorderInput,
  ProductMediaUpdateInput,
} from '@shared/schemas/media';
import type { ProductMediaItemDto } from '@shared/types/media';

import { prisma } from '../../config/prisma';
import { mediaRepository } from '../../repositories/media.repository';
import { productRepository } from '../../repositories/product.repository';
import {
  productMediaRepository,
  type ProductMediaWithMedia,
} from '../../repositories/productMedia.repository';
import { AppError } from '../../utils/AppError';
import { mark } from '../../utils/uniqueMark';
import { catalogCacheService } from '../catalog-admin/catalogCache.service';
import { productAdminService } from '../catalog-admin/product.admin.service';

import { toMediaDto } from './media.service';
import { mediaUsageService, type UsageRef } from './media-usage.service';

/**
 * Product gallery membership. Every attach/detach also writes a MediaUsage row, which is what makes
 * a hard delete safe. Exactly one PRIMARY per product is enforced here, not hoped for.
 */

function toDto(row: ProductMediaWithMedia): ProductMediaItemDto {
  return {
    id: row.id,
    mediaId: row.mediaId,
    role: row.role as MediaRole,
    position: row.position,
    altText: row.altText,
    deviceTarget: row.deviceTarget as DeviceTarget,
    attributeValueId: row.attributeValueId,
    variantId: row.variantId,
    media: toMediaDto(row.media),
  };
}

/** The attribute value must belong to an attribute the product actually uses. */
async function assertAttributeValueBelongs(
  productId: string,
  attributeValueId: string,
): Promise<void> {
  const value = await prisma.attributeValue.findUnique({
    where: { id: attributeValueId },
    select: { id: true, attributeId: true },
  });
  if (!value) throw AppError.validation('Unknown attribute value', { attributeValueId });

  const [onProduct, onVariant] = await Promise.all([
    prisma.productAttributeValue.count({ where: { productId, attributeId: value.attributeId } }),
    prisma.variantAttributeValue.count({
      where: { attributeId: value.attributeId, variant: { productId } },
    }),
  ]);

  if (onProduct + onVariant === 0) {
    throw AppError.validation('That attribute is not used by this product', {
      attributeValueId,
      attributeId: value.attributeId,
    });
  }
}

async function assertVariantBelongs(productId: string, variantId: string): Promise<void> {
  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    select: { productId: true },
  });

  if (!variant || variant.productId !== productId) {
    throw AppError.validation('That variant belongs to a different product', { variantId });
  }
}

export const productMediaService = {
  async list(productId: string): Promise<ProductMediaItemDto[]> {
    const rows = await productMediaRepository.findForProduct(productId);
    return rows.map(toDto);
  },

  async attach(productId: string, input: ProductMediaAttachInput): Promise<ProductMediaItemDto[]> {
    const product = await prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });
    if (!product) throw AppError.notFound('Product not found', { productId });

    let nextPosition = await productMediaRepository.maxPosition(productId);
    const attached: ProductMediaItemDto[] = [];

    for (const item of input.items) {
      const media = await mediaRepository.findById(item.mediaId);
      if (!media) throw AppError.notFound('Media not found', { mediaId: item.mediaId });

      if (item.attributeValueId)
        await assertAttributeValueBelongs(productId, item.attributeValueId);
      if (item.variantId) await assertVariantBelongs(productId, item.variantId);

      nextPosition += 1;
      const isPrimary = item.role === 'PRIMARY';
      const row = await productRepository.withProductLock(productId, async (tx) => {
        const existing = await productMediaRepository.findExisting(
          productId,
          item.mediaId,
          item.attributeValueId ?? null,
          item.variantId ?? null,
          tx,
        );
        if (existing) {
          throw AppError.conflict('That image is already attached to this product', {
            mediaId: item.mediaId,
          });
        }

        if (isPrimary) await productMediaRepository.demoteOtherPrimaries(productId, null, tx);
        return productMediaRepository.create(
          {
            productId,
            mediaId: item.mediaId,
            role: item.role,
            primaryMark: mark(isPrimary),
            position: item.position ?? nextPosition,
            altText: item.altText ?? media.altText ?? null,
            deviceTarget: item.deviceTarget,
            attributeValueId: item.attributeValueId ?? null,
            variantId: item.variantId ?? null,
          },
          tx,
        );
      });

      await mediaUsageService.attach({
        mediaId: item.mediaId,
        usageType: item.variantId ? 'PRODUCT_VARIANT' : 'PRODUCT',
        entityId: item.variantId ?? productId,
        field: 'gallery',
      });

      attached.push(toDto(row));
    }

    await invalidateGallery(productId);
    return attached;
  },

  async update(
    productId: string,
    id: string,
    input: ProductMediaUpdateInput,
  ): Promise<ProductMediaItemDto> {
    const existing = await productMediaRepository.findById(id);
    if (!existing || existing.productId !== productId) {
      throw AppError.notFound('Gallery item not found', { id });
    }

    if (input.attributeValueId)
      await assertAttributeValueBelongs(productId, input.attributeValueId);
    if (input.variantId) await assertVariantBelongs(productId, input.variantId);

    const row = await productRepository.withProductLock(productId, async (tx) => {
      if (input.role === 'PRIMARY') {
        await productMediaRepository.demoteOtherPrimaries(productId, id, tx);
      }
      return productMediaRepository.update(
        id,
        {
          ...(input.role === undefined
            ? {}
            : { role: input.role, primaryMark: mark(input.role === 'PRIMARY') }),
          ...(input.altText === undefined ? {} : { altText: input.altText ?? null }),
          ...(input.deviceTarget === undefined ? {} : { deviceTarget: input.deviceTarget }),
          ...(input.attributeValueId === undefined
            ? {}
            : { attributeValueId: input.attributeValueId ?? null }),
          ...(input.variantId === undefined ? {} : { variantId: input.variantId ?? null }),
        },
        tx,
      );
    });

    // Moved between the product and a variant: the usage ledger follows, or a hard delete of
    // the asset would be judged against the wrong owner.
    if (row.variantId !== existing.variantId) {
      await mediaUsageService.attach(galleryUsage(productId, row.mediaId, row.variantId));
      await detachIfUnused(productId, existing.mediaId, existing.variantId);
    }

    await invalidateGallery(productId);
    return toDto(row);
  },

  async reorder(
    productId: string,
    input: ProductMediaReorderInput,
  ): Promise<ProductMediaItemDto[]> {
    for (const item of input.items) {
      const row = await productMediaRepository.findById(item.id);
      if (!row || row.productId !== productId) {
        throw AppError.notFound('Gallery item not found', { id: item.id });
      }
      await productMediaRepository.setPosition(item.id, item.position);
    }

    await invalidateGallery(productId);
    return this.list(productId);
  },

  async detach(productId: string, id: string): Promise<void> {
    const existing = await productMediaRepository.findById(id);
    if (!existing || existing.productId !== productId) {
      throw AppError.notFound('Gallery item not found', { id });
    }

    await productMediaRepository.delete(id);

    // Only drop the usage row when nothing else on this product still points at the asset.
    const remaining = await prisma.productMedia.count({
      where: { productId, mediaId: existing.mediaId },
    });
    if (remaining === 0) {
      await mediaUsageService.detach({
        mediaId: existing.mediaId,
        usageType: existing.variantId ? 'PRODUCT_VARIANT' : 'PRODUCT',
        entityId: existing.variantId ?? productId,
        field: 'gallery',
      });
    }

    await invalidateGallery(productId);
  },
};

/** Who owns a gallery row in the usage ledger: its variant, or the product itself. */
function galleryUsage(productId: string, mediaId: string, variantId: string | null): UsageRef {
  return {
    mediaId,
    usageType: variantId ? 'PRODUCT_VARIANT' : 'PRODUCT',
    entityId: variantId ?? productId,
    field: 'gallery',
  };
}

/** Drops an owner's usage row once none of its gallery rows shows the asset any more. */
async function detachIfUnused(
  productId: string,
  mediaId: string,
  variantId: string | null,
): Promise<void> {
  const remaining = await prisma.productMedia.count({ where: { productId, mediaId, variantId } });
  if (remaining === 0) await mediaUsageService.detach(galleryUsage(productId, mediaId, variantId));
}

/**
 * A gallery change touches that product's pages and the card payloads, nothing else - and its
 * stored completeness score, which counts the primary image and the gallery.
 */
async function invalidateGallery(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { slug: true },
  });
  if (!product) return;
  await productAdminService.refreshCompleteness(productId);
  await catalogCacheService.invalidateProductMedia(product.slug);
}
