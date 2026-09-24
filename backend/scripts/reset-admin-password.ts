// Resets ONE existing admin account to ADMIN_SEED_PASSWORD and forces a password change at the
// next sign-in. Non-interactive:
//
//   npm run admin:reset-password                        -> the ADMIN_SEED_EMAIL account
//   npm run admin:reset-password -- --email a@b.example -> any other existing account
//
// The new password is read from ADMIN_SEED_PASSWORD (backend/.env), never from the command line,
// so it cannot end up in shell history or a process listing. Production refuses to load the
// published placeholder (config/env.ts), so a live account can never be reset to a public value.
// In development this restores the documented seed credentials after exercising first login.
import { env } from '../src/config/env';
import { disconnectPrisma, prisma } from '../src/config/prisma';
import { passwordService } from '../src/modules/auth/password.service';

function targetEmail(): string {
  const flag = process.argv.indexOf('--email');
  if (flag === -1) return env.ADMIN_SEED_EMAIL.trim().toLowerCase();

  const value = process.argv[flag + 1];
  if (!value || value.startsWith('--')) throw new Error('--email needs an address after it');
  return value.trim().toLowerCase();
}

async function main(): Promise<void> {
  const email = targetEmail();
  const account = await prisma.adminUser.findUnique({
    where: { email },
    select: { id: true, deletedAt: true },
  });

  if (!account || account.deletedAt) {
    console.error(`[admin] no admin account exists for ${email} — nothing was changed`);
    process.exitCode = 1;
    return;
  }

  const passwordHash = await passwordService.hash(env.ADMIN_SEED_PASSWORD);

  await prisma.$transaction([
    prisma.adminUser.update({
      where: { id: account.id },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
        status: 'ACTIVE',
        // Access tokens already handed out die now rather than when they expire.
        permissionVersion: { increment: 1 },
      },
    }),
    prisma.refreshToken.updateMany({
      where: { principalType: 'ADMIN_USER', principalId: account.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'ADMIN_PASSWORD_RESET_SCRIPT' },
    }),
  ]);

  console.log(
    `[admin] ${email} reset to ADMIN_SEED_PASSWORD — must change it at the next sign-in; every session was revoked`,
  );
}

main()
  .catch((error) => {
    console.error('[admin] reset failed', error);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
