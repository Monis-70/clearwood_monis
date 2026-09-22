import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { passwordService } from '../src/modules/auth/password.service';
import { helpService } from '../src/modules/cms/faq.service';

/**
 * Prompt 10A slice 3 - FAQs and the help centre.
 *
 * The two properties worth testing: targeting returns the right set rather than everything, and
 * markdown is sanitised at WRITE time so the stored bytes are the bytes we vouched for.
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
      name: `Cms ${roleCode}`,
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
let contentManager: Session;
let catalogManager: Session;

beforeAll(async () => {
  superAdmin = await admin('cms.super@clearwood.local', 'SUPER_ADMIN');
  contentManager = await admin('cms.content@clearwood.local', 'CONTENT_MANAGER');
  catalogManager = await admin('cms.catalog@clearwood.local', 'CATALOG_MANAGER');
});

/* -------------------------------------------------------------------- FAQ */

describe('FAQs over HTTP', () => {
  it('serves the seeded FAQs and categories', async () => {
    const [faqs, categories] = await Promise.all([
      request(app).get(`${API}/content/faqs`),
      request(app).get(`${API}/content/faq-categories`),
    ]);

    expect(faqs.status).toBe(200);
    expect(faqs.body.data.length).toBeGreaterThanOrEqual(30);

    expect(categories.status).toBe(200);
    expect(categories.body.data.length).toBe(6);
  });

  it('narrows by visibility', async () => {
    const response = await request(app).get(`${API}/content/faqs?visibility=SHIPPING`);

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);

    for (const faq of response.body.data as { visibility: string }[]) {
      expect(faq.visibility).toBe('SHIPPING');
    }
  });

  it('searches question and answer text', async () => {
    const response = await request(app).get(`${API}/content/faqs?q=monsoon`);

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);

    const text = JSON.stringify(response.body.data).toLowerCase();
    expect(text).toContain('monsoon');
  });

  /**
   * The targeting rule: an untargeted FAQ applies everywhere, a targeted one only where listed.
   * "Empty means nowhere" would silently hide every FAQ an admin forgot to target.
   */
  it('returns targeted FAQs for their product and withholds them elsewhere', async () => {
    const product = await prisma.product.findFirstOrThrow({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { id: true, slug: true },
    });

    const other = await prisma.product.findFirstOrThrow({
      where: { status: 'ACTIVE', deletedAt: null, NOT: { id: product.id } },
      select: { slug: true },
    });

    const targeted = await prisma.faq.create({
      data: {
        question: 'Does this particular piece come flat packed?',
        answer: 'No. This one arrives assembled.',
        visibility: 'PRODUCT',
        isActive: true,
        targetProductIdsJson: JSON.stringify([product.id]),
      },
    });

    try {
      const onProduct = await request(app).get(`${API}/content/faqs?productSlug=${product.slug}`);
      const onOther = await request(app).get(`${API}/content/faqs?productSlug=${other.slug}`);

      const idsHere = (onProduct.body.data as { id: string }[]).map((faq) => faq.id);
      const idsThere = (onOther.body.data as { id: string }[]).map((faq) => faq.id);

      // G1: both lists must be non-empty, or "absent from the other" proves nothing.
      expect(idsHere.length).toBeGreaterThan(0);
      expect(idsThere.length).toBeGreaterThan(0);

      expect(idsHere).toContain(targeted.id);
      expect(idsThere).not.toContain(targeted.id);
    } finally {
      await prisma.faq.delete({ where: { id: targeted.id } });
    }
  });

  it('counts a helpfulness vote', async () => {
    const faq = await prisma.faq.findFirstOrThrow({ where: { deletedAt: null } });
    const before = faq.helpfulYes;

    const response = await request(app)
      .post(`${API}/content/faqs/${faq.id}/helpful`)
      .send({ helpful: true });

    expect(response.status).toBe(200);
    expect(response.body.data.counted).toBe(true);

    const after = await prisma.faq.findUniqueOrThrow({ where: { id: faq.id } });
    expect(after.helpfulYes).toBe(before + 1);
  });

  it('rejects a vote without a boolean (R2)', async () => {
    const faq = await prisma.faq.findFirstOrThrow({ where: { deletedAt: null } });

    const response = await request(app)
      .post(`${API}/content/faqs/${faq.id}/helpful`)
      .send({ helpful: 'yes please' });

    expect(response.status).toBe(422);
  });

  it('has no FAQ about returns while customer returns are frozen', async () => {
    const all = await prisma.faq.findMany({ where: { deletedAt: null } });

    expect(all.length).toBeGreaterThan(30);
    expect(all.filter((faq) => /\breturn(s|ing)?\b/i.test(faq.question))).toEqual([]);
  });
});

/* ------------------------------------------------------------ help centre */

