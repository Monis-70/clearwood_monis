import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { pageRendererService } from '../src/modules/cms/pageRenderer.service';

import { countQueries } from './helpers/queryCounter';

/**
 * Prompt 10A slice 1 - page hydration and its query budget.
 *
 * The budget is the point of this file. A renderer that loops blocks and fetches per block passes
 * every functional assertion below and then costs one query per block on the single most requested
 * URL on the site. So the count is asserted as a NUMBER, and the ceiling is recorded in
 * PROJECT_CONTEXT section 26 alongside it.
 */

const app = createApp();
const API = '/api/v1';

/**
 * MEASURED cost of hydrating the seeded 13-block home page (28 distinct products), plus headroom.
 *
 * Prompt B1 batched the pricing context loader, which took this from 125 to 41. The pricing engine
 * now costs a flat ~17 regardless of how many products are on the page, instead of three queries
 * per product line; hydration's own overhead is the remaining ~24 and was always flat.
 *
 * The ceiling guards against a regression. `does not grow when blocks are added` below guards
 * against the thing a ceiling alone cannot catch. Recorded in PROJECT_CONTEXT section 26.
 */
const HOME_QUERY_CEILING = 50;

/** What the renderer itself costs once the pricing engine's lookups are excluded. */
const HYDRATION_OVERHEAD_CEILING = 30;

let homeBlockCount = 0;

beforeAll(async () => {
  const home = await prisma.page.findUniqueOrThrow({ where: { slug: 'home' } });
  homeBlockCount = await prisma.pageBlock.count({ where: { pageId: home.id } });
});

