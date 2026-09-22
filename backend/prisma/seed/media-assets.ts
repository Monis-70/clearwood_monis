import { createHash } from 'node:crypto';

import type { Media } from '@prisma/client';
import sharp from 'sharp';

import { mediaService } from '../../src/container';
import { mediaUsageService } from '../../src/modules/media/media-usage.service';
import { mediaRepository } from '../../src/repositories/media.repository';

import { log, prisma } from './context';

/**
 * Deterministic, fully offline demo imagery.
 *
 * Prompt 4 replaced the old inline SVG placeholders with real rasters composed by sharp, because
 * SVG cannot exercise the rendition pipeline (no resize ladder, no blurhash, no LQIP, no dominant
 * colour). Every asset is now pushed through the *same* mediaService.upload() the admin UI uses,
 * so the seeded database is indistinguishable from one populated by hand.
 *
 * The bytes are a pure function of the spec, so re-seeding produces an identical checksum and the
 * asset is reused instead of regenerated.
 */

export interface SeedMediaSpec {
  /** Stable key — the same product always regenerates the same file. */
  key: string;
  label: string;
  caption: string;
  hex: string;
  width?: number;
  height?: number;
  altText: string;
}

const FOLDER_PATH = 'products';
const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 1200;

/** Small deterministic hash used to vary the composition without any randomness. */
function seedOf(key: string): number {
  return parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16);
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const normalised = hex.replace('#', '');
  const full =
    normalised.length === 3
      ? normalised
          .split('')
          .map((char) => char + char)
          .join('')
      : normalised.padEnd(6, '0').slice(0, 6);

  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function shade(
  base: { r: number; g: number; b: number },
  factor: number,
): { r: number; g: number; b: number } {
  return {
    r: clampChannel(base.r * factor),
    g: clampChannel(base.g * factor),
    b: clampChannel(base.b * factor),
  };
}

async function block(
  width: number,
  height: number,
  colour: { r: number; g: number; b: number },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: colour } })
    .png()
    .toBuffer();
}

/**
 * A flat-design "furniture in a room" panel: a floor band, a wall band and two offset blocks whose
 * placement is derived from the key. Deliberately typography-free so the output never depends on
 * which fonts happen to be installed on the build machine.
 */
async function composePanel(spec: SeedMediaSpec, width: number, height: number): Promise<Buffer> {
  const base = parseHex(spec.hex);
  const seed = seedOf(spec.key);

  const floorHeight = Math.round(height * 0.32);
  const pieceWidth = Math.round(width * 0.42);
  const pieceHeight = Math.round(height * 0.38);
  const pieceLeft = Math.round(width * 0.12) + (seed % Math.round(width * 0.14));
  const pieceTop = height - floorHeight - pieceHeight + (seed % 40);

  const accentSize = Math.round(width * 0.14);
  const accentLeft = width - accentSize - Math.round(width * 0.12);
  const accentTop = Math.round(height * 0.16) + ((seed >> 8) % 60);

  return sharp({ create: { width, height, channels: 3, background: shade(base, 1.22) } })
    .composite([
      {
        input: await block(width, floorHeight, shade(base, 0.72)),
        left: 0,
        top: height - floorHeight,
      },
      { input: await block(pieceWidth, pieceHeight, base), left: pieceLeft, top: pieceTop },
      {
        input: await block(pieceWidth, Math.round(pieceHeight * 0.16), shade(base, 0.58)),
        left: pieceLeft,
        top: pieceTop + pieceHeight - Math.round(pieceHeight * 0.16),
      },
      {
        input: await block(accentSize, accentSize, shade(base, 0.9)),
        left: accentLeft,
        top: accentTop,
      },
    ])
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/**
 * Idempotent: identical bytes short-circuit on the checksum, so a second `db:seed` run neither
 * re-uploads nor regenerates renditions, and any admin-edited altText/title survives.
 */
export async function ensureSeedMedia(spec: SeedMediaSpec): Promise<Media> {
  const width = spec.width ?? DEFAULT_WIDTH;
  const height = spec.height ?? DEFAULT_HEIGHT;

  const buffer = await composePanel(spec, width, height);
  const checksum = createHash('sha256').update(buffer).digest('hex');

  const existing = await mediaRepository.findByChecksum(checksum);
  if (existing) {
    // Re-seed of an unchanged asset: keep the row (and its renditions) exactly as they are.
    if (existing.deletedAt) {
      await prisma.media.update({ where: { id: existing.id }, data: { deletedAt: null } });
    }
    return prisma.media.findUniqueOrThrow({ where: { id: existing.id } });
  }

  const result = await mediaService.upload({
    buffer,
    originalName: `${spec.key}.jpg`,
    declaredMimeType: 'image/jpeg',
    folderPath: FOLDER_PATH,
    altText: spec.altText,
    title: spec.label,
    tags: ['seed', 'demo'],
    source: 'SEED',
    uploadedByType: 'SYSTEM',
    uploadedById: null,
  });

  return prisma.media.findUniqueOrThrow({ where: { id: result.media.id } });
}

/**
 * Prompt 1–3 seeded SVG placeholders under `seed/`. Prompt 4 replaced them with rasters, so the old
 * rows (and their now-dangling ProductMedia links) are swept up once; on later runs this is a no-op.
 */
export async function purgeLegacySvgSeedMedia(): Promise<number> {
  const legacy = await prisma.media.findMany({
    where: { mimeType: 'image/svg+xml', uploadedByType: 'SYSTEM', folder: 'seed' },
    select: { id: true },
  });
  if (legacy.length === 0) return 0;

  const ids = legacy.map((row) => row.id);
  await prisma.productMedia.deleteMany({ where: { mediaId: { in: ids } } });
  await prisma.mediaUsage.deleteMany({ where: { mediaId: { in: ids } } });
  await prisma.mediaVariant.deleteMany({ where: { mediaId: { in: ids } } });
  await prisma.media.deleteMany({ where: { id: { in: ids } } });

  log('media-assets', `${ids.length} legacy SVG placeholders removed`);
  return ids.length;
}

/**
 * The demo catalog writes ProductMedia rows directly (it predates Prompt 4), so the usage ledger is
 * reconciled afterwards rather than duplicating the attach logic in two places.
 */
export async function backfillProductMediaUsage(): Promise<number> {
  const links = await prisma.productMedia.findMany({
    select: { productId: true, mediaId: true },
    orderBy: { productId: 'asc' },
  });

  const byProduct = new Map<string, string[]>();
  for (const link of links) {
    const bucket = byProduct.get(link.productId) ?? [];
    if (!bucket.includes(link.mediaId)) bucket.push(link.mediaId);
    byProduct.set(link.productId, bucket);
  }

  for (const [productId, mediaIds] of byProduct) {
    await mediaUsageService.sync('PRODUCT', productId, mediaIds);
  }

  const total = await prisma.mediaUsage.count();
  log('media-assets', `${total} media usage rows reconciled across ${byProduct.size} products`);
  return total;
}
