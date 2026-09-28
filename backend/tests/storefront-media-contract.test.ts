import sharp from 'sharp';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { CARD_RENDITION_LABELS, PUBLIC_IMAGE_RENDITIONS } from '@shared/constants';
import type { ProductCardDto, ProductImageDto, PublicImageDto } from '@shared/types/storefront';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { cache, storage } from '../src/container';
import {
  CATALOG_CACHE_PREFIXES,
  catalogCacheService,
} from '../src/modules/catalog-admin/catalogCache.service';
import { pageRendererService } from '../src/modules/cms/pageRenderer.service';
import { mediaService } from '../src/modules/media/media.service';
import { publicImageService, swatchImageOf } from '../src/modules/media/publicImage.service';
import { requestScope } from '../src/utils/requestScope';

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

/* -------------------------------------- BC-3: media wherever a DTO had only an id */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Resolved {
  id: string | null;
  image: PublicImageDto | null;
}

interface Surface {
  name: string;
  /** Distinct public read, for the statement comparison. */
  path: string;
  labels: readonly string[];
  set(mediaId: string | null): Promise<unknown>;
  read(): Promise<Resolved>;
}

async function dropCaches(): Promise<void> {
  for (const prefix of Object.values(CATALOG_CACHE_PREFIXES)) await cache.delByPrefix(prefix);
}

async function getData(path: string, method: 'get' | 'post' = 'get', body?: object): Promise<Json> {
  const response =
    method === 'post'
      ? await request(app).post(`${API}${path}`).send(body)
      : await request(app).get(`${API}${path}`);
  expect(response.status, `${path}: ${response.text.slice(0, 300)}`).toBe(200);
  return response.body.data as Json;
}

async function uploadImage(name: string, width: number, height: number, red: number) {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: red, g: 120, b: 90 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const result = await mediaService.upload({
    buffer,
    originalName: `${name}.jpg`,
    declaredMimeType: 'image/jpeg',
  });
  expect(result.deduplicated).toBe(false);
  return result.media;
}

function findNode(nodes: Json[], id: string): Json | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inChild = findNode((node.children ?? []) as Json[], id);
    if (inChild) return inChild;
  }
  return undefined;
}

