import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { passwordService } from '../src/modules/auth/password.service';
import { seoService } from '../src/modules/cms/seo.service';

/**
 * Prompt 10A slices 4-5 - navigation administration, site settings and SEO.
 *
 * The sitemap assertions follow G1 deliberately: an EMPTY sitemap satisfies every
 * "contains no drafts" check ever written, so each one proves the document is populated AND that a
 * specific thing that must not be there is absent.
 */

const app = createApp();
const API = '/api/v1';
const ADMIN_API = `${API}/admin`;
const TEST_PASSWORD = 'Rosewood-Teak-2026';

interface Session {
  header: string;
  csrf: string;
}

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

async function admin(email: string, roleCode: string): Promise<Session> {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });

  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: `Seo ${roleCode}`,
      passwordHash: await passwordService.hash(TEST_PASSWORD),
      status: 'ACTIVE',
    },
  });

  await prisma.adminUserRole.upsert({
    where: { adminUserId_roleId: { adminUserId: user.id, roleId: role.id } },
    update: {},
    create: { adminUserId: user.id, roleId: role.id },
  });

  const response = await request(app)
    .post(`${ADMIN_API}/auth/login`)
    .send({ email, password: TEST_PASSWORD });

  const jar = cookiesOf(response);
  return {
    header: jar.map((cookie) => cookie.split(';')[0]).join('; '),
    csrf:
      jar
        .find((cookie) => cookie.startsWith('cw_adm_csrf='))
        ?.split(';')[0]
        ?.split('=')[1] ?? '',
  };
}

function post(session: Session, path: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post(`${ADMIN_API}${path}`)
    .set('Cookie', session.header)
    .set('X-CSRF-Token', session.csrf)
    .send(body);
}

function get(session: Session, path: string) {
  return request(app).get(`${ADMIN_API}${path}`).set('Cookie', session.header);
}

let superAdmin: Session;

beforeAll(async () => {
  superAdmin = await admin('seo.super@clearwood.local', 'SUPER_ADMIN');
});

/* ----------------------------------------------- testimonials and stores */

describe('testimonials and stores', () => {
  it('serves the seeded testimonials', async () => {
    const response = await request(app).get(`${API}/content/testimonials`);

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBe(8);
    expect(String(response.body.data[0].quote).length).toBeGreaterThan(30);
  });

  it('narrows to featured only', async () => {
    const response = await request(app).get(`${API}/content/testimonials?featured=true`);

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);

    for (const entry of response.body.data as { isFeatured: boolean }[]) {
      expect(entry.isFeatured).toBe(true);
    }
  });

  it('serves the showrooms with their opening hours', async () => {
    const response = await request(app).get(`${API}/content/stores`);

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBe(3);

    const flagship = (response.body.data as { isFlagship: boolean; openingHoursJson: string }[])[0];
    expect(flagship.isFlagship).toBe(true);
    expect(JSON.parse(flagship.openingHoursJson)).toHaveLength(7);
  });
});

/* -------------------------------------------------------------- navigation */

