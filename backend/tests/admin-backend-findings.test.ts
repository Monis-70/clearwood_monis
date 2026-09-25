import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { passwordService } from '../src/modules/auth/password.service';

/**
 * Regression tests for the backend findings raised by the admin-panel analysis (F2-F11). Each
 * block names its finding; the ones fixed elsewhere (F1 route registrations, F7 import checksum,
 * F12 seeded menu columns) live next to the code they guard.
 */

const app = createApp();
const API = '/api/v1';
const ADMIN_API = `${API}/admin`;
const TEST_PASSWORD = 'Rosewood-Teak-2026';
const tag = Date.now().toString(36);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Audit writes are fire-and-forget; poll rather than assert the instant the response lands. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(100);
    value = await read();
  }
  return value;
}

interface Session {
  id: string;
  email: string;
  header: string;
  csrf: string;
}

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

async function login(email: string, password: string): Promise<request.Response> {
  return request(app).post(`${ADMIN_API}/auth/login`).send({ email, password });
}

function sessionOf(id: string, email: string, response: request.Response): Session {
  const jar = cookiesOf(response);
  return {
    id,
    email,
    header: jar.map((cookie) => cookie.split(';')[0]).join('; '),
    csrf:
      jar
        .find((cookie) => cookie.startsWith('cw_adm_csrf='))
        ?.split(';')[0]
        ?.split('=')[1] ?? '',
  };
}

async function admin(key: string, roleCode: string): Promise<Session> {
  const email = `findings.${key}.${tag}@clearwood.local`;
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const user = await prisma.adminUser.create({
    data: {
      email,
      name: `Findings ${key}`,
      passwordHash: await passwordService.hash(TEST_PASSWORD),
      status: 'ACTIVE',
      roles: { create: { roleId: role.id } },
    },
  });

  const response = await login(email, TEST_PASSWORD);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return sessionOf(user.id, email, response);
}

function get(session: Session, path: string) {
  return request(app).get(`${ADMIN_API}${path}`).set('Cookie', session.header);
}

function send(
  method: 'post' | 'patch' | 'delete',
  session: Session,
  path: string,
  body: Record<string, unknown> = {},
) {
  return request(app)
    [method](`${ADMIN_API}${path}`)
    .set('Cookie', session.header)
    .set('X-CSRF-Token', session.csrf)
    .send(body);
}

let superAdmin: Session;
let adminUser: Session;
let catalogManager: Session;
let orderManager: Session;
let contentManager: Session;

beforeAll(async () => {
  superAdmin = await admin('super', 'SUPER_ADMIN');
  adminUser = await admin('admin', 'ADMIN');
  catalogManager = await admin('catalog', 'CATALOG_MANAGER');
  orderManager = await admin('orders', 'ORDER_MANAGER');
  contentManager = await admin('content', 'CONTENT_MANAGER');
}, 60_000);

/* ------------------------------------------------ F2 - documented statuses */

