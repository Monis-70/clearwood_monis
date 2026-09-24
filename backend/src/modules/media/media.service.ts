import type { Media } from '@prisma/client';

import { RENDITION_PRESETS } from '@shared/constants';
import type {
  DeviceTarget,
  ImageFormat,
  MediaKind,
  MediaSource,
  MediaStatus,
  RenditionLabel,
} from '@shared/enums';
import type { MediaListQuery, MediaUpdateInput } from '@shared/schemas/media';
import type {
  MediaAssetDto,
  MediaConfigDto,
  MediaDetailDto,
  MediaGarbageReportDto,
  MediaUploadResultDto,
  MediaVariantDto,
} from '@shared/types/media';

import { avifEnabled, env } from '../../config/env';
import { logger } from '../../config/logger';
import { storage } from '../../container';
import { buildStorageKey, sha256 } from '../../drivers/storage';
import type { PageResult } from '../../repositories/helpers';
import {
  mediaRepository,
  type MediaWithDetail,
  type MediaWithVariants,
} from '../../repositories/media.repository';
import { productMediaRepository } from '../../repositories/productMedia.repository';
import { AppError } from '../../utils/AppError';
import { jsonColumn } from '../../utils/jsonColumn';
import { catalogCacheService } from '../catalog-admin/catalogCache.service';

import { imageProcessor, supportsRenditions } from './image.processor';
import { mediaFolderService } from './mediaFolder.service';
import { mediaUsageService } from './media-usage.service';
import { validateUpload } from './upload.validator';

const tagsColumn = jsonColumn<string[]>(undefined, 'Media.tagsJson');

async function invalidateUsersOf(mediaIds: string[]): Promise<void> {
  await catalogCacheService.invalidateMedia(
    await productMediaRepository.productSlugsForMedia(mediaIds),
  );
}

export interface UploadInput {
  buffer: Buffer;
  originalName: string;
  declaredMimeType?: string;
  folderId?: string;
  folderPath?: string;
  altText?: string;
  title?: string;
  tags?: string[];
  source?: MediaSource;
  uploadedByType?: string | null;
  uploadedById?: string | null;
}

function toVariantDto(variant: MediaWithVariants['variants'][number]): MediaVariantDto {
  return {
    id: variant.id,
    label: variant.label as RenditionLabel,
    format: variant.format as ImageFormat,
    url: storage.url(variant.path),
    width: variant.width,
    height: variant.height,
    sizeBytes: variant.sizeBytes,
    isDefault: variant.isDefault,
    deviceTarget: variant.deviceTarget as DeviceTarget,
  };
}

export function toMediaDto(
  media: MediaWithVariants,
  folderPath: string | null = null,
): MediaAssetDto {
  return {
    id: media.id,
    kind: media.kind as MediaKind,
    status: media.status as MediaStatus,
    source: media.source as MediaSource,
    disk: media.disk,
    path: media.path,
    url: storage.url(media.path),
    mimeType: media.mimeType,
    originalName: media.originalName,
    sizeBytes: media.sizeBytes,
    width: media.width,
    height: media.height,
    durationSec: media.durationSec,
    altText: media.altText,
    title: media.title,
    tags: tagsColumn.parse(media.tagsJson, []),
    folderId: media.folderId,
    folderPath,
    checksumSha256: media.checksumSha256,
    dominantColorHex: media.dominantColorHex,
    blurhash: media.blurhash,
    lqipDataUri: media.lqipDataUri,
    focalPoint:
      media.focalPointX === null || media.focalPointY === null
        ? null
        : { x: media.focalPointX, y: media.focalPointY },
    isOptimized: media.isOptimized,
    processingError: media.processingError,
    usageCount: media.usageCount,
    createdAt: media.createdAt.toISOString(),
    updatedAt: media.updatedAt.toISOString(),
    deletedAt: media.deletedAt?.toISOString() ?? null,
    variants: media.variants.map(toVariantDto),
  };
}

