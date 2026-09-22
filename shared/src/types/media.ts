import type {
  DeviceTarget,
  ImageFormat,
  MediaKind,
  MediaRole,
  MediaSource,
  MediaStatus,
  MediaUsageType,
  RenditionLabel,
} from '../enums';

/** Media DTOs — the shapes the API returns and both frontends consume. */

export interface MediaVariantDto {
  id: string;
  label: RenditionLabel;
  format: ImageFormat;
  url: string;
  width: number;
  height: number;
  sizeBytes: number;
  isDefault: boolean;
  deviceTarget: DeviceTarget;
}

export interface MediaUsageDto {
  id: string;
  usageType: MediaUsageType;
  entityId: string;
  field: string | null;
  createdAt: string;
}

export interface MediaFolderDto {
  id: string;
  name: string;
  slug: string;
  path: string;
  depth: number;
  position: number;
  parentId: string | null;
  isSystem: boolean;
  mediaCount?: number;
  children?: MediaFolderDto[];
}

/** Focal point in basis points of width/height (0–10000) so smart crops survive a resize. */
export interface FocalPoint {
  x: number;
  y: number;
}

export interface MediaAssetDto {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  source: MediaSource;
  disk: string;
  path: string;
  url: string;
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  altText: string | null;
  title: string | null;
  tags: string[];
  folderId: string | null;
  folderPath: string | null;
  checksumSha256: string | null;
  dominantColorHex: string | null;
  blurhash: string | null;
  lqipDataUri: string | null;
  focalPoint: FocalPoint | null;
  isOptimized: boolean;
  processingError: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  variants: MediaVariantDto[];
}

export interface MediaDetailDto extends MediaAssetDto {
  usage: MediaUsageDto[];
}

export interface MediaUploadResultDto {
  media: MediaAssetDto;
  /** True when the exact bytes already existed — nothing new was stored. */
  deduplicated: boolean;
}

export interface MediaConfigDto {
  maxUploadSizeMb: number;
  maxUploadFiles: number;
  maxImageDimension: number;
  allowedImageMime: string[];
  allowedVideoMime: string[];
  allowedDocMime: string[];
  renditions: {
    label: string;
    width: number;
    height?: number;
    fit: string;
    quality: number;
    formats: string[];
    deviceTarget: string;
  }[];
  avifEnabled: boolean;
  driver: string;
  presignSupported: boolean;
}

export interface MediaGarbageReportDto {
  dryRun: boolean;
  orphanedFiles: string[];
  missingFiles: { mediaId: string; path: string }[];
  scannedFiles: number;
  scannedRows: number;
}

/* ------------------------------------------------------------ product media */

export interface ProductMediaItemDto {
  id: string;
  mediaId: string;
  role: MediaRole;
  position: number;
  altText: string | null;
  deviceTarget: DeviceTarget;
  attributeValueId: string | null;
  variantId: string | null;
  media: MediaAssetDto;
}

/* --------------------------------------------------------------- gallery */

export interface GallerySourceDto {
  label: RenditionLabel;
  format: ImageFormat;
  url: string;
  width: number;
  height: number;
}

export interface GalleryItemDto {
  mediaId: string;
  productMediaId: string;
  role: MediaRole;
  position: number;
  alt: string | null;
  width: number | null;
  height: number | null;
  focalPoint: FocalPoint | null;
  blurhash: string | null;
  lqip: string | null;
  url: string;
  deviceTarget: DeviceTarget;
  /** Set when the asset is tied to a specific colour/finish or variant. */
  attributeValueId: string | null;
  variantId: string | null;
  sources: GallerySourceDto[];
}

export interface ProductGalleryDto {
  productId: string;
  slug: string;
  items: GalleryItemDto[];
}
