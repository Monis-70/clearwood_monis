import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import { createApp } from '../src/app';
import { passwordService } from '../src/modules/auth/password.service';

const app = createApp();

const SEEDED_ADMIN = { email: 'admin@clearwood.local', password: 'ChangeMe@12345' };
const TEST_PASSWORD = 'Rosewood-Teak-2026';

function cookiesFrom(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return match?.split(';')[0]?.split('=')[1];
}

function cookieHeader(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

/** Audit writes are deliberately fire-and-forget, so assertions poll rather than read once. */
async function eventually(
  read: () => Promise<number>,
  expected: (value: number) => boolean,
  timeoutMs = 4000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();

  while (!expected(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

async function createAdmin(email: string, roleCode: string): Promise<string> {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: `Test ${roleCode}`,
      passwordHash: await passwordService.hash(TEST_PASSWORD),
      status: 'ACTIVE',
    },
  });

  await prisma.adminUserRole.upsert({
    where: { adminUserId_roleId: { adminUserId: user.id, roleId: role.id } },
    update: {},
    create: { adminUserId: user.id, roleId: role.id },
  });

  return user.id;
}

async function loginAs(email: string, password = TEST_PASSWORD) {
  const response = await request(app).post('/api/v1/admin/auth/login').send({ email, password });
  const cookies = cookiesFrom(response);

  return {
    response,
    cookies,
    header: cookieHeader(cookies),
    csrf: cookieValue(cookies, 'cw_adm_csrf') ?? '',
    accessToken: response.body.data?.tokens?.accessToken as string,
  };
}

describe('POST /api/v1/admin/auth/login', () => {
  it('signs the seeded SUPER_ADMIN in and sets all three realm cookies', async () => {
    const { response, cookies } = await loginAs(SEEDED_ADMIN.email, SEEDED_ADMIN.password);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.user.email).toBe(SEEDED_ADMIN.email);
    expect(response.body.data.roles).toContain('SUPER_ADMIN');
    expect(response.body.data.permissions).toHaveLength(86);
    expect(response.body.data.mustChangePassword).toBe(true);

    const names = cookies.map((cookie) => cookie.split('=')[0]);
    expect(names).toEqual(expect.arrayContaining(['cw_adm_at', 'cw_adm_rt', 'cw_adm_csrf']));

    const refresh = cookies.find((cookie) => cookie.startsWith('cw_adm_rt='))!;
    expect(refresh).toContain('HttpOnly');
    expect(refresh).toContain('Path=/api/v1/admin');
    expect(cookies.find((cookie) => cookie.startsWith('cw_adm_csrf='))).not.toContain('HttpOnly');
  });

  it('never returns the refresh token in the body', async () => {
    const { response } = await loginAs(SEEDED_ADMIN.email, SEEDED_ADMIN.password);
    const body = JSON.stringify(response.body);

    expect(response.body.data.tokens).not.toHaveProperty('refreshToken');
    expect(body).not.toContain('refreshToken');
  });

  it('answers identically for a wrong password and an unknown account', async () => {
    const wrong = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: SEEDED_ADMIN.email, password: 'definitely-not-it' });

    const unknown = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: 'nobody@clearwood.local', password: 'definitely-not-it' });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe(unknown.body.error.code);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(wrong.body.error.message).toBe('Email or password is incorrect');
  });

  it('records a LoginAttempt row and an audit entry for every failure', async () => {
    const identifier = 'audit-probe@clearwood.local';
    await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: identifier, password: 'nope-nope-nope' });

    expect(
      await prisma.loginAttempt.count({ where: { realm: 'ADMIN', identifier, success: false } }),
    ).toBeGreaterThanOrEqual(1);

    const audited = await eventually(
      () => prisma.auditLog.count({ where: { action: 'LOGIN_FAILED', actorEmail: identifier } }),
      (value) => value >= 1,
    );
    expect(audited).toBeGreaterThanOrEqual(1);
  });
});

describe('progressive lockout', () => {
  it('locks the account after five consecutive failures', async () => {
    const email = 'lockout-test@clearwood.local';
    await createAdmin(email, 'CATALOG_MANAGER');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(app)
        .post('/api/v1/admin/auth/login')
        .send({ email, password: 'wrong-password-here' });
      expect(response.status).toBe(401);
    }

    const sixth = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email, password: TEST_PASSWORD });

    expect(sixth.status).toBe(401);
    expect(sixth.body.error.code).toBe('ACCOUNT_LOCKED');

    const user = await prisma.adminUser.findUniqueOrThrow({ where: { email } });
    expect(user.failedLoginCount).toBeGreaterThanOrEqual(5);
    expect(user.lockedUntil).not.toBeNull();

    expect(
      await prisma.loginAttempt.count({ where: { identifier: email } }),
    ).toBeGreaterThanOrEqual(5);
  });
});

