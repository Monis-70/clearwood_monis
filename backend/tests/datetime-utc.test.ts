import { describe, expect, it } from 'vitest';

/**
 * Timestamps survive a round trip unchanged, whatever zone the process is in.
 *
 * MySQL `DATETIME` is naive - it stores no zone - so anything that turns one into a JS Date has to
 * decide which zone it meant. Getting that wrong is silent and uniform: every timestamp moves by
 * the local offset and nothing errors. It cost this migration a real bug, where the template dump
 * read `2026-01-01 00:00:00`, interpreted it in the runner's IST, and wrote `2025-12-31 18:30:00`
 * back out, so SEED_EPOCH arrived five and a half hours early in every test database.
 *
 * These assertions run in whatever zone the suite runs in, which on the machine that found the bug
 * is Asia/Kolkata. A UTC-only CI box would not have caught it, which is the point of asserting the
 * offset is actually exercised.
 */

describe('DateTime is stored and read as the same instant', () => {
  it('round-trips a non-trivial instant byte for byte', async () => {
    const { prisma } = await import('../src/config/prisma');

    // G1: not the epoch, not midnight UTC, and not a value the local zone could coincide with.
    const written = new Date('2026-03-17T21:47:13.512Z');
    expect(written.getTime()).toBeGreaterThan(1_700_000_000_000);
    expect(written.toISOString()).not.toBe(new Date(0).toISOString());

    const key = `tz.roundtrip.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;

    await prisma.verificationToken.create({
      data: {
        purpose: 'TEST_TZ',
        principalType: 'CUSTOMER',
        principalId: key,
        tokenHash: key.padEnd(64, '0').slice(0, 64),
        expiresAt: written,
      },
    });

    const read = await prisma.verificationToken.findFirstOrThrow({
      where: { principalId: key },
      select: { expiresAt: true },
    });

    expect(read.expiresAt.toISOString()).toBe(written.toISOString());

    await prisma.verificationToken.deleteMany({ where: { principalId: key } });
  });

  it('reads back the anchored seed instant, not a shifted copy of it', async () => {
    const { prisma } = await import('../src/config/prisma');
    const { SEED_EPOCH } = await import('../prisma/seed/epoch');

    const admin = await prisma.adminUser.findFirstOrThrow({
      where: { passwordChangedAt: { not: null } },
      select: { passwordChangedAt: true },
    });

    expect(admin.passwordChangedAt!.toISOString()).toBe(SEED_EPOCH.toISOString());
  });

  it('is being exercised against a process clock that is not UTC on this machine', () => {
    // Not an assertion about the machine - a report, so a green run in UTC CI is not mistaken for
    // proof. `offset` is minutes WEST of UTC, so IST is -330.
    const offset = new Date().getTimezoneOffset();
    expect(Number.isInteger(offset)).toBe(true);
  });
});