describe('BC-3 public DTOs resolve the media they reference', () => {
  const surfaces: Surface[] = [];
  const media = { ready: '', deleted: '', failed: '' };

  beforeAll(async () => {
    const ready = await uploadImage('bc3-ready', 2000, 1200, 150);
    const deleted = await uploadImage('bc3-deleted', 2000, 1200, 60);
    const failed = await uploadImage('bc3-failed', 2000, 1200, 200);
    await prisma.media.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    await prisma.media.update({ where: { id: failed.id }, data: { status: 'FAILED' } });
    Object.assign(media, { ready: ready.id, deleted: deleted.id, failed: failed.id });

    const roots = await prisma.category.findMany({
      where: { depth: 0, isActive: true, deletedAt: null },
      include: { children: { where: { isActive: true, deletedAt: null } } },
      orderBy: { slug: 'asc' },
    });
    const landing = [...roots].sort((a, b) => b.children.length - a.children.length)[0]!;
    const child = [...landing.children].sort((a, b) => a.slug.localeCompare(b.slug))[0]!;
    const collection = await prisma.collection.findFirstOrThrow({
      where: { isActive: true, deletedAt: null, products: { some: {} } },
      orderBy: { slug: 'asc' },
    });
    const strip = await prisma.banner.findFirstOrThrow({
      where: { placement: 'HOME_STRIP', deletedAt: null, isActive: true },
    });
    const hero = await prisma.banner.findFirstOrThrow({
      where: { placement: 'HOME_HERO', deletedAt: null, isActive: true },
      orderBy: { position: 'asc' },
    });
    const main = await prisma.navigationMenu.findUniqueOrThrow({ where: { key: 'MAIN' } });
    const navItem = await prisma.navigationItem.findFirstOrThrow({
      where: { menuId: main.id, parentId: null, isActive: true, type: { not: 'CATEGORY' } },
      orderBy: { position: 'asc' },
    });
    const store = await prisma.storeLocation.findFirstOrThrow({ where: { isActive: true } });
    const testimonial = await prisma.testimonial.findFirstOrThrow({ where: { isActive: true } });

    // A swatch-bearing product with a live variant, and the filterable value it shows.
    const link = await prisma.variantAttributeValue.findFirstOrThrow({
      where: {
        attribute: { showInSwatch: true, isFilterable: true },
        variant: {
          deletedAt: null,
          isActive: true,
          product: { status: 'ACTIVE', visibility: 'PUBLIC', deletedAt: null },
        },
      },
      include: {
        variant: {
          include: {
            product: { include: { categories: { where: { isPrimary: true } } } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    const product = link.variant.product;
    const scope = await prisma.category.findUniqueOrThrow({
      where: { id: product.categories[0]!.categoryId },
    });

    // A store locator on a page, for the CMS store photos.
    const about = await prisma.page.findUniqueOrThrow({ where: { slug: 'about-us' } });
    await prisma.pageBlock.create({
      data: {
        pageId: about.id,
        type: 'STORE_LOCATOR',
        position: 970,
        isActive: true,
        configJson: JSON.stringify({ showMap: false }),
      },
    });

    const { banner, collectionBanner, collectionImage, categoryTile, icon, swatch } =
      PUBLIC_IMAGE_RENDITIONS;
    const category = (id: string, field: string) => (mediaId: string | null) =>
      prisma.category.update({ where: { id }, data: { [field]: mediaId } });

    surfaces.push(
      {
        name: 'landing category banner',
        path: `/catalog/categories/${landing.slug}/landing`,
        labels: banner,
        set: category(landing.id, 'bannerMediaId'),
        read: async () => {
          const data = await getData(`/catalog/categories/${landing.slug}/landing`);
          return { id: data.category.bannerMediaId, image: data.category.bannerMedia };
        },
      },
      {
        name: 'landing category mobile banner',
        path: `/catalog/categories/${landing.slug}/landing`,
        labels: banner,
        set: category(landing.id, 'mobileBannerMediaId'),
        read: async () => {
          const data = await getData(`/catalog/categories/${landing.slug}/landing`);
          return { id: data.category.mobileBannerMediaId, image: data.category.mobileBannerMedia };
        },
      },
      {
        name: 'landing child tile',
        path: `/catalog/categories/${landing.slug}/landing`,
        labels: categoryTile,
        set: category(child.id, 'iconMediaId'),
        read: async () => {
          const data = await getData(`/catalog/categories/${landing.slug}/landing`);
          const entry = (data.children as Json[]).find((node) => node.id === child.id)!;
          return { id: entry.iconMediaId, image: entry.iconMedia };
        },
      },
      {
        name: 'category tree icon',
        path: '/catalog/categories/tree',
        labels: icon,
        set: category(landing.id, 'iconMediaId'),
        read: async () => {
          const node = findNode((await getData('/catalog/categories/tree')) as Json[], landing.id)!;
          return { id: node.iconMediaId, image: node.iconMedia };
        },
      },
      {
        name: 'category detail banner',
        path: `/catalog/categories/${landing.slug}`,
        labels: banner,
        set: category(landing.id, 'bannerMediaId'),
        read: async () => {
          const data = await getData(`/catalog/categories/${landing.slug}`);
          return { id: data.bannerMediaId, image: data.bannerMedia };
        },
      },
      {
        name: 'category detail child icon',
        path: `/catalog/categories/${landing.slug}`,
        labels: icon,
        set: category(child.id, 'iconMediaId'),
        read: async () => {
          const data = await getData(`/catalog/categories/${landing.slug}`);
          const entry = (data.children as Json[]).find((node) => node.id === child.id)!;
          return { id: entry.iconMediaId, image: entry.iconMedia };
        },
      },
      {
        name: 'collection list image',
        path: '/catalog/collections',
        labels: collectionImage,
        set: (id) =>
          prisma.collection.update({ where: { id: collection.id }, data: { imageMediaId: id } }),
        read: async () => {
          const data = await getData('/catalog/collections');
          const entry = (data as unknown as Json[]).find((row) => row.id === collection.id)!;
          return { id: entry.imageMediaId, image: entry.image };
        },
      },
      {
        name: 'collection detail banners',
        path: `/catalog/collections/${collection.slug}`,
        labels: collectionBanner,
        set: (id) =>
          prisma.collection.update({
            where: { id: collection.id },
            data: { bannerMediaId: id, mobileBannerMediaId: id },
          }),
        read: async () => {
          const data = await getData(`/catalog/collections/${collection.slug}`);
          expect(data.collection.mobileBanner?.mediaId ?? null).toBe(
            data.collection.banner?.mediaId ?? null,
          );
          return { id: data.collection.bannerMediaId, image: data.collection.banner };
        },
      },
      {
        name: 'banner placement',
        path: '/content/banners?placement=HOME_STRIP',
        labels: banner,
        set: (id) =>
          prisma.banner.update({
            where: { id: strip.id },
            data: { mediaId: id, mobileMediaId: id },
          }),
        read: async () => {
          const data = await getData('/content/banners?placement=HOME_STRIP');
          const entry = (data as unknown as Json[]).find((row) => row.id === strip.id)!;
          expect(entry.mobileMedia?.mediaId ?? null).toBe(entry.media?.mediaId ?? null);
          return { id: entry.mediaId, image: entry.media };
        },
      },
      {
        name: 'hero slider banner (CMS)',
        path: '/content/home',
        labels: banner,
        set: (id) => prisma.banner.update({ where: { id: hero.id }, data: { mediaId: id } }),
        read: async () => {
          const data = await getData('/content/home');
          const slider = (data.blocks as Json[]).find((block) => block.type === 'HERO_SLIDER')!;
          const entry = (slider.data.banners as Json[]).find((row) => row.id === hero.id)!;
          return { id: entry.mediaId, image: entry.media };
        },
      },
      {
        name: 'card swatch',
        path: '/catalog/products/batch',
        labels: swatch,
        set: (id) =>
          prisma.attributeValue.update({
            where: { id: link.attributeValueId },
            data: { swatchMediaId: id },
          }),
        read: async () => {
          const [card] = (await getData('/catalog/products/batch', 'post', {
            ids: [product.id],
          })) as unknown as Json[];
          const entry = (card!.swatches as Json[]).find(
            (row) => row.attributeValueId === link.attributeValueId,
          )!;
          return { id: entry.swatchMediaId, image: entry.swatchImage };
        },
      },
      {
        name: 'facet value swatch',
        path: `/catalog/filters?categorySlug=${scope.slug}`,
        labels: swatch,
        set: (id) =>
          prisma.attributeValue.update({
            where: { id: link.attributeValueId },
            data: { swatchMediaId: id },
          }),
        read: async () => {
          const facets = (await getData(
            `/catalog/filters?categorySlug=${scope.slug}`,
          )) as unknown as Json[];
          const facet = facets.find((row) => row.attributeId === link.attributeId)!;
          const entry = (facet.values as Json[]).find(
            (row) => row.value === link.attributeValueId,
          )!;
          return { id: entry.swatchMediaId, image: entry.swatchImage };
        },
      },
      {
        name: 'option value swatch',
        path: `/catalog/products/${product.slug}/options`,
        labels: swatch,
        set: (id) =>
          prisma.attributeValue.update({
            where: { id: link.attributeValueId },
            data: { swatchMediaId: id },
          }),
        read: async () => {
          const data = await getData(`/catalog/products/${product.slug}/options`);
          const attribute = (data.attributes as Json[]).find(
            (row) => row.attributeId === link.attributeId,
          )!;
          const entry = (attribute.values as Json[]).find(
            (row) => row.valueId === link.attributeValueId,
          )!;
          return { id: entry.swatchMediaId, image: entry.swatchImage };
        },
      },
      {
        name: 'navigation icon',
        path: '/navigation/MAIN',
        labels: icon,
        set: (id) =>
          prisma.navigationItem.update({ where: { id: navItem.id }, data: { iconMediaId: id } }),
        read: async () => {
          const node = findNode((await getData('/navigation/MAIN')).items as Json[], navItem.id)!;
          return { id: node.iconMediaId, image: node.icon };
        },
      },
      {
        name: 'store photo',
        path: '/content/stores',
        labels: PUBLIC_IMAGE_RENDITIONS.storePhoto,
        set: (id) =>
          prisma.storeLocation.update({
            where: { id: store.id },
            data: { mediaIdsJson: id ? JSON.stringify([id]) : null },
          }),
        read: async () => {
          const data = (await getData('/content/stores')) as unknown as Json[];
          const entry = data.find((row) => row.id === store.id)!;
          const ids = entry.mediaIdsJson ? (JSON.parse(entry.mediaIdsJson) as string[]) : [];
          return { id: ids[0] ?? null, image: (entry.images as PublicImageDto[])[0] ?? null };
        },
      },
      {
        name: 'store photo (CMS store locator)',
        path: '/content/pages/about-us',
        labels: PUBLIC_IMAGE_RENDITIONS.storePhoto,
        set: (id) =>
          prisma.storeLocation.update({
            where: { id: store.id },
            data: { mediaIdsJson: id ? JSON.stringify([id]) : null },
          }),
        read: async () => {
          const data = await getData('/content/pages/about-us');
          const block = (data.blocks as Json[]).find((row) => row.type === 'STORE_LOCATOR')!;
          const entry = (block.data.stores as Json[]).find((row) => row.id === store.id)!;
          const ids = entry.mediaIdsJson ? (JSON.parse(entry.mediaIdsJson) as string[]) : [];
          return { id: ids[0] ?? null, image: (entry.images as PublicImageDto[])[0] ?? null };
        },
      },
      {
        name: 'testimonial avatar',
        path: '/content/testimonials',
        labels: PUBLIC_IMAGE_RENDITIONS.avatar,
        set: (id) =>
          prisma.testimonial.update({ where: { id: testimonial.id }, data: { avatarMediaId: id } }),
        read: async () => {
          const data = (await getData('/content/testimonials')) as unknown as Json[];
          const entry = data.find((row) => row.id === testimonial.id)!;
          return { id: entry.avatarMediaId, image: entry.avatar };
        },
      },
    );
  }, 120_000);

  it('covers every surface in the contract', () => {
    // G1: the per-surface loop below proves nothing if the table is empty.
    expect(surfaces.length).toBe(17);
  });

  it('resolves each field when set, and returns null when unset, deleted or not READY', async () => {
    for (const surface of surfaces) {
      await surface.set(null);
      await dropCaches();
      expect(await surface.read(), `${surface.name}: unset`).toEqual({ id: null, image: null });

      await surface.set(media.ready);
      await dropCaches();
      const resolved = await surface.read();
      expect(resolved.id, `${surface.name}: the id is unchanged`).toBe(media.ready);
      expect(resolved.image?.mediaId, `${surface.name}: resolved`).toBe(media.ready);
      const labels = new Set(resolved.image!.sources.map((source) => source.label));
      expect(labels.size, `${surface.name}: has renditions`).toBeGreaterThan(0);
      expect([...labels].sort(), surface.name).toEqual([...surface.labels].sort());
      expectDriverUrls([resolved.image as MediaObject]);

      for (const unusable of [media.deleted, media.failed]) {
        await surface.set(unusable);
        await dropCaches();
        expect(await surface.read(), `${surface.name}: ${unusable}`).toEqual({
          id: unusable,
          image: null,
        });
      }
      await surface.set(null);
    }
  }, 180_000);

  it('adds at most one media statement to any payload, a cold swatch map included', async () => {
    const byPath = new Map(surfaces.map((surface) => [surface.path, surface]));
    const countFor = async (surface: Surface) => {
      await dropCaches();
      return (await countQueries(() => surface.read())).count;
    };

    // No reference of any kind, so the "unset" reads have no media statement to share.
    await prisma.$transaction([
      prisma.banner.updateMany({ data: { mediaId: null, mobileMediaId: null } }),
      prisma.category.updateMany({
        data: { iconMediaId: null, bannerMediaId: null, mobileBannerMediaId: null },
      }),
      prisma.collection.updateMany({
        data: { imageMediaId: null, bannerMediaId: null, mobileBannerMediaId: null },
      }),
      prisma.navigationItem.updateMany({ data: { iconMediaId: null } }),
      prisma.attributeValue.updateMany({ data: { swatchMediaId: null } }),
      prisma.storeLocation.updateMany({ data: { mediaIdsJson: null } }),
      prisma.testimonial.updateMany({ data: { avatarMediaId: null } }),
    ]);
    const unset = new Map<string, number>();
    for (const [path, surface] of byPath) unset.set(path, await countFor(surface));

    for (const surface of surfaces) await surface.set(media.ready);
    const deltas: string[] = [];
    for (const [path, surface] of byPath) {
      const added = (await countFor(surface)) - unset.get(path)!;
      deltas.push(`${path} +${added}`);
      // G1: the unset read did real work, so a difference of zero is a measurement.
      expect(unset.get(path), path).toBeGreaterThan(0);
      // A CMS page folds these ids into the media query it already runs; anything else pays one
      // statement, and a landing or a collection page reads a cold swatch map in that same one.
      const cms = path.startsWith('/content/home') || path.startsWith('/content/pages/');
      expect(added, `${path} added ${added} statements`).toBeGreaterThanOrEqual(cms ? 0 : 1);
      expect(added, `${path} added ${added} statements`).toBeLessThanOrEqual(1);
    }
    console.log(`[media statements] ${deltas.join(' | ')}`);
  }, 180_000);

  it('reads a cold swatch map in the same statement as a payload’s own images', async () => {
    const { banner } = PUBLIC_IMAGE_RENDITIONS;
    await surfaces.find((entry) => entry.name === 'facet value swatch')!.set(media.ready);
    const read = () =>
      requestScope.run(async () => {
        const images = await publicImageService.loadWithSwatches([
          { ids: [media.ready], labels: banner },
        ]);
        // Joins the map the call above started, as a landing's cards and facets do.
        const swatches = await publicImageService.swatches();
        return { image: images.get(media.ready, banner), swatches };
      });

    await dropCaches();
    const expected = await publicImageService.swatches();
    // G1: the map holds the swatch, so the comparisons below compare something.
    expect(swatchImageOf(expected, media.ready)?.mediaId).toBe(media.ready);

    await dropCaches();
    const cold = await countQueries(read);
    expect(cold.count, cold.statements.join('\n')).toBe(1);
    expect(cold.statements[0]).toContain('isSwatch');
    expect(cold.result.image?.mediaId).toBe(media.ready);
    expect(new Set(cold.result.image!.sources.map((source) => source.label))).toEqual(
      new Set(banner),
    );
    expect(cold.result.swatches).toEqual(expected);

    // Warm: the map comes from the cache, the images from their own statement.
    const warm = await countQueries(read);
    expect(warm.count, warm.statements.join('\n')).toBe(1);
    expect(warm.statements[0]).not.toContain('isSwatch');
    expect(warm.result).toEqual(cold.result);
  });

  it('shows a replaced or deleted asset on the next public read, however it was cached', async () => {
    for (const surface of surfaces) await surface.set(media.ready);
    await dropCaches();
    const before = new Map<string, string>();
    for (const surface of surfaces) {
      const { image } = await surface.read();
      before.set(surface.name, image!.url);
    }

    const bytes = await sharp({
      create: { width: 2100, height: 1300, channels: 3, background: { r: 20, g: 180, b: 40 } },
    })
      .jpeg()
      .toBuffer();
    await mediaService.replace(media.ready, { buffer: bytes, originalName: 'bc3-replaced.jpg' });
    const replaced = await prisma.media.findUniqueOrThrow({ where: { id: media.ready } });

    // No manual cache drop from here on: only the media write's own invalidation.
    for (const surface of surfaces) {
      const { image } = await surface.read();
      expect(image?.url, surface.name).toBe(storage.url(replaced.path));
      expect(image?.url, surface.name).not.toBe(before.get(surface.name));
    }

    await mediaService.softDelete(media.ready);
    for (const surface of surfaces) {
      expect((await surface.read()).image, `${surface.name} after delete`).toBeNull();
    }

    await mediaService.restore(media.ready);
    for (const surface of surfaces) {
      expect((await surface.read()).image?.mediaId, `${surface.name} after restore`).toBe(
        media.ready,
      );
    }
  }, 180_000);

  it('drops the swatch map with every attribute write', async () => {
    const surface = surfaces.find((entry) => entry.name === 'facet value swatch')!;
    await surface.set(media.ready);
    await dropCaches();
    expect((await surface.read()).image?.mediaId).toBe(media.ready);

    const other = await uploadImage('bc3-swatch-other', 400, 400, 90);
    await surface.set(other.id);
    await catalogCacheService.invalidateAttributes('structure');

    expect((await surface.read()).image?.mediaId).toBe(other.id);
  });
});