describe('forgot-password does not leak account existence', () => {
  it('returns the same body for a known and an unknown address', async () => {
    const known = await request(app)
      .post('/api/v1/admin/auth/forgot-password')
      .send({ email: SEEDED_ADMIN.email });
    const unknown = await request(app)
      .post('/api/v1/admin/auth/forgot-password')
      .send({ email: 'ghost@clearwood.local' });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body.data).toStrictEqual(unknown.body.data);
  });
});

describe('realm isolation on the guarded routes', () => {
  let adminToken = '';
  let customerToken = '';

  beforeAll(async () => {
    adminToken = (await loginAs(SEEDED_ADMIN.email, SEEDED_ADMIN.password)).accessToken;

    const customer = await request(app)
      .post('/api/v1/auth/otp/request')
      .send({ phone: '919810000001', purpose: 'LOGIN' });

    const verified = await request(app).post('/api/v1/auth/otp/verify').send({
      destination: '919810000001',
      code: customer.body.data.devCode,
      purpose: 'LOGIN',
    });

    customerToken = verified.body.data.tokens.accessToken;
  });

  it('rejects an anonymous request with 401', async () => {
    const response = await request(app).get('/api/v1/admin/catalog/categories');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('NOT_AUTHENTICATED');
    expect(response.body.error.traceId).toBeTruthy();
  });

  it('rejects a CUSTOMER token on an admin route', async () => {
    const response = await request(app)
      .get('/api/v1/admin/catalog/categories')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects an ADMIN token on a customer route', async () => {
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('TOKEN_INVALID');
  });

  it('lets a permitted admin through', async () => {
    const response = await request(app)
      .get('/api/v1/admin/catalog/categories')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(12);
  });
});

describe('RBAC', () => {
  it('lets CATALOG_MANAGER read the catalog but not create roles', async () => {
    const email = 'catalog-manager@clearwood.local';
    await createAdmin(email, 'CATALOG_MANAGER');
    const session = await loginAs(email);

    expect(session.response.body.data.permissions).toHaveLength(36);

    const allowed = await request(app)
      .get('/api/v1/admin/catalog/categories')
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(allowed.status).toBe(200);

    const denied = await request(app)
      .post('/api/v1/admin/roles')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ code: 'HACKER', name: 'Hacker', permissions: [] });

    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    expect(denied.body.error.details.required).toContain('system.role.create');

    const audited = await eventually(
      () =>
        prisma.auditLog.count({
          where: { action: 'PERMISSION_DENIED', entityId: 'system.role.create' },
        }),
      (value) => value >= 1,
    );
    expect(audited).toBeGreaterThanOrEqual(1);
  });

  it('gives SUPER_ADMIN every permission, including newly added ones', async () => {
    const session = await loginAs(SEEDED_ADMIN.email, SEEDED_ADMIN.password);

    const roles = await request(app)
      .get('/api/v1/admin/roles')
      .set('Authorization', `Bearer ${session.accessToken}`);

    expect(roles.status).toBe(200);
    expect(roles.body.data).toHaveLength(5);
    expect(roles.body.data.find((role: { code: string }) => role.code === 'ADMIN')).toMatchObject({
      permissionCount: 79,
      isSystem: true,
    });
  });

  it('bumps permissionVersion on a role change so live tokens stop working', async () => {
    const email = 'role-change@clearwood.local';
    const targetId = await createAdmin(email, 'CONTENT_MANAGER');
    const target = await loginAs(email);

    expect(target.response.body.data.permissions).toHaveLength(24);

    const beforeVersion = (await prisma.adminUser.findUniqueOrThrow({ where: { id: targetId } }))
      .permissionVersion;

    const superAdmin = await loginAs(SEEDED_ADMIN.email, SEEDED_ADMIN.password);
    const assigned = await request(app)
      .post(`/api/v1/admin/users/${targetId}/roles`)
      .set('Authorization', `Bearer ${superAdmin.accessToken}`)
      .send({ roleCodes: ['ORDER_MANAGER'] });

    expect(assigned.status).toBe(200);

    const afterVersion = (await prisma.adminUser.findUniqueOrThrow({ where: { id: targetId } }))
      .permissionVersion;
    expect(afterVersion).toBeGreaterThan(beforeVersion);

    const stale = await request(app)
      .get('/api/v1/admin/auth/me')
      .set('Authorization', `Bearer ${target.accessToken}`);

    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('TOKEN_EXPIRED');

    const audited = await eventually(
      () => prisma.auditLog.count({ where: { action: 'ROLE_ASSIGNED', entityId: targetId } }),
      (value) => value === 1,
    );
    expect(audited).toBe(1);
  });
});

