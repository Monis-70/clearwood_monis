import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { cache } from '../src/container';
import { CATALOG_CACHE_PREFIXES } from '../src/modules/catalog-admin/catalogCache.service';
import { mediaService } from '../src/modules/media/media.service';

import { countQueries } from './helpers/queryCounter';

/**
 * Storefront media contract (PROJECT_CONTEXT §51): statements and payload bytes of the public
 * reads the media contract touches, measured the same way before and after the change.
 *
 * Opt-in (CLEARWOOD_MEDIA_MEASURE=1); CLEARWOOD_MEDIA_MEASURE_OUT=<file> writes the report as JSON.
 * Every read is COLD: all catalog caches are dropped first except pricing and settings
 * configuration, so a new cached map is paid for, not hidden. Two scenarios: the seed as it is,
 * then the same reads after media is attached to every reference the contract resolves
 * (category icon and banners, collection images, navigation icons, swatches, stores, testimonials,
 * banner mobile images). `statements` is the query-budget counter; `header` is what
 * DEBUG_QUERY_COUNT (§33) reported for the same request.
 */

const enabled = process.env.CLEARWOOD_MEDIA_MEASURE === '1';
const OUT = process.env.CLEARWOOD_MEDIA_MEASURE_OUT;
const API = '/api/v1';
const app = createApp();

const WARM = new Set<string>([
  CATALOG_CACHE_PREFIXES.pricingSettings,
  CATALOG_CACHE_PREFIXES.pricingShipping,
  CATALOG_CACHE_PREFIXES.storefrontSettings,
  CATALOG_CACHE_PREFIXES.cmsSettings,
]);

interface Measurement {
  scenario: string;
  label: string;
  path: string;
  statements: number;
  header: number | null;
  rawBytes: number;
  gzipBytes: number;
}

const report: Measurement[] = [];
const paths: Record<string, string> = {};

async function quiesce(): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const { count } = await countQueries(async () => {
      for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    });
    if (count === 0) return;
  }
  throw new Error('background database work never settled');
}

async function measure(scenario: string, label: string, path: string): Promise<Measurement> {
  for (const prefix of Object.values(CATALOG_CACHE_PREFIXES)) {
    if (!WARM.has(prefix)) await cache.delByPrefix(prefix);
  }
  await quiesce();

  let text = '';
  let status = 0;
  let header: number | null = null;
  const { count } = await countQueries(async () => {
    const response = await request(app).get(path);
    status = response.status;
    text = response.text;
    const reported = response.headers['x-query-count'] as string | undefined;
    header = reported === undefined ? null : Number(reported);
  });

  expect(status, `${path}: ${text.slice(0, 200)}`).toBe(200);
  // G1: a read that touched nothing measured nothing.
  expect(count).toBeGreaterThan(0);

  const row = {
    scenario,
    label,
    path,
    statements: count,
    header,
    rawBytes: Buffer.byteLength(text),
    gzipBytes: gzipSync(text).byteLength,
  };
  report.push(row);
  return row;
}

async function upload(name: string, width: number, height: number): Promise<string> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 150, g: 110, b: 80 } },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
  const result = await mediaService.upload({
    buffer,
    originalName: `${name}.jpg`,
    declaredMimeType: 'image/jpeg',
  });
  return result.media.id;
}

async function measureAll(scenario: string): Promise<void> {
  for (const [label, path] of Object.entries(paths)) await measure(scenario, label, path);
}