function toDetailDto(media: MediaWithDetail): MediaDetailDto {
  return {
    ...toMediaDto(media as unknown as MediaWithVariants, media.folderRef?.path ?? null),
    usage: media.usages.map((usage) => ({
      id: usage.id,
      usageType: usage.usageType as MediaDetailDto['usage'][number]['usageType'],
      entityId: usage.entityId,
      field: usage.field,
      createdAt: usage.createdAt.toISOString(),
    })),
  };
}

/** Stores the original plus every rendition, updating the row as it goes. */
async function storeAsset(
  mediaId: string,
  input: {
    buffer: Buffer;
    mimeType: string;
    kind: MediaKind;
    fileName: string;
    folderPath: string;
  },
): Promise<{ path: string; sizeBytes: number; width: number | null; height: number | null }> {
  const original = await imageProcessor.prepareOriginal(input.buffer, input.mimeType);

  const key = buildStorageKey({
    id: mediaId,
    folderPath: input.folderPath,
    originalName: input.fileName,
    mimeType: input.mimeType,
  });

  const stored = await storage.put(key, original.buffer, {
    contentType: input.mimeType,
    cacheControl: 'public, max-age=31536000, immutable',
  });

  await mediaRepository.update(mediaId, {
    path: stored.key,
    url: stored.url,
    sizeBytes: stored.size,
    width: original.width || null,
    height: original.height || null,
    dominantColorHex: original.dominantColorHex,
    blurhash: original.blurhash,
    lqipDataUri: original.lqipDataUri,
  });

  // A rendition failure must never lose the original: the asset is marked FAILED and kept.
  try {
    const renditions = await imageProcessor.buildRenditions(original, input.mimeType);
    const variants = [];

    for (const rendition of renditions) {
      const renditionKey = buildStorageKey({
        id: mediaId,
        folderPath: input.folderPath,
        originalName: input.fileName,
        mimeType: input.mimeType,
        label: rendition.label,
        extension: rendition.extension,
      });

      const put = await storage.put(renditionKey, rendition.buffer, {
        contentType: `image/${rendition.extension === 'jpg' ? 'jpeg' : rendition.extension}`,
        cacheControl: 'public, max-age=31536000, immutable',
      });

      variants.push({
        label: rendition.label,
        path: put.key,
        width: rendition.width,
        height: rendition.height,
        sizeBytes: put.size,
        format: rendition.format,
        isDefault: rendition.isDefault,
        deviceTarget: rendition.deviceTarget,
      });
    }

    await mediaRepository.replaceVariants(mediaId, variants);
    await mediaRepository.update(mediaId, {
      status: 'READY',
      isOptimized: supportsRenditions(input.mimeType),
      processingError: null,
    });
  } catch (error) {
    logger.error({ err: error, mediaId }, 'rendition pipeline failed — original retained');
    await mediaRepository.update(mediaId, {
      status: 'FAILED',
      processingError: error instanceof Error ? error.message : 'rendition pipeline failed',
    });
  }

  return {
    path: stored.key,
    sizeBytes: stored.size,
    width: original.width || null,
    height: original.height || null,
  };
}