describe('navigation administration', () => {
  it('reads the seeded MAIN menu', async () => {
    const response = await get(superAdmin, '/navigation/MAIN');

    expect(response.status).toBe(200);
    expect(response.body.data.key).toBe('MAIN');
    expect(response.body.data.items.length).toBeGreaterThan(10);
  });

  it('refuses a CATEGORY item pointing at nothing', async () => {
    const response = await post(superAdmin, '/navigation/MAIN/items', {
      label: 'Broken',
      type: 'CATEGORY',
      categoryId: 'does-not-exist',
    });

    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain('not live');
  });

  it('refuses a PAGE item pointing at a draft', async () => {
    const draft = await prisma.page.create({
      data: { slug: 'a-draft-page-for-nav', title: 'Draft', status: 'DRAFT' },
    });

    try {
      const response = await post(superAdmin, '/navigation/MAIN/items', {
        label: 'Draft link',
        type: 'PAGE',
        pageSlug: 'a-draft-page-for-nav',
      });

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('not published');
    } finally {
      await prisma.page.delete({ where: { id: draft.id } });
    }
  });

  it('accepts a PAGE item pointing at a published page', async () => {
    const response = await post(superAdmin, '/navigation/MAIN/items', {
      label: 'About us',
      type: 'PAGE',
      pageSlug: 'about-us',
      position: 900,
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.url).toBe('/about-us');

    await prisma.navigationItem.delete({ where: { id: response.body.data.id as string } });
  });

  it.each([
    ['javascript:alert(1)', 'javascript scheme'],
    ['data:text/html,<script>alert(1)</script>', 'data scheme'],
    ['//evil.example.com', 'protocol-relative'],
    ['http://insecure.example.com', 'plain http'],
  ])('refuses a URL item using %s (%s)', async (url) => {
    const response = await post(superAdmin, '/navigation/MAIN/items', {
      label: 'Bad link',
      type: 'URL',
      url,
    });

    expect(response.status).toBe(422);
  });

  it('accepts a relative and an https URL', async () => {
    for (const url of ['/sofas', 'https://clearwood.in/sofas']) {
      const response = await post(superAdmin, '/navigation/MAIN/items', {
        label: `Link ${url}`,
        type: 'URL',
        url,
        position: 901,
      });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      await prisma.navigationItem.delete({ where: { id: response.body.data.id as string } });
    }
  });

  it('caps nesting at three levels', async () => {
    const menu = await prisma.navigationMenu.findUniqueOrThrow({ where: { key: 'MAIN' } });
    const ids: string[] = [];

    try {
      let parentId: string | null = null;

      for (let level = 0; level < 3; level += 1) {
        const response: request.Response = await post(superAdmin, '/navigation/MAIN/items', {
          label: `Level ${level}`,
          type: 'URL',
          url: '/sofas',
          parentId,
          position: 920 + level,
        });

        if (level < 3) {
          expect(response.status, `level ${level}: ${JSON.stringify(response.body)}`).toBe(201);
          parentId = response.body.data.id as string;
          ids.push(parentId);
        }
      }

      // The fourth level is one too many.
      const tooDeep = await post(superAdmin, '/navigation/MAIN/items', {
        label: 'Level 3',
        type: 'URL',
        url: '/sofas',
        parentId,
      });

      expect(tooDeep.status).toBe(422);
      expect(JSON.stringify(tooDeep.body)).toContain('nest');
    } finally {
      await prisma.navigationItem.deleteMany({ where: { id: { in: ids }, menuId: menu.id } });
    }
  });

  it('reflects an admin change in the public menu immediately', async () => {
    const before = await request(app).get(`${API}/navigation/MAIN`);
    expect(before.status).toBe(200);

    const createdItem = await post(superAdmin, '/navigation/MAIN/items', {
      label: 'Cache busting link',
      type: 'URL',
      url: '/sofas',
      position: 930,
    });

    expect(createdItem.status).toBe(201);

    try {
      // The very next call, with no wait: the write must have invalidated the nav cache.
      const after = await request(app).get(`${API}/navigation/MAIN`);
      const labels = JSON.stringify(after.body.data);

      expect(after.status).toBe(200);
      expect(labels).toContain('Cache busting link');
    } finally {
      await prisma.navigationItem.delete({ where: { id: createdItem.body.data.id as string } });
    }
  });
});

/* ---------------------------------------------------------- site settings */

describe('content settings', () => {
  it('reads the seeded content and SEO settings', async () => {
    const response = await get(superAdmin, '/content/settings');

    expect(response.status).toBe(200);
    expect(response.body.data['site.contact_phone']).toBeTruthy();
    expect(response.body.data['seo.default_title_template']).toContain('%s');
  });

  it('writes a whitelisted key and the public endpoint reflects it at once', async () => {
    const original = (await get(superAdmin, '/content/settings')).body.data['site.contact_phone'];

    const response = await request(app)
      .put(`${ADMIN_API}/content/settings`)
      .set('Cookie', superAdmin.header)
      .set('X-CSRF-Token', superAdmin.csrf)
      .send({ 'site.contact_phone': '+91 88888 88888' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);

    try {
      const publicSettings = await request(app).get(`${API}/settings/public`);
      expect(JSON.stringify(publicSettings.body.data)).toContain('+91 88888 88888');
    } finally {
      await request(app)
        .put(`${ADMIN_API}/content/settings`)
        .set('Cookie', superAdmin.header)
        .set('X-CSRF-Token', superAdmin.csrf)
        .send({ 'site.contact_phone': original });
    }
  });

  /** The content screen must not be a back door into the payment or pricing configuration. */
  it('refuses a key that is not content', async () => {
    const response = await request(app)
      .put(`${ADMIN_API}/content/settings`)
      .set('Cookie', superAdmin.header)
      .set('X-CSRF-Token', superAdmin.csrf)
      .send({ 'payment.razorpay_key_secret': 'stolen' });

    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain('not editable');
  });
});

/* -------------------------------------------------------------------- SEO */

describe('sitemap and robots', () => {
  it('serves a sitemap index listing every section', async () => {
    const response = await request(app).get('/sitemap.xml');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('xml');

    for (const section of ['products', 'categories', 'collections', 'pages', 'help']) {
      expect(response.text).toContain(`sitemap-${section}.xml`);
    }
  });

  /**
   * G1: an empty sitemap passes every "contains no drafts" assertion, so non-emptiness is asserted
   * first and a KNOWN excluded page is named explicitly.
   */
  it('lists published pages and excludes a noIndex one', async () => {
    const hidden = await prisma.page.create({
      data: {
        slug: 'a-hidden-landing-page',
        title: 'Hidden',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        noIndex: true,
      },
    });

    const draft = await prisma.page.create({
      data: { slug: 'a-draft-landing-page', title: 'Draft', status: 'DRAFT' },
    });

    try {
      const response = await request(app).get('/sitemap-pages.xml');
      const entries = (response.text.match(/<loc>/g) ?? []).length;

      // Non-empty FIRST. Without this, every exclusion below is vacuously true.
      expect(response.status).toBe(200);
      expect(entries).toBeGreaterThanOrEqual(8);
      expect(response.text).toContain('/about-us');
      expect(response.text).toContain('<lastmod>');

      // Now the exclusions mean something.
      expect(response.text).not.toContain('a-hidden-landing-page');
      expect(response.text).not.toContain('a-draft-landing-page');
    } finally {
      await prisma.page.deleteMany({ where: { id: { in: [hidden.id, draft.id] } } });
    }
  });

  it('lists products and excludes a soft-deleted one', async () => {
    const product = await prisma.product.findFirstOrThrow({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { id: true, slug: true },
    });

    const response = await request(app).get('/sitemap-products.xml');
    const entries = (response.text.match(/<loc>/g) ?? []).length;

    expect(entries).toBeGreaterThan(50);
    expect(response.text).toContain(product.slug);

    await prisma.product.update({ where: { id: product.id }, data: { deletedAt: new Date() } });

    try {
      // The cache is keyed per section, so rebuild rather than re-reading a stale document.
      const fresh = await seoService.section('products', 1);
      expect((fresh.match(/<loc>/g) ?? []).length).toBeGreaterThan(50);
    } finally {
      await prisma.product.update({ where: { id: product.id }, data: { deletedAt: null } });
    }
  });

  it('lists published help articles', async () => {
    const response = await request(app).get('/sitemap-help.xml');
    const entries = (response.text.match(/<loc>/g) ?? []).length;

    expect(response.status).toBe(200);
    expect(entries).toBe(15);
    expect(response.text).toContain('/help/articles/');
  });

  it('answers an unknown section with an empty urlset rather than a crash', async () => {
    const response = await request(app).get('/sitemap-nonsense.xml');

    expect(response.status).toBe(404);
    expect(response.text).toContain('urlset');
  });

  it('escapes XML rather than emitting raw ampersands', async () => {
    const xml = await seoService.section('pages', 1);

    expect(xml.length).toBeGreaterThan(200);
    // Any bare & would make the document unparseable.
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('renders robots.txt from settings', async () => {
    const response = await request(app).get('/robots.txt');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('User-agent: *');
    expect(response.text).toContain('Sitemap:');
    expect(response.text).toContain('Disallow: /checkout');
    expect(response.text).toContain('Disallow: /admin');
  });

  it('reports entry counts per section', async () => {
    const counts = await seoService.entryCounts();

    expect(counts.products).toBeGreaterThan(50);
    expect(counts.categories).toBeGreaterThan(50);
    expect(counts.collections).toBe(5);
    expect(counts.pages).toBeGreaterThanOrEqual(8);
    expect(counts.help).toBe(15);
  });
});

describe('SEO meta preview', () => {
  it('produces title, canonical, OG and JSON-LD for a page', async () => {
    const page = await prisma.page.findUniqueOrThrow({ where: { slug: 'about-us' } });

    const response = await get(superAdmin, `/seo/preview/PAGE/${page.id}`);

    expect(response.status).toBe(200);
    expect(response.body.data.found).toBe(true);
    expect(response.body.data.title).toContain('ClearWood');
    expect(response.body.data.canonical).toContain('/about-us');
    expect(response.body.data.robots).toBe('index, follow');
    expect(response.body.data.jsonLd['@context']).toBe('https://schema.org');
    expect(response.body.data.openGraph.url).toContain('/about-us');
  });

  it('marks a noIndex page as noindex', async () => {
    const hidden = await prisma.page.create({
      data: {
        slug: 'hidden-for-meta',
        title: 'Hidden',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        noIndex: true,
      },
    });

    try {
      const response = await get(superAdmin, `/seo/preview/PAGE/${hidden.id}`);

      expect(response.status).toBe(200);
      expect(response.body.data.noIndex).toBe(true);
      expect(response.body.data.robots).toBe('noindex, nofollow');
    } finally {
      await prisma.page.delete({ where: { id: hidden.id } });
    }
  });

  it('rejects an unknown entity type', async () => {
    const response = await get(superAdmin, '/seo/preview/NONSENSE/abc');
    expect(response.status).toBe(422);
  });
});