describe.skipIf(!enabled)('storefront media contract measurement', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeAll(async () => {
    vi.stubEnv('DEBUG_QUERY_COUNT', 'true');

    const roots = await prisma.category.findMany({
      where: { depth: 0, isActive: true, deletedAt: null },
      select: { slug: true, _count: { select: { children: true } } },
      orderBy: [{ position: 'asc' }, { slug: 'asc' }],
    });
    const landing = [...roots].sort((a, b) => b._count.children - a._count.children)[0]!;

    const collection = await prisma.collection.findFirstOrThrow({
      where: { isActive: true, deletedAt: null, products: { some: {} } },
      orderBy: { slug: 'asc' },
      select: { slug: true },
    });

    const product = await prisma.product.findFirstOrThrow({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        variants: {
          some: { attributeValues: { some: { attribute: { showInSwatch: true } } } },
        },
      },
      orderBy: { slug: 'asc' },
      select: { slug: true },
    });

    Object.assign(paths, {
      listing24: `${API}/catalog/products?limit=24`,
      landing: `${API}/catalog/categories/${landing.slug}/landing`,
      categoryDetail: `${API}/catalog/categories/${landing.slug}`,
      tree: `${API}/catalog/categories/tree`,
      navMain: `${API}/navigation/MAIN`,
      collections: `${API}/catalog/collections`,
      collection: `${API}/catalog/collections/${collection.slug}`,
      bannersHomeHero: `${API}/content/banners?placement=HOME_HERO`,
      home: `${API}/content/home`,
      pdp: `${API}/catalog/products/${product.slug}`,
      options: `${API}/catalog/products/${product.slug}/options`,
      filters: `${API}/catalog/filters?categorySlug=${landing.slug}`,
      stores: `${API}/content/stores`,
      testimonials: `${API}/content/testimonials`,
    });

    // Process-level warm-up (search memo, settings, pricing configuration).
    for (const path of Object.values(paths)) await request(app).get(path);
  }, 180_000);

  it('measures the seed as it is', async () => {
    await measureAll('seed');
  }, 180_000);

  it('measures again with media on every reference the contract resolves', async () => {
    const icon = await upload('measure-icon', 400, 400);
    const banner = await upload('measure-banner', 2880, 840);
    const mobile = await upload('measure-mobile', 1600, 2000);
    const swatch = await upload('measure-swatch', 300, 300);
    const photo = await upload('measure-store', 2400, 1600);
    const avatar = await upload('measure-avatar', 600, 600);

    const landingSlug = paths.landing!.split('/').at(-2)!;
    const landing = await prisma.category.findUniqueOrThrow({ where: { slug: landingSlug } });

    await prisma.category.updateMany({ where: { depth: 0 }, data: { iconMediaId: icon } });
    await prisma.category.updateMany({
      where: { parentId: landing.id },
      data: { iconMediaId: icon },
    });
    await prisma.category.update({
      where: { id: landing.id },
      data: { bannerMediaId: banner, mobileBannerMediaId: mobile },
    });
    await prisma.collection.updateMany({
      data: { imageMediaId: icon, bannerMediaId: banner, mobileBannerMediaId: mobile },
    });
    const main = await prisma.navigationMenu.findUniqueOrThrow({ where: { key: 'MAIN' } });
    await prisma.navigationItem.updateMany({
      where: { menuId: main.id, parentId: null },
      data: { iconMediaId: icon },
    });
    await prisma.attributeValue.updateMany({
      where: { attribute: { showInSwatch: true } },
      data: { swatchMediaId: swatch },
    });
    await prisma.storeLocation.updateMany({ data: { mediaIdsJson: JSON.stringify([photo]) } });
    await prisma.testimonial.updateMany({ data: { avatarMediaId: avatar } });
    await prisma.banner.updateMany({ data: { mobileMediaId: mobile } });

    await measureAll('media');

    if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(
      report
        .map(
          (row) =>
            `${row.scenario.padEnd(6)} ${row.label.padEnd(16)} q=${String(row.statements).padStart(3)} ` +
            `h=${String(row.header).padStart(4)} ` +
            `raw=${String(row.rawBytes).padStart(7)} gz=${String(row.gzipBytes).padStart(6)}`,
        )
        .join('\n'),
    );
    expect(report.length).toBe(Object.keys(paths).length * 2);
  }, 300_000);
});
