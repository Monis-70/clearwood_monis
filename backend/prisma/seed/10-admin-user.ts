import { env } from '../../src/config/env';
import { passwordService } from '../../src/modules/auth/password.service';

import { SEED_EPOCH } from './epoch';
import { log, prisma } from './context';

/**
 * The bootstrap account holds the ordinary ADMIN role, NOT SUPER_ADMIN.
 *
 * ADMIN runs the business day to day (catalog, content, orders, users below it). What it lacks -
 * role editing, deleting admins, payment and split settings - is exactly what a routinely-used
 * login should not carry. Nothing the platform needs to start requires SUPER_ADMIN, so seeding one
 * would hand the most powerful grant to the credential most likely to leak.
 */
const BOOTSTRAP_ROLE = 'ADMIN';

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

/**
 * Keyed on the email address and nothing else, so the seed is safe to run any number of times.
 *
 * An existing account is left COMPLETELY alone: not its password, not its name, not its roles. A
 * re-seed must never reset a live admin, re-grant a role somebody deliberately removed, or demote
 * an account an operator promoted. The password is read from env, hashed immediately and never
 * logged; production refuses to boot with the placeholder credentials (config/env.ts and
 * config/productionSecrets.ts), and the seed loads that same config.
 */
export async function seedAdminUser(): Promise<void> {
  const email = env.ADMIN_SEED_EMAIL.trim().toLowerCase();
  const name = env.ADMIN_SEED_NAME.trim();

  const role = await prisma.role.findUnique({ where: { code: BOOTSTRAP_ROLE } });
  if (!role) throw new Error(`${BOOTSTRAP_ROLE} role is missing — run seed step 09 first`);

  const existing = await prisma.adminUser.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    log('admin-user', `bootstrap admin already exists (${email}) — left untouched`);
    return;
  }

  const passwordHash = await passwordService.hash(env.ADMIN_SEED_PASSWORD);

  try {
    // One transaction: an account without its role, or without its audit row, never exists.
    await prisma.$transaction(async (tx) => {
      const user = await tx.adminUser.create({
        data: {
          email,
          name,
          passwordHash,
          status: 'ACTIVE',
          mustChangePassword: true,
          passwordChangedAt: SEED_EPOCH,
        },
      });

      await tx.adminUserRole.create({ data: { adminUserId: user.id, roleId: role.id } });

      await tx.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          action: 'CREATE',
          entity: 'AdminUser',
          entityId: user.id,
          severity: 'NOTICE',
          meta: JSON.stringify({ email, role: BOOTSTRAP_ROLE, source: 'seed' }),
        },
      });
    });
  } catch (error) {
    // Two seeds racing on an empty database: the unique email index lets exactly one of them win.
    if (!isUniqueViolation(error)) throw error;
    log('admin-user', `bootstrap admin was created concurrently (${email}) — left untouched`);
    return;
  }

  log(
    'admin-user',
    `bootstrap ${BOOTSTRAP_ROLE} created (${email}) — must change password on first login`,
  );
}
