// Restores the bootstrap admin to the documented seed credentials.
// Useful after manually exercising the first-login "must change password" flow in development.
import { env } from '../src/config/env';
import { disconnectPrisma, prisma } from '../src/config/prisma';
import { passwordService } from '../src/modules/auth/password.service';

async function main(): Promise<void> {
  const email = env.ADMIN_SEED_EMAIL.toLowerCase();

  const updated = await prisma.adminUser.update({
    where: { email },
    data: {
      passwordHash: await passwordService.hash(env.ADMIN_SEED_PASSWORD),
      mustChangePassword: true,
      failedLoginCount: 0,
      lockedUntil: null,
      status: 'ACTIVE',
    },
  });

  await prisma.refreshToken.updateMany({
    where: { principalType: 'ADMIN_USER', principalId: updated.id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'ADMIN_PASSWORD_RESET_SCRIPT' },
  });

  console.log(`[admin] ${email} reset to ADMIN_SEED_PASSWORD, mustChangePassword=true`);
}

main()
  .catch((error) => {
    console.error('[admin] reset failed', error);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
