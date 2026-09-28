import { Prisma, type Media, type MediaVariant } from '@prisma/client';

import type { MediaListQuery } from '@shared/schemas/media';

import { prisma } from '../config/prisma';

import { notDeleted, orderBy, pageResult, skipTake, type PageResult } from './helpers';

const SORTABLE = ['originalName', 'sizeBytes', 'usageCount', 'createdAt', 'updatedAt'] as const;

/** One media row per requested rendition (or one with null variant columns when it has none). */
export interface PublicImageRow {
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
  variantLabel: string | null;
  variantFormat: string | null;
  variantPath: string | null;
  variantWidth: number | null;
  variantHeight: number | null;
}

/** A public image row that also says whether an attribute value shows it as a swatch (1 or 0). */
export interface FlaggedImageRow extends PublicImageRow {
  isSwatch: number | bigint | boolean;
}

export interface MediaReferences {
  category: boolean;
  navigation: boolean;
  swatch: boolean;
}

/** Every media id an attribute value shows as its swatch. */
const SWATCH_MEDIA_IDS = Prisma.sql`SELECT av.swatchMediaId FROM AttributeValue av
  WHERE av.swatchMediaId IS NOT NULL AND av.deletedAt IS NULL`;

/** Live, READY media and only the requested renditions, in ONE statement (PROJECT_CONTEXT §51). */
function publicImages<Row extends PublicImageRow>(
  scope: Prisma.Sql,
  labels: readonly string[],
  extraColumns: Prisma.Sql = Prisma.empty,
): Promise<Row[]> {
  return prisma.$queryRaw<Row[]>`
    SELECT m.id, m.path, m.width, m.height, m.altText, m.blurhash, m.lqipDataUri,
           m.dominantColorHex, m.focalPointX, m.focalPointY,
           v.label AS variantLabel, v.format AS variantFormat, v.path AS variantPath,
           v.width AS variantWidth, v.height AS variantHeight${extraColumns}
    FROM Media m
    LEFT JOIN MediaVariant v ON v.mediaId = m.id AND v.label IN (${Prisma.join([...labels])})
    WHERE m.deletedAt IS NULL AND m.status = 'READY' AND ${scope}
    ORDER BY m.id, v.width, v.format`;
}

const withVariants = {
  variants: { orderBy: [{ width: 'asc' as const }] },
} satisfies Prisma.MediaInclude;

const withDetail = {
  variants: { orderBy: [{ width: 'asc' as const }] },
  usages: { orderBy: [{ createdAt: 'asc' as const }] },
  folderRef: { select: { id: true, path: true } },
} satisfies Prisma.MediaInclude;

export type MediaWithVariants = Prisma.MediaGetPayload<{ include: typeof withVariants }>;
export type MediaWithDetail = Prisma.MediaGetPayload<{ include: typeof withDetail }>;

export interface MediaFilter {
  kind?: string;
  folder?: string;
  ids?: string[];
}

function where(query: Partial<MediaListQuery> = {}): Prisma.MediaWhereInput {
  return {
    ...(query.includeDeleted ? {} : notDeleted),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.folderId ? { folderId: query.folderId } : {}),
    ...(query.folderPath ? { folderRef: { path: { startsWith: query.folderPath } } } : {}),
    ...(query.tag ? { tagsJson: { contains: `"${query.tag}"` } } : {}),
    ...(query.unusedOnly ? { usageCount: 0 } : {}),
    ...(query.search
      ? {
          OR: [
            { originalName: { contains: query.search } },
            { altText: { contains: query.search } },
            { title: { contains: query.search } },
          ],
        }
      : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
  };
}

