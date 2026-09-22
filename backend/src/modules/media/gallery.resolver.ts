import type { DeviceTarget, ImageFormat, MediaRole, RenditionLabel } from '@shared/enums';
import type { GalleryQuery } from '@shared/schemas/media';
import type { GalleryItemDto, GallerySourceDto, ProductGalleryDto } from '@shared/types/media';

import { storage } from '../../container';
import { productRepository } from '../../repositories/product.repository';
import {
  productMediaRepository,
  type ProductMediaWithMedia,
} from '../../repositories/productMedia.repository';
import { AppError } from '../../utils/AppError';

/**
 * THE gallery contract that Prompt 7's PDP and Prompt 13's UI consume.
 *
 * Specificity: a variant-specific image beats a colour (attribute value) specific one, which beats
 * the generic gallery. Within a tier, PRIMARY comes first, then HOVER, then `position`.
 * The result is deterministic — the tests assert the exact ordering.
 */

const ROLE_RANK: Record<string, number> = {
  PRIMARY: 0,
  HOVER: 1,
  GALLERY: 2,
  LIFESTYLE: 3,
  DIMENSION_SHEET: 4,
  THREE_SIXTY: 5,
  VIDEO: 6,
};

function specificity(row: ProductMediaWithMedia, query: GalleryQuery): number {
  if (query.variantId && row.variantId === query.variantId) return 0;
  if (query.attributeValueId && row.attributeValueId === query.attributeValueId) return 1;
  return 2;
}

/** Rows tied to a *different* variant or colour never appear in someone else's gallery. */
function isVisible(row: ProductMediaWithMedia, query: GalleryQuery): boolean {
  if (query.device && row.deviceTarget !== 'ALL' && row.deviceTarget !== query.device) return false;

  if (row.variantId && row.variantId !== query.variantId) return false;
  if (row.attributeValueId && row.attributeValueId !== query.attributeValueId) {
    // A colour-specific asset still shows when no colour was asked for and no variant was chosen.
    if (query.attributeValueId || query.variantId) return false;
  }

  return true;
}

function toSources(row: ProductMediaWithMedia, device?: DeviceTarget): GallerySourceDto[] {
  return row.media.variants
    .filter(
      (variant) => !device || variant.deviceTarget === 'ALL' || variant.deviceTarget === device,
    )
    .map((variant) => ({
      label: variant.label as RenditionLabel,
      format: variant.format as ImageFormat,
      url: storage.url(variant.path),
      width: variant.width,
      height: variant.height,
    }))
    .sort((a, b) => a.width - b.width || a.format.localeCompare(b.format));
}

function toItem(row: ProductMediaWithMedia, query: GalleryQuery): GalleryItemDto {
  return {
    mediaId: row.mediaId,
    productMediaId: row.id,
    role: row.role as MediaRole,
    position: row.position,
    alt: row.altText ?? row.media.altText,
    width: row.media.width,
    height: row.media.height,
    focalPoint:
      row.media.focalPointX === null || row.media.focalPointY === null
        ? null
        : { x: row.media.focalPointX, y: row.media.focalPointY },
    blurhash: row.media.blurhash,
    lqip: row.media.lqipDataUri,
    url: storage.url(row.media.path),
    deviceTarget: row.deviceTarget as DeviceTarget,
    attributeValueId: row.attributeValueId,
    variantId: row.variantId,
    sources: toSources(row, query.device),
  };
}

/** The sort and filter one product's rows go through, shared by the single and batched paths. */
function orderFor(rows: ProductMediaWithMedia[], query: GalleryQuery): GalleryItemDto[] {
  return rows
    .filter((row) => row.media.deletedAt === null && isVisible(row, query))
    .sort((a, b) => {
      const bySpecificity = specificity(a, query) - specificity(b, query);
      if (bySpecificity !== 0) return bySpecificity;

      const byRole = (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9);
      if (byRole !== 0) return byRole;

      return a.position - b.position;
    })
    .map((row) => toItem(row, query));
}

export const galleryResolver = {
  async resolveProductGallery(
    productId: string,
    query: GalleryQuery = {},
  ): Promise<GalleryItemDto[]> {
    return orderFor(await productMediaRepository.findForProduct(productId), query);
  },

  /**
   * Galleries for many products in ONE query.
   *
   * A cart or a product grid must not resolve a gallery per line: at ten lines that was thirty
   * queries (ProductMedia, Media, MediaVariant each time) for data a single `IN` clause returns.
   * The per-product `query` differs by variant, so filtering and sorting still happen per product
   * — but only the fetch was ever the expensive part.
   */
  async resolveManyProductGalleries(
    requests: { productId: string; query?: GalleryQuery }[],
  ): Promise<Map<string, GalleryItemDto[]>> {
    const result = new Map<string, GalleryItemDto[]>();
    if (requests.length === 0) return result;

    const rows = await productMediaRepository.findForProducts([
      ...new Set(requests.map((entry) => entry.productId)),
    ]);

    const byProduct = new Map<string, ProductMediaWithMedia[]>();
    for (const row of rows) {
      const list = byProduct.get(row.productId) ?? [];
      list.push(row);
      byProduct.set(row.productId, list);
    }

    for (const entry of requests) {
      result.set(
        `${entry.productId}:${entry.query?.variantId ?? ''}`,
        orderFor(byProduct.get(entry.productId) ?? [], entry.query ?? {}),
      );
    }

    return result;
  },

  async resolveBySlug(slug: string, query: GalleryQuery = {}): Promise<ProductGalleryDto> {
    const product = await productRepository.findBySlug(slug);
    if (!product) throw AppError.notFound(`Product "${slug}" not found`, { slug });

    return {
      productId: product.id,
      slug: product.slug,
      items: await this.resolveProductGallery(product.id, query),
    };
  },
};
