import { encode as encodeBlurhash } from 'blurhash';
import sharp from 'sharp';

import { RENDITION_PRESETS, type RenditionPreset } from '@shared/constants';
import type { DeviceTarget, ImageFormat, RenditionLabel } from '@shared/enums';

import { avifEnabled, blurhashEnabled, env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * sharp pipeline: auto-rotate from EXIF, then strip ALL metadata (privacy — location and camera
 * serials travel in photos), cap the original at MAX_IMAGE_DIMENSION, and derive the rendition
 * ladder from RENDITION_PRESETS. Renditions are never upscaled past the source.
 */

export interface ProcessedOriginal {
  buffer: Buffer;
  width: number;
  height: number;
  format: ImageFormat;
  dominantColorHex: string | null;
  blurhash: string | null;
  lqipDataUri: string | null;
}

export interface ProcessedRendition {
  label: RenditionLabel;
  format: ImageFormat;
  extension: string;
  buffer: Buffer;
  width: number;
  height: number;
  deviceTarget: DeviceTarget;
  isDefault: boolean;
}

const FORMAT_BY_MIME: Record<string, ImageFormat> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
  'image/avif': 'AVIF',
  'image/gif': 'GIF',
  'image/svg+xml': 'SVG',
};

const EXTENSION_BY_FORMAT: Record<ImageFormat, string> = {
  JPEG: 'jpg',
  PNG: 'png',
  WEBP: 'webp',
  AVIF: 'avif',
  GIF: 'gif',
  SVG: 'svg',
};

export function imageFormatFor(mimeType: string): ImageFormat | null {
  return FORMAT_BY_MIME[mimeType.toLowerCase()] ?? null;
}

export function extensionForFormat(format: ImageFormat): string {
  return EXTENSION_BY_FORMAT[format];
}

/** SVG has no renditions and an animated GIF is passed through untouched. */
export function supportsRenditions(mimeType: string): boolean {
  return !['image/svg+xml', 'image/gif'].includes(mimeType.toLowerCase());
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function encodeTo(pipeline: sharp.Sharp, format: ImageFormat, quality: number): sharp.Sharp {
  switch (format) {
    case 'PNG':
      return pipeline.png({ compressionLevel: 9, palette: true });
    case 'WEBP':
      return pipeline.webp({ quality });
    case 'AVIF':
      return pipeline.avif({ quality: Math.max(30, quality - 10) });
    case 'GIF':
      return pipeline.gif();
    case 'JPEG':
    default:
      return pipeline.jpeg({ quality, mozjpeg: true, progressive: true });
  }
}

async function buildBlurhash(buffer: Buffer): Promise<string | null> {
  if (!blurhashEnabled) return null;

  try {
    const { data, info } = await sharp(buffer)
      .raw()
      .ensureAlpha()
      .resize(32, 32, { fit: 'inside' })
      .toBuffer({ resolveWithObject: true });

    return encodeBlurhash(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
  } catch (error) {
    logger.warn({ err: error }, 'blurhash generation failed');
    return null;
  }
}

/** A <1.5KB inline preview the admin UI and Prompt 13 cross-fade from. */
async function buildLqip(buffer: Buffer): Promise<string | null> {
  try {
    const tiny = await sharp(buffer)
      .resize(24, 24, { fit: 'inside' })
      .webp({ quality: 35 })
      .toBuffer();
    if (tiny.byteLength > 1500) return null;
    return `data:image/webp;base64,${tiny.toString('base64')}`;
  } catch {
    return null;
  }
}

async function dominantColor(buffer: Buffer): Promise<string | null> {
  try {
    const { dominant } = await sharp(buffer).stats();
    return toHex(dominant.r, dominant.g, dominant.b);
  } catch {
    return null;
  }
}

export const imageProcessor = {
  /** Reads dimensions without decoding the whole image. */
  async probe(buffer: Buffer): Promise<{ width: number | null; height: number | null }> {
    try {
      const metadata = await sharp(buffer).metadata();
      return { width: metadata.width ?? null, height: metadata.height ?? null };
    } catch {
      return { width: null, height: null };
    }
  },

  async prepareOriginal(buffer: Buffer, mimeType: string): Promise<ProcessedOriginal> {
    const format = imageFormatFor(mimeType) ?? 'JPEG';

    if (!supportsRenditions(mimeType)) {
      const probed = await this.probe(buffer);
      return {
        buffer,
        width: probed.width ?? 0,
        height: probed.height ?? 0,
        format,
        dominantColorHex: format === 'SVG' ? null : await dominantColor(buffer),
        blurhash: format === 'SVG' ? null : await buildBlurhash(buffer),
        lqipDataUri: format === 'SVG' ? null : await buildLqip(buffer),
      };
    }

    const normalised = await encodeTo(
      sharp(buffer, { failOn: 'none' }).rotate().resize({
        width: env.MAX_IMAGE_DIMENSION,
        height: env.MAX_IMAGE_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      }),
      format,
      env.IMAGE_QUALITY,
      // sharp strips metadata unless withMetadata() is called — that is exactly what we want.
    ).toBuffer();

    const metadata = await sharp(normalised).metadata();

    return {
      buffer: normalised,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      format,
      dominantColorHex: await dominantColor(normalised),
      blurhash: await buildBlurhash(normalised),
      lqipDataUri: await buildLqip(normalised),
    };
  },

  /** One rendition per preset × format, skipping any that would upscale the source. */
  async buildRenditions(
    original: ProcessedOriginal,
    mimeType: string,
  ): Promise<ProcessedRendition[]> {
    if (!supportsRenditions(mimeType)) return [];

    const renditions: ProcessedRendition[] = [];
    const sourceFormat = original.format;

    const formatsFor = (preset: RenditionPreset): ImageFormat[] => {
      const extra = preset.formats.filter(
        (format): format is ImageFormat => format !== sourceFormat,
      );
      return [sourceFormat, ...extra, ...(avifEnabled ? (['AVIF'] as ImageFormat[]) : [])];
    };

    for (const preset of RENDITION_PRESETS) {
      if (preset.fit === 'inside' && preset.width > original.width) continue;

      for (const format of new Set(formatsFor(preset))) {
        try {
          const pipeline = sharp(original.buffer).resize({
            width: preset.width,
            ...(preset.height ? { height: preset.height } : {}),
            fit: preset.fit,
            withoutEnlargement: true,
            position: 'attention',
          });

          const { data, info } = await encodeTo(pipeline, format, preset.quality).toBuffer({
            resolveWithObject: true,
          });

          renditions.push({
            label: preset.label as RenditionLabel,
            format,
            extension: extensionForFormat(format),
            buffer: data,
            width: info.width,
            height: info.height,
            deviceTarget: preset.deviceTarget,
            isDefault: format === 'WEBP',
          });
        } catch (error) {
          logger.warn({ err: error, label: preset.label, format }, 'rendition failed');
        }
      }
    }

    return renditions;
  },
};
