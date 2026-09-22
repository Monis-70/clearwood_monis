import { env } from '../../src/config/env';

import { log, prisma } from './context';

/**
 * Payout accounts for the Razorpay Route split.
 *
 * The provider account id lives in the DATABASE, not in code, so an admin can repoint a payout
 * without a deploy. It is seeded from `RAZORPAY_ACCOUNT_*` on first run and then NEVER overwritten
 * — re-seeding must not silently undo an admin's change to where money goes.
 */

const MOCK_PRIMARY = 'acc_mock_primary_000001';
const MOCK_PARTNER = 'acc_mock_partner_000002';

const ACCOUNTS = [
  {
    key: 'PRIMARY',
    name: 'ClearWood Furnitures',
    providerAccountId: env.RAZORPAY_ACCOUNT_PRIMARY ?? MOCK_PRIMARY,
    isPrimary: true,
    notes: 'Receives the residue of every split, and bears the provider fees.',
  },
  {
    key: 'PARTNER_A',
    name: 'Workshop Partner A',
    providerAccountId: env.RAZORPAY_ACCOUNT_SECONDARY ?? MOCK_PARTNER,
    isPrimary: false,
    notes: 'The manufacturing partner paid a fixed amount per order.',
  },
];

export async function seedSplitAccounts(): Promise<void> {
  let created = 0;

  for (const account of ACCOUNTS) {
    const existing = await prisma.splitAccount.findUnique({ where: { key: account.key } });

    if (existing) {
      // Only the name and the notes are resynced; the provider id is the admin's to own.
      await prisma.splitAccount.update({
        where: { key: account.key },
        data: { name: account.name, notes: account.notes },
      });
      continue;
    }

    await prisma.splitAccount.create({ data: { ...account, isActive: true } });
    created += 1;
  }

  log('split-accounts', `${ACCOUNTS.length} payout accounts ensured (${created} created)`);
}
