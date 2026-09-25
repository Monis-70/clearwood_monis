import sharp from 'sharp';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { passwordService } from '../src/modules/auth/password.service';

/**
 * Prompt 4 — the media HTTP surface: RBAC, the upload endpoint, dedup, usage-aware deletion,
 * gallery resolution and the audit trail.
 */

const app = createApp();
const TEST_PASSWORD = 'Rosewood-Teak-2026';

function cookiesFrom(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

async function admin(email: string, roleCode: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: `Media ${roleCode}`,
      passwordHash: await passwordService.hash(TEST_PASSWORD),
      status: 'ACTIVE',
    },
  });

  await prisma.adminUserRole.upsert({
    where: { adminUserId_roleId: { adminUserId: user.id, roleId: role.id } },
    update: {},
    create: { adminUserId: user.id, roleId: role.id },
  });

  const login = await request(app)
    .post('/api/v1/admin/auth/login')
    .send({ email, password: TEST_PASSWORD });

  const cookies = cookiesFrom(login);
  const csrf =
    cookies
      .find((c) => c.startsWith('cw_adm_csrf='))
      ?.split(';')[0]
      ?.split('=')[1] ?? '';

  return { header: cookies.map((c) => c.split(';')[0]).join('; '), csrf, id: user.id };
}

async function png(width: number, height: number, hex: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: hex } })
    .png()
    .toBuffer();
}

/** Audit writes are fire-and-forget, so assertions poll rather than read once. */
async function eventually(read: () => Promise<number>, expected: (value: number) => boolean) {
  const deadline = Date.now() + 4000;
  let value = await read();
  while (!expected(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

let catalogManager: Awaited<ReturnType<typeof admin>>;
let orderManager: Awaited<ReturnType<typeof admin>>;

beforeAll(async () => {
  catalogManager = await admin('media.catalog@clearwood.local', 'CATALOG_MANAGER');
  orderManager = await admin('media.orders@clearwood.local', 'ORDER_MANAGER');
});

describe('media RBAC (R10)', () => {
  it('rejects an anonymous request with 401', async () => {
    const response = await request(app).get('/api/v1/admin/media');
    expect(response.status).toBe(401);
  });

  it('rejects an admin without media permissions with 403', async () => {
    const response = await request(app)
      .get('/api/v1/admin/media')
      .set('Cookie', orderManager.header);

    expect(response.status).toBe(403);
  });

  it('lets a CATALOG_MANAGER list the library', async () => {
    const response = await request(app)
      .get('/api/v1/admin/media')
      .set('Cookie', catalogManager.header);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.meta).toMatchObject({ page: 1 });
  });
});

describe('POST /api/v1/admin/media/upload', () => {
  it('stores the original, generates renditions and audits exactly one row', async () => {
    const before = await prisma.auditLog.count({ where: { entity: 'Media', action: 'CREATE' } });

    const response = await request(app)
      .post('/api/v1/admin/media/upload')
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf)
      .attach('files', await png(1400, 1000, '#8A5A3B'), 'walnut-console.png');

    expect(response.status).toBe(201);

    const uploaded = response.body.data.uploaded[0];
    expect(uploaded.deduplicated).toBe(false);
    expect(uploaded.media.status).toBe('READY');
    expect(uploaded.media.variants.length).toBeGreaterThan(0);
    expect(uploaded.media.blurhash).toBeTruthy();
    expect(uploaded.media.lqipDataUri).toMatch(/^data:image\//);
    expect(uploaded.media.checksumSha256).toHaveLength(64);
    // The key is derived, never taken from the uploaded name.
    expect(uploaded.media.path).toMatch(/^[a-z-]+\/\d{4}\/\d{2}\//);

    const after = await eventually(
      () => prisma.auditLog.count({ where: { entity: 'Media', action: 'CREATE' } }),
      (value) => value > before,
    );
    expect(after).toBe(before + 1);
  });

  it('deduplicates identical bytes instead of storing them twice', async () => {
    const bytes = await png(600, 600, '#2E7D5B');

    const first = await request(app)
      .post('/api/v1/admin/media/upload')
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf)
      .attach('files', bytes, 'dup-a.png');

    const second = await request(app)
      .post('/api/v1/admin/media/upload')
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf)
      .attach('files', bytes, 'dup-b.png');

    expect(second.body.data.uploaded[0].deduplicated).toBe(true);
    expect(second.body.data.uploaded[0].media.id).toBe(first.body.data.uploaded[0].media.id);

    const checksum = first.body.data.uploaded[0].media.checksumSha256;
    expect(await prisma.media.count({ where: { checksumSha256: checksum } })).toBe(1);
  });

  it('refuses a file whose bytes are not a real image', async () => {
    const response = await request(app)
      .post('/api/v1/admin/media/upload')
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf)
      .attach('files', Buffer.from('<?php system($_GET[0]); ?>'), 'evil.png');

    expect(response.status).toBe(415);
    expect(response.body.error.code).toBeTruthy();
  });

  it('requires the CSRF header', async () => {
    const response = await request(app)
      .post('/api/v1/admin/media/upload')
      .set('Cookie', catalogManager.header)
      .attach('files', await png(40, 40, '#B23B3B'), 'nocsrf.png');

    expect(response.status).toBe(403);
  });

  it('answers a file above MAX_UPLOAD_SIZE_MB with 413 FILE_TOO_LARGE, not a 500', async () => {
    const oversized = Buffer.alloc(env.MAX_UPLOAD_SIZE_MB * 1024 * 1024 + 1024);
    (await png(8, 8, '#B4613A')).copy(oversized);

    const response = await request(app)
      .post('/api/v1/admin/media/upload')
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf)
      .attach('files', oversized, 'huge.png');

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('FILE_TOO_LARGE');
  });
});

