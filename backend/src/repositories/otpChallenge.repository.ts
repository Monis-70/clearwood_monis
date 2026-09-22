import type { OtpChallenge, Prisma, VerificationToken } from '@prisma/client';

import type { OtpPurpose, PrincipalType, TokenPurpose } from '@shared/enums';

import { prisma } from '../config/prisma';

export const otpChallengeRepository = {
  findActive(destination: string, purpose: OtpPurpose): Promise<OtpChallenge | null> {
    return prisma.otpChallenge.findFirst({
      where: { destination, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: [{ createdAt: 'desc' }],
    });
  },

  findLatest(destination: string, purpose: OtpPurpose): Promise<OtpChallenge | null> {
    return prisma.otpChallenge.findFirst({
      where: { destination, purpose },
      orderBy: [{ createdAt: 'desc' }],
    });
  },

  countSince(destination: string, since: Date): Promise<number> {
    return prisma.otpChallenge.count({ where: { destination, createdAt: { gte: since } } });
  },

  create(data: Prisma.OtpChallengeUncheckedCreateInput): Promise<OtpChallenge> {
    return prisma.otpChallenge.create({ data });
  },

  update(id: string, data: Prisma.OtpChallengeUncheckedUpdateInput): Promise<OtpChallenge> {
    return prisma.otpChallenge.update({ where: { id }, data });
  },

  /** A new code supersedes any outstanding one for the same destination + purpose. */
  async consumeOutstanding(destination: string, purpose: OtpPurpose): Promise<number> {
    const result = await prisma.otpChallenge.updateMany({
      where: { destination, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return result.count;
  },
};

export const verificationTokenRepository = {
  findByHash(tokenHash: string): Promise<VerificationToken | null> {
    return prisma.verificationToken.findUnique({ where: { tokenHash } });
  },

  create(data: Prisma.VerificationTokenUncheckedCreateInput): Promise<VerificationToken> {
    return prisma.verificationToken.create({ data });
  },

  consume(id: string): Promise<VerificationToken> {
    return prisma.verificationToken.update({
      where: { id },
      data: { consumedAt: new Date() },
    });
  },

  async invalidateOutstanding(
    principalType: PrincipalType,
    principalId: string,
    purpose: TokenPurpose,
  ): Promise<number> {
    const result = await prisma.verificationToken.updateMany({
      where: { principalType, principalId, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return result.count;
  },
};
