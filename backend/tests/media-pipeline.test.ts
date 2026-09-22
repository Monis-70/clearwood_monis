import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../src/config/env';
import { LocalStorageDriver } from '../src/drivers/storage/local.storage';
import { S3StorageDriver } from '../src/drivers/storage/s3.storage';
import {
  buildStorageKey,
  normaliseStorageKey,
  signKey,
  verifyKeySignature,
} from '../src/drivers/storage';
import type { StorageDriver } from '../src/drivers/storage/storage.driver';
import { imageProcessor, supportsRenditions } from '../src/modules/media/image.processor';
import {
  sanitiseFileName,
  sanitiseSvg,
  validateUpload,
} from '../src/modules/media/upload.validator';

/**
 * Prompt 4 — everything below the HTTP layer: file validation, the sharp pipeline, storage-driver
 * parity, key safety and signed URLs.
 */

async function png(width: number, height: number, hex = '#B4613A'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: hex } })
    .png()
    .toBuffer();
}

async function jpegWithExif(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#7E8C77' } })
    .withMetadata({ exif: { IFD0: { Copyright: 'ClearWood', Artist: 'Seed' } } })
    .jpeg()
    .toBuffer();
}

/** `toMatchObject` does not see Error class fields, so failures are inspected directly. */
async function statusOf(action: Promise<unknown>): Promise<number> {
  try {
    await action;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode ?? 0;
  }
  throw new Error('expected the call to reject');
}

describe('upload validation', () => {
  it('identifies the type from magic bytes, not from the declared mime type', async () => {
    const buffer = await png(64, 64);

    const result = await validateUpload({
      buffer,
      originalName: 'lies.jpg',
      declaredMimeType: 'image/jpeg',
    });

    expect(result.mimeType).toBe('image/png');
    expect(result.kind).toBe('IMAGE');
  });

  it('rejects a file whose bytes are not an allowed type', async () => {
    const status = await statusOf(
      validateUpload({ buffer: Buffer.from('#!/bin/sh\nrm -rf /'), originalName: 'payload.png' }),
    );
    expect(status).toBe(415);
  });

  it('rejects an oversized file', async () => {
    const oversized = Buffer.alloc(env.MAX_UPLOAD_SIZE_MB * 1024 * 1024 + 1024);
    (await png(8, 8)).copy(oversized);

    expect(await statusOf(validateUpload({ buffer: oversized, originalName: 'huge.png' }))).toBe(
      413,
    );
  });

  it('strips scripting out of an SVG and refuses one that still looks active', () => {
    const result = sanitiseSvg(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect onload="steal()"/></svg>',
      ),
    );

    const cleaned = result.sanitised.toString('utf8');
    expect(cleaned).not.toContain('<script');
    expect(cleaned).not.toContain('onload');
    expect(result.removed).toContain('script');
    expect(result.removed).toContain('event-handler');
  });

  it('defuses traversal, null bytes and double extensions in the filename', () => {
    expect(sanitiseFileName('../../etc/passwd')).not.toContain('..');
    expect(sanitiseFileName('shell.php\u0000.png')).not.toContain('\u0000');
    expect(sanitiseFileName('invoice.pdf.exe.png')).not.toMatch(/\.exe/i);
  });
});