describe('CSRF (double submit)', () => {
  it('rejects a cookie-authenticated mutation without the header', async () => {
    const session = await loginAs(SEEDED_ADMIN.email, SEEDED_ADMIN.password);

    const response = await request(app)
      .post('/api/v1/admin/auth/logout-all')
      .set('Cookie', session.header);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('accepts the same request with a matching X-CSRF-Token', async () => {
    const session = await loginAs(SEEDED_ADMIN.email, SEEDED_ADMIN.password);

    const response = await request(app)
      .post('/api/v1/admin/auth/logout-all')
      .set('Cookie', session.header)
      .set('X-CSRF-Token', session.csrf);

    expect(response.status).toBe(200);
    expect(response.body.data.loggedOut).toBe(true);
  });

  it('exempts Bearer requests, which carry no ambient credential', async () => {
    const session = await loginAs(SEEDED_ADMIN.email, SEEDED_ADMIN.password);

    const response = await request(app)
      .post('/api/v1/admin/auth/logout-all')
      .set('Authorization', `Bearer ${session.accessToken}`);

    expect(response.status).toBe(200);
  });
});

describe('refresh rotation over cookies', () => {
  it('rotates the session and refuses a replayed cookie', async () => {
    const email = 'rotation-admin@clearwood.local';
    await createAdmin(email, 'CATALOG_MANAGER');
    const session = await loginAs(email);

    const first = await request(app)
      .post('/api/v1/admin/auth/refresh')
      .set('Cookie', session.header)
      .set('X-CSRF-Token', session.csrf)
      .send({});

    expect(first.status).toBe(200);
    expect(first.body.data.tokens.accessToken).toBeTruthy();
    expect(JSON.stringify(first.body)).not.toContain('refreshToken');

    const rotatedHeader = cookieHeader(cookiesFrom(first));
    const second = await request(app)
      .post('/api/v1/admin/auth/refresh')
      .set('Cookie', rotatedHeader)
      .set('X-CSRF-Token', session.csrf)
      .send({});
    expect(second.status).toBe(200);

    // Replaying the very first cookie is treated as a leak.
    const replay = await request(app)
      .post('/api/v1/admin/auth/refresh')
      .set('Cookie', session.header)
      .set('X-CSRF-Token', session.csrf)
      .send({});

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('TOKEN_REUSE');

    const audited = await eventually(
      () => prisma.auditLog.count({ where: { action: 'TOKEN_REUSE_DETECTED', realm: 'ADMIN' } }),
      (value) => value >= 1,
    );
    expect(audited).toBeGreaterThanOrEqual(1);
  });
});

describe('audit trail', () => {
  it('writes exactly one row for a login, a logout and a password change', async () => {
    const email = 'audit-admin@clearwood.local';
    const id = await createAdmin(email, 'CATALOG_MANAGER');

    const before = await prisma.auditLog.count({ where: { entityId: id } });
    expect(before).toBe(0);

    const session = await loginAs(email);
    expect(
      await eventually(
        () => prisma.auditLog.count({ where: { action: 'LOGIN', entityId: id } }),
        (value) => value === 1,
      ),
    ).toBe(1);

    await request(app)
      .post('/api/v1/admin/auth/change-password')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'Sheesham-Walnut-88' });

    expect(
      await eventually(
        () => prisma.auditLog.count({ where: { action: 'PASSWORD_CHANGE', entityId: id } }),
        (value) => value === 1,
      ),
    ).toBe(1);

    const relogin = await loginAs(email, 'Sheesham-Walnut-88');
    await request(app)
      .post('/api/v1/admin/auth/logout')
      .set('Cookie', relogin.header)
      .set('X-CSRF-Token', relogin.csrf);

    expect(
      await eventually(
        () => prisma.auditLog.count({ where: { action: 'LOGOUT', entityId: id } }),
        (value) => value === 1,
      ),
    ).toBe(1);
  });

  it('is searchable through the API for anyone holding system.audit.read', async () => {
    const session = await loginAs(SEEDED_ADMIN.email, SEEDED_ADMIN.password);

    const response = await request(app)
      .get('/api/v1/admin/audit-logs')
      .query({ action: 'LOGIN', limit: 5 })
      .set('Authorization', `Bearer ${session.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.meta.total).toBeGreaterThan(0);
    expect(response.body.data[0]).toMatchObject({ action: 'LOGIN' });
  });
});

describe('sessions', () => {
  it('lists and revokes refresh-token families', async () => {
    const email = 'sessions-admin@clearwood.local';
    await createAdmin(email, 'CATALOG_MANAGER');
    const first = await loginAs(email);
    await loginAs(email);

    const list = await request(app)
      .get('/api/v1/admin/auth/sessions')
      .set('Authorization', `Bearer ${first.accessToken}`);

    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(2);

    const other = list.body.data.find((session: { isCurrent: boolean }) => !session.isCurrent);
    const revoked = await request(app)
      .delete(`/api/v1/admin/auth/sessions/${other.id}`)
      .set('Authorization', `Bearer ${first.accessToken}`);

    expect(revoked.status).toBe(200);
    expect(
      await prisma.refreshToken.count({ where: { familyId: other.id, revokedAt: null } }),
    ).toBe(0);
  });
});
