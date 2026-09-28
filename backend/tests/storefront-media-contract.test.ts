import sharp from 'sharp';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { CARD_RENDITION_LABELS } from '@shared/constants';
import type { ProductCardDto, ProductImageDto } from '@shared/types/storefront';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { cache, storage } from '../src/container';
import { CATALOG_CACHE_PREFIXES } from '../src/modules/catalog-admin/catalogCache.service';
import { pageRendererService } from '../src/modules/cms/pageRenderer.service';
import { mediaService } from '../src/modules/media/media.service';

import { uploadGalleryImages } from './helpers/galleryImages';
import { countQueries } from './helpers/queryCounter';

/**
 * The storefront media contract (PROJECT_CONTEXT §51): every image a public payload shows arrives
 * with a URL the storage driver produced, so the storefront never builds one.
 */

const app = createApp();
const API = '/api/v1';

/** What `storage.url()` prefixes every key with; derived, so the test follows the driver. */
const BASE = storage.url('probe').slice(0, -'probe'.length);

interface MediaObject {
  id?: string;
  mediaId?: string;
  mimeType?: string;
  url: string;
  sources: { label: string; url: string; path?: string }[];
}

/** Every object in a payload that carries a `sources` array: CMS media and card images alike. */
function mediaObjectsIn(value: unknown, found: MediaObject[] = []): MediaObject[] {
  if (Array.isArray(value)) {
    for (const entry of value) mediaObjectsIn(entry, found);
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.sources) && typeof record.url === 'string') {
      found.push(record as unknown as MediaObject);
    }
    for (const entry of Object.values(record)) mediaObjectsIn(entry, found);
  }
  return found;
}

function expectDriverUrls(objects: MediaObject[]): void {
  for (const object of objects) {
    expect(object.url.startsWith(BASE), object.url).toBe(true);
    for (const source of object.sources) {
      expect(source.url.startsWith(BASE), `${source.label} ${source.url}`).toBe(true);
    }
  }
}

async function readyImageIds(count: number): Promise<string[]> {
  const rows = await prisma.media.findMany({
    where: { kind: 'IMAGE', status: 'READY', deletedAt: null, variants: { some: {} } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: count,
  });
  expect(rows).toHaveLength(count);
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  // G1: the prefix must be a real absolute base, or every startsWith below proves nothing.
  expect(BASE).toMatch(/^https?:\/\/.+\/$/);
});

/* ------------------------------------------------------------ BC-1: CMS media */