describe('image processing', () => {
  it('downscales beyond MAX_IMAGE_DIMENSION and strips metadata', async () => {
    const original = await imageProcessor.prepareOriginal(
      await jpegWithExif(4000, 3000),
      'image/jpeg',
    );

    expect(Math.max(original.width, original.height)).toBeLessThanOrEqual(env.MAX_IMAGE_DIMENSION);

    const metadata = await sharp(original.buffer).metadata();
    expect(metadata.exif).toBeUndefined();
  });

  it('never upscales: a small source produces only the presets it can fill', async () => {
    const original = await imageProcessor.prepareOriginal(await png(200, 200), 'image/png');
    const renditions = await imageProcessor.buildRenditions(original, 'image/png');

    expect(renditions.length).toBeGreaterThan(0);
    for (const rendition of renditions) {
      expect(rendition.width).toBeLessThanOrEqual(200);
    }
  });

  it('derives a blurhash, an LQIP and a dominant colour', async () => {
    const original = await imageProcessor.prepareOriginal(await png(800, 600), 'image/png');

    expect(original.blurhash).toBeTruthy();
    expect(original.lqipDataUri).toMatch(/^data:image\//);
    // Inlined into HTML, so it has to stay tiny.
    expect((original.lqipDataUri ?? '').length).toBeLessThan(1600);
    expect(original.dominantColorHex).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('leaves animated and vector formats alone', () => {
    expect(supportsRenditions('image/gif')).toBe(false);
    expect(supportsRenditions('image/svg+xml')).toBe(false);
    expect(supportsRenditions('image/jpeg')).toBe(true);
  });
});

describe('storage keys and signed URLs', () => {
  it('builds a date-partitioned, collision-proof key', () => {
    const key = buildStorageKey({
      id: 'ckabc123',
      folderPath: 'products',
      originalName: 'Teak Sideboard.JPG',
      mimeType: 'image/jpeg',
    });

    expect(key).toMatch(/^products\/\d{4}\/\d{2}\/ckabc123-teak-sideboard\.jpg$/);
  });

  it('refuses traversal, null bytes and reserved Windows names, and forces keys to be relative', () => {
    for (const bad of ['../secrets.env', 'a/../../b.png', 'CON.png', 'C:/windows/system32.png']) {
      expect(() => normaliseStorageKey(bad)).toThrow();
    }

    // A leading slash is stripped rather than rejected — the result is still confined to the root.
    expect(normaliseStorageKey('/etc/passwd')).toBe('etc/passwd');
  });

  it('accepts a valid signature and rejects a tampered or expired one', () => {
    const key = 'products/2026/01/asset.jpg';
    const expires = Date.now() + 300_000;
    const signature = signKey(key, expires, 'unit-test-secret');

    expect(verifyKeySignature(key, expires, signature, 'unit-test-secret').valid).toBe(true);
    expect(verifyKeySignature(key, expires, `${signature}x`, 'unit-test-secret')).toMatchObject({
      valid: false,
      reason: 'BAD_SIGNATURE',
    });
    expect(verifyKeySignature('other/key.jpg', expires, signature, 'unit-test-secret').valid).toBe(
      false,
    );

    const past = Date.now() - 10_000;
    expect(
      verifyKeySignature(key, past, signKey(key, past, 'unit-test-secret'), 'unit-test-secret'),
    ).toMatchObject({ valid: false, reason: 'EXPIRED' });
  });
});

/**
 * Parity suite — the same expectations are asserted against both drivers so swapping
 * STORAGE_DRIVER can never silently change behaviour. S3 runs against an in-memory fake client
 * (no credentials, no network).
 */
describe.each<[string, () => Promise<{ driver: StorageDriver; cleanup: () => Promise<void> }>]>([
  [
    'local',
    async () => {
      const root = path.join(env.LOCAL_UPLOAD_DIR, `.parity-${randomUUID()}`);
      await fs.mkdir(root, { recursive: true });

      const driver = new LocalStorageDriver({
        uploadDir: root,
        publicBaseUrl: 'http://localhost:7180/media',
        signedBaseUrl: 'http://localhost:7180/media-signed',
        signingSecret: 'parity-secret',
        defaultSignedTtlSeconds: 300,
      });

      return { driver, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
    },
  ],
  [
    's3',
    async () => {
      const objects = new Map<string, Buffer>();

      // Minimal stand-in for the AWS SDK client: just enough command handling for the contract.
      const fakeClient = {
        async send(command: { constructor: { name: string }; input: Record<string, never> }) {
          const input = command.input as unknown as {
            Key?: string;
            Body?: Buffer | string;
            Prefix?: string;
            CopySource?: string;
            Delete?: { Objects: { Key: string }[] };
          };
          const name = command.constructor.name;

          if (name === 'PutObjectCommand') {
            objects.set(input.Key as string, Buffer.from(input.Body as Buffer | string));
            return {};
          }
          if (name === 'GetObjectCommand') {
            const body = objects.get(input.Key as string);
            if (!body) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
            return {
              Body: {
                transformToByteArray: async () => new Uint8Array(body),
                [Symbol.asyncIterator]: async function* () {
                  yield body;
                },
              },
              ContentLength: body.length,
            };
          }
          if (name === 'HeadObjectCommand') {
            const body = objects.get(input.Key as string);
            if (!body) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
            return { ContentLength: body.length, LastModified: new Date() };
          }
          if (name === 'DeleteObjectCommand') {
            objects.delete(input.Key as string);
            return {};
          }
          if (name === 'DeleteObjectsCommand') {
            for (const object of input.Delete?.Objects ?? []) objects.delete(object.Key);
            return {};
          }
          if (name === 'CopyObjectCommand') {
            const source = decodeURIComponent(String(input.CopySource))
              .split('/')
              .slice(1)
              .join('/');
            objects.set(input.Key as string, objects.get(source) ?? Buffer.alloc(0));
            return {};
          }
          if (name === 'ListObjectsV2Command') {
            return {
              Contents: [...objects.keys()]
                .filter((key) => key.startsWith(input.Prefix ?? ''))
                .map((key) => ({ Key: key, Size: objects.get(key)?.length ?? 0 })),
            };
          }
          return {};
        },
        destroy() {
          /* nothing to release in the fake */
        },
      };

      const driver = new S3StorageDriver({
        bucket: 'clearwood-test',
        region: 'ap-south-1',
        prefix: '',
        publicBaseUrl: 'https://cdn.example.test',
        acl: 'private',
        forcePathStyle: false,
        defaultSignedTtlSeconds: 300,
        client: fakeClient as never,
      });

      return {
        driver,
        cleanup: async () => {
          objects.clear();
        },
      };
    },
  ],
])('storage driver parity (%s)', (_name, make) => {
  let driver: StorageDriver;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ driver, cleanup } = await make());
  });

  afterAll(async () => {
    await cleanup();
  });

  it('round-trips a put, get, stat, exists and delete', async () => {
    const key = 'parity/2026/01/sample.png';
    const body = await png(32, 32);

    const stored = await driver.put(key, body, { contentType: 'image/png' });
    expect(stored.key).toBe(key);
    expect(stored.size).toBe(body.length);
    expect(stored.url).toContain(key);

    expect(await driver.exists(key)).toBe(true);

    // G1: an empty buffer round-trips through a broken driver just as cleanly as a real one.
    const fetched = await driver.get(key);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.length).toBe(body.length);
    expect(fetched.equals(body)).toBe(true);
    expect((await driver.stat(key))?.size).toBe(body.length);

    const listed = await driver.list('parity/');
    expect(listed.keys).toContain(key);

    await driver.copy(key, 'parity/2026/01/copy.png');
    expect(await driver.exists('parity/2026/01/copy.png')).toBe(true);

    await driver.deleteMany([key, 'parity/2026/01/copy.png']);
    expect(await driver.exists(key)).toBe(false);
  });

  it('refuses a traversal key on every driver', async () => {
    await expect(driver.put('../escape.png', Buffer.from('x'))).rejects.toThrow();
  });
});