describe('home page hydration', () => {
  it('has a seeded home page with a real block list', async () => {
    // G1: every assertion below is vacuous if the page has no blocks.
    expect(homeBlockCount).toBeGreaterThanOrEqual(13);
  });

  it('hydrates every block in one request', async () => {
    const page = await pageRendererService.renderHome({ device: 'DESKTOP' });

    expect(page.slug).toBe('home');
    expect(page.blocks.length).toBe(homeBlockCount);

    const types = page.blocks.map((block) => block.type);

    expect(types).toContain('HERO_SLIDER');
    expect(types).toContain('CATEGORY_CIRCLES');
    expect(types).toContain('PRODUCT_CAROUSEL');
    expect(types).toContain('FAQ_ACCORDION');
    expect(types).toContain('TESTIMONIALS');

    // Blocks are returned in the order an admin arranged them.
    const positions = page.blocks.map((block) => block.position);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  /** THE N+1 guard. Asserts a number, not a vibe. */
  it('stays inside its query budget', async () => {
    const { result, count, statements } = await countQueries(() =>
      pageRendererService.renderHome({ device: 'DESKTOP' }),
    );

    // G1: zero queries would pass any ceiling. Prove work actually happened.
    expect(count).toBeGreaterThan(5);
    expect(result.blocks.length).toBe(homeBlockCount);

    // The schema name is `main` on SQLite and the database name on MySQL, so it is not matched:
    // pinning it made every pricing query invisible and charged all 41 to hydration.
    const pricingQueries = statements.filter((sql) =>
      /FROM `[^`]+`\.`(Category|VariantAttributeValue|TaxClass|ShippingZone|Coupon|DiscountRule|TierPrice|PriceListItem|PriceAdjustment|CustomerGroup)`/.test(
        sql,
      ),
    ).length;

    const overhead = count - pricingQueries;

    expect(
      count,
      `Hydrating ${homeBlockCount} blocks cost ${count} queries (ceiling ${HOME_QUERY_CEILING}), ` +
        `of which ${pricingQueries} are the pricing engine and ${overhead} are hydration itself.`,
    ).toBeLessThanOrEqual(HOME_QUERY_CEILING);

    expect(
      overhead,
      `Hydration's own cost is ${overhead} queries (ceiling ${HYDRATION_OVERHEAD_CEILING}). ` +
        'If this grew, batch it - do not raise the ceiling.',
    ).toBeLessThanOrEqual(HYDRATION_OVERHEAD_CEILING);
  });

  /**
   * The assertion a ceiling alone cannot make: adding blocks must cost NOTHING extra when they
   * reference data the page already loads. This is what fails the moment somebody fetches per
   * block.
   */
  it('does not grow when blocks are added', async () => {
    const home = await prisma.page.findUniqueOrThrow({ where: { slug: 'home' } });

    const before = await countQueries(() => pageRendererService.renderHome({ device: 'DESKTOP' }));

    const added = await prisma.$transaction(
      [910, 911, 912, 913, 914].map((position) =>
        prisma.pageBlock.create({
          data: {
            pageId: home.id,
            type: 'SPACER',
            position,
            isActive: true,
            configJson: JSON.stringify({ heightPx: 48, showDivider: false }),
          },
        }),
      ),
    );

    try {
      const after = await countQueries(() => pageRendererService.renderHome({ device: 'DESKTOP' }));

      expect(after.result.blocks.length).toBe(before.result.blocks.length + 5);
      expect(before.count).toBeGreaterThan(5);

      expect(
        after.count,
        `Five extra blocks cost ${after.count - before.count} extra queries. ` +
          'Hydration must batch across blocks, not fetch per block.',
      ).toBe(before.count);
    } finally {
      await prisma.pageBlock.deleteMany({ where: { id: { in: added.map((row) => row.id) } } });
    }
  });

  it('prices product blocks through the pricing facade and declares the basis', async () => {
    const page = await pageRendererService.renderHome({ device: 'DESKTOP' });

    expect(page.pricingBasis).toBe('DEFAULT_GROUP');

    const productBlock = page.blocks.find(
      (block) => block.type === 'PRODUCT_CAROUSEL' || block.type === 'PRODUCT_GRID',
    );

    expect(productBlock).toBeDefined();

    const products = (productBlock!.data.products ?? []) as { id: string; pricePaise: number }[];

    // G1: an empty product list would make the price assertions below prove nothing.
    expect(products.length).toBeGreaterThan(0);

    for (const product of products) {
      expect(product.pricePaise).toBeGreaterThan(0);
    }
  });

  it('resolves categories, testimonials and FAQs into render-ready data', async () => {
    const page = await pageRendererService.renderHome({ device: 'DESKTOP' });

    const circles = page.blocks.find((block) => block.type === 'CATEGORY_CIRCLES');
    const categories = (circles?.data.categories ?? []) as { slug: string; name: string }[];
    expect(categories.length).toBeGreaterThanOrEqual(10);
    expect(categories[0].slug).toBeTruthy();

    const testimonials = page.blocks.find((block) => block.type === 'TESTIMONIALS');
    const quotes = (testimonials?.data.testimonials ?? []) as { quote: string }[];
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes[0].quote.length).toBeGreaterThan(20);

    const faqBlock = page.blocks.find((block) => block.type === 'FAQ_ACCORDION');
    const faqs = (faqBlock?.data.faqs ?? []) as { question: string; answer: string }[];
    expect(faqs.length).toBeGreaterThan(0);
    expect(faqs[0].answer.length).toBeGreaterThan(20);
  });

  it('drops a block whose device does not match', async () => {
    const home = await prisma.page.findUniqueOrThrow({ where: { slug: 'home' } });

    const block = await prisma.pageBlock.create({
      data: {
        pageId: home.id,
        type: 'SPACER',
        position: 900,
        isActive: true,
        deviceVisibility: 'MOBILE_ONLY',
        configJson: JSON.stringify({ heightPx: 48, showDivider: false }),
      },
    });

    try {
      const desktop = await pageRendererService.renderHome({ device: 'DESKTOP' });
      const mobile = await pageRendererService.renderHome({ device: 'MOBILE' });

      expect(desktop.blocks.some((entry) => entry.id === block.id)).toBe(false);
      expect(mobile.blocks.some((entry) => entry.id === block.id)).toBe(true);
    } finally {
      await prisma.pageBlock.delete({ where: { id: block.id } });
    }
  });

  it('drops a block outside its schedule window', async () => {
    const home = await prisma.page.findUniqueOrThrow({ where: { slug: 'home' } });

    const expired = await prisma.pageBlock.create({
      data: {
        pageId: home.id,
        type: 'SPACER',
        position: 901,
        isActive: true,
        configJson: JSON.stringify({ heightPx: 48, showDivider: false }),
        startsAt: new Date(Date.now() - 4 * 86_400_000),
        endsAt: new Date(Date.now() - 86_400_000),
      },
    });

    const future = await prisma.pageBlock.create({
      data: {
        pageId: home.id,
        type: 'SPACER',
        position: 902,
        isActive: true,
        configJson: JSON.stringify({ heightPx: 48, showDivider: false }),
        startsAt: new Date(Date.now() + 86_400_000),
      },
    });

    try {
      const page = await pageRendererService.renderHome({ device: 'DESKTOP' });
      const ids = page.blocks.map((block) => block.id);

      expect(ids.length).toBeGreaterThan(0);
      expect(ids).not.toContain(expired.id);
      expect(ids).not.toContain(future.id);
    } finally {
      await prisma.pageBlock.deleteMany({ where: { id: { in: [expired.id, future.id] } } });
    }
  });

  /** A page written by a newer deployment must not break the storefront after a rollback. */
  it('filters an unknown block type instead of throwing', async () => {
    const home = await prisma.page.findUniqueOrThrow({ where: { slug: 'home' } });

    const alien = await prisma.pageBlock.create({
      data: {
        pageId: home.id,
        type: 'BLOCK_FROM_THE_FUTURE',
        position: 903,
        isActive: true,
        configJson: JSON.stringify({ anything: true }),
      },
    });

    try {
      const page = await pageRendererService.renderHome({ device: 'DESKTOP' });

      expect(page.blocks.length).toBeGreaterThan(0);
      expect(page.blocks.some((block) => block.id === alien.id)).toBe(false);
    } finally {
      await prisma.pageBlock.delete({ where: { id: alien.id } });
    }
  });
});

