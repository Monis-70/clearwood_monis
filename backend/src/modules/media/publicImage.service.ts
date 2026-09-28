import type { PublicImageDto } from '@shared/types/storefront';

import { env } from '../../config/env';
import { cache, storage } from '../../container';
import type { CmsMediaRow } from '../../repositories/cms.repository';
import { mediaRepository, type PublicImageRow } from '../../repositories/media.repository';
import type { ProductCardRow } from '../../repositories/storefront.repository';
import { requestScope } from '../../utils/requestScope';
import { CATALOG_CACHE_PREFIXES } from '../catalog-admin/catalogCache.service';

/**
 * THE resolver for media a public payload references by id (PROJECT_CONTEXT §51).
 *
 * The storefront never builds a URL from a key or an id, so every image it shows must arrive
 * resolved: this turns ids into `PublicImageDto` (the card image shape) with URLs from the storage
 * driver. A payload collects every id it references and resolves them in ONE statement; an id that
 * is unset, or points at a deleted or not-READY asset, resolves to null.
 */

interface ResolvedMedia {
  id: string;
  path: string;
  width: number | null;
  height: number | null;
  altText: string | null;
  blurhash: string | null;
  lqipDataUri: string | null;
  dominantColorHex: string | null;
  focalPointX: number | null;
  focalPointY: number | null;
  variants: { label: string; format: string; path: string; width: number; height: number }[];
}

/** Images keyed by media id, each narrowed to the renditions its slot carries. */
export interface PublicImages {
  get(id: string | null | undefined, labels: readonly string[]): PublicImageDto | null;
}

/** Swatch images by media id, as cached (plain JSON). */
export type SwatchImages = Record<string, PublicImageDto>;

export function swatchImageOf(
  images: SwatchImages,
  mediaId: string | null | undefined,
): PublicImageDto | null {
  return mediaId && Object.hasOwn(images, mediaId) ? images[mediaId]! : null;
}

export interface ImageRequest {
  ids: Iterable<string | null | undefined>;
  labels: readonly string[];
}

const SWATCH_LABELS = ['THUMB'] as const;

// A function, not a constant: catalogCache.service is mid-load when this module is first imported.
const swatchKey = () => `${CATALOG_CACHE_PREFIXES.attributeSwatches}all`;

function toImage(media: ResolvedMedia, labels: readonly string[]): PublicImageDto {
  return {
    mediaId: media.id,
    url: storage.url(media.path),
    alt: media.altText ?? '',
    width: media.width,
    height: media.height,
    blurhash: media.blurhash,
    lqip: media.lqipDataUri,
    dominantColorHex: media.dominantColorHex,
    focalPoint:
      media.focalPointX === null || media.focalPointY === null
        ? null
        : { x: media.focalPointX, y: media.focalPointY },
    sources: media.variants
      .filter((variant) => labels.includes(variant.label))
      .map((variant) => ({
        label: variant.label,
        format: variant.format,
        url: storage.url(variant.path),
        width: variant.width,
        height: variant.height,
      }))
      .sort((a, b) => a.width - b.width || a.format.localeCompare(b.format)),
  };
}

function fromRows(rows: PublicImageRow[]): Map<string, ResolvedMedia> {
  const byId = new Map<string, ResolvedMedia>();

  for (const row of rows) {
    let media = byId.get(row.id);
    if (!media) {
      media = { ...row, variants: [] };
      byId.set(row.id, media);
    }
    if (row.variantLabel && row.variantFormat && row.variantPath) {
      media.variants.push({
        label: row.variantLabel,
        format: row.variantFormat,
        path: row.variantPath,
        width: row.variantWidth ?? 0,
        height: row.variantHeight ?? 0,
      });
    }
  }
  return byId;
}

function resolver(byId: Map<string, ResolvedMedia>): PublicImages {
  return {
    get(id, labels) {
      const media = id ? byId.get(id) : undefined;
      return media ? toImage(media, labels) : null;
    },
  };
}