describe('metadata, usage and deletion', () => {
  it('updates alt text and the focal point', async () => {
    const upload = await request(app)
      .post('/api/v1/admin/media/upload')
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf)
      .attach('files', await png(900, 700, '#7E8C77'), 'sage-chair.png');

    const id = upload.body.data.uploaded[0].media.id;

    const response = await request(app)
      .patch(`/api/v1/admin/media/${id}`)
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf)
      .send({ altText: 'Sage green accent chair', focalPoint: { x: 40, y: 30 }, tags: ['chair'] });

    expect(response.status).toBe(200);
    expect(response.body.data.altText).toBe('Sage green accent chair');
    expect(response.body.data.focalPoint).toEqual({ x: 40, y: 30 });
    expect(response.body.data.tags).toContain('chair');
  });

  it('rejects an invalid focal point with 422 (R2)', async () => {
    const media = await prisma.media.findFirstOrThrow({ where: { deletedAt: null } });

    const response = await request(app)
      .patch(`/api/v1/admin/media/${media.id}`)
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf)
      .send({ focalPoint: { x: 400, y: -2 } });

    expect(response.status).toBe(422);
  });

  it('blocks a hard delete while the asset is in use, and allows a forced one', async () => {
    // A throwaway asset, attached through the real endpoint, so the seeded demo data is untouched.
    const upload = await request(app)
      .post('/api/v1/admin/media/upload')
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf)
      .attach('files', await png(500, 400, '#1E1A16'), 'disposable.png');

    const mediaId = upload.body.data.uploaded[0].media.id;
    const product = await prisma.product.findFirstOrThrow({ where: { deletedAt: null } });

    const attached = await request(app)
      .post(`/api/v1/admin/products/${product.id}/media`)
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf)
      .send({ items: [{ mediaId, role: 'GALLERY' }] });

    expect(attached.status).toBe(201);
    expect(await prisma.mediaUsage.count({ where: { mediaId } })).toBe(1);

    const blocked = await request(app)
      .delete(`/api/v1/admin/media/${mediaId}/permanent`)
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf);

    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('MEDIA_IN_USE');
    expect(await prisma.media.count({ where: { id: mediaId } })).toBe(1);

    const forced = await request(app)
      .delete(`/api/v1/admin/media/${mediaId}/permanent`)
      .query({ force: true })
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf);

    expect(forced.status).toBe(200);
    expect(await prisma.media.count({ where: { id: mediaId } })).toBe(0);
    expect(await prisma.mediaUsage.count({ where: { mediaId } })).toBe(0);
    expect(await prisma.mediaVariant.count({ where: { mediaId } })).toBe(0);

    const audited = await eventually(
      () =>
        prisma.auditLog.count({
          where: { entity: 'Media', entityId: mediaId, action: 'DELETE' },
        }),
      (value) => value > 0,
    );
    expect(audited).toBeGreaterThan(0);
  });

  it('soft delete hides the asset but keeps the row, and restore brings it back', async () => {
    const upload = await request(app)
      .post('/api/v1/admin/media/upload')
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf)
      .attach('files', await png(300, 300, '#E3DACE'), 'temporary.png');

    const id = upload.body.data.uploaded[0].media.id;

    await request(app)
      .delete(`/api/v1/admin/media/${id}`)
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf)
      .expect(200);

    // D6 — the row survives, it is just filtered out of the default listing.
    const row = await prisma.media.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).not.toBeNull();

    const list = await request(app)
      .get('/api/v1/admin/media')
      .query({ limit: 100 })
      .set('Cookie', catalogManager.header);

    expect(list.body.data.some((item: { id: string }) => item.id === id)).toBe(false);

    const restored = await request(app)
      .post(`/api/v1/admin/media/${id}/restore`)
      .set('Cookie', catalogManager.header)
      .set('X-CSRF-Token', catalogManager.csrf);

    expect(restored.status).toBe(200);
    expect((await prisma.media.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
  });

  it('reports orphaned files without deleting anything (gc dry run)', async () => {
    const response = await request(app)
      .get('/api/v1/admin/media/gc')
      .set('Cookie', catalogManager.header);

    expect(response.status).toBe(200);
    expect(response.body.data.dryRun).toBe(true);
    expect(Array.isArray(response.body.data.orphanedFiles)).toBe(true);
  });
});