describe('F2: the OpenAPI document declares the status the handler sends', () => {
  interface Operation {
    responses: Record<string, unknown>;
  }

  it('declares exactly one success status per operation, and never 204', async () => {
    const response = await request(app).get('/openapi.json');
    const paths = response.body.paths as Record<string, Record<string, Operation>>;

    const offenders: string[] = [];
    for (const [path, operations] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const success = Object.keys(operation.responses).filter((code) => code.startsWith('2'));
        // R3: nothing answers a bare 204 - "no content" is 200 with data:null.
        if (success.length !== 1 || success.includes('204')) {
          offenders.push(`${method.toUpperCase()} ${path} -> ${success.join(',')}`);
        }
      }
    }

    expect(offenders).toStrictEqual([]);
  });

  it('documents CMS creates as 201 and deletes as 200 with null data', async () => {
    const response = await request(app).get('/openapi.json');
    const paths = response.body.paths as Record<string, Record<string, Operation>>;

    expect(Object.keys(paths[`${ADMIN_API}/cms/banners`]!.post!.responses)).toContain('201');
    expect(Object.keys(paths[`${ADMIN_API}/cms/pages`]!.post!.responses)).toContain('201');
    expect(Object.keys(paths[`${ADMIN_API}/cms/banners/{id}`]!.delete!.responses)).toContain('200');
    expect(Object.keys(paths[`${ADMIN_API}/cms/banners/reorder`]!.post!.responses)).toContain(
      '200',
    );
  });

  it('matches what the banner routes really send', async () => {
    const created = await send('post', contentManager, '/cms/banners', {
      name: `F2 banner ${tag}`,
      placement: 'CART_PROMO',
      headline: 'Contract check',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;

    const reordered = await send('post', contentManager, '/cms/banners/reorder', {
      order: [{ id, position: 3 }],
    });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    expect(reordered.body).toStrictEqual({ success: true, data: null, meta: null });

    const removed = await send('delete', contentManager, `/cms/banners/${id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toStrictEqual({ success: true, data: null, meta: null });
  });
});

/* --------------------------------------------------- F8 - banner isActive */

describe('F8: the banner list reads isActive=false as false', () => {
  it('returns exactly the active or the inactive banners asked for', async () => {
    const make = async (label: string, isActive: boolean) => {
      const response = await send('post', contentManager, '/cms/banners', {
        name: `F8 ${label} ${tag}`,
        placement: 'CART_PROMO',
        headline: label,
        isActive,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return response.body.data.id as string;
    };
    const activeId = await make('on', true);
    const inactiveId = await make('off', false);

    type Row = { id: string; isActive: boolean };
    const list = async (value: string) => {
      const response = await get(
        contentManager,
        `/cms/banners?placement=CART_PROMO&limit=100&isActive=${value}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data as Row[];
    };

    const onlyInactive = await list('false');
    expect(onlyInactive.map((row) => row.id)).toContain(inactiveId);
    expect(onlyInactive.map((row) => row.id)).not.toContain(activeId);
    expect(onlyInactive.every((row) => row.isActive === false)).toBe(true);

    const onlyActive = await list('true');
    expect(onlyActive.map((row) => row.id)).toContain(activeId);
    expect(onlyActive.map((row) => row.id)).not.toContain(inactiveId);
    expect(onlyActive.every((row) => row.isActive === true)).toBe(true);

    const invalid = await get(contentManager, '/cms/banners?isActive=maybe');
    expect(invalid.status).toBe(422);
  });
});

/* ----------------------------------------- F3 / F4 - custom roles, role read */

describe('F3: a custom role can be granted', () => {
  it('creates a custom role and assigns it, accepting a lower-case code', async () => {
    const role = await send('post', superAdmin, '/roles', {
      code: `qa_f3_${tag}`,
      name: 'QA reviewer',
      permissions: ['catalog.product.read'],
    });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const code = role.body.data.code as string;
    expect(code).toBe(`QA_F3_${tag}`.toUpperCase());

    const created = await send('post', superAdmin, '/users', {
      email: `findings.f3.${tag}@clearwood.local`,
      name: 'Custom Role Holder',
      roleCodes: [code],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const userId = created.body.data.id as string;

    const assigned = await send('post', superAdmin, `/users/${userId}/roles`, {
      roleCodes: [code.toLowerCase(), 'CONTENT_MANAGER'],
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);

    const held = await prisma.adminUserRole.findMany({
      where: { adminUserId: userId },
      select: { role: { select: { code: true } } },
    });
    expect(held.map((row) => row.role.code).sort()).toStrictEqual([code, 'CONTENT_MANAGER'].sort());

    const audit = await eventually(
      () => prisma.auditLog.findMany({ where: { entity: 'AdminUser', entityId: userId } }),
      (rows) => rows.some((row) => row.action === 'ROLE_ASSIGNED'),
    );
    expect(audit.some((row) => row.action === 'ROLE_ASSIGNED')).toBe(true);
  });

  it('refuses unknown and inactive roles with 422', async () => {
    const target = await admin('f3target', 'CATALOG_MANAGER');

    const unknown = await send('post', superAdmin, `/users/${target.id}/roles`, {
      roleCodes: [`NO_SUCH_ROLE_${tag}`.toUpperCase()],
    });
    expect(unknown.status).toBe(422);

    const inactive = await prisma.role.create({
      data: { code: `QA_OFF_${tag}`.toUpperCase(), name: 'Switched off', isActive: false },
    });
    const refused = await send('post', superAdmin, `/users/${target.id}/roles`, {
      roleCodes: [inactive.code],
    });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('Inactive role');
  });

  it('still refuses a custom role carrying permissions the actor lacks', async () => {
    // ADMIN lacks system.role.*, so a role granting it is out of reach whatever its code.
    const escalation = await prisma.role.create({
      data: {
        code: `QA_ESC_${tag}`.toUpperCase(),
        name: 'Escalation',
        permissions: {
          create: {
            permission: { connect: { code: 'system.role.update' } },
          },
        },
      },
    });

    const refused = await send('post', adminUser, '/users', {
      email: `findings.esc.${tag}@clearwood.local`,
      name: 'Would Escalate',
      roleCodes: [escalation.code],
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.code).toBe('ROLE_NOT_GRANTABLE');
    expect(
      await prisma.adminUser.count({ where: { email: `findings.esc.${tag}@clearwood.local` } }),
    ).toBe(0);
  });
});

describe('F4: a role can be read with its permissions', () => {
  it('returns the permission codes to a reader and nothing to anyone else', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'CATALOG_MANAGER' } });

    const read = await get(superAdmin, `/roles/${role.id}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.code).toBe('CATALOG_MANAGER');
    expect(read.body.data.permissions).toContain('catalog.product.read');
    expect(read.body.data.permissions).not.toContain('system.role.read');

    expect((await get(adminUser, `/roles/${role.id}`)).status).toBe(403);
    expect((await get(catalogManager, `/roles/${role.id}`)).status).toBe(403);
    expect((await get(superAdmin, '/roles/cl0000000000000000000000')).status).toBe(404);
  });
});

/* ---------------------------------------------- F5 / F6 - admin passwords */

describe('F5: an admin-chosen password must be changed at first sign-in', () => {
  it('forces the change for a user created with a password', async () => {
    const email = `findings.f5.${tag}@clearwood.local`;
    const created = await send('post', superAdmin, '/users', {
      email,
      name: 'New Hire',
      password: TEST_PASSWORD,
      roleCodes: ['CONTENT_MANAGER'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const signedIn = await login(email, TEST_PASSWORD);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.mustChangePassword).toBe(true);

    const session = sessionOf(created.body.data.id as string, email, signedIn);
    const blocked = await get(session, '/enquiries');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('applies the same password policy as change-password', async () => {
    const weak = await send('post', superAdmin, '/users', {
      email: `findings.f5weak.${tag}@clearwood.local`,
      name: 'Weak Password',
      password: 'short',
      roleCodes: ['CONTENT_MANAGER'],
    });
    expect(weak.status).toBe(422);
  });
});

describe('F6: an admin can set another admin password', () => {
  it('replaces the password, ends every session and forces a change', async () => {
    const target = await admin('f6target', 'CATALOG_MANAGER');
    const newPassword = 'Sheesham-Oak-Bench-2027';

    const set = await send('post', superAdmin, `/users/${target.id}/password`, { newPassword });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(JSON.stringify(set.body)).not.toContain('passwordHash');

    // The live access token dies now (permission version), and so does the refresh token.
    expect((await get(target, '/auth/me')).status).toBe(401);
    const refreshed = await send('post', target, '/auth/refresh');
    expect(refreshed.status).toBe(401);

    expect((await login(target.email, TEST_PASSWORD)).status).toBe(401);
    const fresh = await login(target.email, newPassword);
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.mustChangePassword).toBe(true);

    const audit = await eventually(
      () =>
        prisma.auditLog.findMany({
          where: { entity: 'AdminUser', entityId: target.id, action: 'PASSWORD_RESET' },
        }),
      (rows) => rows.length > 0,
    );
    expect(audit[0]!.severity).toBe('CRITICAL');
    expect(audit[0]!.actorId).toBe(superAdmin.id);
    expect(JSON.stringify(audit)).not.toContain(newPassword);
  });

  it('lets nobody below SUPER_ADMIN touch a SUPER_ADMIN password', async () => {
    const refused = await send('post', adminUser, `/users/${superAdmin.id}/password`, {
      newPassword: 'Sheesham-Oak-Bench-2027',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('ADMIN_USER_NOT_MANAGEABLE');

    expect((await login(superAdmin.email, TEST_PASSWORD)).status).toBe(200);
  });

  it('lets an ADMIN reset an account it fully covers', async () => {
    const target = await admin('f6covered', 'ORDER_MANAGER');
    const set = await send('post', adminUser, `/users/${target.id}/password`, {
      newPassword: 'Sheesham-Oak-Bench-2027',
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
  });

  it('requires system.user.update, refuses self and weak passwords', async () => {
    const target = await admin('f6other', 'CONTENT_MANAGER');

    const noPermission = await send('post', catalogManager, `/users/${target.id}/password`, {
      newPassword: 'Sheesham-Oak-Bench-2027',
    });
    expect(noPermission.status).toBe(403);
    expect(noPermission.body.error.code).toBe('FORBIDDEN');

    const self = await send('post', superAdmin, `/users/${superAdmin.id}/password`, {
      newPassword: 'Sheesham-Oak-Bench-2027',
    });
    expect(self.status).toBe(403);

    const weak = await send('post', superAdmin, `/users/${target.id}/password`, {
      newPassword: 'short',
    });
    expect(weak.status).toBe(422);

    const unknown = await send('post', superAdmin, '/users/cl0000000000000000000000/password', {
      newPassword: 'Sheesham-Oak-Bench-2027',
    });
    expect(unknown.status).toBe(404);

    // The untouched account still signs in with its own password.
    expect((await login(target.email, TEST_PASSWORD)).status).toBe(200);
  });
});

/* ------------------------------------------------- F10 - enquiry assignees */

describe('F10: enquiries are assigned only to admins who can read them', () => {
  it('lists eligible assignees to whoever may assign', async () => {
    const response = await get(contentManager, '/enquiries/assignees');
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const ids = (response.body.data as { id: string; name: string }[]).map((row) => row.id);
    expect(ids).toContain(superAdmin.id);
    expect(ids).toContain(orderManager.id);
    expect(ids).toContain(contentManager.id);
    expect(ids).not.toContain(catalogManager.id);
    expect(Object.keys(response.body.data[0]).sort()).toStrictEqual(['id', 'name']);

    // ORDER_MANAGER reads enquiries but may not move them.
    expect((await get(orderManager, '/enquiries/assignees')).status).toBe(403);
    expect((await get(catalogManager, '/enquiries/assignees')).status).toBe(403);
  });

  it('refuses to assign an enquiry to someone who cannot open it', async () => {
    const submitted = await request(app)
      .post(`${API}/enquiries`)
      .send({ formKey: 'contract-work', name: 'Assign Tester', email: `f10.${tag}@example.com` });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const id = submitted.body.data.reference as string;

    const refused = await send('patch', contentManager, `/enquiries/${id}`, {
      assignedToId: catalogManager.id,
      version: 0,
    });
    expect(refused.status).toBe(422);

    const assigned = await send('patch', contentManager, `/enquiries/${id}`, {
      assignedToId: orderManager.id,
      version: 0,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body.data.assignedToId).toBe(orderManager.id);
  });
});

/* ------------------------------------------------ F11 - report permissions */

describe('F11: each report needs the permission for its own data', () => {
  const range = `from=${new Date(Date.now() - 30 * 86_400_000).toISOString()}&to=${new Date().toISOString()}`;
  const report = (session: Session, kind: string) =>
    get(session, `/reports?kind=${kind}&${range}&format=json`);

  it('serves ORDER_MANAGER the order reports but not payouts', async () => {
    for (const kind of ['SALES_SUMMARY', 'GST_HSN_SUMMARY', 'TOP_PRODUCTS', 'REFUND_SUMMARY']) {
      const response = await report(orderManager, kind);
      expect(response.status, `${kind} ${JSON.stringify(response.body)}`).toBe(200);
    }

    const payouts = await report(orderManager, 'SPLIT_PAYOUT');
    expect(payouts.status).toBe(403);
    expect(payouts.body.error.details.required).toStrictEqual(['payment.split.read']);
  });

  it('serves CATALOG_MANAGER inventory movement and nothing financial', async () => {
    expect((await report(catalogManager, 'INVENTORY_MOVEMENT')).status).toBe(200);
    for (const kind of ['SALES_SUMMARY', 'SPLIT_PAYOUT', 'REFUND_SUMMARY']) {
      expect((await report(catalogManager, kind)).status, kind).toBe(403);
    }
  });

  it('serves CONTENT_MANAGER no report at all', async () => {
    expect((await report(contentManager, 'INVENTORY_MOVEMENT')).status).toBe(403);
    expect((await report(contentManager, 'SALES_SUMMARY')).status).toBe(403);
  });

  it('keeps every report open to ADMIN and SUPER_ADMIN', async () => {
    for (const session of [adminUser, superAdmin]) {
      for (const kind of [
        'SALES_SUMMARY',
        'GST_HSN_SUMMARY',
        'SPLIT_PAYOUT',
        'REFUND_SUMMARY',
        'TOP_PRODUCTS',
        'INVENTORY_MOVEMENT',
      ]) {
        expect((await report(session, kind)).status, kind).toBe(200);
      }
    }
  });
});