describe('BC-1 CMS media carries driver URLs', () => {
  it('gives every media object on the home page absolute URLs and keeps the storage path', async () => {
    const response = await request(app).get(`${API}/content/home`);
    expect(response.status).toBe(200);

    const objects = mediaObjectsIn(response.body.data);
    const cms = objects.filter((object) => object.mimeType !== undefined);

    // G1: two hero slides, two split panels and the story image at the very least.
    expect(cms.length).toBeGreaterThanOrEqual(5);
    expectDriverUrls(objects);

    for (const object of cms) {
      expect(object.sources.length, object.id).toBeGreaterThan(0);
      for (const source of object.sources) {
        expect(typeof source.path).toBe('string');
        expect(source.path!.startsWith('http')).toBe(false);
        expect(source.url).toBe(storage.url(source.path!));
      }
    }
  });

  it('resolves a page’s hero, social image and block media the same way', async () => {
    const [hero, og, story] = await readyImageIds(3);
    const page = await prisma.page.findUniqueOrThrow({ where: { slug: 'about-us' } });
    await prisma.page.update({
      where: { id: page.id },
      data: { heroMediaId: hero, ogMediaId: og },
    });
    await prisma.pageBlock.create({
      data: {
        pageId: page.id,
        type: 'IMAGE_WITH_TEXT',
        position: 950,
        isActive: true,
        configJson: JSON.stringify({ mediaId: story, headline: 'Workshop', body: 'Made here.' }),
      },
    });
    await cache.delByPrefix(CATALOG_CACHE_PREFIXES.cmsPage);

    const response = await request(app).get(`${API}/content/pages/about-us`);
    expect(response.status).toBe(200);

    const data = response.body.data as {
      heroMedia: MediaObject | null;
      seo: { ogMedia: MediaObject | null };
      blocks: { type: string; data: { media?: MediaObject | null } }[];
    };
    const block = data.blocks.find((entry) => entry.type === 'IMAGE_WITH_TEXT');

    expect(data.heroMedia?.id).toBe(hero);
    expect(data.seo.ogMedia?.id).toBe(og);
    expect(block?.data.media?.id).toBe(story);
    expectDriverUrls([data.heroMedia!, data.seo.ogMedia!, block!.data.media!]);
  });

  it('serves the driver’s URL, not the Media.url column written at upload time', async () => {
    const home = await prisma.page.findUniqueOrThrow({
      where: { slug: 'home' },
      include: { blocks: { where: { type: 'HERO_SLIDER' } } },
    });
    const config = JSON.parse(home.blocks[0]!.configJson) as { slides: { mediaId: string }[] };
    const mediaId = config.slides[0]!.mediaId;
    const row = await prisma.media.update({
      where: { id: mediaId },
      data: { url: 'https://stale.example.invalid/old.jpg' },
    });

    const page = await pageRendererService.renderHome({ device: 'DESKTOP' });
    const slider = page.blocks.find((block) => block.type === 'HERO_SLIDER')!;
    const slide = (slider.data.slides as { media: MediaObject | null }[])[0]!;

    expect(slide.media?.url).toBe(storage.url(row.path));
    expect(slide.media?.url).not.toContain('stale.example.invalid');
  });

  it('hydrates category icons, collection banners, avatars and logos at no extra statement', async () => {
    const home = await prisma.page.findUniqueOrThrow({
      where: { slug: 'home' },
      include: { blocks: true },
    });
    const configOf = (type: string) =>
      JSON.parse(home.blocks.find((block) => block.type === type)!.configJson) as Record<
        string,
        unknown
      >;
    const categoryId = (configOf('CATEGORY_CIRCLES').categoryIds as string[])[0]!;
    const collectionId = configOf('COUNTDOWN_DEAL').collectionId as string;
    const brand = await prisma.brand.findFirstOrThrow({
      where: { deletedAt: null, logoMediaId: { not: null } },
    });

    await prisma.pageBlock.create({
      data: {
        pageId: home.id,
        type: 'BRAND_STRIP',
        position: 960,
        isActive: true,
        configJson: JSON.stringify({ brandIds: [brand.id] }),
      },
    });

    const render = () => pageRendererService.renderHome({ device: 'DESKTOP' });
    const before = await countQueries(render);

    const [icon, banner, avatar] = await readyImageIds(3);
    await prisma.category.update({ where: { id: categoryId }, data: { iconMediaId: icon } });
    await prisma.collection.update({
      where: { id: collectionId },
      data: { bannerMediaId: banner },
    });
    await prisma.testimonial.updateMany({ data: { avatarMediaId: avatar } });

    const after = await countQueries(render);
    const blockData = (type: string) =>
      after.result.blocks.find((block) => block.type === type)!.data as Record<string, unknown>;

    const circle = (
      blockData('CATEGORY_CIRCLES').categories as { id: string; icon: MediaObject | null }[]
    ).find((entry) => entry.id === categoryId);
    const deal = blockData('COUNTDOWN_DEAL').collection as { banner: MediaObject | null };
    const quote = (blockData('TESTIMONIALS').testimonials as { avatar: MediaObject | null }[])[0];
    const logo = (blockData('BRAND_STRIP').brands as { logo: MediaObject | null }[])[0];

    expect(circle?.icon?.id).toBe(icon);
    expect(deal.banner?.id).toBe(banner);
    expect(quote?.avatar?.id).toBe(avatar);
    expect(logo?.logo?.id).toBe(brand.logoMediaId);
    expectDriverUrls([circle!.icon!, deal.banner!, quote!.avatar!, logo!.logo!]);

    // G1: a count of zero would equal zero; the page does real work.
    expect(before.count).toBeGreaterThan(5);
    expect(after.count, 'resolving these ids must reuse the page’s one media query').toBe(
      before.count,
    );
  });
});

/* ------------------------------------------------------ BC-2: hover image on cards */

async function cardsFor(ids: string[]): Promise<Map<string, ProductCardDto>> {
  const response = await request(app).post(`${API}/catalog/products/batch`).send({ ids });
  expect(response.status).toBe(200);
  const cards = response.body.data as ProductCardDto[];
  return new Map(cards.map((card) => [card.id, card]));
}

function squares(image: ProductImageDto | null): { width: number; height: number }[] {
  return (image?.sources ?? []).filter((source) => source.label === 'SQUARE');
}

