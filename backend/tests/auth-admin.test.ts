import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEV_ADMIN_PASSWORD, env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { createApp } from '../src/app';
import { mailer } from '../src/container';
import { passwordService } from '../src/modules/auth/password.service';

const app = createApp();

/**
 * The seed's bootstrap account, read from the same env the seed used: an ordinary ADMIN that must
 * change its password before anything but self-service works.
 */
const SEEDED_ADMIN = {
  email: env.ADMIN_SEED_EMAIL.trim().toLowerCase(),
  password: env.ADMIN_SEED_PASSWORD,
};
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

async function createAdmin(
  email: string,
  roleCode: string,
  overrides: { mustChangePassword?: boolean; status?: string } = {},
): Promise<string> {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const user = await prisma.adminUser.upsert({
    where: { email },
    update: {
      status: overrides.status ?? 'ACTIVE',
      failedLoginCount: 0,
      lockedUntil: null,
      deletedAt: null,
    },
    create: {
      email,
      name: `Test ${roleCode}`,
      passwordHash: await passwordService.hash(TEST_PASSWORD),
      status: overrides.status ?? 'ACTIVE',
      mustChangePassword: overrides.mustChangePassword ?? false,
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
  it('signs the seeded bootstrap ADMIN in and sets all three realm cookies', async () => {
    const { response, cookies } = await loginAs(SEEDED_ADMIN.email, SEEDED_ADMIN.password);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.user.email).toBe(SEEDED_ADMIN.email);
    // The ordinary ADMIN role - never SUPER_ADMIN - and the reduced grant set that comes with it.
    expect(response.body.data.roles).toEqual(['ADMIN']);
    expect(response.body.data.permissions).toHaveLength(79);
    expect(response.body.data.permissions).not.toContain('system.role.update');
    expect(response.body.data.permissions).not.toContain('system.user.delete');
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
    await createAdmin('realm-super@clearwood.local', 'SUPER_ADMIN');
    adminToken = (await loginAs('realm-super@clearwood.local')).accessToken;

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
    // The seeded site map's root groups (16 since the catalog-management taxonomy).
    expect(response.body.data).toHaveLength(16);
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
    await createAdmin('rbac-super@clearwood.local', 'SUPER_ADMIN');
    const session = await loginAs('rbac-super@clearwood.local');

    expect(session.response.body.data.permissions).toHaveLength(86);

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

    const superAdminEmail = 'role-change-super@clearwood.local';
    await createAdmin(superAdminEmail, 'SUPER_ADMIN');
    const superAdmin = await loginAs(superAdminEmail);
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

  it('is not switched off by an Authorization header that is not Bearer', async () => {
    // e.g. Basic credentials a browser attaches by itself behind an authenticating proxy: the
    // cookie is still what authenticates, so the request is still forgeable cross-site.
    await createAdmin('csrf-basic@clearwood.local', 'CATALOG_MANAGER');
    const session = await loginAs('csrf-basic@clearwood.local');

    const response = await request(app)
      .post('/api/v1/admin/auth/logout-all')
      .set('Cookie', session.header)
      .set('Authorization', 'Basic dXNlcjpwYXNz');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_TOKEN_INVALID');
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
    // An ordinary ADMIN holds system.audit.read; the bootstrap one must change its password first.
    await createAdmin('audit-reader@clearwood.local', 'ADMIN');
    const session = await loginAs('audit-reader@clearwood.local');

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

function bearer(accessToken: string): { Authorization: string } {
  return { Authorization: `Bearer ${accessToken}` };
}

/* ------------------------------------------------------------- mustChangePassword */

describe('a pending password change is enforced by the server, not the UI', () => {
  it('blocks the bootstrap ADMIN everywhere except the self-service routes', async () => {
    const session = await loginAs(SEEDED_ADMIN.email, SEEDED_ADMIN.password);
    expect(session.response.status).toBe(200);

    const catalog = await request(app)
      .get('/api/v1/admin/catalog/categories')
      .set(bearer(session.accessToken));
    expect(catalog.status).toBe(403);
    expect(catalog.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // Even a permission the account genuinely holds stays shut until the password changes.
    const create = await request(app)
      .post('/api/v1/admin/users')
      .set(bearer(session.accessToken))
      .send({
        email: 'should-not-exist@clearwood.local',
        name: 'Should Not Exist',
        password: 'Teak-Rosewood-2031',
        roleCodes: ['CATALOG_MANAGER'],
      });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(
      await prisma.adminUser.count({ where: { email: 'should-not-exist@clearwood.local' } }),
    ).toBe(0);

    const me = await request(app).get('/api/v1/admin/auth/me').set(bearer(session.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.data.mustChangePassword).toBe(true);

    const sessions = await request(app)
      .get('/api/v1/admin/auth/sessions')
      .set(bearer(session.accessToken));
    expect(sessions.status).toBe(200);
  });

  it('lifts the block on the same session once the password really changes', async () => {
    const email = 'must-change@clearwood.local';
    await createAdmin(email, 'CATALOG_MANAGER', { mustChangePassword: true });
    const session = await loginAs(email);
    expect(session.response.body.data.mustChangePassword).toBe(true);

    const before = await request(app)
      .get('/api/v1/admin/catalog/categories')
      .set(bearer(session.accessToken));
    expect(before.status).toBe(403);
    expect(before.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // Re-submitting the same secret would clear the flag without changing anything.
    const same = await request(app)
      .post('/api/v1/admin/auth/change-password')
      .set(bearer(session.accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });
    expect(same.status).toBe(422);

    // The development placeholder is public, so it can never be chosen.
    const published = await request(app)
      .post('/api/v1/admin/auth/change-password')
      .set(bearer(session.accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword: DEV_ADMIN_PASSWORD });
    expect(published.status).toBe(422);

    const changed = await request(app)
      .post('/api/v1/admin/auth/change-password')
      .set(bearer(session.accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'Sheesham-Walnut-2031' });
    expect(changed.status).toBe(200);

    const after = await request(app)
      .get('/api/v1/admin/catalog/categories')
      .set(bearer(session.accessToken));
    expect(after.status).toBe(200);

    const me = await request(app).get('/api/v1/admin/auth/me').set(bearer(session.accessToken));
    expect(me.body.data.mustChangePassword).toBe(false);
  });
});

/* ------------------------------------------------------------ account status */

describe('disabled and suspended admins cannot hold a usable session', () => {
  for (const status of ['SUSPENDED', 'DISABLED'] as const) {
    it(`refuses a ${status} admin at sign-in, at refresh and on a live access token`, async () => {
      const email = `status-${status.toLowerCase()}@clearwood.local`;
      const id = await createAdmin(email, 'CATALOG_MANAGER');
      const session = await loginAs(email);
      expect(session.response.status).toBe(200);

      await prisma.adminUser.update({ where: { id }, data: { status } });

      const live = await request(app)
        .get('/api/v1/admin/catalog/categories')
        .set(bearer(session.accessToken));
      expect(live.status).toBe(401);
      expect(live.body.error.code).toBe('ACCOUNT_DISABLED');

      // A refresh must not mint a fresh access token for the account, and kills the session.
      const refreshed = await request(app)
        .post('/api/v1/admin/auth/refresh')
        .set('Cookie', session.header)
        .send({});
      expect(refreshed.status).toBe(401);
      expect(refreshed.body.error.code).toBe('ACCOUNT_DISABLED');
      expect(refreshed.body.data).toBeUndefined();
      expect(
        await prisma.refreshToken.count({
          where: { principalType: 'ADMIN_USER', principalId: id, revokedAt: null },
        }),
      ).toBe(0);

      const again = await request(app)
        .post('/api/v1/admin/auth/login')
        .send({ email, password: TEST_PASSWORD });
      expect(again.status).toBe(401);
      expect(again.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  }
});

/* ----------------------------------------------------------- privilege escalation */

describe('an ordinary ADMIN cannot reach SUPER_ADMIN', () => {
  let admin: Awaited<ReturnType<typeof loginAs>>;
  let superId = '';

  beforeAll(async () => {
    await createAdmin('escalation-admin@clearwood.local', 'ADMIN');
    admin = await loginAs('escalation-admin@clearwood.local');
    superId = await createAdmin('escalation-super@clearwood.local', 'SUPER_ADMIN');
  });

  it('cannot create a SUPER_ADMIN', async () => {
    const response = await request(app)
      .post('/api/v1/admin/users')
      .set(bearer(admin.accessToken))
      .send({
        email: 'would-be-super@clearwood.local',
        name: 'Would Be Super',
        password: 'Teak-Rosewood-2031',
        roleCodes: ['SUPER_ADMIN'],
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ROLE_NOT_GRANTABLE');
    expect(response.body.error.details.roleCodes).toEqual(['SUPER_ADMIN']);
    expect(
      await prisma.adminUser.count({ where: { email: 'would-be-super@clearwood.local' } }),
    ).toBe(0);

    const audited = await eventually(
      () =>
        prisma.auditLog.count({
          where: { action: 'PERMISSION_DENIED', entity: 'AdminUser', severity: 'CRITICAL' },
        }),
      (value) => value >= 1,
    );
    expect(audited).toBeGreaterThanOrEqual(1);
  });

  it('still creates accounts at or below its own level', async () => {
    const response = await request(app)
      .post('/api/v1/admin/users')
      .set(bearer(admin.accessToken))
      .send({
        email: 'made-by-admin@clearwood.local',
        name: 'Made By Admin',
        password: 'Teak-Rosewood-2031',
        roleCodes: ['CATALOG_MANAGER'],
      });

    expect(response.status).toBe(201);
    expect(response.body.data.roles.map((role: { code: string }) => role.code)).toEqual([
      'CATALOG_MANAGER',
    ]);
  });

  it('cannot disable or even rename a SUPER_ADMIN, and cannot delete anybody', async () => {
    const disable = await request(app)
      .patch(`/api/v1/admin/users/${superId}`)
      .set(bearer(admin.accessToken))
      .send({ status: 'DISABLED' });
    expect(disable.status).toBe(403);
    expect(disable.body.error.code).toBe('ADMIN_USER_NOT_MANAGEABLE');

    const rename = await request(app)
      .patch(`/api/v1/admin/users/${superId}`)
      .set(bearer(admin.accessToken))
      .send({ name: 'Renamed By Admin' });
    expect(rename.status).toBe(403);
    expect(rename.body.error.code).toBe('ADMIN_USER_NOT_MANAGEABLE');

    const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: superId } });
    expect(row.status).toBe('ACTIVE');
    expect(row.name).not.toBe('Renamed By Admin');

    // ADMIN does not hold system.user.delete at all: the permission guard answers first.
    const remove = await request(app)
      .delete(`/api/v1/admin/users/${superId}`)
      .set(bearer(admin.accessToken));
    expect(remove.status).toBe(403);
    expect(remove.body.error.code).toBe('FORBIDDEN');
    expect(remove.body.error.details.required).toContain('system.user.delete');
  });

  it('cannot touch role definitions', async () => {
    const superRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });

    const response = await request(app)
      .patch(`/api/v1/admin/roles/${superRole.id}`)
      .set(bearer(admin.accessToken))
      .send({ name: 'Owned' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.details.required).toContain('system.role.update');
  });

  it('leaves a SUPER_ADMIN able to create, and to manage, another SUPER_ADMIN', async () => {
    const owner = await loginAs('escalation-super@clearwood.local');

    const created = await request(app)
      .post('/api/v1/admin/users')
      .set(bearer(owner.accessToken))
      .send({
        email: 'second-owner@clearwood.local',
        name: 'Second Owner',
        password: 'Teak-Rosewood-2031',
        roleCodes: ['SUPER_ADMIN'],
      });
    expect(created.status).toBe(201);
    expect(created.body.data.roles.map((role: { code: string }) => role.code)).toEqual([
      'SUPER_ADMIN',
    ]);

    const renamed = await request(app)
      .patch(`/api/v1/admin/users/${created.body.data.id}`)
      .set(bearer(owner.accessToken))
      .send({ name: 'Second Owner (renamed)' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe('Second Owner (renamed)');
  });

  it('answers an action outside the role with 403 FORBIDDEN naming the permission', async () => {
    await createAdmin('no-user-admin@clearwood.local', 'CATALOG_MANAGER');
    const manager = await loginAs('no-user-admin@clearwood.local');

    const response = await request(app)
      .post('/api/v1/admin/users')
      .set(bearer(manager.accessToken))
      .send({
        email: 'not-by-a-manager@clearwood.local',
        name: 'Not By A Manager',
        password: 'Teak-Rosewood-2031',
        roleCodes: ['CATALOG_MANAGER'],
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.details.required).toEqual(['system.user.create']);
  });
});

describe('a delegated user/role manager cannot amplify either', () => {
  const DELEGATE_CODES = [
    'catalog.product.read',
    'system.role.read',
    'system.role.update',
    'system.user.read',
    'system.user.update',
  ];

  let delegate: Awaited<ReturnType<typeof loginAs>>;
  let delegateRoleId = '';
  let peerId = '';

  beforeAll(async () => {
    const permissions = await prisma.permission.findMany({
      where: { code: { in: DELEGATE_CODES } },
    });
    expect(permissions).toHaveLength(DELEGATE_CODES.length);

    // Far below ADMIN, but holding exactly the two permissions the grant route checks.
    const role = await prisma.role.create({
      data: {
        code: 'TEST_DELEGATE',
        name: 'Test delegate',
        isSystem: false,
        position: 90,
        permissions: { create: permissions.map((permission) => ({ permissionId: permission.id })) },
      },
    });
    delegateRoleId = role.id;

    await createAdmin('delegate@clearwood.local', 'TEST_DELEGATE');
    delegate = await loginAs('delegate@clearwood.local');
    peerId = await createAdmin('delegate-peer@clearwood.local', 'TEST_DELEGATE');
  });

  it('cannot grant SUPER_ADMIN, or any role above its own grants', async () => {
    for (const roleCode of ['SUPER_ADMIN', 'ADMIN', 'CATALOG_MANAGER']) {
      const response = await request(app)
        .post(`/api/v1/admin/users/${peerId}/roles`)
        .set(bearer(delegate.accessToken))
        .send({ roleCodes: [roleCode] });

      expect(response.status, roleCode).toBe(403);
      expect(response.body.error.code, roleCode).toBe('ROLE_NOT_GRANTABLE');
    }

    const roles = await prisma.adminUserRole.findMany({
      where: { adminUserId: peerId },
      include: { role: true },
    });
    expect(roles.map((assignment) => assignment.role.code)).toEqual(['TEST_DELEGATE']);
  });

  it('cannot edit the SUPER_ADMIN role, nor widen its own role', async () => {
    const superRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });

    const rename = await request(app)
      .patch(`/api/v1/admin/roles/${superRole.id}`)
      .set(bearer(delegate.accessToken))
      .send({ name: 'Owned' });
    expect(rename.status).toBe(403);
    expect(rename.body.error.code).toBe('ROLE_NOT_MANAGEABLE');

    const widen = await request(app)
      .patch(`/api/v1/admin/roles/${delegateRoleId}`)
      .set(bearer(delegate.accessToken))
      .send({ permissions: [...DELEGATE_CODES, 'payment.settings.update'] });
    expect(widen.status).toBe(403);
    expect(widen.body.error.code).toBe('ROLE_NOT_MANAGEABLE');
    expect(widen.body.error.details.permissions).toEqual(['payment.settings.update']);

    expect(await prisma.rolePermission.count({ where: { roleId: delegateRoleId } })).toBe(
      DELEGATE_CODES.length,
    );
    expect((await prisma.role.findUniqueOrThrow({ where: { id: superRole.id } })).name).not.toBe(
      'Owned',
    );
  });
});

/* ------------------------------------------------------------ the last SUPER_ADMIN */

describe('the last active SUPER_ADMIN is protected', () => {
  let soleId = '';
  let sole: Awaited<ReturnType<typeof loginAs>>;
  let parked: string[] = [];

  beforeAll(async () => {
    soleId = await createAdmin('sole-super@clearwood.local', 'SUPER_ADMIN');

    // Park every other active SUPER_ADMIN in this file's database, so this one really is the last.
    const others = await prisma.adminUser.findMany({
      where: {
        id: { not: soleId },
        status: 'ACTIVE',
        deletedAt: null,
        roles: { some: { role: { code: 'SUPER_ADMIN' } } },
      },
      select: { id: true },
    });
    parked = others.map((row) => row.id);
    await prisma.adminUser.updateMany({
      where: { id: { in: parked } },
      data: { status: 'SUSPENDED' },
    });

    sole = await loginAs('sole-super@clearwood.local');
  });

  afterAll(async () => {
    await prisma.adminUser.updateMany({
      where: { id: { in: parked } },
      data: { status: 'ACTIVE' },
    });
  });

  it('cannot suspend or demote itself', async () => {
    const suspend = await request(app)
      .patch(`/api/v1/admin/users/${soleId}`)
      .set(bearer(sole.accessToken))
      .send({ status: 'SUSPENDED' });
    expect(suspend.status).toBe(403);
    expect(suspend.body.error.code).toBe('LAST_SUPER_ADMIN');

    const demote = await request(app)
      .post(`/api/v1/admin/users/${soleId}/roles`)
      .set(bearer(sole.accessToken))
      .send({ roleCodes: ['ADMIN'] });
    expect(demote.status).toBe(403);
    expect(demote.body.error.code).toBe('LAST_SUPER_ADMIN');

    const row = await prisma.adminUser.findUniqueOrThrow({
      where: { id: soleId },
      include: { roles: { include: { role: true } } },
    });
    expect(row.status).toBe('ACTIVE');
    expect(row.roles.map((assignment) => assignment.role.code)).toEqual(['SUPER_ADMIN']);
  });

  it('lets one SUPER_ADMIN retire another, but never both at once', async () => {
    const peerId = await createAdmin('peer-super@clearwood.local', 'SUPER_ADMIN');
    const peer = await loginAs('peer-super@clearwood.local');

    try {
      // Each suspends the other at the same moment: the role lock lets exactly one through.
      const results = await Promise.all([
        request(app)
          .patch(`/api/v1/admin/users/${peerId}`)
          .set(bearer(sole.accessToken))
          .send({ status: 'SUSPENDED' }),
        request(app)
          .patch(`/api/v1/admin/users/${soleId}`)
          .set(bearer(peer.accessToken))
          .send({ status: 'SUSPENDED' }),
      ]);

      expect(results.filter((response) => response.status === 200)).toHaveLength(1);
      for (const response of results.filter((entry) => entry.status !== 200)) {
        expect(['LAST_SUPER_ADMIN', 'ACCOUNT_DISABLED']).toContain(response.body.error.code);
      }

      expect(
        await prisma.adminUser.count({
          where: { id: { in: [soleId, peerId] }, status: 'ACTIVE' },
        }),
      ).toBe(1);
    } finally {
      await prisma.adminUser.updateMany({
        where: { id: { in: [soleId, peerId] } },
        data: { status: 'ACTIVE' },
      });
    }
  });
});

/* -------------------------------------------------------------------- invites */

describe('admin invites', () => {
  it('lets an invited admin set a password with the emailed token, exactly once', async () => {
    await createAdmin('inviter@clearwood.local', 'ADMIN');
    const inviter = await loginAs('inviter@clearwood.local');
    const send = vi.spyOn(mailer, 'send');

    try {
      const created = await request(app)
        .post('/api/v1/admin/users')
        .set(bearer(inviter.accessToken))
        .send({
          email: 'invitee@clearwood.local',
          name: 'Invited Person',
          roleCodes: ['CONTENT_MANAGER'],
        });
      expect(created.status).toBe(201);
      expect(created.body.data.status).toBe('INVITED');

      const invite = send.mock.calls
        .map(([message]) => message)
        .find((message) => message.to === 'invitee@clearwood.local');
      const token = invite?.text?.trim().split('\n').at(-1) ?? '';
      expect(token.length).toBeGreaterThan(20);

      const accepted = await request(app)
        .post('/api/v1/admin/auth/reset-password')
        .send({ token, newPassword: 'Invited-Teak-2031' });
      expect(accepted.status).toBe(200);

      const login = await loginAs('invitee@clearwood.local', 'Invited-Teak-2031');
      expect(login.response.status).toBe(200);
      expect(login.response.body.data.user.status).toBe('ACTIVE');
      expect(login.response.body.data.mustChangePassword).toBe(false);

      const replay = await request(app)
        .post('/api/v1/admin/auth/reset-password')
        .send({ token, newPassword: 'Another-Teak-2032' });
      expect(replay.status).toBe(400);
      expect(replay.body.error.code).toBe('RESET_TOKEN_INVALID');
    } finally {
      send.mockRestore();
    }
  });
});