export const mediaRepository = {
  findById(id: string, includeDeleted = false): Promise<MediaWithVariants | null> {
    return prisma.media.findFirst({
      where: { id, ...(includeDeleted ? {} : notDeleted) },
      include: withVariants,
    });
  },

  findDetail(id: string, includeDeleted = false): Promise<MediaWithDetail | null> {
    return prisma.media.findFirst({
      where: { id, ...(includeDeleted ? {} : notDeleted) },
      include: withDetail,
    });
  },

  findManyByIds(ids: string[]): Promise<MediaWithVariants[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.media.findMany({
      where: { id: { in: ids }, ...notDeleted },
      include: withVariants,
    });
  },

  findByPath(disk: string, path: string): Promise<Media | null> {
    return prisma.media.findFirst({ where: { disk, path } });
  },

  /** De-duplication: the same bytes are only ever stored once. */
  findByChecksum(checksum: string): Promise<MediaWithVariants | null> {
    return prisma.media.findFirst({
      where: { checksumSha256: checksum, ...notDeleted },
      include: withVariants,
    });
  },

  async list(query: MediaListQuery): Promise<PageResult<MediaWithVariants>> {
    const args = { where: where(query) };
    const [items, total] = await Promise.all([
      prisma.media.findMany({
        ...args,
        ...skipTake(query),
        include: withVariants,
        orderBy: orderBy(query.sort, query.order, SORTABLE, [{ createdAt: 'desc' }]),
      }),
      prisma.media.count(args),
    ]);
    return pageResult(items, total, query);
  },

  create(data: Prisma.MediaUncheckedCreateInput): Promise<MediaWithVariants> {
    return prisma.media.create({ data, include: withVariants });
  },

  update(id: string, data: Prisma.MediaUncheckedUpdateInput): Promise<MediaWithVariants> {
    return prisma.media.update({ where: { id }, data, include: withVariants });
  },

  softDelete(id: string): Promise<Media> {
    return prisma.media.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  restore(id: string): Promise<Media> {
    return prisma.media.update({ where: { id }, data: { deletedAt: null } });
  },

  hardDelete(id: string): Promise<Media> {
    return prisma.media.delete({ where: { id } });
  },

  setUsageCount(id: string, usageCount: number): Promise<Media> {
    return prisma.media.update({ where: { id }, data: { usageCount } });
  },

  /* ------------------------------------------------------------ variants */

  async replaceVariants(
    mediaId: string,
    variants: Omit<Prisma.MediaVariantUncheckedCreateInput, 'mediaId'>[],
  ): Promise<void> {
    await prisma.mediaVariant.deleteMany({ where: { mediaId } });
    if (variants.length > 0) {
      await prisma.mediaVariant.createMany({
        data: variants.map((variant) => ({ ...variant, mediaId })),
      });
    }
  },

  findVariants(mediaId: string): Promise<MediaVariant[]> {
    return prisma.mediaVariant.findMany({ where: { mediaId }, orderBy: [{ width: 'asc' }] });
  },

  countVariants(): Promise<number> {
    return prisma.mediaVariant.count();
  },

  /* ------------------------------------------------------- public images */

  findPublicImages(ids: string[], labels: readonly string[]): Promise<PublicImageRow[]> {
    if (ids.length === 0 || labels.length === 0) return Promise.resolve([]);
    return publicImages(Prisma.sql`m.id IN (${Prisma.join(ids)})`, labels);
  },

  /** Every image an attribute value uses as its swatch. */
  findSwatchImages(labels: readonly string[]): Promise<PublicImageRow[]> {
    return publicImages(Prisma.sql`m.id IN (${SWATCH_MEDIA_IDS})`, labels);
  },

  /**
   * `findPublicImages` and `findSwatchImages` in ONE statement, for a payload that needs its own
   * images while the shared swatch map is cold. `isSwatch` tells the swatch rows apart.
   */
  findPublicAndSwatchImages(ids: string[], labels: readonly string[]): Promise<FlaggedImageRow[]> {
    if (ids.length === 0 || labels.length === 0) return Promise.resolve([]);
    return publicImages<FlaggedImageRow>(
      Prisma.sql`(m.id IN (${Prisma.join(ids)}) OR m.id IN (${SWATCH_MEDIA_IDS}))`,
      labels,
      Prisma.sql`, m.id IN (${SWATCH_MEDIA_IDS}) AS isSwatch`,
    );
  },

  /**
   * Which cached, id-only references resolve these media (§51), so a media write drops exactly
   * their payloads. Collections, banners, stores and testimonials are read live, or inside CMS
   * pages, which every media write drops.
   */
  async findReferences(mediaIds: string[]): Promise<MediaReferences> {
    if (mediaIds.length === 0) return { category: false, navigation: false, swatch: false };
    const ids = { in: mediaIds };
    const select = { id: true } as const;

    const [category, navigation, swatch] = await Promise.all([
      prisma.category.findFirst({
        where: { OR: [{ iconMediaId: ids }, { bannerMediaId: ids }, { mobileBannerMediaId: ids }] },
        select,
      }),
      prisma.navigationItem.findFirst({ where: { iconMediaId: ids }, select }),
      prisma.attributeValue.findFirst({ where: { swatchMediaId: ids }, select }),
    ]);

    return {
      category: category !== null,
      navigation: navigation !== null,
      swatch: swatch !== null,
    };
  },

  /* -------------------------------------------------------- housekeeping */

  allPaths(): Promise<{ id: string; path: string }[]> {
    return prisma.media.findMany({ select: { id: true, path: true } });
  },

  allVariantPaths(): Promise<{ id: string; path: string }[]> {
    return prisma.mediaVariant.findMany({ select: { id: true, path: true } });
  },

  count(filter: MediaFilter = {}): Promise<number> {
    return prisma.media.count({
      where: {
        ...notDeleted,
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.folder ? { folder: filter.folder } : {}),
        ...(filter.ids ? { id: { in: filter.ids } } : {}),
      },
    });
  },
};