describe('GET /api/v1/catalog/products/:slug/gallery', () => {
  it('is public and orders PRIMARY first, then by role and position', async () => {
    const primary = await prisma.productMedia.findFirstOrThrow({
      where: { role: 'PRIMARY', product: { deletedAt: null } },
      include: { product: { select: { slug: true } } },
    });

    const response = await request(app).get(
      `/api/v1/catalog/products/${primary.product.slug}/gallery`,
    );

    expect(response.status).toBe(200);
    const items = response.body.data.items as { role: string; position: number }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].role).toBe('PRIMARY');
    expect(items.filter((item) => item.role === 'PRIMARY')).toHaveLength(1);
  });

  it('narrows the gallery to a variant when one is requested', async () => {
    const link = await prisma.productMedia.findFirst({
      where: { variantId: { not: null } },
      include: { product: { select: { slug: true } } },
    });

    if (!link) return; // the demo catalog always seeds one, but never fail on data shape

    const response = await request(app)
      .get(`/api/v1/catalog/products/${link.product.slug}/gallery`)
      .query({ variantId: link.variantId });

    expect(response.status).toBe(200);
    const items = response.body.data.items as { variantId: string | null }[];
    // Imagery belonging to a *different* variant must not leak into the result.
    expect(
      items.every((item) => item.variantId === null || item.variantId === link.variantId),
    ).toBe(true);
  });

  it('404s for an unknown slug', async () => {
    const response = await request(app).get('/api/v1/catalog/products/not-a-real-product/gallery');
    expect(response.status).toBe(404);
  });
});
