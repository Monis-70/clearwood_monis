import { env } from '../../src/config/env';
import { passwordService } from '../../src/modules/auth/password.service';

import { SEED_EPOCH } from './epoch';
import { log, prisma } from './context';

/**
 * Bootstrap SUPER_ADMIN. The password is read from env, hashed immediately and never logged.
 * An existing account is left completely alone — re-seeding must not reset a live admin.
 */
export async function seedAdminUser(): Promise<void> {
  const email = env.ADMIN_SEED_EMAIL.toLowerCase();
  const existing = await prisma.adminUser.findUnique({ where: { email } });

  const superAdmin = await prisma.role.findUnique({ where: { code: 'SUPER_ADMIN' } });
  if (!superAdmin) throw new Error('SUPER_ADMIN role is missing — run seed step 09 first');

  if (existing) {
    await prisma.adminUserRole.upsert({
      where: { adminUserId_roleId: { adminUserId: existing.id, roleId: superAdmin.id } },
      update: {},
      create: { adminUserId: existing.id, roleId: superAdmin.id },
    });
    log('admin-user', `bootstrap admin already exists (${email}) — left untouched`);
    return;
  }

  const user = await prisma.adminUser.create({
    data: {
      email,
      name: env.ADMIN_SEED_NAME,
      passwordHash: await passwordService.hash(env.ADMIN_SEED_PASSWORD),
      status: 'ACTIVE',
      mustChangePassword: true,
      passwordChangedAt: SEED_EPOCH,
    },
  });

  await prisma.adminUserRole.create({ data: { adminUserId: user.id, roleId: superAdmin.id } });

  await prisma.auditLog.create({
    data: {
      actorType: 'SYSTEM',
      action: 'CREATE',
      entity: 'AdminUser',
      entityId: user.id,
      severity: 'NOTICE',
      meta: JSON.stringify({ email, role: 'SUPER_ADMIN', source: 'seed' }),
    },
  });

  log(
    'admin-user',
    `bootstrap SUPER_ADMIN created (${email}) — must change password on first login`,
  );
}
