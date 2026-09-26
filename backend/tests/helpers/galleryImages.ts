import { randomUUID } from 'node:crypto';

import sharp from 'sharp';

import { env } from '../../src/config/env';
import { mediaService } from '../../src/modules/media/media.service';

/**
 * Images a product gallery accepts (at least MIN_PRODUCT_IMAGE_DIMENSION on the shortest side).
 * The seeded demo images predate that rule, so tests that attach images upload their own.
 */
export async function uploadGalleryImages(count: number): Promise<string[]> {
  const side = Math.max(env.MIN_PRODUCT_IMAGE_DIMENSION, 256);
  const run = randomUUID().slice(0, 8);
  const jitter = parseInt(run.slice(2, 4), 16);
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const buffer = await sharp({
      create: {
        width: side + jitter + 16 * index,
        height: side,
        channels: 3,
        background: { r: 40 + ((index * 30) % 200), g: 90, b: parseInt(run.slice(0, 2), 16) },
      },
    })
      .png()
      .toBuffer();
    const result = await mediaService.upload({
      buffer,
      originalName: `gallery-${run}-${index}.png`,
      declaredMimeType: 'image/png',
    });
    ids.push(result.media.id);
  }
  return ids;
}
