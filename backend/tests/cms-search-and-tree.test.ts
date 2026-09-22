import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { passwordService } from '../src/modules/auth/password.service';
import { helpService } from '../src/modules/cms/faq.service';
import { searchIndexerService } from '../src/modules/storefront/searchIndexer.service';

/**
 * Prompt B1 Task 4 - the two loose ends left by 10A.
 *
 * `SearchDocument` accepted PAGE and HELP_ARTICLE but nothing ever wrote them, so the enum values
 * were a promise the indexer did not keep. And help re-parenting threw an unexplained 422.
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

async function admin(email: string): Promise<Session> {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });

  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: 'B1 admin',
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

let superAdmin: Session;

beforeAll(async () => {
  superAdmin = await admin('b1.super@clearwood.local');
});

/* ------------------------------------------------------ content in search */

describe('published content is searchable', () => {
  it('indexes published pages and help articles', async () => {
    await searchIndexerService.indexPages();
    await searchIndexerService.indexHelpArticles();

    const [pageDocs, articleDocs] = await Promise.all([
      prisma.searchDocument.count({ where: { entityType: 'PAGE' } }),
      prisma.searchDocument.count({ where: { entityType: 'HELP_ARTICLE' } }),
    ]);

    // G1: the enum values were accepted long before anything wrote them; prove rows exist.
    expect(pageDocs).toBeGreaterThanOrEqual(8);
    expect(articleDocs).toBe(15);
  });

  it('indexes the readable body, not the raw block JSON', async () => {
    await searchIndexerService.indexPages();

    const about = await prisma.page.findUniqueOrThrow({ where: { slug: 'about-us' } });
    const document = await prisma.searchDocument.findFirstOrThrow({
      where: { entityType: 'PAGE', entityId: about.id },
    });

    expect(document.bodyText.length).toBeGreaterThan(100);
    expect(document.bodyText).toContain('workshop');
    // Flattened from the sanitised html, so no markup and no config keys leak into the index.
    expect(document.bodyText).not.toContain('<');
    expect(document.bodyText).not.toContain('configJson');
    expect(document.slug).toBe('about-us');
  });

  it('indexes a help article from its sanitised html', async () => {
    await searchIndexerService.indexHelpArticles();

    const article = await prisma.helpArticle.findUniqueOrThrow({
      where: { slug: 'what-to-check-on-arrival' },
    });
    const document = await prisma.searchDocument.findFirstOrThrow({
      where: { entityType: 'HELP_ARTICLE', entityId: article.id },
    });

    expect(document.title).toBe('What to check when it arrives');
    expect(document.bodyText).toContain('delivery team');
    expect(document.bodyText).not.toContain('<');
    expect(document.subtitle).toBeTruthy();
  });

  it('excludes a draft article and a noIndex page', async () => {
    const category = await prisma.helpCategory.findFirstOrThrow({ where: { deletedAt: null } });

    const draft = await prisma.helpArticle.create({
      data: {
        helpCategoryId: category.id,
        slug: 'b1-draft-article',
        title: 'Draft',
        bodyMarkdown: 'x',
        bodyHtml: '<p>x</p>',
        status: 'DRAFT',
      },
    });

    const hidden = await prisma.page.create({
      data: {
        slug: 'b1-hidden-page',
        title: 'Hidden',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        noIndex: true,
      },
    });

    try {
      await searchIndexerService.indexPages();
      await searchIndexerService.indexHelpArticles();

      const total = await prisma.searchDocument.count({
        where: { entityType: { in: ['PAGE', 'HELP_ARTICLE'] } },
      });

      // G1: assert the index is populated before asserting what is missing from it.
      expect(total).toBeGreaterThan(20);

      expect(
        await prisma.searchDocument.count({
          where: { entityType: 'HELP_ARTICLE', entityId: draft.id },
        }),
      ).toBe(0);

      const hiddenDoc = await prisma.searchDocument.findFirst({
        where: { entityType: 'PAGE', entityId: hidden.id },
      });

      // A noIndex page may be indexed, but never as active.
      expect(hiddenDoc?.isActive ?? false).toBe(false);
    } finally {
      await prisma.helpArticle.delete({ where: { id: draft.id } });
      await prisma.page.delete({ where: { id: hidden.id } });
      await searchIndexerService.pruneContent();
    }
  });

  it('drops content from the index once it is withdrawn', async () => {
    const category = await prisma.helpCategory.findFirstOrThrow({ where: { deletedAt: null } });

    const article = await prisma.helpArticle.create({
      data: {
        helpCategoryId: category.id,
        slug: 'b1-temporary-article',
        title: 'Temporary',
        bodyMarkdown: 'Here for a moment.',
        bodyHtml: '<p>Here for a moment.</p>',
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });

    await searchIndexerService.indexHelpArticles();

    expect(
      await prisma.searchDocument.count({
        where: { entityType: 'HELP_ARTICLE', entityId: article.id },
      }),
    ).toBe(1);

    await prisma.helpArticle.update({
      where: { id: article.id },
      data: { deletedAt: new Date() },
    });

    const pruned = await searchIndexerService.pruneContent();

    expect(pruned).toBeGreaterThan(0);
    expect(
      await prisma.searchDocument.count({
        where: { entityType: 'HELP_ARTICLE', entityId: article.id },
      }),
    ).toBe(0);

    await prisma.helpArticle.delete({ where: { id: article.id } });
  });

  it('reindexAll covers content as well as catalog', async () => {
    const outcome = await searchIndexerService.reindexAll('PAGE');

    // `written` counts only CHANGED documents, so a warm index legitimately writes nothing.
    expect(outcome.failed).toBe(0);
    expect(
      await prisma.searchDocument.count({ where: { entityType: 'PAGE' } }),
    ).toBeGreaterThanOrEqual(8);
  });
});

/* ------------------------------------------------ help category moves */

describe('help categories can be re-parented', () => {
  it('rewrites path and depth for the node and every descendant', async () => {
    const parentA = await helpService.createCategory({
      name: 'B1 Parent A',
      slug: 'b1-parent-a',
      position: 0,
      isActive: true,
    });

    const parentB = await helpService.createCategory({
      name: 'B1 Parent B',
      slug: 'b1-parent-b',
      position: 1,
      isActive: true,
    });

    const child = await helpService.createCategory({
      name: 'B1 Child',
      slug: 'b1-child',
      parentId: parentA.id,
      position: 0,
      isActive: true,
    });

    try {
      expect(child.path).toBe('b1-parent-a/b1-child');
      expect(child.depth).toBe(1);

      const moved = await helpService.updateCategory(child.id, {
        parentId: parentB.id,
        version: child.version,
      });

      expect(moved!.path).toBe('b1-parent-b/b1-child');
      expect(moved!.depth).toBe(1);
      expect(moved!.parentId).toBe(parentB.id);
    } finally {
      await prisma.helpCategory.deleteMany({
        where: { id: { in: [child.id, parentA.id, parentB.id] } },
      });
    }
  });

  it('refuses a move that would exceed the depth cap, and leaves the tree untouched', async () => {
    const root = await helpService.createCategory({
      name: 'B1 Deep Root',
      slug: 'b1-deep-root',
      position: 0,
      isActive: true,
    });
    const mid = await helpService.createCategory({
      name: 'B1 Deep Mid',
      slug: 'b1-deep-mid',
      parentId: root.id,
      position: 0,
      isActive: true,
    });
    const leaf = await helpService.createCategory({
      name: 'B1 Deep Leaf',
      slug: 'b1-deep-leaf',
      parentId: mid.id,
      position: 0,
      isActive: true,
    });

    const orphan = await helpService.createCategory({
      name: 'B1 Orphan',
      slug: 'b1-orphan',
      position: 9,
      isActive: true,
    });

    try {
      expect(leaf.depth).toBe(2);

      await expect(
        helpService.updateCategory(orphan.id, { parentId: leaf.id, version: orphan.version }),
      ).rejects.toThrow();

      // Nothing moved: a rejected move must not leave a half-applied tree.
      const after = await prisma.helpCategory.findUniqueOrThrow({ where: { id: orphan.id } });
      expect(after.parentId).toBeNull();
      expect(after.path).toBe('b1-orphan');
      expect(after.depth).toBe(0);
    } finally {
      await prisma.helpCategory.deleteMany({
        where: { id: { in: [leaf.id, mid.id, root.id, orphan.id] } },
      });
    }
  });

  it('refuses to make a category its own parent', async () => {
    const category = await helpService.createCategory({
      name: 'B1 Self',
      slug: 'b1-self',
      position: 0,
      isActive: true,
    });

    try {
      await expect(
        helpService.updateCategory(category.id, {
          parentId: category.id,
          version: category.version,
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.helpCategory.delete({ where: { id: category.id } });
    }
  });

  it('moves through the admin route', async () => {
    const parent = await helpService.createCategory({
      name: 'B1 Route Parent',
      slug: 'b1-route-parent',
      position: 0,
      isActive: true,
    });
    const child = await helpService.createCategory({
      name: 'B1 Route Child',
      slug: 'b1-route-child',
      position: 1,
      isActive: true,
    });

    try {
      const response = await request(app)
        .patch(`${ADMIN_API}/cms/help/categories/${child.id}`)
        .set('Cookie', superAdmin.header)
        .set('X-CSRF-Token', superAdmin.csrf)
        .send({ parentId: parent.id, version: child.version });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.path).toBe('b1-route-parent/b1-route-child');
      expect(response.body.data.depth).toBe(1);
    } finally {
      await prisma.helpCategory.deleteMany({ where: { id: { in: [child.id, parent.id] } } });
    }
  });
});
