import { passwordService } from '../../src/modules/auth/password.service';

import { SEED_EPOCH } from './epoch';
import { log, prisma } from './context';

/**
 * Three shapes of customer so the guards can be exercised end to end:
 * a verified email+password account, a phone-only OTP account, and a blocked one.
 */

const DEMO_PASSWORD = 'CustomerDemo@2026';

const CUSTOMERS = [
  {
    email: 'aarav.mehta@example.com',
    phone: '919810000001',
    name: 'Aarav Mehta',
    status: 'ACTIVE',
    withPassword: true,
    verifiedEmail: true,
    referralCode: 'CWDEMO01',
  },
  {
    email: null,
    phone: '919810000002',
    name: 'Ishita Rao',
    status: 'ACTIVE',
    withPassword: false,
    verifiedEmail: false,
    referralCode: 'CWDEMO02',
  },
  {
    email: 'blocked.user@example.com',
    phone: '919810000003',
    name: 'Blocked Tester',
    status: 'BLOCKED',
    withPassword: true,
    verifiedEmail: true,
    referralCode: 'CWDEMO03',
  },
];

export async function seedDemoCustomers(): Promise<void> {
  const passwordHash = await passwordService.hash(DEMO_PASSWORD);

  for (const customer of CUSTOMERS) {
    const existing = customer.email
      ? await prisma.customer.findUnique({ where: { email: customer.email } })
      : await prisma.customer.findUnique({ where: { phone: customer.phone } });

    if (existing) {
      // Only the status is resynced; names, opt-ins and passwords are the customer's own data.
      await prisma.customer.update({
        where: { id: existing.id },
        data: { status: customer.status, deletedAt: null },
      });
      continue;
    }

    await prisma.customer.create({
      data: {
        email: customer.email,
        phone: customer.phone,
        name: customer.name,
        status: customer.status,
        passwordHash: customer.withPassword ? passwordHash : null,
        emailVerifiedAt: customer.verifiedEmail ? SEED_EPOCH : null,
        phoneVerifiedAt: customer.withPassword ? null : SEED_EPOCH,
        referralCode: customer.referralCode,
        marketingOptIn: true,
      },
    });
  }

  log('demo-customers', `${CUSTOMERS.length} demo customers upserted (password: ${DEMO_PASSWORD})`);
}