function idsOf(requests: ImageRequest[]): string[] {
  const ids = new Set<string>();
  for (const request of requests) {
    for (const id of request.ids) if (id) ids.add(id);
  }
  return [...ids];
}

function labelsOf(requests: ImageRequest[]): string[] {
  return [...new Set(requests.flatMap((request) => [...request.labels]))];
}

function swatchMap(media: Iterable<ResolvedMedia>): SwatchImages {
  return Object.fromEntries([...media].map((entry) => [entry.id, toImage(entry, SWATCH_LABELS)]));
}

export const publicImageService = {
  /** Resolves nothing: for a caller that resolves its own renditions elsewhere. */
  none: resolver(new Map()),

  /** Every id of every request in one statement; none at all when there is no id. */
  async load(requests: ImageRequest[]): Promise<PublicImages> {
    const ids = idsOf(requests);
    if (ids.length === 0) return resolver(new Map());

    return resolver(fromRows(await mediaRepository.findPublicImages(ids, labelsOf(requests))));
  },

  /**
   * `load` for a payload that also shows swatches (a category landing, a collection page). While
   * the shared swatch map is cold it is read in the SAME statement, so the payload still adds one
   * (§51). Call it before starting the work that shows swatches, which then joins this map.
   */
  async loadWithSwatches(requests: ImageRequest[]): Promise<PublicImages> {
    const ids = idsOf(requests);
    if (ids.length === 0) return resolver(new Map());

    const read: { own?: Map<string, ResolvedMedia> } = {};
    const key = swatchKey();
    await requestScope.once(key, () =>
      cache.wrap(key, env.CATALOG_CACHE_TTL_SECONDS, async () => {
        const labels = [...new Set([...labelsOf(requests), ...SWATCH_LABELS])];
        const rows = await mediaRepository.findPublicAndSwatchImages(ids, labels);
        const wanted = new Set(ids);
        read.own = fromRows(rows.filter((row) => wanted.has(row.id)));
        return swatchMap(fromRows(rows.filter((row) => Number(row.isSwatch) === 1)).values());
      }),
    );

    // The map was warm, or another caller is already reading it: the payload's own statement.
    return read.own ? resolver(read.own) : this.load(requests);
  },

  /**
   * The same images from media rows the CMS renderer already loaded (its one media query), so a
   * page resolves banners and store photos without a statement of its own.
   */
  fromCmsRows(rows: CmsMediaRow[]): PublicImages {
    return resolver(
      new Map(
        rows
          .filter((row) => row.status === 'READY')
          .map((row) => [row.id, { ...row, variants: row.variants }]),
      ),
    );
  },

  /**
   * Every swatch image, keyed by media id. Swatches are attribute-value configuration that the
   * grid, the facets and the option matrix all show, so they share one cached map: one statement
   * when cold, joined by every payload of the request.
   */
  swatches(): Promise<SwatchImages> {
    const key = swatchKey();
    return requestScope.once(key, () =>
      cache.wrap(key, env.CATALOG_CACHE_TTL_SECONDS, async () =>
        swatchMap(fromRows(await mediaRepository.findSwatchImages(SWATCH_LABELS)).values()),
      ),
    );
  },

  /** The swatch map, or an empty one without touching the cache when no id needs it. */
  async swatchesFor(mediaIds: Iterable<string | null | undefined>): Promise<SwatchImages> {
    for (const id of mediaIds) if (id) return this.swatches();
    return {};
  },

  /** The swatch images the cards built from these rows can show. */
  swatchesForCards(rows: ProductCardRow[]): Promise<SwatchImages> {
    return this.swatchesFor(
      rows.flatMap((row) =>
        row.variants.flatMap((variant) =>
          variant.attributeValues
            .filter((link) => link.attribute.showInSwatch)
            .map((link) => link.attributeValue.swatchMediaId),
        ),
      ),
    );
  },
};