export const mediaService = {
  toMediaDto,

  config(): MediaConfigDto {
    return {
      maxUploadSizeMb: env.MAX_UPLOAD_SIZE_MB,
      maxUploadFiles: env.MAX_UPLOAD_FILES,
      maxImageDimension: env.MAX_IMAGE_DIMENSION,
      allowedImageMime: env.ALLOWED_IMAGE_MIME,
      allowedVideoMime: env.ALLOWED_VIDEO_MIME,
      allowedDocMime: env.ALLOWED_DOC_MIME,
      renditions: RENDITION_PRESETS.map((preset) => ({ ...preset })),
      avifEnabled,
      driver: storage.name,
      presignSupported: storage.supportsPresignedUpload,
    };
  },

  async upload(input: UploadInput): Promise<MediaUploadResultDto> {
    const validated = await validateUpload({
      buffer: input.buffer,
      originalName: input.originalName,
      ...(input.declaredMimeType ? { declaredMimeType: input.declaredMimeType } : {}),
    });

    const checksum = sha256(validated.buffer);
    const existing = await mediaRepository.findByChecksum(checksum);
    if (existing) {
      return { media: toMediaDto(existing), deduplicated: true };
    }

    const folder = input.folderId
      ? await mediaFolderService.get(input.folderId)
      : await mediaFolderService.resolveByPath(input.folderPath ?? 'uploads');

    const created = await mediaRepository.create({
      disk: storage.name,
      // Replaced with the real key as soon as the asset is stored under its own id.
      path: `pending/${checksum}`,
      kind: validated.kind,
      status: 'PROCESSING',
      source: input.source ?? 'ADMIN_UPLOAD',
      mimeType: validated.mimeType,
      originalName: validated.fileName,
      sizeBytes: validated.sizeBytes,
      checksum,
      checksumSha256: checksum,
      altText: input.altText ?? null,
      title: input.title ?? null,
      tagsJson: tagsColumn.serialize(input.tags ?? []),
      folder: folder.path,
      folderId: folder.id,
      uploadedByType: input.uploadedByType ?? null,
      uploadedById: input.uploadedById ?? null,
    });

    await storeAsset(created.id, {
      buffer: validated.buffer,
      mimeType: validated.mimeType,
      kind: validated.kind,
      fileName: validated.fileName,
      folderPath: folder.path,
    });

    const media = await mediaRepository.findById(created.id);
    return { media: toMediaDto(media!, folder.path), deduplicated: false };
  },

  async list(query: MediaListQuery): Promise<PageResult<MediaAssetDto>> {
    const page = await mediaRepository.list(query);
    return { ...page, items: page.items.map((media) => toMediaDto(media)) };
  },

  async get(id: string): Promise<MediaDetailDto> {
    const media = await mediaRepository.findDetail(id, true);
    if (!media) throw AppError.notFound('Media not found', { id });
    return toDetailDto(media);
  },

  async update(id: string, input: MediaUpdateInput): Promise<MediaAssetDto> {
    const existing = await mediaRepository.findById(id, true);
    if (!existing) throw AppError.notFound('Media not found', { id });

    const folder = input.folderId ? await mediaFolderService.get(input.folderId) : null;

    const updated = await mediaRepository.update(id, {
      ...(input.altText === undefined ? {} : { altText: input.altText ?? null }),
      ...(input.title === undefined ? {} : { title: input.title ?? null }),
      ...(input.tags === undefined ? {} : { tagsJson: tagsColumn.serialize(input.tags) }),
      ...(input.focalPoint === undefined
        ? {}
        : {
            focalPointX: input.focalPoint?.x ?? null,
            focalPointY: input.focalPoint?.y ?? null,
          }),
      ...(folder ? { folderId: folder.id, folder: folder.path } : {}),
      ...(input.folderId === null ? { folderId: null } : {}),
    });

    await invalidateUsersOf([id]);
    return toMediaDto(updated, folder?.path ?? null);
  },

  /** Keeps the same media id (and therefore every reference) while swapping the bytes. */
  async replace(
    id: string,
    file: { buffer: Buffer; originalName: string },
  ): Promise<MediaAssetDto> {
    const existing = await mediaRepository.findById(id, true);
    if (!existing) throw AppError.notFound('Media not found', { id });

    const validated = await validateUpload(file);
    const oldKeys = [existing.path, ...existing.variants.map((variant) => variant.path)];

    await mediaRepository.update(id, {
      status: 'PROCESSING',
      mimeType: validated.mimeType,
      kind: validated.kind,
      originalName: validated.fileName,
      checksum: sha256(validated.buffer),
      checksumSha256: sha256(validated.buffer),
      processingError: null,
    });

    await storeAsset(id, {
      buffer: validated.buffer,
      mimeType: validated.mimeType,
      kind: validated.kind,
      fileName: validated.fileName,
      folderPath: existing.folder,
    });

    await storage.deleteMany(oldKeys.filter((key) => !key.startsWith('pending/')));
    // Cached payloads still point at the storage keys just deleted.
    await invalidateUsersOf([id]);

    const media = await mediaRepository.findById(id);
    return toMediaDto(media!);
  },

  /** Re-runs the pipeline from the stored original — used after a preset change. */
  async reprocess(id: string): Promise<MediaAssetDto> {
    const existing = await mediaRepository.findById(id, true);
    if (!existing) throw AppError.notFound('Media not found', { id });

    const buffer = await storage.get(existing.path);
    await storage.deleteMany(existing.variants.map((variant) => variant.path));

    await storeAsset(id, {
      buffer,
      mimeType: existing.mimeType,
      kind: existing.kind as MediaKind,
      fileName: existing.originalName,
      folderPath: existing.folder,
    });
    await invalidateUsersOf([id]);

    const media = await mediaRepository.findById(id);
    return toMediaDto(media!);
  },

  async softDelete(id: string): Promise<void> {
    const existing = await mediaRepository.findById(id, true);
    if (!existing) throw AppError.notFound('Media not found', { id });
    await mediaRepository.softDelete(id);
    await invalidateUsersOf([id]);
  },

  async restore(id: string): Promise<MediaAssetDto> {
    const existing = await mediaRepository.findById(id, true);
    if (!existing) throw AppError.notFound('Media not found', { id });

    const restored = await mediaRepository.restore(id);
    await invalidateUsersOf([id]);
    return toMediaDto((await mediaRepository.findById(restored.id))!);
  },

  /** Removes the row AND the bytes. Refuses while the asset is referenced unless forced. */
  async hardDelete(
    id: string,
    force = false,
  ): Promise<{ detachedUsages: number; filesDeleted: number }> {
    const existing = await mediaRepository.findById(id, true);
    if (!existing) throw AppError.notFound('Media not found', { id });

    const usages = await mediaUsageService.listFor(id);
    if (usages.length > 0 && !force) {
      throw new AppError(409, 'MEDIA_IN_USE', 'This asset is still in use', {
        usageCount: usages.length,
        usages: usages.map((usage) => ({ usageType: usage.usageType, entityId: usage.entityId })),
      });
    }

    // Read first: a forced detach and the delete cascade both remove the rows naming the users.
    const productSlugs = await productMediaRepository.productSlugsForMedia([id]);
    const detachedUsages = usages.length > 0 ? await mediaUsageService.detachMedia(id) : 0;
    const keys = [existing.path, ...existing.variants.map((variant) => variant.path)];
    const filesDeleted = await storage.deleteMany(
      keys.filter((key) => !key.startsWith('pending/')),
    );

    await mediaRepository.hardDelete(id);
    await catalogCacheService.invalidateMedia(productSlugs);
    return { detachedUsages, filesDeleted };
  },

  async bulkSoftDelete(ids: string[]): Promise<number> {
    const deletedIds: string[] = [];
    for (const id of ids) {
      const existing = await mediaRepository.findById(id, true);
      if (!existing) continue;
      await mediaRepository.softDelete(id);
      deletedIds.push(id);
    }
    if (deletedIds.length > 0) await invalidateUsersOf(deletedIds);
    return deletedIds.length;
  },

  /**
   * Finds files on disk with no row and rows with no file. Dry run by default: this is a report,
   * not a destructive operation.
   */
  async garbageCollect(dryRun = true): Promise<MediaGarbageReportDto> {
    const [mediaPaths, variantPaths, listed] = await Promise.all([
      mediaRepository.allPaths(),
      mediaRepository.allVariantPaths(),
      storage.list(''),
    ]);

    const known = new Set([...mediaPaths, ...variantPaths].map((row) => row.path));
    const onDisk = new Set(listed.keys);

    const orphanedFiles = listed.keys.filter((key) => !known.has(key));
    const missingFiles = mediaPaths.filter((row) => !onDisk.has(row.path));

    if (!dryRun && orphanedFiles.length > 0) {
      await storage.deleteMany(orphanedFiles);
    }

    return {
      dryRun,
      orphanedFiles,
      missingFiles: missingFiles.map((row) => ({ mediaId: row.id, path: row.path })),
      scannedFiles: listed.keys.length,
      scannedRows: mediaPaths.length + variantPaths.length,
    };
  },

  rawById(id: string): Promise<Media | null> {
    return mediaRepository.findById(id, true) as unknown as Promise<Media | null>;
  },
};