/* -------------------------------------------------------------- over HTTP */

describe('the public content routes', () => {
  it('serves the hydrated home page', async () => {
    const response = await request(app).get(`${API}/content/home`);

    expect(response.status, JSON.stringify(response.body).slice(0, 300)).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.blocks.length).toBe(homeBlockCount);
    expect(response.body.data.pricingBasis).toBe('DEFAULT_GROUP');
  });

  it('returns 304 when the ETag matches', async () => {
    const first = await request(app).get(`${API}/content/home`);
    const etag = first.headers.etag;

    expect(etag).toBeTruthy();

    const second = await request(app).get(`${API}/content/home`).set('If-None-Match', etag);

    expect(second.status).toBe(304);
  });

  it('serves a published policy page with its sanitised body', async () => {
    const response = await request(app).get(`${API}/content/pages/privacy-policy`);

    expect(response.status).toBe(200);
    expect(response.body.data.title).toBe('Privacy policy');

    const rich = response.body.data.blocks.find(
      (block: { type: string }) => block.type === 'RICH_TEXT',
    );

    expect(rich).toBeDefined();
    expect(String(rich.config.html).length).toBeGreaterThan(200);
    expect(String(rich.config.html)).not.toMatch(/<script/i);
  });

  it('404s an unknown slug', async () => {
    const response = await request(app).get(`${API}/content/pages/not-a-real-page`);
    expect(response.status).toBe(404);
  });

  it('serves live banners for a placement', async () => {
    const response = await request(app).get(`${API}/content/banners?placement=HOME_HERO`);

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);

    for (const banner of response.body.data as { placement: string }[]) {
      expect(banner.placement).toBe('HOME_HERO');
    }
  });

  it('accepts an impression without making the caller wait on it', async () => {
    const banner = await prisma.banner.findFirstOrThrow({ where: { deletedAt: null } });

    const response = await request(app).post(`${API}/content/banners/${banner.id}/impression`);

    expect(response.status).toBe(202);
    expect(response.body.data.accepted).toBe(true);
  });

  it('serves the announcement bar', async () => {
    const response = await request(app).get(`${API}/content/announcement`);

    expect(response.status).toBe(200);
    expect(response.body.data).not.toBeNull();
    expect(String(response.body.data.message).length).toBeGreaterThan(10);
  });
});