describe('BC-2 cards carry the first generic HOVER image', () => {
  let products: {
    id: string;
    variantId: string;
    attributeValueId: string;
    primary: { id: string; mediaId: string };
    hover: { id: string; mediaId: string };
  }[] = [];

  beforeAll(async () => {
    const rows = await prisma.product.findMany({
      where: {
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        deletedAt: null,
        media: { some: { role: 'HOVER', variantId: null, attributeValueId: null } },
        variants: { some: { deletedAt: null, attributeValues: { some: {} } } },
      },
      include: {
        media: { orderBy: { position: 'asc' } },
        variants: { where: { deletedAt: null }, include: { attributeValues: true } },
      },
      orderBy: { slug: 'asc' },
      take: 5,
    });
    // G1: every case below needs its own product.
    expect(rows).toHaveLength(5);

    products = rows.map((row) => {
      const variant = row.variants.find((entry) => entry.attributeValues.length > 0)!;
      const primary = row.media.find((link) => link.role === 'PRIMARY')!;
      const hover = row.media.find(
        (link) => link.role === 'HOVER' && !link.variantId && !link.attributeValueId,
      )!;
      return {
        id: row.id,
        variantId: variant.id,
        attributeValueId: variant.attributeValues[0]!.attributeValueId,
        primary: { id: primary.id, mediaId: primary.mediaId },
        hover: { id: hover.id, mediaId: hover.mediaId },
      };
    });
  });

  it('gives a card its PRIMARY and its generic HOVER, with the same renditions', async () => {
    const [product] = products;
    const card = (await cardsFor([product!.id])).get(product!.id)!;

    expect(card.image?.mediaId).toBe(product!.primary.mediaId);
    expect(card.hoverImage?.mediaId).toBe(product!.hover.mediaId);

    const labels = (image: ProductImageDto) => [...new Set(image.sources.map((s) => s.label))];
    // G1: an image with no sources would match another with none.
    expect(card.hoverImage!.sources.length).toBeGreaterThan(0);
    expect(labels(card.hoverImage!).sort()).toEqual(labels(card.image!).sort());
    expectDriverUrls([card.image as MediaObject, card.hoverImage as MediaObject]);
  });

  it('gives a card without a HOVER image hoverImage: null and keeps its image', async () => {
    const product = products[1]!;
    await prisma.productMedia.deleteMany({ where: { productId: product.id, role: 'HOVER' } });

    const card = (await cardsFor([product.id])).get(product.id)!;
    expect(card.image?.mediaId).toBe(product.primary.mediaId);
    expect(card.hoverImage).toBeNull();
  });

  it('never uses a variant- or colour-scoped HOVER, even at a lower position', async () => {
    const product = products[2]!;
    await prisma.productMedia.deleteMany({ where: { productId: product.id, role: 'HOVER' } });
    const [scopedToVariant, scopedToColour, generic] = await readyImageIds(3);
    await prisma.productMedia.createMany({
      data: [
        {
          productId: product.id,
          mediaId: scopedToVariant!,
          role: 'HOVER',
          position: 0,
          variantId: product.variantId,
        },
        {
          productId: product.id,
          mediaId: scopedToColour!,
          role: 'HOVER',
          position: 0,
          attributeValueId: product.attributeValueId,
        },
      ],
    });

    expect((await cardsFor([product.id])).get(product.id)!.hoverImage).toBeNull();

    await prisma.productMedia.create({
      data: { productId: product.id, mediaId: generic!, role: 'HOVER', position: 90 },
    });
    expect((await cardsFor([product.id])).get(product.id)!.hoverImage?.mediaId).toBe(generic);
  });

  it('skips a generic HOVER whose media was deleted, and picks by role rather than by order', async () => {
    const product = products[3]!;
    await prisma.media.update({
      where: { id: product.hover.mediaId },
      data: { deletedAt: new Date() },
    });
    expect((await cardsFor([product.id])).get(product.id)!.hoverImage).toBeNull();
    await prisma.media.update({ where: { id: product.hover.mediaId }, data: { deletedAt: null } });

    // No PRIMARY at all: the HOVER is not promoted into `image`.
    await prisma.productMedia.delete({ where: { id: product.primary.id } });
    const card = (await cardsFor([product.id])).get(product.id)!;
    expect(card.image).toBeNull();
    expect(card.hoverImage?.mediaId).toBe(product.hover.mediaId);
  });
});

describe('BC-2b card images carry a SQUARE rendition', () => {
  it('lists SQUARE among the card renditions', () => {
    expect(CARD_RENDITION_LABELS).toContain('SQUARE');
  });

  it('is 800 x 800 for a product-sized source and never upscales a smaller one', async () => {
    const product = await prisma.product.findFirstOrThrow({
      where: {
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        deletedAt: null,
        media: { some: { role: 'HOVER', variantId: null, attributeValueId: null } },
      },
      include: { media: true },
      orderBy: { slug: 'desc' },
    });
    const [large] = await uploadGalleryImages(1);
    const small = (
      await mediaService.upload({
        buffer: await sharp({
          create: { width: 900, height: 600, channels: 3, background: { r: 90, g: 60, b: 40 } },
        })
          .jpeg()
          .toBuffer(),
        originalName: 'legacy-small-hover.jpg',
        declaredMimeType: 'image/jpeg',
      })
    ).media;

    const primary = product.media.find((link) => link.role === 'PRIMARY')!;
    const hover = product.media.find(
      (link) => link.role === 'HOVER' && !link.variantId && !link.attributeValueId,
    )!;
    await prisma.productMedia.update({ where: { id: primary.id }, data: { mediaId: large! } });
    await prisma.productMedia.update({ where: { id: hover.id }, data: { mediaId: small.id } });

    const card = (await cardsFor([product.id])).get(product.id)!;
    const largeSquares = squares(card.image);
    const smallSquares = squares(card.hoverImage);

    // G1: one entry per emitted format, so none would pass every check below.
    expect(largeSquares.length).toBeGreaterThan(0);
    expect(smallSquares.length).toBeGreaterThan(0);
    for (const square of largeSquares) expect(square).toMatchObject({ width: 800, height: 800 });
    // sharp's withoutEnlargement keeps each side at min(source, 800): 900 x 600 gives 800 x 600,
    // never a larger box (PROJECT_CONTEXT §51, known limitations).
    for (const square of smallSquares) expect(square).toMatchObject({ width: 800, height: 600 });
  });
});