describe('the help centre over HTTP', () => {
  it('serves the category tree and featured articles', async () => {
    const response = await request(app).get(`${API}/content/help`);

    expect(response.status).toBe(200);
    expect(response.body.data.categories.length).toBe(5);
    expect(response.body.data.featured.length).toBeGreaterThan(0);
  });

  it('serves one category with its articles', async () => {
    const response = await request(app).get(`${API}/content/help/help-delivery`);

    expect(response.status).toBe(200);
    expect(response.body.data.slug).toBe('help-delivery');
    expect(response.body.data.articles.length).toBeGreaterThanOrEqual(4);
  });

  it('serves an article with sanitised HTML rendered at write time', async () => {
    const response = await request(app).get(
      `${API}/content/help/articles/what-to-check-on-arrival`,
    );

    expect(response.status).toBe(200);
    expect(response.body.data.title).toBe('What to check when it arrives');

    const html = String(response.body.data.bodyHtml);

    // Markdown really was rendered, not stored raw.
    expect(html.length).toBeGreaterThan(300);
    expect(html).toContain('<li>');
    expect(html).toContain('<strong>');
    expect(html).not.toContain('**');
    expect(html).not.toMatch(/<script/i);
  });

  it('404s a draft article', async () => {
    const category = await prisma.helpCategory.findFirstOrThrow({ where: { deletedAt: null } });

    const draft = await prisma.helpArticle.create({
      data: {
        helpCategoryId: category.id,
        slug: 'a-draft-nobody-should-see',
        title: 'Draft',
        bodyMarkdown: 'Not ready.',
        bodyHtml: '<p>Not ready.</p>',
        status: 'DRAFT',
      },
    });

    try {
      const response = await request(app).get(
        `${API}/content/help/articles/a-draft-nobody-should-see`,
      );
      expect(response.status).toBe(404);
    } finally {
      await prisma.helpArticle.delete({ where: { id: draft.id } });
    }
  });

  /** The rule: markdown is sanitised on the way IN, so no read ever has to trust it. */
  it('sanitises a malicious markdown body at write time', async () => {
    const category = await prisma.helpCategory.findFirstOrThrow({ where: { deletedAt: null } });

    const response = await post(superAdmin, '/cms/help/articles', {
      helpCategoryId: category.id,
      slug: 'xss-attempt',
      title: 'XSS attempt',
      bodyMarkdown:
        'Safe text.\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[click](javascript:alert(1))',
      status: 'PUBLISHED',
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);

    try {
      // The STORED bytes, not the response, are what matters.
      const stored = await prisma.helpArticle.findUniqueOrThrow({ where: { slug: 'xss-attempt' } });

      expect(stored.bodyHtml.length).toBeGreaterThan(10);
      expect(stored.bodyHtml).toContain('Safe text');
      expect(stored.bodyHtml).not.toMatch(/<script/i);
      expect(stored.bodyHtml).not.toMatch(/onerror/i);
      expect(stored.bodyHtml).not.toContain('alert(1)</script>');

      /*
       * `javascript:` surviving as literal TEXT is harmless — markdown-it refuses to build a link
       * from it, so it never reaches an attribute. What must never appear is a dangerous scheme
       * inside an href or src, which is the only place a browser would act on it.
       */
      expect(stored.bodyHtml).not.toMatch(/(href|src)\s*=\s*["']?\s*javascript:/i);
      expect(stored.bodyHtml).not.toMatch(/(href|src)\s*=\s*["']?\s*data:/i);
      expect(stored.bodyHtml).not.toMatch(/<a[^>]+javascript/i);

      // The markdown an admin typed is kept, so they can keep editing it.
      expect(stored.bodyMarkdown).toContain('<script>');
    } finally {
      await prisma.helpArticle.deleteMany({ where: { slug: 'xss-attempt' } });
    }
  });

  it('refuses an iframe even from a whitelisted host in a help article', async () => {
    const html = await helpService.renderBody(
      'Watch this\n\n<iframe src="https://www.youtube.com/embed/x"></iframe>',
    );

    expect(html).toContain('Watch this');
    expect(html).not.toContain('<iframe');
  });

  it('counts an article vote', async () => {
    const article = await prisma.helpArticle.findFirstOrThrow({ where: { status: 'PUBLISHED' } });
    const before = article.helpfulNo;

    const response = await request(app)
      .post(`${API}/content/help/articles/${article.id}/helpful`)
      .send({ helpful: false });

    expect(response.status).toBe(200);

    const after = await prisma.helpArticle.findUniqueOrThrow({ where: { id: article.id } });
    expect(after.helpfulNo).toBe(before + 1);
  });
});

/* -------------------------------------------------------------- admin RBAC */

describe('admin CMS access control', () => {
  it('lets CONTENT_MANAGER manage FAQs', async () => {
    const response = await get(contentManager, '/cms/faqs');
    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
  });

  it('refuses CATALOG_MANAGER, who has no cms permissions', async () => {
    const response = await get(catalogManager, '/cms/faqs');
    expect(response.status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    const response = await request(app).get(`${ADMIN_API}/cms/faqs`);
    expect(response.status).toBe(401);
  });

  it('refuses a customer token on an admin route', async () => {
    const response = await request(app)
      .get(`${ADMIN_API}/cms/faqs`)
      .set('Authorization', 'Bearer not-an-admin-token');

    expect(response.status).toBe(401);
  });

  it('writes exactly one audit row per write', async () => {
    const before = await prisma.auditLog.count({ where: { entity: 'Faq' } });

    const created = await post(contentManager, '/cms/faqs', {
      question: 'An audited question?',
      answer: 'An audited answer.',
      visibility: 'GLOBAL',
    });

    expect(created.status, JSON.stringify(created.body)).toBe(201);

    try {
      const after = await prisma.auditLog.count({ where: { entity: 'Faq' } });
      expect(after).toBe(before + 1);
    } finally {
      await prisma.faq.deleteMany({ where: { id: created.body.data.id as string } });
    }
  });

  it('refuses to delete a help category that still has articles', async () => {
    const category = await prisma.helpCategory.findFirstOrThrow({
      where: { slug: 'help-delivery' },
    });

    const response = await request(app)
      .delete(`${ADMIN_API}/cms/help/categories/${category.id}`)
      .set('Cookie', superAdmin.header)
      .set('X-CSRF-Token', superAdmin.csrf);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('HELP_CATEGORY_HAS_ARTICLES');
  });
});
