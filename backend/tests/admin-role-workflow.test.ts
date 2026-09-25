import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { passwordService } from '../src/modules/auth/password.service';

/**
 * The workflow the admin UI builds on for an ordinary ADMIN (all permissions except
 * `system.role.*`, `system.user.delete` and payment updates): it may ADD admins with any role whose
 * permissions it holds (`system.user.create` + ROLE_NOT_GRANTABLE), but it may neither read the role
 * catalogue nor change the roles of an existing admin, which both need `system.role.read`.
 */

const app = createApp();
const TEST_PASSWORD = 'Rosewood-Teak-2026';
const RUN = Date.now().toString(36);

let cookie = '';
let csrf = '';

beforeAll(async () => {
  const email = `workflow-admin-${RUN}@clearwood.local`;
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
  await prisma.adminUser.create({
    data: {
      email,
      name: 'Workflow Admin',
      passwordHash: await passwordService.hash(TEST_PASSWORD),
      status: 'ACTIVE',
      roles: { create: { roleId: role.id } },
    },
  });
  const login = await request(app)
    .post('/api/v1/admin/auth/login')
    .send({ email, password: TEST_PASSWORD });
  expect(login.status).toBe(200);
  const raw = login.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  csrf =
    cookies
      .find((c) => c.startsWith('cw_adm_csrf='))
      ?.split(';')[0]
      ?.split('=')[1] ?? '';
});

const create = (roleCodes: string[], suffix: string) =>
  request(app)
    .post('/api/v1/admin/users')
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrf)
    .send({
      email: `workflow-${suffix}-${RUN}@clearwood.local`,
      name: `Workflow ${suffix}`,
      password: 'Walnut-Sheesham-2031',
      roleCodes,
    });

describe('an ADMIN adding admins', () => {
  it('adds an admin with a role it holds, by role code, without reading the role list', async () => {
    const response = await create(['CATALOG_MANAGER'], 'catalog');
    expect(response.status).toBe(201);
    expect(response.body.data.roles.map((role: { code: string }) => role.code)).toEqual([
      'CATALOG_MANAGER',
    ]);
    expect(response.body.data.mustChangePassword).toBe(true);
  });

  it('is refused SUPER_ADMIN', async () => {
    const response = await create(['SUPER_ADMIN'], 'super');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ROLE_NOT_GRANTABLE');
  });

  it('cannot read the role catalogue', async () => {
    const response = await request(app).get('/api/v1/admin/roles').set('Cookie', cookie);
    expect(response.status).toBe(403);
  });

  it('cannot change the roles of an existing admin', async () => {
    const created = await create(['CONTENT_MANAGER'], 'content');
    expect(created.status).toBe(201);
    const response = await request(app)
      .post(`/api/v1/admin/users/${created.body.data.id}/roles`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ roleCodes: ['CATALOG_MANAGER'] });
    expect(response.status).toBe(403);
    const roles = await prisma.adminUserRole.findMany({
      where: { adminUserId: created.body.data.id },
      include: { role: true },
    });
    expect(roles.map((assignment) => assignment.role.code)).toEqual(['CONTENT_MANAGER']);
  });
});
